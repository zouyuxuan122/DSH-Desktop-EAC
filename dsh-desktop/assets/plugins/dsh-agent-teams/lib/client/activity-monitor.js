/** Shared, demand-driven state for the AgentTeams browser monitor. */
const targets = new Map();
const targetListeners = new Set();
const snapshotListeners = new Set();
let targetSnapshot = [];
let activitySnapshots = { teams: [], archivedTeams: [] };
function targetKey(sessionId, teamId) {
    return `${sessionId}\u0000${teamId}`;
}
function publishTargets() {
    targetSnapshot = [...targets.values()]
        .filter((target) => target.active)
        .map(({ key, sessionId, teamId }) => ({ key, sessionId, teamId }));
    for (const listener of targetListeners)
        listener();
}
/** Subscribe to the active monitor-target list (React external-store shape). */
export function subscribeActivityMonitorTargets(listener) {
    targetListeners.add(listener);
    return () => { targetListeners.delete(listener); };
}
/** Read the stable active-target snapshot. */
export function getActivityMonitorTargetsSnapshot() {
    return targetSnapshot;
}
/**
 * Register one successful AgentTeams card as a monitoring demand.
 *
 * The returned cleanup is reference-counted so multiple cards and React
 * StrictMode remounts cannot stop another card's monitor.
 */
export function monitorAgentTeam(sessionId, teamId) {
    const owner = sessionId.trim();
    const id = teamId.trim();
    if (owner === '' || id === '')
        return () => { };
    const key = targetKey(owner, id);
    const existing = targets.get(key);
    if (existing === undefined) {
        targets.set(key, { key, sessionId: owner, teamId: id, refs: 1, active: true });
        publishTargets();
    }
    else {
        existing.refs += 1;
        if (!existing.active) {
            existing.active = true;
            publishTargets();
        }
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const current = targets.get(key);
        if (current === undefined)
            return;
        current.refs -= 1;
        if (current.refs <= 0) {
            targets.delete(key);
            if (current.active)
                publishTargets();
        }
    };
}
/** Stop polling targets whose final archived snapshot has been captured. */
export function settleActivityMonitorTargets(keys) {
    let changed = false;
    for (const key of keys) {
        const target = targets.get(key);
        if (target?.active !== true)
            continue;
        target.active = false;
        changed = true;
    }
    if (changed)
        publishTargets();
}
/** Subscribe to the shared live/archive snapshot. */
export function subscribeActivitySnapshots(listener) {
    snapshotListeners.add(listener);
    return () => { snapshotListeners.delete(listener); };
}
/** Read the stable shared live/archive snapshot. */
export function getActivitySnapshotsSnapshot() {
    return activitySnapshots;
}
/** Publish one or both successful state-route responses. */
export function updateActivitySnapshots(update) {
    const next = {
        teams: update.teams ?? activitySnapshots.teams,
        archivedTeams: update.archivedTeams ?? activitySnapshots.archivedTeams,
    };
    if (next.teams === activitySnapshots.teams && next.archivedTeams === activitySnapshots.archivedTeams)
        return;
    activitySnapshots = next;
    for (const listener of snapshotListeners)
        listener();
}
/** Poll cadence for the live host snapshot route. */
export const ACTIVITY_POLL_MS = 1000;
/**
 * Low-frequency probe cadence while a cardless discovery session still owns
 * no team. The probe keeps the panel able to pick up a team created later in
 * that session (e.g. a run_code-wrapped agent_teams_create) without turning
 * every ordinary session into a one-second filesystem scan.
 */
export const ACTIVITY_PROBE_MS = 5000;
/** Host route serving live and archived team snapshots. */
export const ACTIVITY_STATE_URL = '/plugins/dsh-agent-teams/state';
/**
 * Start the single polling loop for the current session's requested targets.
 *
 * With neither targets nor a discovery session this is deliberately inert.
 * Explicit card targets poll at the live cadence from the start. A discovery
 * session performs an immediate live+archive restore pass, then — while it
 * still owns no team — probes on a low-frequency cadence, so a team created
 * later in that session (e.g. a run_code-wrapped agent_teams_create) is
 * discovered without a manual reload, without turning every ordinary session
 * into a one-second filesystem scan. The moment a team for the discovery
 * session appears, the controller upgrades to the live one-second cadence for
 * the rest of its lifetime. The caller — the session view, which stops the
 * controller when the session is no longer current — bounds the lifetime, and
 * archive state is refreshed when a target or a previously discovered live
 * team disappears.
 */
export function startActivityPolling(monitorTargets, runtime = {}) {
    const discoverySessionId = runtime.discoverySessionId?.trim();
    if (monitorTargets.length === 0 && (discoverySessionId === undefined || discoverySessionId === '')) {
        return { firstTick: Promise.resolve(), stop: () => { } };
    }
    const fetchState = runtime.fetchState ?? ((url, init) => fetch(url, init));
    const schedule = runtime.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    const cancel = runtime.cancel ?? ((timer) => { clearInterval(timer); });
    const publishSnapshots = runtime.publishSnapshots ?? updateActivitySnapshots;
    const settleTargets = runtime.settleTargets ?? settleActivityMonitorTargets;
    let cancelled = false;
    let inFlight = false;
    // Explicit card targets are demanded work: start at the live cadence. A
    // discovery session starts probing low-frequency and upgrades on detection.
    let hot = monitorTargets.length > 0;
    let discoveryComplete = false;
    let discoveredLiveKeys = new Set();
    let controller;
    let timer;
    const intervalMs = () => (hot ? ACTIVITY_POLL_MS : ACTIVITY_PROBE_MS);
    const reschedule = () => {
        cancel(timer);
        timer = schedule(() => { void tick(); }, intervalMs());
    };
    const tick = async () => {
        if (inFlight || cancelled)
            return;
        inFlight = true;
        controller = new AbortController();
        try {
            const liveResponse = await fetchState(ACTIVITY_STATE_URL, {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!liveResponse.ok)
                return;
            const body = (await liveResponse.json());
            if (cancelled || !Array.isArray(body.teams))
                return;
            const liveTeams = body.teams;
            publishSnapshots({ teams: liveTeams });
            const previousDiscoveredKeys = discoveredLiveKeys;
            discoveredLiveKeys = new Set(discoverySessionId === undefined || discoverySessionId === ''
                ? []
                : liveTeams
                    .filter((team) => team.captainSessionId === discoverySessionId)
                    .map((team) => team.teamId));
            // A discovery session found its first team: upgrade from the low-frequency
            // probe to the live cadence for the rest of the controller lifetime.
            if (!hot && discoveredLiveKeys.size > 0) {
                hot = true;
                reschedule();
            }
            const discoveredTeamArchived = [...previousDiscoveredKeys]
                .some((teamId) => !discoveredLiveKeys.has(teamId));
            const missing = monitorTargets.filter((target) => !liveTeams.some((team) => team.captainSessionId === target.sessionId && team.teamId === target.teamId));
            const needsDiscoveryArchive = discoverySessionId !== undefined
                && discoverySessionId !== ''
                && !discoveryComplete;
            if (missing.length === 0 && !needsDiscoveryArchive && !discoveredTeamArchived)
                return;
            // Archives are immutable per team generation. A successful fallback
            // retires every missing explicit target, including legacy cards whose
            // host archive no longer exists; a discovery session that already
            // upgraded keeps polling, and a still-probing one keeps probing, so a
            // team created later in the same session stays discoverable.
            const archivedResponse = await fetchState(`${ACTIVITY_STATE_URL}?archived=1`, {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!archivedResponse.ok)
                return;
            const archivedBody = (await archivedResponse.json());
            if (cancelled || !Array.isArray(archivedBody.teams))
                return;
            publishSnapshots({ archivedTeams: archivedBody.teams });
            discoveryComplete = true;
            settleTargets(new Set(missing.map((target) => target.key)));
        }
        catch (error) {
            if (error?.name === 'AbortError')
                return;
            // Host restarting; keep the last snapshot and retry on the next tick.
        }
        finally {
            inFlight = false;
        }
    };
    const firstTick = tick();
    if (timer === undefined)
        timer = schedule(() => { void tick(); }, intervalMs());
    return {
        firstTick,
        stop: () => {
            if (cancelled)
                return;
            cancelled = true;
            controller?.abort();
            cancel(timer);
        },
    };
}

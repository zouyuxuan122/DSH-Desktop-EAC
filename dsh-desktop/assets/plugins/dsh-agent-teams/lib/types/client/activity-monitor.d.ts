/** Shared, demand-driven state for the AgentTeams browser monitor. */
/** One member row of a host snapshot. */
export interface ActivityMember {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly executionPrompt?: string;
    readonly status?: 'idle' | 'working' | 'removed';
    readonly activity: 'working' | 'idle' | 'unknown';
    readonly progress: number;
    readonly done: number;
    readonly total: number;
    readonly currentTask: string;
    readonly unread: number;
}
/** One task row of a host snapshot. */
export interface ActivityTask {
    readonly id: string;
    readonly subject: string;
    readonly description?: string;
    readonly status: string;
    readonly state: 'blocked' | 'open' | 'running' | 'completed' | 'failed' | 'cancelled';
    readonly assignee: string;
    readonly model?: string;
    readonly dependencies: readonly string[];
    readonly depth: number;
    readonly kind?: string;
    readonly round?: number;
    readonly verdict?: string;
}
/** One captain-inbox preview row. */
export interface ActivityMessage {
    readonly from: string;
    readonly content: string;
}
/** One team snapshot (mirrors the host TeamActivitySnapshot). */
export interface ActivityTeam {
    readonly workspace: string;
    readonly teamId: string;
    readonly name: string;
    readonly description?: string;
    readonly captainSessionId: string;
    readonly phase: 'staged' | 'running';
    readonly planReviewState?: 'awaiting_review' | 'awaiting_feedback';
    readonly halted?: boolean;
    readonly members: readonly ActivityMember[];
    readonly tasks: readonly ActivityTask[];
    readonly messageCount: number;
    readonly captainInbox: readonly ActivityMessage[];
}
/** A successfully-created conversation card that currently needs updates. */
export interface ActivityMonitorTarget {
    readonly key: string;
    readonly sessionId: string;
    readonly teamId: string;
}
/** Latest shared response data for both the floater and conversation cards. */
export interface ActivitySnapshots {
    readonly teams: readonly ActivityTeam[];
    readonly archivedTeams: readonly ActivityTeam[];
}
/** Subscribe to the active monitor-target list (React external-store shape). */
export declare function subscribeActivityMonitorTargets(listener: () => void): () => void;
/** Read the stable active-target snapshot. */
export declare function getActivityMonitorTargetsSnapshot(): readonly ActivityMonitorTarget[];
/**
 * Register one successful AgentTeams card as a monitoring demand.
 *
 * The returned cleanup is reference-counted so multiple cards and React
 * StrictMode remounts cannot stop another card's monitor.
 */
export declare function monitorAgentTeam(sessionId: string, teamId: string): () => void;
/** Stop polling targets whose final archived snapshot has been captured. */
export declare function settleActivityMonitorTargets(keys: ReadonlySet<string>): void;
/** Subscribe to the shared live/archive snapshot. */
export declare function subscribeActivitySnapshots(listener: () => void): () => void;
/** Read the stable shared live/archive snapshot. */
export declare function getActivitySnapshotsSnapshot(): ActivitySnapshots;
/** Publish one or both successful state-route responses. */
export declare function updateActivitySnapshots(update: Partial<ActivitySnapshots>): void;
/** Poll cadence for the live host snapshot route. */
export declare const ACTIVITY_POLL_MS = 1000;
/**
 * Low-frequency probe cadence while a cardless discovery session still owns
 * no team. The probe keeps the panel able to pick up a team created later in
 * that session (e.g. a run_code-wrapped agent_teams_create) without turning
 * every ordinary session into a one-second filesystem scan.
 */
export declare const ACTIVITY_PROBE_MS = 5000;
/** Host route serving live and archived team snapshots. */
export declare const ACTIVITY_STATE_URL = "/plugins/dsh-agent-teams/state";
export declare const ACTIVITY_HALT_URL = "/plugins/dsh-agent-teams/halt";
interface ActivityFetchResponse {
    readonly ok: boolean;
    json(): Promise<unknown>;
}
/** Injectable browser primitives used by the poll controller and its tests. */
export interface ActivityPollingRuntime {
    /**
     * Current captain session to discover after a cold client/host restart.
     * This one-time scope restores teams whose older conversation log has no
     * AgentTeams card capable of registering an explicit monitor target.
     */
    readonly discoverySessionId?: string;
    readonly fetchState?: (url: string, init: {
        readonly cache: 'no-store';
        readonly signal: AbortSignal;
    }) => Promise<ActivityFetchResponse>;
    readonly schedule?: (callback: () => void, intervalMs: number) => unknown;
    readonly cancel?: (timer: unknown) => void;
    readonly publishSnapshots?: (update: Partial<ActivitySnapshots>) => void;
    readonly settleTargets?: (keys: ReadonlySet<string>) => void;
}
/** Handle returned by one current-session polling loop. */
export interface ActivityPollingController {
    /** The immediate first pass, exposed so offline verification can await it. */
    readonly firstTick: Promise<void>;
    /** Idempotently stop the timer and abort the current request. */
    stop(): void;
}
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
export declare function startActivityPolling(monitorTargets: readonly ActivityMonitorTarget[], runtime?: ActivityPollingRuntime): ActivityPollingController;
export {};

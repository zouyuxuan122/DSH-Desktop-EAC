/** Pure relationship projections used by the AgentTeams activity panel. */
/** Reference-panel geometry: narrow nodes with enough room for curved edges. */
export const COMPACT_DAG_NODE_WIDTH = 92;
export const COMPACT_DAG_NODE_HEIGHT = 30;
export const COMPACT_DAG_COLUMN_GAP = 26;
export const COMPACT_DAG_ROW_GAP = 8;
/** Compact `provider/model` route, or just the model when the provider is absent. */
export function memberRouteLabel(member) {
    if (member === undefined)
        return '';
    const provider = member.provider?.trim() ?? '';
    const model = member.model?.trim() ?? '';
    if (provider !== '' && model !== '')
        return `${provider}/${model}`;
    return model;
}
/**
 * Compact route shown on a running task. Prefer the task's own snapshot
 * field; fall back to the assignee member when older hosts omit it.
 */
export function taskModelLabel(task, members) {
    const direct = task.model?.trim() ?? '';
    if (direct !== '')
        return direct;
    return memberRouteLabel(members.find((candidate) => candidate.name === task.assignee));
}
/** Short model id for tight DAG/chip surfaces (`openai/gpt-5.6-sol` → `gpt-5.6-sol`). */
export function compactModelLabel(route) {
    const trimmed = route.trim();
    if (trimmed === '')
        return '';
    const slash = trimmed.lastIndexOf('/');
    return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}
/** A live team the current captain still owns and has not halted. */
export function liveCaptainTeam(teams, sessionId) {
    const owner = sessionId?.trim() ?? '';
    if (owner === '')
        return undefined;
    return teams.find((team) => team.captainSessionId === owner && team.halted !== true);
}
/** Whether the captain chat should keep showing the in-progress banner. */
export function teamIsActive(team) {
    if (team.halted === true || team.phase === 'staged')
        return false;
    if (team.members.some((member) => member.activity === 'working' || member.status === 'working'))
        return true;
    if (team.tasks.some((task) => task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress'))
        return true;
    return team.members.length > 0 && team.tasks.length === 0;
}
/** Compact banner copy: running members, otherwise the current planning state. */
export function teamProgressSummary(team, separator) {
    const workingMembers = team.members.filter((member) => member.activity === 'working' || member.status === 'working');
    const runningTasks = team.tasks.filter((task) => task.status === 'claimed' || task.status === 'in_progress');
    const labels = runningTasks.map((task) => task.subject.trim() || task.id).filter((label) => label !== '');
    if (workingMembers.length > 0 || labels.length > 0) {
        return {
            working: Math.max(workingMembers.length, labels.length),
            detail: labels.slice(0, 2).join(separator),
        };
    }
    if (team.tasks.length === 0)
        return { working: 0, detail: '' };
    return { working: 0, detail: '' };
}
/** Use a fill-width grid when the task graph has no real dependency edges. */
export function usesParallelTaskGrid(tasks) {
    if (tasks.length === 0)
        return false;
    const taskIds = new Set(tasks.map((task) => task.id));
    return tasks.every((task) => task.dependencies.every((dependency) => !taskIds.has(dependency)));
}
/**
 * Whether an expanded activity panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export function activityPanelExpandedForSession(open, owner, current) {
    return open && owner !== undefined && owner === current;
}
/**
 * Auto-expand only for live teams that appear after the current session's
 * initial restore pass. Replayed cards, archived teams, and live teams restored
 * while reopening a conversation must remain behind the collapsed badge.
 */
export function activityPanelShouldAutoExpand({ alreadyAutoOpened, pageSettled, restoreComplete, previousLiveTeamIds, currentLiveTeamIds, }) {
    return !alreadyAutoOpened
        && pageSettled
        && restoreComplete
        && currentLiveTeamIds.some((teamId) => !previousLiveTeamIds.has(teamId));
}
/**
 * Resolve the task whose dependency chain should be highlighted.
 *
 * A pinned task is an explicit user choice. Keyboard focus takes precedence
 * over delayed pointer intent so an older hover timer cannot steal the active
 * chain from someone navigating the task map with the keyboard.
 */
export function dependencyFocusTaskId(pinnedTaskId, keyboardTaskId, hoverTaskId) {
    return pinnedTaskId ?? keyboardTaskId ?? hoverTaskId;
}
/** Group tasks by their precomputed dependency depth. */
export function taskStages(tasks) {
    const byDepth = new Map();
    for (const task of tasks) {
        const depth = Number.isFinite(task.depth) ? Math.max(0, Math.floor(task.depth)) : 0;
        const stage = byDepth.get(depth) ?? [];
        stage.push(task);
        byDepth.set(depth, stage);
    }
    return [...byDepth.entries()]
        .sort(([left], [right]) => left - right)
        .map(([depth, stageTasks]) => ({
        depth,
        tasks: stageTasks.slice().sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true })),
    }));
}
/**
 * Lay tasks out as the reference panel's compact left-to-right DAG.
 *
 * Columns are dependency-depth stages. Rows are stable task-id order within
 * each stage. Edges use cubic curves so fan-in remains readable without
 * turning every task into a large card.
 */
export function compactDagLayout(tasks) {
    const stages = taskStages(tasks);
    const positions = new Map();
    const nodes = [];
    for (const [column, stage] of stages.entries()) {
        for (const [row, task] of stage.tasks.entries()) {
            const x = column * (COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP);
            const y = row * (COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP);
            positions.set(task.id, { x, y });
            nodes.push({ task, x, y });
        }
    }
    const edges = [];
    for (const task of tasks) {
        const target = positions.get(task.id);
        if (target === undefined)
            continue;
        for (const dependency of task.dependencies) {
            const source = positions.get(dependency);
            if (source === undefined)
                continue;
            const x1 = source.x + COMPACT_DAG_NODE_WIDTH;
            const y1 = source.y + COMPACT_DAG_NODE_HEIGHT / 2;
            const x2 = target.x;
            const y2 = target.y + COMPACT_DAG_NODE_HEIGHT / 2;
            edges.push({
                from: dependency,
                to: task.id,
                path: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}`,
            });
        }
    }
    const rows = Math.max(1, ...stages.map((stage) => stage.tasks.length));
    return {
        width: stages.length === 0
            ? 0
            : stages.length * COMPACT_DAG_NODE_WIDTH + (stages.length - 1) * COMPACT_DAG_COLUMN_GAP,
        height: stages.length === 0
            ? 0
            : rows * COMPACT_DAG_NODE_HEIGHT + (rows - 1) * COMPACT_DAG_ROW_GAP,
        nodes,
        edges,
    };
}
/**
 * Return the complete upstream/downstream chain around one task.
 *
 * Traversal uses both dependency directions and remains cycle-safe, so the UI
 * can highlight every handoff related to the focused task even if malformed
 * durable data contains a cycle.
 */
export function relatedTaskIds(taskId, tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (!byId.has(taskId))
        return new Set();
    const dependents = new Map();
    for (const task of tasks) {
        for (const dependency of task.dependencies) {
            const targets = dependents.get(dependency) ?? [];
            targets.push(task.id);
            dependents.set(dependency, targets);
        }
    }
    const related = new Set();
    const upstreamSeen = new Set();
    const downstreamSeen = new Set();
    const visitUpstream = (id) => {
        if (upstreamSeen.has(id))
            return;
        upstreamSeen.add(id);
        related.add(id);
        for (const dependency of byId.get(id)?.dependencies ?? [])
            visitUpstream(dependency);
    };
    const visitDownstream = (id) => {
        if (downstreamSeen.has(id))
            return;
        downstreamSeen.add(id);
        related.add(id);
        for (const dependent of dependents.get(id) ?? [])
            visitDownstream(dependent);
    };
    visitUpstream(taskId);
    visitDownstream(taskId);
    return related;
}

/**
 * Pure quality-gate rules: contracts, path audit, completion, follow-up,
 * coverage, and resume. Tools and persistence call these; they do not I/O.
 * @module dsh-agent-teams/quality-gates
 */
import { FINDING_SEVERITIES, REVIEW_VERDICTS, TASK_KINDS, } from "./types.js";
const QUALITY_KINDS = [
    'requirements',
    'implementation',
    'verification',
    'review',
    'repair',
    'integration',
];
const WRITE_KINDS = ['implementation', 'repair'];
const OPEN_STATUSES = ['pending', 'claimed', 'in_progress'];
const DEFAULT_REVIEW_POLICY = {
    requirementsMinRounds: 1,
    requirementsMaxRounds: 4,
    codeMaxRounds: 3,
    maxRepairAttempts: 2,
};
export const DEFAULT_REVIEW_ACCEPTANCE = [
    'The latest implementation meets the user goal',
    'No unresolved blocker or high findings',
];
export const DEFAULT_REVIEW_OBJECTIVE = 'Review whether the latest implementation satisfies the user goal';
const GATE_TEST_CONTRACT = /needs[_ ]revision|拒绝路径|verdict\s*=\s*needs_revision|cannot complete|不能完成|触发拒绝/iu;
export function taskKindOf(task) {
    return task?.kind ?? 'work';
}
export function isQualityKind(kind) {
    return kind !== undefined && kind !== 'work' && QUALITY_KINDS.includes(kind);
}
export function resolveReviewPolicy(policy) {
    return {
        ...DEFAULT_REVIEW_POLICY,
        ...policy,
        requirementsMinRounds: policy?.requirementsMinRounds ?? DEFAULT_REVIEW_POLICY.requirementsMinRounds,
        requirementsMaxRounds: policy?.requirementsMaxRounds ?? DEFAULT_REVIEW_POLICY.requirementsMaxRounds,
        codeMaxRounds: policy?.codeMaxRounds ?? DEFAULT_REVIEW_POLICY.codeMaxRounds,
        maxRepairAttempts: policy?.maxRepairAttempts ?? DEFAULT_REVIEW_POLICY.maxRepairAttempts,
    };
}
export function isReviewPolicy(value) {
    if (value === undefined)
        return true;
    if (!isRecord(value))
        return false;
    const numbers = ['requirementsMinRounds', 'requirementsMaxRounds', 'codeMaxRounds', 'maxRepairAttempts'];
    for (const key of numbers) {
        const item = value[key];
        if (item === undefined)
            continue;
        if (!Number.isSafeInteger(item) || item < 1)
            return false;
    }
    const min = value['requirementsMinRounds'] ?? DEFAULT_REVIEW_POLICY.requirementsMinRounds;
    const max = value['requirementsMaxRounds'] ?? DEFAULT_REVIEW_POLICY.requirementsMaxRounds;
    if (min > max)
        return false;
    if (value['requiredReviewers'] !== undefined) {
        if (!Array.isArray(value['requiredReviewers']))
            return false;
        if (!value['requiredReviewers'].every((item) => typeof item === 'string' && item.trim() !== ''))
            return false;
    }
    const allowed = new Set([...numbers, 'requiredReviewers']);
    return Object.keys(value).every((key) => allowed.has(key));
}
/** Normalize a workspace-relative POSIX path. `undefined` means illegal. */
export function normalizeWorkspacePath(path) {
    if (typeof path !== 'string')
        return undefined;
    const trimmed = path.trim();
    if (trimmed === '')
        return undefined;
    if (trimmed.startsWith('~') || /^[A-Za-z]:/.test(trimmed))
        return undefined;
    const posix = trimmed.replaceAll('\\', '/');
    if (posix.startsWith('/'))
        return undefined;
    const parts = [];
    for (const part of posix.split('/')) {
        if (part === '' || part === '.')
            continue;
        if (part === '..')
            return undefined;
        parts.push(part);
    }
    return parts.join('/');
}
export function pathMatchesScope(path, pattern) {
    const normalizedPath = normalizeWorkspacePath(path);
    if (normalizedPath === undefined)
        return false;
    const rawPattern = pattern.trim().replaceAll('\\', '/');
    if (rawPattern.startsWith('~') || rawPattern.startsWith('/') || /^[A-Za-z]:/.test(rawPattern))
        return false;
    const directory = rawPattern.endsWith('/');
    const normalizedPattern = normalizeWorkspacePath(rawPattern);
    if (normalizedPattern === undefined) {
        if (directory && (rawPattern === './' || rawPattern === '/' || rawPattern === '.'))
            return true;
        return false;
    }
    if (directory || rawPattern === './' || rawPattern === '.') {
        if (normalizedPattern === '')
            return true;
        return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
    }
    return normalizedPath === normalizedPattern;
}
function isDefaultExcluded(path) {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === undefined)
        return false;
    const segments = normalized.split('/');
    const base = segments[segments.length - 1] ?? '';
    if (segments[0] === '.git' || segments[0] === '.dsh')
        return true;
    if (base === '.env' || base.startsWith('.env.'))
        return true;
    if (segments.includes('secrets'))
        return true;
    if (base.startsWith('id_rsa'))
        return true;
    return false;
}
export function classifyChangedPath(path, inScope = [], outOfScope = []) {
    if (normalizeWorkspacePath(path) === undefined)
        return 'illegal';
    if (isDefaultExcluded(path))
        return 'out_of_scope';
    if (outOfScope.some((pattern) => pathMatchesScope(path, pattern)))
        return 'out_of_scope';
    if (inScope.some((pattern) => pathMatchesScope(path, pattern)))
        return 'in_scope';
    return 'undeclared';
}
export function collectChangedPaths(gitStatusText) {
    const paths = [];
    const seen = new Set();
    for (const rawLine of gitStatusText.split(/\r?\n/u)) {
        const line = rawLine.trimEnd();
        if (line.trim() === '')
            continue;
        let candidate = line;
        const rename = /->\s+(\S+)$/u.exec(line);
        if (/^[ MADRCU?!]{1,2}\s+/u.test(line)) {
            candidate = rename?.[1] ?? line.replace(/^[ MADRCU?!]{1,2}\s+/u, '');
        }
        const cleaned = candidate.replace(/^"|"$/gu, '').trim();
        const normalized = normalizeWorkspacePath(cleaned);
        if (normalized === undefined || seen.has(normalized))
            continue;
        seen.add(normalized);
        paths.push(normalized);
    }
    return paths;
}
export function inScopeOverlap(left, right) {
    if (left === undefined || right === undefined)
        return [];
    const hits = [];
    for (const a of left) {
        for (const b of right) {
            if (pathMatchesScope(a, b) || pathMatchesScope(b, a) || a === b) {
                if (!hits.includes(a))
                    hits.push(a);
            }
        }
    }
    return hits;
}
function nonemptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}
function nonemptyStringList(value) {
    return Array.isArray(value) && value.length > 0 && value.every(nonemptyString);
}
function dependencyClosureContains(tasks, dependencies, targetId) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const pending = [...dependencies];
    const visited = new Set();
    while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined || visited.has(id))
            continue;
        if (id === targetId)
            return true;
        visited.add(id);
        pending.push(...(byId.get(id)?.dependencies ?? []));
    }
    return false;
}
export function validateCreateTask(team, input) {
    const kind = input.kind ?? 'work';
    if (!TASK_KINDS.includes(kind)) {
        return { ok: false, error: `unknown task kind "${String(kind)}"` };
    }
    if (team.halted === true) {
        const reason = input.resumeReason?.trim() ?? '';
        if (input.resume !== true || reason === '') {
            return { ok: false, error: 'team is halted; resume with a non-empty reason before create_task' };
        }
    }
    if (isQualityKind(kind)) {
        if (!nonemptyString(input.objective)) {
            return { ok: false, error: `${kind} tasks require a non-empty objective` };
        }
        if (!nonemptyStringList(input.acceptance)) {
            return { ok: false, error: `${kind} tasks require at least one acceptance criterion` };
        }
    }
    if (WRITE_KINDS.includes(kind)) {
        if (!nonemptyStringList(input.inScope)) {
            return { ok: false, error: `${kind} tasks require a non-empty inScope` };
        }
        if (!nonemptyStringList(input.verify)) {
            return { ok: false, error: `${kind} tasks require a non-empty verify list` };
        }
    }
    if (kind === 'review') {
        if (!nonemptyString(input.reviewedTaskId)) {
            return { ok: false, error: 'review tasks require reviewedTaskId' };
        }
        if (!team.tasks.some((item) => item.id === input.reviewedTaskId)) {
            return { ok: false, error: `reviewed task "${input.reviewedTaskId}" does not exist` };
        }
    }
    if (kind === 'repair') {
        if (!nonemptyString(input.sourceTaskId) || !nonemptyStringList(input.sourceFindingIds)) {
            return { ok: false, error: 'repair tasks require sourceTaskId and at least one sourceFindingId' };
        }
        if (!team.tasks.some((item) => item.id === input.sourceTaskId)) {
            return { ok: false, error: `source task "${input.sourceTaskId}" does not exist` };
        }
    }
    const dependencies = input.dependencies ?? [];
    for (const dependency of dependencies) {
        const upstream = team.tasks.find((item) => item.id === dependency);
        if (upstream === undefined) {
            return { ok: false, error: `dependency "${dependency}" does not exist` };
        }
        if ((kind === 'repair' || kind === 'review') && (upstream.status === 'failed' || upstream.status === 'cancelled')) {
            return { ok: false, error: `${kind} must not depend on ${upstream.status} task "${dependency}"` };
        }
    }
    if (WRITE_KINDS.includes(kind) && nonemptyStringList(input.inScope)) {
        for (const other of team.tasks) {
            if (!WRITE_KINDS.includes(taskKindOf(other)))
                continue;
            if (!OPEN_STATUSES.includes(other.status))
                continue;
            if (dependencies.includes(other.id) || other.dependencies.includes('pending-new'))
                continue;
            if (dependencies.includes(other.id))
                continue;
            const overlap = inScopeOverlap(input.inScope, other.inScope);
            if (overlap.length > 0) {
                return {
                    ok: false,
                    error: `inScope overlaps ${other.id} at ${overlap.join(', ')}; serialize these tasks or split the paths`,
                };
            }
        }
    }
    if (kind === 'implementation') {
        const requirements = team.tasks.filter((item) => taskKindOf(item) === 'requirements');
        const passed = requirements.some((item) => item.status === 'completed' && item.verdict === 'pass');
        const stagedBehindRequirements = team.phase === 'staged' && requirements.some((item) => (dependencyClosureContains(team.tasks, dependencies, item.id)));
        if (requirements.length > 0 && !passed && !stagedBehindRequirements) {
            return {
                ok: false,
                error: team.phase === 'staged'
                    ? 'implementation must depend on the staged requirements task; it will run only after requirements passes'
                    : 'implementation is blocked until a requirements task completes with verdict=pass',
            };
        }
    }
    const nextTeam = team.halted === true && input.resume === true
        ? { ...team, halted: false, haltedAt: undefined }
        : team;
    return {
        ok: true,
        kind,
        team: nextTeam,
        task: {
            subject: input.subject,
            kind,
            ...input.description === undefined ? {} : { description: input.description },
            ...input.assignee === undefined ? {} : { assignee: input.assignee },
            dependencies,
            ...input.round === undefined ? {} : { round: input.round },
            ...input.objective === undefined ? {} : { objective: input.objective },
            ...input.inScope === undefined ? {} : { inScope: input.inScope },
            ...input.outOfScope === undefined ? {} : { outOfScope: input.outOfScope },
            ...input.acceptance === undefined ? {} : { acceptance: input.acceptance },
            ...input.verify === undefined ? {} : { verify: input.verify },
            ...input.deliverables === undefined ? {} : { deliverables: input.deliverables },
            ...input.nonGoals === undefined ? {} : { nonGoals: input.nonGoals },
            ...input.reviewedTaskId === undefined ? {} : { reviewedTaskId: input.reviewedTaskId },
            ...input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId },
            ...input.sourceFindingIds === undefined ? {} : { sourceFindingIds: input.sourceFindingIds },
            ...input.coverageOf === undefined ? {} : { coverageOf: input.coverageOf },
        },
    };
}
const STATUS_TRANSITIONS = {
    pending: ['claimed', 'cancelled'],
    claimed: ['in_progress', 'failed', 'cancelled'],
    in_progress: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
};
function openHighFindings(findings) {
    return (findings ?? []).filter((finding) => (finding.resolved !== true && (finding.severity === 'high' || finding.severity === 'blocker')));
}
function acceptanceCovered(required, results) {
    if (results === undefined)
        return false;
    const byCriterion = new Map(results.map((item) => [item.criterion, item]));
    if ((required ?? []).every((criterion) => byCriterion.get(criterion)?.status === 'passed'))
        return true;
    // Structured result arrays naturally preserve the contract order. Accept a
    // same-length all-pass report even when a model paraphrases punctuation or
    // whitespace in `criterion`; verification evidence remains independently
    // required below. This avoids turning display text into an opaque id.
    return results.length === (required ?? []).length && results.every((item) => item.status === 'passed');
}
function verifyCovered(required, results) {
    if (results === undefined)
        return false;
    const byCommand = new Map(results.map((item) => [item.command, item]));
    if ((required ?? []).every((command) => byCommand.get(command)?.status === 'passed'))
        return true;
    return results.length === (required ?? []).length && results.every((item) => item.status === 'passed');
}
export function evaluateQualityCompletion(task, update) {
    const nextStatus = update.status;
    if (nextStatus !== undefined && nextStatus !== task.status) {
        if (!STATUS_TRANSITIONS[task.status].includes(nextStatus)) {
            return { ok: false, error: `task status cannot move from "${task.status}" to "${nextStatus}"` };
        }
    }
    const kind = taskKindOf(task);
    if (kind === 'work')
        return { ok: true };
    const verdict = update.verdict ?? task.verdict;
    const findings = update.findings ?? task.findings;
    if (kind === 'review' || kind === 'requirements') {
        if (nextStatus === 'completed') {
            if (verdict === undefined)
                return { ok: false, error: `${kind} cannot complete without verdict=pass` };
            if (verdict !== 'pass')
                return { ok: false, error: `${kind} with verdict=${verdict} cannot complete` };
            if (openHighFindings(findings).length > 0) {
                return { ok: false, error: `${kind} pass cannot leave unresolved high/blocker findings` };
            }
        }
        if (nextStatus === 'failed' && (verdict === 'needs_revision' || verdict === 'reject')) {
            if ((findings ?? []).length < 1) {
                return { ok: false, error: `${kind} ${verdict} requires at least one finding` };
            }
        }
        return { ok: true };
    }
    if (kind === 'implementation' || kind === 'repair' || kind === 'verification' || kind === 'integration') {
        const commands = update.commandsRun ?? task.commandsRun;
        if (commands?.some((item) => item.status === 'failed') === true) {
            if (nextStatus === 'completed') {
                return { ok: false, error: 'verify failure must fail the task', requiredStatus: 'failed' };
            }
        }
        if (nextStatus !== 'completed')
            return { ok: true };
        const acceptanceResults = update.acceptanceResults ?? task.acceptanceResults;
        if (acceptanceResults === undefined || !acceptanceCovered(task.acceptance, acceptanceResults)) {
            return { ok: false, error: `${kind} completion requires passed acceptanceResults for every acceptance item` };
        }
        if (commands === undefined || !verifyCovered(task.verify, commands)) {
            return { ok: false, error: `${kind} completion requires a passed commandsRun entry for every verify command` };
        }
        if (kind === 'implementation' || kind === 'repair') {
            const changed = update.changedPaths ?? task.changedPaths;
            if (changed === undefined) {
                return { ok: false, error: `${kind} completion requires changedPaths` };
            }
            for (const path of changed) {
                const classification = classifyChangedPath(path, task.inScope ?? [], task.outOfScope ?? []);
                if (classification !== 'in_scope') {
                    return { ok: false, error: `${kind} cannot complete: ${path} is ${classification}` };
                }
            }
        }
    }
    return { ok: true };
}
function unresolvedFindings(task) {
    return (task.findings ?? []).filter((finding) => finding.resolved !== true);
}
function findingKey(ids) {
    return [...ids].sort().join(',');
}
const CAPTAIN_ASSIGNEE = 'captain';
const OPEN_FOLLOW_UP_STATUSES = ['pending', 'claimed', 'in_progress'];
function schedulableAssignee(preferred, team, forbidden) {
    if (preferred !== undefined && preferred !== CAPTAIN_ASSIGNEE && preferred !== forbidden) {
        const live = team.members.find((member) => member.name === preferred && member.status !== 'removed');
        if (live !== undefined)
            return live.name;
    }
    return team.members.find((member) => (member.status !== 'removed'
        && member.name !== CAPTAIN_ASSIGNEE
        && member.name !== forbidden))?.name;
}
function countRepairAttempts(team, sourceTaskId, findingIds) {
    const key = findingKey(findingIds);
    return team.tasks.filter((item) => (taskKindOf(item) === 'repair'
        && item.sourceTaskId === sourceTaskId
        && findingKey(item.sourceFindingIds ?? []) === key)).length;
}
function hasOpenFollowUp(team, sourceTaskId, findingIds) {
    const key = findingKey(findingIds);
    return team.tasks.some((item) => (taskKindOf(item) === 'repair'
        && item.sourceTaskId === sourceTaskId
        && findingKey(item.sourceFindingIds ?? []) === key
        && OPEN_FOLLOW_UP_STATUSES.includes(item.status)));
}
export function planQualityFollowUp(team, closed) {
    const empty = { created: [], tasks: [] };
    const kind = taskKindOf(closed);
    if ((kind !== 'review' && kind !== 'requirements') || closed.status !== 'failed')
        return empty;
    if (closed.verdict === 'reject')
        return { ...empty, escalated: true, status: 'escalated' };
    if (closed.verdict !== 'needs_revision')
        return empty;
    const policy = resolveReviewPolicy(team.reviewPolicy);
    const currentRound = closed.round ?? 1;
    const nextRound = currentRound + 1;
    const maxRounds = kind === 'requirements' ? policy.requirementsMaxRounds : policy.codeMaxRounds;
    if (nextRound > maxRounds)
        return { ...empty, escalated: true, status: 'escalated' };
    if (kind === 'requirements') {
        const next = {
            kind: 'requirements',
            subject: `requirements-round-${nextRound}`,
            assignee: closed.assignee,
            dependencies: [],
            round: nextRound,
            objective: sanitizeReviewObjective(closed.objective, 'Converge remaining open questions'),
            acceptance: sanitizeReviewAcceptance(unresolvedFindings(closed).map((finding) => finding.requiredFix)),
        };
        return { created: [next], tasks: [next] };
    }
    const sourceId = closed.reviewedTaskId ?? closed.sourceTaskId;
    if (sourceId === undefined)
        return empty;
    const source = team.tasks.find((item) => item.id === sourceId);
    const findings = unresolvedFindings(closed);
    const findingIds = findings.map((finding) => finding.id);
    if (hasOpenFollowUp(team, sourceId, findingIds))
        return empty;
    if (countRepairAttempts(team, sourceId, findingIds) >= policy.maxRepairAttempts) {
        return { ...empty, escalated: true, status: 'escalated' };
    }
    const files = findings.map((finding) => finding.file).filter((file) => nonemptyString(file));
    const implementer = schedulableAssignee(source?.assignee, team);
    const repair = {
        id: `repair-round-${nextRound}`,
        kind: 'repair',
        subject: `repair-round-${nextRound}`,
        assignee: implementer,
        dependencies: [sourceId],
        round: nextRound,
        objective: source?.objective ?? closed.objective ?? `Fix findings from ${sourceId}`,
        inScope: files.length > 0 ? files : source?.inScope,
        outOfScope: source?.outOfScope,
        verify: source?.verify,
        acceptance: findings.map((finding) => finding.requiredFix),
        sourceTaskId: sourceId,
        sourceFindingIds: findingIds,
    };
    const reviewer = schedulableAssignee(closed.assignee !== implementer ? closed.assignee : undefined, team, implementer);
    const review = {
        id: `review-round-${nextRound}`,
        kind: 'review',
        subject: `review-round-${nextRound}`,
        assignee: reviewer,
        dependencies: [repair.id ?? `repair-round-${nextRound}`],
        round: nextRound,
        objective: sanitizeReviewObjective(closed.objective, DEFAULT_REVIEW_OBJECTIVE),
        acceptance: sanitizeReviewAcceptance(closed.acceptance),
        reviewedTaskId: repair.id,
    };
    return { created: [repair, review], tasks: [repair, review] };
}
export function buildCoverageMatrix(goalItems, tasks) {
    return goalItems.map((goalItem) => {
        const covering = tasks.filter((item) => item.coverageOf?.includes(goalItem));
        const taskIds = covering.map((item) => item.id);
        if (covering.length === 0)
            return { goal_item: goalItem, task_ids: taskIds, status: 'missing' };
        if (covering.some((item) => item.status === 'failed' || item.status === 'cancelled')) {
            return { goal_item: goalItem, task_ids: taskIds, status: 'blocked' };
        }
        if (covering.every((item) => item.status === 'completed')) {
            return { goal_item: goalItem, task_ids: taskIds, status: 'passed' };
        }
        return { goal_item: goalItem, task_ids: taskIds, status: 'in_progress' };
    });
}
export function canDeclareDelivery(team) {
    const blockers = [];
    const quality = team.tasks.filter((item) => isQualityKind(taskKindOf(item)));
    const implementations = quality.filter((item) => taskKindOf(item) === 'implementation' || taskKindOf(item) === 'repair');
    const reviews = quality.filter((item) => taskKindOf(item) === 'review');
    for (const item of quality) {
        const kind = taskKindOf(item);
        if (item.status === 'completed') {
            if ((kind === 'review' || kind === 'requirements') && item.verdict !== 'pass') {
                blockers.push(`${item.id} completed without verdict=pass`);
            }
            continue;
        }
        if (item.status === 'failed') {
            const repaired = kind === 'review'
                ? quality.some((candidate) => (taskKindOf(candidate) === 'repair'
                    && candidate.sourceTaskId === (item.reviewedTaskId ?? item.sourceTaskId)
                    && (candidate.status === 'pending' || candidate.status === 'claimed' || candidate.status === 'in_progress' || candidate.status === 'completed')))
                : kind === 'requirements'
                    ? quality.some((candidate) => (taskKindOf(candidate) === 'requirements'
                        && (candidate.round ?? 1) > (item.round ?? 1)))
                    : quality.some((candidate) => (taskKindOf(candidate) === 'repair' && candidate.sourceTaskId === item.id));
            if (!repaired)
                blockers.push(`${item.id} failed without a follow-up repair`);
            continue;
        }
        if (item.status === 'cancelled')
            continue;
        blockers.push(`${item.id} (${kind}) is not completed`);
    }
    if (implementations.some((item) => item.status === 'completed') && !reviews.some((item) => item.status === 'completed' && item.verdict === 'pass')) {
        if (!blockers.some((item) => item.includes('review'))) {
            blockers.push('completed implementation has no passing review');
        }
    }
    for (const item of implementations) {
        for (const path of item.changedPaths ?? []) {
            if (classifyChangedPath(path, item.inScope ?? [], item.outOfScope ?? []) !== 'in_scope') {
                blockers.push(`${item.id} has unaudited path ${path}`);
            }
        }
    }
    return { ok: blockers.length === 0, blockers };
}
export function resumeTeamState(team, reason) {
    if (!nonemptyString(reason)) {
        return { ok: false, status: 'rejected', error: 'resume requires a non-empty reason' };
    }
    if (team.halted !== true) {
        return { ok: true, status: 'already_running', team };
    }
    return {
        ok: true,
        status: 'resumed',
        team: {
            ...team,
            halted: false,
            haltedAt: undefined,
        },
    };
}
export function isReviewFinding(value) {
    if (!isRecord(value))
        return false;
    return nonemptyString(value['id'])
        && FINDING_SEVERITIES.includes(value['severity'])
        && nonemptyString(value['problem'])
        && nonemptyString(value['requiredFix'])
        && (value['file'] === undefined || nonemptyString(value['file']))
        && (value['line'] === undefined || (Number.isSafeInteger(value['line']) && value['line'] >= 0))
        && (value['resolved'] === undefined || typeof value['resolved'] === 'boolean');
}
export function isAcceptanceResult(value) {
    if (!isRecord(value))
        return false;
    return nonemptyString(value['criterion'])
        && (value['status'] === 'passed' || value['status'] === 'failed')
        && (value['evidence'] === undefined || typeof value['evidence'] === 'string');
}
export function isCommandResult(value) {
    if (!isRecord(value))
        return false;
    return nonemptyString(value['command'])
        && (value['status'] === 'passed' || value['status'] === 'failed')
        && (value['exitCode'] === undefined || (Number.isSafeInteger(value['exitCode'])))
        && (value['evidence'] === undefined || typeof value['evidence'] === 'string');
}
export function hasValidQualityTaskFields(value) {
    if (value['kind'] !== undefined && !TASK_KINDS.includes(value['kind']))
        return false;
    if (value['verdict'] !== undefined && !REVIEW_VERDICTS.includes(value['verdict']))
        return false;
    if (value['round'] !== undefined && !(Number.isSafeInteger(value['round']) && value['round'] >= 1))
        return false;
    if (value['objective'] !== undefined && !nonemptyString(value['objective']))
        return false;
    if (value['reviewedTaskId'] !== undefined && !nonemptyString(value['reviewedTaskId']))
        return false;
    if (value['sourceTaskId'] !== undefined && !nonemptyString(value['sourceTaskId']))
        return false;
    if (value['reviewedAttempt'] !== undefined && !(Number.isSafeInteger(value['reviewedAttempt']) && value['reviewedAttempt'] >= 0)) {
        return false;
    }
    const stringLists = ['inScope', 'outOfScope', 'acceptance', 'verify', 'deliverables', 'nonGoals', 'changedPaths', 'sourceFindingIds', 'coverageOf'];
    for (const key of stringLists) {
        if (value[key] === undefined)
            continue;
        if (!Array.isArray(value[key]) || !value[key].every(nonemptyString))
            return false;
    }
    if (value['findings'] !== undefined) {
        if (!Array.isArray(value['findings']) || !value['findings'].every(isReviewFinding))
            return false;
        const ids = value['findings'].map((finding) => finding.id);
        if (new Set(ids).size !== ids.length)
            return false;
    }
    if (value['acceptanceResults'] !== undefined) {
        if (!Array.isArray(value['acceptanceResults']) || !value['acceptanceResults'].every(isAcceptanceResult))
            return false;
    }
    if (value['commandsRun'] !== undefined) {
        if (!Array.isArray(value['commandsRun']) || !value['commandsRun'].every(isCommandResult))
            return false;
    }
    return true;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isTaskKind(value) {
    return typeof value === 'string' && TASK_KINDS.includes(value);
}
export function isReviewVerdict(value) {
    return typeof value === 'string' && REVIEW_VERDICTS.includes(value);
}
export function isFindingSeverity(value) {
    return typeof value === 'string' && FINDING_SEVERITIES.includes(value);
}
export function looksLikeGateTestContract(value) {
    return typeof value === 'string' && GATE_TEST_CONTRACT.test(value);
}
export function sanitizeReviewObjective(value, fallback = DEFAULT_REVIEW_OBJECTIVE) {
    if (!nonemptyString(value) || looksLikeGateTestContract(value))
        return fallback;
    return value.trim();
}
export function sanitizeReviewAcceptance(values) {
    const cleaned = (values ?? []).map((item) => item.trim()).filter((item) => item !== '' && !looksLikeGateTestContract(item));
    return cleaned.length > 0 ? cleaned : [...DEFAULT_REVIEW_ACCEPTANCE];
}
export function defaultQualityDeliveryGraph(input) {
    const goal = input.goal.trim() || 'the stated user goal';
    const analyst = input.analyst;
    const implementer = input.implementer;
    const tester = input.tester ?? input.implementer;
    const reviewer = input.reviewer;
    const integrator = input.integrator ?? input.reviewer;
    return [
        {
            subject: 'requirements-round-1',
            kind: 'requirements',
            assignee: analyst,
            dependencies: [],
            objective: `Converge requirements for: ${goal}`,
            acceptance: ['Open questions are closed or explicitly deferred', 'Acceptance criteria are testable'],
            coverageOf: [goal],
        },
        {
            subject: 'implementation',
            kind: 'implementation',
            assignee: implementer,
            dependencies: ['requirements-round-1'],
            objective: `Implement the approved requirements for: ${goal}`,
            acceptance: ['The implementation matches the approved requirements'],
            inScope: ['src/'],
            verify: ['pnpm test'],
            coverageOf: [goal],
        },
        {
            subject: 'verification',
            kind: 'verification',
            assignee: tester,
            dependencies: ['implementation'],
            objective: `Verify the implementation of: ${goal}`,
            acceptance: ['Declared verification commands pass'],
            coverageOf: [goal],
        },
        {
            subject: 'review-round-1',
            kind: 'review',
            assignee: reviewer,
            dependencies: ['verification'],
            objective: DEFAULT_REVIEW_OBJECTIVE,
            acceptance: [...DEFAULT_REVIEW_ACCEPTANCE],
            coverageOf: [goal],
        },
        {
            subject: 'integration',
            kind: 'integration',
            assignee: integrator,
            dependencies: ['review-round-1'],
            objective: `Confirm the team can declare delivery for: ${goal}`,
            acceptance: ['All required quality tasks are completed with passing reviews'],
            coverageOf: [goal],
        },
    ];
}
export function qualityPlanningPrompt() {
    return [
        'When the user explicitly requests full quality-mode planning, use this order unless a constraint forbids a stage: requirements → implementation → verification → review → integration.',
        'Build that entire DAG while the team is staged: an implementation may be created before requirements finishes when its dependency chain includes that requirements task. This is supported; do not wait for requirements to run and do not inspect plugin source to confirm it.',
        'A staged integration task may depend on review round 1. If that review later returns needs_revision, the system automatically rewires still-pending downstream dependencies to the generated repair + next-review gate, so keep integration in the original plan instead of omitting or manually recreating it.',
        'Derive inScope and verification commands from the actual workspace or explicit profile; never assume src/ or pnpm test.',
        'Give every quality task a contract. Review acceptance must judge the latest implementation, not whether the gate rejects needs_revision.',
        'Do not write smoke-test scripts into tasks. Do not ask reviewers to submit needs_revision on purpose.',
        'Do not claim implementation or review yourself unless the user asked the captain to take over.',
        'After a failed review, wait for the automatic repair + next review. Do not recreate that loop by hand.',
        'halted means the human stopped the team; call agent_teams_resume before creating more work. escalated means the automatic review loop hit its ceiling; that is not halt.',
    ].join(' ');
}
export function describeQualityLoop(team) {
    const delivery = canDeclareDelivery(team);
    if (team.halted === true) {
        return {
            state: 'halted',
            halted: true,
            escalated: team.escalated === true,
            deliverable: false,
            summary: 'Team is halted. Call agent_teams_resume with a reason before creating more work.',
        };
    }
    if (delivery.ok) {
        return {
            state: 'deliverable',
            halted: false,
            escalated: team.escalated === true,
            deliverable: true,
            summary: 'All required quality gates passed. The captain may report delivery.',
        };
    }
    if (team.escalated === true) {
        return {
            state: 'escalated',
            halted: false,
            escalated: true,
            deliverable: false,
            summary: 'Automatic review/repair loop hit its ceiling. The team is still running; do not treat this as halt. Escalate to the user instead of inventing another needs_revision cycle.',
        };
    }
    const open = team.tasks.some((item) => OPEN_STATUSES.includes(item.status));
    return {
        state: open ? 'running' : 'blocked',
        halted: false,
        escalated: false,
        deliverable: false,
        summary: open
            ? 'Work remains on the shared task list; wait for the scheduler or complete owned tasks.'
            : `Delivery is blocked: ${delivery.blockers.join('; ') || 'unresolved quality gates'}.`,
    };
}
export { QUALITY_KINDS, WRITE_KINDS };

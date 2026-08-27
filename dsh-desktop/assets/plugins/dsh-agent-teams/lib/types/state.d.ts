/**
 * Team state persistence and pure team-logic rules.
 *
 * State lives on disk under `<workspace>/<stateDir>/<teamId>/`:
 * - `team.json` — the durable {@link TeamState} record
 * - `inbox/<agentKey>.jsonl` — one JSONL mailbox per agent (`captain` or a
 *   member name), mirroring the Claude Code AgentTeams mailbox layout
 *
 * All mutations run through an in-process per-team queue so read-modify-write
 * stays serial; `fs/promises` is used directly because the plugin owns this
 * bookkeeping (host-plane state, like session persistence) and the abstract
 * `fs` service offers no directory deletion.
 * @module dsh-agent-teams/state
 */
import { type TaskStatus, type TeamMessage, type TeamState, type TeamTask } from './types.ts';
export { buildCoverageMatrix, canDeclareDelivery, classifyChangedPath, collectChangedPaths, defaultQualityDeliveryGraph, describeQualityLoop, evaluateQualityCompletion, hasValidQualityTaskFields, isQualityKind, pathMatchesScope, planQualityFollowUp, qualityPlanningPrompt, resumeTeamState, sanitizeReviewAcceptance, sanitizeReviewObjective, taskKindOf, validateCreateTask, } from './quality-gates.ts';
/** Mailbox key of the captain. */
export declare const CAPTAIN_KEY = "captain";
/**
 * Serialize mutations of one team across the whole process.
 * @param key - the team id (or any mutation scope).
 * @param fn - the mutation to run exclusively.
 * @returns the mutation's result.
 */
export declare function withTeamLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
/**
 * Fold a free-form name into a safe path/key segment.
 *
 * Unicode letters and digits survive, so CJK/Cyrillic/Greek names stay
 * distinct and readable; everything else — spaces, punctuation, path
 * separators, control characters — folds to `-`. An ASCII-only whitelist
 * mapped *every* non-Latin name onto one shared fallback, which silently
 * merged their mailboxes and rejected the second such member as a duplicate.
 *
 * A name with no letters or digits at all (pure emoji or punctuation) cannot
 * yield a readable key, so it gets a digest rather than a shared constant.
 * Over-long names are truncated with a digest appended, so names sharing a
 * long prefix stay distinct and the result stays within filesystem limits
 * (CJK costs 3 bytes per character in UTF-8).
 *
 * @param name - any user-supplied name.
 * @returns a non-empty key safe as a single path segment.
 */
export declare function sanitizeKey(name: string): string;
/**
 * Whether `dependencies` are all satisfied (every named task exists and
 * completed) for the given task list.
 * @param tasks - the team's tasks.
 * @param dependencies - task ids the candidate depends on.
 * @returns the ids that are still unsatisfied, empty when claimable.
 */
export declare function unsatisfiedDependencies(tasks: TeamTask[], dependencies: string[]): string[];
/**
 * The allowed task status transitions, keyed by current status.
 * Terminal statuses have no outgoing transitions.
 */
export declare const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>>;
/**
 * Validate one task status transition.
 * @param current - the task's current status.
 * @param next - the requested status.
 * @returns the transition error, or undefined when allowed.
 */
export declare function transitionError(current: TaskStatus, next: TaskStatus): string | undefined;
/** Activate the task's current generation for one owner and return its capability id. */
export declare function activateTaskAttempt(task: TeamTask, assignee: string): string;
/** Start a fresh task generation for one owner. */
export declare function beginTaskAttempt(task: TeamTask, assignee: string): string;
/**
 * Revoke the current worker immediately. Clearing its capability makes old
 * updates stale; a separate handoff generation serializes async quiescence.
 */
/** Cancel one unfinished task without returning it to the ready pool. */
export declare function cancelUnfinishedTask(task: TeamTask, output?: string): void;
export declare function invalidateTaskAttempt(task: TeamTask, nextAssignee?: string, reassigning?: boolean): void;
/**
 * Create the team directory structure and the initial team record.
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the initial team record.
 */
export declare function createTeamDir(stateRoot: string, state: TeamState): Promise<void>;
/**
 * Read one team record; `undefined` when absent.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 */
export declare function readTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined>;
/**
 * Synchronously read one team record while a continuable child is being
 * composed. Harness requires child setup contributions to be synchronous;
 * this narrow boundary lets a cold-resumed member restore its durable model
 * selection before its first request can be published.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 * @returns the team record, or `undefined` when absent.
 */
export declare function readTeamSync(stateRoot: string, teamId: string): TeamState | undefined;
/**
 * Persist one team record (inside the caller's lock).
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the record to persist.
 */
export declare function writeTeam(stateRoot: string, state: TeamState): Promise<void>;
/** Read the durable set of member session ids retired by remove/delete. */
export declare function readRetiredMemberIds(stateRoot: string): Promise<Set<string>>;
/** Atomically add session ids to the durable retired-member deny-list. */
export declare function recordRetiredMemberIds(stateRoot: string, memberIds: readonly string[]): Promise<void>;
/**
 * Find the team owned by one captain session (at most one per captain).
 * @param stateRoot - resolved absolute state root directory.
 * @param captainSessionId - the owning session id.
 * @returns the team record, or undefined when the captain leads no team.
 */
export declare function findTeamByCaptain(stateRoot: string, captainSessionId: string): Promise<TeamState | undefined>;
/**
 * Find the team in which one session is an active participant.
 * Captains match `captainSessionId`; members match their durable child session
 * id. Removed members no longer have access to team-scoped tools.
 * @param stateRoot - resolved absolute state root directory.
 * @param agentSessionId - calling captain/member session id.
 * @returns the team record, or undefined when the caller belongs to no team.
 */
export declare function findTeamByParticipant(stateRoot: string, agentSessionId: string): Promise<TeamState | undefined>;
/** Build a fresh message record. */
export declare function createMessage(from: string, to: string, content: string): TeamMessage;
/**
 * Append one message to an agent's mailbox (JSONL).
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param message - the message to append.
 */
export declare function appendMailbox(stateRoot: string, teamId: string, agentKey: string, message: TeamMessage): Promise<void>;
/**
 * Read one agent's whole mailbox, oldest first.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param onMalformedLine - optional diagnostic hook; malformed records are
 * skipped so one manually damaged line cannot make the whole team unreadable.
 * @returns the messages, empty when the mailbox does not exist yet.
 */
export declare function readMailbox(stateRoot: string, teamId: string, agentKey: string, onMalformedLine?: (lineNumber: number, error: unknown) => void): Promise<TeamMessage[]>;
/** Read only messages that have not been acknowledged by their recipient. */
export declare function readUnreadMailbox(stateRoot: string, teamId: string, agentKey: string, onMalformedLine?: (lineNumber: number, error: unknown) => void): Promise<TeamMessage[]>;
/** Lease selected fallback messages to one delivery path. */
export declare function claimMailboxDelivery(stateRoot: string, teamId: string, agentKey: string, messageIds: readonly string[]): Promise<void>;
/** Release a failed delivery lease so the scheduler can retry it later. */
export declare function releaseMailboxDelivery(stateRoot: string, teamId: string, agentKey: string, messageIds: readonly string[]): Promise<void>;
/**
 * Mark selected durable mailbox records delivered/read while preserving
 * malformed lines for diagnostics. Callers serialize this with the team lock.
 */
export declare function acknowledgeMailbox(stateRoot: string, teamId: string, agentKey: string, messageIds: readonly string[]): Promise<void>;
/** Filesystem primitives used by {@link replaceFileAtomicOrDirect}; injectable for tests. */
export interface AtomicReplacePrimitives {
    rename: (from: string, to: string) => Promise<void>;
    writeFile: (file: string, content: string) => Promise<void>;
    remove: (file: string) => Promise<void>;
}
/** Tuning knobs for {@link replaceFileAtomicOrDirect} (defaults match production). */
export interface AtomicReplaceOptions {
    /** Rename attempts before the direct-write fallback (default 3). */
    retries?: number;
    /** Delay between rename attempts in ms (default 50). */
    retryDelayMs?: number;
}
/**
 * Replace `file` with `content`, preferring an atomic same-directory rename of
 * an already-written temp file.
 *
 * On Windows, `rename(tmp, file)` over an existing target throws EPERM while
 * any other process keeps the target open without FILE_SHARE_DELETE (editors,
 * indexers, antivirus scans, preview panes). By that point the payload has
 * already been fully written to the temp file, so a direct overwrite of the
 * target is a content-equivalent degraded path: retry the rename a few times
 * (transient locks clear quickly), then write the target in place. Every path
 * removes the temp file; when both the atomic rename and the direct write
 * fail, the combined error surfaces as an {@link AggregateError}.
 *
 * @returns nothing once the file has been replaced by one of the two paths.
 */
export declare function replaceFileAtomicOrDirect(temporary: string, file: string, content: string, primitives: AtomicReplacePrimitives, options?: AtomicReplaceOptions): Promise<void>;
export declare function isTeamTask(value: unknown): value is TeamTask;
/**
 * Remove a team's whole directory (members should be interrupted first).
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export declare function removeTeamDir(stateRoot: string, teamId: string): Promise<void>;
/**
 * Archive a team instead of deleting it: the whole directory (team.json with
 * tasks and dependency graph, plus the mailboxes) moves under
 * `<stateRoot>/archive/<teamId>/` so later sessions can review how tasks were
 * planned and rebuild dependency relationships. The archive directory has no
 * team.json of its own, so the live activity scan skips it naturally.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export declare function archiveTeamDir(stateRoot: string, teamId: string): Promise<void>;
/**
 * Read one archived team (already moved under `archive/`), or undefined when
 * it was never archived.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export declare function readArchivedTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined>;
/**
 * List every archived team id under the state root.
 * @param stateRoot - resolved absolute state root directory.
 * @returns the archived team ids, empty when the archive does not exist.
 */
export declare function listArchivedTeamIds(stateRoot: string): Promise<string[]>;
/** Visual task state for the activity panel. */
export type VisualTaskState = 'blocked' | 'open' | 'running' | 'completed' | 'failed' | 'cancelled';
/**
 * The visual state of one task: `running` while in_progress, `completed`
 * when done, `failed`/`cancelled` when terminal without success, `blocked`
 * while any dependency is unfinished, else `open`.
 */
export declare function taskVisualState(status: string, dependencies: readonly string[], tasks: readonly TeamTask[]): VisualTaskState;
/**
 * Longest dependency path depth per task id (each depth = one lane column).
 */
export declare function taskDepthsById(tasks: readonly TeamTask[]): Map<string, number>;

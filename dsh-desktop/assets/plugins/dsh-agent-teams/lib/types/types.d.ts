/**
 * Durable AgentTeams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-agent-teams/types
 */
/** Task lifecycle statuses in progression order. */
export type TaskStatus = 'pending' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
/** Statuses after which a task can no longer be claimed or worked on. */
export declare const TERMINAL_TASK_STATUSES: readonly TaskStatus[];
/** Structured quality-gate kind. Absent / unknown values are treated as `work`. */
export type TaskKind = 'requirements' | 'implementation' | 'verification' | 'review' | 'repair' | 'integration' | 'work';
export declare const TASK_KINDS: readonly TaskKind[];
/** Review / requirements conclusion. Only `pass` may complete those kinds. */
export type ReviewVerdict = 'pass' | 'needs_revision' | 'reject';
export declare const REVIEW_VERDICTS: readonly ReviewVerdict[];
/** Finding severity used by review / requirements output. */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'blocker';
export declare const FINDING_SEVERITIES: readonly FindingSeverity[];
/** One structured review finding. */
export interface ReviewFinding {
    /** Stable id, for example `SEC-001`. */
    id: string;
    severity: FindingSeverity;
    file?: string;
    line?: number;
    problem: string;
    requiredFix: string;
    resolved?: boolean;
}
/** One acceptance criterion result recorded at completion. */
export interface AcceptanceResult {
    criterion: string;
    status: 'passed' | 'failed';
    evidence?: string;
}
/** One verification command result recorded at completion. */
export interface CommandResult {
    command: string;
    status: 'passed' | 'failed';
    exitCode?: number;
    evidence?: string;
}
/** Profile / team review-loop limits. */
export interface ReviewPolicy {
    requirementsMinRounds?: number;
    requirementsMaxRounds?: number;
    codeMaxRounds?: number;
    maxRepairAttempts?: number;
    requiredReviewers?: string[];
}
/** One task of a team's task list. */
export interface TeamTask {
    /** Stable task id from the profile template; absent for ad-hoc tasks. */
    profileSeedId?: string;
    /** Stable task id within the team (`t1`, `t2`, …). */
    id: string;
    /** Brief title for the task. */
    subject: string;
    /** What needs to be done. */
    description?: string;
    status: TaskStatus;
    /** Member name (or `captain`) the task is assigned to; unassigned tasks await a claim. */
    assignee?: string;
    /** Task ids that must reach `completed` before this task can be claimed. */
    dependencies: string[];
    /** The worker's written result, set when the task completes or fails. */
    output?: string;
    /** Monotonic execution generation. Reassignment/retry invalidates every older attempt. */
    attempt?: number;
    /** Capability for the current claimed/in-progress attempt. Members must present it when updating. */
    attemptId?: string;
    /** Opaque generation for a revocation/handoff that has not started its next attempt yet. */
    handoffId?: string;
    /** A handoff is quiescing the old owner; the scheduler must not dispatch it yet. */
    reassigning?: boolean;
    /** Quality-gate kind. Missing values are treated as `work`. */
    kind?: TaskKind;
    /** Review / requirements / repair loop index, 1-based when present. */
    round?: number;
    verdict?: ReviewVerdict;
    findings?: ReviewFinding[];
    objective?: string;
    inScope?: string[];
    outOfScope?: string[];
    acceptance?: string[];
    verify?: string[];
    deliverables?: string[];
    nonGoals?: string[];
    changedPaths?: string[];
    acceptanceResults?: AcceptanceResult[];
    commandsRun?: CommandResult[];
    reviewedTaskId?: string;
    reviewedAttempt?: number;
    /** Repair source: the implementation / previous successful artifact. */
    sourceTaskId?: string;
    sourceFindingIds?: string[];
    /** User-constraint / goal items this task claims to cover. */
    coverageOf?: string[];
    createdAt: number;
    updatedAt: number;
}
/** Member lifecycle status. */
export type MemberStatus = 'idle' | 'working' | 'removed';
/** One team member: a continuable subagent plus its team-side record. */
export interface TeamMember {
    /** Durable continuable subagent session id (empty until spawned). */
    id: string;
    /** Unique display name inside the team. */
    name: string;
    /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
    role?: string;
    /** Resolved LLM provider route captured when this member was created. */
    provider?: string;
    /** Resolved model captured when this member was created. */
    model?: string;
    /** Resolved reasoning effort captured from the captain or target model default. */
    reasoningEffort?: string;
    /** Prompt specific to this member's execution turns. */
    executionPrompt?: string;
    /** Configured second-choice route. */
    fallback?: TeamModelFallback;
    /** Active route after fallback, without changing the primary descriptor route. */
    activeProvider?: string;
    activeModel?: string;
    /** Whether the fallback route is currently active. */
    fallbackActive?: boolean;
    joinedAt: number;
    status: MemberStatus;
}
/** One mailbox message. */
export interface TeamMessage {
    id: string;
    /** `captain` or a member name. */
    from: string;
    /** `captain` or a member name. */
    to: string;
    content: string;
    ts: number;
    /** Process-local delivery lease; prevents fallback and direct delivery racing. */
    deliveryClaimedAt?: number;
    /** Set after the durable message was accepted by the recipient's live Harness inbox. */
    deliveredAt?: number;
    /** Set once the recipient has consumed or been shown the durable fallback. */
    readAt?: number;
}
/** Snapshot of the named profile used to seed a team. */
export interface TeamModelFallback {
    provider: string;
    model: string;
}
export interface TeamProfileSnapshot {
    name: string;
    description?: string;
    protocol?: string;
    executionPrompt?: string;
    fallback?: TeamModelFallback;
    /** Frozen planning mode: captain plans the graph; seed keeps template tasks. */
    taskPlanning?: 'captain' | 'seed';
    /** Frozen review-loop policy from the creating profile. */
    reviewPolicy?: ReviewPolicy;
}
/** The full durable team record. */
export interface TeamState {
    /** Original team name. */
    name: string;
    /** Sanitized directory id; the team's stable identity. */
    id: string;
    /** Team purpose/goal. */
    description?: string;
    /** Immutable named profile snapshot, when created from a profile. */
    profile?: TeamProfileSnapshot;
    /** Session id of the captain agent that owns this team. */
    captainSessionId: string;
    createdAt: number;
    /** Teammates only; the captain is implicit (the owning session). */
    members: TeamMember[];
    tasks: TeamTask[];
    /** Monotonic task id counter. */
    taskSeq: number;
    /**
     * Two-phase execution lifecycle. Missing means `running` for durable
     * compatibility with teams created before staging existed.
     */
    phase?: 'staged' | 'running';
    /**
     * Human-facing review sub-state while `phase` is `staged`. Missing staged
     * records are treated as `awaiting_review` for backward compatibility.
     * `awaiting_feedback` means the user returned to chat and the Captain must
     * ask what should change before editing this same draft.
     */
    planReviewState?: 'awaiting_review' | 'awaiting_feedback';
    /** Timestamp written only after a staged plan is explicitly approved. */
    approvedAt?: number;
    /**
     * Human halt from the captain chat. The team remains on disk, members stay
     * available, and unfinished work is cancelled until the captain resumes.
     */
    halted?: boolean;
    /** Timestamp of the latest human halt, when present. */
    haltedAt?: number;
    /** Review-loop policy snapshot copied from the creating profile, when present. */
    reviewPolicy?: ReviewPolicy;
    /** Set when an automatic review/repair loop hits its configured ceiling. */
    escalated?: boolean;
}

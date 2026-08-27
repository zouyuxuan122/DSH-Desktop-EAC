/**
 * Event-driven shared task scheduler.
 *
 * Claude Code teammates keep polling the shared task list after a turn. DSH
 * continuable agents instead expose explicit idle/running edges, so this
 * scheduler closes the same loop without keeping a polling turn alive: every
 * idle edge and every task-graph mutation attempts one atomic claim and wakes
 * the selected durable member. A resident member that becomes idle while it
 * still owns an open attempt is parked: only an explicit captain reassignment
 * may rotate that capability. Automatic retry is reserved for cold recovery,
 * when the durable owner is no longer resident in the live Agent registry.
 * @module dsh-agent-teams/scheduler
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TeamTask } from './types.ts';
/** Per-dependency output cap in the assignment prompt. */
export declare const DEPENDENCY_OUTPUT_MAX_CHARS = 2000;
/** Combined dependency-output budget in the assignment prompt. */
export declare const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12000;
export interface SchedulerConfig {
    readonly stateDir: string;
    readonly executionPrompt?: string;
}
export interface TeamScheduler {
    /** Try to give every genuinely idle/ready member one unit of ready work. */
    kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>;
    /** Try to flush fallback mail or give one member one ready task. */
    kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<void>;
}
/** One completed recursive dependency shown to the assignee. */
export interface DependencyOutput {
    readonly id: string;
    readonly subject: string;
    readonly profileSeedId?: string;
    readonly output?: string;
}
export interface DispatchTicket {
    readonly taskId: string;
    readonly memberName: string;
    readonly memberId: string;
    readonly attempt: number;
    readonly attemptId: string;
    readonly previousAssignee?: string;
    readonly subject: string;
    readonly description?: string;
    readonly teamDescription?: string;
    readonly profileProtocol?: string;
    readonly profileSeedId?: string;
    readonly dependencyOutputs: readonly DependencyOutput[];
    readonly executionPrompt?: string;
    readonly kind?: string;
    readonly round?: number;
    readonly objective?: string;
    readonly inScope?: readonly string[];
    readonly outOfScope?: readonly string[];
    readonly acceptance?: readonly string[];
    readonly verify?: readonly string[];
    readonly reviewedTaskId?: string;
}
/**
 * Recursively collect `status=completed` ancestors of `taskId` in topological
 * order (dependencies before dependents). Cycles stop that branch only.
 */
export declare function collectCompletedDependencyOutputs(tasks: readonly TeamTask[], taskId: string, warn?: (message: string) => void): DependencyOutput[];
/** Format completed-dependency outputs with per-item and total truncation. */
export declare function formatDependencyOutputs(items: readonly DependencyOutput[]): string;
export declare function assignmentPrompt(ticket: DispatchTicket, stateDir: string, teamId: string): string;
/** Install one scheduler and its member activity observer. */
export declare function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler;

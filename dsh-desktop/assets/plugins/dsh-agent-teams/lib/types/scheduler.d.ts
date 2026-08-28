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
export interface SchedulerConfig {
    readonly stateDir: string;
}
export interface TeamScheduler {
    /** Try to give every genuinely idle/ready member one unit of ready work. */
    kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>;
    /** Try to flush fallback mail or give one member one ready task. */
    kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<void>;
}
/** Install one scheduler and its member activity observer. */
export declare function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler;

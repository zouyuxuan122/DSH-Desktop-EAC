/**
 * AgentTeams session event types — pure types only, zero imports.
 *
 * This file intentionally imports nothing: both the host program (the
 * emitter in `events.ts`) and the browser program (the Conversation Node
 * definition) must be able to load these types and the `SessionEventMap`
 * declaration merge without pulling in host-side `Context` augmentations
 * (dsh-session's index declares `Context.sessions: SessionStore`, which
 * collides with the browser runtime's `ISessions` under the same name).
 * @module dsh-agent-teams/event-types
 */
/** Opens one team record: the captain created the team. */
export interface AgentTeamsTeamCreatedData {
    readonly teamId: string;
    /** The captain session that owns this team (UI follows it). */
    readonly captainSessionId: string;
    readonly name: string;
    readonly description?: string;
}
/** Records one member after its continuable subagent is spawned. */
export interface AgentTeamsMemberAddedData {
    readonly teamId: string;
    readonly memberId: string;
    readonly name: string;
    readonly role?: string;
}
/** Marks one member removed. */
export interface AgentTeamsMemberRemovedData {
    readonly teamId: string;
    readonly memberId: string;
}
/** Records one task in the team's task list. */
export interface AgentTeamsTaskCreatedData {
    readonly teamId: string;
    readonly taskId: string;
    readonly subject: string;
    readonly dependencies: readonly string[];
    readonly assignee?: string;
}
/** Records one task status/assignee/output transition. */
export interface AgentTeamsTaskUpdatedData {
    readonly teamId: string;
    readonly taskId: string;
    readonly status: string;
    readonly assignee?: string;
    readonly output?: string;
    readonly attempt?: number;
    readonly attemptId?: string;
}
/** Closes one team record: the team was deleted. */
export interface AgentTeamsTeamDeletedData {
    readonly teamId: string;
}
/** Records one mailbox message sent between team agents. */
export interface AgentTeamsMessageSentData {
    readonly teamId: string;
    readonly messageId: string;
    /** `captain` or a member name. */
    readonly from: string;
    /** `captain` or a member name. */
    readonly to: string;
    readonly content: string;
    readonly ts: number;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * Opens one team record.
         * @param data - stable team identity and display name.
         */
        'agent-teams/team-created': AgentTeamsTeamCreatedData;
        /**
         * Records one team member.
         * @param data - team identity, member child session, and display identity.
         */
        'agent-teams/member-added': AgentTeamsMemberAddedData;
        /**
         * Records one member removal.
         * @param data - team identity and the member's child session id.
         */
        'agent-teams/member-removed': AgentTeamsMemberRemovedData;
        /**
         * Records one task creation.
         * @param data - team identity, task id, subject, dependencies, assignee.
         */
        'agent-teams/task-created': AgentTeamsTaskCreatedData;
        /**
         * Records one task transition.
         * @param data - team identity, task id, and the new status/assignee/output.
         */
        'agent-teams/task-updated': AgentTeamsTaskUpdatedData;
        /**
         * Records one mailbox message.
         * @param data - team identity, sender, recipient, and content.
         */
        'agent-teams/message-sent': AgentTeamsMessageSentData;
        /**
         * Closes one team record after deletion.
         * @param data - stable team identity.
         */
        'agent-teams/team-deleted': AgentTeamsTeamDeletedData;
    }
}
/** The full set of `agent-teams/*` event names. */
export type AgentTeamsEventType = 'agent-teams/team-created' | 'agent-teams/member-added' | 'agent-teams/member-removed' | 'agent-teams/task-created' | 'agent-teams/task-updated' | 'agent-teams/message-sent' | 'agent-teams/team-deleted';

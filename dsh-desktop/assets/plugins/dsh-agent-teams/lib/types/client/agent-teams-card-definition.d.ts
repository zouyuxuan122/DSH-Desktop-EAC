/**
 * AgentTeams conversation card: a lightweight in-conversation summary shown
 * when a team is created — the captain's name, the member roster with whale
 * avatars, and an entry point that re-activates the top-right activity
 * panel (useful after the floater was closed, or when re-opening an old
 * session for review).
 *
 * The fold anchors to the Harness's durable `tool/call` + `tool/result`
 * records for `agent_teams_create`. Those are first-party session events, so
 * the card survives restarts without writing an out-of-repo event type.
 * @module dsh-agent-teams/client/card
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client';
/** Final keyed Chat payload for the team summary card. */
export interface AgentTeamsCardData {
    readonly teamId: string;
    /** The captain session that owns this team (panel follows it). */
    readonly captainSessionId: string;
    readonly teamName: string;
    readonly members: readonly {
        readonly id: string;
        readonly name: string;
        readonly role: string;
    }[];
}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ChatNodeDataMap {
        /** Lightweight team summary card anchoring the conversation. */
        'agent-teams': AgentTeamsCardData;
    }
}
/** Folded team record (the node's business state). */
export interface AgentTeamsNodeState {
    readonly teamId: string;
    readonly name: string;
    readonly accepted: boolean;
}
/** Parse the only create-call fields the historic card owns. */
export declare function parseAgentTeamsCreateArgs(value: string): {
    teamId: string;
    name: string;
} | undefined;
/** Durable first-party tool events folded into one keyed Chat node. */
export declare const agentTeamsCardDefinition: ConversationNodeDefinition<AgentTeamsNodeState>;

/**
 * AgentTeams conversation card: the lightweight in-conversation summary for
 * one team — the captain's whale avatar and name, the member roster as
 * clickable whale avatars (opening the member's subagent transcript), and
 * an "activity panel" button that re-activates the top-right floater.
 *
 * The floater and this card share the `agent-teams:open-panel` window event
 * so the card can summon the panel even after it was closed (or when an old
 * session is re-opened for review).
 * @module dsh-agent-teams/client/card
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
/** Window event name the floater listens for to open itself. */
export declare const OPEN_PANEL_EVENT = "agent-teams:open-panel";
/** Navigation action injected from the plugin's own SessionsService access. */
export interface AgentTeamsCardInjected {
    readonly openMember: (parentId: SessionId, childId: SessionId) => void;
}
/** Complete keyed Chat renderer props. */
export type AgentTeamsCardProps = PropsRuntime<'conversation.chat.node', 'agent-teams'> & PropsLocale<'agentTeams'> & AgentTeamsCardInjected;
/** Render one durable team as a compact conversation card. */
export declare function AgentTeamsCard({ node, openMember, sessionId, t }: AgentTeamsCardProps): import("react").JSX.Element;

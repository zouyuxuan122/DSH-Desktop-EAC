/** Browser plugin for the AgentTeams activity floater and conversation card. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type AgentTeamsLocaleKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** AgentTeams conversation card and activity monitor copy. */
        agentTeams: AgentTeamsLocaleKey;
    }
}
/** Required services: conversation nodes, slots, sessions navigation, and locale. */
export declare const inject: string[];
/**
 * Register the activity monitor in the shell's additive overlay and the
 * in-conversation team card. The card's activity button re-opens a folded
 * monitor via a window event — the recovery path for an old session.
 */
export declare function apply(ctx: ClientContext): void;

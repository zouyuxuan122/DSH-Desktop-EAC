/**
 * The `/agent-teams` slash command and its plain-text gesture boundary.
 *
 * Two deterministic activation paths, mirroring the Harness skill pipeline
 * (`dsh-tool-skill` + the `ui-skill` client source):
 *
 * 1. **Host command** — `ctx.commands.register` publishes the closed-namespace
 *    `/agent-teams` command. The web GUI's slash menu (the Harness
 *    `ui-commands` client) lists it from the host catalog with the input
 *    hint; the argued line is claimed client-side and executed through
 *    `command.execute`. The handler replays that exact line as an ordinary
 *    user follow-up (`agent.followup`) so it remains visible in the chat; the
 *    gesture boundary then adds the deterministic activation message.
 * 2. **Gesture boundary** — a `agent/pre-step` listener recognizes a leading
 *    `/agent-teams` token in genuine user messages and injects the same
 *    activation message. This covers surfaces with no command adjudication
 *    (headless CLI, API, pasted text in plain composers) and also handles the
 *    exact user line replayed by the host command. Mid-sentence mentions stay
 *    ordinary prose; only `source.kind === 'user'` messages are scanned, so
 *    injected or external text cannot forge the gesture.
 *
 * @module dsh-agent-teams/command
 */
import type { Context } from '@deepseek-ai/cordis';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
/** The slash command name (without the leading slash). */
export declare const AGENT_TEAMS_COMMAND = "agent-teams";
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /**
         * A deterministic `/agent-teams` activation injected after the visible
         * user-authored slash line.
         */
        'agent-teams-command': {
            readonly kind: 'agent-teams-command';
            /** The user-supplied goal text (absent when the gesture was bare). */
            readonly goal?: string;
        };
    }
}
/**
 * The deterministic activation text. The system-prompt usage section owns
 * the full protocol; this message only switches it on for one concrete goal.
 * @param goal - the user-supplied goal, or `''` for a bare invocation.
 */
export declare function buildActivationDirective(goal: string): string;
/**
 * The goal of the latest start-anchored `/agent-teams` gesture in genuine
 * user messages, or `undefined` when no message carries one. `''` means a
 * bare `/agent-teams` token with no goal.
 * @param messages - the step's claimed batch (user messages only scanned).
 */
export declare function invokedAgentTeamsGoal(messages: readonly UserMessage[]): string | undefined;
/**
 * Register the closed-namespace `/agent-teams` host command. The handler
 * preserves the exact submitted slash line as an ordinary user follow-up;
 * the pre-step gesture boundary injects the activation directive and wakes
 * the captain deterministically. The registration rides the calling
 * context's fiber, so a disposed scope (HMR, plugin removal) unregisters the
 * command.
 * @param ctx - host context providing the `commands` registry.
 */
export declare function registerAgentTeamsCommand(ctx: Context): void;
/**
 * Install the `agent/pre-step` gesture boundary: a claimed user message
 * starting with `/agent-teams` gains the deterministic activation message
 * appended after every other injection, closest to the model's answer.
 * @param ctx - host context providing the `agent/pre-step` waterfall.
 */
export declare function installAgentTeamsGestureBoundary(ctx: Context): void;

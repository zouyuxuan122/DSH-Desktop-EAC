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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** The slash command name (without the leading slash). */
export const AGENT_TEAMS_COMMAND = 'agent-teams';
/**
 * A leading, whitespace-bounded `/agent-teams` token — the command grammar
 * shape the harness uses (`parseCommand`): `/` inside words, file paths and
 * mid-sentence mentions never match.
 */
const GESTURE = /^\/agent-teams(?=$|[\t\n\r ])/u;
/**
 * The deterministic activation text. The system-prompt usage section owns
 * the full protocol; this message only switches it on for one concrete goal.
 * @param goal - the user-supplied goal, or `''` for a bare invocation.
 */
export function buildActivationDirective(goal) {
    const goalLine = goal === ''
        ? 'The goal was not given — ask the user what the team should accomplish.'
        : `Goal: ${goal}`;
    return [
        'The user invoked the `/agent-teams` command. Activate the AgentTeams protocol from your instructions now: you are the captain of a multi-agent team.',
        goalLine,
    ].join('\n');
}
/**
 * The goal of the latest start-anchored `/agent-teams` gesture in genuine
 * user messages, or `undefined` when no message carries one. `''` means a
 * bare `/agent-teams` token with no goal.
 * @param messages - the step's claimed batch (user messages only scanned).
 */
export function invokedAgentTeamsGoal(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined || message.source.kind !== 'user')
            continue;
        for (const block of message.content) {
            if (block.type !== 'text')
                continue;
            const text = block.text.trimStart();
            if (!GESTURE.test(text))
                continue;
            return text.slice(AGENT_TEAMS_COMMAND.length + 1).trim();
        }
    }
    return undefined;
}
/**
 * Register the closed-namespace `/agent-teams` host command. The handler
 * preserves the exact submitted slash line as an ordinary user follow-up;
 * the pre-step gesture boundary injects the activation directive and wakes
 * the captain deterministically. The registration rides the calling
 * context's fiber, so a disposed scope (HMR, plugin removal) unregisters the
 * command.
 * @param ctx - host context providing the `commands` registry.
 */
export function registerAgentTeamsCommand(ctx) {
    ctx.effect(() => ctx.commands.register({
        name: AGENT_TEAMS_COMMAND,
        description: 'run a goal with a multi-agent team (you become the captain)',
        input: { hint: '<goal — what the team should accomplish>' },
        handler(invocation) {
            const goal = invocation.rawInput.trim();
            if (goal === '') {
                return {
                    kind: 'error',
                    text: `Usage: /${AGENT_TEAMS_COMMAND} <goal — what the team should accomplish>`,
                };
            }
            invocation.agent.followup(createUserMessage({
                content: [{ type: 'text', text: `/${AGENT_TEAMS_COMMAND}${invocation.rawInput}` }],
                source: { kind: 'user' },
            }));
            return {
                kind: 'success',
                text: `AgentTeams activated — the captain will assemble a team for: ${goal}`,
            };
        },
    }), 'agent-teams: slash command');
}
/**
 * Install the `agent/pre-step` gesture boundary: a claimed user message
 * starting with `/agent-teams` gains the deterministic activation message
 * appended after every other injection, closest to the model's answer.
 * @param ctx - host context providing the `agent/pre-step` waterfall.
 */
export function installAgentTeamsGestureBoundary(ctx) {
    ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        const goal = invokedAgentTeamsGoal(messages);
        if (goal === undefined)
            return decision;
        signal.throwIfAborted();
        const activation = createUserMessage({
            content: [{ type: 'text', text: buildActivationDirective(goal) }],
            source: {
                kind: 'agent-teams-command',
                ...goal === '' ? {} : { goal },
            },
        });
        return { kind: 'enter', messages: [...decision.messages, activation] };
    });
}

/**
 * Member subagent lifecycle: spawn a continuable child per member, deliver
 * messages into its FIFO inbox, and observe its activity.
 *
 * Members are durable continuable subagents of the captain, so a member keeps
 * its conversation across turns and across harness restarts: the captain
 * wakes it with {@link ctx.subagents.followup}, it works through its turn
 * (updating team state through the `agent_teams_*` tools), and becomes idle
 * again. Its final assistant message is not readable programmatically, so the
 * member persists its report into the captain's mailbox and the task records,
 * which the captain reads through `agent_teams_status`.
 * @module dsh-agent-teams/members
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent';
// Declaration merge only: makes ctx.subagents visible.
import { foldSubagentDescriptor, SubagentError } from '@deepseek-ai/dsh-subagent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import { readRetiredMemberIds, readTeamSync, readTeam, withTeamLock, writeTeam } from "./state.js";
import { TERMINAL_TASK_STATUSES } from "./types.js";
/** Persona snapshot of a profile protocol; the full text lives on team.json. */
export const PERSONA_PROTOCOL_MAX_CHARS = 400;
/** Captain-only AgentTeams tools hidden from newly spawned members. */
const MEMBER_DENIED_TOOLS = [
    'agent_teams_create',
    'agent_teams_add_member',
    'agent_teams_remove_member',
    'agent_teams_reassign_task',
    'agent_teams_create_task',
    'agent_teams_resume',
    'agent_teams_delete',
];
/**
 * Restore the SessionId brand on a value that round-tripped through the
 * durable team file. The brand is erased by JSON serialization; the value
 * originated from `startContinuable`/`agent.id`, so this cast is the boundary
 * restoration, not a new assertion.
 */
function brandedSessionId(value) {
    return value;
}
/**
 * Validate a resolved roster against every provider catalog before any child
 * session is created. Catalogs are advisory when empty (some adapters accept
 * dynamic model ids), but a non-empty catalog is authoritative enough to
 * catch a typo that would otherwise boot a child and fail on its first turn.
 */
export async function validateMemberLlmSelections(ctx, selections, signal) {
    const catalogs = new Map();
    for (const selection of selections) {
        if (signal?.aborted === true)
            throw signal.reason ?? new Error('member model validation was cancelled');
        let catalog = catalogs.get(selection.provider);
        if (catalog === undefined) {
            catalog = await ctx.llm.listModels(selection.provider);
            catalogs.set(selection.provider, catalog);
        }
        if (catalog.length === 0 || catalog.some((model) => model.id === selection.model))
            continue;
        const available = catalog.slice(0, 8).map((model) => model.id).join(', ');
        throw new Error(`unknown member model "${selection.model}" for provider "${selection.provider}"`
            + `${available === '' ? '' : ` (available: ${available}${catalog.length > 8 ? ', …' : ''})`}`);
    }
}
const MEMBER_LABEL_PREFIX = 'agent-teams:';
const FALLBACK_FAILURE_CODES = new Set(['QUOTA', 'RATE_LIMIT', 'AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER']);
export function isFallbackFailureCode(code) {
    return FALLBACK_FAILURE_CODES.has(code);
}
/** Pure state transition used by the request-error handler and TDD tests. */
export function selectFallbackRoute(current, fallback, failureCode, alreadySwitched) {
    if (alreadySwitched || fallback === undefined || !isFallbackFailureCode(failureCode)) {
        return { retry: false, switched: alreadySwitched, selection: current };
    }
    return { retry: true, switched: true, selection: fallback };
}
async function updateFallbackState(stateRoot, teamId, memberName, fallback, ctx) {
    await withTeamLock(`team:${stateRoot}:${teamId}`, async () => {
        const team = await readTeam(stateRoot, teamId);
        if (team === undefined)
            return;
        const member = team.members.find(candidate => candidate.name === memberName);
        if (member === undefined)
            return;
        member.activeProvider = fallback.provider;
        member.activeModel = fallback.model;
        member.fallbackActive = true;
        await writeTeam(stateRoot, team);
    });
    void ctx;
}
function pendingSelectionKey(parentSessionId, label) {
    return `${parentSessionId}\u0000${label}`;
}
function selectionFromMember(member) {
    if (member?.provider === undefined || member.model === undefined)
        return undefined;
    const provider = (member.activeProvider ?? member.provider).trim();
    const model = (member.activeModel ?? member.model).trim();
    if (provider === '' || model === '')
        return undefined;
    const reasoningEffort = member.reasoningEffort?.trim();
    return {
        provider,
        model,
        ...reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort },
        ...member.fallback === undefined ? {} : { fallback: member.fallback },
    };
}
function modelSelection(selection) {
    return {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    };
}
/**
 * Resolve one member's complete model selection. Ordinary members snapshot the
 * captain's current request route and reasoning effort. When provider or model
 * changes, effort is intentionally omitted so the target model materializes
 * its own default instead of receiving an adapter-owned id from another route.
 * An explicit effort overrides either policy; the sentinel "default" also
 * selects the target model's default. The final effort is validated against
 * the target model before a child is created.
 */
export async function resolveMemberLlmSelection(ctx, captain, request, signal) {
    const explicitProvider = request.provider?.trim();
    const explicitModel = request.model?.trim();
    const defaultModel = request.defaultModel?.trim();
    const explicitEffort = request.reasoningEffort?.trim();
    const fallback = request.fallback;
    if (request.provider !== undefined && explicitProvider === '') {
        throw new Error('member LLM provider must not be empty');
    }
    if (request.model !== undefined && explicitModel === '') {
        throw new Error('member model must not be empty');
    }
    if (request.defaultModel !== undefined && defaultModel === '') {
        throw new Error('configured memberModel must not be empty');
    }
    if (request.reasoningEffort !== undefined && explicitEffort === '') {
        throw new Error('member reasoning effort must not be empty');
    }
    if (explicitProvider !== undefined && explicitModel === undefined) {
        throw new Error('an explicit member LLM provider requires an explicit member model');
    }
    const current = captain.session.requestHeader()?.config;
    const currentProvider = current?.provider ?? captain.options.provider;
    const currentModel = current?.model ?? captain.options.model;
    const provider = explicitProvider ?? currentProvider;
    const model = explicitModel ?? defaultModel ?? currentModel;
    if (provider === undefined || model === undefined) {
        throw new Error('cannot resolve the member LLM route from the current captain session');
    }
    // Effort ids belong to one exact provider/model capability. Preserve the
    // captain's effort only on the same route; a changed route must resolve its
    // own default. Explicit effort still wins, while "default" forces that
    // target-default behavior even when the route did not change.
    const sameRoute = provider === currentProvider && model === currentModel;
    const reasoningEffort = explicitEffort === undefined
        ? sameRoute
            ? current?.reasoningEffort
            : undefined
        : explicitEffort === 'default'
            ? undefined
            : ReasoningEffortId(explicitEffort);
    const resolved = await ctx.llm.resolveCallConfig({
        provider,
        model,
        ...reasoningEffort === undefined
            ? {}
            : { reasoningEffort },
    }, signal);
    return {
        provider: resolved.provider,
        model: resolved.model,
        ...resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: String(resolved.reasoningEffort) },
        ...fallback === undefined ? {} : { fallback },
    };
}
/**
 * Install the member selection bridge for every fresh or cold-resumed
 * continuable child. Fresh creation reads the pending in-memory selection;
 * cold resume restores the same selection from the owning team's durable
 * record. Legacy members without a complete saved route retain Harness's
 * descriptor provider/model behavior.
 */
export function installMemberSelectionRuntime(ctx, stateDir) {
    const pending = new Map();
    ctx.subagents.registerContinuableSetup((childCtx) => {
        const child = childCtx.agent;
        if (child === undefined)
            return () => undefined;
        const suffix = child.session.events.slice(child.session.header.seedLength ?? 0);
        const descriptor = foldSubagentDescriptor(suffix);
        if (descriptor?.mode !== 'continuable' || !descriptor.label.startsWith(MEMBER_LABEL_PREFIX)) {
            return () => undefined;
        }
        const parentSessionId = child.session.header.parentSession;
        if (parentSessionId === undefined)
            return () => undefined;
        const key = pendingSelectionKey(parentSessionId, descriptor.label);
        let selection = pending.get(key);
        if (selection === undefined) {
            const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length);
            const separator = identity.indexOf(':');
            if (separator < 1 || separator === identity.length - 1)
                return () => undefined;
            const teamId = identity.slice(0, separator);
            const memberName = identity.slice(separator + 1);
            const workspace = child.session.header.cwd ?? process.cwd();
            const team = readTeamSync(join(workspace, stateDir), teamId);
            if (team?.captainSessionId !== parentSessionId)
                return () => undefined;
            const durableMember = team.members.find(member => member.name === memberName);
            selection = selectionFromMember(durableMember);
            // An old team record has no provider/reasoning snapshot. Its durable
            // Harness descriptor still restores provider/model, so leave it alone.
            if (selection === undefined)
                return () => undefined;
            if (descriptor.agentProvider !== durableMember?.provider || descriptor.agentModel !== durableMember?.model) {
                throw new Error(`agent-teams: saved model route for member "${memberName}" does not match its subagent descriptor`);
            }
        }
        const selectionRef = { current: modelSelection(selection), assembled: undefined };
        const disposeSelection = installModelSelection(childCtx, selectionRef);
        const fallback = selection.fallback;
        if (fallback === undefined)
            return disposeSelection;
        let switched = false;
        const disposeFallback = childCtx.on('agent/request-error', async (payload) => {
            if (payload.agent.id !== child.id)
                return undefined;
            const transition = selectFallbackRoute(selectionRef.current ?? { provider: selection.provider, model: selection.model }, fallback, payload.failure.code, switched);
            if (!transition.retry)
                return undefined;
            switched = transition.switched;
            selectionRef.current = transition.selection;
            const workspace = child.session.header.cwd ?? process.cwd();
            const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length);
            const separator = identity.indexOf(':');
            if (separator > 0) {
                const teamId = identity.slice(0, separator);
                const memberName = identity.slice(separator + 1);
                void updateFallbackState(join(workspace, stateDir), teamId, memberName, fallback, ctx).catch((error) => {
                    ctx.logger.warn(`agent-teams: failed to persist fallback route: ${String(error)}`);
                });
            }
            ctx.logger.warn(`agent-teams: member ${child.id} switching to fallback ${fallback.provider}/${fallback.model} after ${payload.failure.code}`);
            return { kind: 'retry' };
        });
        return () => {
            disposeFallback();
            disposeSelection();
        };
    });
    return {
        async withPending(parentSessionId, label, selection, operation) {
            const key = pendingSelectionKey(parentSessionId, label);
            if (pending.has(key)) {
                throw new Error(`member model selection is already pending for "${label}"`);
            }
            pending.set(key, selection);
            try {
                return await operation();
            }
            finally {
                pending.delete(key);
            }
        },
    };
}
function configuredExecutionPrompt(member, config) {
    const prompt = member.executionPrompt?.trim() || config.executionPrompt?.trim();
    return prompt === undefined || prompt === '' ? undefined : prompt;
}
function truncatedPersonaProtocol(protocol) {
    if (protocol === undefined || protocol.trim() === '')
        return '(none)';
    if (protocol.length <= PERSONA_PROTOCOL_MAX_CHARS)
        return protocol;
    return `${protocol.slice(0, PERSONA_PROTOCOL_MAX_CHARS)}… [truncated]`;
}
function assignedNonTerminalCount(team, memberName) {
    return team.tasks.filter(task => (task.assignee === memberName && !TERMINAL_TASK_STATUSES.includes(task.status))).length;
}
/**
 * The member's system prompt (persona), shadowing the deployment persona for
 * that child. Self-contained: it replaces the whole persona section.
 * Frozen at spawn: draft must already carry the Team goal and profile protocol.
 * @param team - the team the member joined.
 * @param member - the member record (name/role are read before spawning).
 * @param stateDir - configured state directory, so the member can locate the
 *   team files with its own file tools.
 */
export function memberPersona(team, member, stateDir, executionPrompt) {
    const goal = team.description?.trim() || '(not provided)';
    const injectedPrompt = member.executionPrompt?.trim() || executionPrompt?.trim();
    const protocol = truncatedPersonaProtocol(team.profile?.protocol);
    return `You are ${member.name}, a member of the multi-agent team "${team.name}" running inside DeepSeek Harness AgentTeams. The captain leads the team; you are a worker member${member.role ? ` with the role: ${member.role}` : ''}.

Team context:
- Team id: ${team.id}
- Your name inside the team (use it as \`from\`/identity): ${member.name}
- Team goal: ${goal}
- Profile protocol: ${protocol}
${injectedPrompt === undefined || injectedPrompt === '' ? '' : `- Execution guidance:
${injectedPrompt}
`}- The team state lives under ${stateDir}/${team.id}/ (team.json and inbox/*.jsonl). You may inspect these files read-only for diagnostics, but never edit them directly; use the agent_teams_* tools so JSON escaping and concurrent updates stay safe.
- The captain and your teammates reach you through messages. Each message you receive is a new turn: act on it and end your turn with a concise reply.
When you receive a task, treat the assignment prompt's dependency results as source material. Do not ignore them.

Working rules:
1. When you receive a task assignment, call agent_teams_claim_task with the task id. Keep the returned attempt_id: include it in every agent_teams_update_task call for that execution attempt. Then mark the task in_progress.
2. Work thoroughly with your available tools; do not cut corners.
3. When finishing a task:
   - use status=completed only when the task's success criteria are satisfied;
   - use status=failed when blocking findings or validation failures mean downstream work must not proceed;
   - include a concise output in either case;
   - a stale-attempt rejection means the captain reassigned or took over the task; stop touching that task and wait for new work.
   claimed cannot jump to completed. Mark in_progress first, then completed or failed.
   Include attempt_id on every update. Then send_message to captain and become idle.
4. Send a short report to the captain with agent_teams_send_message (to=captain) when you complete a task or hit a blocker.
5. To ask a teammate something, use agent_teams_send_message with to=<teammate name>; the message lands in their mailbox and wakes them directly — teammates talk to each other without the captain in the loop. The same applies to the captain (to=captain).
6. After your turn becomes idle, the shared task scheduler may assign your next ready task automatically. Never claim a second task while you still own unfinished work.
7. If you already own an open attempt (claimed or in_progress) and receive mail, treat it as guidance for that same attempt_id unless the mail explicitly tells you to stop or fail. Do not claim a new task in that turn.
8. Do not start a teammate's assigned task. Do not privately tell the next-stage member to start; the scheduler assigns unlocked work after you become idle.
9. You are a worker: do not create or delete teams, reassign tasks, or add/remove members — that is the captain's job.
10. Quality-gate kinds carry a contract (kind, objective, inScope, acceptance, verify). Stay inside inScope. Do not mark your own implementation as review pass. Review/requirements complete only with verdict=pass; needs_revision/reject must fail with findings. Mail is not a formal next review.`;
}
/**
 * The initial user message delivered when the member is created.
 * Counts non-terminal tasks already assigned to this member on the in-memory draft.
 * @param team - the team the member joined.
 * @param memberName - canonical member name used to count assigned pending work.
 */
export function memberWelcome(team, memberName) {
    const assigned = assignedNonTerminalCount(team, memberName);
    return `You have joined the team "${team.name}" as a member. Wait for an automatic assignment or a captain message.
Current team status: ${team.tasks.length} task(s), ${assigned} pending task(s) assigned to you.
Do not start work until the scheduler or captain assigns a task in this turn.`;
}
/**
 * Spawn one member as a durable continuable subagent of the captain and fill
 * `member.id` with its child session id. On failure nothing is persisted.
 * @param ctx - the plugin context (injects `subagents`).
 * @param config - member runtime knobs.
 * @param selections - fresh/cold child model-selection bridge.
 * @param llmSelection - resolved provider/model/reasoning snapshot.
 * @param captain - the exact live captain agent (the calling agent).
 * @param team - the team record (read-only here).
 * @param member - the member draft whose `id` is filled on success.
 * @param stateDir - configured state directory (for the persona).
 * @param signal - caller cancellation, forwarded to the start.
 */
export async function spawnMember(ctx, config, selections, llmSelection, captain, team, member, stateDir, signal) {
    // Fail loud at the first use: provider registration is a sibling plugin's
    // effect and may settle after this plugin mounts. Capability checks here
    // mirror what startContinuable would reject, with an actionable error.
    const provider = ctx.subagents.getProvider(config.provider);
    if (provider === undefined) {
        throw new Error(`agent-teams: no subagent provider "${config.provider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — `
            + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition');
    }
    if (provider.prepareContinuable === undefined) {
        throw new Error(`agent-teams: provider "${config.provider}" does not support continuable members`);
    }
    if (!provider.capabilities.persona) {
        throw new Error(`agent-teams: provider "${config.provider}" cannot apply a member persona`);
    }
    if (!provider.capabilities.toolFilter) {
        throw new Error(`agent-teams: provider "${config.provider}" cannot restrict captain-only tools for members`);
    }
    const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`;
    const start = await selections.withPending(captain.id, label, llmSelection, () => (ctx.subagents.startContinuable({
        provider: config.provider,
        label,
        request: {
            prompt: [{ type: 'text', text: memberWelcome(team, member.name) }],
            parent: captain,
            persona: memberPersona(team, member, stateDir, config.executionPrompt),
            toolFilter: { deny: [...MEMBER_DENIED_TOOLS] },
            agentOptions: {
                provider: llmSelection.provider,
                model: llmSelection.model,
            },
            ...config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {},
        },
        signal,
    })));
    member.id = start.childId;
}
/**
 * Deliver one message to a member as its next FIFO turn. Best effort: a
 * failure (member gone or not continuable) is logged and reported as `false`
 * so the caller can decide (mailbox delivery still happened).
 *
 * Any team sender can route through this helper: the captain is the direct
 * parent of every member, and the caller passes the captain's live Agent
 * (its own when the captain calls, the registry-resolved one when a member
 * sends) — mirroring the Claude Code mailbox model where the writer writes
 * the target's inbox and the target picks it up on its own.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's direct parent).
 * @param childId - the member's durable child session id.
 * @param text - the message content.
 * @param signal - caller cancellation, forwarded to the delivery.
 * @returns whether the member inbox accepted the message.
 */
export async function deliverToMember(ctx, captain, childId, text, signal) {
    try {
        await ctx.subagents.followup(captain, brandedSessionId(childId), [{ type: 'text', text }], {
            source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
            signal,
        });
        return true;
    }
    catch (error) {
        ctx.logger.warn(`agent-teams: followup to member ${childId} failed: ${String(error)}`);
        return false;
    }
}
/**
 * Request cancellation of one live member's current turn. Best effort, fire
 * and return; the target may keep running until it observes the signal.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's parent).
 * @param childId - the member's durable child session id.
 */
export function interruptMember(ctx, captain, childId) {
    try {
        ctx.subagents.interrupt(brandedSessionId(childId), { kind: 'ancestor', agent: captain });
    }
    catch (error) {
        ctx.logger.warn(`agent-teams: interrupt of member ${childId} failed: ${String(error)}`);
    }
}
/**
 * Install the missing per-child retirement boundary above Harness rc.6.
 *
 * Upstream `interrupt()` deliberately preserves continuable sessions and the
 * upstream seam exposes no targeted forget/retire method. The durable
 * AgentTeams index therefore rejects `followup()` before it can cold-resume a
 * retired member. Catalog rows deliberately remain discoverable: Harness rc.8
 * uses the direct-child catalog to authorize historical transcript reads and
 * `openSubagent()`, so filtering those rows would make an archived member's
 * persisted conversation inaccessible. Exact ids keep unrelated subagents
 * untouched while the followup boundary still prevents further model turns.
 */
export function installRetiredMemberGuard(ctx, stateDir) {
    const runtime = ctx.subagents;
    ctx.effect(() => {
        const followup = runtime.followup;
        const guardedFollowup = async (parent, childId, content, options) => {
            const retired = await readRetiredMemberIds(join(parent.session.header.cwd ?? process.cwd(), stateDir));
            if (retired.has(childId)) {
                throw new SubagentError(`AgentTeams member "${childId}" was retired and cannot be resumed`, 'NOT_RESUMABLE');
            }
            return followup.call(runtime, parent, childId, content, options);
        };
        runtime.followup = guardedFollowup;
        return () => {
            if (runtime.followup === guardedFollowup)
                runtime.followup = followup;
        };
    }, 'agent-teams: retired member guard');
}
/**
 * Snapshot the real driver activity for durable member ids.
 *
 * The team record is the membership authority, so this path intentionally no
 * longer depends on `listChildren()`'s versioned projection shape. Harness
 * rc.8 changed those rows to branded `SessionId` values plus residency-only
 * `activity`; neither is needed to answer whether the live Agent driver is
 * running, idle, or absent/ready.
 * @param ctx - the plugin context (injects `agents`).
 * @param memberIds - child ids restored from the durable team record.
 * @returns child id → live activity.
 */
export function memberActivity(ctx, memberIds) {
    const activity = new Map();
    for (const id of memberIds) {
        if (id === '')
            continue;
        const live = ctx.agents.get(brandedSessionId(id));
        activity.set(id, live === undefined ? 'ready' : live.status);
    }
    return activity;
}

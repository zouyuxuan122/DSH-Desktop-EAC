/**
 * The `agent_teams_*` model-facing tools.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state, mirroring the Claude Code AgentTeams flow:
 * create team → add members → create tasks with dependencies → claim/assign →
 * work → report → status → delete.
 * @module dsh-agent-teams/tools
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';
import { appendTeamEvent, captainSessionOf } from "./events.js";
import { acknowledgeMailbox, appendMailbox, archiveTeamDir, beginTaskAttempt, CAPTAIN_KEY, createMessage, createTeamDir, findTeamByCaptain, findTeamByParticipant, cancelUnfinishedTask, invalidateTaskAttempt, readUnreadMailbox, recordRetiredMemberIds, releaseMailboxDelivery, readTeam, sanitizeKey, transitionError, unsatisfiedDependencies, withTeamLock, writeTeam, removeTeamDir, validateCreateTask, evaluateQualityCompletion, planQualityFollowUp, resumeTeamState, buildCoverageMatrix, canDeclareDelivery, describeQualityLoop, sanitizeReviewAcceptance, sanitizeReviewObjective, taskKindOf, } from "./state.js";
import { deliverToMember, installRetiredMemberGuard, installMemberSelectionRuntime, interruptMember, memberActivity, resolveMemberLlmSelection, spawnMember, validateMemberLlmSelections, } from "./members.js";
import { TERMINAL_TASK_STATUSES } from "./types.js";
import { installTeamScheduler } from "./scheduler.js";
import { resolveTeamProfile } from "./profiles.js";
/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec) {
    if (!exec.agent) {
        throw new Error('agent_teams tools require a calling agent (exec.agent was undefined)');
    }
    return exec.agent;
}
/** The captain's workspace directory (team state root parent). */
function workspaceOf(agent) {
    return agent.session.header.cwd ?? process.cwd();
}
/** Resolved absolute state root. */
function stateRootOf(workspace, config) {
    return join(workspace, config.stateDir);
}
/** Process-local lock key scoped by workspace state root and team id. */
function teamLockKey(stateRoot, teamId) {
    return `team:${stateRoot}:${teamId}`;
}
/** Process-local lock key enforcing one active team per captain session. */
function captainLockKey(stateRoot, captainId) {
    return `captain:${stateRoot}:${captainId}`;
}
/** The team this captain currently leads, or a loud failure. */
async function requireCaptainTeam(workspace, config, captain) {
    const team = await findTeamByCaptain(stateRootOf(workspace, config), captain.id);
    if (team === undefined) {
        throw new Error('you are not leading any team yet — call agent_teams_create first');
    }
    return team;
}
/** The team this captain or active member currently participates in. */
async function requireParticipantTeam(workspace, config, caller) {
    const team = await findTeamByParticipant(stateRootOf(workspace, config), caller.id);
    if (team === undefined) {
        throw new Error('you do not lead or belong to any active team yet');
    }
    return team;
}
/** Re-derive a caller's role from fresh state while holding the team lock. */
function participantIdentityOf(team, agentId) {
    if (team.captainSessionId === agentId)
        return { kind: 'captain', name: CAPTAIN_KEY };
    const member = team.members.find((candidate) => candidate.id === agentId && candidate.status !== 'removed');
    return member === undefined ? undefined : { kind: 'member', name: member.name };
}
/** Fresh state for a team that still exists; never falls back to stale lookup data. */
async function requireFreshTeam(stateRoot, teamId) {
    const fresh = await readTeam(stateRoot, teamId);
    if (fresh === undefined)
        throw new Error(`team "${teamId}" is no longer active`);
    return fresh;
}
/** Fresh state with captain authorization rechecked inside the lock. */
async function requireFreshCaptainTeam(stateRoot, teamId, captainId) {
    const fresh = await requireFreshTeam(stateRoot, teamId);
    if (fresh.captainSessionId !== captainId) {
        throw new Error(`only the captain of team "${fresh.name}" may perform this operation`);
    }
    return fresh;
}
/** Fresh state and caller identity rechecked inside the lock. */
async function requireFreshParticipant(stateRoot, teamId, callerId) {
    const fresh = await requireFreshTeam(stateRoot, teamId);
    const identity = participantIdentityOf(fresh, callerId);
    if (identity === undefined)
        throw new Error(`you are no longer an active participant in team "${fresh.name}"`);
    return { team: fresh, identity };
}
/** Look up one live (non-removed) member by display name. */
function requireMember(team, name) {
    const member = team.members.find((candidate) => candidate.name === name && candidate.status !== 'removed');
    if (member === undefined) {
        throw new Error(`no active member named "${name}" in team "${team.name}"`);
    }
    return member;
}
/** Look up one task by id. */
function requireTask(team, taskId) {
    const task = team.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
        throw new Error(`no task "${taskId}" in team "${team.name}" — use agent_teams_status to list tasks`);
    }
    return task;
}
function requireStagedTeam(team) {
    if (team.phase !== 'staged') {
        throw new Error(`team "${team.name}" is already running; its plan can no longer be edited`);
    }
    if (team.halted === true)
        throw new Error(`team "${team.name}" is halted, not awaiting plan approval`);
}
function trimmedOptional(value) {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
/** Validate references and cycles before a staged graph can be saved or run. */
function validateStagedGraph(team, requireRunnable) {
    const members = team.members.filter((member) => member.status !== 'removed');
    if (requireRunnable && members.length === 0)
        throw new Error('add at least one member before approving the plan');
    if (requireRunnable && team.tasks.length === 0)
        throw new Error('add at least one task before approving the plan');
    const memberNames = new Set(members.map((member) => member.name));
    const taskIds = new Set(team.tasks.map((task) => task.id));
    for (const task of team.tasks) {
        if (task.subject.trim() === '')
            throw new Error(`task "${task.id}" must have a subject`);
        if (task.assignee !== undefined && task.assignee !== CAPTAIN_KEY && !memberNames.has(task.assignee)) {
            throw new Error(`task "${task.id}" assignee "${task.assignee}" is not an active member`);
        }
        for (const dependency of task.dependencies) {
            if (dependency === task.id)
                throw new Error(`task "${task.id}" cannot depend on itself`);
            if (!taskIds.has(dependency))
                throw new Error(`task "${task.id}" depends on unknown task "${dependency}"`);
        }
    }
    const visiting = new Set();
    const visited = new Set();
    const byId = new Map(team.tasks.map((task) => [task.id, task]));
    const visit = (taskId) => {
        if (visiting.has(taskId))
            throw new Error(`task dependency graph contains a cycle at "${taskId}"`);
        if (visited.has(taskId))
            return;
        visiting.add(taskId);
        for (const dependency of byId.get(taskId)?.dependencies ?? [])
            visit(dependency);
        visiting.delete(taskId);
        visited.add(taskId);
    };
    for (const task of team.tasks)
        visit(task.id);
}
function memberOpenTask(team, memberName, exceptTaskId) {
    return team.tasks.find(task => task.id !== exceptTaskId
        && task.assignee === memberName
        && (task.status === 'claimed' || task.status === 'in_progress'));
}
/** Captain work is immediate, not a durable scheduler lane: allow one unfinished takeover at a time. */
function captainOpenTask(team, exceptTaskId) {
    return team.tasks.find(task => task.id !== exceptTaskId
        && task.assignee === CAPTAIN_KEY
        && !TERMINAL_TASK_STATUSES.includes(task.status));
}
async function waitForMemberIdle(ctx, member, signal) {
    if (member.id === '')
        return;
    const live = ctx.agents.get(member.id);
    if (live === undefined)
        return;
    if (signal.aborted)
        throw signal.reason;
    let onAbort;
    const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('task reassignment was cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        await Promise.race([live.whenIdle(), aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
/** Stop every currently-resident member activation for one halted team.
 *
 * Interrupt requests only cancel the member's current model turn and retain its
 * activation. Draining the selected direct children is the stronger lifecycle
 * boundary: it waits for the activation handles to release, so a child cannot
 * keep executing after the captain-chat Stop control has reported success.
 */
async function stopTeamMemberActivations(ctx, captain, members, signal) {
    const activeMembers = members.filter((member) => member.id !== '' && member.status !== 'removed');
    const memberIds = activeMembers.map((member) => member.id);
    if (memberIds.length === 0)
        return;
    for (const memberId of memberIds)
        interruptMember(ctx, captain, memberId);
    // `drainContinuableChildren` is available in the current runtime and releases
    // the selected activation handles. Keep the quiescence fallback for pre-rc.8
    // hosts, where interrupt is the strongest available lifecycle operation.
    const runtime = ctx.subagents;
    if (runtime.drainContinuableChildren !== undefined) {
        try {
            await runtime.drainContinuableChildren(captain, memberIds);
            return;
        }
        catch (error) {
            // Do not claim the browser action stopped work when the runtime could not
            // release all selected child activations. The HTTP route surfaces this
            // failure instead of returning a false successful stop.
            ctx.logger.warn(`agent-teams: failed to drain halted members: ${String(error)}`);
            throw error;
        }
    }
    const fallbackSignal = signal ?? new AbortController().signal;
    const results = await Promise.allSettled(activeMembers.map((member) => waitForMemberIdle(ctx, member, fallbackSignal)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected')
        throw failed.reason;
}
export async function haltTeamWork(input) {
    const halted = await withTeamLock(teamLockKey(input.stateRoot, input.teamId), async () => {
        const fresh = await requireFreshCaptainTeam(input.stateRoot, input.teamId, input.captain.id);
        if (fresh.halted === true) {
            return {
                teamName: fresh.name,
                cancelledTasks: fresh.tasks.filter((task) => task.status === 'cancelled').length,
                alreadyHalted: true,
                members: fresh.members.filter((member) => member.id !== '' && member.status !== 'removed').map((member) => ({ ...member })),
            };
        }
        const now = Date.now();
        let cancelledTasks = 0;
        for (const task of fresh.tasks) {
            if (TERMINAL_TASK_STATUSES.includes(task.status))
                continue;
            cancelUnfinishedTask(task, 'Stopped from the captain chat.');
            cancelledTasks += 1;
        }
        for (const member of fresh.members) {
            if (member.status === 'removed')
                continue;
            member.status = 'idle';
        }
        fresh.halted = true;
        fresh.haltedAt = now;
        await writeTeam(input.stateRoot, fresh);
        appendTeamEvent(input.ctx, captainSessionOf(input.ctx, fresh.captainSessionId, input.captain.session), 'agent-teams/team-halted', {
            teamId: fresh.id,
            cancelledTasks,
        });
        return {
            teamName: fresh.name,
            cancelledTasks,
            alreadyHalted: false,
            members: fresh.members.filter((member) => member.id !== '' && member.status !== 'removed').map((member) => ({ ...member })),
        };
    });
    // Persist the stop boundary first, then abort the Captain before draining
    // children. Otherwise its current model turn can observe `halted`, call
    // resume, and race the still-running HTTP stop request.
    input.captain.cancel({ kind: 'user' }, { keepInbox: true });
    await stopTeamMemberActivations(input.ctx, input.captain, halted.members, input.signal);
    // Interrupting a child emits a trailing subagent-settled notification. That
    // notification can start a fresh Captain turn after the first cancellation,
    // so close the stop boundary again once every child activation has drained.
    // Queued user input is preserved both times; only runtime-generated work is
    // prevented from silently resuming the halted team.
    input.captain.cancel({ kind: 'user' }, { keepInbox: true });
    return {
        teamName: halted.teamName,
        cancelledTasks: halted.cancelledTasks,
        alreadyHalted: halted.alreadyHalted,
    };
}
export function steerCaptainReport(captain, from, content) {
    try {
        captain.steer(createUserMessage({
            content: [{ type: 'text', text: `AgentTeams message from member ${from}:\n\n${content}` }],
            source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
        }));
        return true;
    }
    catch {
        // The plugin mailbox was persisted before this best-effort live delivery.
        return false;
    }
}
/** Context queued after the human rejects a staged plan. */
export function stagedPlanDiscardContext(teamName) {
    return [
        `The user discarded the staged AgentTeams plan "${teamName}" from the pre-run review UI.`,
        'That decision is final for this draft: it has been archived, no members were created, and no tasks may run.',
        'Do not call agent_teams_create, agent_teams_approve, or recreate a replacement team merely because the old team is no longer active.',
        'Wait for a later explicit user request. If the next user message is unrelated to AgentTeams, answer it normally and do not start a team.',
    ].join('\n');
}
/** Model-facing continuation that turns the review UI back into a conversation. */
export function stagedPlanFeedbackContext(teamName) {
    return [
        `The user selected "Return to chat and revise" for the staged AgentTeams plan "${teamName}".`,
        'The existing staged plan is still the only draft. Do not create a replacement team, approve it, spawn members, edit the plan, or start work in this turn.',
        'Ask the user one concise, concrete question about what they want changed, then stop and wait for their answer.',
        'After the user answers, revise this same staged roster and DAG with one atomic agent_teams_edit_plan call, summarize the changes, and ask the user to review the updated plan again.',
    ].join('\n');
}
/**
 * Register every `agent_teams_*` tool into the shared tools registry.
 * @param ctx - the plugin context (injects `tools`).
 * @param config - resolved tool config.
 */
export function registerAgentTeamsTools(ctx, config) {
    installRetiredMemberGuard(ctx, config.stateDir);
    const memberSelections = installMemberSelectionRuntime(ctx, config.stateDir);
    const scheduler = installTeamScheduler(ctx, { stateDir: config.stateDir, executionPrompt: config.executionPrompt });
    const updateStagedPlanBatch = async (captain, teamId, mutations, signal) => {
        if (mutations.length === 0)
            throw new Error('at least one staged plan operation is required');
        const workspace = workspaceOf(captain);
        const stateRoot = stateRootOf(workspace, config);
        return withTeamLock(teamLockKey(stateRoot, teamId), async () => {
            const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id);
            requireStagedTeam(fresh);
            for (const mutation of mutations) {
                if (mutation.action === 'update_member') {
                    const member = requireMember(fresh, mutation.memberName);
                    if (member.id !== '')
                        throw new Error(`staged member "${member.name}" was already spawned`);
                    const selection = await resolveMemberLlmSelection(ctx, captain, {
                        provider: mutation.provider,
                        model: mutation.model,
                        reasoningEffort: trimmedOptional(mutation.reasoningEffort),
                        fallback: member.fallback,
                    }, signal);
                    member.role = trimmedOptional(mutation.role);
                    member.provider = selection.provider;
                    member.model = selection.model;
                    member.reasoningEffort = selection.reasoningEffort;
                    member.executionPrompt = trimmedOptional(mutation.executionPrompt);
                }
                else if (mutation.action === 'update_task') {
                    const task = requireTask(fresh, mutation.taskId);
                    if (task.status !== 'pending' || (task.attempt ?? 0) !== 0) {
                        throw new Error(`task "${task.id}" has already started and cannot be edited`);
                    }
                    const subject = mutation.subject.trim();
                    if (subject === '')
                        throw new Error('task subject must not be empty');
                    task.subject = subject;
                    task.description = trimmedOptional(mutation.description);
                    task.assignee = trimmedOptional(mutation.assignee);
                    task.dependencies = [...new Set(mutation.dependencies.map((item) => item.trim()).filter(Boolean))];
                    task.updatedAt = Date.now();
                }
                else if (mutation.action === 'add_task') {
                    const subject = mutation.subject.trim();
                    if (subject === '')
                        throw new Error('task subject must not be empty');
                    fresh.taskSeq += 1;
                    const now = Date.now();
                    fresh.tasks.push({
                        id: `t${fresh.taskSeq}`,
                        subject,
                        description: trimmedOptional(mutation.description),
                        status: 'pending',
                        assignee: trimmedOptional(mutation.assignee),
                        dependencies: [...new Set(mutation.dependencies.map((item) => item.trim()).filter(Boolean))],
                        attempt: 0,
                        kind: 'work',
                        createdAt: now,
                        updatedAt: now,
                    });
                }
                else if (mutation.action === 'remove_task') {
                    const task = requireTask(fresh, mutation.taskId);
                    const dependent = fresh.tasks.find((candidate) => candidate.dependencies.includes(task.id));
                    if (dependent !== undefined) {
                        throw new Error(`task "${task.id}" is still required by "${dependent.id}"; update that dependency before removing the task`);
                    }
                    fresh.tasks = fresh.tasks.filter((candidate) => candidate.id !== task.id);
                }
                else {
                    const member = requireMember(fresh, mutation.memberName);
                    if (member.id !== '')
                        throw new Error(`staged member "${member.name}" was already spawned`);
                    const owned = fresh.tasks.filter((task) => task.assignee === member.name);
                    if (owned.length > 0) {
                        throw new Error(`member "${member.name}" still owns planned tasks: ${owned.map((task) => task.id).join(', ')}; update or remove those tasks first`);
                    }
                    fresh.members = fresh.members.filter((candidate) => candidate !== member);
                }
            }
            validateStagedGraph(fresh, false);
            fresh.planReviewState = 'awaiting_review';
            await writeTeam(stateRoot, fresh);
            return fresh;
        });
    };
    const updateStagedPlan = async (captain, teamId, mutation, signal) => (updateStagedPlanBatch(captain, teamId, [mutation], signal));
    const approveStagedTeam = async (captain, teamId, signal) => {
        const workspace = workspaceOf(captain);
        const stateRoot = stateRootOf(workspace, config);
        const runSignal = signal ?? new AbortController().signal;
        const approved = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
            const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id);
            requireStagedTeam(fresh);
            // A staged removal has no child session to retain in history. Drop those
            // placeholders before transitioning to the stricter running shape.
            fresh.members = fresh.members.filter((member) => member.status !== 'removed');
            validateStagedGraph(fresh, true);
            const spawned = [];
            try {
                const selections = new Map();
                for (const member of fresh.members) {
                    if (member.id !== '')
                        continue;
                    const selection = await resolveMemberLlmSelection(ctx, captain, {
                        provider: member.provider,
                        model: member.model,
                        reasoningEffort: member.reasoningEffort,
                        fallback: member.fallback,
                    }, runSignal);
                    selections.set(member, selection);
                    member.provider = selection.provider;
                    member.model = selection.model;
                    member.reasoningEffort = selection.reasoningEffort;
                }
                // This is the approval commit barrier: resolve and validate the whole
                // final roster before spawning even the first durable child.
                await validateMemberLlmSelections(ctx, [...selections.values()], runSignal);
                for (const [member, selection] of selections) {
                    await spawnMember(ctx, memberRuntime(config), memberSelections, selection, captain, fresh, member, config.stateDir, runSignal);
                    spawned.push(member);
                }
                if (fresh.members.some((member) => member.id === '')) {
                    throw new Error('one or more staged members could not be spawned');
                }
                fresh.phase = 'running';
                delete fresh.planReviewState;
                fresh.approvedAt = Date.now();
                await writeTeam(stateRoot, fresh);
                return { teamId: fresh.id, members: fresh.members.length, tasks: fresh.tasks.length };
            }
            catch (error) {
                await recordRetiredMemberIds(stateRoot, spawned.map((member) => member.id)).catch(() => undefined);
                for (const member of spawned) {
                    if (member.id !== '')
                        interruptMember(ctx, captain, member.id);
                }
                throw error;
            }
        });
        try {
            await scheduler.kickTeam(workspace, teamId, captain);
        }
        catch (error) {
            // Approval is already durably committed. A transient wake-up failure is
            // recoverable by the next status/member lifecycle kick and must not make
            // the UI report that an already-running team failed to approve.
            ctx.logger.warn(`agent-teams: post-approval kick failed for "${teamId}": ${String(error)}`);
        }
        return approved;
    };
    const continueStagedPlanning = async (captain, teamId) => {
        const workspace = workspaceOf(captain);
        const stateRoot = stateRootOf(workspace, config);
        const prepared = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
            const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id);
            requireStagedTeam(fresh);
            if (fresh.planReviewState === 'awaiting_feedback') {
                return { teamName: fresh.name, alreadyWaiting: true };
            }
            fresh.planReviewState = 'awaiting_feedback';
            await writeTeam(stateRoot, fresh);
            return { teamName: fresh.name, alreadyWaiting: false };
        });
        if (prepared.alreadyWaiting)
            return { teamId, alreadyWaiting: true };
        // End any planning turn that is still producing tool calls. A plugin
        // follow-up submitted after cancellation is queued as the next turn by the
        // Harness Agent contract, so it cannot race ahead and recreate the team.
        captain.cancel({ kind: 'user' }, { keepInbox: true });
        try {
            captain.followup(createUserMessage({
                content: [{ type: 'text', text: stagedPlanFeedbackContext(prepared.teamName) }],
                source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
            }));
        }
        catch (error) {
            // Do not leave the durable UI in a false waiting state when the live
            // Captain disappeared between lookup and delivery.
            await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id);
                requireStagedTeam(fresh);
                if (fresh.planReviewState === 'awaiting_feedback') {
                    fresh.planReviewState = 'awaiting_review';
                    await writeTeam(stateRoot, fresh);
                }
            });
            throw error;
        }
        return { teamId, alreadyWaiting: false };
    };
    const discardStagedTeam = async (captain, teamId) => {
        const workspace = workspaceOf(captain);
        const stateRoot = stateRootOf(workspace, config);
        const discarded = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
            const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id);
            requireStagedTeam(fresh);
            appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/plan-discarded', {
                teamId: fresh.id,
            });
            // A staged plan owns no child sessions. Archiving releases the captain
            // immediately while retaining the rejected graph for later inspection.
            await archiveTeamDir(stateRoot, fresh.id);
            return { teamId: fresh.id, teamName: fresh.name };
        });
        // Preserve this control fact for the next genuine user turn, then abort the
        // still-running Captain turn. Without both operations a late model step can
        // observe the missing active team and incorrectly create it again.
        try {
            captain.inject(createUserMessage({
                content: [{ type: 'text', text: stagedPlanDiscardContext(discarded.teamName) }],
                source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
            }));
        }
        catch (error) {
            // The archive is already authoritative. Cancellation still prevents a
            // late step from recreating work; failure to park extra context is only a
            // live-delivery warning and must not turn a successful discard into 409.
            ctx.logger.warn(`agent-teams: failed to inject discard context for "${discarded.teamId}": ${String(error)}`);
        }
        captain.cancel({ kind: 'user' }, { keepInbox: true });
        return { teamId: discarded.teamId };
    };
    const runtime = {
        updateStagedPlan,
        updateStagedPlanBatch,
        approveStagedTeam,
        continueStagedPlanning,
        discardStagedTeam,
    };
    ctx.tools.register(defineTool({
        name: 'agent_teams_create',
        description: 'Create a team. Use approval=required for a two-phase plan: members and tasks remain unspawned/unclaimed until the user reviews the Web plan and explicitly approves it. Optional profiles expand their configured roster; seed profiles also expand template tasks, while captain profiles leave the graph for the Captain to design. approval=automatic preserves the legacy immediate-execution path.',
        parameters: {
            name: { type: 'string', required: true, description: 'Name for the new team (used as its stable id).' },
            description: { type: 'string', description: 'Team purpose / the goal the team will work on.' },
            profile: { type: 'string', description: 'Optional configured profile name.' },
            approval: {
                type: 'string',
                enum: ['required', 'automatic'],
                description: 'required stages the plan for explicit user review; automatic starts immediately. Defaults to automatic for API compatibility.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    team_id: { type: 'string', required: true },
                    team_name: { type: 'string', required: true },
                    state_dir: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                    profile: { type: 'string' },
                    task_planning: { type: 'string' },
                    members: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { member_name: { type: 'string', required: true }, member_id: { type: 'string', required: true }, provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoning_effort: { type: 'string' }, status: { type: 'string', required: true } } } },
                    tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { task_id: { type: 'string', required: true }, seed_id: { type: 'string', required: true }, subject: { type: 'string', required: true }, status: { type: 'string', required: true }, kind: { type: 'string' }, assignee: { type: 'string' }, dependencies: { type: 'array', items: { type: 'string' }, required: true } } } },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: value.phase === 'staged'
                        ? `Team "${value.team_name}" plan created under ${value.state_dir}. It is staged: finish the roster and DAG, then wait for the user to edit and approve it. Do not start or approve it yourself.`
                        : `Team "${value.team_name}" created (id ${value.team_id}) under ${value.state_dir}. You are the captain.`,
                }],
        },
        async execute(args, exec) {
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const stateRoot = stateRootOf(workspace, config);
            const teamName = args.name.trim();
            if (teamName === '')
                throw new Error('team name must not be empty');
            const teamId = sanitizeKey(teamName);
            const staged = args.approval === 'required';
            const profileName = args.profile?.trim();
            if (args.profile !== undefined && profileName === '') {
                throw new Error('AgentTeams profile name must not be empty');
            }
            const created = await withTeamLock(captainLockKey(stateRoot, captain.id), async () => {
                const current = await findTeamByParticipant(stateRoot, captain.id);
                if (current !== undefined) {
                    const relationship = current.captainSessionId === captain.id ? 'lead' : 'belong to';
                    throw new Error(`you already ${relationship} team "${current.name}" — end or leave it before creating another`);
                }
                return withTeamLock(teamLockKey(stateRoot, teamId), async () => {
                    const existing = await readTeam(stateRoot, teamId);
                    if (existing !== undefined) {
                        throw new Error(`team id "${teamId}" is taken by another captain — pick a different team name`);
                    }
                    if (profileName === undefined) {
                        const state = {
                            name: teamName,
                            id: teamId,
                            description: args.description,
                            captainSessionId: captain.id,
                            createdAt: Date.now(),
                            members: [],
                            tasks: [],
                            taskSeq: 0,
                            ...staged ? { phase: 'staged', planReviewState: 'awaiting_review' } : {},
                        };
                        await createTeamDir(stateRoot, state);
                        return { committed: true, state };
                    }
                    return initializeProfileTeam({
                        ctx,
                        config,
                        memberSelections,
                        captain,
                        exec,
                        stateRoot,
                        teamName,
                        teamId,
                        profileName,
                        description: args.description,
                        staged,
                    });
                });
            });
            if (created.committed) {
                try {
                    await scheduler.kickTeam(workspace, created.state.id, captain);
                }
                catch (error) {
                    ctx.logger.warn(`agent-teams: post-create kick failed for "${created.state.id}": ${String(error)}`);
                }
                try {
                    appendTeamEvent(ctx, captain.session, 'agent-teams/team-created', {
                        teamId: created.state.id,
                        captainSessionId: captain.id,
                        name: created.state.name,
                        ...created.state.description !== undefined ? { description: created.state.description } : {},
                        ...created.state.profile?.name === undefined ? {} : { profile: created.state.profile.name },
                    });
                    for (const member of created.state.members) {
                        appendTeamEvent(ctx, captain.session, 'agent-teams/member-added', {
                            teamId: created.state.id,
                            memberId: member.id,
                            name: member.name,
                            ...member.role === undefined ? {} : { role: member.role },
                        });
                    }
                    for (const task of created.state.tasks) {
                        appendTeamEvent(ctx, captain.session, 'agent-teams/task-created', {
                            teamId: created.state.id,
                            taskId: task.id,
                            subject: task.subject,
                            dependencies: task.dependencies,
                            ...task.assignee === undefined ? {} : { assignee: task.assignee },
                        });
                    }
                }
                catch (error) {
                    ctx.logger.warn(`agent-teams: post-create events failed for "${created.state.id}": ${String(error)}`);
                }
            }
            const persisted = await readTeam(stateRoot, created.state.id).catch(() => undefined);
            const snapshot = persisted ?? created.state;
            if (snapshot.profile === undefined) {
                return {
                    team_id: snapshot.id,
                    team_name: snapshot.name,
                    state_dir: join(stateRoot, snapshot.id),
                    phase: snapshot.phase ?? 'running',
                };
            }
            return {
                team_id: snapshot.id,
                team_name: snapshot.name,
                state_dir: join(stateRoot, snapshot.id),
                phase: snapshot.phase ?? 'running',
                profile: snapshot.profile.name,
                task_planning: snapshot.profile.taskPlanning ?? 'seed',
                members: snapshot.members.map((member) => ({
                    member_name: member.name,
                    member_id: member.id,
                    provider: member.provider ?? '',
                    model: member.model ?? '',
                    ...member.reasoningEffort === undefined ? {} : { reasoning_effort: member.reasoningEffort },
                    status: member.status,
                })),
                tasks: snapshot.tasks.map((task) => ({
                    task_id: task.id,
                    seed_id: task.profileSeedId ?? '',
                    subject: task.subject,
                    status: task.status,
                    ...task.kind === undefined ? {} : { kind: task.kind },
                    ...task.assignee === undefined ? {} : { assignee: task.assignee },
                    dependencies: task.dependencies,
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_edit_plan',
        description: 'Atomically revise the current staged AgentTeams plan without spawning members or scheduling tasks. Use this when the user continues chatting to change a plan that is waiting for approval. Submit dependent edits in order (update downstream dependencies or assignees, then remove tasks, then remove unused members). Never inspect or edit .agent-teams state files or plugin source code to revise a plan.',
        parameters: {
            operations: {
                type: 'array',
                required: true,
                description: 'One atomic, ordered batch of staged-plan edits. If any operation is invalid, none of the edits are saved.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        action: {
                            type: 'string',
                            required: true,
                            enum: ['update_member', 'update_task', 'add_task', 'remove_task', 'remove_member'],
                        },
                        member_name: { type: 'string', description: 'Member name for update_member or remove_member.' },
                        task_id: { type: 'string', description: 'Task id for update_task or remove_task.' },
                        subject: { type: 'string', description: 'Required for add_task; optional replacement for update_task.' },
                        description: { type: 'string', description: 'Optional task description.' },
                        assignee: { type: 'string', description: 'Optional task assignee; an empty string moves it to the shared pool.' },
                        dependencies: { type: 'array', items: { type: 'string' }, description: 'Complete replacement dependency list for a task.' },
                        role: { type: 'string', description: 'Optional member role.' },
                        provider: { type: 'string', description: 'Optional member provider; defaults to the current staged route.' },
                        model: { type: 'string', description: 'Optional member model; defaults to the current staged route.' },
                        reasoning_effort: { type: 'string', description: 'Optional member reasoning effort.' },
                        execution_prompt: { type: 'string', description: 'Optional member-specific execution prompt.' },
                    },
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    status: { type: 'string', required: true },
                    team_id: { type: 'string', required: true },
                    members: { type: 'number', required: true },
                    tasks: { type: 'number', required: true },
                    dependencies: { type: 'number', required: true },
                    roster: { type: 'array', items: { type: 'string' }, required: true },
                    graph: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Staged plan updated atomically (${value.members} members, ${value.tasks} tasks, ${value.dependencies} dependencies). No members were spawned and no tasks were scheduled.\n${value.graph.join('\n')}`,
                }],
        },
        async execute(args, exec) {
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const team = await requireCaptainTeam(workspace, config, captain);
            requireStagedTeam(team);
            if (args.operations.length === 0)
                throw new Error('at least one staged plan operation is required');
            const mutations = args.operations.map((operation, index) => {
                const label = `operation ${index + 1} (${operation.action})`;
                if (operation.action === 'update_member') {
                    const memberName = operation.member_name?.trim() ?? '';
                    if (memberName === '')
                        throw new Error(`${label} requires member_name`);
                    const member = requireMember(team, memberName);
                    return {
                        action: 'update_member',
                        memberName,
                        role: operation.role ?? member.role,
                        provider: operation.provider?.trim() || member.provider || '',
                        model: operation.model?.trim() || member.model || '',
                        reasoningEffort: operation.reasoning_effort ?? member.reasoningEffort,
                        executionPrompt: operation.execution_prompt ?? member.executionPrompt,
                    };
                }
                if (operation.action === 'update_task') {
                    const taskId = operation.task_id?.trim() ?? '';
                    if (taskId === '')
                        throw new Error(`${label} requires task_id`);
                    const task = requireTask(team, taskId);
                    return {
                        action: 'update_task',
                        taskId,
                        subject: operation.subject ?? task.subject,
                        description: operation.description ?? task.description,
                        assignee: operation.assignee ?? task.assignee,
                        dependencies: operation.dependencies ?? task.dependencies,
                    };
                }
                if (operation.action === 'add_task') {
                    const subject = operation.subject?.trim() ?? '';
                    if (subject === '')
                        throw new Error(`${label} requires a non-empty subject`);
                    return {
                        action: 'add_task',
                        subject,
                        description: operation.description,
                        assignee: operation.assignee,
                        dependencies: operation.dependencies ?? [],
                    };
                }
                if (operation.action === 'remove_task') {
                    const taskId = operation.task_id?.trim() ?? '';
                    if (taskId === '')
                        throw new Error(`${label} requires task_id`);
                    return { action: 'remove_task', taskId };
                }
                const memberName = operation.member_name?.trim() ?? '';
                if (memberName === '')
                    throw new Error(`${label} requires member_name`);
                return { action: 'remove_member', memberName };
            });
            const updated = await updateStagedPlanBatch(captain, team.id, mutations, exec.signal);
            return {
                status: 'staged',
                team_id: updated.id,
                members: updated.members.length,
                tasks: updated.tasks.length,
                dependencies: updated.tasks.reduce((sum, task) => sum + task.dependencies.length, 0),
                roster: updated.members.map((member) => `${member.name} (${member.role || 'member'}; ${member.provider ?? ''}/${member.model ?? ''})`),
                graph: updated.tasks.map((task) => `${task.id}: ${task.subject} -> ${task.assignee || 'shared'}${task.dependencies.length === 0 ? '' : `; depends on ${task.dependencies.join(', ')}`}`),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_approve',
        description: 'Approve and start a staged team plan. Call this only in response to an explicit user approval in a new user turn; never call it during the turn that created or edited the plan. The Web Approve & Run button uses the same runtime directly.',
        parameters: {
            confirmation: { type: 'string', required: true, description: 'The user\'s explicit approval statement.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    status: { type: 'string', required: true },
                    team_id: { type: 'string', required: true },
                    members: { type: 'number', required: true },
                    tasks: { type: 'number', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Team ${value.team_id} approved and running (${value.members} members, ${value.tasks} tasks).`,
                }],
        },
        async execute(args, exec) {
            if (args.confirmation.trim() === '')
                throw new Error('explicit user approval text is required');
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const team = await requireCaptainTeam(workspace, config, captain);
            const approved = await approveStagedTeam(captain, team.id, exec.signal);
            return { status: 'running', team_id: approved.teamId, members: approved.members, tasks: approved.tasks };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_add_member',
        description: 'Add a member to the team roster. In a staged team this only adds an editable plan row and does not spawn a child; approval spawns the final configuration. In a running team it creates the durable continuable member immediately.',
        parameters: {
            name: { type: 'string', required: true, description: 'Unique member name inside the team.' },
            role: { type: 'string', description: 'Role of the member (e.g. researcher, engineer, reviewer).' },
            provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
            model: { type: 'string', description: 'Optional model override. Omit for the captain\'s current model (or the configured memberModel default).' },
            reasoning_effort: { type: 'string', description: 'Optional reasoning effort override: one of the target model\'s supported effort ids, or "default" to force its default. When omitted, the captain\'s effort is inherited only for the same provider/model; a changed route uses the target default.' },
            executionPrompt: { type: 'string', description: 'Optional member-specific execution prompt. It remains editable while staged.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    member_name: { type: 'string', required: true },
                    member_id: { type: 'string', required: true },
                    provider: { type: 'string', required: true },
                    model: { type: 'string', required: true },
                    reasoning_effort: { type: 'string' },
                    status: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: value.phase === 'staged'
                        ? `Member "${value.member_name}" added to the staged roster (${value.provider}/${value.model}); no child was spawned.`
                        : `Member "${value.member_name}" added (subagent id ${value.member_id}, ${value.provider}/${value.model}${value.reasoning_effort === undefined ? '' : `, reasoning ${value.reasoning_effort}`}, status ${value.status}).`,
                }],
        },
        async execute(args, exec) {
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireCaptainTeam(workspace, config, captain);
            const created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id);
                const memberName = args.name.trim();
                if (memberName === '')
                    throw new Error('member name must not be empty');
                const memberKey = sanitizeKey(memberName);
                if (memberKey === CAPTAIN_KEY) {
                    throw new Error(`member name "${args.name}" is reserved for the captain`);
                }
                if (fresh.members.some((candidate) => sanitizeKey(candidate.name) === memberKey)) {
                    throw new Error(`member name "${args.name}" has already been used in team "${fresh.name}"`);
                }
                if (fresh.members.filter((candidate) => candidate.status !== 'removed').length >= config.maxMembers) {
                    throw new Error(`team "${fresh.name}" is at its member cap (${config.maxMembers})`);
                }
                const selection = await resolveMemberLlmSelection(ctx, captain, {
                    provider: args.provider,
                    model: args.model,
                    defaultModel: config.memberModel,
                    reasoningEffort: args.reasoning_effort,
                    fallback: config.fallback,
                }, exec.signal);
                const member = {
                    id: '',
                    name: memberName,
                    role: args.role,
                    provider: selection.provider,
                    model: selection.model,
                    reasoningEffort: selection.reasoningEffort,
                    executionPrompt: trimmedOptional(args.executionPrompt),
                    joinedAt: Date.now(),
                    status: 'idle',
                };
                if (fresh.phase !== 'staged') {
                    await spawnMember(ctx, memberRuntime(config), memberSelections, selection, captain, fresh, member, config.stateDir, exec.signal);
                }
                fresh.members.push(member);
                try {
                    await writeTeam(stateRoot, fresh);
                }
                catch (error) {
                    // The continuable child is already live, but the durable team record
                    // never saw it. Retire the orphan so it disappears from subagent
                    // listings and cannot be resumed, then surface the write failure.
                    if (member.id !== '') {
                        await recordRetiredMemberIds(stateRoot, [member.id]).catch(() => undefined);
                        interruptMember(ctx, captain, member.id);
                    }
                    throw error;
                }
                appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/member-added', {
                    teamId: fresh.id,
                    memberId: member.id,
                    name: member.name,
                    ...member.role !== undefined ? { role: member.role } : {},
                });
                return {
                    member_name: member.name,
                    member_id: member.id,
                    provider: selection.provider,
                    model: selection.model,
                    ...selection.reasoningEffort === undefined
                        ? {}
                        : { reasoning_effort: selection.reasoningEffort },
                    status: member.status,
                    phase: fresh.phase ?? 'running',
                };
            });
            await scheduler.kickMember(workspace, team.id, created.member_name, captain);
            return created;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_remove_member',
        description: 'Remove a member safely: revoke its current attempts, return all unfinished owned tasks to the shared pending pool, interrupt its live turn, and mark it removed.',
        parameters: {
            name: { type: 'string', required: true, description: 'Name of the member to remove.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    member_name: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    requeued_tasks: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: `Member "${value.member_name}" removed (status ${value.status}); requeued tasks: ${value.requeued_tasks.join(', ') || 'none'}.`,
                }],
        },
        async execute(args, exec) {
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireCaptainTeam(workspace, config, captain);
            const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id);
                const member = requireMember(fresh, args.name);
                const requeued = [];
                for (const task of fresh.tasks) {
                    if (task.assignee !== member.name || task.status === 'completed')
                        continue;
                    invalidateTaskAttempt(task);
                    task.reassigning = false;
                    requeued.push(task.id);
                }
                member.status = 'removed';
                await writeTeam(stateRoot, fresh);
                appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/member-removed', {
                    teamId: fresh.id,
                    memberId: member.id,
                });
                return { member: { ...member }, requeued };
            });
            if (revoked.member.id !== '') {
                await recordRetiredMemberIds(stateRoot, [revoked.member.id]);
                interruptMember(ctx, captain, revoked.member.id);
                await waitForMemberIdle(ctx, revoked.member, exec.signal);
            }
            await scheduler.kickTeam(workspace, team.id, captain);
            return {
                member_name: revoked.member.name,
                status: revoked.member.status,
                requeued_tasks: revoked.requeued,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_create_task',
        description: 'Create a task in your team\'s task list. Every call must include a non-empty subject, including verification and review tasks. Tasks can depend on other tasks (dependencies): a task is only claimable once every dependency is completed. Optionally assign it to a member, who still claims it before working.',
        parameters: {
            subject: { type: 'string', required: true, description: 'Required non-empty title for this task. Never omit it, including for verification or review tasks.' },
            description: { type: 'string', description: 'What needs to be done, in detail.' },
            dependencies: {
                type: 'array',
                items: { type: 'string' },
                description: 'Task ids this task depends on (must be completed before this task can be claimed).',
            },
            assignee: { type: 'string', description: 'Optional member name this task is intended for.' },
            kind: {
                type: 'string',
                enum: ['work', 'requirements', 'implementation', 'verification', 'review', 'repair', 'integration'],
                description: 'Task kind. Defaults to work (legacy, no quality gates). Quality kinds require a contract.',
            },
            round: { type: 'number', description: '1-based review / requirements / repair round.' },
            objective: { type: 'string', description: 'Required non-empty objective for quality kinds.' },
            inScope: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative POSIX paths this task may change.' },
            outOfScope: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative POSIX paths this task must not change.' },
            acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria. Required for quality kinds.' },
            verify: { type: 'array', items: { type: 'string' }, description: 'Verification commands. Required for implementation/repair.' },
            deliverables: { type: 'array', items: { type: 'string' }, description: 'Expected deliverable paths or names.' },
            nonGoals: { type: 'array', items: { type: 'string' }, description: 'Explicit non-goals.' },
            reviewedTaskId: { type: 'string', description: 'Task being reviewed. Required for kind=review.' },
            sourceTaskId: { type: 'string', description: 'Source implementation/artifact. Required for kind=repair.' },
            sourceFindingIds: { type: 'array', items: { type: 'string' }, description: 'Finding ids this repair must close.' },
            coverageOf: { type: 'array', items: { type: 'string' }, description: 'User-constraint / goal items this task covers.' },
            resume: { type: 'boolean', description: 'If true, clear halted in the same lock before creating the task.' },
            resumeReason: { type: 'string', description: 'Required non-empty reason when resume=true.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    task_id: { type: 'string', required: true },
                    subject: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    assignee: { type: 'string' },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: `Task "${value.subject}" created as ${value.task_id} (status ${value.status}${value.assignee ? `, assigned to ${value.assignee}` : ''}).`,
                }],
        },
        async execute(args, exec) {
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireCaptainTeam(workspace, config, captain);
            const created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id);
                const gate = validateCreateTask(fresh, {
                    subject: args.subject,
                    description: args.description,
                    dependencies: args.dependencies,
                    assignee: args.assignee,
                    kind: args.kind,
                    round: args.round,
                    objective: args.objective,
                    inScope: args.inScope,
                    outOfScope: args.outOfScope,
                    acceptance: args.acceptance,
                    verify: args.verify,
                    deliverables: args.deliverables,
                    nonGoals: args.nonGoals,
                    reviewedTaskId: args.reviewedTaskId,
                    sourceTaskId: args.sourceTaskId,
                    sourceFindingIds: args.sourceFindingIds,
                    coverageOf: args.coverageOf,
                    resume: args.resume,
                    resumeReason: args.resumeReason,
                });
                if (!gate.ok)
                    throw new Error(gate.error ?? 'create_task rejected by quality gates');
                if (fresh.halted === true) {
                    const resumed = resumeTeamState(fresh, args.resumeReason ?? '');
                    if (resumed.status !== 'resumed' || resumed.team === undefined) {
                        throw new Error(resumed.error ?? 'team is halted; call agent_teams_resume or pass resume=true with resumeReason');
                    }
                    fresh.halted = false;
                    fresh.haltedAt = undefined;
                    appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/team-resumed', {
                        teamId: fresh.id,
                        reason: args.resumeReason ?? '',
                    });
                }
                const dependencies = args.dependencies ?? [];
                for (const dependency of dependencies) {
                    if (!fresh.tasks.some((task) => task.id === dependency)) {
                        throw new Error(`dependency "${dependency}" does not exist in team "${fresh.name}"`);
                    }
                }
                if (args.assignee !== undefined)
                    requireMember(fresh, args.assignee);
                const kind = gate.kind ?? 'work';
                const objective = kind === 'review' || kind === 'requirements'
                    ? sanitizeReviewObjective(args.objective)
                    : args.objective;
                const acceptance = kind === 'review' || kind === 'requirements'
                    ? sanitizeReviewAcceptance(args.acceptance)
                    : args.acceptance;
                const task = {
                    id: `t${fresh.taskSeq + 1}`,
                    subject: args.subject,
                    description: args.description,
                    status: 'pending',
                    assignee: args.assignee,
                    dependencies,
                    attempt: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    kind,
                    ...args.round === undefined ? {} : { round: args.round },
                    ...objective === undefined ? {} : { objective },
                    ...args.inScope === undefined ? {} : { inScope: args.inScope },
                    ...args.outOfScope === undefined ? {} : { outOfScope: args.outOfScope },
                    ...acceptance === undefined ? {} : { acceptance },
                    ...args.verify === undefined ? {} : { verify: args.verify },
                    ...args.deliverables === undefined ? {} : { deliverables: args.deliverables },
                    ...args.nonGoals === undefined ? {} : { nonGoals: args.nonGoals },
                    ...args.reviewedTaskId === undefined ? {} : { reviewedTaskId: args.reviewedTaskId },
                    ...args.sourceTaskId === undefined ? {} : { sourceTaskId: args.sourceTaskId },
                    ...args.sourceFindingIds === undefined ? {} : { sourceFindingIds: args.sourceFindingIds },
                    ...args.coverageOf === undefined ? {} : { coverageOf: args.coverageOf },
                };
                fresh.taskSeq += 1;
                fresh.tasks.push(task);
                await writeTeam(stateRoot, fresh);
                appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/task-created', {
                    teamId: fresh.id,
                    taskId: task.id,
                    subject: task.subject,
                    dependencies: task.dependencies,
                    ...task.assignee !== undefined ? { assignee: task.assignee } : {},
                    ...task.kind === undefined ? {} : { kind: task.kind },
                    ...task.round === undefined ? {} : { round: task.round },
                });
                return {
                    task_id: task.id,
                    subject: task.subject,
                    status: task.status,
                    ...task.assignee !== undefined ? { assignee: task.assignee } : {},
                };
            });
            await scheduler.kickTeam(workspace, team.id, captain);
            return created;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_reassign_task',
        description: 'Atomically retry, reassign, or let the captain take over one ready unfinished/failed task. The old attempt is revoked before its member is interrupted, so late updates cannot overwrite the new owner. Use assignee="captain" only when you will finish that task in this turn; a captain can own only one unfinished takeover at a time, and an unfinished takeover returns to the member pool when the captain becomes idle.',
        parameters: {
            task_id: { type: 'string', required: true, description: 'Task to retry/reassign.' },
            assignee: { type: 'string', required: true, description: 'Active member name, or "captain" for captain takeover.' },
            reason: { type: 'string', description: 'Why the task is being retried or reassigned.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    task_id: { type: 'string', required: true },
                    previous_assignee: { type: 'string', required: true },
                    assignee: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    attempt: { type: 'number', required: true },
                    attempt_id: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Task ${value.task_id} reassigned ${value.previous_assignee || 'unassigned'} → ${value.assignee} (attempt ${value.attempt}, status ${value.status}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}).`,
                }],
        },
        async execute(args, exec) {
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireCaptainTeam(workspace, config, captain);
            const target = args.assignee.trim();
            if (target === '')
                throw new Error('reassignment assignee must not be empty');
            const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id);
                const task = requireTask(fresh, args.task_id);
                if (task.status === 'completed')
                    throw new Error(`completed task ${task.id} is immutable and cannot be reassigned`);
                if (task.reassigning === true)
                    throw new Error(`task ${task.id} is already being reassigned`);
                const targetMember = target === CAPTAIN_KEY ? undefined : requireMember(fresh, target);
                if (target === CAPTAIN_KEY) {
                    const busy = captainOpenTask(fresh, task.id);
                    if (busy !== undefined) {
                        throw new Error(`captain is busy with ${busy.id}; complete or reassign it before taking over ${task.id}`);
                    }
                    const pending = unsatisfiedDependencies(fresh.tasks, task.dependencies);
                    if (pending.length > 0) {
                        throw new Error(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them before captain takeover`);
                    }
                }
                else if (targetMember !== undefined) {
                    const busy = memberOpenTask(fresh, targetMember.name, task.id);
                    if (busy !== undefined) {
                        throw new Error(`member "${targetMember.name}" is busy with ${busy.id}; finish or reassign it first`);
                    }
                }
                const previousAssignee = task.assignee ?? '';
                const previousMember = (task.status !== 'claimed' && task.status !== 'in_progress')
                    || task.assignee === undefined || task.assignee === CAPTAIN_KEY
                    ? undefined
                    : fresh.members.find(member => member.name === task.assignee && member.status !== 'removed');
                invalidateTaskAttempt(task, target, true);
                await writeTeam(stateRoot, fresh);
                return {
                    previousAssignee,
                    previousMember: previousMember === undefined ? undefined : { ...previousMember },
                    handoffId: task.handoffId,
                };
            });
            let quiescenceError;
            if (revoked.previousMember !== undefined) {
                interruptMember(ctx, captain, revoked.previousMember.id);
                try {
                    await waitForMemberIdle(ctx, revoked.previousMember, exec.signal);
                }
                catch (error) {
                    quiescenceError = error;
                }
            }
            await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id);
                const task = requireTask(fresh, args.task_id);
                if (task.handoffId !== revoked.handoffId || task.assignee !== target || task.reassigning !== true) {
                    throw new Error(`task ${task.id} changed during reassignment; refusing to overwrite the newer state`);
                }
                task.reassigning = false;
                if (quiescenceError === undefined && target === CAPTAIN_KEY) {
                    beginTaskAttempt(task, CAPTAIN_KEY);
                    // The captain is already in the turn that requested takeover; there
                    // is no later member claim handshake to move claimed -> in_progress.
                    task.status = 'in_progress';
                    task.updatedAt = Date.now();
                }
                await writeTeam(stateRoot, fresh);
                appendTeamEvent(ctx, captain.session, 'agent-teams/task-updated', {
                    teamId: fresh.id,
                    taskId: task.id,
                    status: task.status,
                    assignee: task.assignee,
                    ...args.reason === undefined ? {} : { output: `Reassigned: ${args.reason}` },
                });
            });
            if (quiescenceError !== undefined)
                throw quiescenceError;
            if (target !== CAPTAIN_KEY)
                await scheduler.kickMember(workspace, team.id, target, captain);
            const current = await readTeam(stateRoot, team.id);
            const task = current === undefined ? undefined : requireTask(current, args.task_id);
            if (task === undefined)
                throw new Error(`team "${team.name}" ended during reassignment`);
            return {
                task_id: task.id,
                previous_assignee: revoked.previousAssignee,
                assignee: task.assignee ?? '',
                status: task.status,
                attempt: task.attempt ?? 0,
                ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_claim_task',
        description: 'Claim one ready task for a member (or yourself). A member cannot own a second unfinished task. The returned attempt_id is required for that member\'s updates and becomes stale after retry/reassignment.',
        parameters: {
            task_id: { type: 'string', required: true, description: 'The task id to claim.' },
            assignee: { type: 'string', description: 'Member to claim for (captain only; defaults to the task\'s assignee).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    task_id: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    assignee: { type: 'string', required: true },
                    attempt: { type: 'number', required: true },
                    attempt_id: { type: 'string' },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: `Task ${value.task_id} claimed by ${value.assignee} (attempt ${value.attempt}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}, status ${value.status}).`,
                }],
        },
        async execute(args, exec) {
            const caller = requireCaptain(exec);
            const workspace = workspaceOf(caller);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireParticipantTeam(workspace, config, caller);
            return withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id);
                const task = requireTask(fresh, args.task_id);
                if (task.reassigning === true) {
                    throw new Error(`task ${task.id} is being reassigned; wait for the handoff to finish`);
                }
                let assignee = task.assignee;
                if (identity.kind === 'captain') {
                    if (args.assignee !== undefined) {
                        requireMember(fresh, args.assignee);
                        assignee = args.assignee;
                    }
                }
                else {
                    if (args.assignee !== undefined) {
                        throw new Error('members cannot set assignee when claiming a task');
                    }
                    if (assignee !== undefined && assignee !== identity.name) {
                        throw new Error(`task ${task.id} is assigned to "${assignee}", not you`);
                    }
                    assignee = identity.name;
                }
                // Authorization must happen before the idempotent return: another
                // member must not receive a false success for somebody else's task.
                if (task.status === 'claimed' || task.status === 'in_progress') {
                    if (assignee === undefined || task.assignee !== assignee) {
                        throw new Error(`task ${task.id} is already claimed by "${task.assignee ?? 'nobody'}"`);
                    }
                    return {
                        task_id: task.id,
                        status: task.status,
                        assignee,
                        attempt: task.attempt ?? 0,
                        ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
                    };
                }
                const pending = unsatisfiedDependencies(fresh.tasks, task.dependencies);
                if (pending.length > 0) {
                    throw new Error(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them first`);
                }
                const transition = transitionError(task.status, 'claimed');
                if (transition !== undefined)
                    throw new Error(transition);
                if (assignee === undefined) {
                    throw new Error('claiming an unassigned task needs an assignee (claim on behalf of a member)');
                }
                const busy = memberOpenTask(fresh, assignee, task.id);
                if (busy !== undefined) {
                    throw new Error(`member "${assignee}" is busy with ${busy.id}; finish or reassign it first`);
                }
                const attemptId = beginTaskAttempt(task, assignee);
                await writeTeam(stateRoot, fresh);
                appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/task-updated', {
                    teamId: fresh.id,
                    taskId: task.id,
                    status: task.status,
                    assignee: task.assignee,
                });
                return {
                    task_id: task.id,
                    status: task.status,
                    assignee: task.assignee ?? '',
                    attempt: task.attempt ?? 0,
                    attempt_id: attemptId,
                };
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_update_task',
        description: 'Update a task status/output. Members must supply the current attempt_id returned by claim_task; stale attempts are rejected after takeover/reassignment. Terminal results are immutable. A captain must use reassign_task(assignee="captain") before updating member-owned work.',
        parameters: {
            task_id: { type: 'string', required: true, description: 'The task id to update.' },
            status: {
                type: 'string',
                enum: ['in_progress', 'completed', 'failed', 'cancelled'],
                description: 'New status (in_progress, completed, failed, cancelled).',
            },
            output: { type: 'string', description: 'Result summary; set when completing or failing.' },
            attempt_id: { type: 'string', description: 'Current execution capability returned by claim_task (required for members when present on the task).' },
            verdict: {
                type: 'string',
                enum: ['pass', 'needs_revision', 'reject'],
                description: 'Required for completing requirements/review. needs_revision and reject must fail the task.',
            },
            findings: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', required: true },
                        severity: { type: 'string', enum: ['low', 'medium', 'high', 'blocker'], required: true },
                        problem: { type: 'string', required: true },
                        requiredFix: { type: 'string', required: true },
                        file: { type: 'string' },
                        line: { type: 'number' },
                        resolved: { type: 'boolean' },
                    },
                },
                description: 'Structured review findings. Required when verdict is needs_revision or reject; each item needs id, severity, problem, and requiredFix.',
            },
            changedPaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Workspace-relative POSIX paths changed by this implementation/repair.',
            },
            acceptanceResults: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        criterion: { type: 'string', required: true },
                        status: { type: 'string', enum: ['passed', 'failed'], required: true },
                        evidence: { type: 'string' },
                    },
                },
                description: 'Acceptance evidence in contract order: {criterion, status:"passed"|"failed", evidence?}. Supply one item per acceptance criterion.',
            },
            commandsRun: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        command: { type: 'string', required: true },
                        status: { type: 'string', enum: ['passed', 'failed'], required: true },
                        exitCode: { type: 'number' },
                        evidence: { type: 'string' },
                    },
                },
                description: 'Verification evidence in contract order: {command, status:"passed"|"failed", exitCode?, evidence?}. Supply one item per verify command.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    task_id: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    output: { type: 'string' },
                    attempt: { type: 'number', required: true },
                    attempt_id: { type: 'string' },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: `Task ${value.task_id} attempt ${value.attempt} → ${value.status}${value.output !== undefined ? `\nOutput: ${value.output}` : ''}`,
                }],
        },
        async execute(args, exec) {
            const caller = requireCaptain(exec);
            const workspace = workspaceOf(caller);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireParticipantTeam(workspace, config, caller);
            const updated = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id);
                const task = requireTask(fresh, args.task_id);
                if (identity.kind === 'captain'
                    && task.assignee !== undefined
                    && task.assignee !== CAPTAIN_KEY) {
                    throw new Error(`task ${task.id} is owned by member "${task.assignee}"; call agent_teams_reassign_task with assignee="captain" before takeover`);
                }
                if (identity.kind === 'member') {
                    if (task.assignee !== identity.name) {
                        throw new Error(`task ${task.id} is assigned to "${task.assignee ?? 'nobody'}", not you`);
                    }
                    if (task.attemptId !== undefined && args.attempt_id !== task.attemptId) {
                        throw new Error(`stale attempt for task ${task.id}: expected the current attempt_id; stop work and request fresh assignment`);
                    }
                }
                if (TERMINAL_TASK_STATUSES.includes(task.status)) {
                    const sameStatus = args.status === undefined || args.status === task.status;
                    const sameOutput = args.output === undefined || args.output === task.output;
                    if (!sameStatus || !sameOutput) {
                        throw new Error(`terminal task ${task.id} is immutable; use agent_teams_reassign_task to retry failed/cancelled work`);
                    }
                    return {
                        task_id: task.id,
                        status: task.status,
                        attempt: task.attempt ?? 0,
                        ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
                        ...task.output !== undefined ? { output: task.output } : {},
                    };
                }
                const findings = parseFindings(args.findings);
                const acceptanceResults = parseAcceptanceResults(args.acceptanceResults);
                const commandsRun = parseCommandResults(args.commandsRun);
                const gate = evaluateQualityCompletion(task, {
                    status: args.status,
                    output: args.output,
                    verdict: args.verdict,
                    findings,
                    changedPaths: args.changedPaths,
                    acceptanceResults,
                    commandsRun,
                });
                if (!gate.ok)
                    throw new Error(gate.error ?? 'update_task rejected by quality gates');
                if (args.status !== undefined) {
                    const transition = transitionError(task.status, args.status);
                    if (transition !== undefined)
                        throw new Error(transition);
                    task.status = args.status;
                }
                if (args.output !== undefined)
                    task.output = args.output;
                if (args.verdict !== undefined)
                    task.verdict = args.verdict;
                if (findings !== undefined)
                    task.findings = findings;
                if (args.changedPaths !== undefined)
                    task.changedPaths = args.changedPaths;
                if (acceptanceResults !== undefined)
                    task.acceptanceResults = acceptanceResults;
                if (commandsRun !== undefined)
                    task.commandsRun = commandsRun;
                task.updatedAt = Date.now();
                const followUp = (task.status === 'failed' && (task.verdict === 'needs_revision' || task.verdict === 'reject'))
                    ? applyQualityFollowUp(fresh, task)
                    : undefined;
                if (followUp?.escalated === true) {
                    await appendMailbox(stateRoot, fresh.id, CAPTAIN_KEY, createMessage(CAPTAIN_KEY, CAPTAIN_KEY, `Quality-gate loop escalated after ${task.id} (${task.kind ?? 'review'} verdict=${task.verdict}). Automatic repair/review stopped.`));
                }
                await writeTeam(stateRoot, fresh);
                appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/task-updated', {
                    teamId: fresh.id,
                    taskId: task.id,
                    status: task.status,
                    ...task.assignee !== undefined ? { assignee: task.assignee } : {},
                    ...task.output !== undefined ? { output: task.output } : {},
                    ...task.verdict === undefined ? {} : { verdict: task.verdict },
                    ...task.round === undefined ? {} : { round: task.round },
                });
                for (const created of followUp?.created ?? []) {
                    appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/task-created', {
                        teamId: fresh.id,
                        taskId: created.id,
                        subject: created.subject,
                        dependencies: created.dependencies,
                        ...created.assignee === undefined ? {} : { assignee: created.assignee },
                        ...created.kind === undefined ? {} : { kind: created.kind },
                        ...created.round === undefined ? {} : { round: created.round },
                    });
                }
                return {
                    task_id: task.id,
                    status: task.status,
                    attempt: task.attempt ?? 0,
                    ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
                    ...task.output !== undefined ? { output: task.output } : {},
                };
            });
            await scheduler.kickTeam(workspace, team.id, team.captainSessionId === caller.id ? caller : undefined);
            return updated;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_send_message',
        description: 'Send a message to the captain or to a teammate. Messages go straight into the recipient\'s mailbox; when the captain agent is online the plugin also schedules live delivery (member recipients get the message as their next turn; a running captain sees it at the nearest model step). No relay is involved: teammates talk to each other directly, exactly like the Claude Code AgentTeams mailbox model.',
        parameters: {
            to: { type: 'string', required: true, description: 'Recipient: "captain" or a member name.' },
            content: { type: 'string', required: true, description: 'The message text.' },
            from: { type: 'string', description: 'Sender (defaults to the caller: the captain, or the calling member).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    message_id: { type: 'string', required: true },
                    from: { type: 'string', required: true },
                    to: { type: 'string', required: true },
                    delivered: { type: 'string', required: true, description: 'live (accepted by the live captain), wake (member recipient woken), or mailbox (durable inbox only).' },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: `Message ${value.message_id} ${value.from} → ${value.to} delivered via ${value.delivered}.`,
                }],
        },
        async execute(args, exec) {
            const caller = requireCaptain(exec);
            const workspace = workspaceOf(caller);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireParticipantTeam(workspace, config, caller);
            const to = args.to.trim();
            const prepared = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id);
                const from = identity.name;
                // `from` may only be the caller's own identity: impersonating another
                // member (or the captain) would poison the mailbox and event records.
                if (args.from !== undefined && args.from !== from) {
                    throw new Error(`agent_teams_send_message: "from" must be your own identity ("${from}"), not "${args.from}"`);
                }
                if (to === CAPTAIN_KEY) {
                    const message = { ...createMessage(from, CAPTAIN_KEY, args.content), deliveryClaimedAt: Date.now() };
                    await appendMailbox(stateRoot, fresh.id, CAPTAIN_KEY, message);
                    appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/message-sent', {
                        teamId: fresh.id,
                        messageId: message.id,
                        from,
                        to: CAPTAIN_KEY,
                        content: args.content,
                        ts: message.ts,
                    });
                    return { kind: 'captain', fresh, identity, message, from };
                }
                if (fresh.halted === true) {
                    throw new Error(`team "${fresh.name}" is halted; call agent_teams_resume before waking a member`);
                }
                const recipient = requireMember(fresh, to);
                const message = { ...createMessage(from, recipient.name, args.content), deliveryClaimedAt: Date.now() };
                await appendMailbox(stateRoot, fresh.id, recipient.name, message);
                appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/message-sent', {
                    teamId: fresh.id,
                    messageId: message.id,
                    from,
                    to: recipient.name,
                    content: args.content,
                    ts: message.ts,
                });
                return { kind: 'member', fresh, identity, message, from, recipient };
            });
            // Resolve the exact live captain only after releasing the state lock.
            // The plugin mailbox is already durable if live delivery cannot proceed.
            const captain = ctx.agents.get(prepared.fresh.captainSessionId);
            if (prepared.kind === 'captain') {
                let delivered = 'mailbox';
                if (captain !== undefined && prepared.identity.kind === 'member') {
                    delivered = steerCaptainReport(captain, prepared.from, args.content) ? 'live' : 'mailbox';
                }
                if (delivered === 'live') {
                    await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (acknowledgeMailbox(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])));
                }
                else {
                    await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (releaseMailboxDelivery(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])));
                }
                return { message_id: prepared.message.id, from: prepared.from, to: CAPTAIN_KEY, delivered };
            }
            let delivered = 'mailbox';
            if (captain !== undefined && prepared.recipient.id !== '') {
                const senderText = prepared.from === CAPTAIN_KEY
                    ? args.content
                    : `Message from team member ${prepared.from}:\n\n${args.content}`;
                const text = `AgentTeams state policy: inspect ${config.stateDir}/${prepared.fresh.id}/ read-only; never edit team.json or inbox files directly. Use agent_teams_* tools for team state.\n\n${senderText}`;
                const accepted = await deliverToMember(ctx, captain, prepared.recipient.id, text, exec.signal);
                delivered = accepted ? 'wake' : 'mailbox';
                if (accepted) {
                    await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (acknowledgeMailbox(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])));
                }
            }
            if (delivered === 'mailbox') {
                await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (releaseMailboxDelivery(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])));
            }
            return {
                message_id: prepared.message.id,
                from: prepared.from,
                to: prepared.recipient.name,
                delivered,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_status',
        description: 'Team snapshot: members with live activity and tasks with status/assignee/dependencies/output. Captains also see every team mailbox; members see only their own inbox. Poll this to watch progress.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
        },
        async execute(_args, exec) {
            const caller = requireCaptain(exec);
            const workspace = workspaceOf(caller);
            const stateRoot = stateRootOf(workspace, config);
            const located = await requireParticipantTeam(workspace, config, caller);
            if (located.captainSessionId === caller.id) {
                await scheduler.kickTeam(workspace, located.id, caller);
            }
            const { team, identity } = await withTeamLock(teamLockKey(stateRoot, located.id), () => requireFreshParticipant(stateRoot, located.id, caller.id));
            const activity = memberActivity(ctx, team.members.map((member) => member.id));
            const members = team.members
                .filter((member) => member.status !== 'removed')
                .map((member) => ({
                name: member.name,
                role: member.role ?? '',
                provider: member.provider ?? '',
                model: member.model ?? '',
                reasoning_effort: member.reasoningEffort ?? '',
                status: member.status,
                activity: member.id !== '' ? (activity.get(member.id) ?? 'unknown') : 'unspawned',
            }));
            const tasks = team.tasks.map((task) => ({
                id: task.id,
                subject: task.subject,
                status: task.status,
                assignee: task.assignee ?? '',
                dependencies: task.dependencies,
                attempt: task.attempt ?? 0,
                attempt_id: task.attemptId ?? '',
                reassigning: task.reassigning === true,
                kind: taskKindOf(task),
                ...task.round === undefined ? {} : { round: task.round },
                ...task.verdict === undefined ? {} : { verdict: task.verdict },
                findings_open: (task.findings ?? []).filter((finding) => finding.resolved !== true).length,
                ...task.profileSeedId === undefined ? {} : { seed_id: task.profileSeedId },
                ...task.output !== undefined ? { output: task.output } : {},
            }));
            const mailboxWarnings = [];
            let mailboxWarningCount = 0;
            const reportMalformed = (agentKey) => (lineNumber) => {
                mailboxWarningCount += 1;
                if (mailboxWarnings.length < 10) {
                    mailboxWarnings.push(`${agentKey} mailbox line ${lineNumber}`);
                }
            };
            const captainInbox = identity.kind === 'captain'
                ? await readUnreadMailbox(stateRoot, team.id, CAPTAIN_KEY, reportMalformed(CAPTAIN_KEY))
                : [];
            const memberInboxes = {};
            const visibleMembers = identity.kind === 'captain'
                ? members
                : members.filter((member) => member.name === identity.name);
            for (const member of visibleMembers) {
                const messages = await readUnreadMailbox(stateRoot, team.id, member.name, reportMalformed(member.name));
                if (messages.length > 0) {
                    memberInboxes[member.name] = {
                        count: messages.length,
                        latest: messages[messages.length - 1]?.content.slice(0, 200) ?? '',
                    };
                }
            }
            const coverage = buildCoverageMatrix([...new Set(team.tasks.flatMap((item) => item.coverageOf ?? []))], team.tasks).map((row) => ({
                goal_item: row.goal_item,
                task_ids: [...row.task_ids],
                status: row.status,
                ...row.evidence === undefined ? {} : { evidence: row.evidence },
            }));
            const deliveryCheck = canDeclareDelivery(team);
            const delivery = { ok: deliveryCheck.ok, blockers: [...deliveryCheck.blockers] };
            const loop = describeQualityLoop(team);
            const result = {
                team_id: team.id,
                team_name: team.name,
                description: team.description ?? '',
                phase: team.phase ?? 'running',
                halted: loop.halted,
                escalated: loop.escalated,
                loop_state: loop.state,
                loop_summary: loop.summary,
                deliverable: loop.deliverable,
                coverage,
                delivery,
                ...team.profile === undefined ? {} : {
                    profile: {
                        name: team.profile.name,
                        ...team.profile.protocol === undefined
                            ? {}
                            : { protocol: team.profile.protocol.slice(0, 240) },
                        ...team.profile.taskPlanning === undefined ? {} : { task_planning: team.profile.taskPlanning },
                    },
                },
                viewer: identity.name,
                members,
                tasks,
                captain_inbox: captainInbox.slice(-10).map((message) => ({
                    from: message.from,
                    content: message.content,
                    ts: message.ts,
                })),
                member_inboxes: memberInboxes,
                mailbox_warnings: mailboxWarnings,
                mailbox_warning_count: mailboxWarningCount,
            };
            const acknowledged = identity.kind === 'captain'
                ? captainInbox.map(message => message.id)
                : await readUnreadMailbox(stateRoot, team.id, identity.name).then(messages => messages.map(message => message.id));
            if (acknowledged.length > 0) {
                await withTeamLock(teamLockKey(stateRoot, team.id), () => (acknowledgeMailbox(stateRoot, team.id, identity.kind === 'captain' ? CAPTAIN_KEY : identity.name, acknowledged)));
            }
            return result;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_resume',
        description: 'Explicitly resume a halted team. Requires a non-empty reason. Does not recreate cancelled tasks; only still-pending work is scheduled.',
        parameters: {
            reason: { type: 'string', required: true, description: 'Why the team is being resumed.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    status: { type: 'string', required: true },
                    team_id: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.status === 'already_running'
                        ? `Team ${value.team_id} is already running.`
                        : `Team ${value.team_id} resumed (${value.reason}).`,
                }],
        },
        async execute(args, exec) {
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireCaptainTeam(workspace, config, captain);
            const result = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id);
                const resumed = resumeTeamState(fresh, args.reason);
                if (resumed.status === 'rejected')
                    throw new Error(resumed.error ?? 'resume rejected');
                if (resumed.status === 'resumed') {
                    fresh.halted = false;
                    fresh.haltedAt = undefined;
                    await writeTeam(stateRoot, fresh);
                    appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/team-resumed', {
                        teamId: fresh.id,
                        reason: args.reason,
                    });
                }
                return {
                    status: resumed.status,
                    team_id: fresh.id,
                    reason: args.reason,
                };
            });
            if (result.status === 'resumed')
                await scheduler.kickTeam(workspace, team.id, captain);
            return result;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'agent_teams_delete',
        description: 'End your team: interrupts all members (best effort) and deletes the team\'s state directory (team file, tasks, mailboxes). Use when the team\'s work is done or abandoned.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    deleted: { type: 'boolean', required: true },
                    team_name: { type: 'string', required: true },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: `Team "${value.team_name}" deleted.`,
                }],
        },
        async execute(_args, exec) {
            const captain = requireCaptain(exec);
            const workspace = workspaceOf(captain);
            const stateRoot = stateRootOf(workspace, config);
            const team = await requireCaptainTeam(workspace, config, captain);
            const members = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id);
                // Include previously removed members so deleting a pre-fix team also
                // retires durable catalog entries left behind by remove_member.
                const roster = fresh.members.map(member => ({ ...member }));
                for (const member of fresh.members) {
                    if (member.status === 'removed')
                        continue;
                    member.status = 'removed';
                    for (const task of fresh.tasks) {
                        if (task.assignee === member.name && !TERMINAL_TASK_STATUSES.includes(task.status))
                            invalidateTaskAttempt(task);
                    }
                }
                await writeTeam(stateRoot, fresh);
                return roster;
            });
            await recordRetiredMemberIds(stateRoot, members.map(member => member.id));
            for (const member of members) {
                if (member.id === '')
                    continue;
                interruptMember(ctx, captain, member.id);
            }
            const quiescence = await Promise.allSettled(members.map(member => waitForMemberIdle(ctx, member, exec.signal)));
            for (const result of quiescence) {
                if (result.status === 'rejected') {
                    ctx.logger.warn(`agent-teams: member did not quiesce cleanly before team archive: ${String(result.reason)}`);
                }
            }
            await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id);
                appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/team-deleted', {
                    teamId: fresh.id,
                });
                // Archive, not delete: tasks (with their dependency graph) and the
                // mailboxes stay on disk for later review and dependency rebuilds.
                await archiveTeamDir(stateRoot, fresh.id);
            });
            return { deleted: true, team_name: team.name };
        },
    }));
    return runtime;
}
async function initializeProfileTeam(input) {
    const profile = resolveTeamProfile(input.config.profiles, input.profileName, input.config.maxMembers);
    const selections = [];
    for (const template of profile.members) {
        selections.push(await resolveMemberLlmSelection(input.ctx, input.captain, {
            provider: template.provider,
            model: template.model,
            defaultModel: input.config.memberModel,
            reasoningEffort: template.reasoningEffort,
            fallback: template.fallback ?? profile.fallback ?? input.config.fallback,
        }, input.exec.signal));
    }
    await validateMemberLlmSelections(input.ctx, selections, input.exec.signal);
    const now = Date.now();
    const seedToActual = new Map(profile.tasks.map((template, index) => [template.id, `t${index + 1}`]));
    const draft = {
        name: input.teamName,
        id: input.teamId,
        description: input.description,
        profile: {
            name: profile.name,
            ...profile.description === undefined ? {} : { description: profile.description },
            ...profile.protocol === undefined ? {} : { protocol: profile.protocol },
            ...profile.executionPrompt === undefined ? {} : { executionPrompt: profile.executionPrompt },
            ...profile.fallback === undefined ? {} : { fallback: profile.fallback },
            taskPlanning: profile.taskPlanning,
            ...profile.reviewPolicy === undefined ? {} : { reviewPolicy: profile.reviewPolicy },
        },
        ...profile.reviewPolicy === undefined ? {} : { reviewPolicy: profile.reviewPolicy },
        captainSessionId: input.captain.id,
        createdAt: now,
        ...input.staged ? { phase: 'staged', planReviewState: 'awaiting_review' } : {},
        members: profile.members.map((template, index) => {
            const selection = selections[index];
            return {
                id: '',
                name: template.name,
                role: template.role,
                provider: selection.provider,
                model: selection.model,
                reasoningEffort: selection.reasoningEffort,
                executionPrompt: template.executionPrompt ?? profile.executionPrompt ?? input.config.executionPrompt,
                ...selection.fallback === undefined ? {} : { fallback: selection.fallback },
                joinedAt: now,
                status: 'idle',
            };
        }),
        tasks: profile.tasks.map((template, index) => ({
            id: `t${index + 1}`,
            profileSeedId: template.id,
            subject: template.subject,
            description: template.description,
            status: 'pending',
            assignee: template.assignee,
            dependencies: template.dependencies.map((dependency) => seedToActual.get(dependency) ?? dependency),
            attempt: 0,
            createdAt: now,
            updatedAt: now,
        })),
        taskSeq: profile.tasks.length,
    };
    if (input.staged) {
        await createTeamDir(input.stateRoot, draft);
        return { committed: true, state: draft };
    }
    const spawned = [];
    try {
        for (const member of draft.members) {
            const selection = selections[spawned.length];
            await spawnMember(input.ctx, memberRuntime(input.config), input.memberSelections, selection, input.captain, draft, member, input.config.stateDir, input.exec.signal);
            spawned.push(member);
        }
        if (draft.members.some((member) => member.id === '')) {
            throw new Error(`failed to initialize profile "${profile.name}": a spawned member is missing its child id`);
        }
        await createTeamDir(input.stateRoot, draft);
        return { committed: true, state: draft };
    }
    catch (error) {
        const cleanupErrors = [];
        try {
            await removeTeamDir(input.stateRoot, draft.id);
        }
        catch (cleanupError) {
            cleanupErrors.push(cleanupError);
        }
        try {
            await recordRetiredMemberIds(input.stateRoot, spawned.map((member) => member.id));
        }
        catch (cleanupError) {
            cleanupErrors.push(cleanupError);
        }
        for (const member of spawned) {
            try {
                interruptMember(input.ctx, input.captain, member.id);
            }
            catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError([error, ...cleanupErrors], `failed to initialize profile "${profile.name}"`);
        }
        throw error;
    }
}
function parseFindings(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error('findings must be an array');
    return value.map((item, index) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new Error(`findings[${index}] must be an object`);
        }
        const raw = item;
        if (typeof raw['id'] !== 'string' || raw['id'].trim() === '')
            throw new Error(`findings[${index}].id is required`);
        if (raw['severity'] !== 'low' && raw['severity'] !== 'medium' && raw['severity'] !== 'high' && raw['severity'] !== 'blocker') {
            throw new Error(`findings[${index}].severity is invalid`);
        }
        if (typeof raw['problem'] !== 'string' || raw['problem'].trim() === '')
            throw new Error(`findings[${index}].problem is required`);
        if (typeof raw['requiredFix'] !== 'string' || raw['requiredFix'].trim() === '')
            throw new Error(`findings[${index}].requiredFix is required`);
        return {
            id: raw['id'].trim(),
            severity: raw['severity'],
            problem: raw['problem'],
            requiredFix: raw['requiredFix'],
            ...typeof raw['file'] === 'string' ? { file: raw['file'] } : {},
            ...typeof raw['line'] === 'number' ? { line: raw['line'] } : {},
            ...typeof raw['resolved'] === 'boolean' ? { resolved: raw['resolved'] } : {},
        };
    });
}
function parseAcceptanceResults(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error('acceptanceResults must be an array');
    return value.map((item, index) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new Error(`acceptanceResults[${index}] must be an object`);
        }
        const raw = item;
        if (typeof raw['criterion'] !== 'string' || raw['criterion'].trim() === '') {
            throw new Error(`acceptanceResults[${index}].criterion is required`);
        }
        if (raw['status'] !== 'passed' && raw['status'] !== 'failed') {
            throw new Error(`acceptanceResults[${index}].status must be passed or failed`);
        }
        return {
            criterion: raw['criterion'],
            status: raw['status'],
            ...typeof raw['evidence'] === 'string' ? { evidence: raw['evidence'] } : {},
        };
    });
}
function parseCommandResults(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error('commandsRun must be an array');
    return value.map((item, index) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new Error(`commandsRun[${index}] must be an object`);
        }
        const raw = item;
        if (typeof raw['command'] !== 'string' || raw['command'].trim() === '') {
            throw new Error(`commandsRun[${index}].command is required`);
        }
        if (raw['status'] !== 'passed' && raw['status'] !== 'failed') {
            throw new Error(`commandsRun[${index}].status must be passed or failed`);
        }
        return {
            command: raw['command'],
            status: raw['status'],
            ...typeof raw['exitCode'] === 'number' ? { exitCode: raw['exitCode'] } : {},
            ...typeof raw['evidence'] === 'string' ? { evidence: raw['evidence'] } : {},
        };
    });
}
export function applyQualityFollowUp(team, closed) {
    const planned = planQualityFollowUp(team, closed);
    if (planned.escalated === true)
        team.escalated = true;
    const created = [];
    const existing = [...team.tasks];
    const now = Date.now();
    const idBySubject = new Map();
    for (const draft of planned.created) {
        team.taskSeq += 1;
        const id = `t${team.taskSeq}`;
        if (draft.id !== undefined)
            idBySubject.set(draft.id, id);
        if (draft.subject !== undefined)
            idBySubject.set(draft.subject, id);
        const dependencies = (draft.dependencies ?? []).map((dependency) => {
            if (team.tasks.some((item) => item.id === dependency))
                return dependency;
            return idBySubject.get(dependency) ?? dependency;
        });
        const next = {
            id,
            subject: draft.subject ?? `${draft.kind}-round-${draft.round ?? 1}`,
            status: 'pending',
            assignee: draft.assignee,
            dependencies,
            attempt: 0,
            createdAt: now,
            updatedAt: now,
            kind: draft.kind,
            ...draft.round === undefined ? {} : { round: draft.round },
            ...draft.objective === undefined ? {} : { objective: draft.objective },
            ...draft.inScope === undefined ? {} : { inScope: draft.inScope },
            ...draft.outOfScope === undefined ? {} : { outOfScope: draft.outOfScope },
            ...draft.acceptance === undefined ? {} : { acceptance: draft.acceptance },
            ...draft.verify === undefined ? {} : { verify: draft.verify },
            ...draft.sourceTaskId === undefined ? {} : { sourceTaskId: draft.sourceTaskId },
            ...draft.sourceFindingIds === undefined ? {} : { sourceFindingIds: draft.sourceFindingIds },
            ...draft.reviewedTaskId === undefined ? {} : { reviewedTaskId: idBySubject.get(draft.reviewedTaskId) ?? draft.reviewedTaskId },
        };
        team.tasks.push(next);
        created.push(next);
    }
    // A staged full delivery plan may already contain downstream integration
    // work that points at the first requirements/review gate. When that gate
    // opens an automatic revision loop, move only still-pending downstream
    // edges to the new terminal gate so the approved plan can continue after
    // the repair instead of waiting forever on an intentionally failed task.
    const replacement = created.at(-1);
    if (replacement !== undefined) {
        for (const task of existing) {
            if (task.status !== 'pending' || !task.dependencies.includes(closed.id))
                continue;
            task.dependencies = task.dependencies.map((dependency) => (dependency === closed.id ? replacement.id : dependency));
            task.updatedAt = now;
        }
    }
    return { created, escalated: planned.escalated === true };
}
/** Build the `memberRuntime` config handed to member helpers. */
function memberRuntime(config) {
    return {
        provider: config.memberProvider,
        maxDepth: config.memberMaxDepth,
        executionPrompt: config.executionPrompt,
        fallback: config.fallback,
    };
}
/** Render the status snapshot as compact text for the model. */
function renderStatus(value) {
    const team = value;
    const flags = [
        team.halted ? 'halted' : undefined,
        team.escalated ? 'escalated' : undefined,
        team.deliverable ? 'deliverable' : undefined,
        team.loop_state && team.loop_state !== 'running' && team.loop_state !== 'halted' && team.loop_state !== 'escalated'
            ? team.loop_state
            : undefined,
    ].filter((item) => item !== undefined);
    const lines = [
        `Team "${team.team_name}"${team.description ? ` — ${team.description}` : ''}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`,
        ...team.profile === undefined ? [] : [`Profile: ${team.profile.name}${team.profile.task_planning ? ` [${team.profile.task_planning}]` : ''}${team.profile.protocol ? ` — ${team.profile.protocol}` : ''}`],
        ...team.loop_summary ? [`Loop: ${team.loop_state ?? ''} — ${team.loop_summary}`.replace(/^Loop:  — /u, 'Loop: ')] : [],
        `Viewing as: ${team.viewer}`,
        `Members (${team.members.length}):`,
        ...team.members.map((member) => {
            const route = member.provider && member.model ? ` · ${member.provider}/${member.model}` : '';
            const effort = member.reasoning_effort ? ` · reasoning ${member.reasoning_effort}` : '';
            return `  - ${member.name} [${member.role}] ${member.status}/${member.activity}${route}${effort}`;
        }),
        `Tasks (${team.tasks.length}):`,
        ...team.tasks.map((task) => {
            const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.join(',')})` : '';
            const output = task.output !== undefined ? `\n      output: ${task.output.slice(0, 300)}` : '';
            const handoff = task.reassigning ? ' (reassigning)' : '';
            const seed = task.seed_id === undefined || task.seed_id === '' ? '' : ` seed ${task.seed_id}`;
            const kind = task.kind ? ` ${task.kind}` : '';
            const round = task.round === undefined ? '' : ` r${task.round}`;
            const verdict = task.verdict === undefined ? '' : ` verdict ${task.verdict}`;
            return `  - ${task.id} [${task.status}]${kind}${round}${verdict} attempt ${task.attempt}${handoff}${seed} ${task.subject} → ${task.assignee || 'unassigned'}${deps}${output}`;
        }),
        ...team.coverage === undefined || team.coverage.length === 0 ? [] : [
            'Coverage:',
            ...team.coverage.map((row) => `  - ${row.goal_item}: ${row.status} (${row.task_ids.join(',') || 'none'})`),
        ],
        ...team.delivery === undefined ? [] : [
            `Delivery: ${team.delivery.ok ? 'ok' : `blocked (${team.delivery.blockers.join('; ')})`}`,
        ],
        `Captain inbox (${team.captain_inbox.length}):`,
        ...team.captain_inbox.map((message) => `  - [${message.from}] ${message.content.slice(0, 200)}`),
    ];
    for (const [name, inbox] of Object.entries(team.member_inboxes)) {
        lines.push(`Member inbox ${name} (${inbox.count}): latest — ${inbox.latest.slice(0, 120)}`);
    }
    if (team.mailbox_warning_count > 0) {
        lines.push(`Mailbox warnings (${team.mailbox_warning_count}; malformed lines were skipped; showing up to 10):`, ...team.mailbox_warnings.map((warning) => `  - ${warning}`));
    }
    return lines.join('\n');
}

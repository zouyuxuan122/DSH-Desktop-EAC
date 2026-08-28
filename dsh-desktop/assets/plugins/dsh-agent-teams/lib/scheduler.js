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
import { join } from 'node:path';
import { deliverToMember } from "./members.js";
import { acknowledgeMailbox, beginTaskAttempt, claimMailboxDelivery, findTeamByParticipant, readTeam, readUnreadMailbox, releaseMailboxDelivery, unsatisfiedDependencies, withTeamLock, writeTeam, } from "./state.js";
function stateRootOf(workspace, config) {
    return join(workspace, config.stateDir);
}
function teamLockKey(stateRoot, teamId) {
    return `team:${stateRoot}:${teamId}`;
}
function liveCaptain(ctx, captainSessionId, supplied) {
    if (supplied !== undefined && supplied.id === captainSessionId)
        return supplied;
    return ctx.agents.get(captainSessionId);
}
function liveMember(ctx, member) {
    return ctx.agents.get(member.id);
}
function isMemberAvailable(ctx, member) {
    const live = liveMember(ctx, member);
    return live === undefined || live.status === 'idle';
}
function ownedOpenTask(tasks, memberName) {
    return tasks.find(task => task.assignee === memberName
        && (task.status === 'claimed' || task.status === 'in_progress'));
}
function nextReadyTask(tasks, memberName) {
    const ready = tasks.filter(task => task.status === 'pending'
        && task.reassigning !== true
        && unsatisfiedDependencies([...tasks], task.dependencies).length === 0);
    return ready.find(task => task.assignee === memberName)
        ?? ready.find(task => task.assignee === undefined);
}
function assignmentPrompt(ticket, stateDir, teamId) {
    const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`;
    return `AgentTeams automatic task assignment from the shared task list.

Task: ${ticket.taskId} — ${ticket.subject}${description}
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}

Call agent_teams_claim_task for ${ticket.taskId}; it will return this same attempt_id. Include attempt_id=${ticket.attemptId} in every agent_teams_update_task call. If it is rejected as stale, stop work because the task was reassigned. Work only this task in this turn, report the result to the captain, then become idle so the scheduler can select your next ready task.

State policy: ${stateDir}/${teamId}/ is read-only diagnostics; mutate team state only through agent_teams_* tools.`;
}
function fallbackMailboxPrompt(messages) {
    return [
        'AgentTeams delivered messages that were persisted while live delivery was unavailable:',
        ...messages.map(message => `\nFrom ${message.from}:\n${message.content}`),
        '\nHandle these messages in this turn. Task assignments still require agent_teams_claim_task and the current attempt_id.',
    ].join('\n');
}
/** Install one scheduler and its member activity observer. */
export function installTeamScheduler(ctx, config) {
    const memberQueues = new Map();
    // An idle edge in this process proves that the resident member ended its
    // turn while the current attempt was still open. Remember that capability
    // even after Harness disposes the continuable AgentHandle: later status or
    // graph kicks must keep it parked. A cold process starts with an empty map,
    // so durable open attempts are still recovered after restart.
    const parkedAttempts = new Map();
    const memberQueueKey = (stateRoot, teamId, memberName) => (`${stateRoot}\u0000${teamId}\u0000${memberName}`);
    const serializeMember = async (key, operation) => {
        const previous = memberQueues.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => gate);
        memberQueues.set(key, tail);
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
            if (memberQueues.get(key) === tail)
                memberQueues.delete(key);
        }
    };
    const runtime = {
        async kickTeam(workspace, teamId, suppliedCaptain) {
            const stateRoot = stateRootOf(workspace, config);
            const team = await readTeam(stateRoot, teamId);
            if (team === undefined)
                return;
            const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
            if (captain === undefined)
                return;
            for (const member of team.members) {
                if (member.status === 'removed')
                    continue;
                await runtime.kickMember(workspace, teamId, member.name, captain);
            }
        },
        async kickMember(workspace, teamId, memberName, suppliedCaptain) {
            const stateRoot = stateRootOf(workspace, config);
            const queueKey = memberQueueKey(stateRoot, teamId, memberName);
            await serializeMember(queueKey, async () => {
                let team = await readTeam(stateRoot, teamId);
                if (team === undefined)
                    return;
                const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain);
                if (captain === undefined)
                    return;
                let member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed');
                if (member === undefined || member.id === '' || !isMemberAvailable(ctx, member))
                    return;
                // A mailbox-only fallback is real pending work. Deliver it before a
                // fresh task and acknowledge only after Harness accepts the follow-up.
                const unread = await readUnreadMailbox(stateRoot, team.id, member.name);
                if (unread.length > 0) {
                    await withTeamLock(teamLockKey(stateRoot, team.id), () => (claimMailboxDelivery(stateRoot, team.id, member.name, unread.map(message => message.id))));
                    const accepted = await deliverToMember(ctx, captain, member.id, fallbackMailboxPrompt(unread), new AbortController().signal);
                    if (accepted) {
                        await withTeamLock(teamLockKey(stateRoot, team.id), () => (acknowledgeMailbox(stateRoot, team.id, member.name, unread.map(message => message.id))));
                    }
                    else {
                        await withTeamLock(teamLockKey(stateRoot, team.id), () => (releaseMailboxDelivery(stateRoot, team.id, member.name, unread.map(message => message.id))));
                    }
                    return;
                }
                const ticket = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                    const fresh = await readTeam(stateRoot, team.id);
                    if (fresh === undefined)
                        return undefined;
                    const currentMember = fresh.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed');
                    if (currentMember === undefined || currentMember.id === '' || !isMemberAvailable(ctx, currentMember))
                        return undefined;
                    const owned = ownedOpenTask(fresh.tasks, currentMember.name);
                    // A resident idle member can intentionally leave an attempt open
                    // while waiting for guidance, or because the user paused its turn.
                    // Re-dispatching here would revoke still-valid work on every idle
                    // edge and every status kick. The idle observer remembers that exact
                    // capability across normal continuable disposal; only an unobserved
                    // durable capability (cold process recovery) or a legacy open task
                    // with no capability is retried.
                    const parkedAttemptId = parkedAttempts.get(currentMember.id);
                    const recoverOwned = owned !== undefined
                        && (owned.attemptId === undefined || owned.attemptId !== parkedAttemptId);
                    const task = recoverOwned ? owned : owned === undefined
                        ? nextReadyTask(fresh.tasks, currentMember.name)
                        : undefined;
                    if (task === undefined) {
                        if (currentMember.status !== 'idle') {
                            currentMember.status = 'idle';
                            await writeTeam(stateRoot, fresh);
                        }
                        return undefined;
                    }
                    const previousAssignee = task.assignee;
                    const attemptId = beginTaskAttempt(task, currentMember.name);
                    parkedAttempts.delete(currentMember.id);
                    currentMember.status = 'working';
                    await writeTeam(stateRoot, fresh);
                    return {
                        taskId: task.id,
                        memberName: currentMember.name,
                        memberId: currentMember.id,
                        attempt: task.attempt ?? 1,
                        attemptId,
                        previousAssignee,
                        subject: task.subject,
                        description: task.description,
                    };
                });
                if (ticket === undefined)
                    return;
                const accepted = await deliverToMember(ctx, captain, ticket.memberId, assignmentPrompt(ticket, config.stateDir, team.id), new AbortController().signal);
                if (accepted)
                    return;
                // Roll back only our exact failed dispatch. A concurrent captain
                // handoff has already changed the capability and wins.
                await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                    const fresh = await readTeam(stateRoot, team.id);
                    if (fresh === undefined)
                        return;
                    const task = fresh.tasks.find(candidate => candidate.id === ticket.taskId);
                    if (task?.attemptId !== ticket.attemptId)
                        return;
                    task.status = 'pending';
                    task.assignee = ticket.previousAssignee;
                    task.attemptId = undefined;
                    task.handoffId = undefined;
                    task.reassigning = false;
                    task.updatedAt = Date.now();
                    const currentMember = fresh.members.find(candidate => candidate.name === ticket.memberName);
                    if (currentMember !== undefined && currentMember.status !== 'removed')
                        currentMember.status = 'idle';
                    await writeTeam(stateRoot, fresh);
                });
            });
        },
    };
    const syncMemberStatus = async (agent, status) => {
        const workspace = agent.session.header.cwd ?? process.cwd();
        const stateRoot = stateRootOf(workspace, config);
        const located = await findTeamByParticipant(stateRoot, agent.id);
        if (located === undefined) {
            parkedAttempts.delete(agent.id);
            return;
        }
        if (located.captainSessionId === agent.id)
            return;
        const member = located.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed');
        if (member === undefined) {
            parkedAttempts.delete(agent.id);
            return;
        }
        await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
            const fresh = await readTeam(stateRoot, located.id);
            const current = fresh?.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed');
            if (fresh === undefined || current === undefined)
                return;
            const next = status === 'running' ? 'working' : 'idle';
            if (next === 'idle') {
                const owned = ownedOpenTask(fresh.tasks, current.name);
                if (owned?.attemptId === undefined)
                    parkedAttempts.delete(agent.id);
                else
                    parkedAttempts.set(agent.id, owned.attemptId);
            }
            else {
                parkedAttempts.delete(agent.id);
            }
            if (current.status === next)
                return;
            current.status = next;
            await writeTeam(stateRoot, fresh);
        });
        if (status === 'idle')
            await runtime.kickMember(workspace, located.id, member.name);
    };
    ctx.on('agent/status', ({ agent, status }) => {
        void syncMemberStatus(agent, status).catch((error) => {
            ctx.logger.warn(`agent-teams: member status scheduling failed for ${agent.id}: ${String(error)}`);
        });
    });
    return runtime;
}

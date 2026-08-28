/**
 * Durable AgentTeams session events and their emitter.
 *
 * Every team-state mutation appends one event to the captain's Session, so
 * the web client's Conversation Node mechanism can fold the tree view from
 * the session log deterministically (same mechanism as `tool-workflow`'s
 * `tool-workflow/*` record events). Events append to the captain's session
 * even when a member agent performed the mutation, so the captain's
 * conversation stream stays the single authoritative monitor surface.
 *
 * Types and the `SessionEventMap` merge live in `event-types.ts` (zero
 * imports) so the browser program can load them without host augmentations.
 * @module dsh-agent-teams/events
 */
import * as dshSession from '@deepseek-ai/dsh-session';
/** Event types already reported as unsupported, to avoid repetitive logs. */
const skippedEventTypes = new Set();
/**
 * Append one AgentTeams event to a Session, containing failures (a broken
 * durable record must never break team tool execution).
 * @param ctx - the plugin context (for logging).
 * @param session - the session to record into (the captain's, normally).
 * @param type - the event type.
 * @param data - the event payload.
 */
export function appendTeamEvent(ctx, session, type, data) {
    // Out-of-repo events are not in the harness's generated vocabulary today.
    // Mutating that ReadonlySet would make readability depend on which plugins
    // happen to be loaded. Until Session.append exposes the official
    // `ignorable: true` writer surface, omit these informational records unless
    // the running harness already recognizes them. Disk state remains the
    // authoritative source for the activity panel.
    const known = dshSession.KNOWN_SESSION_EVENT_TYPES;
    if (known?.has(type) !== true) {
        if (!skippedEventTypes.has(type)) {
            skippedEventTypes.add(type);
            ctx.logger.debug(`agent-teams: session event "${type}" omitted because this harness does not recognize it`);
        }
        return;
    }
    try {
        session.append(type, data);
    }
    catch (error) {
        ctx.logger.warn(`agent-teams: session record failed after ${type}: ${String(error)}`);
    }
}
/**
 * Resolve the captain's live Session for event recording. The captain agent
 * may be offline (its team outlives the session), in which case the caller's
 * own session is used as the fallback record target.
 * @param ctx - the plugin context (injects `agents`).
 * @param captainSessionId - the captain's durable session id.
 * @param fallback - the calling agent's session, used when the captain is not live.
 * @returns the session to record into.
 */
export function captainSessionOf(ctx, captainSessionId, fallback) {
    const captain = ctx.agents.get(captainSessionId);
    return captain?.session ?? fallback;
}

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
/** Parse the only create-call fields the historic card owns. */
export function parseAgentTeamsCreateArgs(value) {
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null || !('name' in parsed) || typeof parsed.name !== 'string') {
            return undefined;
        }
        const name = parsed.name.trim();
        if (name === '')
            return undefined;
        const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return { teamId: cleaned === '' ? 'team' : cleaned, name };
    }
    catch {
        return undefined;
    }
}
/** Durable first-party tool events folded into one keyed Chat node. */
export const agentTeamsCardDefinition = {
    kind: 'agent-teams',
    target: 'chat',
    match: (event) => {
        if (event.type === 'tool/call' && event.data.name === 'agent_teams_create') {
            return parseAgentTeamsCreateArgs(event.data.arguments) === undefined
                ? null
                : { id: String(event.data.callId), role: 'start' };
        }
        if (event.type === 'tool/result' && event.data.message.source.kind === 'tool') {
            return { id: String(event.data.message.source.callId), role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'tool/call') {
            throw new Error('agent-teams card start requires agent_teams_create tool/call');
        }
        const parsed = parseAgentTeamsCreateArgs(match.event.data.arguments);
        if (parsed === undefined)
            throw new Error('agent-teams card start requires valid create arguments');
        return { ...parsed, accepted: false };
    },
    update: (context, match) => {
        if (match.event.type !== 'tool/result')
            return context.state;
        const failed = match.event.data.error !== undefined
            || match.event.data.message.content.some((block) => block.type === 'tool-result' && block.isError === true);
        if (failed)
            return context.state;
        return { ...context.state, accepted: true };
    },
    buildViewNode: (context) => {
        if (context.start === undefined)
            return null;
        const state = context.state;
        if (!state.accepted)
            return null;
        return {
            key: context.key,
            kind: 'agent-teams',
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: 'visible',
            data: {
                teamId: state.teamId,
                captainSessionId: '',
                teamName: state.name,
                members: [],
            },
        };
    },
};

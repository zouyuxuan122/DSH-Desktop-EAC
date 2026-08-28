/** Version-tolerant navigation into durable AgentTeams member transcripts. */
/**
 * Open one member's persisted transcript.
 *
 * Harness rc.8 intentionally removed cold subagents from the ordinary session
 * list. They must first be rediscovered in their parent's catalog, then opened
 * with the exact parent/child/mode address. Older runtimes have only `open()`;
 * the fallback preserves the plugin's rc.6 peer range.
 */
export async function openAgentTeamMember(sessions, parentSessionId, childSessionId) {
    if (sessions.openSubagent === undefined || sessions.refreshSubagents === undefined) {
        sessions.open(childSessionId);
        return 'session';
    }
    await sessions.refreshSubagents(parentSessionId);
    const retained = sessions.subagentAddress?.(childSessionId);
    sessions.openSubagent(retained?.parentSessionId === parentSessionId
        ? retained
        : { parentSessionId, childSessionId, mode: 'continuable' });
    return 'subagent';
}

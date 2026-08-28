/**
 * AgentTeams session event types — pure types only, zero imports.
 *
 * This file intentionally imports nothing: both the host program (the
 * emitter in `events.ts`) and the browser program (the Conversation Node
 * definition) must be able to load these types and the `SessionEventMap`
 * declaration merge without pulling in host-side `Context` augmentations
 * (dsh-session's index declares `Context.sessions: SessionStore`, which
 * collides with the browser runtime's `ISessions` under the same name).
 * @module dsh-agent-teams/event-types
 */
export {};

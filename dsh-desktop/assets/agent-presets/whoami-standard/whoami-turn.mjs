/**
 * Whoami anchor turn — seed ONE self-introduction round ahead of the user's
 * very first real message.
 *
 * The anchor is PREPENDED to the `next-turn` inbox queue ahead of the real
 * message, and dsh claims exactly ONE `next-turn` message per turn, so the
 * first real model request is the fixed "who are you" prompt on an EMPTY tool
 * surface (see zero-tool-bootstrap.mjs), while the user's actual message stays
 * queued and is claimed by the NEXT turn — by then the bootstrap has promoted
 * and the full Standard catalog (including the search MCP) is unlocked.
 *
 * Anchoring on the first user message — instead of at session creation — keeps
 * the blank-session preset switcher usable before the user types anything.
 *
 * Durability is free: the prepend goes through `agent/inbox/spliced` event
 * persistence, so a crash between the anchor and the real message resumes the
 * queue in order, and the inbox replay does not fire `inserted` notifications,
 * so the anchor is never re-injected.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'whoami-turn'

/** Default anchor text shown to the model in the synthetic first user turn. */
export const ANCHOR_TEXT = '你是谁'

/** Only top-level fresh sessions (no prior user message) get the anchor turn. */
function isFreshTopLevel(agent) {
  if ((agent.session.header.delegationDepth ?? 0) > 0) return false
  return !agent.session.events.some((event) => event.type === 'user/message')
}

/** Register the first-message whoami anchor injection. */
export function apply(ctx, config) {
  const text = typeof config.text === 'string' && config.text.length > 0
    ? config.text
    : ANCHOR_TEXT

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isFreshTopLevel(agent)) return
    // Never re-anchor on plugin-sourced messages (including our own anchor).
    if (message.source?.kind === 'plugin') return
    agent.inbox.prepend('next-turn', {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'whoami-turn',
        form: 'notice',
        summary: 'whoami anchor turn',
      },
    })
  })
}

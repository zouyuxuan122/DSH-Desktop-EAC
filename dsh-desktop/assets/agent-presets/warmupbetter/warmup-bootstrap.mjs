/**
 * Run one visible warmup turn before the session's first real request.
 *
 * Harness plugins inject workspace instructions (AGENTS.md/CLAUDE.md), the
 * skill catalog reminder, and user-invoked skill content into the FIRST step
 * that carries messages. To keep the first model request pure, this plugin
 * turns the session's very first step into a warmup round:
 *
 *  1. When the first input of a fresh session is queued, the plugin arms a
 *     per-agent pending flag (`agent/inbox/inserted`).
 *  2. While pending, `system-prompt/assemble` narrows the assembled tool
 *     catalog to one native shell plus `str_replace_editor` — the exact two
 *     tools a real Minimal session presents — so the warmup step's
 *     request/header logs that catalog (the system prompt stays the Minimal
 *     fixed text under the `complete` persona).
 *  3. On the first `agent/pre-step`, the claimed real input is moved back to
 *     the next-turn queue and the step's messages are replaced with one
 *     synthetic warmup message. The listener is registered with
 *     `{ prepend: true }`, so it runs OUTERMOST on the waterfall — ahead of
 *     the host-plane `agent-instructions` and `tool-skill` listeners — and
 *     every downstream injection (baseline, skill catalog, skill content) is
 *     discarded with the replacement.
 *  4. The warmup turn runs through the normal loop: turn/step events, a
 *     request/header with the minimal system prompt and two tools, the model
 *     stream, and an assistant message are all recorded in the trajectory.
 *     The real input is then processed in the following turn with the full
 *     catalog and all normal context.
 *
 * Failure is fail-soft: a route that cannot resolve, a rejected step, or an
 * abort skips the warmup and the real input proceeds unchanged.
 */

import { randomUUID } from 'node:crypto'

export const name = 'warmup-tool-bootstrap'

/** Prompt assembly must exist before this plugin can narrow the catalog. */
export const inject = ['systemPrompt']

const DEFAULT_MESSAGE = 'This round is a test. Tools are not open yet; all tools will open next round.'

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

export function apply(ctx, config) {
  const shellTools = stringList(config.shellTools, 'shellTools')
  const commonTools = stringList(config.commonTools, 'commonTools')
  const includeSubagents = config.subagents === true
  const message = typeof config.message === 'string' && config.message.length > 0 ? config.message : DEFAULT_MESSAGE

  /** Agents whose next assembly/pre-step must become the warmup round. */
  const pending = new WeakSet()

  /** A session that has never logged a model request and is not a subagent. */
  const freshSession = (agent) => (
    !agent.session.events.some(event => event.type === 'request/header') &&
    (includeSubagents || agent.session.header.meta?.origin !== 'subagent')
  )

  // Narrow the assembled tool catalog while the warmup is pending, so the
  // warmup step's request/header carries exactly the two tools below.
  // `prepend` keeps this filter outermost on the waterfall, so no later
  // listener can widen the catalog back before the request is built.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined || !pending.has(agent) || !freshSession(agent)) return assembled
    const available = new Set(assembled.tools.map(tool => tool.name))
    const shells = shellTools.filter(toolName => available.has(toolName))
    const missingCommon = commonTools.filter(toolName => !available.has(toolName))
    if (shells.length !== 1 || missingCommon.length > 0) {
      ctx.logger.warn('%s: cannot narrow the warmup catalog (shells=%o missing=%o); running with the full catalog', name, shells, missingCommon)
      return assembled
    }
    const keep = new Set([shells[0], ...commonTools])
    return { ...assembled, tools: assembled.tools.filter(tool => keep.has(tool.name)) }
  }, { prepend: true })

  // Arm the warmup when the first input of a fresh session is queued. This
  // fires synchronously during the inbox splice, before the driver wakes, so
  // the very first assembly already sees the pending flag.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === undefined || message === undefined || pending.has(agent)) return
    if (freshSession(agent)) pending.add(agent)
  })

  // Turn the session's very first step into the warmup round and defer the
  // real input to the next turn. The `prepend` registration is REQUIRED: the
  // host composition already registers `agent-instructions` and `tool-skill`
  // pre-step listeners at startup, so a plain (push) registration would run
  // inside them and their injections would survive our message replacement.
  // Prepend places this listener outermost on the waterfall, and the
  // replacement returned here becomes the final step decision.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    if (!pending.has(agent)) return decision
    pending.delete(agent)
    if (decision.kind === 'reject' || messages.length === 0 || !freshSession(agent)) return decision
    // Resolve the model route up front: a warmup that cannot run must not
    // consume the real input.
    const seed = { provider: agent.options.provider ?? '', model: agent.options.model ?? '' }
    let proposed
    try {
      proposed = await agent.dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seed))
    } catch (error) {
      ctx.logger.warn('%s: route resolution failed (%s); skipping the warmup round', name, error?.message ?? String(error))
      return decision
    }
    if (signal.aborted) return decision
    if (proposed === undefined || !proposed.provider || !proposed.model) {
      ctx.logger.warn('%s: no provider/model route; skipping the warmup round', name)
      return decision
    }
    for (let index = messages.length - 1; index >= 0; index--) agent.inbox.prepend('next-turn', messages[index])
    const warmup = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: message }], source: { kind: 'plugin', plugin: name } }
    ctx.logger.info('%s: warmup round queued as turn %d step %d; real input deferred to the next turn', name, turn, step)
    return { kind: 'enter', messages: [warmup] }
  }, { prepend: true })
}

/**
 * `warmupbetter-replay`: run the Warmup Better first round from pre-recorded
 * content instead of calling the real model.
 *
 * The warmup machinery is inherited from `warmupbetter`: the first input of a
 * fresh session arms a pending flag, `system-prompt/assemble` narrows the
 * catalog to one native shell plus `str_replace_editor`, and the outermost
 * `agent/pre-step` listener defers the real input to the next turn and
 * replaces the step's messages with the warmup message.
 *
 * The difference is the model call itself. When the replay file is valid, the
 * pre-step listener also marks the session, and an `llm/stream` listener
 * short-circuits that session's first model call with a synthetic stream made
 * from the recorded warmup round: one reasoning block (the recorded chain of
 * thought) and one text block (the recorded visible reply). The agent loop
 * consumes that stream exactly like a real provider stream, so
 * `assistant/chunk` and `assistant/message` are logged normally and the
 * following turn keeps the full Standard catalog.
 *
 * Failure is fail-soft. A missing or invalid replay file disables only the
 * stream short-circuit: the preset still runs the ordinary warmup round
 * through the real model. Replay never touches the real adapter, and a stream
 * abort surfaces like an aborted adapter stream.
 */

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const name = 'warmup-replay'

/** Prompt assembly must exist before this plugin can narrow the catalog. */
export const inject = ['systemPrompt']

const DEFAULT_MESSAGE = 'This round is a test. Tools are not open yet; all tools will open next round.'
const DEFAULT_REPLAY_FILE = './replay.json'

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

/**
 * Load the pre-recorded warmup output. A replay document carries the exact
 * reasoning text and the exact visible reply from the recorded warmup round.
 * Read once at mount: editing `replay.json` under a live preset requires a
 * fresh session generation (edit `agent.cordis.yml` or restart) to re-read.
 */
function loadReplay(file, logger) {
  const target = typeof file === 'string' && file.length > 0 ? file : DEFAULT_REPLAY_FILE
  const url = isAbsolute(target) ? pathToFileURL(target) : new URL(target, import.meta.url)
  try {
    const document = JSON.parse(readFileSync(url, 'utf8'))
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new TypeError('replay document must be an object')
    }
    if (typeof document.reasoning !== 'string' || document.reasoning.length === 0) {
      throw new TypeError('replay.reasoning must be a non-empty string')
    }
    if (typeof document.reply !== 'string' || document.reply.length === 0) {
      throw new TypeError('replay.reply must be a non-empty string')
    }
    return { reasoning: document.reasoning, reply: document.reply }
  } catch (error) {
    logger.warn('%s: replay disabled (%s); the warmup round falls back to the real model', name, error?.message ?? String(error))
    return undefined
  }
}

/** Build the synthetic LLM stream for one replayed warmup round. */
function replayChunks(replay) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: replay.reasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: replay.reasoning } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: replay.reply },
    { type: 'block-end', index: 1, block: { type: 'text', text: replay.reply } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Yield the recorded chunks, honoring abort like a real adapter. */
async function* replayStream(chunks, signal) {
  for (const chunk of chunks) {
    if (signal?.aborted) throw new Error('aborted')
    yield chunk
  }
}

export function apply(ctx, config) {
  const shellTools = stringList(config.shellTools, 'shellTools')
  const commonTools = stringList(config.commonTools, 'commonTools')
  const includeSubagents = config.subagents === true
  const message = typeof config.message === 'string' && config.message.length > 0 ? config.message : DEFAULT_MESSAGE
  const replay = loadReplay(config.replayFile, ctx.logger)
  const chunks = replay === undefined ? undefined : replayChunks(replay)

  /** Agents whose next assembly/pre-step must become the warmup round. */
  const pending = new WeakSet()
  /** Sessions whose next loop-built model call must replay the recorded warmup output. */
  const replaySessions = new Set()

  /** A session that has never logged a model request and is not a subagent. */
  const freshSession = (agent) => (
    !agent.session.events.some(event => event.type === 'request/header') &&
    (includeSubagents || agent.session.header.meta?.origin !== 'subagent')
  )

  // Narrow the assembled tool catalog while the warmup is pending, so the
  // warmup step's request/header carries exactly the two tools below.
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

  // Arm the warmup when the first input of a fresh session is queued.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === undefined || message === undefined || pending.has(agent)) return
    if (freshSession(agent)) pending.add(agent)
  })

  // Turn the session's very first step into the warmup round and defer the
  // real input to the next turn. `prepend` keeps this listener outside the
  // host-plane instruction and skill injections, so the replacement discards
  // them for the warmup request.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    if (!pending.has(agent)) return decision
    pending.delete(agent)
    if (decision.kind === 'reject' || messages.length === 0 || !freshSession(agent)) return decision
    // Resolve the model route up front: a warmup that cannot run must not
    // consume the real input. The replay path still runs this check so a
    // route-less deployment behaves exactly like the original preset.
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
    if (chunks !== undefined && agent.session?.id !== undefined) {
      const sid = agent.session.id
      replaySessions.add(sid)
      signal.addEventListener('abort', () => replaySessions.delete(sid), { once: true })
    }
    const warmup = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: message }], source: { kind: 'plugin', plugin: name } }
    ctx.logger.info('%s: warmup round queued as turn %d step %d; real input deferred to the next turn', name, turn, step)
    return { kind: 'enter', messages: [warmup] }
  }, { prepend: true })

  // Short-circuit the warmup round's model call with the recorded stream.
  // Not calling `next()` is the documented `llm/stream` waterfall veto: the
  // adapter (and any provider I/O) never runs. The loop still logs
  // `assistant/chunk` and `assistant/message` from the yielded chunks.
  if (chunks !== undefined) {
    ctx.on('llm/stream', (options, next) => {
      if (options.sessionId === undefined || !replaySessions.has(options.sessionId)) return next()
      replaySessions.delete(options.sessionId)
      return replayStream(chunks, options.signal)
    })
  }
}

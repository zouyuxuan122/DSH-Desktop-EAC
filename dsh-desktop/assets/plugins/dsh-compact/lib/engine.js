import { AsyncLocalStorage } from 'node:async_hooks'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import {
  compactStatus,
  getSharedConfig,
  resolvePolicy,
  routedTargetOf,
  sessionIdOf,
  toBasicResolvedConfig,
} from './policy.js'

// 输出截断类失败码：适配器把 finish reason（max_tokens/length）包装成
// request error 抛出时的 code 别名。恢复路径与上下文溢出一致——压缩后重试；
// 否则用户手动「继续」只会在同预算上继续堆上下文、必然再次截断（#54 死循环）。
const OUTPUT_TRUNCATION_CODES = new Set(['max-tokens', 'max_tokens', 'length'])

// 非溢出的 400：dsh-llm-deepseek 把 400（未命中上下文溢出文案）归类为
// INVALID_REQUEST，且不在内核可重试码里——免费/第三方服务商偶发 400 时直接
// 失败，表现为「莫名其妙 400，继续说一句才好」。此处做一轮有节制的自愈重试。
const INVALID_REQUEST_CODE = 'INVALID_REQUEST'

function isOverflowCode(code) {
  return code === CONTEXT_WINDOW_EXCEEDED_CODE || OUTPUT_TRUNCATION_CODES.has(code)
}

/** 失败摘要（日志脱敏用）：最多保留 300 字符的 cause 文本。 */
function failureSummary(failure) {
  const cause = failure?.cause
  let text = ''
  if (cause instanceof Error) text = cause.message
  else if (typeof cause === 'string') text = cause
  else if (cause !== null && typeof cause === 'object' && typeof cause.constructor?.name === 'string') text = cause.constructor.name
  const trimmed = String(text || failure?.code || 'unknown').replace(/\s+/g, ' ').trim()
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}

/** 溢出误报判定（纯函数，可单测）：实测 tokens 远低于窗口一半 → 疑似供应商误报。 */
export function falseOverflowGuard({ total, context }) {
  if (!Number.isFinite(total) || !Number.isFinite(context) || context <= 0) return false
  return total < context * 0.5
}

function publishStatus(ctx, sessionId, patch) {
  const status = compactStatus.set(sessionId, patch)
  try { ctx.emit?.('dsh-compact/status', status) } catch {}
  return status
}

function logResult(ctx, result, trigger) {
  ctx.logger?.info?.(
    `dsh-compact (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
      + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`,
  )
}

const EMPTY_SUMMARY_ERROR = 'summarization produced no text summary content'

export async function summarizeWithToolFreeFallback(summarize, input, onRetry = () => {}) {
  try {
    return await summarize(input)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== EMPTY_SUMMARY_ERROR) throw error
    onRetry(error)
    const { system: _system, tools: _tools, ...fallbackInput } = input
    return summarize(fallbackInput)
  }
}

// 自动压缩冷却：两次 pre-step 自动压缩之间，会话必须已有新的持久化进展
// （surface.replaceGeneration 增长，即压缩后的检查点之外又产生了输出）且至少
// 间隔 minGapMs。否则跳过 —— 阻断同一步 forced+pressure 双压与跨轮把刚生成
// 的摘要立即再压掉的复压循环（频繁压缩 → 摘要连摘要 → 质量劣化）。
const MIN_COMPACTION_GAP_MS = 15_000

export function compactionGapOk(last, generation, timestamp, minGapMs) {
  return last === undefined || (generation > last.generation && timestamp - last.at >= minGapMs)
}

export function registerAutomaticCompaction(ctx, engine, cfg = {}) {
  const { now = () => Date.now(), minGapMs = MIN_COMPACTION_GAP_MS } = cfg
  const overflowRetries = new WeakMap()
  const overflowAgents = new WeakMap()
  const lastCompaction = new WeakMap()
  // 400 自愈状态：每会话 60s 内最多 2 次瞬态重试；且必须有过成功轮次。
  const transientRetries = new WeakMap()
  const sessionHadSuccess = new WeakMap()

  function transientRetryOk(session) {
    const timestamps = (transientRetries.get(session) ?? []).filter((t) => now() - t < 60_000)
    if (timestamps.length >= 2) return false
    timestamps.push(now())
    transientRetries.set(session, timestamps)
    return true
  }

  async function overflowProbe(agent) {
    try {
      const target = routedTargetOf(agent)
      if (!target || !target.provider || !target.model) return null
      const info = await ctx.llm.resolveModelInfo(target.provider, target.model, undefined)
      const context = info ? info.context : undefined
      if (!Number.isFinite(context) || context <= 0) return null
      const measurement = ctx.tokenMeter?.measure?.(agent.session)
      if (!measurement) return null
      return {
        context,
        total: Number.isFinite(measurement.totalTokens) ? measurement.totalTokens : undefined,
        baseline: measurement.baseline?.kind,
      }
    } catch {
      return null
    }
  }

  const offPreStep = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal.aborted || !engine.policyFor(agent).enabled) return next()
    try {
      // 输出截断（max-tokens/length finish）不再触发强制压缩：截断≠上下文满。
      // 旧实现（#54 时代）会在截断后的首个 pre-step 以保留 0 的全量压缩把整段
      // 历史换成一个摘要；频繁截断时每轮都烧历史 → 摘要连摘要、质量劣化。
      // 是否压缩完全交给 pressure 阈值（thresholdRatio × contextWindow）与
      // retainRatio 决定；真实上下文溢出仍由 agent/request-error 恢复路径兜底。
      const generation = agent?.session?.surface?.replaceGeneration ?? 0
      const last = lastCompaction.get(agent)
      if (!compactionGapOk(last, generation, now(), minGapMs)) return next()
      const result = await engine.compactIfNeeded(agent, 'pressure', signal)
      if (result !== null) {
        // 记录压缩完成后的代际：压缩检查点本身会造成一次 replaceGeneration
        // 增长，下一次压缩必须再次等到新输出落盘且冷却期满。
        lastCompaction.set(agent, {
          at: now(),
          generation: agent?.session?.surface?.replaceGeneration ?? generation,
        })
        logResult(ctx, result, 'step pressure')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-compact step compaction failed: ${message}; continuing the turn`)
    }
    return next()
  })

  const offStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') overflowRetries.delete(agent)
    if (status === 'idle') transientRetries.delete(agent.session)
  })

  const offSessionEvent = ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      const agent = overflowAgents.get(session)
      if (agent !== undefined) overflowRetries.delete(agent)
      // 一次成功的 assistant 输出 = 该会话请求形态被供应商接受过，
      // 之后的 INVALID_REQUEST 更可能是瞬态，允许自愈重试。
      sessionHadSuccess.set(session, true)
    }
  })

  const offSessionDisposed = ctx.on('session/disposed', (session) => {
    compactStatus.clear(session?.id)
    sessionHadSuccess.delete(session)
    transientRetries.delete(session)
  })

  const offRequestError = ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (signal.aborted) return next()
    const policy = engine.policyFor(agent)
    if (!policy.enabled) return next()
    const code = failure?.code
    // ── 瞬态 400 自愈：INVALID_REQUEST 且会话此前成功过 → 原样重试一次
    //   （节奏受限：60s 内最多 2 次）。这自动复现「继续说一句才好」。
    if (code === INVALID_REQUEST_CODE && policy.retryTransientBadRequest !== false) {
      const session = agent.session
      if (sessionHadSuccess.get(session) === true && transientRetryOk(session)) {
        ctx.logger?.warn?.(
          `dsh-compact transient 400 self-heal: retrying once (code=${code}, prior success in session; detail: ${failureSummary(failure)})`,
        )
        return { kind: 'retry' }
      }
    }
    if (!isOverflowCode(code)) return next()
    if (!policy.recoverOnOverflow || policy.maxOverflowRetries === 0) return next()
    overflowAgents.set(agent.session, agent)
    const retries = overflowRetries.get(agent) ?? 0
    if (retries >= policy.maxOverflowRetries) return next()
    // ── 溢出误报护栏：供应商报 CONTEXT_WINDOW_EXCEEDED，但实测 tokens 远低于
    //   contextWindow 一半时，判定为供应商侧误报——不压缩、不重试，原样保留
    //   原始错误（否则免费服务商上一次 400 就把整个会话历史无谓压掉一次）。
    if (code === CONTEXT_WINDOW_EXCEEDED_CODE) {
      const probe = await overflowProbe(agent)
      if (probe && probe.total !== undefined) {
        if (falseOverflowGuard(probe)) {
          ctx.logger?.warn?.(
            `dsh-compact overflow guard: provider reported context overflow but measured tokens are far below the window (~${probe.total} of ${probe.context}, baseline=${probe.baseline ?? '?'}); treating as provider-side error, skipping compaction (detail: ${failureSummary(failure)})`,
          )
          return next()
        }
      }
    }
    const generation = agent.session.surface.replaceGeneration
    let result
    try {
      result = await engine.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
        ctx.logger?.warn?.(
          `dsh-compact overflow recovery failed after durable progress: ${message}; retrying from replacement surface`,
        )
        overflowRetries.set(agent, retries + 1)
        return { kind: 'retry' }
      }
      ctx.logger?.warn?.(
        `dsh-compact overflow recovery failed: ${message}; preserving the original request error`,
      )
      return next()
    }
    if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
    if (result !== null) logResult(ctx, result, code === CONTEXT_WINDOW_EXCEEDED_CODE ? 'context overflow recovery' : 'output overflow recovery')
    overflowRetries.set(agent, retries + 1)
    return { kind: 'retry' }
  })

  return () => {
    offPreStep?.()
    offStatus?.()
    offSessionEvent?.()
    offSessionDisposed?.()
    offRequestError?.()
  }
}

export class DshCompactEngine extends BasicCompactionEngine {
  static inject = BasicCompactionEngine.inject
  static Config = BasicCompactionEngine.Config

  constructor(ctx, config = {}) {
    const initial = toBasicResolvedConfig({ ...getSharedConfig(), ...config })
    super(ctx, initial)
    this.dshCompact = true
    this.entryConfig = { ...config }
    this.policyStorage = new AsyncLocalStorage()
    const fallbackConfig = this.config
    Object.defineProperty(this, 'config', {
      configurable: false,
      enumerable: true,
      get: () => this.policyStorage.getStore() ?? fallbackConfig,
    })
    const disposeHooks = registerAutomaticCompaction(ctx, this)
    ctx.effect?.(() => disposeHooks, 'dsh-compact: automatic request-path compaction')
  }

  currentConfig() {
    return { ...getSharedConfig(), ...this.entryConfig }
  }

  policyFor(agent) {
    return resolvePolicy(this.currentConfig(), routedTargetOf(agent))
  }

  summarize(input, agent, signal) {
    return summarizeWithToolFreeFallback(
      (nextInput) => super.summarize(nextInput, agent, signal),
      input,
      () => this.ctx.logger?.warn?.(
        'dsh-compact summary returned no text; retrying once without the agent system prompt and tools',
      ),
    )
  }

  async withPolicySnapshot(agent, trigger, operation) {
    const sessionId = sessionIdOf(agent)
    const config = this.currentConfig()
    const policy = resolvePolicy(config, routedTargetOf(agent))
    if (trigger !== 'manual' && !policy.enabled) return null
    if (trigger === 'context-overflow' && !policy.recoverOnOverflow) return null
    publishStatus(this.ctx, sessionId, {
      state: 'measuring',
      active: true,
      trigger,
      error: null,
      policy,
    })
    try {
      const result = await this.policyStorage.run(toBasicResolvedConfig(config), operation)
      if (result === null) {
        publishStatus(this.ctx, sessionId, {
          state: 'idle',
          active: false,
          trigger,
          outcome: 'no-range',
        })
        return null
      }
      publishStatus(this.ctx, sessionId, {
        state: trigger === 'context-overflow' ? 'recovered' : 'idle',
        active: false,
        trigger,
        outcome: 'compacted',
        lastCompactedAt: new Date().toISOString(),
        shadowedTokenCount: result.shadowedTokenCount,
        shadowedNodes: result.shadowedSeqs.length,
      })
      return result
    } catch (error) {
      publishStatus(this.ctx, sessionId, {
        state: 'failed',
        active: false,
        trigger,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  compactIfNeeded(agent, trigger, signal) {
    return this.withPolicySnapshot(
      agent,
      trigger,
      () => super.compactIfNeeded(agent, trigger, signal),
    )
  }

  compactNow(agent, signal, sourceCommandId) {
    return this.withPolicySnapshot(
      agent,
      'manual',
      () => super.compactNow(agent, signal, sourceCommandId),
    )
  }
}

export const name = 'dsh-compact-engine'
export default DshCompactEngine

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

export function registerAutomaticCompaction(ctx, engine) {
  const overflowRetries = new WeakMap()
  const overflowAgents = new WeakMap()

  const offPreStep = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal.aborted || !engine.policyFor(agent).enabled) return next()
    try {
      const result = await engine.compactIfNeeded(agent, 'pressure', signal)
      if (result !== null) logResult(ctx, result, 'step pressure')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-compact step compaction failed: ${message}; continuing the turn`)
    }
    return next()
  })

  const offStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') overflowRetries.delete(agent)
  })

  const offSessionEvent = ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const agent = overflowAgents.get(session)
    if (agent !== undefined) overflowRetries.delete(agent)
  })

  const offSessionDisposed = ctx.on('session/disposed', (session) => {
    compactStatus.clear(session?.id)
  })

  const offRequestError = ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
    const policy = engine.policyFor(agent)
    if (!policy.enabled || !policy.recoverOnOverflow || policy.maxOverflowRetries === 0) return next()
    overflowAgents.set(agent.session, agent)
    const retries = overflowRetries.get(agent) ?? 0
    if (retries >= policy.maxOverflowRetries) return next()
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
    if (result !== null) logResult(ctx, result, 'context overflow recovery')
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

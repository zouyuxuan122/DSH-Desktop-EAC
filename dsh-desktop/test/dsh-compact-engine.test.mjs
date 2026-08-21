import test from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { registerAutomaticCompaction } from '../assets/plugins/dsh-compact/lib/engine.js'

function harness(policy = {}) {
  const handlers = new Map()
  const logs = []
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
  }
  const calls = []
  const engine = {
    policyFor: () => ({
      enabled: true,
      recoverOnOverflow: true,
      maxOverflowRetries: 1,
      ...policy,
    }),
    async compactIfNeeded(agent, trigger, signal) {
      calls.push({ agent, trigger, signal })
      return null
    },
  }
  const dispose = registerAutomaticCompaction(ctx, engine)
  return { calls, dispose, engine, handlers, logs }
}

function fakeAgent() {
  return {
    id: 's1',
    session: {
      surface: { replaceGeneration: 0 },
    },
  }
}

test('dsh-compact engine hooks: disabled policy skips request-path compaction', async () => {
  const t = harness({ enabled: false })
  let nextCalls = 0
  const agent = fakeAgent()
  await t.handlers.get('agent/pre-step')(
    { agent, signal: new AbortController().signal },
    () => { nextCalls += 1 },
  )
  assert.equal(t.calls.length, 0)
  assert.equal(nextCalls, 1)
  t.dispose()
})

test('dsh-compact engine hooks: pressure failures never abort the user turn', async () => {
  const t = harness()
  t.engine.compactIfNeeded = async () => { throw new Error('summary failed') }
  let nextCalls = 0
  await t.handlers.get('agent/pre-step')(
    { agent: fakeAgent(), signal: new AbortController().signal },
    () => { nextCalls += 1 },
  )
  assert.equal(nextCalls, 1)
  assert.match(t.logs[0][1], /continuing the turn/)
})

test('dsh-compact engine hooks: overflow retries the original request at most once', async () => {
  const t = harness()
  const agent = fakeAgent()
  t.engine.compactIfNeeded = async () => {
    agent.session.surface.replaceGeneration += 1
    return {
      shadowedSeqs: [1],
      shadowedRange: { start: 1, end: 1 },
      shadowedTokenCount: 10,
    }
  }
  let nextCalls = 0
  const payload = {
    agent,
    failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    signal: new AbortController().signal,
  }
  assert.deepEqual(
    await t.handlers.get('agent/request-error')(payload, () => { nextCalls += 1 }),
    { kind: 'retry' },
  )
  assert.equal(await t.handlers.get('agent/request-error')(payload, () => { nextCalls += 1 }), undefined)
  assert.equal(nextCalls, 1)
  assert.equal(t.calls.length, 0)
})

test('dsh-compact engine hooks: no durable replacement preserves original overflow', async () => {
  const t = harness()
  const agent = fakeAgent()
  let nextCalls = 0
  const result = await t.handlers.get('agent/request-error')({
    agent,
    failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    signal: new AbortController().signal,
  }, () => { nextCalls += 1 })
  assert.equal(result, undefined)
  assert.equal(nextCalls, 1)
})

test('dsh-compact engine hooks: aborted overflow is never retried', async () => {
  const t = harness()
  const controller = new AbortController()
  controller.abort()
  let nextCalls = 0
  await t.handlers.get('agent/request-error')({
    agent: fakeAgent(),
    failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    signal: controller.signal,
  }, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)
})

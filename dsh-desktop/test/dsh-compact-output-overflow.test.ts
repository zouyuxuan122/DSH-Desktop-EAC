import test from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import {
  registerAutomaticCompaction,
} from '../assets/plugins/dsh-compact/lib/engine.js'

function harness(policy = {}, cfg = {}) {
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
  const dispose = registerAutomaticCompaction(ctx, engine, cfg)
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

// #54 防御路径：个别适配器可能把输出截断包装成 request-error 抛出
// （正常链路截断是成功流 + finish kind，走下方 turn/end 路径）。
test('dsh-compact engine: max-tokens output overflow retries like context overflow', async () => {
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
  const payload = {
    agent,
    failure: { code: 'max-tokens' },
    signal: new AbortController().signal,
  }
  const result = await t.handlers.get('agent/request-error')(payload, () => {})
  assert.deepEqual(result, { kind: 'retry' }, 'max-tokens should retry after compaction')
  t.dispose()
})

test('dsh-compact engine: length failure code also retries (adapter alias)', async () => {
  const t = harness()
  const agent = fakeAgent()
  t.engine.compactIfNeeded = async () => {
    agent.session.surface.replaceGeneration += 1
    return { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 }, shadowedTokenCount: 10 }
  }
  const payload = { agent, failure: { code: 'length' }, signal: new AbortController().signal }
  const result = await t.handlers.get('agent/request-error')(payload, () => {})
  assert.deepEqual(result, { kind: 'retry' }, 'length should also retry')
  t.dispose()
})

test('dsh-compact engine: max-tokens respects maxOverflowRetries=0 (no retry)', async () => {
  const t = harness({ maxOverflowRetries: 0 })
  const agent = fakeAgent()
  let nextCalls = 0
  const payload = { agent, failure: { code: 'max-tokens' }, signal: new AbortController().signal }
  const result = await t.handlers.get('agent/request-error')(payload, () => { nextCalls += 1 })
  assert.equal(result, undefined)
  assert.equal(nextCalls, 1)
  t.dispose()
})

// 截断不再强制保留 0 的全量压缩：截断≠上下文满（#54 时代的 pre-step 会在
// 截断后的首步先用 context-overflow 把整段历史换成一个摘要，频繁截断时每轮
// 都烧 → 摘要连摘要、质量劣化）。压缩与否完全交给 pressure 阈值决定。
test('dsh-compact engine: output truncation alone never forces compaction', async () => {
  const t = harness()
  const agent = fakeAgent()
  t.handlers.get('session/event')(agent.session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  const triggers = []
  t.engine.compactIfNeeded = async (a, trigger) => { triggers.push(trigger); return null }
  await t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})
  assert.deepEqual(triggers, ['pressure'],
    'below-threshold run only attempts pressure, never the context-overflow forced path')
  assert.equal(t.logs.some(([, message]) => message.includes('step pressure')), false,
    'null result → no compaction committed')
  t.dispose()
})

test('dsh-compact engine: truncation with real pressure compacts once via the pressure path', async () => {
  const t = harness()
  const agent = fakeAgent()
  t.handlers.get('session/event')(agent.session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  const triggers = []
  t.engine.compactIfNeeded = async (a, trigger) => {
    triggers.push(trigger)
    agent.session.surface.replaceGeneration += 1
    return { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 }, shadowedTokenCount: 10 }
  }
  await t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})
  assert.deepEqual(triggers, ['pressure'], 'compaction runs through the threshold path, never retain-0')
  assert.equal(t.logs.some(([, message]) => message.includes('step pressure')), true)
  t.dispose()
})

test('dsh-compact engine: cooldown suppresses immediate re-compaction on the same surface', async () => {
  let fakeNow = 0
  const t = harness({}, { now: () => fakeNow, minGapMs: 15_000 })
  const agent = fakeAgent()
  let calls = 0
  t.engine.compactIfNeeded = async () => {
    calls += 1
    agent.session.surface.replaceGeneration += 1
    return { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 }, shadowedTokenCount: 10 }
  }
  const runPreStep = () => t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})
  await runPreStep()
  assert.equal(calls, 1)
  await runPreStep()
  assert.equal(calls, 1, 'same generation within the gap must not compact again')
  t.dispose()
})

test('dsh-compact engine: a new assistant generation past the gap allows compaction again', async () => {
  let fakeNow = 0
  const t = harness({}, { now: () => fakeNow, minGapMs: 15_000 })
  const agent = fakeAgent()
  let calls = 0
  t.engine.compactIfNeeded = async () => {
    calls += 1
    agent.session.surface.replaceGeneration += 1
    return { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 }, shadowedTokenCount: 10 }
  }
  const runPreStep = () => t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})
  await runPreStep()
  assert.equal(calls, 1)
  agent.session.surface.replaceGeneration += 1 // 新一轮输出落盘
  fakeNow += 16_000
  await runPreStep()
  assert.equal(calls, 2, 'new generation after the gap is pressure-checked again')
  t.dispose()
})

test('dsh-compact engine: real overflow recovery bypasses the auto cooldown', async () => {
  let fakeNow = 0
  const t = harness({}, { now: () => fakeNow, minGapMs: 15_000 })
  const agent = fakeAgent()
  t.engine.compactIfNeeded = async () => {
    agent.session.surface.replaceGeneration += 1
    return { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 }, shadowedTokenCount: 10 }
  }
  await t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})
  const result = await t.handlers.get('agent/request-error')({
    agent,
    failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    signal: new AbortController().signal,
  }, () => {})
  assert.deepEqual(result, { kind: 'retry' },
    'context overflow must compact-and-retry even right after an auto compaction')
  t.dispose()
})

test('dsh-compact engine: normal turn end still pressure-checks without any extra trigger', async () => {
  const t = harness()
  const agent = fakeAgent()
  const session = agent.session
  t.handlers.get('session/event')(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  t.handlers.get('session/event')(session, { type: 'assistant/message', data: { message: { role: 'assistant' } } })
  const triggers = []
  t.engine.compactIfNeeded = async (a, trigger) => { triggers.push(trigger); return null }
  await t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})
  assert.deepEqual(triggers, ['pressure'])
  t.dispose()
})

test('dsh-compact engine: pre-step compaction failure never aborts the user turn', async () => {
  const t = harness()
  const agent = fakeAgent()
  t.handlers.get('session/event')(agent.session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  let nextCalls = 0
  t.engine.compactIfNeeded = async () => { throw new Error('summary failed') }
  await t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)
  assert.match(t.logs.find(([level]) => level === 'warn')?.[1] ?? '', /continuing the turn/)
  t.dispose()
})

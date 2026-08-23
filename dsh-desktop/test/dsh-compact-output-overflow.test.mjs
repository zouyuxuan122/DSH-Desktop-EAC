import test from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import {
  registerAutomaticCompaction,
} from '../assets/plugins/dsh-compact/lib/engine.js'

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

// #54 主路径：真实持久化信号是 turn/end 的 data.reason.kind（官方
// 「已达到输出 token 上限」提示读同一字段）。用户发「继续」开启新 turn，
// pre-step 必须先压缩再放行请求。
test('dsh-compact engine: turn/end max-tokens forces compaction on next pre-step', async () => {
  const t = harness()
  const agent = fakeAgent()
  const session = agent.session
  // 真实事件形状（见 dsh-goal-round-driver / dsh-client-ui-conversation）
  t.handlers.get('session/event')(session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  const triggers = []
  t.engine.compactIfNeeded = async (a, trigger) => { triggers.push(trigger); return null }
  await t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})
  assert.deepEqual(triggers, ['context-overflow', 'pressure'],
    'should force context-overflow compaction first, then normal pressure check')
  t.dispose()
})

test('dsh-compact engine: forced output-overflow compaction fires only once per truncation', async () => {
  const t = harness()
  const agent = fakeAgent()
  const session = agent.session
  t.handlers.get('session/event')(session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  const triggers = []
  t.engine.compactIfNeeded = async (a, trigger) => { triggers.push(trigger); return null }
  const runPreStep = () => t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})
  await runPreStep()
  await runPreStep()
  assert.equal(triggers.filter((x) => x === 'context-overflow').length, 1,
    'flag must be consumed so later steps do not re-force')
  t.dispose()
})

test('dsh-compact engine: normal turn end does not force extra compaction', async () => {
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

test('dsh-compact engine: forced compaction failure never aborts the user turn', async () => {
  const t = harness()
  const agent = fakeAgent()
  const session = agent.session
  t.handlers.get('session/event')(session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  let nextCalls = 0
  t.engine.compactIfNeeded = async (a, trigger) => {
    if (trigger === 'context-overflow') throw new Error('summary failed')
    return null
  }
  await t.handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)
  assert.match(t.logs.find(([level]) => level === 'warn')?.[1] ?? '', /output overflow/)
  t.dispose()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import {
  falseOverflowGuard,
  registerAutomaticCompaction,
} from '../assets/plugins/dsh-compact/lib/engine.js'

// ---------------------------------------------------------------------------
// 5.1.1 新增请求路径护栏的单元测试：
//   1) falseOverflowGuard —— 溢出误报判定（纯函数）
//   2) request-error 集成：护栏拦截误报、放行真实溢出、瞬态 400 自愈
// ---------------------------------------------------------------------------

function fakeSession({ messages = undefined } = {}) {
  return {
    surface: { replaceGeneration: 0 },
    deriveMessages() {
      return messages ?? []
    },
  }
}

function fakeAgent(session, options = { provider: 'openai', model: 'gpt-x' }) {
  return { id: 's1', options, session }
}

function harness({ policy = {}, llm = {}, meter = {}, logs = [] } = {}) {
  const handlers = new Map()
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    logger: { info: () => {}, warn: (message) => logs.push(message) },
    llm: {
      resolveModelInfo: async (provider, model) => llm,
    },
    tokenMeter: {
      measure: (session) => ({ ...meter, totalTokens: meter.totalTokens ?? 0 }),
    },
  }
  const calls = []
  const engine = {
    policyFor: () => ({
      enabled: true,
      recoverOnOverflow: true,
      maxOverflowRetries: 1,
      retryTransientBadRequest: true,
      thresholdRatio: 0.75,
      ...policy,
    }),
    async compactIfNeeded(agent, trigger, signal) {
      calls.push({ agent, trigger })
      // 真实内核压缩会持久化地增长 surface.replaceGeneration（压缩检查点），
      // 恢复路径据此判断「压缩产生了新表面」才允许 retry。
      if (agent?.session?.surface && typeof agent.session.surface.replaceGeneration === 'number') {
        agent.session.surface.replaceGeneration += 1
      }
      return { shadowedSeqs: [], shadowedRange: { start: 0, end: 1 }, shadowedTokenCount: 1 }
    },
  }
  const dispose = registerAutomaticCompaction(ctx, engine)
  return { calls, dispose, engine, handlers, ctx }
}

test('falseOverflowGuard: 实测远低于窗口一半 → 判误报', () => {
  assert.equal(falseOverflowGuard({ total: 10_000, context: 262_144 }), true)
  assert.equal(falseOverflowGuard({ total: 100_000, context: 262_144 }), true)
  assert.equal(falseOverflowGuard({ total: 200_000, context: 262_144 }), false)
  assert.equal(falseOverflowGuard({ total: undefined, context: 262_144 }), false)
  assert.equal(falseOverflowGuard({ total: 10, context: 0 }), false)
  assert.equal(falseOverflowGuard({ total: 10, context: NaN }), false)
})

test('request-error: 溢出误报护栏拦截（低实测 tokens → 不压缩、不透传 retry）', async () => {
  const logs = []
  const t = harness({
    logs,
    llm: { context: 262_144 },
    meter: { totalTokens: 20_000, baseline: { kind: 'usage' } },
  })
  let nextCalls = 0
  const agent = fakeAgent(fakeSession())
  const handler = t.handlers.get('agent/request-error')
  await handler(
    { agent, failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal: new AbortController().signal },
    () => { nextCalls += 1 },
  )
  assert.equal(t.calls.length, 0)
  assert.equal(nextCalls, 1)
  assert.ok(logs.some((message) => message.includes('overflow guard')))
  t.dispose()
})

test('request-error: 真实溢出（实测接近窗口）→ 压缩并 retry', async () => {
  const t = harness({
    llm: { context: 262_144 },
    meter: { totalTokens: 240_000, baseline: { kind: 'usage' } },
  })
  let nextCalls = 0
  const agent = fakeAgent(fakeSession())
  const result = await t.handlers.get('agent/request-error')(
    { agent, failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal: new AbortController().signal },
    () => { nextCalls += 1 },
  )
  assert.equal(t.calls.length, 1)
  assert.equal(t.calls[0].trigger, 'context-overflow')
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(nextCalls, 0)
  t.dispose()
})

test('request-error: 瞬态 400 自愈（此前成功过 → 直接 retry 一次，不压缩）', async () => {
  const logs = []
  const t = harness({ logs })
  const session = fakeSession()
  const agent = fakeAgent(session)
  // 模拟一次成功回答：session/event 标定 sessionHadSuccess。
  const sessionHandler = t.handlers.get('session/event')
  sessionHandler(session, { type: 'assistant/message' })
  const result = await t.handlers.get('agent/request-error')(
    { agent, failure: { code: 'INVALID_REQUEST' }, signal: new AbortController().signal },
    () => {},
  )
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(t.calls.length, 0, '瞬态 400 不得触发压缩')
  assert.ok(logs.some((message) => message.includes('transient 400 self-heal')))
  t.dispose()
})

test('request-error: 会话从未成功过 → 400 不盲目重试（防配置错误双重计费）', async () => {
  const t = harness()
  const agent = fakeAgent(fakeSession())
  let nextCalls = 0
  await t.handlers.get('agent/request-error')(
    { agent, failure: { code: 'INVALID_REQUEST' }, signal: new AbortController().signal },
    () => { nextCalls += 1 },
  )
  assert.equal(nextCalls, 1)
  assert.equal(t.calls.length, 0)
  t.dispose()
})

test('request-error: 政策关闭 retryTransientBadRequest → 400 直接透传', async () => {
  const t = harness({ policy: { retryTransientBadRequest: false } })
  const session = fakeSession()
  const agent = fakeAgent(session)
  const sessionHandler = t.handlers.get('session/event')
  sessionHandler(session, { type: 'assistant/message' })
  let nextCalls = 0
  await t.handlers.get('agent/request-error')(
    { agent, failure: { code: 'INVALID_REQUEST' }, signal: new AbortController().signal },
    () => { nextCalls += 1 },
  )
  assert.equal(nextCalls, 1)
  t.dispose()
})

test('request-error: 同一会话 60s 内最多 2 次瞬态重试', async () => {
  const t = harness()
  const session = fakeSession()
  const agent = fakeAgent(session)
  const sessionHandler = t.handlers.get('session/event')
  sessionHandler(session, { type: 'assistant/message' })
  const fire = () => t.handlers.get('agent/request-error')(
    { agent, failure: { code: 'INVALID_REQUEST' }, signal: new AbortController().signal },
    () => {},
  )
  assert.deepEqual(await fire(), { kind: 'retry' })
  assert.deepEqual(await fire(), { kind: 'retry' })
  // 第 3 次超限 → 透传（无 retry）。
  let nextCalls = 0
  await t.handlers.get('agent/request-error')(
    { agent, failure: { code: 'INVALID_REQUEST' }, signal: new AbortController().signal },
    () => { nextCalls += 1 },
  )
  assert.equal(nextCalls, 1)
  t.dispose()
})
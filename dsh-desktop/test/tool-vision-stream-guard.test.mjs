import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachRequestGuard } from '../assets/plugins/dsh-tool-vision/index.js';

// 回归：requestGuard 的 llm/stream 监听器曾写成 async 函数 —— 返回 Promise，
// 上游 waterfall 对其 yield* 时整个 turn 以
// "yield* (intermediate value) is not async iterable" 崩溃（发消息必现）。
// 监听器必须同步返回 async generator（流），桥接逻辑在生成器内部进行。

function makeCtx() {
  const listeners = {};
  return {
    listeners,
    ctx: {
      on: (type, fn) => { listeners[type] = fn; },
      logger: { info() {}, warn() {} },
    },
  };
}

function textMsg(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

test('llm/stream guard listener returns an async iterable, not a Promise', async () => {
  const { listeners, ctx } = makeCtx();
  attachRequestGuard(ctx, () => ({ requestGuard: true, multimodalModels: ['good-model'] }), '/tmp/no');
  const listener = listeners['llm/stream'];
  assert.ok(listener, 'guard must register an llm/stream listener');

  const result = listener(
    { model: 'good-model', messages: [textMsg('hi')] },
    () => (async function* () { yield { type: 'text', text: 'ok' }; })(),
  );
  assert.equal(typeof result?.then, 'undefined', 'listener must NOT return a Promise');
  assert.equal(typeof result?.[Symbol.asyncIterator], 'function', 'listener must return an async iterable');
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.deepEqual(chunks, [{ type: 'text', text: 'ok' }]);
});

test('downstream errors propagate without starting a second stream', async () => {
  const { listeners, ctx } = makeCtx();
  attachRequestGuard(ctx, () => ({ requestGuard: true, multimodalModels: ['good-model'] }), '/tmp/no');
  const listener = listeners['llm/stream'];

  let nextCalls = 0;
  const next = () => {
    nextCalls++;
    return (async function* () {
      yield { type: 'text', text: 'partial' };
      throw new Error('boom-from-provider');
    })();
  };
  const stream = listener({ model: 'good-model', messages: [textMsg('hi')] }, next);
  const seen = [];
  await assert.rejects(
    (async () => { for await (const c of stream) seen.push(c); })(),
    /boom-from-provider/,
  );
  assert.deepEqual(seen, [{ type: 'text', text: 'partial' }]);
  assert.equal(nextCalls, 1, 'a downstream failure must not re-invoke next()');
});

// Tests for the AI auto-repair loop (runAutoRepair) — 一键「AI 自动修复」引擎。
// 覆盖：自动执行低/中风险建议并跳过 high-risk、迭代重试、无进展兜底回滚、
// 诊断/AI 失败降级。全部副作用注入，纯逻辑可测。

import { test } from 'node:test';
import assert from 'node:assert';
import { runAutoRepair } from '../rescue-agent.js';

function okDiag() {
  return { ok: true, payload: { env: { appVersion: '4.6.0' } } };
}

test('runAutoRepair：自动执行低/中风险建议，high-risk 自动跳过，重试成功', async () => {
  const executed = [];
  const r = await runAutoRepair({
    maxRounds: 2,
    diagnose: async () => okDiag(),
    analyze: async () => ({
      ok: true,
      analysis: 'settings.yaml 损坏',
      suggestions: [
        { action: 'edit-file', params: { file: 'settings.yaml', ops: [{ op: 'replace-line', anchor: 'bad:', with: 'good: 1' }] }, reason: '修配置', risk: 'medium' },
        { action: 'remove', params: { pluginId: 'dsh-x' }, reason: '高危', risk: 'high' },
      ],
    }),
    execute: async (s) => { executed.push(s.action); return { ok: true, result: 'done', restartRequired: true }; },
    retry: async () => ({ ok: true }),
    fallback: async () => ({ ok: true }),
  });
  assert.equal(r.ok, true, '重试成功即整体成功');
  assert.equal(r.rounds.length, 1);
  assert.deepEqual(executed, ['edit-file'], 'high-risk remove 不应被执行');
  assert.ok(r.rounds[0].applied.some((a) => a.action === 'remove' && a.skipped === 'high-risk'));
  assert.equal(r.rounds[0].retryOk, true);
});

test('runAutoRepair：首轮有进展但重试失败，第二轮修复后成功', async () => {
  const executed = [];
  let round = 0;
  const r = await runAutoRepair({
    maxRounds: 2,
    diagnose: async () => okDiag(),
    analyze: async () => {
      round += 1;
      return {
        ok: true,
        analysis: 'round ' + round,
        suggestions: round === 1
          ? [{ action: 'edit-file', params: { file: 'settings.yaml', ops: [{ op: 'delete-line', anchor: 'bad:' }] }, reason: 'r', risk: 'medium' }]
          : [{ action: 'disable', params: { pluginId: 'dsh-x' }, reason: 'r', risk: 'low' }],
      };
    },
    execute: async (s) => { executed.push(s.action); return { ok: true, result: 'done', restartRequired: true }; },
    retry: async () => ({ ok: round > 1 }),
    fallback: async () => ({ ok: true, rolledBack: true }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.rounds.length, 2);
  assert.deepEqual(executed, ['edit-file', 'disable']);
  assert.equal(r.rounds[0].retryOk, false);
  assert.equal(r.rounds[1].retryOk, true);
});

test('runAutoRepair：无任何进展时不做无谓重试，直接兜底回滚+安全模式', async () => {
  let fallbackCalls = 0;
  let retryCalls = 0;
  const r = await runAutoRepair({
    maxRounds: 2,
    diagnose: async () => okDiag(),
    analyze: async () => ({ ok: true, analysis: '无法确定', suggestions: [] }),
    execute: async () => ({ ok: false, error: 'no-op' }),
    retry: async () => { retryCalls += 1; return { ok: false }; },
    fallback: async () => { fallbackCalls += 1; return { ok: true, rolledBack: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback.rolledBack, true);
  assert.equal(fallbackCalls, 1);
  assert.equal(retryCalls, 0, '无进展不得触发重试');
});

test('runAutoRepair：有进展但重试失败且无更多轮次 → 兜底', async () => {
  const r = await runAutoRepair({
    maxRounds: 1,
    diagnose: async () => okDiag(),
    analyze: async () => ({
      ok: true,
      analysis: 'a',
      suggestions: [{ action: 'repair', params: {}, reason: 'r', risk: 'medium' }],
    }),
    execute: async () => ({ ok: true, result: 'applied', restartRequired: true }),
    retry: async () => ({ ok: false }),
    fallback: async () => ({ ok: true, rolledBack: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback.rolledBack, true);
});

test('runAutoRepair：诊断收集失败 → 直接失败，不执行任何动作', async () => {
  let executed = 0;
  const r = await runAutoRepair({
    diagnose: async () => ({ ok: false, error: 'collect fail' }),
    analyze: async () => ({ ok: true, suggestions: [] }),
    execute: async () => { executed += 1; return { ok: true }; },
    retry: async () => ({ ok: true }),
    fallback: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /collect fail/);
  assert.equal(executed, 0);
});

test('runAutoRepair：AI 诊断失败 → 失败并说明，不执行', async () => {
  const r = await runAutoRepair({
    diagnose: async () => okDiag(),
    analyze: async () => ({ ok: false, error: 'no-key' }),
    execute: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    fallback: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no-key/);
});

test('runAutoRepair：执行器抛错按单条失败记录，不中断整轮', async () => {
  const r = await runAutoRepair({
    diagnose: async () => okDiag(),
    analyze: async () => ({
      ok: true,
      analysis: 'a',
      suggestions: [
        { action: 'repair', params: {}, reason: 'r', risk: 'low' },
        { action: 'retry', params: {}, reason: 'r', risk: 'low' },
      ],
    }),
    execute: async (s) => { if (s.action === 'repair') throw new Error('boom'); return { ok: true, result: 'ok' }; },
    retry: async () => ({ ok: true }),
    fallback: async () => ({ ok: true }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.rounds[0].applied[0].ok, false);
  assert.match(String(r.rounds[0].applied[0].error), /boom/);
  assert.equal(r.rounds[0].applied[1].ok, true);
});
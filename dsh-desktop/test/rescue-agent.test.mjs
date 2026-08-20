// Tests for rescue-agent.js — 崩溃救援代理纯函数核心
// 覆盖存活矩阵：日志超大不整读、profile 损坏不抛、AI 响应容错、白名单
// 校验、安全模式 patch、崩溃循环计数、AI 调用降级。

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_OPTS,
  readTail,
  collectDiagnosis,
  filterDiagnosisPayload,
  buildDiagnosisPrompt,
  parseAiResponse,
  validateSuggestion,
  applySuggestion,
  safeModePatch,
  recordBootFailure,
  shouldEnterRescue,
  chatCompletions,
} from '../rescue-agent.js';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rescue-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('readTail：小文件全文读取', () => {
  const t = tempDir();
  try {
    const f = join(t.dir, 'small.log');
    writeFileSync(f, 'line1\nline2\n');
    assert.equal(readTail(f, 1024), 'line1\nline2\n');
  } finally { t.cleanup(); }
});

test('readTail：大文件只读尾部且从行首对齐', () => {
  const t = tempDir();
  try {
    const f = join(t.dir, 'big.log');
    const big = 'x'.repeat(100 * 1024) + '\nTAIL_MARKER_END';
    writeFileSync(f, big);
    const tail = readTail(f, 1024);
    assert.ok(tail.includes('TAIL_MARKER_END'), '尾部内容必须存在');
    assert.ok(!tail.includes('\nTAIL_MARKER'), '首行应被截到换行之后');
    assert.ok(tail.length <= 1024 + 32, '读取量不超过上限');
  } finally { t.cleanup(); }
});

test('readTail：文件不存在 / 空文件 / 非法上限不抛', () => {
  assert.equal(readTail(join(tmpdir(), 'nope-' + Date.now() + '.log'), 1024), '');
  const t = tempDir();
  try {
    const f = join(t.dir, 'empty.log');
    writeFileSync(f, '');
    assert.equal(readTail(f, 1024), '');
    assert.equal(readTail(f, 0), '');
  } finally { t.cleanup(); }
});

function diagCtx(dir, over = {}) {
  const logsDir = join(dir, 'logs');
  const profileDir = join(dir, 'profile');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(logsDir, 'dsh-web.log'), 'boot error: duplicate loader entry\n');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: bad-plugin\n  name: bad-plugin\n');
  return {
    dshHome: dir,
    profileDir,
    logsDir,
    profile: 'web-desktop',
    versions: { app: '4.4.0', dsh: '0.1.0-rc.7', source: '内置' },
    plugins: () => [{ id: 'bad-plugin', name: 'bad-plugin', enabled: true, core: false, toggleable: true }],
    snapshots: () => [{ id: 'snap-1', reason: 'boot', at: '2026-08-19T00:00:00.000Z' }],
    lastGood: () => ({ id: 'snap-1', reason: 'boot' }),
    incidents: () => [{ id: 'inc-1.md', title: 'boot-failed' }],
    readIncident: () => '# boot-failed\n\n详情\n',
    health: () => [{ code: 'PATCH_DUP_ID', severity: 'high', message: 'x', fixable: true }],
    attribution: () => ({ name: 'bad-plugin', kind: 'patchRow', rowId: 'bad-plugin' }),
    lastErrText: () => 'duplicate loader entry bad-plugin',
    ...over,
  };
}

test('collectDiagnosis：聚合完整诊断包与发送清单', () => {
  const t = tempDir();
  try {
    const d = collectDiagnosis(diagCtx(t.dir));
    assert.equal(d.ok, true);
    assert.ok(d.totalBytes > 0);
    assert.ok(d.sendManifest.some((m) => m.kind === '日志尾部'));
    assert.ok(d.sendManifest.some((m) => m.kind === '事故报告'));
    assert.equal(d.payload.lastBootError.includes('duplicate'), true);
    assert.equal(d.payload.attribution.rowId, 'bad-plugin');
    assert.equal(d.payload.plugins.length, 1);
    assert.equal(d.payload.incidents.length, 1);
  } finally { t.cleanup(); }
});

test('collectDiagnosis：日志缺失 / 回调抛错 / 目录为空都不炸', () => {
  const t = tempDir();
  try {
    const d = collectDiagnosis(diagCtx(t.dir, {
      readIncident: () => { throw new Error('boom'); },
      plugins: () => { throw new Error('boom'); },
      incidents: () => { throw new Error('boom'); },
      logsDir: join(t.dir, 'no-such-dir'),
      profileDir: join(t.dir, 'no-such-profile'),
    }));
    assert.equal(d.ok, true);
    assert.equal(d.payload.plugins.length, 0);
    assert.equal(d.payload.incidents.length, 0);
    assert.equal(d.payload.logs['dsh-web.log'], '');
    assert.equal(d.payload.profile.patchText, '');
  } finally { t.cleanup(); }
});

test('collectDiagnosis：profile 文件写入损坏字节不影响读取', () => {
  const t = tempDir();
  try {
    const ctx = diagCtx(t.dir);
    writeFileSync(join(ctx.profileDir, 'cordis.patch.yml'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const d = collectDiagnosis(ctx);
    assert.equal(d.ok, true);
  } finally { t.cleanup(); }
});

test('filterDiagnosisPayload：未勾选 = 全量发送；按清单裁剪敏感项', () => {
  const t = tempDir();
  try {
    const d = collectDiagnosis(diagCtx(t.dir));
    assert.equal(filterDiagnosisPayload(d.payload, d.sendManifest, []), d.payload);
    const all = d.sendManifest.map((m) => m.name);
    const filtered = filterDiagnosisPayload(d.payload, d.sendManifest, all.filter((n) => n !== 'dsh-web.log' && n !== 'desktop.log'));
    assert.equal(filtered.logs['dsh-web.log'], undefined, '取消勾选的日志不发送');
    assert.equal(filtered.logs['desktop.log'], undefined);
    const noIncidents = filterDiagnosisPayload(d.payload, d.sendManifest, all.filter((n) => n !== 'boot-failed'));
    assert.equal(noIncidents.incidents.length, 0, '取消勾选的事故报告不发送');
    assert.ok(noIncidents.env.appVersion, '版本环境不可取消');
    const onlyPlugins = filterDiagnosisPayload(d.payload, d.sendManifest, [d.sendManifest.find((m) => m.kind === '插件清单').name]);
    assert.equal(onlyPlugins.incidents.length, 0);
    assert.equal(onlyPlugins.plugins.length, 1);
    assert.equal(onlyPlugins.profile.patchText, undefined);
  } finally { t.cleanup(); }
});

test('buildDiagnosisPrompt：含动作白名单与 JSON 输出约束', () => {
  const prompt = buildDiagnosisPrompt({ env: {}, logs: {} });
  assert.ok(prompt.includes('restore'));
  assert.ok(prompt.includes('disable'));
  assert.ok(prompt.includes('safe-mode'));
  assert.ok(prompt.includes('suggestions'));
  assert.ok(prompt.includes('=== 诊断上下文（JSON） ==='));
});

test('parseAiResponse：裸 JSON', () => {
  const r = parseAiResponse(JSON.stringify({
    analysis: '根因分析',
    suggestions: [{ action: 'disable', params: { pluginId: 'bad-plugin' }, reason: '它崩了', risk: 'medium' }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].action, 'disable');
  assert.equal(r.suggestions[0].params.pluginId, 'bad-plugin');
});

test('parseAiResponse：```json 包裹与前后缀文字', () => {
  const r = parseAiResponse('好的，分析如下：\n```json\n{"analysis":"a","suggestions":[{"action":"retry","params":{},"reason":"r"}]}\n```\n以上。');
  assert.equal(r.ok, true);
  assert.equal(r.suggestions[0].action, 'retry');
});

test('parseAiResponse：无代码块但带前后缀（截取花括号）', () => {
  const r = parseAiResponse('结论：{"analysis":"a","suggestions":[{"action":"repair","params":{},"reason":"r"}]} 完毕');
  assert.equal(r.ok, true);
  assert.equal(r.suggestions[0].action, 'repair');
});

test('parseAiResponse：垃圾输入 / 空输入不炸', () => {
  assert.equal(parseAiResponse('').ok, false);
  assert.equal(parseAiResponse('hello world 完全不是 JSON').ok, false);
  assert.equal(parseAiResponse('{"analysis": broken').ok, false);
  assert.equal(parseAiResponse(null).ok, false);
});

test('parseAiResponse：白名单外动作被丢弃，合法项保留', () => {
  const r = parseAiResponse(JSON.stringify({
    analysis: 'a',
    suggestions: [
      { action: 'evil', params: {}, reason: 'x' },
      { action: 'disable', params: { pluginId: 'p1' }, reason: 'x' },
    ],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].action, 'disable');
  assert.equal(r.invalid.length, 1);
});

test('parseAiResponse：建议数超过上限被截断', () => {
  const items = [];
  for (let i = 0; i < 30; i += 1) items.push({ action: 'retry', params: {}, reason: 'x' });
  const r = parseAiResponse(JSON.stringify({ analysis: 'a', suggestions: items }));
  assert.equal(r.suggestions.length, DEFAULT_OPTS.MAX_SUGGESTIONS);
});

test('validateSuggestion：各动作参数校验', () => {
  assert.equal(validateSuggestion({ action: 'restore', params: { snapshotId: 'snap-1' } }).ok, true);
  assert.equal(validateSuggestion({ action: 'restore', params: {} }).ok, false);
  assert.equal(validateSuggestion({ action: 'restore', params: { snapshotId: '../../etc' } }).ok, false);
  assert.equal(validateSuggestion({ action: 'disable', params: { pluginId: 'dsh-pet' } }).ok, true);
  assert.equal(validateSuggestion({ action: 'disable', params: { pluginId: 'bad id!' } }).ok, false);
  assert.equal(validateSuggestion({ action: 'remove', params: { pluginId: 'p' } }).ok, true);
  assert.equal(validateSuggestion({ action: 'safe-mode', params: { on: true } }).ok, true);
  assert.equal(validateSuggestion({ action: 'repair' }).ok, true);
  assert.equal(validateSuggestion({ action: 'retry' }).ok, true);
  assert.equal(validateSuggestion({ action: 'hack', params: {} }).ok, false);
  assert.equal(validateSuggestion(null).ok, false);
  assert.equal(validateSuggestion('str').ok, false);
});

test('applySuggestion：白名单外拒绝、exec 抛错不炸、成功透传', async () => {
  let called = 0;
  const exec = async (s) => { called += 1; return { ok: true, result: s.action }; };
  const r1 = await applySuggestion({ action: 'evil', params: {} }, exec);
  assert.equal(r1.ok, false);
  assert.equal(called, 0);
  const r2 = await applySuggestion({ action: 'retry', params: {} }, async () => { throw new Error('boom'); });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /boom/);
  const r3 = await applySuggestion({ action: 'restore', params: { snapshotId: 'snap-1' } }, exec);
  assert.equal(r3.ok, true);
  assert.equal(r3.result, 'restore');
  assert.equal(called, 1);
});

test('safeModePatch：只保留核心行，其余全移除', () => {
  const patch = [
    '# header comment',
    '- id: core-a',
    '  name: core-a',
    '- id: bad-plugin',
    '  name: bad-plugin',
    '- insert:',
    '    - id: core-b',
    '      name: core-b',
    '    - id: evil',
    '      name: evil',
  ].join('\n');
  const r = safeModePatch(patch, ['core-a', 'core-b']);
  assert.ok(r.patch.includes('core-a'));
  assert.ok(r.patch.includes('core-b'));
  assert.ok(!r.patch.includes('bad-plugin'));
  assert.ok(!r.patch.includes('evil'));
  assert.ok(r.removed.includes('bad-plugin'));
  assert.ok(r.removed.includes('evil'));
  assert.ok(!r.removed.includes('core-a'));
  assert.ok(r.patch.includes('# header comment'), '注释保留');
});

test('safeModePatch：空 patch / 无匹配 id 不炸', () => {
  assert.equal(safeModePatch('', ['a']).patch, '');
  assert.equal(safeModePatch('[]\n', ['a']).removed.length, 0);
  const r = safeModePatch('- id: x\n  name: x\n', []);
  assert.equal(r.removed.length, 1);
  assert.ok(!r.patch.includes('x'));
});

test('recordBootFailure / shouldEnterRescue：窗口内计数、窗口外重置', () => {
  const now = 1000000;
  let s = recordBootFailure(null, now);
  assert.equal(s.bootFailures, 1);
  s = recordBootFailure(s, now + 1000);
  assert.equal(s.bootFailures, 2);
  assert.equal(shouldEnterRescue(s, now + 2000), false);
  s = recordBootFailure(s, now + 3000);
  assert.equal(s.bootFailures, 3);
  assert.equal(shouldEnterRescue(s, now + 3000), true);
  // 窗口超时：计数重置
  s = recordBootFailure(s, now + DEFAULT_OPTS.BOOT_FAILURE_WINDOW_MS + 1);
  assert.equal(s.bootFailures, 1);
  assert.equal(shouldEnterRescue(s, now + DEFAULT_OPTS.BOOT_FAILURE_WINDOW_MS + 1), false);
  assert.equal(shouldEnterRescue(null, now), false);
});

test('chatCompletions：无 key 直接降级 no-key', async () => {
  const r = await chatCompletions({});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-key');
});

test('chatCompletions：注入 httpFn 成功路径', async () => {
  const r = await chatCompletions({
    apiKey: 'sk-test',
    httpFn: (url, body) => Promise.resolve({
      data: JSON.stringify({ choices: [{ message: { content: '{"analysis":"a","suggestions":[]}' } }] }),
    }),
  });
  assert.equal(r.ok, true);
  assert.match(r.content, /analysis/);
});

test('chatCompletions：注入 httpFn 失败 / 畸形响应 / 超时不炸', async () => {
  const r1 = await chatCompletions({ apiKey: 'k', httpFn: () => Promise.resolve({ error: 'HTTP 500：boom' }) });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /HTTP 500/);
  const r2 = await chatCompletions({ apiKey: 'k', httpFn: () => Promise.resolve({ data: 'not json' }) });
  assert.equal(r2.ok, false);
  const r3 = await chatCompletions({ apiKey: 'k', httpFn: () => Promise.resolve({ data: '{}' }) });
  assert.equal(r3.ok, false, '缺少 choices 视为失败');
  const r4 = await chatCompletions({ apiKey: 'k', httpFn: () => Promise.reject(new Error('network down')) });
  assert.equal(r4.ok, false);
  assert.match(r4.error, /network down/);
});

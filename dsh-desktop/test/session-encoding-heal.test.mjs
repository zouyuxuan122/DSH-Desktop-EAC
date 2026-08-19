import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Issue #77：会话目录同时存在 session.jsonl（明文）与 session.jsonl.zstd 时，
// 会话持久化后端（DEFAULT_COMPRESSION = "zstd"）在 checkRootEncoding 抛
// encodingMismatch，整棵插件树加载失败、dsh web 退出码 1，桌面端表现为
// 「Web UI 未在预期时间内就绪」。session-encoding-heal 在守护启动 preRetry
// 里识别该错误并归档（改名，非删除）相反格式的遗留文件，保留权威的 zstd 日志。

const require = createRequire(import.meta.url);
const { isEncodingMismatch, healSessionEncodingConflicts } = require('../session-encoding-heal.js');

// 后端 encodingMismatch 的真实报错文案（rc.6/rc.7 一致）。
const REAL_ERR =
  'Error: dsh: plugin tree failed to load: ... failed to apply loader entry workspace ' +
  '(@deepseek-ai/dsh-workspace): session artifact ' +
  '"C:\\\\Users\\\\x\\\\.dsh\\\\sessions\\\\proj\\\\session-02ab\\\\session.jsonl" uses .jsonl, ' +
  'but this backend is configured for compression "zstd"; use a separate root or select the matching compression mode';

test('isEncodingMismatch：识别后端 encodingMismatch 报错，忽略无关文案', () => {
  assert.equal(isEncodingMismatch(REAL_ERR), true);
  assert.equal(isEncodingMismatch('Ignored build scripts: esbuild'), false);
  assert.equal(isEncodingMismatch(''), false);
  assert.equal(isEncodingMismatch(null), false);
});

function makeSessions(root) {
  const sessions = join(root, 'sessions');
  const dir = join(sessions, 'projA', 'session-02ab7066');
  mkdirSync(dir, { recursive: true });
  return { sessions, dir };
}

test('healSessionEncodingConflicts：两种编码并存时归档明文、保留 zstd（数据无损）', () => {
  const t = mkdtempSync(join(tmpdir(), 'sess-heal-'));
  try {
    const { sessions, dir } = makeSessions(t);
    writeFileSync(join(dir, 'session.jsonl'), 'plaintext stale snapshot');
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'ZSTD-AUTHORITATIVE');
    const archived = healSessionEncodingConflicts(sessions, { compression: 'zstd', log: () => {} });
    assert.equal(archived.length, 1);
    // 权威 zstd 保留、内容不动。
    assert.equal(readFileSync(join(dir, 'session.jsonl.zstd'), 'utf8'), 'ZSTD-AUTHORITATIVE');
    // 明文被归档（改名，非删除）。
    assert.equal(existsSync(join(dir, 'session.jsonl')), false);
    const baks = readdirSync(dir).filter((n) => n.startsWith('session.jsonl.bak-'));
    assert.equal(baks.length, 1);
    assert.equal(readFileSync(join(dir, baks[0]), 'utf8'), 'plaintext stale snapshot');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('healSessionEncodingConflicts：只有 zstd 时不动任何文件', () => {
  const t = mkdtempSync(join(tmpdir(), 'sess-heal-'));
  try {
    const { sessions, dir } = makeSessions(t);
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'ZSTD-ONLY');
    const archived = healSessionEncodingConflicts(sessions, { compression: 'zstd', log: () => {} });
    assert.equal(archived.length, 0);
    assert.deepEqual(readdirSync(dir).sort(), ['session.jsonl.zstd']);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('healSessionEncodingConflicts：sessions 目录不存在时安全返回空', () => {
  const t = mkdtempSync(join(tmpdir(), 'sess-heal-'));
  try {
    assert.deepEqual(healSessionEncodingConflicts(join(t, 'nope', 'sessions'), { log: () => {} }), []);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('healSessionEncodingConflicts：多个会话目录各自独立处理', () => {
  const t = mkdtempSync(join(tmpdir(), 'sess-heal-'));
  try {
    const sessions = join(t, 'sessions');
    const d1 = join(sessions, 'projA', 'session-1');
    const d2 = join(sessions, 'projB', 'session-2');
    const d3 = join(sessions, 'projB', 'session-3'); // 只有 zstd，不动
    for (const d of [d1, d2, d3]) mkdirSync(d, { recursive: true });
    writeFileSync(join(d1, 'session.jsonl'), 'a');
    writeFileSync(join(d1, 'session.jsonl.zstd'), 'A');
    writeFileSync(join(d2, 'session.jsonl'), 'b');
    writeFileSync(join(d2, 'session.jsonl.zstd'), 'B');
    writeFileSync(join(d3, 'session.jsonl.zstd'), 'C');
    const archived = healSessionEncodingConflicts(sessions, { compression: 'zstd', log: () => {} });
    assert.equal(archived.length, 2);
    assert.equal(existsSync(join(d1, 'session.jsonl')), false);
    assert.equal(existsSync(join(d2, 'session.jsonl')), false);
    assert.deepEqual(readdirSync(d3).sort(), ['session.jsonl.zstd']);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

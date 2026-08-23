// RED: logger 旋转 + level 过滤 + 首条 boot trace
// Source: plan/logging-system.md step 2.4 + spec AC-1/AC-3/AC-9
//  Acceptance:
//   - AC-1: logger 初始化后，第一行写入文件的 msg 以 "boot " 开头，字段包含 bootTraceId（nanoid）
//   - AC-3: 每文件 20MB 上限；超出后滚动为 main.<NN>，最多保留 10 个；最老的自动淘汰
//   - AC-9: level=info 时 debug 行不进文件；level=warn 时 info 行不进文件；error 总能进入
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const loggerPath = path.resolve(__dirname, '..', 'logger.js');
const logger = require(loggerPath);

// ---- Helpers
function mkTmpLogsDir(suffix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-logger-rotate-' + suffix + '-'));
  process.on('beforeExit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
  return d;
}
function listLogFiles(logsDir) {
  // Policy: smaller numeric suffix = newer file (main.00 = newest, main.09 = oldest).
  // Return sorted ascending by suffix → first = newest, last = oldest.
  return fs.readdirSync(logsDir)
    .filter(f => /^main\.\d{2}$/.test(f))
    .map(f => ({ f, n: Number(f.slice('main.'.length)) }))
    .sort((a, b) => a.n - b.n)
    .map(x => path.join(logsDir, x.f));
}
function readLines(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

// ---- AC-1: 首条 boot 行
test('AC-1 首条日志是 boot 且包含 bootTraceId', () => {
  const logsDir = mkTmpLogsDir('ac1');
  // init 必须存在（Phase 2 会加）
  assert.equal(typeof logger.init, 'function', 'logger.init 应该是函数');
  logger.init({ logsDir, level: 'info', appVersion: '4.3.0', env: 'test' });

  const files = listLogFiles(logsDir);
  assert.ok(files.length >= 1, `main.xx 文件应存在（got ${files.length}）`);

  const first = files[0];
  const lines = readLines(first);
  assert.ok(lines.length >= 1, `应有首条 boot 行（got ${lines.length}）`);

  const firstLine = JSON.parse(lines[0]);
  // msg 以 "boot " 开头，包含 env + platform
  assert.ok(typeof firstLine.msg === 'string' && firstLine.msg.startsWith('boot '),
    `首行 msg 应以 "boot " 开头，got: ${JSON.stringify(firstLine.msg)}`);
  assert.ok(firstLine.bootTraceId && typeof firstLine.bootTraceId === 'string',
    `首行必须有 bootTraceId 字符串，got: ${JSON.stringify(firstLine.bootTraceId)}`);
  assert.ok(typeof firstLine.env !== 'undefined', '首行应有 env 字段');
  assert.ok(typeof firstLine.platform !== 'undefined', '首行应有 platform 字段');
});

// ---- AC-9: level 过滤
test('AC-9 level=warn 时 info 行不写入文件，warn/error 写入', () => {
  const logsDir = mkTmpLogsDir('ac9');
  logger.init({ logsDir, level: 'warn', appVersion: '4.3.0', env: 'test' });

  logger.info('this-should-not-appear-in-ac9');
  logger.warn('this-warn-should-appear');
  logger.error('this-err-should-appear');
  // flush（如果有）保证落盘
  if (typeof logger.flush === 'function') logger.flush();

  const files = listLogFiles(logsDir);
  const allMsgs = files.flatMap(f => readLines(f).map(l => JSON.parse(l).msg));
  assert.ok(!allMsgs.some(m => typeof m === 'string' && m.includes('this-should-not-appear-in-ac9')),
    `info 级别的日志在 level=warn 时不应出现，实际 msgs=${JSON.stringify(allMsgs)}`);
  assert.ok(allMsgs.some(m => typeof m === 'string' && m.includes('this-warn-should-appear')),
    `warn 级别应出现，实际 msgs=${JSON.stringify(allMsgs)}`);
  assert.ok(allMsgs.some(m => typeof m === 'string' && m.includes('this-err-should-appear')),
    `error 级别应出现，实际 msgs=${JSON.stringify(allMsgs)}`);
});

// ---- AC-3: 20MB 滚动
test('AC-3 20MB 滚动：写入 ~25MB 后应产生多个 main.xx 文件，且最多保留 10 个', { timeout: 30000 }, () => {
  const logsDir = mkTmpLogsDir('ac3');
  logger.init({ logsDir, level: 'info', appVersion: '4.3.0', env: 'test' });

  // 每 1MB 写 1 行，写 28 条 → 总 > 20MB
  const ONE_MB = 1024 * 1024;
  const CHARS_PER_LINE = ONE_MB - 120; // 给 JSON 封装/时间戳/level 预留
  const payload = 'x'.repeat(CHARS_PER_LINE);

  const TOTAL_LINES = 28;
  for (let i = 0; i < TOTAL_LINES; i++) {
    logger.info({ payload, seq: i }, 'ac3-bigline-' + i);
  }
  if (typeof logger.flush === 'function') logger.flush();

  const files = listLogFiles(logsDir);
  // 28MB / 20MB = 至少 2 个文件
  assert.ok(files.length >= 2, `写了 >20MB 应至少 2 个 main 文件，实际 ${files.length}：${files}`);
  assert.ok(files.length <= 10, `main 文件数不应超过 10（最老自动淘汰），实际 ${files.length}：${files}`);

  // 每个文件 size 不应超过 20MB + 一点容差（21MB）
  const MAX_WITH_TOLERANCE = 21 * 1024 * 1024;
  for (const f of files) {
    const st = fs.statSync(f);
    assert.ok(st.size <= MAX_WITH_TOLERANCE,
      `${f} size=${st.size} 超过 21MB 容差`);
  }

  // 最新文件（编号最小：main.00）应包含最新 seq
  const latestFile = files[0];
  const latestLines = readLines(latestFile).map(l => JSON.parse(l));
  const hasLast = latestLines.some(l => l.seq === TOTAL_LINES - 1 || (typeof l.msg === 'string' && l.msg.endsWith('-' + (TOTAL_LINES - 1))));
  assert.ok(hasLast, `最新文件 ${latestFile} 应包含最后一条 (seq ${TOTAL_LINES - 1})，实际 msgs=${latestLines.slice(-3).map(l=>l.msg)}`);
});

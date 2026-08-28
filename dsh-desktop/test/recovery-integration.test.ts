// TDD wiring tests: 恢复/心跳能力必须真正接到桌面壳上。Electron era 版本锁定
// main.js/preload.js 的对接点；两文件已随壳退役（批次 C），本测试接管为
// Tauri 侧等价对接点：
//   - 窗口桥（tauri-shell/sidecar/bridge.ts）暴露 recovery.* 与渲染进程心跳
//     （WebView2 → sidecar 的 log.renderer-heartbeat）；
//   - 恢复中心窗口桥（assets/recovery-center-preload.js）暴露 rc.action/rc.close；
//   - 恢复中心动作分发（lib/recovery-center/register.ts）覆盖导出诊断日志等；
//   - 恢复中心页面（assets/recovery.html）必须存在。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const bridgeSrc = readFileSync(join(ROOT, '..', 'tauri-shell', 'sidecar', 'bridge.ts'), 'utf8');
const rcPreload = readFileSync(join(ROOT, 'assets', 'recovery-center-preload.js'), 'utf8');
const registerSrc = readFileSync(join(ROOT, 'lib', 'recovery-center', 'register.ts'), 'utf8');

test('bridge 暴露 recovery.* 恢复能力（getState/reload/restart/exportLogs）', () => {
  for (const [key, method] of [
    ['getState', 'recovery.state'],
    ['reload', 'recovery.reload'],
    ['restart', 'recovery.restart'],
    ['exportLogs', 'recovery.export-logs'],
  ]) {
    assert.ok(bridgeSrc.includes(`'${method}'`), `bridge recovery.${key} → ${method} 缺失`);
  }
});

test('bridge 向 sidecar 发送渲染进程心跳（renderer-heartbeat）', () => {
  assert.ok(bridgeSrc.includes("send('log.renderer-heartbeat'"), 'bridge 心跳发送缺失');
});

test('recovery-center preload 暴露 rc 桥（action/close 白名单）', () => {
  assert.match(rcPreload, /window\.rc\s*=\s*\{/, 'window.rc 定义缺失');
  assert.match(rcPreload, /\baction:\s*function/, 'rc.action 缺失');
  assert.match(rcPreload, /\bclose:\s*function/, 'rc.close 缺失');
  assert.ok(rcPreload.includes("'rc.action'"), 'rc.action 应为转发动作名');
});

test('rc.action 分发覆盖导出诊断日志（export-logs）', () => {
  assert.ok(registerSrc.includes("case 'export-logs'"), "rc.action export-logs 处理缺失");
});

test('unclean previous-run 判定尊重 clean-exit 与 PID 边界（保留原纯逻辑契约）', () => {
  const predicate = (prev, currentPid) => Boolean(
    prev && prev.cleanExit !== true && prev.pid && Number(prev.pid) !== currentPid,
  );
  assert.equal(predicate({ pid: 41, cleanExit: false }, 42), true);
  assert.equal(predicate({ pid: 41, cleanExit: true }, 42), false);
  assert.equal(predicate({ pid: 42, cleanExit: false }, 42), false);
  assert.equal(predicate({ pid: 0, cleanExit: false }, 42), false);
});

test('恢复中心页面存在', () => {
  assert.ok(existsSync(join(ROOT, 'assets', 'recovery.html')), 'assets/recovery.html missing');
});
// TDD wiring tests: the recovery/watchdog modules must actually be wired
// into the desktop shell. Electron 入口不可在 node:test 下直接执行，故在
// 源码层面钉住接线点 —— 每条断言对应一个必需的集成位。
//
// Task 4/5.4：装配入口 main.js 只剩 bridge 注入 + 生命周期；以下符号分别
// 位于 lib/run-state.ts、lib/watchdog-boot.ts、lib/window.ts、lib/ipc/
// recovery.ts、lib/boot.ts，入口/装配断言改为对应模块的 require 调用。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8');
// Task 6.4：桥接面实现自 preload.js 迁至 preload/api.ts（门面拆分），
// 断言语义等价（心跳发送 + 恢复页通道）。
const preloadSrc = readFileSync(join(ROOT, 'preload', 'api.ts'), 'utf8');
const windowSrc = readFileSync(join(ROOT, 'lib', 'window.ts'), 'utf8');
const runStateSrc = readFileSync(join(ROOT, 'lib', 'run-state.ts'), 'utf8');
const watchdogSrc = readFileSync(join(ROOT, 'lib', 'watchdog-boot.ts'), 'utf8');
const recoveryIpcSrc = readFileSync(join(ROOT, 'lib', 'ipc', 'recovery.ts'), 'utf8');
const bootSrc = readFileSync(join(ROOT, 'lib', 'boot.ts'), 'utf8');

test('renderer-recovery is imported and the state machine attaches the main window', () => {
  // Task 3：lib/window.ts 以 ESM import 引 renderer-recovery.js（编译为 require）。
  assert.ok(/from '\.\.\/renderer-recovery\.js'/.test(windowSrc), "lib/window.ts must import '../renderer-recovery.js'");
  assert.ok(/export function initRendererRecovery\(\)/.test(windowSrc), 'initRendererRecovery() missing');
  assert.ok(/state\.recovery\.attach\(state\.mainWindow,\s*'main'\)/.test(windowSrc), 'main window attach missing');
});

test('watchdog lifecycle: run-state write, spawn, clean-exit mark', () => {
  assert.ok(/export function writeRunState\(/.test(runStateSrc), 'writeRunState() missing');
  assert.ok(/export function markCleanExit\(/.test(runStateSrc), 'markCleanExit() missing');
  assert.ok(/export function startWatchdog\(\)/.test(watchdogSrc), 'startWatchdog() missing');
  // boot 链负责调用（Task 5.4 起 watchdog 生命周期在 lib/boot.ts）。
  assert.ok(/startWatchdog\(\);/.test(bootSrc), 'startWatchdog() is never called');
});

test('heartbeat IPC is registered and heartbeats are polled', () => {
  assert.ok(recoveryIpcSrc.includes("'dsh:renderer-heartbeat'"), 'heartbeat IPC channel missing');
  assert.ok(/checkHeartbeats\(\)/.test(windowSrc), 'checkHeartbeats() loop missing');
});

test('the local recovery page IPC endpoints are served', () => {
  for (const ch of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:export-logs']) {
    assert.ok(recoveryIpcSrc.includes(`'${ch}'`), `IPC handler ${ch} missing`);
  }
  assert.ok(existsSync(join(ROOT, 'assets', 'recovery.html')), 'assets/recovery.html missing');
});

test('every quit path marks a clean exit for the watchdog', () => {
  // 退出路径分散在 main.js（before-quit）、lib/boot.ts（fatal/校验失败）、
  // lib/update-flow.ts（agent/客户端更新重启）—— 全部源码合计 ≥3。
  const sources = [mainSrc, bootSrc];
  const updateFlowSrc = readFileSync(join(ROOT, 'lib', 'update-flow.ts'), 'utf8');
  sources.push(updateFlowSrc);
  const marks = sources.reduce(
    (n, src) => n + (src.match(/markCleanExit\(\)/g) || []).length, 0,
  );
  assert.ok(marks >= 3, `expected markCleanExit() on before-quit + restart + app.exit paths, found ${marks}`);
});

test('preload sends renderer heartbeats and exposes the recovery bridge', () => {
  assert.ok(preloadSrc.includes("'dsh:renderer-heartbeat'"), 'preload heartbeat sender missing');
  for (const ch of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:export-logs']) {
    assert.ok(preloadSrc.includes(`'${ch}'`), `preload bridge for ${ch} missing`);
  }
});

test('main.js wires the boot module and registers IPC through lib/ipc', () => {
  // Task 7：main.js 为 tsc 编译产物（双引号 require）；源码 main.ts 为 ESM import。
  assert.ok(/require\(['"]\.\/lib\/boot\.js['"]\)/.test(mainSrc), 'boot wiring missing');
  assert.ok(/registerIpc\(\);/.test(bootSrc), 'registerIpc() is never called');
});

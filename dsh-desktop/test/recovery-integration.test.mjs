// TDD wiring tests: the recovery/watchdog modules must actually be wired
// into the desktop shell. main.js is an Electron entry (untestable under
// node:test directly), so we pin the wiring points at the source level —
// each assertion corresponds to a required integration point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8');
const registerIpcSrc = readFileSync(join(ROOT, 'ipc', 'register-ipc.js'), 'utf8');
const preloadSrc = readFileSync(join(ROOT, 'preload.js'), 'utf8');

test('main.js requires the renderer-recovery module', () => {
  assert.ok(/require\('\.\/renderer-recovery'\)/.test(mainSrc), "main.js must require('./renderer-recovery')");
});

test('main.js builds the recovery state machine and attaches the main window', () => {
  assert.ok(/function initRendererRecovery\(\)/.test(mainSrc), 'initRendererRecovery() missing');
  assert.ok(/recovery\.attach\(mainWindow,\s*'main'\)/.test(mainSrc), 'main window attach missing');
});

test('main.js runs the watchdog lifecycle: run-state write, spawn, clean-exit mark', () => {
  assert.ok(/function writeRunState\(/.test(mainSrc), 'writeRunState() missing');
  assert.ok(/function markCleanExit\(/.test(mainSrc), 'markCleanExit() missing');
  assert.ok(/function startWatchdog\(\)/.test(mainSrc), 'startWatchdog() missing');
  assert.ok(/startWatchdog\(\);/.test(mainSrc), 'startWatchdog() is never called');
});

test('main.js registers the heartbeat IPC and polls heartbeats', () => {
  // IPC 注册已迁到 ipc/register-ipc.js，main.js 通过 registerAppIpc() 接线。
  assert.ok(registerIpcSrc.includes("'dsh:renderer-heartbeat'"), 'heartbeat IPC channel missing');
  assert.ok(mainSrc.includes('registerAppIpc()'), 'registerAppIpc() is never called');
  assert.ok(/checkHeartbeats\(\)/.test(mainSrc), 'checkHeartbeats() loop missing');
});

test('main.js serves the local recovery page IPC endpoints', () => {
  for (const ch of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:recovery-open-logs']) {
    assert.ok(registerIpcSrc.includes(`'${ch}'`), `IPC handler ${ch} missing`);
  }
  assert.ok(existsSync(join(ROOT, 'assets', 'recovery.html')), 'assets/recovery.html missing');
});

test('every quit path marks a clean exit for the watchdog', () => {
  const marks = mainSrc.match(/markCleanExit\(\)/g) || [];
  assert.ok(marks.length >= 3, `expected markCleanExit() on before-quit + restart + app.exit paths, found ${marks.length}`);
});

test('preload sends renderer heartbeats and exposes the recovery bridge', () => {
  assert.ok(preloadSrc.includes("'dsh:renderer-heartbeat'"), 'preload heartbeat sender missing');
  for (const ch of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:recovery-open-logs']) {
    assert.ok(preloadSrc.includes(`'${ch}'`), `preload bridge for ${ch} missing`);
  }
});

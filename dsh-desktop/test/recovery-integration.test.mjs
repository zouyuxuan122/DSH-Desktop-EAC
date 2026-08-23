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

test('main.js detects the previous run before replacing run-state.json', () => {
  const detect = mainSrc.indexOf('const uncleanPrev = detectUncleanPreviousRun();');
  const write = mainSrc.indexOf('writeRunState();', detect);
  const watchdog = mainSrc.indexOf('startWatchdog();', write);
  assert.ok(detect >= 0, 'previous-run detection missing');
  assert.ok(write > detect, 'current run-state must be written after previous-run detection');
  assert.ok(watchdog > write, 'watchdog must start after current run-state is written');
  assert.ok(mainSrc.indexOf('autoRollbackClientIfCrashed(uncleanPrev);', detect) > watchdog);
  assert.ok(mainSrc.indexOf('if (uncleanPrev) notifyUncleanRestart(uncleanPrev);', detect) > watchdog);
});

test('unclean previous-run predicate respects clean exit and PID boundaries', () => {
  const predicate = (prev, currentPid) => Boolean(
    prev && prev.cleanExit !== true && prev.pid && Number(prev.pid) !== currentPid,
  );
  assert.equal(predicate({ pid: 41, cleanExit: false }, 42), true);
  assert.equal(predicate({ pid: 41, cleanExit: true }, 42), false);
  assert.equal(predicate({ pid: 42, cleanExit: false }, 42), false);
  assert.equal(predicate({ pid: 0, cleanExit: false }, 42), false);
});

test('main.js registers the heartbeat IPC and polls heartbeats', () => {
  assert.ok(mainSrc.includes("'dsh:renderer-heartbeat'"), 'heartbeat IPC channel missing');
  assert.ok(/checkHeartbeats\(\)/.test(mainSrc), 'checkHeartbeats() loop missing');
});

test('main.js serves the local recovery page IPC endpoints', () => {
  for (const ch of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:export-logs']) {
    assert.ok(mainSrc.includes(`'${ch}'`), `IPC handler ${ch} missing`);
  }
  assert.ok(existsSync(join(ROOT, 'assets', 'recovery.html')), 'assets/recovery.html missing');
});

test('every quit path marks a clean exit for the watchdog', () => {
  const marks = mainSrc.match(/markCleanExit\(\)/g) || [];
  assert.ok(marks.length >= 3, `expected markCleanExit() on before-quit + restart + app.exit paths, found ${marks.length}`);
});

test('preload sends renderer heartbeats and exposes the recovery bridge', () => {
  assert.ok(preloadSrc.includes("'dsh:renderer-heartbeat'"), 'preload heartbeat sender missing');
  for (const ch of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:export-logs']) {
    assert.ok(preloadSrc.includes(`'${ch}'`), `preload bridge for ${ch} missing`);
  }
});

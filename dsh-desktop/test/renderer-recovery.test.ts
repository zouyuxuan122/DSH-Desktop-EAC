// TDD acceptance tests for the upstream renderer-recovery state machine.
//
// The module is imported verbatim from myYangyunfan/dsh_desktop (Issue #9
// fix). These tests pin its decision logic so later refactors or re-pulls
// from upstream cannot silently change recovery behavior:
//   - pure helpers: computeBackoff / nextAction
//   - state machine: crash → backoff reload, 3rd failure of main window →
//     rebuild, beyond cap → give-up + local recovery page + notification,
//     clean-exit never triggers recovery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RendererRecovery, computeBackoff, nextAction, DEFAULT_OPTS } from '../renderer-recovery.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal fake BrowserWindow: EventEmitter with webContents (also an
// EventEmitter) exposing the API surface renderer-recovery touches.
function makeWin(id) {
  const win = new EventEmitter();
  win.id = id;
  win.isDestroyed = () => false;
  win.destroyed = false;
  win.destroy = () => { win.destroyed = true; win.emit('closed'); };
  const wc = new EventEmitter();
  wc.id = id * 1000;
  wc.loaded = null;
  wc.loadURL = (u) => { wc.loaded = u; return Promise.resolve(); };
  wc.loadFile = (p) => { wc.loaded = 'file://' + p; return Promise.resolve(); };
  wc.getURL = () => wc.loaded || '';
  wc.forcefullyCrashRenderer = () => { wc.forced = true; };
  win.webContents = wc;
  return win;
}

function makeRecovery(overrides = {}) {
  const calls = { reloads: 0, rebuilds: 0, gaveUp: 0, stable: 0, notified: [] };
  const recovery = new RendererRecovery({
    log: () => {},
    isQuitting: () => false,
    isServerAlive: () => true,
    getTarget: () => ({ kind: 'url', url: 'http://127.0.0.1:6100/' }),
    loadingPage: 'C:/fake/loading.html',
    recoveryPage: 'C:/fake/recovery.html',
    rebuildMainWindow: () => {
      calls.rebuilds += 1;
      const w = makeWin(900 + calls.rebuilds);
      recovery.attach(w, 'main');
      return w;
    },
    waitServerUp: () => Promise.resolve(),
    onGaveUp: () => { calls.gaveUp += 1; },
    onStable: () => { calls.stable += 1; },
    notify: (t, b) => { calls.notified.push([t, b]); },
    // Fast timers for tests.
    FIRST_DELAY_MS: 10,
    BACKOFF_BASE_MS: 10,
    BACKOFF_MAX_MS: 20,
    STABILITY_MS: 30,
    UNRESPONSIVE_GRACE_MS: 20,
    HEARTBEAT_MISS_MS: 50,
    ...overrides,
  });
  return { recovery, calls };
}

// --------------------------------------------------------------- pure helpers

test('computeBackoff: first failure uses FIRST_DELAY_MS, later ones stay capped', () => {
  assert.equal(computeBackoff(1), DEFAULT_OPTS.FIRST_DELAY_MS);
  assert.equal(computeBackoff(0), DEFAULT_OPTS.FIRST_DELAY_MS);
  const d2 = computeBackoff(2);
  assert.ok(d2 > DEFAULT_OPTS.FIRST_DELAY_MS, '2nd failure must back off harder');
  const d9 = computeBackoff(9);
  assert.ok(d9 <= DEFAULT_OPTS.BACKOFF_MAX_MS + DEFAULT_OPTS.BACKOFF_MAX_MS * 0.35 + 1,
    'backoff must respect the cap (+jitter)');
});

test('nextAction: reload → rebuild (main, 3rd) → give-up beyond cap', () => {
  assert.equal(nextAction(1, 'main', false), 'reload');
  assert.equal(nextAction(2, 'main', false), 'reload');
  assert.equal(nextAction(3, 'main', false), 'rebuild');
  assert.equal(nextAction(3, 'main', true), 'reload', 'already rebuilt in burst → plain reload');
  assert.equal(nextAction(3, 'float', false), 'reload', 'float windows are never rebuilt');
  assert.equal(nextAction(DEFAULT_OPTS.MAX_ATTEMPTS + 1, 'main', false), 'give-up');
});

// ------------------------------------------------------------- state machine

test('clean-exit renderer shutdown never schedules recovery', async () => {
  const { recovery, calls } = makeRecovery();
  const win = makeWin(1);
  recovery.attach(win, 'main');
  win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  await sleep(60);
  assert.equal(win.webContents.loaded, null, 'no reload was issued');
  assert.equal(calls.rebuilds, 0);
});

test('crash schedules a backoff reload that lands on the target URL', async () => {
  const { recovery } = makeRecovery();
  const win = makeWin(2);
  recovery.attach(win, 'main');
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 });
  await sleep(80); // > FIRST_DELAY_MS(10) + jitter room
  assert.equal(win.webContents.loaded, 'http://127.0.0.1:6100/', 'reload hit the web URL');
});

test('3rd failure of a visible main window rebuilds the window', async () => {
  const { recovery, calls } = makeRecovery();
  const win = makeWin(3);
  recovery.attach(win, 'main');
  win.emit('show'); // visible
  for (let i = 0; i < 3; i++) {
    win.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    await sleep(5); // let _schedule re-decide with the latest count
  }
  await sleep(60);
  assert.ok(calls.rebuilds >= 1, 'main window must be rebuilt on 3rd failure');
});

test('beyond the attempt cap the recovery gives up: error page + notification', async () => {
  const { recovery, calls } = makeRecovery();
  const win = makeWin(4);
  recovery.attach(win, 'main');
  for (let i = 0; i < DEFAULT_OPTS.MAX_ATTEMPTS + 2; i++) {
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
    await sleep(3);
  }
  await sleep(30);
  const st = recovery.stateOf(win);
  assert.equal(st.gaveUp, true, 'must give up after the cap');
  assert.ok(win.webContents.loaded.includes('recovery.html'), 'local recovery page shown');
  assert.equal(calls.gaveUp, 1);
  assert.equal(calls.notified.length, 1, 'user notified once');
});

test('retryNow clears the gave-up state and retries immediately', async () => {
  const { recovery } = makeRecovery();
  const win = makeWin(5);
  recovery.attach(win, 'main');
  for (let i = 0; i < DEFAULT_OPTS.MAX_ATTEMPTS + 2; i++) {
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await sleep(3);
  }
  await sleep(20);
  assert.equal(recovery.stateOf(win).gaveUp, true);
  assert.equal(recovery.retryNow(win), true);
  await sleep(40);
  assert.equal(recovery.stateOf(win).gaveUp, false, 'burst reset by user retry');
  assert.equal(win.webContents.loaded, 'http://127.0.0.1:6100/', 'web UI reloaded');
});

test('heartbeat loss on a visible web window is treated as a hang', async () => {
  const { recovery } = makeRecovery();
  const win = makeWin(6);
  recovery.attach(win, 'main');
  win.emit('show');
  // Mark a successful web load so expectingWeb=true, then go silent.
  win.webContents.loaded = 'http://127.0.0.1:6100/';
  win.webContents.emit('did-finish-load');
  recovery._states.get(6).heartbeatSilent = true;
  // No heartbeat ever registered for this wc → checkHeartbeats sees a stale 0…
  // actually last=0 skips; send exactly one stale beat instead.
  recovery.noteHeartbeat(win.webContents.id);
  await sleep(60); // > HEARTBEAT_MISS_MS(50)
  recovery.checkHeartbeats();
  const st = recovery._states.get(6);
  assert.ok(st.hangGrace !== null || st.failures >= 1, 'hang path entered (grace timer or counted failure)');
});

test('dispose clears all timers without leaking', async () => {
  const { recovery } = makeRecovery();
  const win = makeWin(7);
  recovery.attach(win, 'main');
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  recovery.dispose();
  assert.equal(recovery._states.size, 0);
  await sleep(30);
  assert.equal(win.webContents.loaded, null, 'pending attempt cancelled by dispose');
});

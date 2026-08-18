import test from 'node:test';
import assert from 'node:assert/strict';
import { createShutdownCoordinator } from '../shutdown-coordinator.js';

function makeCoordinator() {
  const calls = [];
  const app = {
    relaunch: () => calls.push('relaunch'),
    exit: (code) => calls.push(`exit:${code}`),
  };
  const server = { pid: 42 };
  const coordinator = createShutdownCoordinator({
    app,
    log: (tag, message) => calls.push(`${tag}:${message}`),
    markCleanExit: () => calls.push('clean'),
    setQuitting: (value) => calls.push(`quitting:${value}`),
    setForceQuit: (value) => calls.push(`force:${value}`),
    getServerProcess: () => server,
    stopServerProcess: async (proc) => calls.push(`stop:${proc.pid}`),
    terminateChildTree: (child) => calls.push(`market:${child.pid}`),
    getMarketOpChild: () => ({ pid: 77, exitCode: null }),
    closeAllFloatWindows: () => calls.push('floats'),
    abortUpdater: () => calls.push('abort'),
    stopSessionWatcher: () => calls.push('session'),
    clearBalanceTimer: () => calls.push('timer'),
    destroyTray: () => calls.push('tray'),
    applyClientUpdate: async () => calls.push('apply-update'),
  });
  return { calls, app, coordinator };
}

test('restartApp marks clean exit and waits for runtime cleanup before relaunch', async () => {
  const ctx = makeCoordinator();
  await ctx.coordinator.restartApp({ force: true });
  assert.deepEqual(ctx.calls.slice(0, 5), ['quitting:true', 'force:true', 'clean', 'floats', 'market:77']);
  assert.ok(ctx.calls.indexOf('stop:42') < ctx.calls.indexOf('relaunch'));
  assert.equal(ctx.calls.at(-2), 'relaunch');
  assert.equal(ctx.calls.at(-1), 'exit:0');
});

test('beforeQuit is idempotent and performs one bounded cleanup sequence', async () => {
  const ctx = makeCoordinator();
  const events = [{ preventDefault: () => ctx.calls.push('prevent') }, { preventDefault: () => ctx.calls.push('prevent-2') }];
  ctx.coordinator.beforeQuit(events[0]);
  ctx.coordinator.beforeQuit(events[1]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.coordinator.isShuttingDown(), true);
  assert.equal(ctx.calls.filter((call) => call === 'clean').length, 1);
  assert.equal(ctx.calls.filter((call) => call === 'prevent').length, 1);
  assert.equal(ctx.calls.filter((call) => call === 'exit:0').length, 1);
});

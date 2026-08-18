import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServiceSupervisor } from '../web-service-supervisor.js';

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
}

function makeSupervisor() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-supervisor-'));
  const children = [];
  const processChanges = [];
  const unexpected = [];
  const httpStub = {
    get() {
      const request = new EventEmitter();
      request.destroy = () => {};
      return request;
    },
  };
  const supervisor = createWebServiceSupervisor({
    app: { isPackaged: false },
    spawn: () => {
      const child = new FakeChild(children.length + 100);
      children.push(child);
      return child;
    },
    nodeExe: () => process.execPath,
    dshBin: () => process.execPath,
    childEnv: () => ({}),
    desktopProfile: () => 'web-desktop',
    desktopProfileDir: () => dir,
    userDataDir: dir,
    getLogsDir: () => dir,
    chooseStableWebPort: async () => 23456,
    stablePortCtx: () => ({}),
    restrictedPortOf: () => 0,
    overrideAnnouncedPort: () => 0,
    loadSettings: () => ({}),
    saveSettings: () => true,
    updCtx: () => ({}),
    killTree: (child) => { child.killed = true; },
    waitForProcExit: async () => {},
    isQuitting: () => false,
    isRestarting: () => false,
    onProcessChanged: (child) => processChanges.push(child),
    onUnexpectedExit: (info) => unexpected.push(info),
    log: () => {},
    httpImpl: httpStub,
  });
  return { dir, children, processChanges, unexpected, supervisor };
}

test('supervisor owns dsh startup and exposes the running state', async () => {
  const ctx = makeSupervisor();
  try {
    const started = ctx.supervisor.start();
    await new Promise((resolve) => setImmediate(resolve));
    ctx.children[0].stdout.write('dsh web: http://127.0.0.1:23456\n');
    assert.equal(await started, 'http://127.0.0.1:23456');
    assert.equal(ctx.supervisor.getState(), 'running');
    assert.equal(ctx.supervisor.isAlive(), true);
    assert.equal(ctx.processChanges.at(-1), ctx.children[0]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('supervisor marks an early child exit as failed and reports its log path', async () => {
  const ctx = makeSupervisor();
  try {
    const started = ctx.supervisor.start();
    await new Promise((resolve) => setImmediate(resolve));
    const child = ctx.children[0];
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await assert.rejects(started, /dsh web 启动失败/);
    assert.equal(ctx.supervisor.getState(), 'failed');
    assert.equal(ctx.unexpected.length, 0);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('supervisor reports an unexpected exit after the service was ready', async () => {
  const ctx = makeSupervisor();
  try {
    const started = ctx.supervisor.start();
    await new Promise((resolve) => setImmediate(resolve));
    const child = ctx.children[0];
    child.stdout.write('dsh web: http://127.0.0.1:23456\n');
    await started;
    child.exitCode = 7;
    child.emit('exit', 7, 'SIGTERM');
    assert.equal(ctx.supervisor.getState(), 'failed');
    assert.equal(ctx.supervisor.getProcess(), null);
    assert.equal(ctx.unexpected.length, 1);
    assert.match(ctx.unexpected[0].logPath, /dsh-web\.log$/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

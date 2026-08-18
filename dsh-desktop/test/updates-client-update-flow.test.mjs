import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClientUpdateFlow } from '../client-update-flow.js';

// 组件测试：客户端自更新流程（updates/client-update-flow.js）。
// clientUpdater / showBox / 更新弹窗全部桩注入，settings 用内存对象。

function makeFlow(overrides = {}) {
  const settings = {};
  const calls = { boxes: [], restart: [], busy: false, release: null };
  const flow = createClientUpdateFlow({
    isWin: true,
    getQuitting: () => false,
    getClientUpdateBusy: () => calls.busy,
    setClientUpdateBusy: (v) => { calls.busy = v; },
    showBox: (opts) => {
      calls.boxes.push(opts);
      return Promise.resolve({ response: calls.nextResponse ?? 0 });
    },
    showUpdateWindow: () => ({ isDestroyed: () => false, destroy() {} }),
    makeUpdateProgressPusher: () => ({ force() {}, client() {} }),
    ensureGuard: () => ({ snapshot: () => true }),
    restartWithClientUpdate: (_ctx, pending) => { calls.restart.push(pending); },
    clientUpdater: {
      checkLatest: async () => calls.release || { version: '4.4.0', isNewer: true, source: 'github', body: '' },
      releaseFallbacks: async () => [],
      downloadRelease: async () => ({ filePath: path.join(os.tmpdir(), 'dsh-new.zip'), size: 1024 }),
    },
    updater: { compareVersions: (a, b) => (a === b ? 0 : a > b ? 1 : -1) },
    updCtx: () => ({}),
    loadSettings: () => settings,
    saveSettings: (_c, s) => Object.assign(settings, s),
    APP_VERSION: '4.3.0',
    fs, log: () => {},
    ...overrides,
  });
  return { flow, settings, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test('非 Windows：手动提示走包管理器，自动静默', async () => {
  const m1 = makeFlow({ isWin: false });
  await m1.flow.runClientUpdateFlow(true);
  assert.equal(m1.calls.boxes.length, 1);
  assert.ok(m1.calls.boxes[0].message.includes('系统包管理器'));
  const m2 = makeFlow({ isWin: false });
  await m2.flow.runClientUpdateFlow(false);
  assert.equal(m2.calls.boxes.length, 0);
});

test('更新进行中：手动提示稍候', async () => {
  const m = makeFlow({ getClientUpdateBusy: () => true });
  await m.flow.runClientUpdateFlow(true);
  assert.equal(m.calls.boxes.length, 1);
  assert.ok(m.calls.boxes[0].message.includes('正在进行'));
});

test('检查失败：手动弹错误框', async () => {
  const m = makeFlow({
    clientUpdater: { checkLatest: async () => { throw new Error('network down'); } },
  });
  await m.flow.runClientUpdateFlow(true);
  assert.equal(m.calls.boxes.length, 1);
  assert.ok(m.calls.boxes[0].title.includes('失败'));
});

test('已是最新：手动提示，自动静默', async () => {
  const m = makeFlow({
    clientUpdater: {
      checkLatest: async () => ({ version: '4.3.0', isNewer: false, source: 'github' }),
    },
  });
  await m.flow.runClientUpdateFlow(true);
  assert.equal(m.calls.boxes.length, 1);
  assert.ok(m.calls.boxes[0].message.includes('已是最新'));
});

test('跳过/稍后版本：自动模式不再打扰', async () => {
  const m = makeFlow();
  m.settings.skipClientVersion = '4.4.0';
  await m.flow.runClientUpdateFlow(false);
  assert.equal(m.calls.boxes.length, 0);
  m.settings.skipClientVersion = null;
  m.settings.pendingClientVersion = '4.4.0';
  await m.flow.runClientUpdateFlow(false);
  assert.equal(m.calls.boxes.length, 0);
});

test('自动接受：下载 → 记录待装 → 触发重启', async () => {
  const old = process.env.DSH_DESKTOP_TEST_AUTO_UPDATE;
  process.env.DSH_DESKTOP_TEST_AUTO_UPDATE = '1';
  try {
    const m = makeFlow();
    await m.flow.runClientUpdateFlow(true);
    assert.ok(m.settings.pendingClientUpdate, '应记录待装更新');
    assert.equal(m.settings.pendingClientUpdate.version, '4.4.0');
    assert.equal(m.calls.restart.length, 1, '应立即重启安装');
    assert.equal(m.calls.busy, false, 'finally 应复位 busy');
  } finally {
    if (old === undefined) delete process.env.DSH_DESKTOP_TEST_AUTO_UPDATE;
    else process.env.DSH_DESKTOP_TEST_AUTO_UPDATE = old;
  }
});

test('用户选「稍后」：记录版本不下载', async () => {
  const m = makeFlow();
  m.calls.nextResponse = 2;
  await m.flow.runClientUpdateFlow(true);
  assert.equal(m.settings.pendingClientVersion, '4.4.0');
  assert.ok(!m.settings.pendingClientUpdate, '不应下载');
});

test('用户选「跳过此版本」：记录跳过不下载', async () => {
  const m = makeFlow();
  m.calls.nextResponse = 1;
  await m.flow.runClientUpdateFlow(true);
  assert.equal(m.settings.skipClientVersion, '4.4.0');
  assert.ok(!m.settings.pendingClientUpdate);
});

test('offerPendingClientUpdate：文件缺失/版本过期清标记，有效则提示安装', async () => {
  const m = makeFlow();
  m.settings.pendingClientUpdate = { version: '4.4.0', path: path.join(os.tmpdir(), 'missing.zip'), source: 'github' };
  m.flow.offerPendingClientUpdate();
  await flush();
  assert.equal(m.settings.pendingClientUpdate, null, '文件缺失应清标记');
  assert.equal(m.calls.boxes.length, 0);

  const m2 = makeFlow();
  const valid = path.join(os.tmpdir(), 'dsh-valid.zip');
  fs.writeFileSync(valid, 'x');
  m2.settings.pendingClientUpdate = { version: '4.3.0', path: valid, source: 'github' }; // 不新于当前
  m2.flow.offerPendingClientUpdate();
  await flush();
  assert.equal(m2.settings.pendingClientUpdate, null, '版本不新应清标记');

  const m3 = makeFlow();
  m3.settings.pendingClientUpdate = { version: '4.4.0', path: valid, source: 'github' };
  m3.flow.offerPendingClientUpdate();
  await flush();
  assert.equal(m3.calls.boxes.length, 1, '有效待装应弹提示');
  assert.equal(m3.calls.restart.length, 1, '确认后应重启安装');
  fs.rmSync(valid, { force: true });
});

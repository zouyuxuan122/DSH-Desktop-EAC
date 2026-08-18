import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IPC_CONTRACTS,
  PUSH_CHANNELS,
  channelContract,
  validatePayload,
} from '../ipc/contracts.js';

// 契约表（ipc/contracts.js）的防漂移测试：
// 1. 与 main.js 的 ipcMain.handle/on 注册双向一致 —— 新增/改名/漏改都报错；
// 2. preload / onboarding-preload 调用的通道必须在表内；
// 3. 主进程推送通道登记与 preload 的 ipcRenderer.on 一致；
// 4. validatePayload 的形状/类型/必填校验行为。

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = fs.readFileSync(join(root, 'main.js'), 'utf8');
const registerIpcSrc = fs.readFileSync(join(root, 'ipc', 'register-ipc.js'), 'utf8');
const preloadSrc = fs.readFileSync(join(root, 'preload.js'), 'utf8');
const onboardingPreloadSrc = fs.readFileSync(join(root, 'assets', 'onboarding-preload.js'), 'utf8');

function registeredChannels(src) {
  const out = new Set();
  const re = /ipcMain\.(?:handle|on)\('([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

function rendererInvokedChannels(...srcs) {
  const out = new Set();
  const re = /(?:ipcRenderer\.)?(?:invoke|send)\('([^']+)'/g;
  for (const src of srcs) {
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
  }
  return out;
}

test('契约表与 IPC 注册（main.js + ipc/register-ipc.js）双向一致（防漂移）', () => {
  const contractChannels = new Set(IPC_CONTRACTS.map((c) => c.channel));
  const registered = new Set([
    ...registeredChannels(mainSrc),
    ...registeredChannels(registerIpcSrc),
  ]);
  assert.ok(registered.size >= 30, '应识别出 30+ 个注册通道，实际 ' + registered.size);
  const missingInMain = [...contractChannels].filter((ch) => !registered.has(ch));
  const notInTable = [...registered].filter((ch) => !contractChannels.has(ch));
  assert.deepEqual(missingInMain, [], '契约表有但未注册: ' + missingInMain.join(', '));
  assert.deepEqual(notInTable, [], '已注册但契约表缺失: ' + notInTable.join(', '));
});

test('preload / onboarding-preload 调用的通道都在契约表内', () => {
  const contractChannels = new Set(IPC_CONTRACTS.map((c) => c.channel));
  const invoked = rendererInvokedChannels(preloadSrc, onboardingPreloadSrc);
  assert.ok(invoked.size >= 25, 'preload 应识别出 25+ 个通道，实际 ' + invoked.size);
  const notInTable = [...invoked].filter((ch) => !contractChannels.has(ch));
  assert.deepEqual(notInTable, [], 'preload 调用但契约表缺失: ' + notInTable.join(', '));
});

test('推送通道登记与 preload 的 ipcRenderer.on 一致', () => {
  const onChannels = new Set();
  const re = /ipcRenderer\.on\('([^']+)'/g;
  let m;
  while ((m = re.exec(preloadSrc)) !== null) onChannels.add(m[1]);
  assert.deepEqual([...onChannels].sort(), [...PUSH_CHANNELS].sort());
});

test('契约表内部一致性：channel 唯一、字段合法、request.keys 无重复', () => {
  const channels = IPC_CONTRACTS.map((c) => c.channel);
  assert.equal(new Set(channels).size, channels.length, 'channel 必须唯一');
  const unauthorizedCodes = [
    'null', 'array-empty', 'unauthorized', 'forbidden', 'ok-false', 'state', 'ignore', 'balance-cache',
  ];
  for (const c of IPC_CONTRACTS) {
    assert.ok(['handle', 'on'].includes(c.kind), c.channel + ' kind 非法');
    assert.ok(typeof c.sender === 'string' && c.sender.length > 0, c.channel + ' 缺 sender');
    assert.ok(unauthorizedCodes.includes(c.unauthorized), c.channel + ' unauthorized 非法: ' + c.unauthorized);
    assert.equal(typeof c.idempotent, 'boolean', c.channel + ' idempotent 缺失');
    assert.ok(typeof c.response === 'string' && c.response.length > 0, c.channel + ' 缺 response 说明');
    if (c.request) {
      assert.ok(Array.isArray(c.request.keys) && c.request.keys.length > 0, c.channel + ' request.keys 为空');
      assert.equal(new Set(c.request.keys).size, c.request.keys.length, c.channel + ' request.keys 重复');
      if (c.request.required) {
        for (const k of c.request.required) {
          assert.ok(c.request.keys.includes(k), c.channel + ' required 不在 keys 中: ' + k);
        }
      }
      for (const k of Object.keys(c.request.types || {})) {
        assert.ok(c.request.keys.includes(k), c.channel + ' types 引用未声明 key: ' + k);
      }
    }
  }
});

test('channelContract：查找与未命中', () => {
  assert.equal(channelContract('chrome:init').domain, 'chrome');
  assert.equal(channelContract('dsh:file-revert').sender, 'main-window');
  assert.equal(channelContract('dsh:file-open').unauthorized, 'forbidden');
  assert.equal(channelContract('nonexistent:channel'), null);
});

test('validatePayload：无载荷通道传空为合法', () => {
  const r = validatePayload('chrome:recovery-state', undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('validatePayload：必填键缺失', () => {
  const r = validatePayload('chrome:window', {});
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('action')));
  assert.equal(validatePayload('chrome:restart-service', undefined).ok, false);
  assert.equal(validatePayload('dsh:file-open', {}).ok, false);
});

test('validatePayload：非对象载荷一律拒绝', () => {
  for (const bad of [null, 42, 'x', true, [1, 2]]) {
    const r = validatePayload('dsh:file-open', bad);
    assert.equal(r.ok, false, '应拒绝 ' + JSON.stringify(bad));
  }
});

test('validatePayload：未知键', () => {
  const r = validatePayload('dsh:plugin-list', { surprise: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('surprise')));
});

test('validatePayload：类型不符', () => {
  const r = validatePayload('chrome:window', { action: 42 });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('action')));
});

test('validatePayload：合法载荷', () => {
  assert.equal(validatePayload('chrome:window', { action: 'close' }).ok, true);
  assert.equal(validatePayload('dsh:plugin-set-enabled', { id: 'x', enabled: true }).ok, true);
  assert.equal(validatePayload('dsh:balance-prices-set', { model: 'v4-flash', prices: {} }).ok, true);
  assert.equal(validatePayload('dsh:file-revert', { changes: [{ path: '/a', oldText: '', newText: 'b' }] }).ok, true);
});

test('validatePayload：未知通道', () => {
  const r = validatePayload('nope:never', {});
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('unknown channel')));
});

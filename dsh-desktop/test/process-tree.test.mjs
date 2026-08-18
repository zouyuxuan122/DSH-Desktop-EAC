import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessTree } from '../platform/process-tree.js';

// 组件测试（plan Phase 4）：全部通过注入的 fake child process 原语驱动，
// 不产生真实进程，也不依赖当前平台 —— win/posix 两个分支都能在任一宿主机验证。

function fakeDeps(overrides = {}) {
  const timers = [];
  const spawnCalls = [];
  const signals = [];
  const logs = [];
  const deps = {
    spawnImpl: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return {}; },
    execSyncImpl: () => '',
    killSignal: (pid, signal) => {
      if (signal === 0) throw new Error('dead');
      signals.push([pid, signal]);
    },
    log: (tag, msg) => logs.push({ tag, msg }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    ...overrides,
  };
  return { tree: createProcessTree(deps), timers, spawnCalls, signals, logs };
}

const proc = (pid, extra = {}) => ({ pid, exitCode: null, kill() {}, ...extra });

test('killTree：空参数安全，不抛错不产生任何调用', () => {
  const { tree, spawnCalls, signals } = fakeDeps({ platform: 'linux' });
  tree.killTree(null);
  tree.killTree(undefined);
  tree.killTree({});
  tree.killTree({ pid: 0 });
  assert.equal(spawnCalls.length, 0);
  assert.equal(signals.length, 0);
});

test('killTree POSIX：先 SIGTERM 进程组，1.5s 后仍未退则补 SIGKILL 进程组', () => {
  const { tree, timers, signals } = fakeDeps({ platform: 'linux' });
  tree.killTree(proc(42));
  assert.deepEqual(signals, [[-42, 'SIGTERM']]);
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.deepEqual(signals, [[-42, 'SIGTERM'], [-42, 'SIGKILL']]);
});

test('killTree POSIX：组信号失败时回退到主 PID', () => {
  const killed = [];
  const { tree, timers, signals } = fakeDeps({
    platform: 'linux',
    killSignal: (pid, signal) => {
      if (signal === 0) throw new Error('dead');
      if (pid < 0) throw new Error('no group');
      signals.push([pid, signal]);
    },
  });
  tree.killTree(proc(42, { kill: (sig) => killed.push(sig) }));
  assert.deepEqual(killed, ['SIGTERM']);
  timers[0].fn(); // SIGKILL 组失败 → 主 PID 兜底
  assert.deepEqual(signals, [[42, 'SIGKILL']]);
});

test('killTree win32：先优雅 taskkill /T，1.5s 后仍存活才补 /T /F', () => {
  const { tree, timers, spawnCalls } = fakeDeps({
    platform: 'win32',
    execSyncImpl: () => '"node.exe","42","Console",...',
  });
  tree.killTree(proc(42));
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['/pid', '42', '/T']);
  timers[0].fn();
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[1].args, ['/pid', '42', '/T', '/F']);
});

test('killTree win32：进程已退出不补 /F', () => {
  const { tree, timers, spawnCalls } = fakeDeps({
    platform: 'win32',
    execSyncImpl: () => 'INFO: No tasks are running',
  });
  tree.killTree(proc(42));
  timers[0].fn();
  assert.equal(spawnCalls.length, 1);
});

test('killTree win32：tasklist 探测失败视为已退出，不补 /F', () => {
  const { tree, timers, spawnCalls } = fakeDeps({
    platform: 'win32',
    execSyncImpl: () => { throw new Error('EPIPE'); },
  });
  tree.killTree(proc(42));
  timers[0].fn();
  assert.equal(spawnCalls.length, 1);
});

test('killTreeAndWait：null / 已退出的进程直接返回，不发送信号', async () => {
  const { tree, signals, spawnCalls } = fakeDeps({ platform: 'linux' });
  await tree.killTreeAndWait(null);
  await tree.killTreeAndWait(proc(7, { exitCode: 0 }));
  assert.equal(signals.length, 0);
  assert.equal(spawnCalls.length, 0);
});

test('killTreeAndWait POSIX：优雅 → 等退出 → 仍存活则强杀，全程有界', async () => {
  const { tree, signals } = fakeDeps({ platform: 'linux' });
  const p = proc(7);
  await tree.killTreeAndWait(p, { graceMs: 0, hardMs: 0 });
  // SIGTERM → 存活探测(signal 0,抛错视为已死) → SIGKILL → 存活探测
  const sigs = signals.map(([pid, sig]) => sig);
  assert.ok(sigs.includes('SIGTERM'));
  assert.ok(sigs.includes('SIGKILL'));
});

test('killTreeAndWait POSIX：宽限期后进程已退出则不补强杀', async () => {
  const p = proc(7);
  const { tree, signals } = fakeDeps({
    platform: 'linux',
    // 第一次存活探测时“进程已退出”：置 exitCode 并抛错
    killSignal: (pid, signal) => {
      if (signal === 0) { p.exitCode = 0; throw new Error('dead'); }
      signals.push([pid, signal]);
    },
  });
  await tree.killTreeAndWait(p, { graceMs: 0, hardMs: 0 });
  assert.deepEqual(signals, [[-7, 'SIGTERM']]); // 无 SIGKILL
});

test('killTreeAndWait win32：优雅 /T → 探测存活 → /T /F，全程有界', async () => {
  const { tree, spawnCalls } = fakeDeps({
    platform: 'win32',
    execSyncImpl: () => '"node.exe","7","Console",...',
  });
  await tree.killTreeAndWait(proc(7), { graceMs: 0, hardMs: 0 });
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[0].args, ['/pid', '7', '/T']);
  assert.deepEqual(spawnCalls[1].args, ['/pid', '7', '/T', '/F']);
});

test('killTreeAndWait win32：探测显示已退出则不补 /F', async () => {
  const { tree, spawnCalls } = fakeDeps({
    platform: 'win32',
    execSyncImpl: () => 'INFO: No tasks are running',
  });
  await tree.killTreeAndWait(proc(7), { graceMs: 0, hardMs: 0 });
  assert.equal(spawnCalls.length, 1);
});

test('waitForProcExit：null / 无 pid / 已退出立即 resolve', async () => {
  const { tree, logs } = fakeDeps({ platform: 'linux' });
  await tree.waitForProcExit(null, 1000);
  await tree.waitForProcExit({ pid: 0 }, 1000);
  await tree.waitForProcExit(proc(5, { exitCode: 1 }), 1000);
  assert.equal(logs.length, 0);
});

test('waitForProcExit POSIX：进程已退出立即 resolve，不记录超时', async () => {
  const { tree, logs } = fakeDeps({ platform: 'linux' });
  await tree.waitForProcExit(proc(5), 0); // signal 0 抛错 → 已死
  assert.equal(logs.length, 0);
});

test('waitForProcExit POSIX：组存活且超时 → 放行并记录日志', async () => {
  const { tree, logs } = fakeDeps({
    platform: 'linux',
    killSignal: () => {}, // signal 0 一律视为存活
  });
  await tree.waitForProcExit(proc(5), 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].tag, 'service');
  assert.ok(logs[0].msg.includes('超时') && logs[0].msg.includes('5'));
});

test('waitForProcExit win32：tasklist 命中存活 → 超时放行；未命中已退出', async () => {
  const alive = fakeDeps({
    platform: 'win32',
    execSyncImpl: () => '"node.exe","5","Console",...',
  });
  await alive.tree.waitForProcExit(proc(5), 0);
  assert.equal(alive.logs.length, 1);

  const dead = fakeDeps({
    platform: 'win32',
    execSyncImpl: () => 'INFO: No tasks are running',
  });
  await dead.tree.waitForProcExit(proc(5), 0);
  assert.equal(dead.logs.length, 0);
});

test('pidAliveWin：带引号精确匹配 / 未命中 / 探测失败', () => {
  const hit = fakeDeps({ platform: 'win32', execSyncImpl: () => '"node.exe","123","Console"' });
  assert.equal(hit.tree.pidAliveWin(123), true);
  // 裸子串不得误命中（内存列 "1,234 K" 场景）
  const miss = fakeDeps({ platform: 'win32', execSyncImpl: () => '"node.exe","1234","Console"' });
  assert.equal(miss.tree.pidAliveWin(123), false);
  const fail = fakeDeps({ platform: 'win32', execSyncImpl: () => { throw new Error('EPIPE'); } });
  assert.equal(fail.tree.pidAliveWin(123), false);
});

test('默认工厂（无注入）可创建且空调用安全', () => {
  const tree = createProcessTree();
  tree.killTree(null);
  tree.killTreeAndWait(null);
  tree.waitForProcExit(null, 100);
  assert.equal(typeof tree.killTree, 'function');
});

// settings.js 契约测试：应用设置存储（<userData>/settings.json）。
//
// 该存储承载端口、托盘、余额价格、更新跳过状态等全应用设置；从 updater.js
// 剥离为独立模块后，这里锁定其行为契约：缺失/损坏文件返回空对象、读写
// 往返保真、写失败必须经 ctx.log 上报而非静默吞掉。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsPath, loadSettings, saveSettings } from '../settings.js';

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-'));
  return { userDataDir: dir, log: () => {} };
}

test('loadSettings returns versioned defaults when the file does not exist (first run)', () => {
  const ctx = makeCtx();
  try {
    assert.deepEqual(loadSettings(ctx), { schemaVersion: 1 });
  } finally {
    rmSync(ctx.userDataDir, { recursive: true, force: true });
  }
});

test('loadSettings preserves corrupt JSON evidence instead of crashing boot', () => {
  const ctx = makeCtx();
  try {
    writeFileSync(settingsPath(ctx), '{broken json');
    assert.deepEqual(loadSettings(ctx), { schemaVersion: 1 });
    assert.ok(readdirSync(ctx.userDataDir).some((name) => name.startsWith('settings.json.corrupt-')));
  } finally {
    rmSync(ctx.userDataDir, { recursive: true, force: true });
  }
});

test('save + load roundtrips settings faithfully', () => {
  const ctx = makeCtx();
  try {
    const s = { webPort: 12345, notifyOnTurnEnd: false, balancePrices: { 'deepseek-v4-pro': { input: 1 } } };
    saveSettings(ctx, s);
    assert.deepEqual(loadSettings(ctx), { ...s, schemaVersion: 1 });
    assert.match(readFileSync(settingsPath(ctx), 'utf8'), /\n$/); // 末尾换行，便于 diff/合并
  } finally {
    rmSync(ctx.userDataDir, { recursive: true, force: true });
  }
});

test('saveSettings reports write failures through ctx.log', () => {
  const messages = [];
  const ctx = { userDataDir: '/nonexistent-root-xyz/settings-test', log: (tag, msg) => messages.push(tag + ':' + msg) };
  saveSettings(ctx, { a: 1 });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^settings:/);
  assert.match(messages[0], /保存 settings 失败/);
});

test('loadSettings migrates closeToTray and rejects invalid known field types', () => {
  const ctx = makeCtx();
  try {
    writeFileSync(settingsPath(ctx), JSON.stringify({ closeToTray: false, webPort: 'bad', exitAction: 'invalid' }));
    assert.deepEqual(loadSettings(ctx), {
      schemaVersion: 1,
      closeToTray: false,
      exitAction: 'quit',
    });
  } finally {
    rmSync(ctx.userDataDir, { recursive: true, force: true });
  }
});

test('loadSettings can recover a valid interrupted same-directory write', () => {
  const ctx = makeCtx();
  try {
    writeFileSync(settingsPath(ctx) + '.tmp-interrupted', JSON.stringify({ webPort: 23456 }));
    assert.deepEqual(loadSettings(ctx), { schemaVersion: 1, webPort: 23456 });
    assert.ok(existsSync(settingsPath(ctx)));
  } finally {
    rmSync(ctx.userDataDir, { recursive: true, force: true });
  }
});

test('updater.js re-exports the settings API for backward compatibility', async () => {
  const updater = await import('../updater.js');
  assert.equal(typeof updater.loadSettings, 'function');
  assert.equal(typeof updater.saveSettings, 'function');
});

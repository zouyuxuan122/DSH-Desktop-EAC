import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProfileGuard } from '../profile/profile-guard.js';

// 组件测试：共享 profile 迁移 / 皮肤落位 / junction 巡检 / 外部 dsh 探测。
// fs/path/os 真实（临时目录），updater/guard/Notification 桩注入。

class StubNotification {
  on() { return this; }
  show() {}
}

function makeGuard(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-guard-'));
  const home = path.join(root, 'home');
  const oldDir = path.join(home, 'profiles', 'web');
  const newDir = path.join(home, 'profiles', 'web-desktop');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const settings = {};
  const logs = [];
  const guard = createProfileGuard({
    isWin: false,
    getDshHome: () => home,
    getQuitting: () => false,
    getRestartingServer: () => false,
    getServerProc: () => null,
    ensureGuard: () => ({ junctionFindings: () => [], repairJunctions: () => ({ repaired: [] }) }),
    showMainWindow: () => {},
    Notification: StubNotification,
    updater: {
      loadSettings: () => settings,
      saveSettings: (_ctx, s) => Object.assign(settings, s),
    },
    updCtx: () => ({}),
    desktopProfileDir: () => newDir,
    readJsonFile: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } },
    loadBuiltinPluginState: () => ({ plugins: {} }),
    setBuiltinPluginState: () => {},
    DESKTOP_PROFILE: 'web-desktop',
    COMPANION_PLUGINS: [{ id: 'dsh-balance', name: '@deepseek-ai/dsh-balance' }],
    fs, path, os,
    log: (tag, msg) => logs.push({ tag, msg }),
    execSyncImpl: () => '',
    ...overrides,
  });
  return { guard, root, home, oldDir, newDir, settings, logs };
}

test('migrateFromSharedWebProfile：迁移旧 profile、记录皮肤、清理桌面痕迹、幂等', () => {
  const { guard, oldDir, settings } = makeGuard();
  const patchFile = path.join(oldDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile,
    '- insert:\n    - id: dsh-balance\n      name: \'@deepseek-ai/dsh-balance\'\n' +
    '- id: ui-skin-xp\n  name: \'@deepseek-ai/dsh-skin-xp\'\n');
  fs.writeFileSync(path.join(oldDir, '.dsh-builtin-plugins.json'),
    JSON.stringify({ names: ['@deepseek-ai/dsh-balance'] }));
  fs.mkdirSync(path.join(oldDir, 'node_modules', '@deepseek-ai', 'dsh-balance'), { recursive: true });

  guard.migrateFromSharedWebProfile();
  assert.ok(typeof settings.desktopProfileMigrated === 'string', '应写入迁移标记');
  assert.equal(settings.legacySkinChoice, 'ui-skin-xp', '应记录用户启用的皮肤');
  const patch = fs.readFileSync(patchFile, 'utf8');
  assert.ok(!patch.includes('dsh-balance'), '旧 profile 的桌面配套行应被清理');
  assert.ok(!fs.existsSync(path.join(oldDir, '.dsh-builtin-plugins.json')), '内置清单标记应删除');

  // 幂等：标记已写入，二次运行不再改动
  const before = fs.readFileSync(patchFile, 'utf8');
  guard.migrateFromSharedWebProfile();
  assert.equal(fs.readFileSync(patchFile, 'utf8'), before);
});

test('migrateFromSharedWebProfile：共享模式用户不动旧 profile', () => {
  const { guard, oldDir } = makeGuard();
  fs.writeFileSync(path.join(oldDir, '.dsh-builtin-plugins.json'), '{"names":[]}');
  const settings = { shareWebProfile: true };
  const g = makeGuard({
    updater: {
      loadSettings: () => settings,
      saveSettings: (_c, s) => Object.assign(settings, s),
    },
  });
  g.guard.migrateFromSharedWebProfile();
  assert.ok(fs.existsSync(path.join(oldDir, '.dsh-builtin-plugins.json')), '共享模式不应清理旧 profile');
});

test('applyLegacySkinChoice：去掉迁移皮肤的 disabled 并清除标记', () => {
  const { guard, newDir, settings } = makeGuard();
  const patchFile = path.join(newDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile,
    '- insert:\n    - id: ui-skin-xp\n      name: \'@deepseek-ai/dsh-skin-xp\'\n      disabled: true\n' +
    '    - id: ui-skin-qq98\n      name: \'@deepseek-ai/dsh-skin-qq98\'\n      disabled: true\n');
  settings.legacySkinChoice = 'ui-skin-xp';
  guard.applyLegacySkinChoice();
  const patch = fs.readFileSync(patchFile, 'utf8');
  const xpBlock = patch.slice(patch.indexOf('ui-skin-xp'), patch.indexOf('ui-skin-qq98'));
  assert.ok(!xpBlock.includes('disabled: true'), '迁移皮肤的 disabled 应移除');
  const qq98Block = patch.slice(patch.indexOf('ui-skin-qq98'));
  assert.ok(qq98Block.includes('disabled: true'), '其它皮肤保持禁用');
  assert.ok(!('legacySkinChoice' in settings), '迁移标记应清除');
});

test('detectExternalDsh：非 Windows 直接返回无外部进程', async () => {
  const { guard } = makeGuard(); // isWin: false
  assert.deepEqual(await guard.detectExternalDsh(), { running: false, pids: [] });
});

test('detectExternalDsh：Windows 下识别外部 dsh 进程并排除自身', async () => {
  const ownPid = process.pid;
  const base = {
    isWin: true,
    execSyncImpl: () => JSON.stringify([
      { ProcessId: 12345, CommandLine: 'C:\\node.exe C:\\dsh\\bin.js web --port 8080' },
      { ProcessId: ownPid, CommandLine: 'node C:\\app\\bin.js web' },
    ]),
  };
  const g1 = makeGuard(base);
  const res = await g1.guard.detectExternalDsh();
  assert.equal(res.running, true);
  assert.deepEqual(res.pids, [12345], '自身 PID 应被排除');

  const g2 = makeGuard({ isWin: true, execSyncImpl: () => JSON.stringify([{ ProcessId: 999, CommandLine: 'node unrelated.js' }]) });
  assert.deepEqual(await g2.guard.detectExternalDsh(), { running: false, pids: [] }, '无关进程不算');

  const g3 = makeGuard({ isWin: true, execSyncImpl: () => { throw new Error('CIM 失败'); } });
  assert.deepEqual(await g3.guard.detectExternalDsh(), { running: false, pids: [] }, '查询失败按无外部进程');
});

test('startJunctionWatchdog：非 Windows 直接返回', () => {
  const { guard } = makeGuard();
  assert.equal(guard.startJunctionWatchdog(), undefined);
});

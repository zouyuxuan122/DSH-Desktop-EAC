import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginManager } from '../profile/plugin-manager.js';
import { collectPluginRows } from '../plugin-manager-state.js';
import { togglePluginInPatch, removePluginFromPatch, hasEntryId } from '../scripts/plugin-manager-patch.js';

// 组件测试：插件启停/卸载管理（profile/plugin-manager.js）。
// 纯文本手术（scripts/plugin-manager-patch.js）与 collectPluginRows 用真实
// 实现，其余外部依赖桩注入；fs/path/os 真实，跑在临时目录。

function makeManager(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-manager-'));
  const profileDir = path.join(root, 'web-desktop');
  const pluginsSrc = path.join(root, 'plugins');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(pluginsSrc, { recursive: true });
  for (const name of ['dsh-balance', 'dsh-pet']) {
    fs.mkdirSync(path.join(pluginsSrc, name), { recursive: true });
    fs.writeFileSync(path.join(pluginsSrc, name, 'package.json'), JSON.stringify({ name }));
  }
  const settings = {};
  const manager = createPluginManager({
    desktopProfileDir: () => profileDir,
    ensureDesktopProfileInit: () => {},
    builtinPluginSourceDir: (name) => path.join(pluginsSrc, name),
    copyPluginPackage: () => {},
    removeOwnedPluginPackage: () => ({ ok: true, removed: 1 }),
    collectPluginRows,
    loadBuiltinPluginState: () => ({ plugins: {} }),
    setBuiltinPluginState: () => {},
    clearBuiltinPluginState: () => {},
    COMPANION_PLUGINS: [
      { id: 'dsh-balance', name: '@deepseek-ai/dsh-balance' },
      { id: 'dsh-pet', name: '@deepseek-ai/dsh-pet', disabled: true },
    ],
    onboardingLogic: { CORE_PLUGIN_IDS: new Set(['dsh-balance']) },
    updater: {
      loadSettings: () => settings,
      saveSettings: (_ctx, s) => Object.assign(settings, s),
    },
    updCtx: () => ({}),
    readJsonFile: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } },
    togglePluginInPatch,
    removePluginFromPatch,
    hasEntryId,
    configLinesFor: () => '',
    ensureGuard: () => ({ snapshot: () => true }),
    syncCompanionPlugins: () => {},
    restartWebServiceCore: async () => ({ ok: true }),
    recoverWebServiceAfterPluginFailure: async () => {},
    getServerProc: () => null,
    getRestartingServer: () => false,
    fs, path, os,
    log: () => {},
    ...overrides,
  });
  return { manager, profileDir, root, settings };
}

const patchFile = (profileDir) => path.join(profileDir, 'cordis.patch.yml');

test('removedPluginIds / saveRemovedPluginIds：settings 往返', () => {
  const { manager, settings } = makeManager();
  assert.deepEqual([...manager.removedPluginIds()], []);
  manager.saveRemovedPluginIds(new Set(['dsh-pet', 'x']));
  assert.deepEqual([...manager.removedPluginIds()].sort(), ['dsh-pet', 'x']);
  assert.deepEqual(settings.removedPlugins, ['dsh-pet', 'x']);
});

test('pluginManagerResolveName：配套清单优先，patch 兜底', () => {
  const { manager, profileDir } = makeManager();
  assert.equal(manager.pluginManagerResolveName('dsh-balance'), '@deepseek-ai/dsh-balance');
  // patch 兜底：自定义 insert 行
  fs.writeFileSync(patchFile(profileDir),
    '- insert:\n    - id: custom-thing\n      name: \'@scope/custom-thing\'\n');
  assert.equal(manager.pluginManagerResolveName('custom-thing'), '@scope/custom-thing');
  assert.equal(manager.pluginManagerResolveName('nope'), '');
});

test('pluginManagerSetEnabled：关闭写 disabled，开启移除 disabled', () => {
  const { manager, profileDir } = makeManager();
  fs.writeFileSync(patchFile(profileDir), '- insert:\n    - id: dsh-pet\n      name: \'@deepseek-ai/dsh-pet\'\n');
  const off = manager.pluginManagerSetEnabled('dsh-pet', false);
  assert.equal(off.ok, true);
  assert.ok(fs.readFileSync(patchFile(profileDir), 'utf8').includes('disabled: true'), '关闭应写入 disabled');
  const on = manager.pluginManagerSetEnabled('dsh-pet', true);
  assert.equal(on.ok, true);
  assert.ok(!fs.readFileSync(patchFile(profileDir), 'utf8').includes('disabled: true'), '开启应移除 disabled');
});

test('pluginManagerSetEnabled：无法解析包名时拒绝', () => {
  const { manager, profileDir } = makeManager();
  fs.writeFileSync(patchFile(profileDir), '[]\n');
  const res = manager.pluginManagerSetEnabled('ghost', false);
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('无法解析插件包名'));
});

test('pluginManagerCollect：核心/配套/用户插件行齐全', () => {
  const { manager, profileDir } = makeManager();
  fs.writeFileSync(patchFile(profileDir),
    '- insert:\n    - id: dsh-balance\n      name: \'@deepseek-ai/dsh-balance\'\n' +
    '    - id: dsh-pet\n      name: \'@deepseek-ai/dsh-pet\'\n' +
    '    - id: market-thing\n      name: \'@user/market-thing\'\n');
  const rows = manager.pluginManagerCollect();
  assert.ok(rows.length >= 3, '应收集到 3+ 行，实际 ' + rows.length);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('dsh-balance'));
  assert.ok(ids.includes('dsh-pet'));
  assert.ok(ids.includes('market-thing'));
});

test('pluginManagerUninstall：服务未运行直接卸载并触发同步', async () => {
  let synced = 0;
  const { manager, profileDir } = makeManager({ syncCompanionPlugins: () => { synced += 1; } });
  fs.writeFileSync(patchFile(profileDir),
    '- insert:\n    - id: dsh-pet\n      name: \'@deepseek-ai/dsh-pet\'\n');
  const res = await manager.pluginManagerUninstall('dsh-pet');
  assert.equal(res.ok, true);
  assert.equal(res.state, 'uninstalled');
  assert.equal(synced, 1, '卸载后应触发一次配套同步');
});

test('pluginManagerSetRemoved：核心插件拒绝移除', () => {
  const { manager } = makeManager();
  const res = manager.pluginManagerSetRemoved('dsh-balance', true);
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('核心插件不可移除'));
});

test('imagePasteSave：合法 data URL 落盘 / 非法输入拒绝', () => {
  const { manager } = makeManager();
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const saved = manager.imagePasteSave(png, '截图');
  assert.equal(saved.ok, true);
  assert.ok(saved.path.endsWith('.png'));
  assert.ok(fs.existsSync(saved.path), '文件应写入临时目录');
  assert.equal(saved.size, 4);
  fs.rmSync(path.dirname(saved.path), { recursive: true, force: true });

  assert.equal(manager.imagePasteSave('not-a-data-url', 'x').ok, false);
  assert.equal(manager.imagePasteSave('data:image/svg+xml;base64,AAAA', 'x').ok, false, '不支持的 mime 应拒绝');
  const big = 'data:image/png;base64,' + 'A'.repeat(21 * 1024 * 1024);
  const tooBig = manager.imagePasteSave(big, 'x');
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.error.includes('15MB'));
});

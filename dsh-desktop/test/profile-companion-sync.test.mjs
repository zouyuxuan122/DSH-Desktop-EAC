import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCompanionSync } from '../profile/companion-sync.js';

// 组件测试：syncCompanionPlugins 的接线完整性与 patch 幂等逻辑。
// 所有外部依赖用桩注入（缺依赖会在这里抛 TypeError），fs/path 用真实实现
// 操作临时 profile 目录，验证 patch 行生成与二次运行幂等。

class StubNotification {
  on() { return this; }
  show() {}
}

function makeDeps(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-sync-'));
  const home = path.join(root, 'home');
  const profileDir = path.join(root, 'web-desktop');
  const skinsDir = path.join(root, 'skins');
  const assetsPlugins = path.join(root, 'plugins');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(skinsDir, { recursive: true });
  fs.mkdirSync(assetsPlugins, { recursive: true });
  for (const name of ['dsh-balance', 'dsh-pet']) {
    fs.mkdirSync(path.join(assetsPlugins, name), { recursive: true });
    fs.writeFileSync(path.join(assetsPlugins, name, 'package.json'), JSON.stringify({ name }));
  }
  const logs = [];
  const deps = {
    dshHomePath: () => home,
    ensureDesktopProfileInit: () => {},
    applySessionManageFix: () => {},
    patchApiproxyBridgeNamespace: () => {},
    desktopProfileDir: () => profileDir,
    syncBundledPresets: () => ({ installed: [] }),
    ensureDefaultAgentPreset: () => 'kept',
    loadBuiltinPluginState: () => ({ plugins: {} }),
    removedPluginIds: () => new Set(),
    removeOwnedPluginPackage: () => ({ ok: true }),
    builtinPluginSourceDir: (name) => path.join(assetsPlugins, name),
    copyPluginPackage: () => {},
    healSoulMdPatchRow: (patch) => ({ patch, healed: [] }),
    healRowConfig: (patch) => ({ patch, healed: [] }),
    healRowDisabled: (patch) => ({ patch, healed: [] }),
    collectBundleEntryIds: () => new Set(),
    removeBundledRowDuplicates: (patch) => ({ patch, removed: [] }),
    hasEntryId: (patch, id) => patch.includes('id: ' + id),
    configLinesFor: () => '',
    removePluginFromPatch: (patch) => ({ text: patch }),
    applyLegacySkinChoice: () => {},
    showMainWindow: () => {},
    ensureGuard: () => ({ snapshot: () => true }),
    removeMarketDuplicate: () => ({ ok: true, changed: false, removedDep: [], removedRows: [] }),
    COMPANION_PLUGINS: [
      { id: 'dsh-balance', name: '@deepseek-ai/dsh-balance' },
      { id: 'dsh-pet', name: '@deepseek-ai/dsh-pet', disabled: true },
    ],
    SKINS_DIR: skinsDir,
    readJsonFile: () => null,
    fs,
    path,
    Notification: StubNotification,
    log: (tag, msg) => logs.push({ tag, msg }),
    ...overrides,
  };
  return { sync: createCompanionSync(deps).syncCompanionPlugins, profileDir, logs, root };
}

test('syncCompanionPlugins：写入 patch 行与内置清单，二次运行幂等', () => {
  const { sync, profileDir } = makeDeps();
  sync();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const marker = path.join(profileDir, '.dsh-builtin-plugins.json');
  assert.ok(fs.existsSync(patchFile), 'cordis.patch.yml 应被创建');
  const patch = fs.readFileSync(patchFile, 'utf8');
  assert.ok(patch.includes("id: dsh-balance"), 'patch 应包含 dsh-balance 行');
  assert.ok(patch.includes("name: '@deepseek-ai/dsh-balance'"), 'patch 应包含 dsh-balance 包名');
  assert.ok(patch.includes("id: dsh-pet"), 'patch 应包含 dsh-pet 行');
  assert.ok(patch.includes('disabled: true'), '默认禁用插件应带 disabled: true');
  assert.ok(fs.existsSync(marker), '内置插件清单应被写入');
  const mark = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.deepEqual(mark.installed.sort(), ['@deepseek-ai/dsh-balance', '@deepseek-ai/dsh-pet']);

  // 二次运行：已有行不重写，patch 内容不变
  sync();
  assert.equal(fs.readFileSync(patchFile, 'utf8'), patch, '二次同步不应改动 patch');
});

test('syncCompanionPlugins：用户移除的内置插件被跳过且不写行', () => {
  const { sync, profileDir, logs } = makeDeps({
    removedPluginIds: () => new Set(['dsh-pet']),
  });
  sync();
  const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(!patch.includes('id: dsh-pet'), '被移除的插件不应写入 patch');
  assert.ok(patch.includes('id: dsh-balance'));
  assert.ok(logs.some((l) => l.msg.includes('跳过被移除的内置插件')));
});

test('syncCompanionPlugins：源目录无效的配套插件被跳过', () => {
  const { sync, profileDir } = makeDeps({
    builtinPluginSourceDir: (name) => path.join('/nonexistent', name),
  });
  sync();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  if (fs.existsSync(patchFile)) {
    const patch = fs.readFileSync(patchFile, 'utf8');
    assert.ok(!patch.includes('dsh-balance') && !patch.includes('dsh-pet'), '无效源不应写任何行');
  }
});

test('syncCompanionPlugins：皮肤目录的行以 ui-skin-* 登记', () => {
  const realReadJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };
  const { sync, profileDir, root } = makeDeps({ readJsonFile: realReadJson });
  const skinDir = path.join(root, 'skins', 'xp');
  fs.mkdirSync(skinDir, { recursive: true });
  fs.writeFileSync(path.join(skinDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-skin-xp' }));
  fs.writeFileSync(path.join(skinDir, 'skin.json'), JSON.stringify({ wiring: { id: 'ui-skin-xp' } }));
  sync();
  const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('id: ui-skin-xp'), '皮肤应以 ui-skin-xp 登记');
  assert.ok(patch.includes('disabled: true'), '皮肤默认禁用');
});

// 锁死「assets/plugins 目录 ↔ main.js COMPANION_PLUGINS 注册」双向一致。
//
// 背景（Bug #58 排查中发现的两起同类事故）：
//   · dsh-settings-groups 注册行丢失 → 侧边栏「普通/高级」分组整条功能
//     静默失效（用户看到的是平铺列表，无「高级」可折叠）；
//   · dsh-plugin-marketplace 自 v2.0 被替换下架后未再登记，而 v4.3 又在其
//     上重建「内置插件上游更新」标签页（dsh:plugin-updates IPC 唯一消费
//     者）→ 更新链路静默死亡。
// 两者的包目录与功能代码都随包分发，唯独缺一行注册 —— 无任何报错，只能
// 靠用户感知。本测试让这类丢失在 CI 直接红。
//
// V4.6 架构现状：settings-groups 仍是活插件（5.1.1 起只负责常规页页内
// 折叠，侧边栏回归官方原生平铺），必须保持注册；plugin-marketplace 则已被
// dsh-unified-market 取代并列入 RETIRED_BUILTIN_PLUGINS（启动时清理残留）
// —— 守卫方向相反：它绝不能回到 COMPANION_PLUGINS，否则与统一市场重复注
// 册 /api/dsh-market，dsh web 直接以退出码 1 崩溃。
//
// 注意：匹配只看 COMPANION_PLUGINS 数组切片；RETIRED_BUILTIN_PLUGINS 等
// 其他清单里的同名行不算数（那正是 auto-compact 该待的地方）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const syncRoot = join(root, '..', '.sync');
// ADR 0002：COMPANION_PLUGINS / RETIRED_BUILTIN_PLUGINS 已迁至 L2 模块。
const main = readFileSync(join(root, 'lib', 'desktop', 'companion-sync.ts'), 'utf8');
const generatedRegistry = readFileSync(join(root, 'lib', 'desktop', 'plugin-sync-registry.ts'), 'utf8');
const manifest = JSON.parse(readFileSync(join(syncRoot, 'plugins.json'), 'utf8')) as {
  schemaVersion: number;
  generatedRegistry: string;
  plugins: ManifestEntry[];
  skins: ManifestEntry[];
  sdkPlugins: ManifestEntry[];
};
const policies = JSON.parse(readFileSync(join(syncRoot, 'policies.json'), 'utf8')) as {
  inventoryRoots: { kind: string; path: string; manifestKey: string }[];
  runtimeUpdates: { legacySourceCount: number; sourceMapMustBeOneToOne: boolean };
};

interface ManifestEntry {
  id: string;
  kind: 'plugin' | 'skin' | 'sdk-plugin';
  path: string;
  packageName: string;
  class: 'follow-upstream' | 'patched' | 'internal' | 'manual' | 'resource' | 'isolated-sdk';
  source: { kind: string; name?: string; repository?: string; reason?: string };
  request: { mode: string; range?: string; releaseAgeHours?: number; version?: string; commit?: string };
  sync: { mode: string; patches: string[]; preservePaths: string[] };
  runtimeUpdate: { allowed: boolean; defaultAction: string; source?: { kind: string; name?: string; repository?: string } };
  validation: { entrypoints: string[]; commands: string[] };
  license: { expected: string; reviewOnChange: boolean };
  owner: string;
  defaultDisabled?: boolean;
}

function companionSlice() {
  const start = main.indexOf('const COMPANION_PLUGINS');
  assert.ok(start >= 0, 'COMPANION_PLUGINS must exist in lib/desktop/companion-sync.ts');
  const end = main.indexOf('];', start);
  assert.ok(end > start, 'COMPANION_PLUGINS array must be closed');
  return main.slice(start, end);
}

function companionRows() {
  return [...companionSlice().matchAll(
    /\{\s*id:\s*'([^']+)'\s*,\s*name:\s*'([^']+)'(?:\s*,\s*dir:\s*'([^']+)')?/g,
  )].map((match) => ({
    id: match[1],
    packageName: match[2],
    dir: match[3] || (match[2].includes('/') ? match[2].split('/').pop() : match[2]),
  }));
}

function updateSourceRows() {
  const marker = generatedRegistry.match(/plugin-sync:update-sources\s+(\{[^\n]+\})/);
  assert.ok(marker, 'generated registry must contain the runtime source marker');
  const sources = JSON.parse(marker[1]) as Record<string, { npm?: string; github?: string }>;
  return Object.entries(sources).map(([id, source]) => {
    const kind = source.npm ? 'npm' : 'github';
    const value = source.npm || source.github;
    assert.ok(value, `${id} must have a generated source value`);
    return { id, kind, source: value };
  });
}

function allManifestEntries() {
  return [...manifest.plugins, ...manifest.skins, ...manifest.sdkPlugins];
}

function inventoryDirectories(kind: ManifestEntry['kind']) {
  const directory = kind === 'plugin'
    ? join(root, 'assets', 'plugins')
    : kind === 'skin'
      ? join(root, 'assets', 'skins')
      : join(root, 'assets', 'sdk-plugins');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function packageFor(entry: ManifestEntry) {
  return JSON.parse(readFileSync(join(root, entry.path.replace('dsh-desktop/', ''), 'package.json'), 'utf8')) as {
    name: string;
    license?: string;
  };
}

// 有 package.json 但明确不随 COMPANION_PLUGINS 分发的目录（退役等）。
const EXCEPTIONS = new Set([
  'dsh-auto-compact', // 已退役，见 RETIRED_BUILTIN_PLUGINS
  'shared', // EAC 插件共享兼容垫片（0.1.3 内核 API 适配层，非插件，仅被其他插件 import）
]);
test('every vendored plugin dir is registered in COMPANION_PLUGINS', () => {
  const pluginsDir = join(root, 'assets', 'plugins');
  const dirs = readdirSync(pluginsDir).sort();
  const withoutManifest = dirs.filter((d) => !existsSync(join(pluginsDir, d, 'package.json')));
  assert.deepEqual(withoutManifest, [], '插件目录缺少 package.json，可能是已退役插件或不完整安装的残留');
  const slice = companionSlice();
  const missing = [];
  for (const d of dirs) {
    if (EXCEPTIONS.has(d)) continue;
    let name = d;
    try {
      name = JSON.parse(readFileSync(join(pluginsDir, d, 'package.json'), 'utf8')).name || d;
    } catch { /* 包损坏时退回目录名，仍参与检查 */ }
    const byDir = slice.includes(`dir: '${d}'`);
    const byName = slice.includes(`name: '${name}'`);
    if (!byDir && !byName) missing.push(`${d} (${name})`);
  }
  assert.deepEqual(missing, [], '未注册的插件目录 —— 补 COMPANION_PLUGINS 行或加入 EXCEPTIONS 并说明理由');
});

test('every registration row with dir points at a real vendored package', () => {
  const slice = companionSlice();
  const rows = [...slice.matchAll(/dir:\s*'([^']+)'/g)].map((m) => m[1]);
  const bad = rows.filter((d) => !existsSync(join(root, 'assets', 'plugins', d, 'package.json')));
  assert.deepEqual(bad, [], '注册行指向不存在的插件目录');
});

test('manifest covers every bundled plugin, skin, and SDK directory exactly once', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.generatedRegistry, 'dsh-desktop/lib/desktop/plugin-sync-registry.ts');
  assert.deepEqual(policies.inventoryRoots, [
    { kind: 'plugin', path: 'dsh-desktop/assets/plugins', manifestKey: 'plugins' },
    { kind: 'skin', path: 'dsh-desktop/assets/skins', manifestKey: 'skins' },
    { kind: 'sdk-plugin', path: 'dsh-desktop/assets/sdk-plugins', manifestKey: 'sdkPlugins' },
  ]);
  const entries = allManifestEntries();
  assert.equal(manifest.plugins.length, 47);
  assert.equal(manifest.skins.length, 10);
  assert.equal(manifest.sdkPlugins.length, 1);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length, 'manifest ids must be unique');
  for (const kind of ['plugin', 'skin', 'sdk-plugin'] as const) {
    const rows = entries.filter((entry) => entry.kind === kind);
    const manifestDirs = rows.map((entry) => entry.path.split('/').pop()).sort();
    assert.deepEqual(manifestDirs, inventoryDirectories(kind), `${kind} directories must match manifest paths`);
  }
});

test('manifest plugin rows map one-to-one to COMPANION_PLUGINS', () => {
  const registrations = companionRows();
  assert.equal(registrations.length, 47);
  assert.equal(new Set(registrations.map((row) => row.id)).size, registrations.length, 'companion ids must be unique');
  assert.deepEqual(
    manifest.plugins.map((entry) => entry.id).sort(),
    registrations.map((row) => row.id).sort(),
  );
  for (const registration of registrations) {
    const matches = manifest.plugins.filter((entry) => (
      entry.id === registration.id
      && entry.packageName === registration.packageName
      && entry.path.endsWith(`/plugins/${registration.dir}`)
    ));
    assert.equal(matches.length, 1, `${registration.id} must have one matching manifest row`);
  }
});

test('manifest entries agree with package metadata and use explicit source policy', () => {
  const classes = new Set(['follow-upstream', 'patched', 'internal', 'manual', 'resource', 'isolated-sdk']);
  const syncModes = new Set(['mirror', 'patch-rebase', 'metadata-only', 'manual']);
  for (const entry of allManifestEntries()) {
    const pkg = packageFor(entry);
    assert.equal(entry.packageName, pkg.name, `${entry.id} packageName must match package.json`);
    assert.equal(entry.license.expected, pkg.license || 'UNKNOWN', `${entry.id} license must match package.json`);
    assert.ok(classes.has(entry.class), `${entry.id} has an invalid class`);
    assert.ok(syncModes.has(entry.sync.mode), `${entry.id} has an invalid sync mode`);
    assert.ok(entry.owner, `${entry.id} must have an owner`);
    assert.equal(entry.runtimeUpdate.defaultAction, 'prompt');
    assert.equal(entry.license.reviewOnChange, true);
    assert.ok(entry.validation.entrypoints.length > 0, `${entry.id} must declare an entrypoint`);
    const packageRoot = join(root, '..', entry.path);
    assert.ok(entry.validation.entrypoints.every((path) => existsSync(join(packageRoot, path))),
      `${entry.id} declares a missing entrypoint`);
    if (entry.source.kind === 'unknown') {
      assert.ok(entry.source.reason, `${entry.id} unknown source requires a reason`);
      assert.equal(entry.source.repository, undefined, `${entry.id} unknown source must not guess a repository`);
    }
    if (entry.kind === 'skin') {
      assert.equal(entry.class, 'resource');
      assert.equal(entry.sync.mode, 'metadata-only');
      assert.equal(entry.runtimeUpdate.allowed, false);
    }
    if (entry.kind === 'sdk-plugin') {
      assert.equal(entry.class, 'isolated-sdk');
      assert.equal(entry.runtimeUpdate.allowed, false);
    }
  }
});

test('all legacy plugin update sources map to exactly one manifest entry', () => {
  const sources = updateSourceRows();
  const entries = allManifestEntries();
  assert.equal(sources.length, 11);
  assert.equal(policies.runtimeUpdates.legacySourceCount, sources.length);
  assert.equal(policies.runtimeUpdates.sourceMapMustBeOneToOne, true);
  for (const source of sources) {
    const matches = entries.filter((entry) => entry.id === source.id);
    assert.equal(matches.length, 1, `${source.id} must map to exactly one manifest entry`);
    const entry = matches[0];
    assert.equal(entry.runtimeUpdate.allowed, true, `${source.id} must allow its declared runtime source`);
    assert.ok(entry.runtimeUpdate.source, `${source.id} must copy its runtime source into the manifest`);
    assert.equal(entry.runtimeUpdate.source.kind, source.kind);
    if (source.kind === 'npm') assert.equal(entry.runtimeUpdate.source.name, source.source);
    if (source.kind === 'github') assert.equal(entry.runtimeUpdate.source.repository, `https://github.com/${source.source}`);
  }
  const allowedIds = entries.filter((entry) => entry.runtimeUpdate.allowed).map((entry) => entry.id).sort();
  assert.deepEqual(allowedIds, sources.map((source) => source.id).sort(), 'manifest must not add extra runtime update sources');
});

test('companion-sync exports the generated source map without a second hand-maintained table', () => {
  assert.match(main, /from ['"]\.\/plugin-sync-registry['"]/);
  assert.match(main, /export const PLUGIN_UPDATE_SOURCES[^=]*=\s*GENERATED_PLUGIN_UPDATE_SOURCES/);
  assert.doesNotMatch(main, /['"]picturereader['"]\s*:\s*\{\s*npm:/);
});

test('pluginUpdateSources keeps the companion boundary and filters unavailable platforms', () => {
  const start = main.indexOf('export function pluginUpdateSources');
  const end = main.indexOf('/** 内置插件当前生效的源目录', start);
  assert.ok(start >= 0 && end > start, 'pluginUpdateSources must exist');
  const source = main.slice(start, end);
  assert.match(source, /for \(const p of COMPANION_PLUGINS\)/);
  assert.match(source, /companionPluginsForPlatform\(platform\)/);
  assert.match(source, /if \(!available\.has\(p\.id\)\) continue/);
  assert.match(source, /if \(removed\.has\(p\.id\)\) continue/);
  assert.match(source, /path\.join\(assetsDir, 'package\.json'\)/);
});

test('regression: settings-groups stays registered, retired plugins never return', () => {
  const slice = companionSlice();
  assert.doesNotMatch(slice, /dsh-tdai-memory|tdai-memory/, '已退役的 tdai-memory 不得重新进入内置插件清单');
  assert.match(slice, /id:\s*'settings-groups'/, '常规页页内折叠（Bug #58）—— 5.1.1 起唯一存活的设置类辅助插件');
  const retiredStart = main.indexOf('const RETIRED_BUILTIN_PLUGINS');
  assert.ok(retiredStart >= 0, 'RETIRED_BUILTIN_PLUGINS must exist in lib/desktop/companion-sync.ts');
  const retiredSlice = main.slice(retiredStart, main.indexOf('];', retiredStart));
  assert.match(retiredSlice, /id:\s*'plugin-marketplace'/,
    '旧插件市场必须保持退役 —— 复活会与 dsh-unified-market 重复注册 /api/dsh-market（dsh web 退出码 1）');
  assert.match(retiredSlice, /id:\s*'tool-vision'/,
    'dsh-tool-vision 自 4.5.0 被 picturereader 取代，必须保持退役 —— 残留行会渲染空白「视觉模型」卡');
  assert.match(retiredSlice, /id:\s*'settings-nav-custom'/,
    'nav-custom 必须保持退役 —— 用户裁定移除普通/高级分栏，复活会再次接管侧边栏');
  assert.match(retiredSlice, /id:\s*'file-drop'[^]*?name:\s*'dsh-file-drop'/,
    '旧 file-drop 必须保持退役 —— 与 file-drop-eac 并存会重复接管文件和图片拖放');
});

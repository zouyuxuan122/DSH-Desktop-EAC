import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { collectPluginRows } = require(join(root, 'plugin-manager-state.js'));

// 与 main.js COMPANION_PLUGINS 同构的最小清单（含默认禁用的大肥鱼）。
const companion = [
  { id: 'dsh-pet', name: 'dsh-pet' },
  { id: 'dsh-pet-settings', name: 'dsh-pet-settings' },
  { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu' },
];

test('insert 内层 disabled: true 的默认禁用插件（dsh-dafeiyu 场景）正确显示为未启用', () => {
  // syncCompanionPlugins 写入的默认形态：insert 内层行带 disabled: true。
  const entries = [{
    insert: [
      { id: 'dsh-pet', name: 'dsh-pet', config: { size: 260, position: 'bottom-right' } },
      { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu', disabled: true },
    ],
  }];
  const rows = collectPluginRows(entries, { companion });
  const fish = rows.find((r) => r.id === 'dsh-dafeiyu');
  assert.equal(fish.enabled, false, 'v4.2 曾只认顶层 disabled，错报为已启用');
  assert.equal(fish.toggleable, true, '未启用的大肥鱼应可在管理页启用');
  const pet = rows.find((r) => r.id === 'dsh-pet');
  assert.equal(pet.enabled, true);
  assert.equal(pet.toggleable, true, 'insert 内层 config 不应锁死管理页开关（桌宠卡片仍可切换）');
});

test('顶层 disabled: true（用户关闭形态）正确显示为未启用', () => {
  const entries = [{ id: 'dsh-pet', name: 'dsh-pet', disabled: true }];
  const rows = collectPluginRows(entries, { companion });
  assert.equal(rows.find((r) => r.id === 'dsh-pet').enabled, false);
});

test('用户启用后（无 disabled 行）恢复为已启用', () => {
  const entries = [{ insert: [{ id: 'dsh-dafeiyu', name: 'dsh-dafeiyu' }] }];
  const rows = collectPluginRows(entries, { companion });
  assert.equal(rows.find((r) => r.id === 'dsh-dafeiyu').enabled, true);
});

test('顶层与 insert 内层都登记时任一 disabled 即禁用且同 id 去重', () => {
  const entries = [
    { insert: [{ id: 'dsh-pet', name: 'dsh-pet', disabled: true }] },
    { id: 'dsh-pet', name: 'dsh-pet' },
  ];
  const rows = collectPluginRows(entries, { companion });
  assert.equal(rows.filter((r) => r.id === 'dsh-pet').length, 1, '同 id 只出一行');
  assert.equal(rows.find((r) => r.id === 'dsh-pet').enabled, false);
});

test('removed 插件显示 removed 且不可切换、不可移除', () => {
  const rows = collectPluginRows([], { companion, removedIds: ['dsh-dafeiyu'] });
  const fish = rows.find((r) => r.id === 'dsh-dafeiyu');
  assert.equal(fish.removed, true);
  assert.equal(fish.enabled, false);
  assert.equal(fish.toggleable, false);
});

test('bundles 登记的内核骨架进 core 组、第三方 bundle 归 other（issue #212）', () => {
  const rows = collectPluginRows([], { companion, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-fs', 'user-codex'] });
  const base = rows.find((r) => r.name === '@deepseek-ai/dsh-base');
  assert.equal(base.group, 'core');
  assert.equal(base.removable, false);
  assert.equal(base.toggleable, false);
  // 非内核白名单的 bundle（市场/dsh plugin add 装入）不再被标成核心：
  // 旧实现一律 'core'，用户无法在管理页关闭/操作这些第三方插件。
  const fsRow = rows.find((r) => r.name === '@deepseek-ai/dsh-fs');
  assert.equal(fsRow.group, 'other');
  assert.equal(fsRow.toggleable, true);
  const userRow = rows.find((r) => r.name === 'user-codex');
  assert.equal(userRow.group, 'other');
  assert.equal(userRow.toggleable, true);
});

test('other 组：非配套的顶层/insert 条目（市场安装）按 id 去重', () => {
  const entries = [
    { insert: [{ id: 'market-a', name: 'pkg-market-a' }] },
    { id: 'market-b', name: 'pkg-market-b' },
  ];
  const rows = collectPluginRows(entries, { companion });
  assert.ok(rows.some((r) => r.id === 'market-a' && r.group === 'other'));
  assert.ok(rows.some((r) => r.id === 'market-b' && r.group === 'other'));
});

test('排序：companion → other → core，组内按 id 字典序', () => {
  const entries = [{ insert: [{ id: 'zzz', name: 'z' }] }];
  const rows = collectPluginRows(entries, { companion, bundles: ['@deepseek-ai/dsh-base'] });
  const rank = { companion: 0, other: 1, core: 2 };
  const groups = rows.map((r) => r.group);
  for (let i = 1; i < groups.length; i++) {
    assert.ok(rank[groups[i - 1]] <= rank[groups[i]], `分组乱序: ${groups.join(',')}`);
  }
  const companionIds = rows.filter((r) => r.group === 'companion').map((r) => r.id);
  assert.deepEqual(companionIds, ['dsh-dafeiyu', 'dsh-pet', 'dsh-pet-settings']);
});

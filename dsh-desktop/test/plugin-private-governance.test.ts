// 私有维护插件（台账 origin=eac-original）治理契约：
//
//  1) 黑名单从 SOURCES.json 台账正确生成 —— main 线 eac-original 的 14 个
//     插件包名必须一个不差（多一个 = 误判私有；少一个 = 该私有插件仍可能
//     被自动更新冲掉 EAC 适配）；
//  2) pluginUpdateSources() 是更新源唯一漏斗 —— 即使将来有人把私有插件误
//     登记进 PLUGIN_UPDATE_SOURCES，也必须被强制过滤（sidecar server.ts 的
//     「检测」与「应用更新」两条路都经过它）；
//  3) 管理页行带 privateMaintained 标记（设置页可见「私有维护」的数据面）。

import test from 'node:test';
import assert from 'node:assert/strict';
import companionSync from '../lib/desktop/companion-sync.js';
import pluginManagerState from '../plugin-manager-state.js';

const { COMPANION_PLUGINS, PLUGIN_UPDATE_SOURCES, privateMaintainedPluginNames, pluginUpdateSources } = companionSync;
const { collectPluginRows } = pluginManagerState;

const EXPECTED_PRIVATE_NAMES = new Set([
  'dsh-dock-settings',
  'dsh-eac-core-bridge',
  'dsh-eac-locale-compat',
  '@deepseek-ai/dsh-easy-setup',
  'dsh-feature-toggles',
  'dsh-file-drop-eac',
  'dsh-font-custom',
  'dsh-pet-settings',
  'dsh-phone',
  'dsh-plugin-shield',
  'dsh-plugin-wizard',
  'dsh-settings-scroll-fix',
  '@deepseek-ai/dsh-skin-switch',
  'dsh-viewport-lock',
]);

test('黑名单 = 台账 main 线 eac-original 插件包名，一个不差', () => {
  const names = privateMaintainedPluginNames();
  const missing = [...EXPECTED_PRIVATE_NAMES].filter((n) => !names.has(n));
  const extra = [...names].filter((n) => !EXPECTED_PRIVATE_NAMES.has(n));
  assert.deepEqual(missing, [], '台账判为 eac-original 但黑名单缺失的插件');
  assert.deepEqual(extra, [], '黑名单里存在但台账不是 main 线 eac-original 的插件');
});

test('强制过滤：私有插件即使被误登记进 PLUGIN_UPDATE_SOURCES 也进不了更新源', () => {
  const target = COMPANION_PLUGINS.find((p) => p.name === 'dsh-viewport-lock');
  assert.ok(target, 'COMPANION_PLUGINS 里必须存在 dsh-viewport-lock（黑名单过滤按包名匹配）');
  const leaked = pluginUpdateSources().filter((s) => s.id === target.id);
  assert.deepEqual(leaked, [], '基线：私有插件不应天然出现在更新源');
  PLUGIN_UPDATE_SOURCES[target.id] = { npm: 'dsh-viewport-lock' };
  try {
    const after = pluginUpdateSources().filter((s) => s.id === target.id);
    assert.deepEqual(after, [], '误登记后仍必须被黑名单强制过滤——这是自动更新黑名单的强制点');
  } finally {
    delete PLUGIN_UPDATE_SOURCES[target.id];
  }
  const kept = pluginUpdateSources().filter((s) => s.id === 'picturereader');
  assert.equal(kept.length, 1, '非私有插件的更新源不受黑名单影响');
});

test('管理页行带 privateMaintained 标记（数据面）', () => {
  const rows = collectPluginRows([], {
    companion: [
      { id: 'viewport-lock', name: 'dsh-viewport-lock' },
      { id: 'picturereader', name: 'picturereader' },
    ],
    privateIds: ['viewport-lock'],
  }) as Array<{ id: string; privateMaintained: boolean }>;
  assert.equal(rows.find((r) => r.id === 'viewport-lock')?.privateMaintained, true);
  assert.equal(rows.find((r) => r.id === 'picturereader')?.privateMaintained, false);
});

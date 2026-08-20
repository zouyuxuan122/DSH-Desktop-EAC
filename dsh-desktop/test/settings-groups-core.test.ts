// Tests for the dsh-settings-groups companion plugin's pure core.
// The plugin folds low-frequency option rows (matched by title keywords) in
// the settings page's "general" section into a collapsible "advanced" group
// at the bottom, persisted in localStorage. Same evaluation strategy as
// settings-nav-core: the browser bundle is a classic script, so the tests
// evaluate the real file with a stubbed window and assert against the exposed
// `window.__dshSettingsGroupsCore`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE = new URL('../assets/plugins/dsh-settings-groups/lib/client.js', import.meta.url);

function loadCore() {
  const src = readFileSync(BUNDLE, 'utf8');
  const captured = {};
  const win = {
    __ModuleLoader__: { load: (handoff) => { captured.handoff = handoff; } },
  };
  vm.runInNewContext(src, {
    window: win,
    console,
    setTimeout,
    clearTimeout,
    MutationObserver: class {},
    HTMLElement: class {},
    Set, Map, Array, JSON, Error,
  });
  assert.ok(captured.handoff, 'bundle must register via __ModuleLoader__.load');
  assert.equal(captured.handoff.id, 'dsh-settings-groups', 'handoff must carry the plugin id');
  assert.ok(win.__dshSettingsGroupsCore, 'bundle must expose the pure core');
  return win.__dshSettingsGroupsCore;
}

const core = loadCore();

test('default config collapses the advanced group', () => {
  const cfg = core.parseConfig(null);
  assert.equal(cfg.expanded, false);
});

test('parseConfig honors an expanded flag', () => {
  assert.equal(core.parseConfig(JSON.stringify({ expanded: true })).expanded, true);
  assert.equal(core.parseConfig(JSON.stringify({ expanded: 'yes' })).expanded, false);
});

test('isAdvancedTitle matches zh/en keywords, case-insensitive', () => {
  const kw = core.DEFAULT_ADVANCED_KEYWORDS;
  assert.equal(core.isAdvancedTitle('外观', kw), true);
  assert.equal(core.isAdvancedTitle('Language', kw), true);
  assert.equal(core.isAdvancedTitle('权限预设', kw), true);
  assert.equal(core.isAdvancedTitle('Advanced settings', kw), true);
  assert.equal(core.isAdvancedTitle('隐藏对话输出', kw), false);
  assert.equal(core.isAdvancedTitle('', kw), false);
  assert.equal(core.isAdvancedTitle('默认 Agent', kw), false);
});

test('partitionItems keeps advanced/basic order and never misclassifies empty titles', () => {
  const titles = ['外观', '隐藏对话输出', '语言', '忙时回车行为', '', '权限预设'];
  const parts = core.partitionItems(titles, core.DEFAULT_ADVANCED_KEYWORDS);
  assert.deepEqual(Array.from(parts.advanced), [0, 2, 5]);
  assert.deepEqual(Array.from(parts.basic), [1, 3, 4]);
});

test('partitionItems with no advanced rows returns empty advanced list', () => {
  const parts = core.partitionItems(['隐藏对话输出', '忙时回车行为', '默认 Agent'], core.DEFAULT_ADVANCED_KEYWORDS);
  assert.deepEqual(Array.from(parts.advanced), []);
  assert.deepEqual(Array.from(parts.basic), [0, 1, 2]);
});

test('serialize round-trips through parseConfig', () => {
  const cfg = core.parseConfig(JSON.stringify({ expanded: true }));
  assert.equal(core.parseConfig(core.serialize(cfg)).expanded, true);
  assert.equal(core.parseConfig(core.serialize(core.parseConfig(null))).expanded, false);
});

test('parseConfig tolerates garbage input', () => {
  for (const raw of ['', 'abc', '{}', '[1,2]', 'null']) {
    const cfg = core.parseConfig(raw);
    assert.equal(typeof cfg.expanded, 'boolean', raw);
  }
});

test('STORAGE_KEY is namespaced to the plugin', () => {
  assert.ok(core.STORAGE_KEY.startsWith('eac:'), 'storage key must be namespaced');
  assert.ok(core.STORAGE_KEY.includes('settings-groups'));
});

test('NAV_STORAGE_KEY is distinct and namespaced', () => {
  assert.notEqual(core.NAV_STORAGE_KEY, core.STORAGE_KEY);
  assert.ok(core.NAV_STORAGE_KEY.startsWith('eac:'));
  assert.ok(core.NAV_STORAGE_KEY.includes('settings-groups'));
});

test('NAV_KEYWORDS classifies the real settings sidebar titles', () => {
  const titles = [
    '通用设置', '模型', '插件', 'Agent 预设', '🗑 对话管理', 'Skills 与 MCP',
    '插件保护', '价格设置', '人设卡', '视觉模型（快速配置）', '选择向导',
    '视觉模型', '外观 · 字体与颜色', '人设卡', '记忆', '一键迁移（夺舍）',
    '自动压缩', 'AI 变更审核', '快照', 'ClawBot', '自定义提示词',
    '第三方模型思考强度', '归档对话管理', '侧边临时会话', '侧边卡片',
  ];
  const parts = core.partitionItems(titles, core.NAV_KEYWORDS);
  const advancedTitles = parts.advanced.map((i) => titles[i]);
  const basicTitles = parts.basic.map((i) => titles[i]);
  for (const t of ['模型', '插件', 'Skills 与 MCP', '插件保护', '视觉模型（快速配置）', '视觉模型', '外观 · 字体与颜色', '一键迁移（夺舍）', '自动压缩', 'AI 变更审核', '快照', 'ClawBot', '自定义提示词', '第三方模型思考强度', '归档对话管理']) {
    assert.ok(advancedTitles.includes(t), `expected advanced: ${t}`);
  }
  for (const t of ['通用设置', 'Agent 预设', '🗑 对话管理', '价格设置', '人设卡', '选择向导', '记忆', '侧边临时会话', '侧边卡片']) {
    assert.ok(basicTitles.includes(t), `expected basic: ${t}`);
  }
  assert.equal(parts.advanced.length + parts.basic.length, titles.length);
});

test('NAV_KEYWORDS leaves empty and unrelated titles basic', () => {
  const parts = core.partitionItems(['', '设置', '关于'], core.NAV_KEYWORDS);
  assert.deepEqual(Array.from(parts.advanced), []);
  assert.deepEqual(Array.from(parts.basic), [0, 1, 2]);
});
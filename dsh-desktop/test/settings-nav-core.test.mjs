// Tests for the dsh-settings-nav-custom companion plugin's pure core.
// The plugin lets users show/hide and reorder the items in the settings
// page's left sidebar (the `settings.section` nav rail), persisted in
// localStorage. Same evaluation strategy as file-drop: the browser bundle is
// a classic script, so the tests evaluate the real file with a stubbed
// window and assert against the exposed `window.__dshSettingsNavCore`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE = new URL('../assets/plugins/dsh-settings-nav-custom/lib/client.js', import.meta.url);

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
    // 与测试进程共享构造函数，避免 cross-realm 原型差异
    Set, Map, Array, JSON, Error,
  });
  assert.ok(captured.handoff, 'bundle must register via __ModuleLoader__.load');
  assert.equal(captured.handoff.id, 'dsh-settings-nav-custom', 'handoff must carry the plugin id');
  assert.ok(win.__dshSettingsNavCore, 'bundle must expose the pure core');
  return win.__dshSettingsNavCore;
}

const core = loadCore();

const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'models', label: '模型' },
  { id: 'appearance', label: '外观' },
  { id: 'plugins', label: '插件' },
  { id: 'market', label: '市场' },
];

test('default config hides nothing and preserves order', () => {
  const cfg = core.parseConfig(null);
  const out = core.applyConfig(SECTIONS, cfg);
  assert.deepEqual(Array.from(out.map((s) => s.id)), ['general', 'models', 'appearance', 'plugins', 'market']);
});

test('applyConfig filters hidden sections but keeps relative order of the rest', () => {
  const cfg = core.parseConfig(JSON.stringify({ hidden: ['appearance', 'market'], order: [] }));
  const out = core.applyConfig(SECTIONS, cfg);
  assert.deepEqual(Array.from(out.map((s) => s.id)), ['general', 'models', 'plugins']);
});

test('applyConfig honors the custom order for listed ids, unlisted stay after', () => {
  const cfg = core.parseConfig(JSON.stringify({ hidden: [], order: ['plugins', 'general'] }));
  const out = core.applyConfig(SECTIONS, cfg);
  assert.deepEqual(Array.from(out.map((s) => s.id)), ['plugins', 'general', 'models', 'appearance', 'market']);
});

test('applyConfig tolerates unknown ids in the order list and missing sections', () => {
  const cfg = core.parseConfig(JSON.stringify({ hidden: [], order: ['ghost', 'market', 'nope'] }));
  const out = core.applyConfig(SECTIONS, cfg);
  assert.deepEqual(Array.from(out.map((s) => s.id)), ['market', 'general', 'models', 'appearance', 'plugins']);
});

test('toggle adds and removes an id from the hidden set', () => {
  const cfg = core.parseConfig(null);
  const hidden1 = core.toggle('models', cfg);
  assert.ok(hidden1.hidden.has('models'));
  const back = core.toggle('models', hidden1);
  assert.ok(!back.hidden.has('models'));
  assert.ok(core.applyConfig(SECTIONS, back).length === SECTIONS.length);
});

test('move reorders the custom order list; unknown move target is a no-op', () => {
  const cfg = core.parseConfig(null);
  const known = SECTIONS.map((s) => s.id);
  const up = core.move('appearance', -1, cfg, known);
  assert.deepEqual(Array.from(up.order), ['appearance']);
  const down = core.move('general', 1, core.parseConfig(JSON.stringify({ order: ['general'] })), known);
  assert.deepEqual(Array.from(down.order), ['general']);
  const ghost = core.move('ghost', -1, cfg, known);
  assert.deepEqual(Array.from(ghost.order), []);
});

test('move down when not in order inserts at tail, not no-op', () => {
  const cfg = core.parseConfig(null);
  const known = SECTIONS.map((s) => s.id);
  const down = core.move('appearance', 1, cfg, known);
  assert.deepEqual(Array.from(down.order), ['appearance']);
});

test('move at edge clamps instead of deleting from order', () => {
  const known = SECTIONS.map((s) => s.id);
  const atTop = core.move('general', -1, core.parseConfig(JSON.stringify({ order: ['general', 'models'] })), known);
  assert.deepEqual(Array.from(atTop.order), ['general', 'models']);
  const atBottom = core.move('models', 1, core.parseConfig(JSON.stringify({ order: ['general', 'models'] })), known);
  assert.deepEqual(Array.from(atBottom.order), ['general', 'models']);
});

test('serialize round-trips through parseConfig', () => {
  const cfg = core.parseConfig(JSON.stringify({ hidden: ['market'], order: ['general', 'plugins'] }));
  const again = core.parseConfig(core.serialize(cfg));
  assert.deepEqual([...again.hidden], ['market']);
  assert.deepEqual(Array.from(again.order), ['general', 'plugins']);
});

test('parseConfig tolerates garbage input', () => {
  for (const raw of ['', 'abc', '{}', '{"hidden": "nope"}', '{"order": 42}', '[1,2]', 'null']) {
    const cfg = core.parseConfig(raw);
    assert.ok(cfg.hidden instanceof Set, raw);
    assert.ok(Array.isArray(cfg.order), raw);
    assert.equal(core.applyConfig(SECTIONS, cfg).length, SECTIONS.length, raw);
  }
});

test('STORAGE_KEY is namespaced to the plugin', () => {
  assert.ok(core.STORAGE_KEY.startsWith('eac:'), 'storage key must be namespaced');
  assert.ok(core.STORAGE_KEY.includes('settings-nav'));
});

// ── V4.6.1 单一写者核心：computeSidebarLayout / 折叠状态 ──

const LAYOUT_SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'models', label: '模型' },
  { id: 'appearance', label: '外观' },
  { id: 'plugins', label: '插件' },
  { id: 'market', label: '市场' },
];
// 分组归属（按 SIDEBAR_ADVANCED_KEYWORDS）：通用/市场=普通，模型/外观/插件=高级

function rowsById(layout) {
  const out = {};
  for (const r of layout.rows) out[r.id] = r;
  return out;
}

function headByKey(layout, key) {
  return layout.heads.find((h) => h.key === key) ?? null;
}

test('computeSidebarLayout folds advanced rows in place without touching order', () => {
  const layout = core.computeSidebarLayout(LAYOUT_SECTIONS, core.parseConfig(null), { folded: true });
  const rows = rowsById(layout);
  // 折叠只影响 display，order 保持视觉序列位，展开后原位恢复
  assert.equal(rows.general.display, '');
  assert.equal(rows.models.display, 'none');
  assert.equal(rows.appearance.display, 'none');
  assert.equal(rows.plugins.display, 'none');
  assert.equal(rows.market.display, '');
  assert.deepEqual(
    LAYOUT_SECTIONS.map((s) => rows[s.id].order),
    [0, 1, 2, 3, 4],
  );
});

test('computeSidebarLayout unfolded shows every row', () => {
  const layout = core.computeSidebarLayout(LAYOUT_SECTIONS, core.parseConfig(null), { folded: false });
  for (const r of layout.rows) assert.equal(r.display, '', r.id);
});

test('computeSidebarLayout emits basic and advanced heads at each group first row', () => {
  const layout = core.computeSidebarLayout(LAYOUT_SECTIONS, core.parseConfig(null), { folded: true });
  const basic = headByKey(layout, 'basic');
  const adv = headByKey(layout, 'advanced');
  assert.ok(basic && adv, 'both heads must be planned');
  assert.equal(basic.beforeId, 'general');
  assert.equal(basic.order, 0);
  assert.equal(adv.beforeId, 'models');
  assert.equal(adv.order, 1);
  assert.equal(adv.folded, true);
  assert.equal(adv.count, 3);
  assert.equal(adv.text, '高级 ▸ (3)');
});

test('computeSidebarLayout unfold flips head text and folded flag', () => {
  const layout = core.computeSidebarLayout(LAYOUT_SECTIONS, core.parseConfig(null), { folded: false });
  const adv = headByKey(layout, 'advanced');
  assert.equal(adv.folded, false);
  assert.equal(adv.text, '高级 ▾ (3)');
});

test('computeSidebarLayout hidden rows sink to tail orders and leave the group', () => {
  const cfg = core.parseConfig(JSON.stringify({ hidden: ['models'], order: [] }));
  const layout = core.computeSidebarLayout(LAYOUT_SECTIONS, cfg, { folded: true });
  const rows = rowsById(layout);
  // 隐藏行不占视觉序列：display none + 兜底序（seq.length + 原下标 = 4+1）
  assert.equal(rows.models.display, 'none');
  assert.equal(rows.models.order, 5);
  // 高级组首行顺延为外观，计数只剩 2
  const adv = headByKey(layout, 'advanced');
  assert.equal(adv.beforeId, 'appearance');
  assert.equal(adv.count, 2);
  assert.equal(rows.appearance.display, 'none', 'folded still applies to remaining advanced rows');
});

test('computeSidebarLayout honors custom order for head placement', () => {
  const cfg = core.parseConfig(JSON.stringify({ hidden: [], order: ['plugins', 'general'] }));
  const layout = core.computeSidebarLayout(LAYOUT_SECTIONS, cfg, { folded: false });
  const basic = headByKey(layout, 'basic');
  const adv = headByKey(layout, 'advanced');
  assert.equal(basic.beforeId, 'general');
  assert.equal(basic.order, 1);
  assert.equal(adv.beforeId, 'plugins');
  assert.equal(adv.order, 0);
});

// 折叠配置对象产自 vm 沙箱（跨 realm 原型不同），一律断言字段而非整对象。
function foldedOf(cfg) {
  return cfg && cfg.folded;
}

test('parseFoldConfig defaults to collapsed and tolerates garbage', () => {
  assert.equal(foldedOf(core.parseFoldConfig(null)), true);
  assert.equal(foldedOf(core.parseFoldConfig('')), true);
  assert.equal(foldedOf(core.parseFoldConfig('garbage')), true);
  assert.equal(foldedOf(core.parseFoldConfig('{"folded":false}')), false);
  assert.equal(foldedOf(core.parseFoldConfig('{"folded":"yes"}')), true, 'non-boolean falls back to default');
  assert.equal(foldedOf(core.parseFoldConfig('{}')), true);
});

test('serializeFoldConfig coerces strictly to boolean and round-trips', () => {
  assert.equal(core.serializeFoldConfig({ folded: false }), '{"folded":false}');
  assert.equal(core.serializeFoldConfig({ folded: 'truthy' }), '{"folded":false}', 'only === true counts as expanded');
  assert.equal(core.serializeFoldConfig({}), '{"folded":false}');
  const raw = core.serializeFoldConfig({ folded: false });
  assert.equal(foldedOf(core.parseFoldConfig(raw)), false);
});

test('migrateFoldConfig prefers v2 and never touches legacy when v2 exists', () => {
  const written = [];
  const removed = [];
  const cfg = core.migrateFoldConfig('{"folded":false}', '{"expanded":true}', (s) => written.push(s), () => removed.push(1));
  assert.equal(foldedOf(cfg), false);
  assert.deepEqual(written, []);
  assert.deepEqual(removed, []);
});

test('migrateFoldConfig derives folded from legacy expanded, writes v2 and removes legacy', () => {
  const written = [];
  const removed = [];
  const cfg = core.migrateFoldConfig(null, '{"expanded":true}', (s) => written.push(s), () => removed.push(1));
  assert.equal(foldedOf(cfg), false, 'expanded:true → folded:false');
  assert.deepEqual(written, ['{"folded":false}']);
  assert.equal(removed.length, 1);

  const written2 = [];
  const removed2 = [];
  const cfg2 = core.migrateFoldConfig(undefined, '{"expanded":false}', (s) => written2.push(s), () => removed2.push(1));
  assert.equal(foldedOf(cfg2), true, 'expanded:false → folded:true');
  assert.deepEqual(written2, ['{"folded":true}']);
  assert.equal(removed2.length, 1);
});

test('migrateFoldConfig treats garbage legacy as default but still migrates storage', () => {
  const written = [];
  const removed = [];
  const cfg = core.migrateFoldConfig(null, 'not-json', (s) => written.push(s), () => removed.push(1));
  assert.equal(foldedOf(cfg), true);
  assert.deepEqual(written, ['{"folded":true}']);
  assert.equal(removed.length, 1);
});

test('migrateFoldConfig with no stored state returns default and writes nothing', () => {
  const written = [];
  const removed = [];
  const cfg = core.migrateFoldConfig(null, null, (s) => written.push(s), () => removed.push(1));
  assert.equal(foldedOf(cfg), true);
  assert.deepEqual(written, []);
  assert.deepEqual(removed, []);
});

test('migrateFoldConfig survives a failing storage backend', () => {
  const cfg = core.migrateFoldConfig(null, '{"expanded":true}', () => { throw new Error('quota'); }, () => {});
  assert.equal(foldedOf(cfg), false);
});

test('isSidebarAdvancedTitle matches zh/en keywords case-insensitively', () => {
  assert.equal(core.isSidebarAdvancedTitle('模型'), true);
  assert.equal(core.isSidebarAdvancedTitle('Skills 与 MCP'), true);
  assert.equal(core.isSidebarAdvancedTitle('PLUGIN MANAGER'), true);
  assert.equal(core.isSidebarAdvancedTitle('外观 · 字体与颜色'), true);
  assert.equal(core.isSidebarAdvancedTitle('通用'), false);
  assert.equal(core.isSidebarAdvancedTitle('选择向导'), false);
  assert.equal(core.isSidebarAdvancedTitle(''), false);
  assert.equal(core.isSidebarAdvancedTitle(null), false);
});
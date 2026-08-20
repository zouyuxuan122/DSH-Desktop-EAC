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
  assert.deepEqual(Array.from(down.order), []);
  const ghost = core.move('ghost', -1, cfg, known);
  assert.deepEqual(Array.from(ghost.order), []);
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
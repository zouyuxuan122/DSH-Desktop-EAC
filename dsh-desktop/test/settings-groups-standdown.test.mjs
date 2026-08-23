import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GROUPS_SRC = readFileSync(new URL('../assets/plugins/dsh-settings-groups/lib/client.js', import.meta.url), 'utf8');
const NAV_SRC = readFileSync(new URL('../assets/plugins/dsh-settings-nav-custom/lib/client.js', import.meta.url), 'utf8');

// V4.6.1 架构：侧边栏唯一写者为 dsh-settings-nav-custom，groups 不再触碰
// 侧边栏 — 避免两个 MutationObserver 对同一批行拉锯导致抽搐。旧的共存
// 标记/豁免/指纹耦合全部删除，groups 只保留页内折叠。

test('groups no longer touches the sidebar (single writer)', () => {
  assert.ok(!GROUPS_SRC.includes("'eac:settings-nav:v1'"), 'groups must not reference nav-custom storage');
  assert.ok(!GROUPS_SRC.includes('applyNav'), 'groups must not contain sidebar applyNav');
  assert.ok(!GROUPS_SRC.includes('eac-settings-groups-navhead'), 'groups must not contain sidebar heads');
  assert.ok(!GROUPS_SRC.includes('data-eac-adv-fold'), 'groups must not contain fold markers');
});

test('groups still folds the general page items', () => {
  assert.ok(GROUPS_SRC.includes('applySection'), 'general-page folding must remain');
  assert.ok(GROUPS_SRC.includes('DEFAULT_ADVANCED_KEYWORDS'), 'general-page keywords must remain');
  assert.ok(GROUPS_SRC.match(/function scan[^]*?applySection/), 'scan must still drive general-page folding');
});

test('nav-custom now owns sidebar grouping and folding', () => {
  assert.ok(NAV_SRC.includes("'eac:sidebar:v2'"), 'nav-custom must own new fold key');
  assert.ok(NAV_SRC.includes('SIDEBAR_ADVANCED_KEYWORDS'), 'nav-custom must own sidebar keywords');
  assert.ok(NAV_SRC.includes('computeSidebarLayout'), 'nav-custom must expose layout pure function');
  assert.ok(NAV_SRC.includes('migrateFoldConfig'), 'nav-custom must migrate legacy fold key');
  assert.ok(NAV_SRC.includes('eac-settings-groups-navhead') || NAV_SRC.includes('eac-sidebar-head'), 'nav-custom must create sidebar heads');
});

test('nav-custom default fold is collapsed (收起)', () => {
  assert.match(NAV_SRC, /folded:\s*true/);
  assert.ok(NAV_SRC.includes("'eac:settings-groups-nav:v1'"), 'nav-custom must read legacy fold key for migration');
});

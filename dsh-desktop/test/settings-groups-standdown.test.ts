import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const GROUPS_SRC = readFileSync(new URL('../assets/plugins/dsh-settings-groups/lib/client.js', import.meta.url), 'utf8');
const SYNC_SRC = readFileSync(new URL('../lib/desktop/companion-sync.ts', import.meta.url), 'utf8');

// 5.1.1 架构：侧边栏「普通/高级」分组随 dsh-settings-nav-custom 一并退役
// （用户裁定该分栏无用），设置页左侧回归 ui-settings-general 的官方原生
// order 平铺。groups 继续只负责「常规页」页内折叠，且绝不能重新接管侧边栏。

test('nav-custom is retired and never comes back', () => {
  assert.ok(!existsSync(new URL('../assets/plugins/dsh-settings-nav-custom/package.json', import.meta.url)),
    'dsh-settings-nav-custom 插件目录必须删除');
  assert.match(SYNC_SRC, /id:\s*'settings-nav-custom'/,
    'nav-custom 必须登记在 RETIRED_BUILTIN_PLUGINS（启动时清理老 profile 残留行/包副本）');
  const companionStart = SYNC_SRC.indexOf('const COMPANION_PLUGINS');
  const companionSlice = SYNC_SRC.slice(companionStart, SYNC_SRC.indexOf('];', companionStart));
  assert.doesNotMatch(companionSlice, /settings-nav-custom/,
    'nav-custom 绝不能回到 COMPANION_PLUGINS —— 复活会再次注入普通/高级分栏');
});

test('groups no longer touches the sidebar', () => {
  assert.ok(!GROUPS_SRC.includes("'eac:settings-nav:v1'"), 'groups must not reference nav storage');
  assert.ok(!GROUPS_SRC.includes('applyNav'), 'groups must not contain sidebar applyNav');
  assert.ok(!GROUPS_SRC.includes('eac-settings-groups-navhead'), 'groups must not contain sidebar heads');
  assert.ok(!GROUPS_SRC.includes('data-eac-adv-fold'), 'groups must not contain fold markers');
});

test('groups still folds the general page items', () => {
  assert.ok(GROUPS_SRC.includes('applySection'), 'general-page folding must remain');
  assert.ok(GROUPS_SRC.includes('DEFAULT_ADVANCED_KEYWORDS'), 'general-page keywords must remain');
  assert.ok(GROUPS_SRC.match(/function scan[^]*?applySection/), 'scan must still drive general-page folding');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { removePluginFromPatch } from '../scripts/plugin-manager-patch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// ADR 0002：RETIRED_BUILTIN_PLUGINS 与 syncCompanionPlugins 已迁至 L2 模块。
const main = readFileSync(join(root, 'lib', 'desktop', 'companion-sync.ts'), 'utf8');

const retiredMarkets = [
  { id: 'plugin-marketplace', name: '@deepseek-ai/dsh-plugin-marketplace' },
  { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin' },
  { id: 'zat-market', name: 'zat-dsh-engine' },
];

test('all historical built-in markets are retired before unified-market sync', () => {
  const listStart = main.indexOf('const RETIRED_BUILTIN_PLUGINS = [');
  const listEnd = main.indexOf('\n];', listStart);
  const list = main.slice(listStart, listEnd);

  for (const { id, name } of retiredMarkets) {
    assert.ok(list.includes(`{ id: '${id}', name: '${name}' }`),
      `${id} must be removed during profile migration`);
  }

  const cleanupCall = main.indexOf('retireRemovedBuiltinPlugins(desktopProfileDir());');
  const syncLoop = main.indexOf('for (const p of COMPANION_PLUGINS)', cleanupCall);
  assert.ok(cleanupCall !== -1 && syncLoop > cleanupCall,
    'retired markets must be removed before companion plugins are synced');
});

test('retired market migration removes only the exact historical patch rows', () => {
  let patch = [
    '- insert:',
    "    - id: plugin-marketplace",
    "      name: '@deepseek-ai/dsh-plugin-marketplace'",
    '- insert:',
    '    - id: dsh-market-plugin',
    "      name: '@sanqi-normal/dsh-webui-market-plugin'",
    '- insert:',
    '    - id: zat-market',
    "      name: 'zat-dsh-engine'",
    '- insert:',
    '    - id: custom-market',
    "      name: 'community-custom-market'",
    '',
  ].join('\n');

  for (const { id } of retiredMarkets) patch = removePluginFromPatch(patch, id);

  for (const { id, name } of retiredMarkets) {
    assert.doesNotMatch(patch, new RegExp(`id: ${id}(?![A-Za-z0-9_.-])`));
    assert.ok(!patch.includes(name));
  }
  assert.match(patch, /id: custom-market/);
  assert.match(patch, /name: 'community-custom-market'/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { companionPluginsForPlatform } from '../lib/desktop/companion-sync.js';

test('Windows companion registry preserves Windows-only plugins', () => {
  const ids = new Set(companionPluginsForPlatform('win32').map((plugin) => plugin.id));
  assert.equal(ids.has('computer-user'), true);
  assert.equal(ids.has('dsh-dafeiyu'), true);
  assert.equal(ids.has('dsh-stt'), true);
});

test('Linux companion registry keeps common plugins and excludes unavailable helpers', () => {
  const ids = new Set(companionPluginsForPlatform('linux').map((plugin) => plugin.id));
  assert.equal(ids.has('terminal'), true);
  assert.equal(ids.has('picturereader'), true);
  assert.equal(ids.has('computer-user'), false);
  assert.equal(ids.has('dsh-dafeiyu'), false);
  // dsh-stt 引擎由 CI 在各平台构建时安装（install:plugin-engines），三平台可用
  assert.equal(ids.has('dsh-stt'), true);
});

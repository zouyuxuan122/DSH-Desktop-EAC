import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareVersions } = require('../updater.js');

test('版本号缺少第三段时按 0 补齐', () => {
  assert.equal(compareVersions('4.4', '4.4.0'), 0);
  assert.equal(compareVersions('v4.4', '4.4.0'), 0);
  assert.equal(compareVersions('4.4.1', '4.4'), 1);
  assert.equal(compareVersions('4.3.9', '4.4'), -1);
});

test('预发布版本仍排在正式版本之前', () => {
  assert.equal(compareVersions('4.4.0-rc.1', '4.4.0'), -1);
  assert.equal(compareVersions('4.4.0', '4.4.0-rc.1'), 1);
  assert.equal(compareVersions('4.4.0-rc.2', '4.4.0-rc.1'), 1);
});

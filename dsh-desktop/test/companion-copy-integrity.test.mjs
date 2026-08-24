import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPluginPackage } from '../lib/desktop/companion-sync.js';

test('copyPluginPackage repairs a missing file even when the source stamp remains', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-copy-'));
  try {
    const src = join(root, 'source');
    const profile = join(root, 'profile');
    mkdirSync(join(src, 'lib'), { recursive: true });
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'example-plugin', version: '1.0.0' }));
    writeFileSync(join(src, 'lib', 'index.js'), 'module.exports = {}\n');

    copyPluginPackage(profile, src, 'example-plugin');
    const copied = join(profile, 'node_modules', 'example-plugin', 'lib', 'index.js');
    assert.equal(existsSync(copied), true);
    unlinkSync(copied);

    copyPluginPackage(profile, src, 'example-plugin');
    assert.equal(existsSync(copied), true, 'missing plugin files must be restored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

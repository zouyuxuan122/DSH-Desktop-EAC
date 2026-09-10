import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const schema = 'https://raw.githubusercontent.com/Yan-Zero/dsh-std/614dfa1ac168db79fcf4577cf0ebb34e2e3b944b/packages/manifest/schema/dsh-plugin-0.15.schema.json';
const plugins = [
  'dsh-aio-ui-compat',
  'dsh-auto-compact',
  'dsh-balance',
  'dsh-better-sidebar',
  'dsh-composer-dynamic-island',
  'dsh-plugin-manager',
  'dsh-plugin-shield',
  'dsh-skin-switch',
  'dsh-undo-savepoint',
];
const skins = [
  'blue-fantasy', 'dragon-heir', 'maid-atelier', 'miku', 'minecraft',
  'qq98', 'ths', 'trading', 'whale-song', 'xp',
];

test('all bundled plugins carry a unique Community v0.15 manifest with a live host entry', () => {
  const ids = new Set();
  for (const dir of plugins) {
    const pluginDir = join(root, 'assets', 'plugins', dir);
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
    const manifestFile = join(pluginDir, 'dsh-plugin.json');
    assert.ok(existsSync(manifestFile), `${dir} 缺 dsh-plugin.json`);
    if (Array.isArray(pkg.files)) {
      assert.ok(pkg.files.includes('dsh-plugin.json'), `${dir} 的 npm files 白名单遗漏 dsh-plugin.json`);
    }
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.$schema, schema, `${dir} schema 必须固定到当前 dsh-std revision`);
    assert.equal(manifest.manifestVersion, '0.15', `${dir} manifestVersion`);
    assert.equal(manifest.version, pkg.version, `${dir} manifest/package version 不一致`);
    assert.match(manifest.id, /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/, `${dir} id 不符合命名规范`);
    assert.ok(!ids.has(manifest.id), `${dir} 使用了重复插件 id: ${manifest.id}`);
    ids.add(manifest.id);
    assert.equal(manifest.facets?.host?.entry, pkg.main, `${dir} host entry 必须与运行入口一致`);
    assert.ok(existsSync(join(pluginDir, manifest.facets.host.entry)), `${dir} host entry 不存在`);
    assert.deepEqual(manifest.requires?.contracts, [], `${dir} 不得虚构未实现的标准契约`);
    assert.deepEqual(manifest.permissions, [], `${dir} 不得静默声明权限`);
    assert.deepEqual(manifest.contributes?.commands, [], `${dir} 不得虚构命令贡献`);
    assert.deepEqual(manifest.subscriptions, [], `${dir} 不得虚构事件订阅`);
    assert.equal(manifest.license, pkg.license, `${dir} license 不一致`);
    assert.match(manifest.source?.repository ?? '', /^https:\/\//, `${dir} 缺可追溯 source.repository`);
  }
});

test('all bundled skins carry a Community v0.15 manifest and wiring metadata', () => {
  const ids = new Set();
  for (const dir of skins) {
    const skinDir = join(root, 'assets', 'skins', dir);
    const pkg = JSON.parse(readFileSync(join(skinDir, 'package.json'), 'utf8'));
    const skin = JSON.parse(readFileSync(join(skinDir, 'skin.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(skinDir, 'dsh-plugin.json'), 'utf8'));
    assert.equal(manifest.$schema, schema);
    assert.equal(manifest.manifestVersion, '0.15');
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.name, pkg.name);
    assert.ok(!ids.has(manifest.id), `${dir} 使用了重复插件 id`);
    ids.add(manifest.id);
    assert.equal(manifest.facets?.host?.entry, pkg.main);
    assert.ok(existsSync(join(skinDir, manifest.facets.host.entry)));
    assert.equal(manifest['x-eac']?.wiring, skin.wiring.id);
    assert.equal(manifest.license, pkg.license);
  }
});

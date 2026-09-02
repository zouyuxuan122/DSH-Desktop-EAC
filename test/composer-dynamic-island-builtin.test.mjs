import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(root, 'assets', 'plugins', 'dsh-composer-dynamic-island');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const readPlugin = (rel) => readFileSync(join(pluginRoot, rel), 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const packageJson = JSON.parse(readPlugin('package.json'));
const protocolManifest = JSON.parse(readPlugin('dsh-plugin.json'));
const vendor = JSON.parse(readPlugin('EAC-VENDOR.json'));
const client = readPlugin('lib/client.js');

const runtimeFiles = [
  'EAC-VENDOR.json',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'cordis.patch.yml',
  'docs/COMPATIBILITY.md',
  'dsh-plugin.json',
  'lib/client.js',
  'lib/types/index.d.ts',
  'lib/types/index.d.ts.map',
  'lib/types/index.js',
  'package.json',
];

test('Composer Dynamic Island 2.1.0 的运行时包与协议入口完整', () => {
  assert.equal(packageJson.name, 'dsh-composer-dynamic-island');
  assert.equal(packageJson.version, '2.1.0');
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.main, 'lib/types/index.js');
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.equal(packageJson.exports['./client'], './lib/client.js');
  assert.equal(protocolManifest.id, 'io.github.says693.composer-dynamic-island');
  assert.equal(protocolManifest.version, packageJson.version);
  assert.equal(protocolManifest.facets.host.entry, packageJson.main);
  assert.equal(protocolManifest['x-dsh-web-adapter'].entry, 'lib/client.js');
  assert.deepEqual(protocolManifest.permissions, []);
  for (const rel of runtimeFiles) assert.ok(existsSync(join(pluginRoot, rel)), `${rel} 缺失`);

  const patch = readPlugin('cordis.patch.yml');
  assert.match(patch, /id: composer-dynamic-island/);
  assert.match(patch, /name: 'dsh-composer-dynamic-island'/);
});

test('vendored 来源和本地安全补丁有可复核摘要', () => {
  assert.equal(vendor.tag, 'v2.1.0');
  assert.equal(vendor.commit, '2ccd12ff807c3bc983defd2177e15be1a416106f');
  assert.equal(vendor.upstreamClientSha256, '22ea2dff2002dfd012d54aec8fd3c91d1d62544d5f54c10de755bdb05fc20f78');
  assert.equal(vendor.vendoredClientSha256Encoding, 'UTF-8 with LF line endings');
  assert.equal(sha256(Buffer.from(client)), vendor.vendoredClientSha256);
  assert.match(read('.gitattributes'), /^assets\/plugins\/dsh-composer-dynamic-island\/lib\/client\.js text eol=lf$/m);
  assert.ok(vendor.localPatches.length >= 5);
});

test('Web adapter 无外传 API，并锁定焦点与卸载生命周期修复', () => {
  assert.doesNotMatch(client, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
  assert.match(client, /dsh-composer-dynamic-island-config-v1/);
  assert.match(client, /let disposed = false;/);
  assert.match(client, /if \(disposed \|\| !row\.isConnected\) return;/);
  assert.match(client, /row\.matches\(":focus-within"\) \|\| pointerInside\(\)/);
  assert.match(client, /cancelAnimationFrame\(layoutFrame\)/);
  assert.doesNotMatch(client, /"aria-controls": panelId/);
  assert.match(client, /"aria-hidden": "true"/);
  assert.doesNotMatch(client, /\? "岛内" : "原位"/);
});

test('Electron、兼容核心与 Tauri sidecar 同步注册插件和 GitHub 更新源', () => {
  for (const rel of ['main.js', 'desktop-core.js', 'sidecar/src/desktop-core.ts']) {
    const source = read(rel);
    assert.match(source, /\{ id: 'composer-dynamic-island', name: 'dsh-composer-dynamic-island', dir: 'dsh-composer-dynamic-island' \}/, `${rel} 缺 companion 注册`);
    assert.match(source, /'composer-dynamic-island': \{ github: 'says693\/dsh-composer-dynamic-island' \}/, `${rel} 缺更新源`);
    assert.match(source, /'dsh-plugin\.json'/, `${rel} 未复制协议 manifest`);
    assert.match(source, /'README\.zh-CN\.md'/, `${rel} 未复制中文 README`);
    assert.match(source, /'EAC-VENDOR\.json'/, `${rel} 未复制来源审计记录`);
    assert.match(source, /copyDir\('docs'\)/, `${rel} 未复制兼容文档`);
  }
});

test('copyPluginPackage 将完整运行时包复制进 profile', () => {
  const { createDesktopCore } = require('../desktop-core.js');
  const temp = mkdtempSync(join(tmpdir(), 'dsh-composer-island-copy-'));
  try {
    const core = createDesktopCore({
      appRoot: root,
      userDataDir: join(temp, 'userdata'),
      logsDir: join(temp, 'logs'),
      dshHome: join(temp, 'home'),
      nodeExe: () => process.execPath,
      npmCli: () => '',
    });
    const profile = join(temp, 'profile');
    core.copyPluginPackage(profile, pluginRoot, packageJson.name);
    const copiedRoot = join(profile, 'node_modules', packageJson.name);
    for (const rel of runtimeFiles) assert.ok(existsSync(join(copiedRoot, rel)), `${rel} 未复制`);
    assert.ok(existsSync(join(copiedRoot, '.eac-copy-stamp.json')));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('公开 profile 只写一次 companion 行，不重复加入 bundles', () => {
  const profilePackage = JSON.parse(read('distribution/profile-seed/profiles/web-desktop/package.json'));
  assert.ok(!profilePackage.dsh.profile.bundles.includes(packageJson.name));
  const patch = read('distribution/profile-seed/profiles/web-desktop/cordis.patch.yml');
  assert.equal((patch.match(/^\s*- id: composer-dynamic-island\s*$/gm) || []).length, 1);
  assert.equal((patch.match(/^\s*name: 'dsh-composer-dynamic-island'\s*$/gm) || []).length, 1);
});

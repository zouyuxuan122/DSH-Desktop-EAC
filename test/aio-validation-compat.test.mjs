import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('5.x validation entrypoints are backed by AIO implementations', () => {
  for (const rel of ['boot-smoke.js', 'gui-smoke.js', 'update-smoke.js', 'tauri-shell/stage-resources.mjs', 'tauri-shell/make-portable.mjs']) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is missing`);
  }
  assert.match(read('tauri-shell/stage-resources.mjs'), /tauri-app.*scripts.*stage\.ts/s);
  assert.match(read('tauri-shell/make-portable.mjs'), /\.dsh-portable/);
});

test('portable marker selects an isolated data root in the Rust shell', () => {
  const paths = read('tauri-app/src/paths.rs');
  assert.match(paths, /\.dsh-portable/);
  assert.match(paths, /\.dsh-aio-data/);
  assert.match(paths, /portable_marker_selects_sibling_data_root/);
});

test('AIO chrome preserves an existing v prefix', () => {
  const chrome = read('tauri-app/frontend/chrome.ts');
  assert.match(chrome, /\^v\/i\.test\(version\) \? version : `v\$\{version\}`/);
  assert.match(chrome, /badge\.textContent = displayVersion\(info\.appVersion\)/);
  assert.ok(!chrome.includes("badge.textContent = 'v' + info.appVersion"));
});

test('AIO remains isolated from every legacy product by default', () => {
  const conf = JSON.parse(read('tauri-app/tauri.conf.json'));
  const paths = read('tauri-app/src/paths.rs');
  const migrate = read('tauri-app/src/ve_migrate.rs');
  const nsh = read('tauri-app/nsis/installer-hooks.nsh');
  const electron = read('main.js');
  const shortcuts = read('tauri-app/src/shortcuts.rs');
  assert.equal(conf.identifier, 'com.deepseek.dsh.desktop.aio');
  assert.match(paths, /user_data\.join\("dsh-home"\)/);
  assert.match(migrate, /DSH_AIO_IMPORT_LEGACY/);
  assert.match(migrate, /!= Ok\("1"\)/);
  assert.match(nsh, /taskkill \/F \/T \/IM "DSHEAC AIO\.exe"/);
  assert.ok(!/taskkill[^\n]+v4Lite/i.test(nsh));
  assert.match(electron, /\.dsh-aio/);
  assert.match(electron, /com\.deepseek\.dsh\.desktop\.aio/);
  assert.ok(!shortcuts.includes('DSH Desktop.lnk'), 'AIO must not delete another product shortcut by name');
  assert.match(shortcuts, /lnk_targets_app/, 'shortcut maintenance must verify TargetPath ownership');
});

test('AIO has one default Tauri release entrypoint', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.start, /tauri-app/);
  assert.match(pkg.scripts.pack, /tauri-app/);
  assert.match(pkg.scripts.dist, /build-aio-release\.ps1/);
  assert.ok(pkg.scripts['legacy:electron:dist'], 'legacy Electron packaging must require an explicit command');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'verify-aio-installer.ps1')));
});

test('AIO update smoke rejects client self-update exposure', () => {
  const smoke = read('update-smoke.js');
  assert.match(smoke, /client auto-update scripts/);
  assert.match(smoke, /plugin auto-update must default to disabled/);
});

test('release scripts compute SHA-256 without PowerShell module autoloading', () => {
  for (const rel of ['scripts/build-aio-release.ps1', 'scripts/verify-aio-installer.ps1']) {
    const source = read(rel);
    assert.match(source, /System\.Security\.Cryptography\.SHA256/);
    assert.ok(!source.includes('Get-FileHash'), `${rel} must work when Microsoft.PowerShell.Utility is not auto-loaded`);
  }
});

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

test('GUI smoke accepts the current semver display and requires bridge version parity', () => {
  const smoke = read('gui-smoke.js');
  assert.match(smoke, /\^v\\d\+\\\.\\d\+\\\.\\d\+/);
  assert.match(smoke, /recovery\.appVersion !== info\.appVersion/);
  assert.ok(!smoke.includes("info.appVersion !== 'v1'"));
  assert.ok(!smoke.includes("recovery.appVersion !== 'v1'"));
});

test('AIO remains isolated from every legacy product by default', () => {
  const conf = JSON.parse(read('tauri-app/tauri.conf.json'));
  const paths = read('tauri-app/src/paths.rs');
  const migrate = read('tauri-app/src/ve_migrate.rs');
  const nsh = read('tauri-app/nsis/installer-hooks.nsh');
  const electron = read('main.js');
  const shortcuts = read('tauri-app/src/shortcuts.rs');
  assert.equal(conf.identifier, 'com.deepseek.dsh.desktop.aio');
  assert.match(paths, /adopt_legacy_release_data\(&app_data_dir, &version\)/);
  assert.match(paths, /app_data_dir\.join\("releases"\)\.join\(version\)/);
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

test('every Tauri bundle rebuilds and privacy-checks its seed before staging', () => {
  const conf = JSON.parse(read('tauri-app/tauri.conf.json'));
  const pkg = JSON.parse(read('tauri-app/package.json'));
  assert.equal(conf.build.beforeBuildCommand, 'npm run prepare:bundle');
  const prepare = pkg.scripts['prepare:bundle'];
  assert.match(prepare, /sidecar:build/);
  assert.match(prepare, /sanitize-public-seed\.mjs \.\. && node scripts\/stage\.ts$/);
  assert.ok(prepare.indexOf('sidecar:build') < prepare.indexOf('sanitize-public-seed'));
  const root = JSON.parse(read('package.json'));
  assert.equal(root.scripts.pretest, 'npm --prefix tauri-app run sidecar:build');
});

test('AIO update smoke rejects client self-update exposure', () => {
  const smoke = read('update-smoke.js');
  assert.match(smoke, /client auto-update scripts/);
  assert.match(smoke, /plugin auto-update must default to disabled/);
});

test('AIO installer marks the watchdog state clean before forced restart cleanup', () => {
  const script = read('scripts/verify-aio-installer.ps1');
  assert.match(script, /function Mark-CleanExit\(/);
  assert.match(script, /Mark-CleanExit \(Join-Path \$isolatedUserData 'run-state\.json'\)/);
  assert.match(script, /WriteAllText\(\$StateFile, \(\$state \| ConvertTo-Json -Compress\)/);
  assert.match(script, /if \(\$appProcess\.HasExited\) \{ continue \}/);
  assert.doesNotMatch(script, /\$restartTail[\s\S]{0,300}if \(\$appProcess\.HasExited\) \{ break \}/);
});

test('staging restores the WebUI KaTeX fallback on the copied profile seed', () => {
  const stage = read('tauri-app/scripts/stage.ts');
  assert.match(stage, /patch-webui-katex\.mjs/);
  assert.match(stage, /patch-webui-continue\.mjs/);
  assert.match(stage, /patch-webui-prompt-optimize\.mjs/);
  assert.match(stage, /patch-webui-native-model-selection\.mjs/);
  assert.match(stage, /patch-webui-layout\.mjs/);
  assert.match(stage, /patch-status-rotator\.mjs/);
  assert.match(stage, /prepare-aio-staged-seed\.mjs/);
  const patcher = read('scripts/patch-webui-katex.mjs');
  assert.match(patcher, /migrateWebuiKatexFallback/);
  const seed = read('scripts/prepare-aio-staged-seed.mjs');
  assert.match(seed, /installWebuiUsageHost/);
  assert.match(seed, /builtinNames/);
});

test('release scripts compute SHA-256 without PowerShell module autoloading', () => {
  for (const rel of ['scripts/build-aio-release.ps1', 'scripts/verify-aio-installer.ps1']) {
    const source = read(rel);
    assert.match(source, /System\.Security\.Cryptography\.SHA256/);
    assert.ok(!source.includes('Get-FileHash'), `${rel} must work when Microsoft.PowerShell.Utility is not auto-loaded`);
  }
});

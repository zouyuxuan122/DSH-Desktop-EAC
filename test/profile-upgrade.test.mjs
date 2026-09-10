import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Compile only the helper in memory: no app launch, live profile or generated dist.
const require = createRequire(import.meta.url);
const ts = require('../tauri-app/node_modules/typescript');
const helper = fileURLToPath(new URL('../sidecar/src/lib/profile-upgrade.ts', import.meta.url));
const compiled = new Module(helper);
compiled.filename = helper;
compiled.paths = Module._nodeModulePaths(path.dirname(helper));
compiled._compile(ts.transpileModule(fs.readFileSync(helper, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, helper);
const { UPGRADE_TARGET, planProfileUpgrade, assertProfileStartup, stageProfileUpgrade } = compiled.exports;

function put(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
}
function fixture(t, kernel = '0.1.2') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const profile = path.join(root, 'home/profiles/web-desktop');
  put(app, 'package.json', { version: UPGRADE_TARGET.app });
  for (const name of ['dsh', 'dsh-base']) {
    put(app, `node_modules/@deepseek-ai/${name}/package.json`, { name: `@deepseek-ai/${name}`, version: UPGRADE_TARGET.kernel });
    put(profile, `node_modules/@deepseek-ai/${name}/package.json`, { name: `@deepseek-ai/${name}`, version: kernel });
  }
  put(profile, 'package.json', {
    dependencies: { '@deepseek-ai/dsh-base': kernel, 'custom-plugin': 'file:../private-plugin' },
    dsh: { profile: { bundles: ['custom-plugin', '@deepseek-ai/dsh-base'] } },
  });
  put(profile, 'cordis.patch.yml', '\uFEFF- id: custom\r\n  disabled: true\r\n  config: !!js privateChoice\r\n');
  put(profile, 'cordis.yml', '# custom root, do not normalize\r\n[]\r\n');
  put(profile, 'node_modules/custom-plugin/package.json', { name: 'custom-plugin', version: '7.0.0' });
  put(profile, 'node_modules/custom-plugin/private.json', '{"token":"private-fixture-only"}');
  put(profile, '.dsh-builtin-plugins.json', { names: ['custom-plugin'], removed: ['wallpaper'] });
  put(profile, 'pnpm-lock.yaml', '# preserved old lock\r\n');
  put(path.join(root, 'home'), 'settings.yaml', 'api-key: private-fixture-only\r\n');
  return { root, app, profile };
}
function bytes(root) {
  const result = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) result[path.relative(root, target)] = `link:${fs.readlinkSync(target)}`;
      else if (entry.isDirectory()) walk(target);
      else result[path.relative(root, target)] = fs.readFileSync(target).toString('base64');
    }
  }
  walk(root);
  return result;
}

test('old-profile plan is version-bound, read-only and startup fails closed', t => {
  const { app, profile, root } = fixture(t);
  const before = bytes(root);
  const plan = planProfileUpgrade(app, profile);
  assert.equal(plan.status, 'requires-installer');
  assert.deepEqual(plan.target, { app: '1.2.0', kernel: '0.1.3-alpha.2' });
  assert.deepEqual(plan.mismatches, ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']);
  assert.throws(() => assertProfileStartup(app, profile), /PROFILE_UPGRADE_REQUIRED/);
  assert.deepEqual(bytes(root), before);
});

test('staging preserves exact configs, custom packages, disabled choices and private settings', t => {
  const { app, profile, root } = fixture(t);
  const before = bytes(profile);
  const settings = fs.readFileSync(path.join(root, 'home/settings.yaml'));
  const staged = stageProfileUpgrade(app, profile);
  assert.deepEqual(bytes(profile), before);
  assert.deepEqual(bytes(path.join(staged.directory, 'candidate')), before);
  assert.deepEqual(fs.readFileSync(path.join(root, 'home/settings.yaml')), settings);
  const record = fs.readFileSync(path.join(staged.directory, 'upgrade.json'), 'utf8');
  const journal = JSON.parse(record);
  assert.equal(journal.state, 'awaiting-installer');
  assert.equal(journal.activationAllowed, false);
  assert.doesNotMatch(record, /private-fixture|privateChoice/);
  assert.ok(!record.includes(root));
  assert.throws(() => stageProfileUpgrade(app, profile), /STAGE_EXISTS/);
  assert.throws(() => assertProfileStartup(app, profile), /UPGRADE_REQUIRED/);
});

for (const point of ['created', 'copied', 'recorded']) {
  test(`staging error at ${point} rolls back only the owned staging directory`, t => {
    const { app, profile, root } = fixture(t);
    const before = bytes(root);
    assert.throws(() => stageProfileUpgrade(app, profile, phase => {
      if (phase === point) throw new Error('fixture error with private detail');
    }), /PROFILE_UPGRADE_STAGE_FAILED/);
    assert.deepEqual(bytes(root), before);
    assert.ok(!fs.existsSync(path.join(path.dirname(profile), '.web-desktop-upgrade-stage')));
  });
}

test('concurrent source changes abort without undoing the other writer', t => {
  const { app, profile } = fixture(t);
  assert.throws(() => stageProfileUpgrade(app, profile, phase => {
    if (phase === 'copied') put(profile, 'cordis.patch.yml', 'concurrent user choice');
  }), /STAGE_FAILED/);
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), 'concurrent user choice');
});

test('current installed graph passes; current manifest cannot hide old nested packages', t => {
  const { app, profile } = fixture(t, UPGRADE_TARGET.kernel);
  assert.equal(planProfileUpgrade(app, profile).status, 'compatible');
  assert.doesNotThrow(() => assertProfileStartup(app, profile));
  put(profile, 'node_modules/custom-plugin/node_modules/@deepseek-ai/dsh-base/package.json',
    { name: '@deepseek-ai/dsh-base', version: '0.1.2' });
  assert.throws(() => assertProfileStartup(app, profile), /UPGRADE_REQUIRED/);
});

test('new, partial, malformed and wrong-app profiles are distinguished conservatively', t => {
  const { app, root } = fixture(t);
  const fresh = path.join(root, 'home/profiles/fresh');
  assert.equal(planProfileUpgrade(app, fresh).status, 'new-profile');
  fs.mkdirSync(fresh);
  assert.equal(planProfileUpgrade(app, fresh).status, 'requires-installer');
  put(fresh, 'package.json', '{private-fixture-invalid');
  assert.throws(() => assertProfileStartup(app, fresh), error =>
    /UPGRADE_REQUIRED/.test(error.message) && !error.message.includes('private-fixture'));
  put(app, 'package.json', { version: '1.3.0' });
  assert.throws(() => assertProfileStartup(app, path.join(root, 'absent')), /UPGRADE_REQUIRED/);
});

test('overlapping paths and linked custom plugins are not staged or traversed', t => {
  const { app, profile, root } = fixture(t);
  assert.throws(() => stageProfileUpgrade(app, path.join(app, 'profile')), /UPGRADE_REQUIRED/);
  const external = path.join(root, 'external');
  put(external, 'keep', 'unchanged');
  fs.symlinkSync(external, path.join(profile, 'node_modules/linked-custom'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => stageProfileUpgrade(app, profile), /UPGRADE_REQUIRED/);
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'unchanged');
});

test('preexisting interrupted stage is neither deleted nor treated as success', t => {
  const { app, profile } = fixture(t, UPGRADE_TARGET.kernel);
  const stage = path.join(path.dirname(profile), '.web-desktop-upgrade-stage');
  put(stage, 'keep', 'interrupted transaction');
  assert.throws(() => assertProfileStartup(app, profile), /UPGRADE_REQUIRED/);
  assert.equal(fs.readFileSync(path.join(stage, 'keep'), 'utf8'), 'interrupted transaction');
});

function linkDirectory(target, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir');
}

test('extended-length Windows paths resolve instead of failing closed', t => {
  const { app, profile } = fixture(t, UPGRADE_TARGET.kernel);
  linkDirectory(path.join(profile, 'node_modules/@deepseek-ai/dsh-base'),
    path.join(profile, '.dsh-module-fallback/node_modules/@deepseek-ai/dsh-base'));
  assert.doesNotThrow(() => assertProfileStartup(app, profile));
  if (process.platform !== 'win32') return;
  // The desktop shell hands the sidecar \\?\ extended-length paths. Node's realpath
  // walks that prefix as ordinary segments and lstats a bare drive, raising EISDIR,
  // which previously failed every restart after the first launch.
  const extended = file => `\\\\?\\${path.resolve(file)}`;
  assert.equal(planProfileUpgrade(extended(app), extended(profile)).status, 'compatible');
  assert.doesNotThrow(() => assertProfileStartup(extended(app), extended(profile)));
});

test('normal restart accepts actual kernel-generated owned links and projections without mutations', async t => {
  const { healProfilesModuleFallback } = await import('@deepseek-ai/dsh-app-boot');
  const { app, profile, root } = fixture(t, UPGRADE_TARGET.kernel);
  const bundle = path.join(profile, 'node_modules/custom-plugin');
  put(bundle, 'package.json', { name: 'custom-plugin', version: '7.0.0',
    dependencies: { 'restart-dependency': '1.0.0', '@fixture/scoped-dependency': '1.0.0' } });
  for (const name of ['restart-dependency', '@fixture/scoped-dependency']) {
    put(bundle, `node_modules/${name}/package.json`, { name, version: '1.0.0' });
  }
  const options = {
    installAnchor: path.join(app, 'node_modules/@deepseek-ai/dsh/package.json'),
    home: path.join(root, 'home'),
    profile: { dir: profile, layers: [{ packageName: 'custom-plugin', packageDir: bundle }] },
  };
  assert.doesNotThrow(() => assertProfileStartup(app, profile));
  await healProfilesModuleFallback(options);
  const owned = path.join(profile, '.dsh-module-fallback/node_modules/restart-dependency');
  const projection = path.join(profile, 'node_modules/restart-dependency');
  assert.ok(fs.lstatSync(owned).isSymbolicLink());
  assert.ok(fs.lstatSync(projection).isSymbolicLink());
  const before = bytes(root);
  const first = planProfileUpgrade(app, profile);
  assert.equal(first.status, 'compatible');
  assert.doesNotThrow(() => assertProfileStartup(app, profile));
  await healProfilesModuleFallback(options);
  assert.doesNotThrow(() => assertProfileStartup(app, profile));
  assert.equal(planProfileUpgrade(app, profile).sourceDigest, first.sourceDigest);
  assert.deepEqual(bytes(root), before);
});

test('unused owned links to real top-level packages and trusted app packages are accepted', t => {
  const { app, profile } = fixture(t, UPGRADE_TARGET.kernel);
  linkDirectory(path.join(profile, 'node_modules/@deepseek-ai/dsh-base'),
    path.join(profile, '.dsh-module-fallback/node_modules/@deepseek-ai/dsh-base'));
  put(app, 'node_modules/app-bundle/node_modules/bundle-extra/package.json', { name: 'bundle-extra', version: '1.0.0' });
  const owned = path.join(profile, '.dsh-module-fallback/node_modules/bundle-extra');
  linkDirectory(path.join(app, 'node_modules/app-bundle/node_modules/bundle-extra'), owned);
  linkDirectory(owned, path.join(profile, 'node_modules/bundle-extra'));
  assert.doesNotThrow(() => assertProfileStartup(app, profile));
});

// The kernel points profile fallbacks at the shared layer <home>/profiles/node_modules,
// whose entries are themselves junctions. Those hops are trusted and must not block
// the second and later launches of an installed profile.
test('kernel shared dependency layer links are accepted on restart', t => {
  const { app, profile, root } = fixture(t, UPGRADE_TARGET.kernel);
  const shared = path.join(root, 'home/profiles/node_modules');
  const name = 'shared-dependency';
  put(app, `node_modules/${name}/package.json`, { name, version: '1.0.0' });
  linkDirectory(path.join(app, 'node_modules', name), path.join(shared, name));
  const owned = path.join(profile, '.dsh-module-fallback/node_modules', name);
  linkDirectory(path.join(shared, name), owned);
  linkDirectory(owned, path.join(profile, 'node_modules', name));
  const before = bytes(root);
  assert.equal(planProfileUpgrade(app, profile).status, 'compatible');
  assert.doesNotThrow(() => assertProfileStartup(app, profile));
  assert.deepEqual(bytes(root), before);
});

// Accepting the shared-layer hop must not become a way to escape the trusted roots.
test('shared layer links resolving outside the trusted roots still fail closed', t => {
  const { app, profile, root } = fixture(t, UPGRADE_TARGET.kernel);
  const shared = path.join(root, 'home/profiles/node_modules');
  const name = 'escaped-dependency';
  put(root, `outside/${name}/package.json`, { name, version: '1.0.0' });
  linkDirectory(path.join(root, 'outside', name), path.join(shared, name));
  const owned = path.join(profile, '.dsh-module-fallback/node_modules', name);
  linkDirectory(path.join(shared, name), owned);
  linkDirectory(owned, path.join(profile, 'node_modules', name));
  assert.throws(() => assertProfileStartup(app, profile), /PROFILE_UPGRADE_REQUIRED/);
});

for (const attack of ['external', 'sibling-prefix', 'wrong-name', 'manifest-alias', 'dangling',
  'cycle', 'linked-parent', 'direct-projection', 'wrong-owned-name', 'unowned-internal']) {
  test(`generated fallback exception rejects ${attack} links`, t => {
    const { app, profile, root } = fixture(t, UPGRADE_TARGET.kernel);
    const name = 'fixture-dependency';
    const target = path.join(profile, 'node_modules/custom-plugin/node_modules', name);
    const owned = path.join(profile, '.dsh-module-fallback/node_modules', name);
    const projected = path.join(profile, 'node_modules', name);
    put(target, 'package.json', { name, version: '1.0.0' });
    let destination = target;
    if (attack === 'external' || attack === 'sibling-prefix') {
      destination = path.join(attack === 'external' ? root : `${profile}-other`, 'node_modules', name);
      put(destination, 'package.json', { name, version: '1.0.0' });
    } else if (attack === 'wrong-name') {
      destination = path.join(profile, 'node_modules/custom-plugin');
    } else if (attack === 'manifest-alias') {
      put(target, 'package.json', { name: 'different-package', version: '1.0.0' });
    } else if (attack === 'dangling') {
      destination = path.join(profile, 'node_modules/missing');
    } else if (attack === 'cycle') {
      destination = projected;
    } else if (attack === 'linked-parent') {
      const alias = path.join(profile, 'node_modules/alias');
      linkDirectory(path.join(profile, 'node_modules/custom-plugin'), alias);
      destination = path.join(alias, 'node_modules', name);
    }
    linkDirectory(destination, owned);
    if (attack === 'direct-projection') linkDirectory(target, projected);
    else if (attack === 'wrong-owned-name') {
      linkDirectory(owned, path.join(profile, 'node_modules/unrelated'));
    } else if (attack === 'unowned-internal') {
      linkDirectory(target, path.join(profile, 'private-alias'));
    } else linkDirectory(owned, projected);
    const before = bytes(root);
    assert.throws(() => assertProfileStartup(app, profile), /PROFILE_UPGRADE_REQUIRED/);
    assert.deepEqual(bytes(root), before);
  });
}

test('valid generated fallback never hides a stale official package or authorizes unsafe staging', t => {
  const { app, profile, root } = fixture(t);
  linkDirectory(path.join(profile, 'node_modules/@deepseek-ai/dsh-base'),
    path.join(profile, '.dsh-module-fallback/node_modules/@deepseek-ai/dsh-base'));
  const before = bytes(root);
  assert.equal(planProfileUpgrade(app, profile).status, 'requires-installer');
  assert.throws(() => assertProfileStartup(app, profile), /UPGRADE_REQUIRED/);
  assert.throws(() => stageProfileUpgrade(app, profile), /UPGRADE_REQUIRED/);
  assert.deepEqual(bytes(root), before);
});

test('startup integration gates mutations and installs a clean profile into partial homes', () => {
  const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const core = read('sidecar/src/desktop-core.ts');
  assert.match(core, /function migrateAndSync[^]*?upgradePreflight\(\);[^]*?syncCompanionPlugins\(\)/);
  assert.doesNotMatch(core, /migrateFromSharedWebProfile|legacySkinChoice|market\.processPending/);
  assert.match(core, /function syncAll[^]*?upgradePreflight\(\);[^]*?syncCompanionPlugins\(\)/);
  assert.match(core, /activeKernel\?\.version !== UPGRADE_TARGET.kernel/);
  const boot = read('tauri-app/src/boot.rs');
  assert.match(boot, /pub fn start_and_show[^]*?profile\.upgradePreflight/);
  assert.match(boot, /pub fn guarded_start[^]*?profile\.upgradePreflight[^]*?guard\.snapshot/);
  assert.match(boot, /profile 迁移\/同步失败[^]*?return;/);
  const paths = read('tauri-app/src/paths.rs');
  assert.match(paths, /commit_distribution_profile_seed/);
  assert.match(paths, /pending-health/);
  assert.match(paths, /sessions, attachments, provider settings and credentials/);
});

test('Rust profile replacement tests pass through the real Cargo dependency graph', t => {
  const manifest = fileURLToPath(new URL('../tauri-app/Cargo.toml', import.meta.url));
  const run = spawnSync('cargo', ['test', '--manifest-path', manifest, 'paths::tests', '--no-fail-fast'], {
    // A clean release target compiles the full Tauri graph before these focused
    // tests run. Leave enough room for that cold build on Windows CI.
    encoding: 'utf8', timeout: 300000, windowsHide: true,
  });
  if (run.error?.code === 'ENOENT') return t.skip('cargo unavailable');
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /test result: ok\.\s+\d+ passed; 0 failed/);
});

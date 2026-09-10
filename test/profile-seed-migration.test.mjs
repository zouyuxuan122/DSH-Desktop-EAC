import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('../tauri-app/node_modules/typescript');
const filename = fileURLToPath(new URL('../sidecar/src/lib/profile-seed-migration.ts', import.meta.url));
const module = new Module(filename);
module.filename = filename;
module.paths = Module._nodeModulePaths(path.dirname(filename));
module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, filename);
const {
  MIGRATION_TARGET, REVIEWED_SOURCE_DEPENDENCIES, REVIEWED_BASELINE_BUNDLES, APPROVED_RETIREMENT_PACKAGES,
  inspectMigrationSeed, prepareSeedMigration, activateSeedMigration,
  rollbackSeedMigration, recoverSeedMigration, commitSeedMigration, MigrationInterruption,
} = module.exports;
const quiet = { assertQuiescent: () => true }; // Only synthetic directories, never a running profile.
const renderer = '@deepseek-ai/dsh-client-ui-renderer';
const legacy = '@deepseek-ai/dsh-client-web-react';
const compat = 'dsh-aio-ui-compat';
function put(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}
function read(root, relative = 'package.json') {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, ''));
}
function bytes(root) {
  const result = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) result[path.relative(root, file)] = `link:${fs.readlinkSync(file)}`;
      else if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  walk(root);
  return result;
}
function packageAt(root, name, version, bundle = false) {
  const directory = path.join(root, 'node_modules', name);
  put(directory, 'package.json', {
    name, version, type: 'module', exports: { '.': { import: './index.js' } },
    ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
  });
  put(directory, 'index.js', 'export const name = "fixture";\n');
  if (bundle) put(directory, 'cordis.patch.yml', '[]\n');
}
function fixture(t, { lean = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-migration-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('seed-migration-fixture-'));
    assert.ok(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'home/profiles/web-desktop');
  const seed = path.join(root, 'reviewed-seed/profiles/web-desktop');
  const dependencies = Object.fromEntries(Object.entries(REVIEWED_SOURCE_DEPENDENCIES).map(([name, versions]) =>
    [name, name.startsWith('@deepseek-ai/') ? '0.1.0-rc.7' : versions[0]]));
  const bundles = [...REVIEWED_BASELINE_BUNDLES].reverse();
  put(source, 'package.json', {
    name: 'private-profile', private: true, dependencies,
    dsh: { custom: { retained: true }, profile: { bundles, patchReload: 'live', metadata: 'keep-profile' } },
    customMetadata: { owner: 'private-user-fixture', order: [3, 1, 2] },
  });
  put(source, 'cordis.yml', '\uFEFF# keep root comments and CRLF\r\n[]\r\n');
  put(source, 'cordis.patch.yml', '\uFEFF# private choices\r\n- insert:\r\n'
    + '    - id: retained-disabled\r\n      name: dsh-status-rotator\r\n      disabled: true\r\n'
    + '      config:\r\n        name: not-a-package\r\n        token: synthetic-private-value\r\n'
    + '        transform: !!js "ctx => ctx.value"\r\n');
  put(source, '.env', 'PRIVATE_TOKEN=synthetic-private-value\r\n');
  put(source, 'settings.yaml', 'token: synthetic-private-value\r\n');
  put(source, 'private/subdir/state.bin', 'opaque\0private\u0001');
  put(source, '.dsh-builtin-plugins.json', { removed: ['wallpaper'], disabled: ['offpeak'] });
  put(source, 'pnpm-workspace.yaml', 'packages:\n  - .\nnodeLinker: hoisted\nonlyBuiltDependencies:\n  - koffi\n');
  put(source, 'pnpm-lock.yaml', 'old dependency lock\n');
  put(source, 'package-lock.json', { old: 'dependency lock' });
  packageAt(source, legacy, '0.1.0-rc.7');
  put(path.join(root, 'home'), 'settings.yaml', 'api-key: home-private-value\r\n');
  const newDeps = {};
  for (const [name, versions] of Object.entries(REVIEWED_SOURCE_DEPENDENCIES)) {
    if (lean && ['@vlln/dsh-navbar', 'dsh-smooth-stream', 'dsh-usage-skill'].includes(name)) continue;
    const targetName = name === legacy ? renderer : name;
    newDeps[targetName] = name.startsWith('@deepseek-ai/') ? MIGRATION_TARGET.kernel : versions.at(-1);
  }
  Object.assign(newDeps, { '@deepseek-ai/dsh': MIGRATION_TARGET.kernel,
    '@deepseek-ai/dsh-base': MIGRATION_TARGET.kernel, '@deepseek-ai/dsh-web-app': MIGRATION_TARGET.kernel,
    [compat]: '1.0.0' });
  const overrides = Object.fromEntries(Object.keys(newDeps).filter(name => name.startsWith('@deepseek-ai/'))
    .map(name => [name, MIGRATION_TARGET.kernel]));
  put(seed, 'package.json', { name: 'public-seed', private: true, dependencies: newDeps, overrides,
    dsh: { profile: { bundles: [...REVIEWED_BASELINE_BUNDLES, compat] } } });
  put(seed, 'settings.yaml', 'public-default: must-not-overwrite-source\n');
  put(seed, 'cordis.patch.yml', '[]\n');
  for (const [name, version] of Object.entries(newDeps)) {
    packageAt(seed, name, version, REVIEWED_BASELINE_BUNDLES.includes(name) || name === compat);
  }
  const options = { ...quiet, sourceProfile: source, seedProfile: seed,
    reviewedSeedDigest: inspectMigrationSeed(seed).digest };
  return { root, source, seed, options };
}
function onlyTransaction(source) {
  const parent = path.dirname(source);
  const names = fs.readdirSync(parent).filter(name => name.startsWith('.web-desktop-seed-migration-'));
  assert.equal(names.length, 1);
  return path.join(parent, names[0]);
}
function interrupt(phase) {
  return { ...quiet, checkpoint: at => { if (at === phase) throw new MigrationInterruption(phase); } };
}

const market = '@sanqi-normal/dsh-webui-market-plugin';
const digest = value => createHash('sha256').update(value).digest('hex');
function retirementFixture(t) {
  const f = fixture(t, { lean: true });
  const kept = fs.readFileSync(path.join(f.source, 'cordis.patch.yml'), 'utf8');
  const retired = '- insert:\r\n    - id: offpeak\r\n      name: dsh-offpeak\r\n      disabled: true\r\n'
    + '      config:\r\n        token: synthetic-retired-token\r\n'
    + '        prompt: |\r\n          keep this private prompt\r\n          # literal private line\r\n'
    + '# keep next row comment byte-identical\r\n'
    + `- insert:\r\n    - id: dsh-market-plugin\r\n      name: '${market}'\r\n`
    + '      config:\r\n        privateEndpoint: synthetic-market-setting\r\n';
  put(f.source, 'cordis.patch.yml', kept + retired);
  const policy = {
    seedDigest: f.options.reviewedSeedDigest,
    patches: [{ file: 'cordis.patch.yml', originalSha256: digest(fs.readFileSync(path.join(f.source, 'cordis.patch.yml'))),
      rows: [{ package: 'dsh-offpeak', id: 'offpeak' },
        { package: market, id: 'dsh-market-plugin', allowEnabled: true }] }],
  };
  return { ...f, kept, retired, policy, options: { ...f.options, retirementPolicy: policy } };
}

test('retirement is opt-in, preserves original patches/archive/backup and every unrelated user byte', t => {
  const { source, options, kept, policy } = retirementFixture(t);
  const original = bytes(source);
  assert.equal(Object.keys(read(source).dependencies).length, 16);
  assert.throws(() => prepareSeedMigration({ ...options, retirementPolicy: undefined }), /UNRESOLVED_REFERENCE/);
  const tx = prepareSeedMigration(options);
  assert.deepEqual(bytes(source), original);
  const projected = fs.readFileSync(path.join(tx.candidate, 'cordis.patch.yml'), 'utf8');
  assert.ok(projected.startsWith(kept));
  assert.ok(projected.includes('\r\n# keep next row comment byte-identical\r\n'));
  assert.match(projected, /#       name: dsh-offpeak/);
  assert.match(projected, /#         privateEndpoint: synthetic-market-setting/);
  assert.deepEqual(fs.readFileSync(path.join(tx.transaction, 'retirement-originals/cordis.patch.yml')),
    fs.readFileSync(path.join(source, 'cordis.patch.yml')));
  const candidate = bytes(tx.candidate);
  for (const name of ['@vlln/dsh-navbar', 'dsh-smooth-stream', 'dsh-usage-skill']) {
    assert.ok(!Object.hasOwn(read(tx.candidate).dependencies, name));
  }
  for (const [file, value] of Object.entries(original)) {
    if (['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'package-lock.json'].includes(file)
        || file.startsWith(`node_modules${path.sep}`)) continue;
    assert.equal(candidate[file], value, file);
  }
  const journal = read(tx.transaction, 'journal-000001.json');
  assert.deepEqual(journal.retirement.policy, policy);
  assert.equal(journal.retirement.patches[0].projectedSha256, digest(Buffer.from(projected)));
  for (const file of fs.readdirSync(tx.transaction).filter(name => name.endsWith('.json'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(tx.transaction, file), 'utf8'), /synthetic-retired-token|synthetic-market-setting/);
  }
  inspectMigrationSeed(tx.candidate, true);
  assert.equal(activateSeedMigration(tx.transaction, quiet).state, 'pending-health');
  assert.deepEqual(bytes(tx.backup), original);
  assert.equal(rollbackSeedMigration(tx.transaction, quiet).state, 'rolled-back');
  assert.deepEqual(bytes(source), original);
  assert.deepEqual(bytes(tx.backup), original);
  assert.ok(fs.existsSync(tx.retainedActive));
  assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
});

for (const kind of ['seed-binding', 'patch-binding', 'unknown-package', 'wrong-id', 'duplicate-consent',
  'extra-policy-key', 'file-traversal', 'market-no-enabled-consent', 'other-enabled-consent', 'missing-row',
  'unlisted-missing-reference', 'unlisted-disabled-reference', 'dynamic-name', 'dynamic-id', 'dynamic-disabled',
  'duplicate-id', 'id-only-override', 'nested-group', 'multiple-inserts', 'flow-root', 'anchor', 'merge',
  'unknown-directive', 'unlisted-retired-id']) {
  test(`retirement rejects ${kind} before allocating a transaction`, t => {
    const { root, source, options, policy } = retirementFixture(t);
    const patch = policy.patches[0];
    if (kind === 'seed-binding') policy.seedDigest = '0'.repeat(64);
    if (kind === 'patch-binding') patch.originalSha256 = '0'.repeat(64);
    if (kind === 'unknown-package') patch.rows[0].package = 'unreviewed-package';
    if (kind === 'wrong-id') patch.rows[0].id = 'wrong-id';
    if (kind === 'duplicate-consent') patch.rows.push({ ...patch.rows[0] });
    if (kind === 'extra-policy-key') policy.ignoreMissing = true;
    if (kind === 'file-traversal') patch.file = '../private.yml';
    if (kind === 'market-no-enabled-consent') delete patch.rows[1].allowEnabled;
    if (kind === 'other-enabled-consent') patch.rows[0].allowEnabled = true;
    let text = fs.readFileSync(path.join(source, 'cordis.patch.yml'), 'utf8');
    if (kind === 'missing-row') text = text.replace('name: dsh-offpeak', 'name: dsh-status-rotator');
    if (kind === 'unlisted-missing-reference') text += '- name: unreviewed-package\r\n';
    if (kind === 'unlisted-disabled-reference') text += '- name: unreviewed-package\r\n  disabled: true\r\n';
    if (kind === 'dynamic-name') text = text.replace('name: dsh-offpeak', 'name: !!js "getRetiredName()"');
    if (kind === 'dynamic-id') text = text.replace('id: offpeak', 'id: !!js "getRetiredId()"');
    if (kind === 'dynamic-disabled') text = text.replace('name: dsh-offpeak\r\n      disabled: true',
      'name: dsh-offpeak\r\n      disabled: !!js "maybeDisabled()"');
    if (kind === 'duplicate-id') text += '- id: offpeak\r\n  name: dsh-status-rotator\r\n';
    if (kind === 'id-only-override') text += '- id: offpeak\r\n  disabled: false\r\n';
    if (kind === 'nested-group') text = text.replace('- insert:\r\n    - id: offpeak',
      '- name: cordis:group\r\n  config:\r\n    - id: offpeak');
    if (kind === 'multiple-inserts') text = text.replace('- insert:\r\n    - id: offpeak',
      '- insert:\r\n    - id: second\r\n      name: dsh-status-rotator\r\n    - id: offpeak');
    if (kind === 'flow-root') text = `[{id: offpeak, name: dsh-offpeak, disabled: true}, {id: dsh-market-plugin, name: '${market}'}]\n`;
    if (kind === 'anchor') text = text.replace('id: offpeak', 'id: &retiredId offpeak');
    if (kind === 'merge') text = text.replace('id: offpeak', '<<: {id: offpeak}');
    if (kind === 'unknown-directive') text += '- remove: !!js "selectAnyId()"\r\n';
    if (kind === 'unlisted-retired-id') text += '- id: unconsented-offpeak\r\n  name: dsh-offpeak\r\n  disabled: true\r\n';
    if (kind !== 'file-traversal') {
      put(source, 'cordis.patch.yml', text);
      if (kind !== 'patch-binding') patch.originalSha256 = digest(Buffer.from(text));
    }
    const before = bytes(root);
    assert.throws(() => prepareSeedMigration(options), error =>
      error.message.startsWith('SEED_MIGRATION_') && !/synthetic-|getRetired/.test(error.message));
    assert.deepEqual(bytes(root), before);
  });
}

test('every exact approved removal supports disabled rows against a lean seed, without changing source', t => {
  const { source, options, policy } = retirementFixture(t);
  const rows = APPROVED_RETIREMENT_PACKAGES.map((name, index) => ({ package: name, id: `retired-${index}` }));
  const text = rows.map(row => `- insert:\n    - id: ${row.id}\n      name: '${row.package}'\n      disabled: true\n`).join('');
  put(source, 'cordis.patch.yml', text);
  policy.patches = [{ file: 'cordis.patch.yml', originalSha256: digest(Buffer.from(text)), rows }];
  const tx = prepareSeedMigration(options);
  assert.equal(Object.keys(read(source).dependencies).length, 16);
  assert.deepEqual(require('js-yaml').load(fs.readFileSync(path.join(tx.candidate, 'cordis.patch.yml'), 'utf8')), []);
  assert.equal(read(tx.transaction, 'journal-000001.json').retirement.policy.patches[0].rows.length, APPROVED_RETIREMENT_PACKAGES.length);
});

test('failed retirement preparation retains exact archive and leaves every source byte unchanged', t => {
  const { source, options } = retirementFixture(t);
  const original = bytes(source);
  assert.throws(() => prepareSeedMigration({ ...options, checkpoint: at => {
    if (at === 'candidate-copied') throw new Error('synthetic copy failure');
  } }), /PREPARE_FAILED/);
  const transaction = onlyTransaction(source);
  assert.equal(recoverSeedMigration(transaction, quiet).state, 'prepare-failed');
  assert.deepEqual(bytes(source), original);
  assert.deepEqual(fs.readFileSync(path.join(transaction, 'retirement-originals/cordis.patch.yml')),
    fs.readFileSync(path.join(source, 'cordis.patch.yml')));
});

test('ordinary retirement activation failure compensates and keeps the archive plus full backup', t => {
  const { source, options } = retirementFixture(t);
  const original = bytes(source);
  const tx = prepareSeedMigration(options);
  assert.throws(() => activateSeedMigration(tx.transaction, { ...quiet, checkpoint: at => {
    if (at === 'candidate-renamed') throw new Error('synthetic activation failure');
  } }), /ACTIVATION_ROLLED_BACK/);
  assert.deepEqual(bytes(source), original);
  assert.deepEqual(bytes(tx.backup), original);
  assert.deepEqual(fs.readFileSync(path.join(tx.transaction, 'retirement-originals/cordis.patch.yml')),
    fs.readFileSync(path.join(source, 'cordis.patch.yml')));
  assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
});

test('retirement refuses a changed source patch or projected patch without overwriting either', t => {
  const { source, options } = retirementFixture(t);
  const original = fs.readFileSync(path.join(source, 'cordis.patch.yml'));
  const tx = prepareSeedMigration(options);
  put(source, 'cordis.patch.yml', original.toString('utf8') + '# changed consent bytes\n');
  assert.throws(() => activateSeedMigration(tx.transaction, quiet), /SOURCE_CHANGED/);
  fs.writeFileSync(path.join(source, 'cordis.patch.yml'), original);
  put(tx.candidate, 'cordis.patch.yml', '[]\n');
  assert.throws(() => activateSeedMigration(tx.transaction, quiet), /CANDIDATE_CHANGED/);
  assert.ok(!fs.existsSync(tx.backup));
});

test('retirement rejects a still-installed package even with caller consent', t => {
  const { root, seed, options, policy } = retirementFixture(t);
  packageAt(seed, 'dsh-offpeak', '1.0.0');
  options.reviewedSeedDigest = inspectMigrationSeed(seed).digest;
  policy.seedDigest = options.reviewedSeedDigest;
  const before = bytes(root);
  assert.throws(() => prepareSeedMigration(options), /RETIRED_PACKAGE_PRESENT/);
  assert.deepEqual(bytes(root), before);
});

test('all-retired patches project to an explicit empty sequence and preserve CRLF plus BOM', t => {
  const { source, options, policy, retired } = retirementFixture(t);
  put(source, 'cordis.patch.yml', '\uFEFF' + retired);
  policy.patches[0].originalSha256 = digest(fs.readFileSync(path.join(source, 'cordis.patch.yml')));
  const tx = prepareSeedMigration(options);
  const text = fs.readFileSync(path.join(tx.candidate, 'cordis.patch.yml'), 'utf8');
  assert.ok(text.startsWith('\uFEFF'));
  assert.ok(text.endsWith('[]\r\n'));
  assert.deepEqual(require('js-yaml').load(text), []);
});

test('retirement archives both patch files and rejects archive tampering before activation', t => {
  const { source, options, policy } = retirementFixture(t);
  put(source, 'cordis.yml', '- id: navbar\n  name: "@vlln/dsh-navbar"\n  disabled: true\n');
  policy.patches.push({ file: 'cordis.yml', originalSha256: digest(fs.readFileSync(path.join(source, 'cordis.yml'))),
    rows: [{ id: 'navbar', package: '@vlln/dsh-navbar' }] });
  const original = bytes(source);
  const tx = prepareSeedMigration(options);
  assert.deepEqual(fs.readFileSync(path.join(tx.transaction, 'retirement-originals/cordis.yml')),
    fs.readFileSync(path.join(source, 'cordis.yml')));
  put(tx.transaction, 'retirement-originals/cordis.patch.yml', 'changed archive\n');
  assert.throws(() => activateSeedMigration(tx.transaction, quiet), /RETIREMENT_ARCHIVE_CHANGED/);
  assert.deepEqual(bytes(source), original);
  assert.ok(!fs.existsSync(tx.backup));
});

for (const phase of ['source-renamed', 'candidate-renamed', 'active-retained', 'original-restored']) {
  test(`retirement preserves archive and exact originals across interrupted ${phase}`, t => {
    const { source, options } = retirementFixture(t);
    const original = bytes(source);
    const patch = fs.readFileSync(path.join(source, 'cordis.patch.yml'));
    const tx = prepareSeedMigration(options);
    if (phase === 'source-renamed' || phase === 'candidate-renamed') {
      assert.throws(() => activateSeedMigration(tx.transaction, interrupt(phase)), MigrationInterruption);
    } else {
      activateSeedMigration(tx.transaction, quiet);
      assert.throws(() => rollbackSeedMigration(tx.transaction, interrupt(phase)), MigrationInterruption);
    }
    assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
    assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
    assert.deepEqual(bytes(source), original);
    assert.deepEqual(bytes(tx.backup), original);
    assert.deepEqual(fs.readFileSync(path.join(tx.transaction, 'retirement-originals/cordis.patch.yml')), patch);
  });
}

test('prepare replaces reviewed dependency graph, preserves all user bytes and metadata, and leaves source/seed/home unchanged', t => {
  const { root, source, seed, options } = fixture(t);
  const sourceBefore = bytes(source);
  const seedBefore = bytes(seed);
  const homeSettings = fs.readFileSync(path.join(root, 'home/settings.yaml'));
  const old = read(source);
  const tx = prepareSeedMigration(options);
  assert.equal(tx.state, 'prepared');
  assert.deepEqual(bytes(source), sourceBefore);
  assert.deepEqual(bytes(seed), seedBefore);
  assert.deepEqual(fs.readFileSync(path.join(root, 'home/settings.yaml')), homeSettings);
  const merged = read(tx.candidate);
  assert.ok(!Object.hasOwn(merged.dependencies, legacy));
  assert.equal(merged.dependencies[renderer], MIGRATION_TARGET.kernel);
  assert.equal(merged.dependencies[compat], '1.0.0');
  assert.deepEqual(merged.dsh.profile.bundles, [...old.dsh.profile.bundles, compat]);
  assert.deepEqual(merged.customMetadata, old.customMetadata);
  assert.deepEqual(merged.dsh.custom, old.dsh.custom);
  assert.equal(merged.dsh.profile.metadata, 'keep-profile');
  for (const relative of ['cordis.yml', 'cordis.patch.yml', '.env', 'settings.yaml',
    'private/subdir/state.bin', '.dsh-builtin-plugins.json', 'pnpm-workspace.yaml']) {
    assert.deepEqual(fs.readFileSync(path.join(tx.candidate, relative)), fs.readFileSync(path.join(source, relative)));
  }
  assert.ok(!fs.existsSync(path.join(tx.candidate, 'pnpm-lock.yaml')));
  assert.ok(!fs.existsSync(path.join(tx.candidate, 'package-lock.json')));
  for (const file of fs.readdirSync(tx.transaction).filter(name => name.endsWith('.json'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(tx.transaction, file), 'utf8'), /synthetic-private|private-user|home-private/);
  }
});

test('clean profile mode inherits only home sessions, attachments and provider credentials', t => {
  const { root, source, seed, options } = fixture(t);
  const home = path.join(root, 'home');
  put(home, '.credentials.yaml', 'llm-deepseek:\n  apiKey: SYNTHETIC-PRIVATE-KEY\n');
  put(home, 'sessions/session-a/events.jsonl', '{"type":"message","text":"private session"}\n');
  fs.mkdirSync(path.join(home, 'attachments/v1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'attachments/v1/blob-a'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(home, 'unrelated-root-state.bin'), Buffer.from([9, 8, 7]));
  const preserved = Object.fromEntries([
    'settings.yaml', '.credentials.yaml', 'sessions/session-a/events.jsonl',
    'attachments/v1/blob-a', 'unrelated-root-state.bin',
  ].map(relative => [relative, fs.readFileSync(path.join(home, relative))]));
  const sourceBefore = bytes(source);
  const seedBefore = bytes(seed);

  assert.throws(() => prepareSeedMigration({ ...options, inheritProfile: 'none',
    retirementPolicy: { seedDigest: options.reviewedSeedDigest, patches: [] } }), /INVALID_RETIREMENT_POLICY/);
  const tx = prepareSeedMigration({ ...options, inheritProfile: 'none' });
  assert.equal(tx.state, 'prepared');
  assert.deepEqual(bytes(source), sourceBefore, 'prepare must not modify the old profile');
  assert.deepEqual(bytes(tx.candidate), seedBefore, 'candidate must be an exact reviewed seed copy');
  assert.equal(read(tx.transaction, 'journal-000001.json').inheritProfile, 'none');
  for (const relative of ['settings.yaml', '.env', 'private/subdir/state.bin', '.dsh-builtin-plugins.json']) {
    assert.ok(!fs.existsSync(path.join(tx.candidate, relative)) || fs.existsSync(path.join(seed, relative)), relative);
  }
  for (const [relative, value] of Object.entries(preserved)) {
    assert.deepEqual(fs.readFileSync(path.join(home, relative)), value, relative);
  }

  assert.equal(activateSeedMigration(tx.transaction, quiet).state, 'pending-health');
  assert.deepEqual(bytes(source), seedBefore, 'active profile must equal the reviewed seed');
  assert.deepEqual(bytes(tx.backup), sourceBefore, 'full old profile remains available for rollback');
  for (const [relative, value] of Object.entries(preserved)) {
    assert.deepEqual(fs.readFileSync(path.join(home, relative)), value, relative);
  }

  assert.equal(rollbackSeedMigration(tx.transaction, quiet).state, 'rolled-back');
  assert.deepEqual(bytes(source), sourceBefore);
  assert.deepEqual(bytes(tx.retainedActive), seedBefore);
  for (const [relative, value] of Object.entries(preserved)) {
    assert.deepEqual(fs.readFileSync(path.join(home, relative)), value, relative);
  }
});

test('generated fallback links are not copied into candidate, original backup and rollback retain literal links', t => {
  const { root, source, options } = fixture(t);
  const external = path.join(root, 'old-store');
  put(external, 'never-read', 'retained outside source');
  const link = path.join(source, '.dsh-module-fallback/node_modules/old-package');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const original = bytes(source);
  const tx = prepareSeedMigration(options);
  assert.ok(!fs.existsSync(path.join(tx.candidate, '.dsh-module-fallback')));
  activateSeedMigration(tx.transaction, quiet);
  assert.deepEqual(bytes(tx.backup), original);
  rollbackSeedMigration(tx.transaction, quiet);
  assert.deepEqual(bytes(source), original);
  assert.deepEqual(bytes(tx.backup), original);
  assert.equal(fs.readFileSync(path.join(external, 'never-read'), 'utf8'), 'retained outside source');
});

for (const extra of ['dependency', 'bundle', 'patch', 'disabled-patch', 'group-patch', 'canonical-group',
  'dynamic-name', 'local-include', 'canonical-include', 'workspace', 'user-link']) {
  test(`rejects unknown ${extra} before allocating transaction, without echoing private values`, t => {
    const { root, source, options } = fixture(t);
    const manifest = read(source);
    if (extra === 'dependency') manifest.dependencies['private-extra-package'] = 'file:C:/secret-location';
    if (extra === 'bundle') manifest.dsh.profile.bundles[0] = 'private-extra-package';
    put(source, 'package.json', manifest);
    if (extra === 'patch' || extra === 'disabled-patch') {
      put(source, 'cordis.patch.yml', `- name: private-extra-package\n  disabled: ${extra === 'disabled-patch'}\n`);
    }
    if (extra === 'group-patch') put(source, 'cordis.patch.yml',
      '- name: cordis:group\n  group: true\n  config:\n    - name: private-extra-package\n');
    if (extra === 'canonical-group') put(source, 'cordis.patch.yml',
      '- name: "@deepseek-ai/cordis-plugin-group"\n  config:\n    - name: private-extra-package\n');
    if (extra === 'dynamic-name') put(source, 'cordis.patch.yml', '- name: !!js "privateDynamicName"\n');
    if (extra === 'local-include') put(source, 'cordis.patch.yml', '- name: cordis:include\n  config:\n    path: private.yml\n');
    if (extra === 'canonical-include') put(source, 'cordis.patch.yml',
      '- name: "@deepseek-ai/cordis-plugin-include"\n  config:\n    path: private.yml\n');
    if (extra === 'workspace') put(source, 'pnpm-workspace.yaml', 'packages: [., private-workspace]\n');
    if (extra === 'user-link') {
      const external = path.join(root, 'private-data');
      fs.mkdirSync(external);
      fs.symlinkSync(external, path.join(source, 'linked-private'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const before = bytes(root);
    assert.throws(() => prepareSeedMigration(options), error =>
      error.message.startsWith('SEED_MIGRATION_') && !/private|secret-location/.test(error.message));
    assert.deepEqual(bytes(root), before);
  });
}

test('no implicit quiescence and no unreviewed seed accepted', t => {
  const { root, options } = fixture(t);
  const before = bytes(root);
  assert.throws(() => prepareSeedMigration({ ...options, assertQuiescent: undefined }), /QUIESCENCE_REQUIRED/);
  assert.throws(() => prepareSeedMigration({ ...options, assertQuiescent: () => false }), /QUIESCENCE_REQUIRED/);
  assert.throws(() => prepareSeedMigration({ ...options, reviewedSeedDigest: 'unreviewed' }), /SEED_REVIEW_MISMATCH/);
  assert.deepEqual(bytes(root), before);
});

test('target versions and runtime entry resolution are validated before preparation', t => {
  const { seed, options } = fixture(t);
  put(seed, `node_modules/${renderer}/package.json`, { name: renderer, version: '0.1.2' });
  const changed = { ...options, reviewedSeedDigest: inspectMigrationSeed(seed).digest };
  assert.throws(() => prepareSeedMigration(changed), /TARGET_VERSION/);
});

test('a package.json alone cannot satisfy a retained patch reference', t => {
  const { seed, options } = fixture(t);
  const file = 'node_modules/dsh-status-rotator/package.json';
  const manifest = read(seed, file);
  manifest.exports = { '.': { import: './missing-entry.js' } };
  put(seed, file, manifest);
  assert.throws(() => prepareSeedMigration({ ...options, reviewedSeedDigest: inspectMigrationSeed(seed).digest }), /SEED_MIGRATION_/);
});

test('activation refuses a changed source or candidate, retaining every file', t => {
  const { source, options } = fixture(t);
  const tx = prepareSeedMigration(options);
  put(source, 'settings.yaml', 'new user choice\n');
  const before = bytes(source);
  assert.throws(() => activateSeedMigration(tx.transaction, quiet), /SOURCE_CHANGED/);
  assert.deepEqual(bytes(source), before);
  assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'prepared');
});

test('candidate tampering refuses activation before the source rename', t => {
  const { source, options } = fixture(t);
  const before = bytes(source);
  const tx = prepareSeedMigration(options);
  put(tx.candidate, 'private/addition', 'unexpected');
  assert.throws(() => activateSeedMigration(tx.transaction, quiet), /CANDIDATE_CHANGED/);
  assert.deepEqual(bytes(source), before);
  assert.ok(!fs.existsSync(tx.backup));
});

test('activation is pending-health, recovery never commits it, and rollback retains backup plus new user writes', t => {
  const { source, options } = fixture(t);
  const old = bytes(source);
  const tx = prepareSeedMigration(options);
  assert.equal(activateSeedMigration(tx.transaction, quiet).state, 'pending-health');
  assert.equal(activateSeedMigration(tx.transaction, quiet).state, 'pending-health');
  assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'pending-health');
  assert.throws(() => commitSeedMigration(tx.transaction, { ...quiet, validateBoot: () => false }), /BOOT_NOT_VALIDATED/);
  put(source, 'settings.yaml', 'new state from candidate boot\n');
  const newState = bytes(source);
  assert.equal(rollbackSeedMigration(tx.transaction, quiet).state, 'rolled-back');
  assert.deepEqual(bytes(source), old);
  assert.deepEqual(bytes(tx.backup), old);
  assert.deepEqual(bytes(tx.retainedActive), newState);
  assert.equal(rollbackSeedMigration(tx.transaction, quiet).state, 'rolled-back');
  assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
});

test('health commit requires explicit validation and retains original backup', t => {
  const { source, options } = fixture(t);
  const old = bytes(source);
  const tx = prepareSeedMigration(options);
  assert.throws(() => commitSeedMigration(tx.transaction, quiet), /HEALTH_NOT_PENDING/);
  activateSeedMigration(tx.transaction, quiet);
  assert.throws(() => commitSeedMigration(tx.transaction, quiet), /BOOT_NOT_VALIDATED/);
  let checks = 0;
  assert.equal(commitSeedMigration(tx.transaction, {
    ...quiet, validateBoot: (active, target) => {
      assert.equal(active, source);
      assert.deepEqual(target, MIGRATION_TARGET);
      checks++;
      return true;
    },
  }).state, 'committed');
  assert.equal(checks, 1);
  assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'committed');
  assert.deepEqual(bytes(tx.backup), old);
  assert.equal(rollbackSeedMigration(tx.transaction, quiet).state, 'rolled-back');
  assert.deepEqual(bytes(source), old);
});

for (const phase of ['activating', 'source-renamed', 'candidate-renamed', 'pending-health']) {
  test(`ordinary activation error at ${phase} compensates without deleting original or new data`, t => {
    const { source, options } = fixture(t);
    const old = bytes(source);
    const tx = prepareSeedMigration(options);
    assert.throws(() => activateSeedMigration(tx.transaction, {
      ...quiet, checkpoint: at => { if (at === phase) throw new Error('injected file-operation failure'); },
    }), /ACTIVATION_ROLLED_BACK/);
    assert.deepEqual(bytes(source), old);
    assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
    if (fs.existsSync(tx.backup)) assert.deepEqual(bytes(tx.backup), old);
  });
}

for (const phase of ['activating', 'source-renamed', 'candidate-renamed']) {
  test(`interrupted activation at ${phase} recovers idempotently to original`, t => {
    const { source, options } = fixture(t);
    const old = bytes(source);
    const tx = prepareSeedMigration(options);
    assert.throws(() => activateSeedMigration(tx.transaction, interrupt(phase)), MigrationInterruption);
    assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
    const recovered = bytes(path.dirname(source));
    assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
    assert.deepEqual(bytes(path.dirname(source)), recovered);
    assert.deepEqual(bytes(source), old);
  });
}

for (const phase of ['rolling-back', 'restore-copied', 'active-retained', 'original-restored', 'rolled-back']) {
  test(`interrupted rollback at ${phase} is recoverable and retains backup`, t => {
    const { source, options } = fixture(t);
    const old = bytes(source);
    const tx = prepareSeedMigration(options);
    activateSeedMigration(tx.transaction, quiet);
    put(source, 'new-boot-state', 'never delete this');
    assert.throws(() => rollbackSeedMigration(tx.transaction, interrupt(phase)), MigrationInterruption);
    assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
    assert.deepEqual(bytes(source), old);
    assert.deepEqual(bytes(tx.backup), old);
    assert.equal(fs.readFileSync(path.join(tx.retainedActive, 'new-boot-state'), 'utf8'), 'never delete this');
  });
}

test('interrupted preparation leaves source unchanged; partial artifacts remain inspectable', t => {
  const { source, options } = fixture(t);
  const before = bytes(source);
  assert.throws(() => prepareSeedMigration({ ...options, ...interrupt('candidate-copied') }), MigrationInterruption);
  const transaction = onlyTransaction(source);
  assert.equal(recoverSeedMigration(transaction, quiet).state, 'prepare-failed');
  assert.deepEqual(bytes(source), before);
  assert.ok(fs.existsSync(path.join(transaction, 'candidate')));
});

test('prepare detects concurrent source edits without undoing them', t => {
  const { source, options } = fixture(t);
  assert.throws(() => prepareSeedMigration({ ...options,
    checkpoint: phase => { if (phase === 'candidate-copied') put(source, 'settings.yaml', 'new edit'); },
  }), /SOURCE_CHANGED/);
  assert.equal(fs.readFileSync(path.join(source, 'settings.yaml'), 'utf8'), 'new edit');
});

test('rollback refuses a tampered backup', t => {
  const { source, options } = fixture(t);
  const tx = prepareSeedMigration(options);
  activateSeedMigration(tx.transaction, quiet);
  put(tx.backup, 'settings.yaml', 'backup was modified');
  const active = bytes(source);
  assert.throws(() => rollbackSeedMigration(tx.transaction, quiet), /BACKUP_CHANGED/);
  assert.deepEqual(bytes(source), active);
});

test('rollback refuses an unrelated replacement active directory', t => {
  const { root, source, options } = fixture(t);
  const tx = prepareSeedMigration(options);
  activateSeedMigration(tx.transaction, quiet);
  fs.renameSync(source, path.join(root, 'moved-active'));
  put(source, 'unrelated-user-content', 'never move unrelated data');
  const before = bytes(source);
  assert.throws(() => rollbackSeedMigration(tx.transaction, quiet), /ACTIVE_REPLACED/);
  assert.deepEqual(bytes(source), before);
});

test('change after activation intent is rejected before moving the original', t => {
  const { source, options } = fixture(t);
  const tx = prepareSeedMigration(options);
  assert.throws(() => activateSeedMigration(tx.transaction, {
    ...quiet, checkpoint: phase => { if (phase === 'activating') put(source, 'settings.yaml', 'concurrent change'); },
  }), /SOURCE_CHANGED/);
  assert.equal(fs.readFileSync(path.join(source, 'settings.yaml'), 'utf8'), 'concurrent change');
  assert.ok(!fs.existsSync(tx.backup));
});

test('candidate change between renames compensates with original restored', t => {
  const { source, options } = fixture(t);
  const old = bytes(source);
  const tx = prepareSeedMigration(options);
  assert.throws(() => activateSeedMigration(tx.transaction, {
    ...quiet, checkpoint: phase => { if (phase === 'source-renamed') put(tx.candidate, 'unexpected', 'retain this'); },
  }), /ACTIVATION_ROLLED_BACK/);
  assert.deepEqual(bytes(source), old);
  assert.equal(fs.readFileSync(path.join(tx.candidate, 'unexpected'), 'utf8'), 'retain this');
});

test('r4-style companion references must exist even when disabled; reviewed companion files are copied unchanged', t => {
  const { source, seed, options } = fixture(t);
  put(source, 'cordis.patch.yml', '- name: dsh-offpeak\n  disabled: true\n');
  assert.throws(() => prepareSeedMigration(options), /UNRESOLVED_REFERENCE/);
  packageAt(seed, 'dsh-offpeak', '0.1.0');
  const tx = prepareSeedMigration({ ...options, reviewedSeedDigest: inspectMigrationSeed(seed).digest });
  assert.deepEqual(fs.readFileSync(path.join(tx.candidate, 'cordis.patch.yml')), fs.readFileSync(path.join(source, 'cordis.patch.yml')));
  assert.deepEqual(bytes(path.join(tx.candidate, 'node_modules/dsh-offpeak')), bytes(path.join(seed, 'node_modules/dsh-offpeak')));
});

test('commit can follow kernel fallback recreation but never bypasses external health verification', t => {
  const { source, options } = fixture(t);
  const tx = prepareSeedMigration(options);
  activateSeedMigration(tx.transaction, quiet);
  // Model desktop shadow cleanup without executing a kernel or modifying real data.
  fs.renameSync(path.join(source, 'node_modules/@deepseek-ai/dsh'),
    path.join(tx.transaction, 'simulated-installation-fallback'));
  assert.throws(() => commitSeedMigration(tx.transaction, { ...quiet, validateBoot: () => false }), /BOOT_NOT_VALIDATED/);
  assert.equal(commitSeedMigration(tx.transaction, { ...quiet, validateBoot: () => true }).state, 'committed');
});

test('interrupted restore copy is retained before retry; journal temp debris is ignored safely', t => {
  const { source, options } = fixture(t);
  const original = bytes(source);
  const tx = prepareSeedMigration(options);
  assert.throws(() => activateSeedMigration(tx.transaction, interrupt('source-renamed')), MigrationInterruption);
  put(tx.transaction, 'restore/partial', 'retained partial copy');
  put(tx.transaction, 'journal-000099.tmp', '{partial journal');
  assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
  assert.deepEqual(bytes(source), original);
  const retained = fs.readdirSync(tx.transaction).find(name => name.startsWith('incomplete-restore-'));
  assert.equal(fs.readFileSync(path.join(tx.transaction, retained, 'partial'), 'utf8'), 'retained partial copy');
});

test('overlap and transaction symlink boundaries refuse mutation', t => {
  const { root, source, options } = fixture(t);
  assert.throws(() => prepareSeedMigration({ ...options, seedProfile: source }), /OVERLAPPING_PATHS/);
  const tx = prepareSeedMigration(options);
  const link = path.join(root, 'linked-transaction');
  fs.symlinkSync(tx.transaction, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => activateSeedMigration(link, quiet), /LINKED_BOUNDARY/);
  assert.equal(read(source).dependencies[legacy], '0.1.0-rc.7');
});

test('prepared and activated candidate passes the unchanged startup gate; transaction sibling does not impersonate old staging', t => {
  const { root, source, options } = fixture(t);
  const gateFile = fileURLToPath(new URL('../sidecar/src/lib/profile-upgrade.ts', import.meta.url));
  const gate = new Module(gateFile);
  gate.filename = gateFile;
  gate.paths = Module._nodeModulePaths(path.dirname(gateFile));
  gate._compile(ts.transpileModule(fs.readFileSync(gateFile, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, gateFile);
  const app = path.join(root, 'app');
  put(app, 'package.json', { version: MIGRATION_TARGET.app });
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', renderer]) {
    packageAt(app, name, MIGRATION_TARGET.kernel);
  }
  assert.throws(() => gate.exports.assertProfileStartup(app, source), /PROFILE_UPGRADE_REQUIRED/);
  const tx = prepareSeedMigration(options);
  assert.doesNotThrow(() => gate.exports.assertProfileStartup(app, tx.candidate));
  activateSeedMigration(tx.transaction, quiet);
  assert.doesNotThrow(() => gate.exports.assertProfileStartup(app, source));
});

test('loss of caller quiescence after first rename stops writes until explicitly recovered', t => {
  const { source, options } = fixture(t);
  const old = bytes(source);
  const tx = prepareSeedMigration(options);
  let held = true;
  assert.throws(() => activateSeedMigration(tx.transaction, {
    assertQuiescent: () => held,
    checkpoint: phase => { if (phase === 'source-renamed') held = false; },
  }), /RECOVERY_REQUIRED/);
  assert.deepEqual(bytes(tx.backup), old);
  assert.equal(recoverSeedMigration(tx.transaction, quiet).state, 'rolled-back');
  assert.deepEqual(bytes(source), old);
});

test('unknown kernel spec and redirected journal fail closed', t => {
  const { source, options } = fixture(t);
  const manifest = read(source);
  manifest.dependencies[legacy] = '9.9.9';
  put(source, 'package.json', manifest);
  assert.throws(() => prepareSeedMigration(options), /UNKNOWN_SOURCE_GRAPH/);
  manifest.dependencies[legacy] = '0.1.0-rc.7';
  put(source, 'package.json', manifest);
  const tx = prepareSeedMigration(options);
  const journals = fs.readdirSync(tx.transaction).filter(name => name.endsWith('.json')).sort();
  const last = journals.at(-1);
  const record = read(tx.transaction, last);
  record.sourceName = '../unrelated';
  put(tx.transaction, last, record);
  const before = bytes(source);
  assert.throws(() => activateSeedMigration(tx.transaction, quiet), /INVALID_JOURNAL/);
  assert.deepEqual(bytes(source), before);
});

test('an unexpected destination created between renames is never overwritten', t => {
  const { source, options } = fixture(t);
  const old = bytes(source);
  const tx = prepareSeedMigration(options);
  assert.throws(() => activateSeedMigration(tx.transaction, {
    ...quiet, checkpoint: phase => {
      if (phase === 'source-renamed') put(source, 'unexpected-user-file', 'retain me');
    },
  }), /RECOVERY_REQUIRED/);
  assert.equal(fs.readFileSync(path.join(source, 'unexpected-user-file'), 'utf8'), 'retain me');
  assert.deepEqual(bytes(tx.backup), old);
  assert.ok(fs.existsSync(tx.candidate));
});

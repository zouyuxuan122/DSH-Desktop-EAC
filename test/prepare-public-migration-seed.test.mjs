import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  plainPath, disjointPaths, treeBinding, isolatedEnvironment, buildPublicMigrationSeed, publicCompanionText,
} from '../scripts/prepare-public-migration-seed.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-sync-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(plainPath(root)), plainPath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('public-sync-fixture-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('tree binding is path-independent and detects every changed byte', t => {
  const root = fixture(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'public.json'), '{"public":true}');
  fs.cpSync(a, b, { recursive: true });
  assert.equal(treeBinding(a).digest, treeBinding(b).digest);
  fs.writeFileSync(path.join(b, 'public.json'), '{"public":false}');
  assert.notEqual(treeBinding(a).digest, treeBinding(b).digest);
});

test('comment cleanup is restricted to reviewed companion files and leaves runtime strings intact', () => {
  const relative = 'profiles/web-desktop/node_modules/dsh-better-sidebar/lib/client.js';
  const text = '// license\n\t//#region \\0dsh-css:C:\\Users\\builder\\src\\style.css\nconst x = "C:\\\\Users\\\\runtime";\n';
  assert.equal(publicCompanionText(relative, text),
    '// license\n\t//#region dsh-css:public-source\nconst x = "C:\\\\Users\\\\runtime";\n');
  assert.equal(publicCompanionText('node_modules/custom/client.js', text), text);
});

test('clean public profile projection preserves only home sessions and provider configuration',
  { skip: !process.env.PUBLIC_MIGRATION_REHEARSAL, timeout: 15 * 60 * 1000 }, () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const work = plainPath(process.env.PUBLIC_MIGRATION_REHEARSAL);
    const seed = plainPath(process.env.PUBLIC_MIGRATION_SEED);
    const runtime = plainPath(process.env.PUBLIC_MIGRATION_RUNTIME);
    disjointPaths(repo, work, seed, runtime);
    assert.ok(!fs.existsSync(work), 'rehearsal requires a NEW synthetic directory');
    assert.equal(process.env.PUBLIC_MIGRATION_MODE, 'clean-profile-r9');
    const require = createRequire(import.meta.url);
    const migration = require(path.join(runtime, 'lib/profile-seed-migration.js'));
    const seedProfile = path.join(seed, 'profiles/web-desktop');
    const inspected = migration.inspectMigrationSeed(seedProfile, true);
    assert.equal(inspected.digest, process.env.PUBLIC_MIGRATION_DIGEST);
    const home = path.join(work, 'home');
    const source = path.join(home, 'profiles/web-desktop');
    fs.mkdirSync(source, { recursive: true });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    const originals = {};
    for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      const bytes = execFileSync('git', ['show', `${head}:distribution/profile-seed/profiles/web-desktop/${name}`],
        { cwd: repo, windowsHide: true });
      fs.writeFileSync(path.join(source, name), bytes, { flag: 'wx' });
      originals[name] = bytes;
    }
    const profileSentinel = Buffer.from('\uFEFF# SYNTHETIC OLD PROFILE DATA\r\nplugin-setting: must-not-migrate\r\n', 'utf8');
    fs.writeFileSync(path.join(source, 'settings.yaml'), profileSentinel, { flag: 'wx' });
    fs.mkdirSync(path.join(source, 'custom-metadata'));
    fs.writeFileSync(path.join(source, 'custom-metadata', 'opaque.bin'), Buffer.from([0, 255, 13, 10, 128]));
    const homeFiles = {
      'settings.yaml': Buffer.from('llm-deepseek:\n  baseURL: https://synthetic.invalid\nagent-default-model:\n  model: synthetic-model\n'),
      '.credentials.yaml': Buffer.from('llm-deepseek:\n  apiKey: SYNTHETIC-NOT-A-REAL-KEY\n'),
      'sessions/session-a/events.jsonl': Buffer.from('{"type":"message","text":"synthetic private session"}\n'),
      'attachments/v1/blob-a': Buffer.from([1, 2, 3, 255]),
    };
    for (const [relative, value] of Object.entries(homeFiles)) {
      const file = path.join(home, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value, { flag: 'wx' });
    }
    const before = treeBinding(source).digest;
    const seedTree = treeBinding(seedProfile).digest;
    const lease = { assertQuiescent: () => true }; // This test exclusively owns its new synthetic tree.
    const tx = migration.prepareSeedMigration({ ...lease, sourceProfile: source,
      seedProfile, reviewedSeedDigest: inspected.digest, inheritProfile: 'none' });
    assert.equal(tx.state, 'prepared');
    assert.equal(treeBinding(source).digest, before, 'prepare must not modify source');
    assert.equal(treeBinding(tx.candidate).digest, seedTree, 'candidate must exactly match reviewed seed');
    assert.ok(!fs.existsSync(path.join(tx.candidate, 'settings.yaml')));
    assert.ok(!fs.existsSync(path.join(tx.candidate, 'custom-metadata')));
    for (const [relative, value] of Object.entries(homeFiles)) {
      assert.deepEqual(fs.readFileSync(path.join(home, relative)), value, relative);
    }
    const projectedInspection = migration.inspectMigrationSeed(tx.candidate, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(tx.candidate, 'package.json'), 'utf8'));
    const old = JSON.parse(originals['package.json']);
    assert.equal(manifest.dependencies['@deepseek-ai/dsh-client-ui-renderer'], '0.1.5-rc.2');
    assert.ok(!Object.hasOwn(manifest.dependencies, '@deepseek-ai/dsh-client-web-react'));
    for (const name of ['@sanqi-normal/dsh-webui-market-plugin',
      '@vlln/dsh-navbar', 'dsh-smooth-stream', 'dsh-usage-skill']) {
      assert.ok(!Object.hasOwn(manifest.dependencies, name));
      assert.ok(!fs.existsSync(path.join(tx.candidate, 'node_modules', name)));
    }
    const webui = path.join(tx.candidate, 'node_modules/@dsh-external/dsh-webui/lib');
    const bridge = fs.readFileSync(path.join(webui, 'usage-host.js'), 'utf8');
    assert.match(bridge, /export\s*\{\s*applyUsageHost\s*\}\s*from\s*['"]\.\/aio-usage-host\/index\.mjs['"]/);
    const usageFiles = ['index.mjs', 'skills-host.mjs', 'PROVENANCE.json', 'LICENSE'];
    for (const name of usageFiles) assert.ok(fs.statSync(path.join(webui, 'aio-usage-host', name)).isFile());
    const legacyImport = /(?:from\s*|import\s*\(|require\s*\()\s*['"]dsh-usage-skill(?:\/|['"])/;
    for (const relative of ['index.js', 'usage-host.js', 'aio-usage-host/index.mjs', 'aio-usage-host/skills-host.mjs']) {
      assert.doesNotMatch(fs.readFileSync(path.join(webui, relative), 'utf8'), legacyImport);
    }
    // A writer breaking the lease must be detected before either rename.
    fs.writeFileSync(path.join(source, 'settings.yaml'), Buffer.concat([profileSentinel, Buffer.from('# changed\n')]));
    assert.throws(() => migration.activateSeedMigration(tx.transaction, lease), { code: 'SOURCE_CHANGED' });
    assert.ok(!fs.existsSync(tx.backup));
    fs.writeFileSync(path.join(source, 'settings.yaml'), profileSentinel);
    const active = migration.activateSeedMigration(tx.transaction, lease);
    assert.equal(active.state, 'pending-health');
    assert.equal(treeBinding(source).digest, seedTree);
    assert.equal(treeBinding(tx.backup).digest, before);
    assert.deepEqual(fs.readFileSync(path.join(tx.backup, 'cordis.patch.yml')), originals['cordis.patch.yml']);
    for (const [relative, value] of Object.entries(homeFiles)) {
      assert.deepEqual(fs.readFileSync(path.join(home, relative)), value, relative);
    }
    const rolled = migration.rollbackSeedMigration(tx.transaction, lease);
    assert.equal(rolled.state, 'rolled-back');
    assert.equal(treeBinding(source).digest, before);
    assert.equal(treeBinding(tx.backup).digest, before);
    assert.ok(fs.existsSync(tx.retainedActive));
    assert.equal(treeBinding(tx.retainedActive).digest, seedTree);
    assert.equal(migration.recoverSeedMigration(tx.transaction, lease).state, 'rolled-back');
    assert.equal(migration.inspectMigrationSeed(seedProfile).digest, inspected.digest);
    for (const [relative, value] of Object.entries(homeFiles)) {
      assert.deepEqual(fs.readFileSync(path.join(home, relative)), value, relative);
    }
    const report = { purpose: 'offline migration rehearsal; not native UI/boot health qualification',
      profileInheritance: 'none',
      head, seed, seedDigest: inspected.digest, transaction: tx.transaction,
      source, backup: tx.backup, retainedActive: tx.retainedActive, originalTreeDigest: before,
      prepareSourceUnchanged: true, candidateExactlyMatchesSeed: true,
      profileSettingsNotInherited: true, homeSessionsAndProvidersByteIdentical: true,
      modifiedSourceRejected: true,
      projectedCandidateDigest: projectedInspection.digest, seedUnchanged: true,
      r9StaticChecks: { retiredCompanionsAbsent: true, webuiOwnedUsageHost: true,
        legacyUsageImportAbsentInEntryFiles: true, executedHosts: false },
      sourceDependencyCount: Object.keys(old.dependencies).length,
      sourceBundleCount: old.dsh.profile.bundles.length,
      targetDependencyCount: Object.keys(manifest.dependencies).length,
      testedModuleSha256: sha(fs.readFileSync(path.join(runtime, 'lib/profile-seed-migration.js'))),
      command: { cwd: repo, executable: process.execPath, args: ['--test', 'test/prepare-public-migration-seed.test.mjs'],
        env: Object.fromEntries(['NODE_PATH', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL',
          'GIT_CONFIG_NOSYSTEM', 'PUBLIC_MIGRATION_REHEARSAL', 'PUBLIC_MIGRATION_SEED',
          'PUBLIC_MIGRATION_RUNTIME', 'PUBLIC_MIGRATION_DIGEST', 'PUBLIC_MIGRATION_MODE']
          .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) },
      activatedState: active.state, rollbackState: rolled.state, backupRetained: true,
      idempotentRecovery: true, healthCommitted: false, serverStarted: false };
    fs.writeFileSync(path.join(work, 'rehearsal.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(report));
  });

test('linked roots and escaping source links are rejected', t => {
  const root = fixture(t);
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => plainPath(link), /linked/);
  assert.throws(() => treeBinding(root), /unsupported/);
});

test('ancestor overlaps are refused while sibling-prefix paths remain distinct', t => {
  const root = fixture(t);
  assert.throws(() => disjointPaths(root, path.join(root, 'child')), /overlapping/);
  assert.throws(() => disjointPaths(root, root), /overlapping/);
  assert.doesNotThrow(() => disjointPaths(path.join(root, 'output'), path.join(root, 'output-old')));
});

test('worker environment cannot inherit credentials, existing profiles, or Node injection flags', t => {
  const work = fixture(t);
  const env = isolatedEnvironment(work);
  assert.equal(env.HOME, work);
  assert.equal(env.USERPROFILE, work);
  assert.equal(env.DSH_HOME, path.join(work, 'home'));
  for (const name of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    assert.ok(!Object.hasOwn(env, name));
  }
});

test('build refuses existing targets or an unbound public seed before any mutations', t => {
  const root = fixture(t);
  const base = path.join(root, 'aio-1.2.0-public-seed-20260908-r4');
  const output = path.join(root, 'output');
  const work = path.join(root, 'work');
  fs.mkdirSync(base);
  assert.throws(() => buildPublicMigrationSeed({ base, output, work }), /digest required/);
  assert.ok(!fs.existsSync(work));
  fs.mkdirSync(output);
  assert.throws(() => buildPublicMigrationSeed({ base, output, work, expectedBaseDigest: 'a'.repeat(64) }), /NEW/);
  assert.ok(!fs.existsSync(work));
});

test('r8 requires its explicit content binding and future bases are not implicitly approved', t => {
  const root = fixture(t);
  const output = path.join(root, 'output');
  const work = path.join(root, 'work');
  const base = path.join(root, 'aio-1.2.0-public-seed-20260908-r8');
  fs.mkdirSync(base);
  assert.throws(() => buildPublicMigrationSeed({ base, output, work, expectedBaseDigest: '0'.repeat(64) }),
    /reviewed base digest mismatch/);
  assert.ok(!fs.existsSync(output));
  assert.ok(!fs.existsSync(work));
  assert.throws(() => buildPublicMigrationSeed({ base: path.join(root, 'aio-1.2.0-public-seed-20260908-r9'),
    output, work, expectedBaseDigest: '0'.repeat(64) }), /only the named reviewed/);
});

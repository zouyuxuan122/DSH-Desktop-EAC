import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(desktopRoot, '..');
const script = join(desktopRoot, 'scripts', 'plugin-sync.mjs');
const registryScript = join(desktopRoot, 'scripts', 'generate-plugin-registry.mjs');
const manifestPath = join(repoRoot, '.sync', 'plugins.json');
const schemaPath = join(repoRoot, '.sync', 'plugins.schema.json');
const policiesPath = join(repoRoot, '.sync', 'policies.json');

const sync = await import(pathToFileURL(script).href);

function run(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function runRegistryGenerator(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [registryScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-test-'));
  const pluginRoot = join(root, 'dsh-desktop', 'assets', 'plugins', 'demo-plugin');
  mkdirSync(join(pluginRoot, 'lib'), { recursive: true });
  mkdirSync(join(root, 'dsh-desktop', 'assets', 'skins'), { recursive: true });
  mkdirSync(join(root, 'dsh-desktop', 'assets', 'sdk-plugins'), { recursive: true });
  mkdirSync(join(root, 'dsh-desktop', 'lib', 'desktop'), { recursive: true });
  mkdirSync(join(root, '.sync'), { recursive: true });
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.2.3',
    license: 'MIT',
    main: 'lib/index.js',
  }, null, 2) + '\n');
  writeFileSync(join(pluginRoot, 'lib', 'index.js'), 'export default {};\n');
  writeFileSync(join(root, 'dsh-desktop', 'lib', 'desktop', 'companion-sync.ts'), [
    "export const COMPANION_PLUGINS = [{ id: 'demo', name: 'demo-plugin', dir: 'demo-plugin' }];",
    'export const PLUGIN_UPDATE_SOURCES = {};',
  ].join('\n'));
  copyFileSync(schemaPath, join(root, '.sync', 'plugins.schema.json'));
  copyFileSync(policiesPath, join(root, '.sync', 'policies.json'));
  const manifest = {
    schemaVersion: 1,
    generatedRegistry: 'dsh-desktop/lib/desktop/plugin-sync-registry.ts',
    plugins: [{
      id: 'demo',
      kind: 'plugin',
      path: 'dsh-desktop/assets/plugins/demo-plugin',
      packageName: 'demo-plugin',
      class: 'follow-upstream',
      source: { kind: 'npm', name: 'demo-plugin' },
      request: { mode: 'latest', range: '*', releaseAgeHours: 24 },
      sync: { mode: 'mirror', patches: [], preservePaths: [] },
      runtimeUpdate: { allowed: false, defaultAction: 'prompt' },
      validation: { entrypoints: ['lib/index.js'], commands: [] },
      license: { expected: 'MIT', reviewOnChange: true },
      owner: 'desktop-plugins',
    }],
    skins: [],
    sdkPlugins: [],
  };
  const policies = JSON.parse(readFileSync(join(root, '.sync', 'policies.json'), 'utf8'));
  policies.runtimeUpdates.legacySourceCount = 0;
  writeFileSync(join(root, '.sync', 'policies.json'), JSON.stringify(policies, null, 2) + '\n');
  writeFileSync(join(root, '.sync', 'plugins.json'), JSON.stringify(manifest, null, 2) + '\n');
  const generated = runRegistryGenerator(['--root', root]);
  if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout);
  return { root, pluginRoot, manifest, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('validate-manifest accepts the checked-in inventory without network access', () => {
  const result = run(['validate-manifest']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /manifest valid/);
  assert.match(result.stdout, /plugins=48/);
  assert.match(result.stdout, /skins=10/);
  assert.match(result.stdout, /sdkPlugins=1/);
});

test('validate-manifest rejects package, entrypoint, source, and class drift', () => {
  const t = fixture();
  try {
    const packageFile = join(t.pluginRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
    packageJson.name = 'wrong-name';
    writeFileSync(packageFile, JSON.stringify(packageJson));
    const result = run(['validate-manifest', '--root', t.root], repoRoot);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packageName|wrong-name/);

    packageJson.name = 'demo-plugin';
    writeFileSync(packageFile, JSON.stringify(packageJson));
    packageJson.license = 'Apache-2.0';
    writeFileSync(packageFile, JSON.stringify(packageJson));
    const licenseDrift = run(['validate-manifest', '--root', t.root]);
    assert.equal(licenseDrift.status, 1);
    assert.match(licenseDrift.stderr, /license|Apache-2\.0/);

    packageJson.license = 'MIT';
    writeFileSync(packageFile, JSON.stringify(packageJson));
    rmSync(join(t.pluginRoot, 'lib', 'index.js'));
    const missingEntry = run(['validate-manifest', '--root', t.root]);
    assert.equal(missingEntry.status, 1);
    assert.match(missingEntry.stderr, /entrypoint|lib\/index\.js/);

    writeFileSync(join(t.pluginRoot, 'lib', 'index.js'), 'export default {};\n');
    const patchFile = join(t.root, 'patches', 'demo.patch');
    mkdirSync(dirname(patchFile), { recursive: true });
    writeFileSync(patchFile, 'first\n');
    const firstPatch = sync.patchSetSha256(t.root, ['patches/demo.patch']);
    writeFileSync(patchFile, 'second\n');
    assert.notEqual(sync.patchSetSha256(t.root, ['patches/demo.patch']), firstPatch);
    const manifest = JSON.parse(readFileSync(join(t.root, '.sync', 'plugins.json'), 'utf8'));
    manifest.plugins[0].source = {
      kind: 'unknown',
      reason: 'fixture source is intentionally unknown',
      repository: 'https://example.invalid/must-not-be-guessed',
    };
    writeFileSync(join(t.root, '.sync', 'plugins.json'), JSON.stringify(manifest));
    const sourceDrift = run(['validate-manifest', '--root', t.root]);
    assert.equal(sourceDrift.status, 1);
    assert.match(sourceDrift.stderr, /unknown source|repository/);

    manifest.plugins[0].source = { kind: 'npm', name: 'demo-plugin' };
    manifest.plugins[0].class = 'not-a-class';
    writeFileSync(join(t.root, '.sync', 'plugins.json'), JSON.stringify(manifest));
    const classDrift = run(['validate-manifest', '--root', t.root]);
    assert.equal(classDrift.status, 1);
    assert.match(classDrift.stderr, /class|enum|not-a-class/);
  } finally {
    t.cleanup();
  }
});

test('tree and patch-set digests are byte-stable and change when bytes change', () => {
  const t = fixture();
  try {
    const first = sync.treeSha256(t.pluginRoot);
    const second = sync.treeSha256(t.pluginRoot);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
    writeFileSync(join(t.pluginRoot, 'lib', 'index.js'), 'export default { changed: true };\n');
    assert.notEqual(sync.treeSha256(t.pluginRoot), first);
    assert.equal(sync.patchSetSha256(t.root, []), sync.patchSetSha256(t.root, []));
    assert.match(sync.patchSetSha256(t.root, []), /^[0-9a-f]{64}$/);
  } finally {
    t.cleanup();
  }
});

test('tree snapshots exclude forbidden dependency directories without hashing their bytes', () => {
  const t = fixture();
  try {
    const forbidden = join(t.pluginRoot, 'node_modules', 'secret.txt');
    mkdirSync(join(t.pluginRoot, 'node_modules'), { recursive: true });
    writeFileSync(forbidden, 'first\n');
    const first = sync.treeSnapshot(t.pluginRoot);
    writeFileSync(forbidden, 'second\n');
    const second = sync.treeSnapshot(t.pluginRoot);
    assert.deepEqual(first.excludedPaths, ['node_modules']);
    assert.deepEqual(second.excludedPaths, ['node_modules']);
    assert.equal(second.treeSha256, first.treeSha256);
    assert.equal(first.files.some((file: string) => file.includes('node_modules')), false);
  } finally {
    t.cleanup();
  }
});

test('generate-registry is deterministic and --check detects generated drift', () => {
  const first = run(['generate-registry']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const registry = join(repoRoot, 'dsh-desktop', 'lib', 'desktop', 'plugin-sync-registry.ts');
  assert.ok(existsSync(registry));
  const bytes = readFileSync(registry);
  const second = run(['generate-registry']);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.deepEqual(readFileSync(registry), bytes);
  writeFileSync(registry, Buffer.concat([bytes, Buffer.from('// drift\n')]));
  try {
    const check = run(['generate-registry', '--check']);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /drift|generated registry/);
  } finally {
    run(['generate-registry']);
  }
});

test('standalone registry generator checks the checked-in generated file', () => {
  const registry = join(repoRoot, 'dsh-desktop', 'lib', 'desktop', 'plugin-sync-registry.ts');
  const result = runRegistryGenerator(['--check']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /generated registry valid/);
  assert.match(readFileSync(registry, 'utf8'), /run generate-plugin-registry\.mjs/);
});

test('standalone registry generator can create a missing registry from manifest sources', () => {
  const t = fixture();
  try {
    const manifestPath = join(t.root, '.sync', 'plugins.json');
    const policiesPath = join(t.root, '.sync', 'policies.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.plugins[0].runtimeUpdate = {
      allowed: true,
      defaultAction: 'prompt',
      source: { kind: 'npm', name: 'demo-plugin' },
    };
    const policies = JSON.parse(readFileSync(policiesPath, 'utf8'));
    policies.runtimeUpdates.legacySourceCount = 1;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(policiesPath, JSON.stringify(policies, null, 2) + '\n');

    const result = runRegistryGenerator(['--root', t.root]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const registry = join(t.root, 'dsh-desktop', 'lib', 'desktop', 'plugin-sync-registry.ts');
    assert.ok(existsSync(registry));
    assert.equal(runRegistryGenerator(['--root', t.root, '--check']).status, 0);
  } finally {
    t.cleanup();
  }
});

test('validate-manifest requires the generated registry instead of a legacy companion source table', () => {
  const t = fixture();
  try {
    const registry = join(t.root, 'dsh-desktop', 'lib', 'desktop', 'plugin-sync-registry.ts');
    rmSync(registry, { force: true });
    const result = run(['validate-manifest', '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /runtime source registry is missing/);
  } finally {
    t.cleanup();
  }
});

test('validate-manifest rejects a generated registry without its source marker', () => {
  const t = fixture();
  try {
    const registry = join(t.root, 'dsh-desktop', 'lib', 'desktop', 'plugin-sync-registry.ts');
    writeFileSync(registry, 'export const PLUGIN_UPDATE_SOURCES = {};\n');
    const result = run(['validate-manifest', '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /runtime source registry is missing/);
  } finally {
    t.cleanup();
  }
});

test('generate-lock and validate --locked enforce completeness and digests', () => {
  const generated = run(['generate-lock']);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const lockPath = join(repoRoot, '.sync', 'plugins.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(Object.keys(lock.plugins).length, 59);
  assert.equal(run(['validate', '--locked']).status, 0);

  const original = readFileSync(lockPath);
  const missing = JSON.parse(original);
  delete missing.plugins['dsh-pet'];
  writeFileSync(lockPath, JSON.stringify(missing, null, 2) + '\n');
  try {
    const incomplete = run(['validate', '--locked']);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /lock|dsh-pet|completeness/);
  } finally {
    writeFileSync(lockPath, original);
  }

  const changed = JSON.parse(original);
  changed.plugins['dsh-pet'].local.treeSha256 = '0'.repeat(64);
  writeFileSync(lockPath, JSON.stringify(changed, null, 2) + '\n');
  try {
    const digest = run(['validate', '--locked']);
    assert.equal(digest.status, 1);
    assert.match(digest.stderr, /tree|digest|dsh-pet/);
  } finally {
    writeFileSync(lockPath, original);
  }
});

test('validate --locked rejects source identity and source commit drift', () => {
  const lockPath = join(repoRoot, '.sync', 'plugins.lock.json');
  const original = readFileSync(lockPath);
  const mutations = [
    {
      mutate: (lock: any) => { lock.plugins['dsh-pet'].source.name = 'wrong-package'; },
      message: /source.*name|source identity/i,
    },
    {
      mutate: (lock: any) => { lock.plugins['dsh-pet'].source.repository = 'https://example.invalid/wrong'; },
      message: /source.*repository|source identity/i,
    },
    {
      mutate: (lock: any) => { lock.plugins['dsh-pet'].sourceCommit = 'unexpected-commit'; },
      message: /sourceCommit|source commit/i,
    },
  ];
  try {
    for (const { mutate, message } of mutations) {
      const changed = JSON.parse(original);
      mutate(changed);
      writeFileSync(lockPath, JSON.stringify(changed, null, 2) + '\n');
      const result = run(['validate', '--locked']);
      assert.equal(result.status, 1, result.stdout || result.stderr);
      assert.match(result.stderr, message);
    }
  } finally {
    writeFileSync(lockPath, original);
  }
});

test('validate --locked reports a non-object lock instead of throwing a TypeError', () => {
  const lockPath = join(repoRoot, '.sync', 'plugins.lock.json');
  const original = readFileSync(lockPath);
  writeFileSync(lockPath, 'null\n');
  try {
    const result = run(['validate', '--locked']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lock: expected an object/);
    assert.doesNotMatch(result.stderr, /TypeError/);
  } finally {
    writeFileSync(lockPath, original);
  }
});

test('validate --locked rejects a null lock entry', () => {
  const lockPath = join(repoRoot, '.sync', 'plugins.lock.json');
  const original = readFileSync(lockPath);
  const changed = JSON.parse(original);
  changed.plugins['dsh-pet'] = null;
  writeFileSync(lockPath, JSON.stringify(changed, null, 2) + '\n');
  try {
    const result = run(['validate', '--locked']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lock dsh-pet: expected an object/);
  } finally {
    writeFileSync(lockPath, original);
  }
});

test('atomic lock writes keep the previous file when writing is interrupted', () => {
  const t = fixture();
  try {
    const target = join(t.root, '.sync', 'plugins.lock.json');
    sync.writeJsonAtomic(target, { version: 1 });
    assert.throws(
      () => sync.writeJsonAtomic(target, { version: 2 }, { beforeRename: () => { throw new Error('interrupted'); } }),
      /interrupted/,
    );
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { version: 1 });
  } finally {
    t.cleanup();
  }
});

test('sync --dry-run resolves a local fixture and never writes or accesses the network', () => {
  const before = readFileSync(manifestPath);
  const result = run(['sync', '--plugin', 'dsh-pet', '--mode', 'latest', '--dry-run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.networkAccessed, false);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].id, 'dsh-pet');
  assert.deepEqual(readFileSync(manifestPath), before);
});

test('sync --dry-run treats an explicit version as an exact candidate', () => {
  const result = run(['sync', '--plugin', 'dsh-pet', '--version', '0.1.3', '--dry-run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].mode, 'exact');
  assert.equal(report.candidates[0].requested, '0.1.3');
  assert.equal(report.candidates[0].wouldWrite, false);
});

test('sync --dry-run rejects exact mode without an exact version or commit', () => {
  const result = run(['sync', '--plugin', 'dsh-pet', '--mode', 'exact', '--dry-run']);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.match(result.stderr, /exact.*version|commit/i);
});

test('sync --dry-run gives --version precedence over a latest mode flag', () => {
  const result = run(['sync', '--plugin', 'dsh-pet', '--mode', 'latest', '--version', '0.1.3', '--dry-run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.candidates[0].mode, 'exact');
  assert.equal(report.candidates[0].requested, '0.1.3');
});

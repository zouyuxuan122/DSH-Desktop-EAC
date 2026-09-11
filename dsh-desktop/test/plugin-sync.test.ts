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
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import test from 'node:test';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(desktopRoot, '..');
const script = join(desktopRoot, 'scripts', 'plugin-sync.mjs');
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

function fixture(location = tmpdir()) {
  const root = mkdtempSync(join(location, 'dsh-plugin-sync-test-'));
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
  return { root, pluginRoot, manifest, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function sourceFixture(t: ReturnType<typeof fixture>, options: {
  name?: string;
  version?: string;
  license?: string;
  repository?: string;
  entrypoint?: boolean;
  lifecycle?: boolean;
  lifecycleScript?: string;
} = {}) {
  const sourceRoot = join(t.root, 'source-package');
  mkdirSync(join(sourceRoot, 'lib'), { recursive: true });
  const packageJson: Record<string, unknown> = {
    name: options.name || 'demo-plugin',
    version: options.version || '1.2.4',
    license: options.license || 'MIT',
    main: 'lib/index.js',
    repository: options.repository || 'https://github.com/example/demo-plugin',
  };
  if (options.lifecycle) packageJson.scripts = { postinstall: 'touch should-not-run' };
  if (options.lifecycleScript) packageJson.scripts = { [options.lifecycleScript]: 'touch should-not-run' };
  writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
  if (options.entrypoint !== false) {
    writeFileSync(join(sourceRoot, 'lib', 'index.js'), 'export default { source: true };\n');
  }
  return sourceRoot;
}

function configureEntry(t: ReturnType<typeof fixture>, changes: (entry: any) => void) {
  const manifestPath = join(t.root, '.sync', 'plugins.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  changes(manifest.plugins[0]);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function writePatch(t: ReturnType<typeof fixture>, body: string) {
  const patchPath = join(t.root, '.sync', 'patches', 'demo', 'change.patch');
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, body);
  configureEntry(t, (entry) => {
    entry.class = 'patched';
    entry.sync.mode = 'patch-rebase';
    entry.sync.patches = ['.sync/patches/demo/change.patch'];
  });
  return patchPath;
}

function tarArchive(files: Array<[string, Buffer]>) {
  const chunks: Buffer[] = [];
  for (const [name, content] of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header[156] = 0x30;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

test('validate-manifest accepts the checked-in inventory without network access', () => {
  const result = run(['validate-manifest']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /manifest valid/);
  assert.match(result.stdout, /plugins=47/);
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

test('generate-lock and validate --locked enforce completeness and digests', () => {
  const generated = run(['generate-lock']);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const lockPath = join(repoRoot, '.sync', 'plugins.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(Object.keys(lock.plugins).length, 58);
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

test('mirror dry-run validates a local source and reports a reviewable diff without writing', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    const before = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run([
      'sync', '--plugin', 'demo', '--source-dir', source, '--dry-run', '--root', t.root,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.networkAccessed, false);
    assert.equal(report.candidates[0].syncMode, 'mirror');
    assert.equal(report.candidates[0].wouldWrite, true);
    assert.equal(report.candidates[0].resolvedVersion, '1.2.4');
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), before);
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

test('sync reports an unchanged exact source without rewriting the tree or lock', () => {
  const t = fixture();
  try {
    configureEntry(t, (entry) => { entry.request = { mode: 'exact', version: '1.2.3' }; });
    assert.equal(run(['generate-registry', '--root', t.root]).status, 0);
    assert.equal(run(['generate-lock', '--root', t.root]).status, 0);
    assert.equal(run(['validate', '--locked', '--root', t.root]).status, 0);
    const manifestBefore = readFileSync(join(t.root, '.sync', 'plugins.json'));
    const lockBefore = readFileSync(join(t.root, '.sync', 'plugins.lock.json'));
    const treeBefore = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run(['sync', '--plugin', 'demo', '--source-dir', t.pluginRoot, '--root', t.root]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.candidates[0].action, 'no-change', result.stdout);
    assert.equal(report.candidates[0].wouldWrite, false);
    assert.deepEqual(readFileSync(join(t.root, '.sync', 'plugins.json')), manifestBefore);
    assert.deepEqual(readFileSync(join(t.root, '.sync', 'plugins.lock.json')), lockBefore);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), treeBefore);
  } finally {
    t.cleanup();
  }
});

test('mirror rejects unpreserved local files and preserves the target tree', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    const localOnly = join(t.pluginRoot, 'local-only.txt');
    writeFileSync(localOnly, 'must-not-disappear\n');
    const before = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /preservePaths|local-only\.txt|extra/i);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), before);
    assert.equal(readFileSync(localOnly, 'utf8'), 'must-not-disappear\n');
  } finally {
    t.cleanup();
  }
});

test('mirror rejects traversal-shaped preserve paths instead of treating them as the plugin root', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    configureEntry(t, (entry) => { entry.sync.preservePaths = ['local/..']; });
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--dry-run', '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /preservePaths|unsafe|\.\./i);
  } finally {
    t.cleanup();
  }
});

test('mirror allows explicitly preserved paths and updates the exact manifest/lock atomically', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    const localOnly = join(t.pluginRoot, 'local-only.txt');
    writeFileSync(localOnly, 'keep me\n');
    configureEntry(t, (entry) => { entry.sync.preservePaths = ['local-only.txt']; });
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(localOnly, 'utf8'), 'keep me\n');
    assert.equal(JSON.parse(readFileSync(join(t.pluginRoot, 'package.json'), 'utf8')).version, '1.2.4');
    const manifest = JSON.parse(readFileSync(join(t.root, '.sync', 'plugins.json'), 'utf8'));
    assert.deepEqual(manifest.plugins[0].request, { mode: 'exact', version: '1.2.4' });
    assert.equal(JSON.parse(readFileSync(join(t.root, '.sync', 'plugins.lock.json'), 'utf8')).plugins.demo.local.packageVersion, '1.2.4');
    assert.equal(run(['validate', '--locked', '--root', t.root]).status, 0);
  } finally {
    t.cleanup();
  }
});

test('mirror refuses forbidden paths already present in the destination tree', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    const forbidden = join(t.pluginRoot, 'node_modules', 'local-only.txt');
    mkdirSync(dirname(forbidden), { recursive: true });
    writeFileSync(forbidden, 'must-not-be-removed\n');
    const before = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /node_modules|forbidden/i);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), before);
    assert.equal(readFileSync(forbidden, 'utf8'), 'must-not-be-removed\n');
  } finally {
    t.cleanup();
  }
});

test('mirror extracts an archive, verifies integrity, and records the artifact digest', () => {
  const t = fixture();
  try {
    configureEntry(t, (entry) => {
      entry.source.repository = 'https://github.com/example/demo-plugin';
    });
    const archive = tarArchive([
      ['package/package.json', Buffer.from(JSON.stringify({
        name: 'demo-plugin',
        version: '1.2.4',
        license: 'MIT',
        main: 'lib/index.js',
        repository: 'https://github.com/example/demo-plugin',
      }, null, 2) + '\n')],
      ['package/lib/index.js', Buffer.from('export default { archived: true };\n')],
    ]);
    const archivePath = join(t.root, 'demo-plugin-1.2.4.tgz');
    writeFileSync(archivePath, archive);
    const integrity = `sha256-${createHash('sha256').update(archive).digest('base64')}`;
    const result = run([
      'sync', '--plugin', 'demo', '--archive', archivePath, '--sha256', sync.sha256Bytes(archive),
      '--integrity', integrity, '--root', t.root,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(join(t.pluginRoot, 'lib', 'index.js'), 'utf8'), 'export default { archived: true };\n');
    const lock = JSON.parse(readFileSync(join(t.root, '.sync', 'plugins.lock.json'), 'utf8'));
    assert.equal(lock.plugins.demo.source.archiveSha256, sync.sha256Bytes(archive));
    assert.equal(lock.plugins.demo.source.integrity, integrity);
    assert.equal(lock.plugins.demo.source.version, '1.2.4');
    assert.equal(run(['validate', '--locked', '--root', t.root]).status, 0);
  } finally {
    t.cleanup();
  }
});

test('source-url file fixtures do not claim network access or persist a local path in the lock', () => {
  const t = fixture();
  try {
    const archive = tarArchive([
      ['package/package.json', Buffer.from(JSON.stringify({
        name: 'demo-plugin', version: '1.2.4', license: 'MIT', main: 'lib/index.js',
        repository: 'https://github.com/example/demo-plugin',
      }) + '\n')],
      ['package/lib/index.js', Buffer.from('export default { localUrl: true };\n')],
    ]);
    const archivePath = join(t.root, 'demo-plugin-local-url.tgz');
    writeFileSync(archivePath, archive);
    const result = run([
      'sync', '--plugin', 'demo', '--source-url', pathToFileURL(archivePath).href, '--root', t.root,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.networkAccessed, false);
    const lock = JSON.parse(readFileSync(join(t.root, '.sync', 'plugins.lock.json'), 'utf8'));
    assert.equal(lock.plugins.demo.source.tarball, undefined);
    assert.equal(JSON.stringify(lock).includes(archivePath), false);
  } finally {
    t.cleanup();
  }
});

test('mirror rejects an archive integrity mismatch without changing the tree or lock', () => {
  const t = fixture();
  try {
    const archive = tarArchive([
      ['package/package.json', Buffer.from(JSON.stringify({
        name: 'demo-plugin', version: '1.2.4', license: 'MIT', main: 'lib/index.js',
        repository: 'https://github.com/example/demo-plugin',
      }) + '\n')],
      ['package/lib/index.js', Buffer.from('export default {};\n')],
    ]);
    const archivePath = join(t.root, 'demo-plugin-invalid.tgz');
    writeFileSync(archivePath, archive);
    const before = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run([
      'sync', '--plugin', 'demo', '--archive', archivePath, '--sha256', '0'.repeat(64), '--root', t.root,
    ]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /archive.*SHA-256|integrity/i);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), before);
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

test('exact commit sync preserves the immutable source commit in manifest and lock', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    const commit = '0123456789abcdef0123456789abcdef01234567';
    configureEntry(t, (entry) => {
      entry.request = { mode: 'exact', commit };
    });
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--commit', commit, '--root', t.root]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(readFileSync(join(t.root, '.sync', 'plugins.json'), 'utf8'));
    assert.deepEqual(manifest.plugins[0].request, { mode: 'exact', version: '1.2.4', commit });
    const lock = JSON.parse(readFileSync(join(t.root, '.sync', 'plugins.lock.json'), 'utf8'));
    assert.equal(lock.plugins.demo.source.commit, commit);
    assert.equal(lock.plugins.demo.sourceCommit, commit);
    assert.equal(run(['validate', '--locked', '--root', t.root]).status, 0);
  } finally {
    t.cleanup();
  }
});

test('patch-rebase applies an explicit patch-set and records the final exact lock', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    writePatch(t, [
      'diff --git a/lib/index.js b/lib/index.js',
      '--- a/lib/index.js',
      '+++ b/lib/index.js',
      '@@ -1 +1 @@',
      '-export default { source: true };',
      '+export default { patched: true };',
      '',
    ].join('\n'));
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(join(t.pluginRoot, 'lib', 'index.js'), 'utf8'), 'export default { patched: true };\n');
    const lock = JSON.parse(readFileSync(join(t.root, '.sync', 'plugins.lock.json'), 'utf8'));
    assert.deepEqual(lock.plugins.demo.patchFiles, ['.sync/patches/demo/change.patch']);
    assert.match(lock.plugins.demo.patchSet, /^sha256:[0-9a-f]{64}$/);
  } finally {
    t.cleanup();
  }
});

test('patch-rebase rejects package entrypoint changes outside the patch-set', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    const sourcePackagePath = join(source, 'package.json');
    const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'));
    sourcePackage.main = 'lib/other.js';
    writeFileSync(sourcePackagePath, JSON.stringify(sourcePackage, null, 2) + '\n');
    writeFileSync(join(source, 'lib', 'other.js'), 'export default { other: true };\n');
    writePatch(t, [
      'diff --git a/lib/index.js b/lib/index.js',
      '--- a/lib/index.js',
      '+++ b/lib/index.js',
      '@@ -1 +1 @@',
      '-export default { source: true };',
      '+export default { patched: true };',
      '',
    ].join('\n'));
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /entrypoint/i);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), Buffer.from('export default {};\n'));
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

test('patch-rebase rejects a conflicting patch-set without changing the tree or lock', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    writePatch(t, [
      'diff --git a/lib/index.js b/lib/index.js',
      '--- a/lib/index.js',
      '+++ b/lib/index.js',
      '@@ -1 +1 @@',
      '-export default { not_the_upstream_source: true };',
      '+export default { patched: true };',
      '',
    ].join('\n'));
    const before = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /conflict|patch/i);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), before);
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

test('patch-rebase rejects dsh wiring changes outside the patch-set', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    const sourcePackagePath = join(source, 'package.json');
    const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'));
    sourcePackage.dsh = { client: { inject: ['changed-wiring'] } };
    writeFileSync(sourcePackagePath, JSON.stringify(sourcePackage, null, 2) + '\n');
    const currentPackagePath = join(t.pluginRoot, 'package.json');
    const currentPackage = JSON.parse(readFileSync(currentPackagePath, 'utf8'));
    currentPackage.dsh = { client: { inject: ['original-wiring'] } };
    writeFileSync(currentPackagePath, JSON.stringify(currentPackage, null, 2) + '\n');
    configureEntry(t, (entry) => {
      entry.class = 'patched';
      entry.sync.mode = 'patch-rebase';
    });
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /dsh wiring/i);
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

test('patch-rebase rejects upstream changes when no explicit patch-set describes the local delta', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    configureEntry(t, (entry) => {
      entry.class = 'patched';
      entry.sync.mode = 'patch-rebase';
    });
    const before = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /patch-set|patch.*required|explicit patch/i);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), before);
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

test('patch-rebase rejects a patch-set that introduces node_modules', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    writePatch(t, [
      'diff --git a/node_modules/blocked/index.js b/node_modules/blocked/index.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/node_modules/blocked/index.js',
      '@@ -0,0 +1 @@',
      '+blocked',
      '',
    ].join('\n'));
    const before = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /node_modules|forbidden/i);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), before);
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

test('patch-rebase only accepts patch files from the plugin-specific patch-set directory', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    const patchPath = join(t.root, '.sync', 'patches', 'other-plugin', 'change.patch');
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, [
      'diff --git a/lib/index.js b/lib/index.js',
      '--- a/lib/index.js',
      '+++ b/lib/index.js',
      '@@ -1 +1 @@',
      '-export default { source: true };',
      '+export default { patched: true };',
      '',
    ].join('\n'));
    configureEntry(t, (entry) => {
      entry.class = 'patched';
      entry.sync.mode = 'patch-rebase';
      entry.sync.patches = ['.sync/patches/other-plugin/change.patch'];
    });
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /patches.*under|patch.*directory|patch.*path|plugin-specific|unsafe/i);
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

test('manual and internal entries only emit reports and never download or overwrite', () => {
  for (const mode of ['manual', 'internal']) {
    const t = fixture();
    try {
      configureEntry(t, (entry) => {
        entry.class = mode;
        entry.source = mode === 'internal'
          ? { kind: 'internal', name: 'demo-plugin', reason: 'fixture-owned' }
          : { kind: 'unknown', reason: 'fixture requires human review' };
        entry.request = { mode: 'exact', version: '1.2.3' };
        entry.sync.mode = 'manual';
      });
      const before = readFileSync(join(t.pluginRoot, 'package.json'));
      const result = run(['sync', '--plugin', 'demo', '--root', t.root]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.networkAccessed, false);
      assert.equal(report.candidates[0].action, 'manual-review');
      assert.equal(report.candidates[0].wouldWrite, false);
      assert.deepEqual(readFileSync(join(t.pluginRoot, 'package.json')), before);
      assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
    } finally {
      t.cleanup();
    }
  }
});

test('sync source validation rejects owner/name, license, lifecycle, and node_modules drift', () => {
  const cases = [
    { options: { name: 'wrong-name' }, message: /owner|name|package/i },
    { options: { license: 'Apache-2.0' }, message: /license/i },
    { options: { lifecycle: true }, message: /lifecycle|install/i },
    { options: { lifecycleScript: 'prepack' }, message: /lifecycle|prepack/i },
  ];
  for (const item of cases) {
    const t = fixture();
    try {
      const source = sourceFixture(t, item.options);
      const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--dry-run', '--root', t.root]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, item.message);
    } finally {
      t.cleanup();
    }
  }
  const sourceIdentity = fixture();
  try {
    const source = sourceFixture(sourceIdentity, { repository: 'https://github.com/other-owner/demo-plugin' });
    configureEntry(sourceIdentity, (entry) => {
      entry.source.repository = 'https://github.com/example-owner/demo-plugin';
    });
    const result = run([
      'sync', '--plugin', 'demo', '--source-dir', source, '--dry-run', '--root', sourceIdentity.root,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /owner\/name|source.*match/i);
  } finally {
    sourceIdentity.cleanup();
  }
  const missingEntrypoint = fixture();
  try {
    const source = sourceFixture(missingEntrypoint, { entrypoint: false });
    const result = run([
      'sync', '--plugin', 'demo', '--source-dir', source, '--dry-run', '--root', missingEntrypoint.root,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /entrypoint.*missing|entrypoint/i);
  } finally {
    missingEntrypoint.cleanup();
  }
  const missingPackageMain = fixture();
  try {
    const source = sourceFixture(missingPackageMain);
    const sourcePackagePath = join(source, 'package.json');
    const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'));
    sourcePackage.main = 'lib/missing.js';
    writeFileSync(sourcePackagePath, JSON.stringify(sourcePackage, null, 2) + '\n');
    const result = run([
      'sync', '--plugin', 'demo', '--source-dir', source, '--dry-run', '--root', missingPackageMain.root,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /entrypoint.*missing|entrypoint/i);
  } finally {
    missingPackageMain.cleanup();
  }
  const t = fixture();
  try {
    const source = sourceFixture(t);
    mkdirSync(join(source, 'node_modules', 'bad'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'bad', 'package.json'), '{}\n');
    const result = run(['sync', '--plugin', 'demo', '--source-dir', source, '--dry-run', '--root', t.root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /node_modules|forbidden/i);
  } finally {
    t.cleanup();
  }
});

test('sync source validation rejects npm source name drift', () => {
  const t = fixture();
  try {
    const source = sourceFixture(t);
    configureEntry(t, (entry) => { entry.source.name = 'other-package'; });
    const result = run([
      'sync', '--plugin', 'demo', '--source-dir', source, '--dry-run', '--root', t.root,
    ]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /source.*name|package.*name/i);
  } finally {
    t.cleanup();
  }
});

test('sync reports source download failures without changing the tree or lock', () => {
  const t = fixture();
  try {
    const missingArchive = pathToFileURL(join(t.root, 'does-not-exist.tgz')).href;
    const before = readFileSync(join(t.pluginRoot, 'lib', 'index.js'));
    const result = run(['sync', '--plugin', 'demo', '--source-url', missingArchive, '--root', t.root]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /source download failed|ENOENT/i);
    assert.deepEqual(readFileSync(join(t.pluginRoot, 'lib', 'index.js')), before);
    assert.equal(existsSync(join(t.root, '.sync', 'plugins.lock.json')), false);
  } finally {
    t.cleanup();
  }
});

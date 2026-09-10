import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import * as settingsApi from '@deepseek-ai/dsh-settings';
import {
  createMigrationStaging, transformPluginInterfaces, reviewedPackages, officialVersion, reviewedSourceVersion,
} from '../scripts/migrate-plugin-interfaces.mjs';

// Only explicitly reviewed public build inputs, never a live profile/install.
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const archives = process.env.DSH_REVIEWED_PLUGIN_ARCHIVES
  ?? path.join(workspace, 'build-inputs', 'aio-1.2.0-reviewed-plugins');
const upstream = process.env.DSH_REVIEWED_UPSTREAM
  ?? path.join(workspace, 'deepseek-harness-upstream-20260908');
const prefix = '@deepseek-ai/';
const runtime = prefix + 'dsh-client-runtime';
const store = prefix + 'dsh-client-store';

function stageFor(t) {
  const stage = createMigrationStaging();
  t.after(() => fs.rmSync(stage.root, { recursive: true, force: true }));
  return stage;
}

function extract(t, name = '@ha-na-bi/dsh-client-ui-custom') {
  const spec = reviewedPackages.find(item => item.name === name);
  const archive = path.join(archives, spec.archive);
  if (!fs.existsSync(archive)) {
    t.skip(`Reviewed archive unavailable: ${spec.archive}`);
    return undefined;
  }
  const stage = stageFor(t);
  execFileSync('tar', ['-xf', archive, '-C', stage.root], { stdio: 'pipe' });
  return { stage, directory: path.join(stage.root, 'package'), spec };
}

function tree(directory) {
  const files = {};
  function walk(dir, rel = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), name);
      else files[name] = createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex');
    }
  }
  walk(directory);
  return files;
}

function manifestAt(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
}

for (const name of ['@ha-na-bi/dsh-client-ui-custom', '@dsh-external/dsh-webui']) {
  test(`qualified UI adapter closes retired exports for ${name}`, async t => {
    const fixture = extract(t, name);
    if (!fixture) return;
    const result = transformPluginInterfaces(fixture.directory,
      { stage: fixture.stage, write: true, useUiCompat: true });
    assert.equal(result.status, 'migrated');
    assert.deepEqual(result.unresolved, []);
    const client = fs.readFileSync(path.join(fixture.directory, 'lib/client.js'), 'utf8');
    assert.doesNotThrow(() => new Script(client));
    assert.match(client, /require\("dsh-aio-ui-compat"\)/);
    assert.doesNotMatch(client, /require\("@deepseek-ai\/dsh-client-runtime/);
    assert.doesNotMatch(client, /_deepseek_ai_dsh_client_ui_attachment\.ImageGallery/);
    assert.doesNotMatch(client, /_deepseek_ai_dsh_client_ui_primitives\.MessageText/);
    assert.ok(manifestAt(fixture.directory).dsh.client.inject.includes('dsh-aio-ui-compat'));
    const host = fs.readFileSync(path.join(fixture.directory, 'lib/index.js'), 'utf8');
    assert.match(host, /function settingsNamespace\(value\)/);
    for (const [, members] of host.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]@deepseek-ai\/dsh-settings['"]/g)) {
      for (const member of members.split(',')) assert.ok(member.trim() in settingsApi, member);
    }
    assert.equal(typeof settingsApi.SettingsProvider.prototype.installSection, 'function');
    for (const file of Object.keys(tree(fixture.directory)).filter(file => file.startsWith('lib/') && file.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(fixture.directory, file), 'utf8');
      for (const [, members, module] of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"](@deepseek-ai\/[^'"]+)['"]/gm)) {
        const api = await import(module);
        for (const member of members.split(',')) {
          const exported = member.trim().split(/\s+as\s+/)[0];
          if (exported) assert.ok(exported in api, `${name}/${file}: missing ${module}.${exported}`);
        }
      }
    }
    if (name === '@dsh-external/dsh-webui') {
      assert.match(client, /init_katex_stub\(\), init__webui_katex_mhchem_stub\(\)/);
      assert.doesNotMatch(client, /require\("katex"\)/);
      assert.doesNotMatch(client, /import\("katex"\)/);
      assert.match(client, /math_fence/);
      assert.match(client, /math_environment/);
      assert.match(client, /children: parseInlineTokens\(contentToken\.children \|\| \[\]/);
      assert.match(client, /case "math_inline"/);
      assert.doesNotMatch(client, /katex disabled in webui/);
      assert.doesNotMatch(client, /(?:\.conversationEvents|"conversationEvents")/);
      assert.match(client, /\.uiConversation\.events\.register/);
      const adapter = host.slice(host.lastIndexOf('\nfunction installSettingsSection'));
      const install = new Function(`${adapter}\nreturn installSettingsSection;`)();
      const schema = {}, entry = {}, hooks = {};
      let call;
      const owner = { inject(names, callback) {
        assert.deepEqual(names, ['settings']);
        callback({ settings: { installSection(...args) { call = args; } } });
      } };
      install(owner, 'webui-mail', schema, entry, hooks);
      assert.deepEqual(call, [owner, 'webui-mail', schema, entry, hooks]);
      const sound = fs.readFileSync(path.join(fixture.directory, 'lib/task-done-sound.js'), 'utf8');
      assert.doesNotMatch(sound, /Users/);
      assert.match(sound, /join\(PKG_DIR, 'assets', name\)/);
      assert.match(sound, /join\(soundDir, name\)/);
    }
    assert.equal(transformPluginInterfaces(fixture.directory,
      { stage: fixture.stage, write: true, useUiCompat: true }).status, 'unchanged');
  });
}

test('arbitrary paths, forged staging capabilities and installed directories are rejected', t => {
  const stage = stageFor(t);
  const directory = path.join(stage.root, 'package');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  assert.throws(() => transformPluginInterfaces(directory), /capability/);
  assert.throws(() => transformPluginInterfaces(directory, { stage: { root: stage.root } }), /capability/);
  assert.throws(() => transformPluginInterfaces(stage.root, { stage }), /Only the staging/);
  fs.mkdirSync(path.join(directory, 'node_modules'));
  assert.throws(() => transformPluginInterfaces(directory, { stage, write: true }), /Installed\/live/);
  assert.equal(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'), '{}');
});

test('unknown identities fail before any writes', t => {
  const stage = stageFor(t);
  const directory = path.join(stage.root, 'package');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"unknown","version":"1.0.0"}');
  const before = tree(directory);
  assert.throws(() => transformPluginInterfaces(directory, { stage, write: true }), /Unknown package identity/);
  assert.deepEqual(tree(directory), before);
});

for (const spec of reviewedPackages) {
  test(`reviewed extraction: ${spec.name}@${spec.version}`, t => {
    const fixture = extract(t, spec.name);
    if (!fixture) return;
    const { stage, directory } = fixture;
    const before = tree(directory);
    const original = manifestAt(directory);
    const plan = transformPluginInterfaces(directory, { stage });
    assert.deepEqual(tree(directory), before, 'default is read-only planning');
    assert.equal(plan.upstream, 'c389f96');
    const nextManifest = plan.proposedFiles['package.json']
      ? JSON.parse(plan.proposedFiles['package.json']) : original;
    assert.deepEqual(nextManifest.dependencies, original.dependencies);
    assert.deepEqual(nextManifest.devDependencies, original.devDependencies);
    assert.deepEqual(nextManifest.scripts, original.scripts);
    assert.deepEqual(nextManifest.exports, original.exports);
    assert.equal(nextManifest.peerDependencies?.[prefix + 'cordis'], original.peerDependencies?.[prefix + 'cordis']);
    assert.equal(nextManifest.peerDependencies?.[prefix + 'schemastery'], original.peerDependencies?.[prefix + 'schemastery']);
    assert.equal(nextManifest.peerDependencies?.react, original.peerDependencies?.react);
    assert.ok(!nextManifest.dsh.client.inject?.includes(runtime));

    const blocked = ['@ha-na-bi/dsh-client-ui-custom', '@dsh-external/dsh-webui'].includes(spec.name);
    const result = transformPluginInterfaces(directory, { stage, write: true });
    if (blocked) {
      assert.equal(result.status, 'blocked');
      assert.deepEqual(result.written, []);
      assert.deepEqual(tree(directory), before, 'known blockers never result in partial writes');
      assert.ok(result.unresolved.some(item => item.symbol === 'ImageGallery'));
      assert.ok(result.unresolved.some(item => item.symbol === 'MessageText'));
    } else {
      assert.equal(result.unresolved.length, 0);
      const after = tree(directory);
      assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'no files added or dropped');
      for (const file of Object.keys(before)) {
        if (!result.written.includes(file)) assert.equal(after[file], before[file], `${file} preserved`);
      }
      assert.ok(result.written.every(file => file === 'package.json' || /\.tsx?$/.test(file)),
        'working browser code and all assets are byte-identical');
      for (const [id, version] of Object.entries(manifestAt(directory).peerDependencies ?? {})) {
        if (id.startsWith(prefix + 'dsh-')) assert.equal(version, officialVersion, id);
      }
      const again = transformPluginInterfaces(directory, { stage, write: true });
      assert.equal(again.status, 'unchanged');
      assert.deepEqual(again.written, []);
      assert.deepEqual(tree(directory), after);
    }
    const client = plan.proposedFiles['lib/client.js']
      ?? fs.readFileSync(path.join(directory, 'lib/client.js'), 'utf8');
    assert.doesNotThrow(() => new Script(client), 'planned browser code is syntactically valid');
  });
}

test('custom UI maps only its store module and types; gallery behavior is preserved', t => {
  const fixture = extract(t);
  if (!fixture) return;
  const { directory, stage } = fixture;
  const original = fs.readFileSync(path.join(directory, 'lib/client.js'), 'utf8');
  const result = transformPluginInterfaces(directory, { stage });
  const client = result.proposedFiles['lib/client.js'];
  assert.equal(client, original.replace(`require("${runtime}/client")`, `require("${store}")`));
  const manifest = JSON.parse(result.proposedFiles['package.json']);
  assert.equal(manifest.peerDependencies[store], officialVersion);
  assert.equal(manifest.peerDependencies[runtime], undefined);
  assert.equal(manifest.peerDependencies[prefix + 'dsh-client-web-react'], undefined);
  assert.equal(manifest.peerDependencies[prefix + 'dsh-client-ui-attachment'], officialVersion);
  assert.ok(manifest.dsh.client.inject.includes(prefix + 'dsh-client-ui-renderer'));
  assert.ok(manifest.dsh.client.inject.includes(prefix + 'dsh-api-session-controller'));
  assert.ok(manifest.dsh.client.inject.includes(prefix + 'dsh-api-workspace-controller'));
  assert.ok(!manifest.dsh.client.inject.includes(store), 'store is seeded, not a service provider');
  const contract = result.proposedFiles['lib/types/client/settings/contract.d.ts'];
  assert.match(contract, /dsh-client-ui-settings\/client/);
  assert.match(contract, /dsh-client-store/);
  assert.doesNotMatch(contract, /dsh-client-runtime/);
});

test('webui mixed runtime symbols are split, not blindly redirected or dropped', t => {
  const fixture = extract(t, '@dsh-external/dsh-webui');
  if (!fixture) return;
  const result = transformPluginInterfaces(fixture.directory, { stage: fixture.stage });
  const client = result.proposedFiles['lib/client.js'];
  assert.match(client, /_dsh_migration_store\.createSnapshotStore/);
  assert.doesNotMatch(client, /_deepseek_ai_dsh_client_runtime_client\.createSnapshotStore/);
  assert.match(client, /_deepseek_ai_dsh_client_runtime_client\.isAppendSurfaceEvent/);
  assert.match(client, /_deepseek_ai_dsh_client_runtime_client\.isReplacementSurfaceEvent/);
  assert.match(client, /_deepseek_ai_dsh_client_ui_attachment\.ImageGallery/);
  assert.ok(result.unresolved.some(item => item.owner === prefix + 'dsh-session/surface'));
  const manifest = JSON.parse(result.proposedFiles['package.json']);
  assert.equal(manifest.peerDependencies[prefix + 'dsh-client-schema-form'], undefined);
  assert.ok(!manifest.dsh.client.inject.includes(prefix + 'dsh-client-schema-form'));
  assert.match(client, /schema-form: setPath needs a non-empty path/, 'inlined form behavior remains intact');
  assert.ok(manifest.peerDependencies[runtime], 'used obsolete dependency remains visible as a blocker');
  assert.equal(manifest.peerDependencies[prefix + 'dsh-client-ui-locale'], undefined);
  assert.equal(manifest.peerDependencies[prefix + 'dsh-client-locale'], officialVersion);
});

test('unknown runtime members, namespace escapes and extra modules fail closed', t => {
  const fixture = extract(t);
  if (!fixture) return;
  const { directory, stage } = fixture;
  const clientPath = path.join(directory, 'lib/client.js');
  const original = fs.readFileSync(clientPath, 'utf8');
  for (const suffix of [
    '\n_deepseek_ai_dsh_client_runtime_client.unknownAPI();',
    '\nconst escaped = _deepseek_ai_dsh_client_runtime_client;',
    '\nrequire("@deepseek-ai/dsh-client-web-react");',
    '\nrequire("@deepseek-ai/" + "dsh-client-runtime/client");',
  ]) {
    fs.writeFileSync(clientPath, original + suffix);
    const before = tree(directory);
    assert.throws(() => transformPluginInterfaces(directory, { stage, write: true }), /Unreviewed.*API/);
    assert.deepEqual(tree(directory), before);
  }
  fs.writeFileSync(clientPath, original);
  fs.writeFileSync(path.join(directory, 'extra.js'), 'export const unknown = true;');
  assert.throws(() => transformPluginInterfaces(directory, { stage, write: true }), /Unreviewed/);
});

test('known name with a different version is not approved', t => {
  const fixture = extract(t, '@vlln/dsh-navbar');
  if (!fixture) return;
  const manifest = manifestAt(fixture.directory);
  manifest.version = '0.4.1';
  fs.writeFileSync(path.join(fixture.directory, 'package.json'), JSON.stringify(manifest));
  assert.throws(() => transformPluginInterfaces(fixture.directory, { stage: fixture.stage }), /Unknown package identity/);
});

test('changed already-migrated packages require a new review', t => {
  const fixture = extract(t, '@vlln/dsh-navbar');
  if (!fixture) return;
  transformPluginInterfaces(fixture.directory, { stage: fixture.stage, write: true });
  const client = path.join(fixture.directory, 'lib/client.js');
  fs.appendFileSync(client, '\n/* unexpected change */');
  const before = tree(fixture.directory);
  assert.throws(() => transformPluginInterfaces(fixture.directory, { stage: fixture.stage, write: true }),
    /Unreviewed/);
  assert.deepEqual(tree(fixture.directory), before);
});

test('non-code changes also invalidate the reviewed extraction', t => {
  const fixture = extract(t, '@vlln/dsh-navbar');
  if (!fixture) return;
  fs.appendFileSync(path.join(fixture.directory, 'cordis.patch.yml'), '\n# changed patch\n');
  const before = tree(fixture.directory);
  assert.throws(() => transformPluginInterfaces(fixture.directory, { stage: fixture.stage, write: true }),
    /Unreviewed/);
  assert.deepEqual(tree(fixture.directory), before);
});

test('junctions and hardlinks cannot turn staging into writes to external files', t => {
  const stage = stageFor(t);
  const other = stageFor(t);
  const directory = path.join(stage.root, 'package');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(other.root, 'outside.txt'), 'untouched');
  fs.linkSync(path.join(other.root, 'outside.txt'), path.join(directory, 'hardlink'));
  assert.throws(() => transformPluginInterfaces(directory, { stage, write: true }), /hardlinked/);
  fs.unlinkSync(path.join(directory, 'hardlink'));
  fs.symlinkSync(other.root, path.join(directory, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => transformPluginInterfaces(directory, { stage, write: true }), /Symbolic link/);
  assert.equal(fs.readFileSync(path.join(other.root, 'outside.txt'), 'utf8'), 'untouched');
});

test('package-root junctions are rejected before reading the target package', t => {
  const stage = stageFor(t);
  const other = stageFor(t);
  const directory = path.join(stage.root, 'package');
  fs.symlinkSync(other.root, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => transformPluginInterfaces(directory, { stage, write: true }), /symlink\/junction/);
  assert.deepEqual(fs.readdirSync(other.root), []);
});

test('write failure restores earlier files and does not claim success', t => {
  const fixture = extract(t, 'dsh-drag-and-drop');
  if (!fixture) return;
  const before = tree(fixture.directory);
  const realWrite = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (++writes === 2) throw new Error('simulated staging I/O error');
    return realWrite(...args);
  });
  assert.throws(() => transformPluginInterfaces(fixture.directory, { stage: fixture.stage, write: true }),
    /Migration write failed/);
  assert.deepEqual(tree(fixture.directory), before);
});

test('pinned upstream confirms seeded store, service owners, and non-seeded blockers', t => {
  if (!fs.existsSync(path.join(upstream, 'packages/client/web/src/seed.ts'))) {
    t.skip('Reviewed upstream checkout unavailable');
    return;
  }
  const head = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.ok(head.startsWith('c389f96'), 'source conformance must use the reviewed commit');
  const read = file => fs.readFileSync(path.join(upstream, file), 'utf8');
  const seed = read('packages/client/web/src/seed.ts');
  assert.match(seed, /'@deepseek-ai\/dsh-client-store': ClientStore/);
  assert.doesNotMatch(seed, /dsh-client-runtime|dsh-client-web-react|dsh-session\/surface|dsh-client-ui-attachment/);
  assert.match(read('packages/client/store/src/index.ts'), /export function createSnapshotStore/);
  assert.match(read('packages/core/session/src/surface.ts'), /export function isAppendSurfaceEvent/);
  assert.match(read('packages/core/session/src/surface.ts'), /export function isReplacementSurfaceEvent/);
  assert.doesNotMatch(read('packages/client/ui-attachment/src/index.ts'), /export.*ImageGallery/);
  assert.doesNotMatch(read('packages/client/ui-attachment/src/client/index.ts'), /export.*ImageGallery/);
  assert.match(read('packages/client/ui-renderer/src/client/index.ts'), /slots: SlotRegistry/);
  assert.match(read('packages/api/session-controller/src/client/index.ts'), /sessions: import/);
  assert.match(read('packages/api/workspace-controller/src/client/index.ts'), /workspaces: import/);
  for (const owner of ['packages/client/store', 'packages/api/session-controller',
    'packages/api/workspace-controller', 'packages/client/ui-renderer']) {
    assert.equal(JSON.parse(read(`${owner}/package.json`)).version, reviewedSourceVersion);
  }
  const primitives = read('packages/client/ui-primitives/src/index.ts')
    + read('packages/client/ui-primitives/src/icons/index.tsx');
  const values = new Set([...primitives.matchAll(/export (?:const|function|class) (\w+)/g)].map(item => item[1]));
  for (const item of primitives.matchAll(/export \{([^}]+)\}/g)) {
    for (const member of item[1].split(',')) values.add(member.trim());
  }
  assert.ok(!values.has('MessageText'));
  for (const spec of reviewedPackages) {
    const archive = path.join(archives, spec.archive);
    if (!fs.existsSync(archive)) continue;
    const client = execFileSync('tar', ['-xOf', archive, 'package/lib/client.js'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const used = [...new Set([...client.matchAll(
      /(?:_deepseek_ai_dsh_client_ui_primitives|primitives|import_dsh_client_ui_primitives)\.(\w+)/g,
    )].map(item => item[1]))];
    const missing = used.filter(symbol => !values.has(symbol));
    assert.deepEqual(missing, ['@dsh-external/dsh-webui', '@ha-na-bi/dsh-client-ui-custom'].includes(spec.name)
      ? ['MessageText'] : [], `${spec.name}: every primitive export inspected`);
  }
});

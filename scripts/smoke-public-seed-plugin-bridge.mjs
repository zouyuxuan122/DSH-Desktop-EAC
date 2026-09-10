// Run explicitly: node --test scripts/smoke-public-seed-plugin-bridge.mjs
// No native app, HTTP server, model request, or existing user home is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const seed = path.resolve(process.env.DSH_PLUGIN_BRIDGE_PUBLIC_SEED ||
  'H:\\CODEX\\build-inputs\\aio-1.2.0-public-seed-20260908-r4');
assert.equal(path.dirname(seed), 'H:\\CODEX\\build-inputs');
assert.match(path.basename(seed), /^aio-1\.2\.0-public-seed-20260908-r\d+$/);
const scratchParent = path.dirname(seed);
const preload = fileURLToPath(new URL('./lib/public-seed-plugin-bridge-guard.cjs', import.meta.url));
const sidecar = path.join(appRoot, 'sidecar/dist/shell-host.js');
const coreFile = path.join(appRoot, 'sidecar/dist/desktop-core.js');
const { createDesktopCore } = require(coreFile);

function treeDigest(directory) {
  const hash = createHash('sha256');
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      assert.ok(!fs.lstatSync(file).isSymbolicLink(), `Refuse linked fixture content: ${file}`);
      hash.update(path.relative(directory, file));
      if (entry.isDirectory()) walk(file);
      else hash.update(fs.readFileSync(file));
    }
  }
  walk(directory);
  return hash.digest('hex');
}

function safeRemove(root) {
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(scratchParent));
  assert.ok(path.basename(resolved).startsWith('public-seed-plugin-bridge-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('installed desktop-core plugin bridge against isolated public seed and current source patch', { timeout: 180000 }, async (t) => {
  const sourceDigest = treeDigest(seed);
  const root = fs.mkdtempSync(path.join(scratchParent, 'public-seed-plugin-bridge-'));
  t.diagnostic(`Disposable root: ${root}`);
  const home = path.join(root, 'home');
  const userData = path.join(root, 'desktop');
  const logs = path.join(root, 'logs');
  const osHome = path.join(root, 'os-home');
  for (const dir of [userData, logs, osHome]) fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(seed, home, { recursive: true, dereference: false });
  const profile = path.join(home, 'profiles/web-desktop');
  const patchFile = path.join(profile, 'cordis.patch.yml');
  // r4 is immutable historical input. Only this disposable copy receives the
  // lean source defaults and a synthetic disabled row for generic toggle coverage.
  fs.copyFileSync(path.join(appRoot, 'distribution/profile-seed/profiles/web-desktop/cordis.patch.yml'), patchFile);
  fs.appendFileSync(patchFile, '\n- insert:\n    - id: bridge-fixture\n      name: fixture-plugin\n      disabled: true\n');
  const settingsFile = path.join(userData, 'settings.json');
  fs.writeFileSync(settingsFile, '{}\n');
  const core = createDesktopCore({
    appRoot, userDataDir: userData, logsDir: logs, dshHome: home,
    nodeExe: () => process.execPath,
    npmCli: () => { throw new Error('No npm in this smoke'); },
  });
  for (const plugin of core.COMPANION_PLUGINS) {
    const source = core.builtinPluginSourceDir(plugin.dir || plugin.name.split('/').pop());
    // Reject junctions before the actual copy implementation traverses sources.
    treeDigest(source);
    core.copyPluginPackage(profile, source, plugin.name);
  }
  const originalPatch = fs.readFileSync(patchFile, 'utf8');
  const originalManifest = fs.readFileSync(path.join(profile, 'package.json'), 'utf8');
  const env = {
    ...process.env,
    DSH_BRIDGE_SMOKE_ROOT: root,
    DSH_HOME: home, DSH_CWD: root, HOME: osHome, USERPROFILE: osHome,
    APPDATA: path.join(osHome, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(osHome, 'AppData/Local'),
    TEMP: root, TMP: root, XDG_CONFIG_HOME: osHome, XDG_DATA_HOME: osHome,
    NODE_OPTIONS: '', NODE_PATH: '',
    NPM_CONFIG_USERCONFIG: path.join(root, 'unused.npmrc'),
  };
  // Credentials are irrelevant to these methods and must not be inherited.
  for (const key of Object.keys(env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
  }
  const live = new Set();
  const stderrChunks = [];
  let nextId = 0;
  function start() {
    const child = spawn(process.execPath, [
      '--require', preload, sidecar,
      '--app-root', appRoot, '--user-data', userData,
      '--logs-dir', logs, '--dsh-home', home,
    ], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    live.add(child);
    const pending = new Map();
    child.stderr.on('data', (buffer) => stderrChunks.push(buffer.toString()));
    const closed = new Promise((resolve) => child.once('close', (code) => {
      live.delete(child);
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited ${code}: ${stderrChunks.join('')}`));
      }
      resolve(code);
    }));
    child.on('error', (error) => {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (!pending.has(message.id)) return;
      const { resolve, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      resolve(message);
    });
    return {
      async call(method, params = {}) {
        const id = ++nextId;
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 15000);
          pending.set(id, { resolve, reject, timer });
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
        assert.equal(response.ok, true, `${method}: ${response.error}`);
        return response.result;
      },
      async close() {
        child.stdin.end();
        const timeout = setTimeout(() => child.kill(), 5000);
        try { assert.equal(await closed, 0, 'own sidecar exits cleanly on EOF'); }
        finally { clearTimeout(timeout); }
      },
    };
  }
  let rpc = start();
  t.after(async () => {
    for (const child of live) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 5000);
      await closed;
      clearTimeout(timeout);
    }
    try {
      assert.equal(treeDigest(seed), sourceDigest, 'public seed remains byte-identical');
    } finally {
      safeRemove(root);
    }
  });
  async function restart() {
    await rpc.close();
    rpc = start();
  }
  const row = async (id) => (await rpc.call('plugin.list')).find((entry) => entry.id === id);
  const initial = await rpc.call('plugin.list');
  await t.test('classification includes retained companions, a synthetic row and manifest bundles', () => {
    assert.equal(new Set(initial.map((entry) => entry.id)).size, initial.length);
    for (const plugin of core.COMPANION_PLUGINS) {
      const found = initial.find((entry) => entry.id === plugin.id);
      assert.equal(found?.name, plugin.name);
      assert.equal(found.group, 'companion');
      assert.equal(found.core, core.CORE_PLUGIN_IDS.has(plugin.id));
      assert.equal(found.removable, !found.core);
      assert.ok(found.description.length > 0, `${plugin.id}: package description`);
    }
    assert.ok(!initial.some((entry) => ['offpeak', 'plugin-marketplace'].includes(entry.id)));
    assert.ok(initial.some((entry) => entry.id === 'skin-switch'));
    assert.ok(initial.some((entry) => entry.id === 'ui-skin-blue-fantasy' && entry.enabled === false));
    assert.ok(!initial.some((entry) => entry.id === 'ui-skin-maid-atelier'));
    assert.ok(!initial.some((entry) => entry.id === 'dsh-market-plugin'));
    assert.equal(initial.find((entry) => entry.id === 'bridge-fixture').group, 'other');
    assert.equal(initial.find((entry) => entry.id === 'bridge-fixture').enabled, false);
    for (const id of ['dsh-base', 'dsh-web-app', 'dsh-aio-ui-compat']) {
      assert.equal(initial.find((entry) => entry.id === id)?.group, 'core');
      assert.equal(initial.find((entry) => entry.id === id)?.toggleable, false);
    }
    t.diagnostic(`Rows: ${initial.length}; groups: ${JSON.stringify(initial.reduce((counts, entry) => {
      counts[entry.group] = (counts[entry.group] || 0) + 1;
      return counts;
    }, {}))}`);
  });
  await t.test('enable/disable persists through real sidecar EOF/restart and restores initial state', async () => {
    for (const id of ['bridge-fixture', 'balance']) {
      const was = initial.find((entry) => entry.id === id).enabled;
      assert.deepEqual(await rpc.call('plugin.setEnabled', { id, enabled: !was }), { ok: true });
      const changed = fs.readFileSync(patchFile, 'utf8');
      assert.equal((await row(id)).enabled, !was);
      await restart();
      assert.equal((await row(id)).enabled, !was);
      assert.deepEqual(await rpc.call('plugin.setEnabled', { id, enabled: !was }), { ok: true });
      assert.equal(fs.readFileSync(patchFile, 'utf8'), changed, 'repeated toggle is byte-idempotent');
      assert.deepEqual(await rpc.call('plugin.setEnabled', { id, enabled: was }), { ok: true });
      await restart();
      assert.equal((await row(id)).enabled, was);
    }
    assert.equal(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), originalManifest);
    assert.deepEqual(await rpc.call('plugin.list'), initial, 'all row states restored');
  });
  await t.test('remove/restore persists and restores the real companion payload', async () => {
    const id = 'better-sidebar';
    const packageDir = path.join(profile, 'node_modules/dsh-better-sidebar');
    const payload = treeDigest(packageDir);
    assert.deepEqual(await rpc.call('plugin.setRemoved', { id, removed: true }), { ok: true, restartRequired: true });
    assert.equal(fs.existsSync(packageDir), false);
    assert.ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).removedPlugins.includes(id));
    assert.ok(!fs.readFileSync(patchFile, 'utf8').includes('id: better-sidebar'));
    await restart();
    assert.equal((await row(id)).removed, true);
    assert.equal((await row(id)).enabled, false);
    assert.equal((await row(id)).toggleable, false);
    assert.deepEqual(await rpc.call('plugin.setRemoved', { id, removed: false }), { ok: true, restartRequired: true });
    await restart();
    assert.equal((await row(id)).removed, false);
    assert.equal((await row(id)).enabled, true);
    assert.ok(!JSON.parse(fs.readFileSync(settingsFile, 'utf8')).removedPlugins.includes(id));
    assert.equal(treeDigest(packageDir), payload, 'restored source companion is byte-identical');
  });
  await t.test('core removal and unknown disable/remove reject without changing persistence', async () => {
    const patch = fs.readFileSync(patchFile, 'utf8');
    const settings = fs.readFileSync(settingsFile, 'utf8');
    for (const id of ['plugin-manager', 'plugin-shield', 'missing-plugin']) {
      assert.equal((await rpc.call('plugin.setRemoved', { id, removed: true })).ok, false);
    }
    assert.equal((await rpc.call('plugin.setEnabled', { id: 'missing-plugin', enabled: false })).ok, false);
    assert.equal(fs.readFileSync(patchFile, 'utf8'), patch);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), settings);
  });
  await t.test('updates.list returns actual installed current versions with all remote work blocked', async () => {
    const result = await rpc.call('updates.list', { force: true });
    assert.equal(result.list.length, core.pluginUpdateSources().length);
    assert.equal(typeof result.autoUpdate, 'boolean');
    const versions = {};
    for (const entry of result.list) {
      const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'node_modules', entry.name, 'package.json'), 'utf8'));
      assert.equal(entry.current, pkg.version, `${entry.id}: installed version`);
      assert.equal(entry.hasUpdate, false);
      versions[entry.id] = { current: entry.current, latest: entry.latest, error: entry.error };
    }
    t.diagnostic(`Offline update versions: ${JSON.stringify(versions)}`);
    assert.match(stderrChunks.join(''), /SMOKE_BLOCKED:/);
  });
  await t.test('new kernel exposes the read-only pluginInventory list API', async () => {
    const { default: Inventory } = await import('@deepseek-ai/dsh-host-plugin-inventory');
    assert.equal(typeof Inventory.prototype.list, 'function');
    assert.equal(Inventory.prototype.setEnabled, undefined);
    assert.equal(Inventory.prototype.setRemoved, undefined);
    const client = fs.readFileSync(path.join(appRoot, 'assets/plugins/dsh-plugin-manager/lib/client.js'), 'utf8');
    assert.ok(client.includes('ctx.remote.pluginInventory.list()'));
    assert.ok(client.includes('b.setEnabled('));
    assert.ok(client.includes('b.setRemoved('));
    t.diagnostic('Kernel inventory is read-only; mutations still use the tested desktop bridge.');
  });
  await t.test('installed kernel --version exits without launching a server', async () => {
    const bin = core.dshBin();
    const expected = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), '../package.json'), 'utf8')).version;
    const child = spawn(process.execPath, ['--require', preload, bin, '--version'], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill(), 15000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    clearTimeout(timeout);
    live.delete(child);
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes(expected), stdout);
    assert.ok(!stderr.includes('SMOKE_BLOCKED:server'), stderr);
    t.diagnostic(`Installed kernel --version: ${stdout.trim()}`);
  });
  await rpc.close();
  fs.writeFileSync(patchFile, originalPatch);
  assert.equal(fs.readFileSync(patchFile, 'utf8'), originalPatch);
  t.diagnostic(`Actual sidecar: ${sidecar}; sha256=${createHash('sha256').update(fs.readFileSync(sidecar)).digest('hex')}`);
  t.diagnostic('Only owned stdio children were started; all exit before fixture cleanup.');
});

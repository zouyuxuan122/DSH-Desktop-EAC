// Read-only inventory: source/public seed only. Never inspect a user or candidate home.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../', import.meta.url));
const publicSeed = 'H:\\CODEX\\build-inputs\\aio-1.2.0-public-seed-20260908-r4';
const sourceProfile = path.join(repo, 'distribution/profile-seed/profiles/web-desktop');
const publicProfile = path.join(publicSeed, 'profiles/web-desktop');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const { createDesktopCore } = require('../sidecar/dist/desktop-core.js');
// Construction alone is inert; only the exported registry is consulted.
const registry = createDesktopCore({
  appRoot: repo, userDataDir: '', logsDir: '', dshHome: '',
  nodeExe() { throw new Error('Inventory never executes a runtime'); },
  npmCli() { throw new Error('Inventory never executes npm'); },
});

function assetManifests(kind) {
  return fs.readdirSync(path.join(repo, 'assets', kind), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(repo, 'assets', kind, entry.name, 'package.json');
      return fs.existsSync(file) ? [{ file, pkg: json(file), kind }] : [];
    });
}
const assets = [...assetManifests('plugins'), ...assetManifests('skins')];
const manifest = json(path.join(sourceProfile, 'package.json'));
const prepared = json(path.join(publicProfile, 'package.json'));
const patch = load(fs.readFileSync(path.join(sourceProfile, 'cordis.patch.yml'), 'utf8'),
  { schema: entryListSchema });
const rows = patch.flatMap((entry) => entry.insert ?? [entry]);
const packaged = new Map(assets.map((entry) => [entry.pkg.name, entry]));
const candidates = new Set([
  ...packaged.keys(),
  ...Object.keys(manifest.dependencies),
  ...manifest.dsh.profile.bundles,
  ...prepared.dsh.profile.bundles,
]);
function resolvePackage(name) {
  if (packaged.has(name)) return packaged.get(name);
  for (const base of [publicProfile, repo]) {
    const file = path.join(base, 'node_modules', name, 'package.json');
    if (fs.existsSync(file)) return { file, pkg: json(file), kind: 'dependency' };
  }
  return undefined;
}
const active = new Set([
  ...prepared.dsh.profile.bundles,
  ...rows.filter((row) => row.name && row.disabled !== true).map((row) => row.name),
]);
const requiredBy = new Map();
const optionalBy = new Map();
const visited = new Set();
const queue = [...active];
while (queue.length) {
  const name = queue.shift();
  if (visited.has(name)) continue;
  visited.add(name);
  const info = resolvePackage(name);
  if (!info) continue;
  const pkg = info.pkg;
  const injected = pkg.dsh?.client?.inject ?? [];
  const dependencies = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...injected.filter((value) => typeof value === 'string'),
  ]);
  for (const dep of dependencies) {
    if (dep === name) continue;
    const optional = Object.hasOwn(pkg.optionalDependencies ?? {}, dep) ||
      (pkg.peerDependenciesMeta?.[dep]?.optional === true &&
        !Object.hasOwn(pkg.dependencies ?? {}, dep) && !injected.includes(dep));
    const edges = optional ? optionalBy : requiredBy;
    if (!edges.has(dep)) edges.set(dep, new Set());
    edges.get(dep).add(name);
    if (!optional) queue.push(dep);
  }
}
const inventory = [...candidates].sort().map((name) => {
  const info = resolvePackage(name);
  const registrations = rows.filter((row) => row.name === name);
  const bundled = prepared.dsh.profile.bundles.includes(name);
  const declaredBy = [...(requiredBy.get(name) ?? [])].sort();
  const state = active.has(name) ? 'enabled'
    : registrations.length && registrations.every((row) => row.disabled === true) ? 'disabled'
      : declaredBy.length ? 'dependency-only' : 'not-composed';
  return {
    name, state,
    role: declaredBy.length ? 'dependency-required'
      : registry.CORE_PLUGIN_IDS.has(registry.COMPANION_PLUGINS.find((p) => p.name === name)?.id)
        ? 'desktop-core' : 'optional-feature',
    requiredBy: declaredBy,
    optionalBy: [...(optionalBy.get(name) ?? [])].sort(),
    owners: [
      info?.file,
      Object.hasOwn(manifest.dependencies, name) || manifest.dsh.profile.bundles.includes(name)
        ? path.join(sourceProfile, 'package.json') : null,
      registrations.length ? path.join(sourceProfile, 'cordis.patch.yml') : null,
      registry.COMPANION_PLUGINS.some((p) => p.name === name)
        ? path.join(repo, 'sidecar/src/desktop-core.ts') : null,
      bundled && !manifest.dsh.profile.bundles.includes(name)
        ? path.join(repo, 'scripts/prepare-public-seed.mjs') : null,
      info?.pkg.dsh?.bundle?.patch ? path.resolve(path.dirname(info.file), info.pkg.dsh.bundle.patch) : null,
    ].filter(Boolean),
  };
});

test('public source plugin defaults distinguish dependencies from optional features', (t) => {
  const byName = new Map(inventory.map((row) => [row.name, row]));
  for (const name of [
    'dsh-offpeak', '@deepseek-ai/dsh-plugin-marketplace', 'dshmarket',
    '@sanqi-normal/dsh-webui-market-plugin',
  ]) {
    assert.ok(!byName.has(name), `${name} must not be reintroduced to source defaults`);
  }
  assert.equal(assets.filter((entry) => entry.kind === 'skins').length, 10);
  assert.ok(byName.has('@deepseek-ai/dsh-skin-switch'), 'skin-switch companion must be inventoried');
  assert.ok(!rows.some((row) => row.id?.startsWith('ui-skin-')));
  for (const name of ['@deepseek-ai/dsh-plugin-manager', 'dsh-plugin-shield']) {
    assert.equal(byName.get(name).state, 'enabled');
    assert.equal(byName.get(name).role, 'desktop-core');
  }
  assert.equal(byName.get('dsh-aio-ui-compat').state, 'enabled');
  assert.equal(byName.get('dsh-aio-ui-compat').role, 'dependency-required');
  assert.ok(byName.get('dsh-aio-ui-compat').requiredBy.includes('@dsh-external/dsh-webui'));
  for (const state of ['enabled', 'disabled', 'dependency-only', 'not-composed']) {
    t.diagnostic(`${state}: ${inventory.filter((row) => row.state === state).map((row) => row.name).join(', ') || '(none)'}`);
  }
  for (const row of inventory.filter((entry) => entry.role === 'dependency-required')) {
    t.diagnostic(`REQUIRED ${row.name} <- ${row.requiredBy.join(', ')}`);
  }
  for (const row of inventory.filter((entry) => ['disabled', 'not-composed'].includes(entry.state))) {
    t.diagnostic(`REVIEW ONLY ${row.name}: ${row.role}; owners=${row.owners.join(' | ')}`);
  }
  t.diagnostic('Static manifest/bundle/client-inject edges only: not proof of safe deletion; dynamic imports and product intent still require review.');
  t.diagnostic(`Packaging copies assets via ${path.join(repo, 'tauri-app/scripts/stage.ts')}; source profile dependencies/bundles and patch are separate owners.`);
});

test('promptoptimizer is intended-enabled and must be retained inside webui', async (t) => {
  const webui = resolvePackage('@dsh-external/dsh-webui');
  const modulesFile = path.join(path.dirname(webui.file), 'lib/modules.js');
  const modules = await import(pathToFileURL(modulesFile).href);
  assert.ok(modules.WEBUI_MODULE_KEYS.includes('promptOptimize'));
  // This is the checked-in PUBLIC default, never a user's settings.yaml.
  const publicDefaults = load(fs.readFileSync(path.join(repo, 'distribution/profile-seed/settings.yaml'), 'utf8'));
  const flags = publicDefaults['webui-modules'];
  assert.notEqual(flags.promptOptimize, false);
  assert.ok(active.has('@dsh-external/dsh-webui'));
  t.diagnostic(`RETAIN promptoptimizer = @dsh-external/dsh-webui:promptOptimize; intended-enabled, retained independently of runtime health. Owner=${modulesFile}`);
  t.diagnostic(`Public disabled webui modules: ${Object.entries(flags).filter(([, value]) => value === false).map(([key]) => key).join(', ')}`);
});

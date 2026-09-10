import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewedPackages } from '../scripts/migrate-plugin-interfaces.mjs';
import { localPackages, prepareManifest, assertEmptyOutput, assertPlainPath,
  inspectLocalPackages, installedManifest, validateInstallLock, summarizeInstallFailure } from '../scripts/prepare-public-seed.mjs';

test('install diagnostics preserve public dependency failures without disclosing credentials or user paths', () => {
  const result = summarizeInstallFailure([
    'npm error code ERESOLVE',
    'npm error Could not resolve dependency:',
    'npm error peer example@"1.0.0" from sample@2.0.0',
    'npm error C:\\Users\\Somebody\\private',
    'npm error authorization Bearer private-value',
    'npm error sk-' + 'x'.repeat(32),
  ].join('\n'));
  assert.match(result, /ERESOLVE/);
  assert.match(result, /sample@2.0.0/);
  assert.doesNotMatch(result, /Somebody|private-value|sk-/);
});

const version = '0.1.5-rc.2';
test('lean target retains six required archives without erasing historical migration coverage', () => {
  const source = JSON.parse(fs.readFileSync(new URL(
    '../distribution/profile-seed/profiles/web-desktop/package.json', import.meta.url)));
  const root = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const { lock } = fixture();
  const prepared = prepareManifest(source, lock);
  assert.equal(Object.keys(localPackages).length, 6);
  assert.equal(reviewedPackages.length, 8);
  for (const name of ['@vlln/dsh-navbar', 'dsh-smooth-stream', 'dsh-usage-skill']) {
    assert.equal(source.dependencies[name], undefined);
    assert.equal(prepared.dependencies[name], undefined);
    assert.equal(root.dependencies[name], undefined);
    assert.equal(localPackages[name], undefined);
    assert.ok(!prepared.dsh.profile.bundles.includes(name));
  }
  for (const name of ['@vlln/dsh-navbar', 'dsh-usage-skill']) {
    assert.ok(reviewedPackages.some(pkg => pkg.name === name));
  }
  assert.ok(prepared.dependencies['@dsh-external/dsh-webui']);
  assert.ok(prepared.dependencies['dsh-aio-ui-compat']);
});
function fixture() {
  const source = { name: 'fixture', dependencies: Object.fromEntries(
    Object.entries(localPackages).map(([name, [, ver]]) => [name, ver])),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
  source.dependencies['@deepseek-ai/dsh-client-ui-renderer'] = version;
  source.dependencies['dsh-meme'] = '^0.1.39';
  const lock = { packages: {
    '': { dependencies: { '@deepseek-ai/dsh': version } },
    'node_modules/@deepseek-ai/dsh': { version },
    'node_modules/@deepseek-ai/dsh-base': { version },
  } };
  return { source, lock };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('manifest pins public bounds, reviewed archives and the official root graph without mutating input', () => {
  const { source, lock } = fixture();
  source.dependencies['@dsh-external/dsh-visualize'] = 'git+https://github.com/Nagi-ovo/dsh-visualize.git';
  const before = structuredClone(source);
  const result = prepareManifest(source, lock);
  assert.deepEqual(source, before);
  assert.equal(result.dependencies['dsh-meme'], '0.1.39');
  assert.equal(result.dependencies['@dsh-external/dsh-visualize'], 'file:../packages/dsh-external-dsh-visualize-0.1.2.tgz');
  assert.equal(result.dependencies['@deepseek-ai/dsh-base'], version);
  assert.equal(result.overrides['@deepseek-ai/dsh'], version);
  assert.deepEqual(result.dsh.profile.bundles, [...source.dsh.profile.bundles, 'dsh-aio-ui-compat']);
});

test('unknown local packages, missing reviewed dependencies and mixed official graphs fail closed', () => {
  for (const spec of ['file:C:/private/plugin', 'workspace:*', 'git+https://example.org/head', 'latest']) {
    const { source, lock } = fixture();
    source.dependencies.unknown = spec;
    assert.throws(() => prepareManifest(source, lock), /unknown local/);
  }
  const { source, lock } = fixture();
  delete source.dependencies['@dsh-external/dsh-visualize'];
  assert.throws(() => prepareManifest(source, lock), /missing reviewed/);
  const next = fixture();
  next.lock.packages['node_modules/@deepseek-ai/dsh'].version = '0.1.2';
  assert.throws(() => prepareManifest(next.source, next.lock), /inconsistent/);
  assert.throws(() => prepareManifest(next.source, {}), /missing root/);
});

test('target must exist, be empty, and not overlap protected inputs', t => {
  const root = temporary(t);
  const input = path.join(root, 'input');
  const target = path.join(root, 'target');
  fs.mkdirSync(input);
  fs.mkdirSync(target);
  assert.equal(assertEmptyOutput(target, [input]), fs.realpathSync(target));
  assert.throws(() => assertEmptyOutput(input, [input]), /overlaps/);
  const nested = path.join(input, 'nested');
  fs.mkdirSync(nested);
  assert.throws(() => assertEmptyOutput(nested, [input]), /overlaps/);
  fs.writeFileSync(path.join(target, 'keep'), 'unchanged');
  assert.throws(() => assertEmptyOutput(target, [input]), /EMPTY/);
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'unchanged');
  assert.throws(() => assertEmptyOutput(path.join(root, 'missing'), [input]));
});

test('symlink or junction ancestors are rejected', t => {
  const root = temporary(t);
  const real = path.join(root, 'real');
  const link = path.join(root, 'link');
  fs.mkdirSync(real);
  fs.mkdirSync(path.join(real, 'child'));
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertPlainPath(path.join(link, 'child')), /symbolic/);
});

test('archive inventory rejects missing or unknown packages before reading archives', async t => {
  const root = temporary(t);
  await assert.rejects(inspectLocalPackages(root), /unknown or missing/);
  fs.writeFileSync(path.join(root, 'unknown.tgz'), '');
  await assert.rejects(inspectLocalPackages(root), /unknown or missing/);
});

test('final manifest retains exact installed plugin versions, never mutable heads or file paths', t => {
  const root = temporary(t);
  const { source, lock } = fixture();
  const prepared = prepareManifest(source, lock);
  for (const [name, spec] of Object.entries(prepared.dependencies)) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      name, version: name === 'dsh-aio-ui-compat' ? '1.0.0' : localPackages[name]?.[1] || spec,
    }));
  }
  const final = installedManifest(prepared, root);
  assert.equal(final.dependencies['@dsh-external/dsh-visualize'], '0.1.2');
  assert.equal(final.dependencies['dsh-aio-ui-compat'], '1.0.0');
  assert.ok(final.dsh.profile.bundles.includes('dsh-aio-ui-compat'));
  assert.doesNotMatch(JSON.stringify(final), /file:|git\+/);
  fs.writeFileSync(path.join(root, 'dsh-meme/package.json'), JSON.stringify({ name: 'dsh-meme', version: '9.0.0' }));
  assert.throws(() => installedManifest(prepared, root), /mismatch/);
});

test('replay locks require matching roots, integrity, portable sources and bounded paths', () => {
  const manifest = { dependencies: { fixture: '1.0.0' } };
  const lock = { lockfileVersion: 3, packages: {
    '': { dependencies: manifest.dependencies },
    'node_modules/fixture': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
      integrity: 'sha512-fixture' },
  } };
  validateInstallLock(lock, manifest);
  for (const resolved of ['file:C:/private/pkg', 'file:../packages/unknown.tgz', 'git+https://example.org/head']) {
    const bad = structuredClone(lock);
    bad.packages['node_modules/fixture'].resolved = resolved;
    assert.throws(() => validateInstallLock(bad, manifest), /nonportable/);
  }
  const bad = structuredClone(lock);
  bad.packages['node_modules/../../escape'] = bad.packages['node_modules/fixture'];
  assert.throws(() => validateInstallLock(bad, manifest), /path/);
  assert.throws(() => validateInstallLock(lock, { dependencies: {} }), /mismatch/);
});

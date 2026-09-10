import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectSeedTree, inspectSeedText, inspectSeedArtifact, inspectPublicConfig } from './public-seed-privacy.mjs';
import { createMigrationStaging, transformPluginInterfaces } from './migrate-plugin-interfaces.mjs';
import { installWebuiUsageHost } from './webui-usage-host-compat.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const official = name => /^@deepseek-ai\/dsh(?:-|$)/.test(name);
const exact = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
const version = '0.1.5-rc.2';
const compat = { name: 'dsh-aio-ui-compat', version: '1.0.0', archive: 'dsh-aio-ui-compat-1.0.0.tgz' };
const compatRoot = path.join(repo, 'assets/plugins', compat.name);
export const localPackages = Object.freeze({
  '@dsh-external/dsh-visualize': ['dsh-external-dsh-visualize-0.1.2.tgz', '0.1.2'],
  '@dsh-external/dsh-webui': ['dsh-external-dsh-webui-0.5.1.tgz', '0.5.1'],
  '@ha-na-bi/dsh-client-ui-custom': ['ha-na-bi-dsh-client-ui-custom-0.1.0-rc.6.tgz', '0.1.0-rc.6'],
  '@local/dsh-webui-statem-bridge': ['local-dsh-webui-statem-bridge-1.2.2.tgz', '1.2.2'],
  'dsh-drag-and-drop': ['dsh-drag-and-drop-0.1.6.tgz', '0.1.6'],
  'dsh-plugin-wallpaper-engine': ['dsh-plugin-wallpaper-engine-0.6.7.tgz', '0.6.7'],
});
const publicFiles = ['README.md', 'settings.yaml', 'profiles/web-desktop/package.json',
  'profiles/web-desktop/cordis.yml', 'profiles/web-desktop/cordis.patch.yml'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

export function pruneSeedDebugArtifacts(seed) {
  // Validate the entire tree before deleting any packaging-only artifacts.
  const files = inspectSeedTree(seed);
  for (const { file, relative } of files) {
    if (relative.startsWith('profiles/web-desktop/node_modules/') &&
        /\.(?:map|pdb)$/i.test(relative)) fs.unlinkSync(file);
  }
}

export function summarizeInstallFailure(stderr) {
  return String(stderr || '').split(/\r?\n/).filter(line => {
    if (!/^npm error/.test(line) || /password|authorization|credential|secret|token/i.test(line)) return false;
    try { inspectSeedText(line); return true; } catch { return false; }
  }).slice(0, 30).join('\n').slice(0, 4000);
}

export function assertPlainPath(input) {
  const absolute = path.resolve(input);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symbolic path rejected');
  }
  return fs.realpathSync(absolute);
}

export function assertEmptyOutput(output, protectedPaths) {
  const target = assertPlainPath(output);
  if (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length) {
    throw new Error('output must be an existing EMPTY directory');
  }
  for (const input of protectedPaths) {
    const source = assertPlainPath(input);
    for (const [a, b] of [[source, target], [target, source]]) {
      const rel = path.relative(a, b);
      if (!rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) {
        throw new Error('output overlaps protected input');
      }
    }
  }
  return target;
}

export function prepareManifest(source, lock) {
  if (!lock.packages?.['']?.dependencies || !lock.packages[''].dependencies['@deepseek-ai/dsh']) {
    throw new Error('missing root lock dependency data');
  }
  const dependencies = {};
  const overrides = {};
  // Only root-resolved official packages justify graph-wide overrides.
  for (const [location, entry] of Object.entries(lock.packages)) {
    const name = location.replace(/^node_modules\//, '');
    if (location === `node_modules/${name}` && !name.includes('/node_modules/') && official(name)) {
      if (entry.version !== version) throw new Error('inconsistent official root lock');
      overrides[name] = version;
    }
  }
  for (const [name, spec] of Object.entries(lock.packages[''].dependencies)) {
    if (!official(name)) continue;
    if (spec !== version || overrides[name] !== version) throw new Error('inconsistent official root lock');
    dependencies[name] = version;
  }
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-group',
    '@deepseek-ai/schemastery', 'react', 'react-dom']) {
    const resolved = lock.packages[`node_modules/${name}`]?.version;
    if (resolved) dependencies[name] = overrides[name] = resolved;
  }
  for (const [name, spec] of Object.entries(source.dependencies || {})) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error('invalid package name');
    if (Object.hasOwn(localPackages, name)) {
      dependencies[name] = `file:../packages/${localPackages[name][0]}`;
    } else if (official(name)) {
      if (spec !== version) throw new Error('inconsistent official source manifest');
      dependencies[name] = overrides[name] = version;
    } else {
      if (!exact(spec) && !/^[~^]\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) {
        throw new Error('unknown local or mutable package');
      }
      // Public manifest lower bounds are explicit first-build pins; replay uses the full lock.
      dependencies[name] = spec.replace(/^[~^]/, '');
    }
  }
  for (const name of Object.keys(localPackages)) {
    if (!Object.hasOwn(dependencies, name)) throw new Error('missing reviewed local dependency');
  }
  for (const name of source.dsh?.profile?.bundles || []) {
    if (official(name)) dependencies[name] = overrides[name] = version;
    else if (!Object.hasOwn(dependencies, name)) throw new Error('unknown bundle');
  }
  dependencies[compat.name] = `file:../packages/${compat.archive}`;
  const dsh = structuredClone(source.dsh);
  dsh.profile.bundles = [...new Set([...dsh.profile.bundles, compat.name])];
  return { name: source.name, private: true, dependencies, overrides, dsh };
}

export async function inspectLocalPackages(directory) {
  const root = assertPlainPath(directory);
  const expected = Object.values(localPackages).map(([file]) => file).sort();
  if (JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify(expected)) {
    throw new Error('unknown or missing local packages');
  }
  const tar = require('tar');
  const hashes = {};
  for (const [name, [file, expectedVersion]] of Object.entries(localPackages)) {
    const input = path.join(root, file);
    assertPlainPath(input);
    if (!fs.statSync(input).isFile() || fs.statSync(input).size > 64 * 1024 * 1024) {
      throw new Error('invalid local archive');
    }
    let manifest;
    let count = 0;
    await tar.t({ file: input, onReadEntry(entry) {
      if (entry.path !== 'package/package.json') return;
      count++;
      const chunks = [];
      let size = 0;
      entry.on('data', chunk => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      entry.on('end', () => {
        if (size <= 1024 * 1024) manifest = Buffer.concat(chunks).toString('utf8');
      });
    } });
    const data = manifest ? JSON.parse(manifest) : {};
    if (count !== 1 || data.name !== name || data.version !== expectedVersion) {
      throw new Error('local archive identity mismatch');
    }
    hashes[file] = hash(fs.readFileSync(input));
  }
  return hashes;
}

export function installedManifest(prepared, modules) {
  const result = structuredClone(prepared);
  for (const name of Object.keys(result.dependencies)) {
    const installed = json(path.join(modules, name, 'package.json'));
    const expected = name === compat.name ? compat.version : localPackages[name]?.[1] || prepared.dependencies[name];
    if (installed.name !== name || !exact(installed.version) || installed.version !== expected) {
      throw new Error('installed dependency mismatch');
    }
    result.dependencies[name] = installed.version;
  }
  return result;
}

export function validateInstallLock(lock, manifest) {
  if (lock.lockfileVersion !== 3 || JSON.stringify(lock.packages?.['']?.dependencies)
      !== JSON.stringify(manifest.dependencies)) {
    // npm sorts dependency keys, so compare objects independent of insertion order.
    const sorted = object => JSON.stringify(Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)));
    if (lock.lockfileVersion !== 3 || sorted(lock.packages?.['']?.dependencies) !== sorted(manifest.dependencies)) {
      throw new Error('install lock manifest mismatch');
    }
  }
  const allowedFiles = new Set(Object.values(localPackages).map(([file]) => `file:../packages/${file}`));
  allowedFiles.add(`file:../packages/${compat.archive}`);
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (!location.startsWith('node_modules/') || location.split('/').some(part => part === '..' || part === '.')
        || location.includes('\\') || entry.link) throw new Error('invalid install lock path');
    const name = location.split('node_modules/').at(-1);
    if (official(name) && entry.version !== version) throw new Error('mixed official installed graph');
    if ((!allowedFiles.has(entry.resolved) && !/^https:\/\/registry\.npmjs\.org\/[^?#]+$/.test(entry.resolved || ''))
        || !/^sha(?:256|384|512)-/.test(entry.integrity || '')) {
      throw new Error('nonportable dependency resolution');
    }
  }
}

export async function buildSeed({ output, packages, npmCli, replay }) {
  const source = path.join(repo, 'distribution/profile-seed');
  const target = assertEmptyOutput(output, [repo, packages]);
  const cli = assertPlainPath(npmCli);
  if (path.basename(cli) !== 'npm-cli.js' || !fs.statSync(cli).isFile()) {
    throw new Error('explicit npm-cli.js required');
  }
  const yaml = require('js-yaml');
  const configs = new Map();
  for (const relative of publicFiles) {
    const input = path.join(source, relative);
    assertPlainPath(input);
    const text = fs.readFileSync(input, 'utf8');
    inspectSeedText(text);
    if (/\.(?:json|ya?ml)$/.test(relative)) inspectPublicConfig(yaml.load(text));
    configs.set(relative, text);
  }
  const settings = yaml.load(configs.get('settings.yaml'));
  if (!settings || Object.keys(settings).some(key => !['status-rotator', 'webui-modules'].includes(key))
      || !['status-rotator', 'webui-modules'].every(key => Object.hasOwn(settings, key))) {
    throw new Error('public settings sections required');
  }
  const manifest = prepareManifest(JSON.parse(configs.get(publicFiles[2])), json(path.join(repo, 'package-lock.json')));
  // cordis.patch.yml 的 insert 注册必须对应真实存在的插件：要么是 npm manifest
  // 依赖，要么是内置 companion 插件（assets/plugins/<dir>，首启时拷入 profile）。
  // r7 seed 曾在仓库 seed 修正前生成，patch 里残留已删除市场插件的 insert
  // 注册，安装包首启时 dsh web 以 ERR_MODULE_NOT_FOUND 崩溃。skin-switch
  // 现在由 sidecar companion-sync 负责，不能写入脱敏 seed。
  const builtinPlugins = new Set(fs.readdirSync(path.join(repo, 'assets/plugins'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name));
  const patchRegistrations = yaml.load(configs.get('profiles/web-desktop/cordis.patch.yml')) || [];
  for (const entry of patchRegistrations) {
    for (const item of entry.insert || []) {
      const shortName = item.name?.startsWith('@') ? item.name.split('/')[1] : item.name;
      const known = item.name && (Object.hasOwn(manifest.dependencies, item.name) || builtinPlugins.has(shortName));
      if (!known) throw new Error(`patch registers unknown dependency: ${item.name || '(anonymous)'}`);
    }
  }
  const archives = await inspectLocalPackages(packages);
  const nativeFile = path.join(repo, 'node_modules/fs-ext/build/Release/fs_ext.node');
  const nativeBytes = fs.readFileSync(nativeFile);
  inspectSeedText(nativeBytes.toString('latin1'));
  const fingerprint = hash(JSON.stringify({ configs: [...configs], manifest, archives,
    builder: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    migration: hash(fs.readFileSync(new URL('./migrate-plugin-interfaces.mjs', import.meta.url))),
    migrationHelpers: Object.fromEntries([
      './lib/migrate-provider-settings.mjs', './webui-chat-compat.mjs',
      './webui-prompt-optimize-compat.mjs', './webui-continue-compat.mjs',
      './webui-input-chat-tool-compat.mjs',
      './webui-usage-host-compat.mjs',
    ].map(file => [file, hash(fs.readFileSync(new URL(file, import.meta.url)))])),
    usageHost: hash(fs.readFileSync(new URL('../assets/webui-host/usage/integrity.json', import.meta.url))),
    privacy: hash(fs.readFileSync(new URL('./public-seed-privacy.mjs', import.meta.url))),
    reviewedContent: hash(fs.readFileSync(new URL('./public-seed-reviewed-content.mjs', import.meta.url))),
    compat: json(path.join(compatRoot, 'PROVENANCE.json')).clientSha256,
    native: hash(nativeBytes),
    node: process.version, platform: process.platform, arch: process.arch, npmCli: hash(fs.readFileSync(cli)) }));
  const prior = replay ? json(assertPlainPath(replay)) : null;
  if (prior && (prior.fingerprint !== fingerprint || !prior.lock?.packages)) throw new Error('replay inputs differ');
  if (prior) validateInstallLock(prior.lock, manifest);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-public-seed-'));
  // Only this newly-created staging directory is ever removed; output is never deleted.
  try {
    const work = path.join(staging, 'work');
    fs.mkdirSync(work);
    fs.mkdirSync(path.join(staging, 'packages'));
    for (const file of Object.keys(archives)) {
      const bytes = fs.readFileSync(path.join(packages, file));
      if (hash(bytes) !== archives[file]) throw new Error('local archive changed');
      const migrationStage = createMigrationStaging();
      try {
        const tar = require('tar');
        await tar.x({ file: path.join(packages, file), cwd: migrationStage.root, strict: true });
        const report = transformPluginInterfaces(path.join(migrationStage.root, 'package'),
          { stage: migrationStage, write: true, useUiCompat: true });
        if (report.status === 'blocked') {
          const error = new Error(`Plugin interface migration is incomplete: ${report.name}`);
          error.code = 'SEED_INTERFACE_BLOCKED';
          throw error;
        }
        await tar.c({ cwd: migrationStage.root, file: path.join(staging, 'packages', file),
          gzip: true, portable: true, mtime: new Date(0) }, ['package']);
      } finally {
        const safeRoot = assertPlainPath(migrationStage.root);
        if (path.dirname(safeRoot) !== fs.realpathSync(os.tmpdir())) throw new Error('migration cleanup boundary rejected');
        fs.rmSync(safeRoot, { recursive: true, force: true });
      }
    }
    const tar = require('tar');
    const compatManifest = json(path.join(compatRoot, 'package.json'));
    await tar.c({ cwd: compatRoot, prefix: 'package', file: path.join(staging, 'packages', compat.archive),
      gzip: true, portable: true, mtime: new Date(0) }, ['package.json', ...compatManifest.files]);
    writeJson(path.join(work, 'package.json'), manifest);
    if (prior) writeJson(path.join(work, 'package-lock.json'), prior.lock);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) env[key] = staging;
    env.npm_config_userconfig = path.join(staging, 'empty.npmrc');
    env.npm_config_globalconfig = path.join(staging, 'global.npmrc');
    const cache = path.join(os.tmpdir(), 'dsh-aio-public-npm-cache');
    fs.mkdirSync(cache, { recursive: true });
    env.npm_config_cache = assertPlainPath(cache);
    env.npm_config_fetch_retries = '1';
    fs.writeFileSync(env.npm_config_userconfig, '');
    fs.writeFileSync(env.npm_config_globalconfig, '');
    const run = spawnSync(process.execPath, [cli, prior ? 'ci' : 'install', '--ignore-scripts', '--legacy-peer-deps', '--prefer-offline',
      '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], {
      cwd: work, env, shell: false, stdio: 'pipe', timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
    });
    if (run.error || run.status !== 0) {
      const error = new Error(`npm install failed; output left untouched\n${summarizeInstallFailure(run.stderr)}`);
      error.code = 'SEED_INSTALL_FAILED';
      throw error;
    }
    const lock = json(path.join(work, 'package-lock.json'));
    validateInstallLock(lock, manifest);
    const closure = spawnSync(process.execPath, [cli, 'ls', '--omit=dev', '--all', '--parseable'], {
      cwd: work, env, shell: false, stdio: 'pipe', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    });
    if (closure.error || closure.status !== 0) {
      const error = new Error(`Installed dependency closure is incomplete\n${summarizeInstallFailure(closure.stderr)}`);
      error.code = 'SEED_INSTALL_FAILED';
      throw error;
    }
    const modules = path.join(work, 'node_modules');
    await installWebuiUsageHost(path.join(modules, '@dsh-external/dsh-webui'));
    const nativePackage = json(path.join(modules, 'fs-ext/package.json'));
    if (nativePackage.version !== json(path.join(repo, 'node_modules/fs-ext/package.json')).version) {
      throw new Error('Native dependency version differs from the qualified build');
    }
    const nativeTarget = path.join(modules, 'fs-ext/build/Release');
    fs.mkdirSync(nativeTarget, { recursive: true });
    fs.writeFileSync(path.join(nativeTarget, 'fs_ext.node'), nativeBytes, { flag: 'wx' });
    const finalManifest = installedManifest(manifest, modules);
    const seed = path.join(staging, 'seed');
    fs.mkdirSync(path.join(seed, 'profiles/web-desktop'), { recursive: true });
    for (const [relative, text] of configs) {
      if (relative !== publicFiles[2]) fs.writeFileSync(path.join(seed, relative), text, { flag: 'wx' });
    }
    writeJson(path.join(seed, publicFiles[2]), finalManifest);
    fs.renameSync(modules, path.join(seed, 'profiles/web-desktop/node_modules'));
    writeJson(path.join(seed, 'profiles/web-desktop/node_modules/.public-seed-build.json'),
      { fingerprint, archives, lock, node: process.version, nativeScripts: { 'fs-ext': hash(nativeBytes) } });
    pruneSeedDebugArtifacts(seed);
    const rejected = new Set();
    for (const { file, relative } of inspectSeedTree(seed)) {
      const bytes = fs.readFileSync(file);
      const text = bytes.toString('utf8');
      try { inspectSeedArtifact(relative, bytes); }
      catch {
        const parts = relative.slice('profiles/web-desktop/node_modules/'.length).split('/');
        const packageParts = parts.slice(0, parts[0]?.startsWith('@') ? 2 : 1);
        const packageFile = path.join(seed, 'profiles/web-desktop/node_modules', ...packageParts, 'package.json');
        const installedVersion = fs.existsSync(packageFile) ? json(packageFile).version : null;
        rejected.add(`${relative} sha256=${hash(bytes)} version=${exact(installedVersion) ? installedVersion : 'unknown'}`);
      }
      for (const local of [repo, packages, staging, target]) {
        const normalized = text.replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase();
        if (normalized.includes(path.resolve(local).replaceAll('\\', '/').toLowerCase())) {
          rejected.add(relative);
        }
      }
    }
    if (rejected.size) {
      const error = new Error(`Public seed content rejected (${rejected.size} files):\n${[...rejected].slice(0, 40).join('\n')}`);
      error.code = 'SEED_PRIVACY_FAILED';
      throw error;
    }
    assertEmptyOutput(target, [repo, packages]);
    fs.cpSync(seed, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  } finally {
    if (path.dirname(staging) !== fs.realpathSync(os.tmpdir()) && path.dirname(staging) !== path.resolve(os.tmpdir())) {
      throw new Error('staging cleanup boundary rejected');
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  try {
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--output': 'output', '--packages': 'packages', '--npm-cli': 'npmCli', '--replay': 'replay' }[args[i]];
      if (!key || !args[i + 1] || Object.hasOwn(options, key)) throw new Error('invalid arguments');
      options[key] = args[i + 1];
    }
    if (!options.output || !options.packages || !options.npmCli) throw new Error('required arguments missing');
    await buildSeed(options);
    console.log('Public seed prepared with the qualified fs-ext native artifact.');
  } catch (error) {
    if (['SEED_INSTALL_FAILED', 'SEED_INTERFACE_BLOCKED', 'SEED_PRIVACY_FAILED'].includes(error?.code) ||
        /^[A-Za-z][A-Za-z0-9 .,;:-]*$/.test(error?.message || '')) console.error(error.message);
    console.error('Public seed preparation failed. Require --output EMPTY_DIR --packages REVIEWED_TGZ_DIR --npm-cli NPM_CLI_JS [--replay BUILD_RECORD]. No existing target is deleted.');
    process.exitCode = 1;
  }
}

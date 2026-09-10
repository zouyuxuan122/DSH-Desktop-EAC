import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { assertNoLinks, boundedPath, removeBounded } from '../assets/webui-host/usage/filesystem.mjs';

const assets = fileURLToPath(new URL('../assets/webui-host/usage/', import.meta.url));
const sourceHash = 'ccf6be4ece9c5d9d6b502a534d3d1735937b28e614f983c0e76663ba04d31e05';
const wrapper = "// DSHEAC WebUI-owned host migration v1.\nexport { applyUsageHost } from './aio-usage-host/index.mjs';\n";
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function packageOf(require, specifier) {
  let directory = dirname(require.resolve(specifier));
  for (;;) {
    try {
      const pkg = await json(join(directory, 'package.json'));
      if (pkg.name === specifier) return pkg;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate dependency manifest: ${specifier}`);
    directory = parent;
  }
}

/**
 * Install into an explicitly supplied DISPOSABLE/staging WebUI package root.
 * Caller owns seed/staging selection. No discovery of DSH_HOME or user homes.
 * Validates all sources/dependencies before writing; repeat installs are no-ops.
 */
export async function installWebuiUsageHost(webuiDirectory) {
  const root = resolve(webuiDirectory);
  await assertNoLinks(root);
  const pkg = await json(join(root, 'package.json'));
  if (pkg.name !== '@dsh-external/dsh-webui' || pkg.version !== '0.5.1' || pkg.type !== 'module') {
    throw new Error('Unsupported WebUI package/version for usage host migration');
  }
  const require = createRequire(join(root, 'package.json'));
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence',
    '@deepseek-ai/dsh-llm']) {
    if ((await packageOf(require, name)).version !== '0.1.5-rc.2') {
      throw new Error(`Unsupported kernel dependency: ${name}`);
    }
  }
  if ((await packageOf(require, 'fflate')).version !== '0.8.3') {
    throw new Error('Unsupported fflate dependency for usage host migration');
  }
  const manifest = await json(join(assets, 'integrity.json'));
  if (manifest.version !== 1 || manifest.files === null || typeof manifest.files !== 'object'
      || Array.isArray(manifest.files)) throw new Error('Unsupported usage host integrity manifest');
  const names = Object.keys(manifest.files).sort();
  const actualNames = (await readdir(assets)).filter(name => name !== 'integrity.json').sort();
  if (JSON.stringify(names) !== JSON.stringify(actualNames)) throw new Error('Unexpected usage host asset inventory');
  const payloads = new Map();
  for (const name of names) {
    const file = boundedPath(assets, name);
    await assertNoLinks(file);
    const bytes = await readFile(file);
    if (sha256(bytes) !== manifest.files[name]) throw new Error(`Usage host integrity mismatch: ${name}`);
    payloads.set(name, bytes);
  }
  const target = join(root, 'lib', 'usage-host.js');
  await assertNoLinks(target);
  const original = await readFile(target);
  const destination = join(root, 'lib', 'aio-usage-host');
  if (original.toString('utf8') === wrapper) {
    await assertNoLinks(destination);
    const installedNames = (await readdir(destination)).sort();
    if (JSON.stringify(installedNames) !== JSON.stringify(names)) throw new Error('Installed usage host inventory changed');
    for (const [name, bytes] of payloads) {
      const path = boundedPath(destination, name);
      await assertNoLinks(path);
      if (!bytes.equals(await readFile(path))) throw new Error(`Installed usage host changed: ${name}`);
    }
    return { changed: false, directory: destination, files: names };
  }
  if (sha256(original) !== sourceHash) throw new Error('Unrecognized WebUI usage-host.js source');
  try {
    await lstat(destination);
    throw new Error('Refusing to replace an existing usage host directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = join(root, 'lib', `.aio-usage-${randomUUID()}`);
  const entry = join(root, 'lib', `.aio-usage-entry-${randomUUID()}.tmp`);
  let published = false;
  try {
    await mkdir(stage);
    for (const [name, bytes] of payloads) await writeFile(boundedPath(stage, name), bytes, { flag: 'wx' });
    await writeFile(entry, wrapper, { flag: 'wx' });
    if (!original.equals(await readFile(target))) throw new Error('Usage host changed during migration');
    await rename(stage, destination);
    published = true;
    await rename(entry, target);
  } catch (error) {
    if (published) await removeBounded(join(root, 'lib'), destination);
    throw error;
  } finally {
    await removeBounded(join(root, 'lib'), stage);
    await rm(entry, { force: true });
  }
  return { changed: true, directory: destination, files: names };
}

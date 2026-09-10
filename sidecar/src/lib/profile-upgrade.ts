// Deliberately stage-only: no installer, activation, user-config merge or process launch.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const UPGRADE_TARGET = Object.freeze({ app: '9.6.3', kernel: '0.1.5-rc.2' });
const official = (name: string): boolean => /^@deepseek-ai\/dsh(?:-|$)/.test(name);
const fail = (): never => { throw new Error('PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available; profile unchanged'); };
type Manifest = { name?: string; version?: string; dependencies?: Record<string, string> };
type Inventory = { digest: string; files: string[]; packages: { name: string; version: string }[] };
export type UpgradePlan = {
  schema: 1;
  target: typeof UPGRADE_TARGET;
  status: 'new-profile' | 'compatible' | 'requires-installer';
  sourceDigest: string | null;
  mismatches: string[];
};

function readManifest(file: string): Manifest {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail();
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Manifest;
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function plainPath(file: string): string {
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (exists(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail();
  }
  return absolute;
}

// The desktop shell hands us extended-length paths (\\?\C:\... on drives,
// \\?\UNC\server\share\... for UNC). Node's realpath rejects those: it walks the
// prefix as ordinary segments and ends up lstat'ing a bare "C:", which fails with
// EISDIR. Strip the prefix first so anchors and link targets resolve consistently.
function extendedPath(file: string): string {
  if (file.startsWith('\\\\?\\UNC\\')) return `\\\\${file.slice(8)}`;
  if (file.startsWith('\\\\?\\')) return file.slice(4);
  return file;
}

const realPath = (file: string): string => fs.realpathSync(extendedPath(file));

function disjoint(a: string, b: string): void {
  for (const [parent, child] of [[a, b], [b, a]]) {
    const rel = path.relative(parent!, child!);
    if (!rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))) fail();
  }
}

const packageNamePattern = '(?:@[a-z0-9._-]+/)?[a-z0-9._-]+';
const ownedLinkPattern = new RegExp(`^\\.dsh-module-fallback/node_modules/(${packageNamePattern})$`);
const projectionPattern = new RegExp(`^node_modules/(${packageNamePattern})$`);
const packageLocationPattern = new RegExp(`^(?:node_modules/${packageNamePattern}/)*node_modules/(${packageNamePattern})$`);

function canonicalEntry(file: string): string {
  // Canonicalize parents only: a projection must name the owned link, not merely
  // resolve to the same eventual package via some other, unowned chain.
  return path.join(realPath(plainPath(path.dirname(file))), path.basename(file));
}

function generatedFallback(root: string, appRoot: string, relative: string): {
  identity: string; manifest: Manifest;
} {
  const normalized = relative.replaceAll('\\', '/');
  const owned = ownedLinkPattern.exec(normalized);
  const projection = projectionPattern.exec(normalized);
  const name = owned?.[1] ?? projection?.[1];
  if (!name) return fail();
  const ownedFile = path.join(root, '.dsh-module-fallback', 'node_modules', name);
  plainPath(path.dirname(ownedFile));
  if (!exists(ownedFile) || !fs.lstatSync(ownedFile).isSymbolicLink()) return fail();
  if (projection) {
    const file = path.join(root, relative);
    const destination = path.resolve(path.dirname(file), fs.readlinkSync(file));
    if (path.relative(canonicalEntry(destination), canonicalEntry(ownedFile)) !== '') fail();
  }
  const destination = path.resolve(path.dirname(ownedFile), fs.readlinkSync(ownedFile));
  // DSH's generated profile fallback can point through the shared layer
  // <home>/profiles/node_modules/<name>. That entry is itself a junction into
  // the installed app closure. Allow exactly this named, one-hop layout, then
  // apply the same trusted-root validation to its final target. Any other
  // linked parent remains rejected by plainPath().
  const shared = path.join(path.dirname(root), 'node_modules', name);
  const throughSharedLayer = path.relative(path.resolve(shared), path.resolve(destination)) === '';
  let target: string;
  let linkIdentity = '';
  if (throughSharedLayer) {
    if (!exists(shared) || !fs.lstatSync(shared).isSymbolicLink()) fail();
    const sharedDestination = path.resolve(path.dirname(shared), fs.readlinkSync(shared));
    target = realPath(plainPath(sharedDestination));
    linkIdentity = ':shared-layer';
  } else {
    // Reject chained links, linked ancestors, cycles and dangling destinations.
    target = realPath(plainPath(destination));
  }
  if (!fs.statSync(target).isDirectory()) fail();
  for (const [kind, anchor] of [['profile', root], ['app', appRoot]] as const) {
    const location = path.relative(realPath(anchor), target).replaceAll('\\', '/');
    if (packageLocationPattern.exec(location)?.[1] !== name) continue;
    const manifest = readManifest(path.join(target, 'package.json'));
    if (manifest.name !== name || typeof manifest.version !== 'string') fail();
    return { identity: `${projection ? 'projection' : 'owned'}:${name}:${kind}:${location}${linkIdentity}`, manifest };
  }
  return fail();
}

function inventory(root: string, fallbackAppRoot?: string): Inventory {
  plainPath(root);
  const hash = createHash('sha256');
  const files: string[] = [];
  const packages: Inventory['packages'] = [];
  let entries = 0;
  let bytes = 0;
  function walk(relative: string): void {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (++entries > 150000) fail();
    if (stat.isSymbolicLink()) {
      if (!fallbackAppRoot) return fail();
      const link = generatedFallback(root, fallbackAppRoot, relative);
      hash.update(JSON.stringify([relative.replaceAll('\\', '/'), 'generated-link', link.identity, link.manifest.version]));
      packages.push({ name: link.manifest.name!, version: link.manifest.version! });
      // Validate metadata but never recurse through projections or owned links.
      // Profile-owned real packages are visited through their ordinary paths.
      return;
    }
    hash.update(JSON.stringify([relative.replaceAll('\\', '/'), stat.isDirectory() ? 'dir' : 'file']));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 3 * 1024 ** 3 || stat.size > 128 * 1024 ** 2) fail();
      const content = fs.readFileSync(file);
      hash.update(createHash('sha256').update(content).digest());
      files.push(relative);
      if (/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(relative.replaceAll('\\', '/'))) {
        const manifest = readManifest(file);
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
          packages.push({ name: manifest.name, version: manifest.version });
        }
      }
    } else fail();
  }
  walk('');
  return { digest: hash.digest('hex'), files, packages };
}

function ownedPackages(appRoot: string): Set<string> {
  plainPath(appRoot);
  if (readManifest(path.join(appRoot, 'package.json')).version !== UPGRADE_TARGET.app) fail();
  const scope = path.join(appRoot, 'node_modules', '@deepseek-ai');
  plainPath(scope);
  const owned = new Set<string>();
  for (const entry of fs.readdirSync(scope).sort()) {
    if (!official(`@deepseek-ai/${entry}`)) continue;
    const directory = path.join(scope, entry);
    plainPath(directory);
    const manifest = readManifest(path.join(directory, 'package.json'));
    if (manifest.name === `@deepseek-ai/${entry}` && manifest.version === UPGRADE_TARGET.kernel) {
      owned.add(manifest.name);
    }
  }
  if (!owned.has('@deepseek-ai/dsh')) fail();
  return owned;
}

export function planProfileUpgrade(appRoot: string, profile: string): UpgradePlan {
  const app = plainPath(appRoot);
  const source = plainPath(profile);
  disjoint(app, source);
  const owned = ownedPackages(app);
  if (!exists(source)) return { schema: 1, target: UPGRADE_TARGET, status: 'new-profile', sourceDigest: null, mismatches: [] };
  if (!fs.statSync(source).isDirectory()) fail();
  const snapshot = inventory(source, app);
  const manifestFile = path.join(source, 'package.json');
  const manifest = exists(manifestFile) ? readManifest(manifestFile) : {};
  const mismatches = new Set<string>();
  let evidence = 0;
  for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
    if (!owned.has(name)) continue;
    if (spec !== UPGRADE_TARGET.kernel) mismatches.add(name);
  }
  for (const installed of snapshot.packages) {
    if (!owned.has(installed.name)) continue;
    evidence++;
    if (installed.version !== UPGRADE_TARGET.kernel) mismatches.add(installed.name);
  }
  if (!evidence || !exists(manifestFile)) mismatches.add('unversioned-profile');
  return {
    schema: 1, target: UPGRADE_TARGET, status: mismatches.size ? 'requires-installer' : 'compatible',
    sourceDigest: snapshot.digest, mismatches: [...mismatches].sort(),
  };
}

/** Read-only gate. Never treat an old profile as repaired merely because the app updated. */
export function assertProfileStartup(appRoot: string, profile: string): void {
  try {
    const pending = path.join(path.dirname(profile), `.${path.basename(profile)}-upgrade-stage`);
    plainPath(pending);
    if (exists(pending) || planProfileUpgrade(appRoot, profile).status === 'requires-installer') fail();
  } catch {
    // No filesystem errors, private paths, YAML or credentials enter RPC/log diagnostics.
    fail();
  }
}

/**
 * Explicit offline API, not called at startup. Stage beside the source on the same
 * volume. Original files are never renamed/removed; caught staging errors roll back
 * only our new directory. A crash leaves an inspectable stage that blocks startup.
 */
export function stageProfileUpgrade(
  appRoot: string,
  profile: string,
  checkpoint: (phase: 'created' | 'copied' | 'recorded') => void = () => {},
): { directory: string; plan: UpgradePlan } {
  const source = plainPath(profile);
  const plan = planProfileUpgrade(appRoot, source);
  if (plan.status !== 'requires-installer') throw new Error('PROFILE_UPGRADE_NOT_NEEDED');
  // Startup understands kernel projections; staging still requires a link-free
  // source until candidate link rebasing and activation have been implemented.
  inventory(source);
  const parent = plainPath(path.dirname(source));
  const stage = path.join(parent, `.${path.basename(source)}-upgrade-stage`);
  if (exists(stage)) throw new Error('PROFILE_UPGRADE_STAGE_EXISTS');
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    checkpoint('created');
    const candidate = path.join(stage, 'candidate');
    fs.cpSync(source, candidate, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    checkpoint('copied');
    if (inventory(source).digest !== plan.sourceDigest || inventory(candidate).digest !== plan.sourceDigest) fail();
    fs.writeFileSync(path.join(stage, 'upgrade.json'), `${JSON.stringify({
      ...plan, state: 'awaiting-installer', activationAllowed: false,
      // No config/manifest contents or absolute private paths in the journal.
      pending: ['custom dependency closure', 'native approvals', 'offline validation', 'quiescence lock',
        'atomic activation journal', 'boot health commit and rollback'],
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    checkpoint('recorded');
    if (inventory(source).digest !== plan.sourceDigest) fail();
    return { directory: stage, plan };
  } catch {
    // Refuse cleanup if any ancestor was replaced by a link while staging.
    plainPath(parent);
    plainPath(stage);
    if (path.dirname(stage) !== parent) fail();
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error('PROFILE_UPGRADE_STAGE_FAILED: original profile was not replaced');
  }
}

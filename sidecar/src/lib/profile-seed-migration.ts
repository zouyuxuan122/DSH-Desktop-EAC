/**
 * Explicit OFFLINE migration of the reviewed AIO profile.
 * No CLI, process launch, installer, startup hook, cleanup or automatic health commit.
 *
 * Caller contract:
 * 1. Independently review the seed (including native artifacts), then bind its
 *    inspectMigrationSeed() digest into prepareSeedMigration().
 * 2. Hold an exclusive external lease over this profile, ALL CLI/desktop users
 *    and other migration callers. assertQuiescent must attest to that lease for
 *    every mutating API. A true return is a prerequisite, NOT process detection.
 * 3. activate -> separately boot/test -> stop all writers -> commit or rollback.
 *    recover rolls back interrupted activation; pending-health never commits itself.
 * 4. `inheritProfile: 'none'` replaces the whole old profile with the reviewed
 *    seed. Sessions, attachments, Home settings and credentials live outside
 *    the profile and remain untouched; no old plugin, patch row or cache enters
 *    the candidate. This is the AIO installer policy.
 * 5. Optional retirementPolicy binds exact package/row IDs and original patch hashes
 *    to the reviewed seed digest. Approved blocks become inert comments; original
 *    patch bytes live in transaction/retirement-originals and the full backup.
 *    All other user bytes remain unchanged. No policy means no retirement.
 *
 * Transactions are same-volume siblings. Journals are append-only and fsynced;
 * backups and unsuccessful candidates are retained. Power-loss/filesystem durability
 * still requires platform qualification; tests cover exception/process interruptions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const yaml = require('js-yaml');
const exportsResolver = require('resolve.exports');
export const MIGRATION_TARGET = Object.freeze({ app: '9.6.3', kernel: '0.1.5-rc.2' });
const COMPAT = 'dsh-aio-ui-compat';
const RENDERER = '@deepseek-ai/dsh-client-ui-renderer';
const LEGACY_RENDERER = '@deepseek-ai/dsh-client-web-react';
// Only the explicitly approved lean-distribution removals, never a missing-package wildcard.
export const APPROVED_RETIREMENT_PACKAGES = Object.freeze([
  'dsh-offpeak', '@deepseek-ai/dsh-plugin-marketplace',
  '@vlln/dsh-navbar', 'dsh-smooth-stream', 'dsh-usage-skill',
  '@sanqi-normal/dsh-webui-market-plugin',
]);
const APPROVED_ENABLED_RETIREMENTS = new Set(['@sanqi-normal/dsh-webui-market-plugin']);
type PatchFile = 'cordis.yml' | 'cordis.patch.yml';
export type ApprovedRetirementPolicy = {
  seedDigest: string;
  patches: {
    file: PatchFile;
    originalSha256: string;
    rows: { package: string; id: string; allowEnabled?: boolean }[];
  }[];
};
type RetirementRecord = {
  policy: ApprovedRetirementPolicy;
  patches: { file: PatchFile; originalSha256: string; projectedSha256: string }[];
};
// HEAD's shipped profile uses rc.7; the reviewed updated source uses alpha.2.
const officialSourceVersions = Object.freeze(['0.1.0-rc.7', '0.1.3-alpha.2', '0.1.5-rc.2']);
export const REVIEWED_SOURCE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '@deepseek-ai/dsh-client-ui-primitives': officialSourceVersions,
  '@deepseek-ai/dsh-client-ui-slots': officialSourceVersions,
  [LEGACY_RENDERER]: officialSourceVersions,
  '@dsh-external/dsh-visualize': ['git+https://github.com/Nagi-ovo/dsh-visualize.git', '0.1.2'],
  '@dsh-external/dsh-webui': ['0.5.1'],
  '@ha-na-bi/dsh-client-ui-custom': ['0.1.0-rc.6'],
  '@local/dsh-webui-statem-bridge': ['1.2.2'],
  '@vlln/dsh-navbar': ['git+https://github.com/vlln/dsh-navbar.git', '0.4.0'],
  'dsh-drag-and-drop': ['git+https://github.com/bill9109/dsh-drag-and-drop.git', '0.1.6'],
  'dsh-find-plugin': ['^0.3.7', '0.3.7'],
  'dsh-meme': ['^0.1.39', '0.1.39'],
  'dsh-plugin-wallpaper-engine': ['^0.6.7', '0.6.7'],
  'dsh-smooth-stream': ['^0.4.1', '0.4.1'],
  'dsh-status-rotator': ['^0.9.1', '0.9.1'],
  'dsh-usage-skill': ['0.3.0'],
  'dsh-whale-widget': ['^0.2.10', '0.2.10'],
});
for (const versions of Object.values(REVIEWED_SOURCE_DEPENDENCIES)) Object.freeze(versions);
export const REVIEWED_BASELINE_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-whale-widget',
  'dsh-status-rotator', '@ha-na-bi/dsh-client-ui-custom', 'dsh-plugin-wallpaper-engine',
  '@dsh-external/dsh-visualize', 'dsh-drag-and-drop', 'dsh-find-plugin', 'dsh-meme',
  '@dsh-external/dsh-webui', '@local/dsh-webui-statem-bridge',
]);
const dependencyArtifacts = new Set([
  'node_modules', '.dsh-module-fallback', 'package.json', 'package-lock.json',
  'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
]);
const packagePattern = '(?:@[a-z0-9._-]+/)?[a-z0-9._-]+';
const packageRef = new RegExp(`^(${packagePattern})(/[^\\\\\\s]*)?$`);
const installedManifest = new RegExp(`(?:^|/)node_modules/${packagePattern}/package\\.json$`);
const dependencyDirectoryLink = new RegExp(`(?:^|/)node_modules/${packagePattern}$`);
type Json = Record<string, any>;
type Entry = { relative: string; kind: 'directory' | 'file' | 'link'; hash?: string; link?: string };
type Snapshot = { digest: string; userDigest: string; entries: Entry[] };
export type MigrationState = 'preparing' | 'prepare-failed' | 'prepared' | 'activating'
  | 'pending-health' | 'rolling-back' | 'rolled-back' | 'committed';
export type Checkpoint = 'preparing' | 'candidate-copied' | 'prepared' | 'activating'
  | 'source-renamed' | 'candidate-renamed' | 'pending-health' | 'rolling-back'
  | 'restore-copied' | 'active-retained' | 'original-restored' | 'rolled-back' | 'committed';
export type OfflineLease = {
  assertQuiescent: () => boolean;
  checkpoint?: (phase: Checkpoint) => void;
};
type Identity = { dev: string; ino: string };
type Journal = {
  schema: 1; sequence: number; previous: string; sourceName: string;
  target: typeof MIGRATION_TARGET; state: MigrationState;
  sourceDigest: string; sourceIdentity: Identity; userDigest: string; seedDigest: string;
  candidateDigest?: string; candidateIdentity?: Identity;
  dependencies: Record<string, string>; overrides: Json;
  bundles: string[]; references: string[];
  inheritProfile?: 'none';
  retirement?: RetirementRecord;
};
export type MigrationView = {
  transaction: string; profile: string; candidate: string; backup: string;
  retainedActive: string; state: MigrationState;
};

export class SeedMigrationError extends Error {
  readonly code: string;
  transaction?: string;
  constructor(code: string) {
    super(`SEED_MIGRATION_${code}`);
    this.name = 'SeedMigrationError';
    this.code = code;
  }
}
/** Fault-injection only: simulate termination after a durable checkpoint. */
export class MigrationInterruption extends Error {}
function reject(code: string): never { throw new SeedMigrationError(code); }
function safe<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof SeedMigrationError || error instanceof MigrationInterruption) throw error;
    return reject('IO_OR_FORMAT_ERROR');
  }
}
function lease(options: OfflineLease): void {
  if (!options || typeof options.assertQuiescent !== 'function' || options.assertQuiescent() !== true) {
    reject('QUIESCENCE_REQUIRED');
  }
}
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function plain(file: string): string {
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (exists(cursor) && fs.lstatSync(cursor).isSymbolicLink()) reject('LINKED_BOUNDARY');
  }
  return absolute;
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function distinct(a: string, b: string): void {
  if (a === b || inside(a, b) || inside(b, a)) reject('OVERLAPPING_PATHS');
}
function identity(file: string): Identity {
  const stat = fs.statSync(plain(file), { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function sameIdentity(file: string, expected?: Identity): boolean {
  return !!expected && JSON.stringify(identity(file)) === JSON.stringify(expected);
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('INVALID_MANIFEST');
  return value as Json;
}
function readJson(file: string): Json {
  const stat = fs.lstatSync(plain(file));
  if (!stat.isFile() || stat.size > 4 * 1024 ** 2) reject('INVALID_MANIFEST');
  return object(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
}
function isUser(relative: string): boolean {
  return !dependencyArtifacts.has(relative.split('/')[0]!);
}
function snapshot(root: string, allowDependencyLinks: boolean): Snapshot {
  plain(root);
  const entries: Entry[] = [];
  let bytes = 0;
  function walk(relative: string): void {
    if (entries.length >= 200000) reject('TREE_LIMIT');
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      // Old package-manager/kernel links are fingerprinted as links, never followed
      // or copied into the candidate. Nondependency links require manual review.
      if (!allowDependencyLinks || isUser(relative) || !dependencyDirectoryLink.test(relative)) reject('UNREVIEWED_LINK');
      entries.push({ relative, kind: 'link', link: fs.readlinkSync(file) });
    } else if (stat.isDirectory()) {
      entries.push({ relative, kind: 'directory' });
      for (const name of fs.readdirSync(file).sort()) walk(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 4 * 1024 ** 3 || stat.size > 128 * 1024 ** 2) reject('TREE_LIMIT');
      entries.push({ relative, kind: 'file', hash: sha(fs.readFileSync(file)) });
    } else reject('UNSUPPORTED_ENTRY');
  }
  walk('');
  return {
    digest: sha(JSON.stringify(entries)),
    userDigest: sha(JSON.stringify(entries.filter(entry => entry.relative !== '' && isUser(entry.relative)))),
    entries,
  };
}

const expressionSchema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: () => ({ __migrationExpression: true }) }),
]);
function readYaml(file: string): unknown {
  if (fs.statSync(file).size > 4 * 1024 ** 2) reject('PATCH_LIMIT');
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema: expressionSchema });
}
function referencesFromPatches(value: unknown): string[] {
  const refs = new Set<string>();
  const ancestors = new Set<object>();
  let count = 0;
  function rows(value: unknown): void {
    if (!Array.isArray(value) || ancestors.has(value)) reject('UNSUPPORTED_PATCH_GRAPH');
    ancestors.add(value);
    for (const item of value) {
      if (++count > 10000) reject('PATCH_LIMIT');
      const row = object(item);
      if (row.name !== undefined) {
        if (typeof row.name !== 'string') reject('UNSUPPORTED_PATCH_GRAPH');
        if (row.name === 'cordis:group') refs.add('@deepseek-ai/cordis-plugin-group');
        else {
          if (!packageRef.test(row.name) || row.name === LEGACY_RENDERER
              || packageRef.exec(row.name)?.[1] === '@deepseek-ai/cordis-plugin-include') reject('UNSUPPORTED_PATCH_GRAPH');
          refs.add(row.name);
        }
      }
      if (row.insert !== undefined) rows(row.insert);
      if (row.group === true || row.name === 'cordis:group'
          || row.name === '@deepseek-ai/cordis-plugin-group') rows(row.config ?? []);
      else if (row.group !== undefined && row.group !== false && row.group !== null) reject('UNSUPPORTED_PATCH_GRAPH');
      // An array-valued config on an id-only row may modify an inherited group.
      else if (row.name === undefined && Array.isArray(row.config)) rows(row.config);
    }
    ancestors.delete(value);
  }
  rows(value ?? []);
  return [...refs].sort();
}
function sourceReferences(source: string): string[] {
  const refs = new Set<string>();
  for (const name of ['cordis.yml', 'cordis.patch.yml']) {
    if (exists(path.join(source, name))) {
      for (const ref of referencesFromPatches(readYaml(path.join(source, name)))) refs.add(ref);
    }
  }
  return [...refs].sort();
}

function patchBytes(source: string, file: PatchFile): Buffer {
  const target = plain(path.join(source, file));
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size > 4 * 1024 ** 2) reject('PATCH_LIMIT');
  return fs.readFileSync(target);
}

function retirementProjection(source: string, seed: string, seedDigest: string,
  policy?: ApprovedRetirementPolicy): { files: Map<PatchFile, Buffer>; record?: RetirementRecord; references: string[] } {
  const files = new Map<PatchFile, Buffer>();
  if (policy === undefined) return { files, references: sourceReferences(source) };
  const invalid = (): never => reject('INVALID_RETIREMENT_POLICY');
  const exactKeys = (value: Json, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));
  if (!exactKeys(object(policy), ['seedDigest', 'patches']) || policy.seedDigest !== seedDigest
      || !Array.isArray(policy.patches) || !policy.patches.length || policy.patches.length > 2) invalid();
  const usedFiles = new Set<string>();
  const usedIds = new Set<string>();
  const approved: ApprovedRetirementPolicy = { seedDigest, patches: [] };
  for (const patch of policy.patches) {
    if (!exactKeys(object(patch), ['file', 'originalSha256', 'rows'])
        || !['cordis.yml', 'cordis.patch.yml'].includes(patch.file) || usedFiles.has(patch.file)
        || !/^[a-f0-9]{64}$/.test(patch.originalSha256) || !Array.isArray(patch.rows)
        || !patch.rows.length || patch.rows.length > 32) invalid();
    usedFiles.add(patch.file);
    const rows: ApprovedRetirementPolicy['patches'][number]['rows'] = [];
    for (const row of patch.rows) {
      if (!exactKeys(object(row), ['package', 'id', 'allowEnabled'])
          || !APPROVED_RETIREMENT_PACKAGES.includes(row.package)
          || typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(row.id)
          || usedIds.has(row.id) || (row.allowEnabled !== undefined && typeof row.allowEnabled !== 'boolean')
          || (row.allowEnabled === true && !APPROVED_ENABLED_RETIREMENTS.has(row.package))) invalid();
      // Retirement is not a way to disable a package still present in this seed.
      if (exists(path.join(seed, 'node_modules', row.package))) reject('RETIRED_PACKAGE_PRESENT');
      usedIds.add(row.id);
      rows.push({ package: row.package, id: row.id, ...(row.allowEnabled === undefined ? {} : { allowEnabled: row.allowEnabled }) });
    }
    approved.patches.push({ file: patch.file, originalSha256: patch.originalSha256, rows });
  }

  const documents = new Map<PatchFile, unknown>();
  const idCounts = new Map<string, number>();
  function countIds(value: unknown): void {
    for (const item of value as Json[]) {
      const row = object(item);
      if (!exactKeys(row, ['id', 'name', 'disabled', 'config', 'insert', 'group'])
          || (row.disabled !== undefined && typeof row.disabled !== 'boolean')) reject('AMBIGUOUS_RETIREMENT');
      if (row.id !== undefined) {
        if (typeof row.id !== 'string') reject('AMBIGUOUS_RETIREMENT');
        idCounts.set(row.id, (idCounts.get(row.id) || 0) + 1);
      }
      if (row.insert !== undefined) countIds(row.insert);
      if (row.group === true || row.name === 'cordis:group' || row.name === '@deepseek-ai/cordis-plugin-group'
          || (row.name === undefined && Array.isArray(row.config))) countIds(row.config ?? []);
    }
  }
  for (const file of ['cordis.yml', 'cordis.patch.yml'] as PatchFile[]) {
    if (!exists(path.join(source, file))) continue;
    const document = readYaml(path.join(source, file)) ?? [];
    referencesFromPatches(document); // Validate dynamic/include/group references before considering retirement.
    countIds(document);
    documents.set(file, document);
  }
  for (const id of usedIds) if (idCounts.get(id) !== 1) reject('AMBIGUOUS_RETIREMENT');
  const record: RetirementRecord = { policy: approved, patches: [] };
  for (const patch of approved.patches) {
    const original = patchBytes(source, patch.file);
    if (sha(original) !== patch.originalSha256) reject('RETIREMENT_PATCH_CHANGED');
    const text = original.toString('utf8');
    if (!Buffer.from(text).equals(original)) reject('AMBIGUOUS_RETIREMENT');
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = text.slice(bom.length);
    const parsed = yaml.load(body, {
      schema: expressionSchema,
      listener: (_event: string, state: Json) => {
        if (state.anchor || Object.keys(state.anchorMap || {}).length
            || state.tag === 'tag:yaml.org,2002:merge') reject('AMBIGUOUS_RETIREMENT');
      },
    });
    // Intentionally support only ordinary root block-sequence rows. Flow style,
    // directives, shared anchors, nested/multiple insertions require manual review.
    const starts = [...body.matchAll(/^-(?:[ \t]|\r?$)/gm)].map(match => match.index!);
    const prefix = body.slice(0, starts[0] ?? body.length);
    if (!Array.isArray(parsed) || starts.length !== parsed.length
        || prefix.split(/\r?\n/).some(line => line.trim() && !line.trimStart().startsWith('#'))) {
      reject('AMBIGUOUS_RETIREMENT');
    }
    const remaining = [];
    const seen = new Set<string>();
    let projected = prefix;
    for (let i = 0; i < starts.length; i++) {
      const block = body.slice(starts[i], starts[i + 1] ?? body.length);
      const item = object(parsed[i]);
      const blockValue = yaml.load(block, { schema: expressionSchema });
      if (JSON.stringify(blockValue) !== JSON.stringify([item])) reject('AMBIGUOUS_RETIREMENT');
      let row = item;
      if (Object.keys(item).length === 1 && Array.isArray(item.insert) && item.insert.length === 1) {
        row = object(item.insert[0]);
      }
      const consent = patch.rows.find(entry => entry.id === row.id && entry.package === row.name);
      if (!consent) {
        remaining.push(item);
        projected += block;
        continue;
      }
      if (!exactKeys(row, ['id', 'name', 'disabled', 'config'])
          || (row.disabled !== undefined && typeof row.disabled !== 'boolean')
          || (row.disabled !== true && consent.allowEnabled !== true)) reject('AMBIGUOUS_RETIREMENT');
      seen.add(consent.id);
      // Comment out only the reviewed block. Retain its text locally as inert
      // configuration, and archive the exact original file separately before copying.
      projected += block.replace(/^[^\r\n]+/gm, line =>
        !line.trim() || line.trimStart().startsWith('#') ? line : `# ${line}`);
    }
    if (seen.size !== patch.rows.length) reject('AMBIGUOUS_RETIREMENT');
    const newline = body.includes('\r\n') ? '\r\n' : '\n';
    if (!remaining.length) projected += `${projected.endsWith('\n') ? '' : newline}[]${newline}`;
    if (JSON.stringify(yaml.load(projected, { schema: expressionSchema })) !== JSON.stringify(remaining)) {
      reject('AMBIGUOUS_RETIREMENT');
    }
    const bytes = Buffer.from(bom + projected);
    files.set(patch.file, bytes);
    documents.set(patch.file, remaining);
    record.patches.push({ file: patch.file, originalSha256: sha(original), projectedSha256: sha(bytes) });
  }
  return { files, record, references: [...new Set([...documents.values()].flatMap(referencesFromPatches))].sort() };
}

function verifyRetirementArchive(transaction: string, record?: RetirementRecord): void {
  if (!record) return;
  if (!Array.isArray(record.patches) || !record.patches.length || record.patches.length > 2) reject('INVALID_JOURNAL');
  for (const patch of record.patches) {
    if (!['cordis.yml', 'cordis.patch.yml'].includes(patch.file)
        || !/^[a-f0-9]{64}$/.test(patch.originalSha256)
        || !/^[a-f0-9]{64}$/.test(patch.projectedSha256)) reject('INVALID_JOURNAL');
    if (sha(patchBytes(path.join(transaction, 'retirement-originals'), patch.file)) !== patch.originalSha256) {
      reject('RETIREMENT_ARCHIVE_CHANGED');
    }
  }
}

function resolvePackage(root: string, reference: string, anchor = root): { directory: string; manifest: Json; subpath: string } {
  const match = packageRef.exec(reference);
  if (!match || reference.split('/').some(part => part === '..' || part === '.')) return reject('UNRESOLVED_REFERENCE');
  const name = match[1]!;
  let cursor = anchor;
  while (cursor === root || inside(root, cursor)) {
    const directory = path.join(cursor, 'node_modules', name);
    if (exists(path.join(directory, 'package.json'))) {
      plain(directory);
      const manifest = readJson(path.join(directory, 'package.json'));
      if (manifest.name !== name) reject('PACKAGE_IDENTITY');
      return { directory, manifest, subpath: match[2] ? `.${match[2]}` : '.' };
    }
    cursor = path.dirname(cursor);
  }
  return reject('UNRESOLVED_REFERENCE');
}
function regularWithin(root: string, target: string): void {
  const file = plain(path.resolve(root, target));
  if (!inside(root, file) || !fs.statSync(file).isFile()) reject('UNRESOLVED_REFERENCE');
}
function verifyEntry(root: string, reference: string, anchor = root): void {
  const { directory, manifest, subpath } = resolvePackage(root, reference, anchor);
  if (manifest.exports !== undefined) {
    const targets = exportsResolver.resolve(manifest, subpath, { conditions: ['node', 'import'] });
    if (!Array.isArray(targets) || !targets.length) reject('UNRESOLVED_REFERENCE');
    for (const target of targets) regularWithin(directory, target);
  } else {
    const resolved = createRequire(path.join(anchor, 'package.json')).resolve(reference);
    regularWithin(directory, path.relative(directory, resolved));
  }
}
function verifyProjection(root: string, expected: Pick<Journal, 'dependencies' | 'overrides' | 'bundles' | 'references'>): void {
  const tree = snapshot(root, false);
  for (const [name, version] of Object.entries(expected.dependencies)) {
    const { manifest } = resolvePackage(root, name);
    if (manifest.version !== version) reject('TARGET_VERSION');
  }
  for (const entry of tree.entries) {
    if (entry.kind !== 'file' || !installedManifest.test(entry.relative)) continue;
    const manifest = readJson(path.join(root, entry.relative));
    const pinned = expected.overrides[manifest.name];
    if (typeof pinned === 'string' && pinned === MIGRATION_TARGET.kernel && manifest.version !== pinned) {
      reject('TARGET_VERSION');
    }
  }
  for (const reference of expected.references) verifyEntry(root, reference);
  for (const bundle of expected.bundles) {
    const { directory, manifest } = resolvePackage(root, bundle);
    const patch = manifest.dsh?.bundle?.patch;
    if (typeof patch !== 'string') reject('UNRESOLVED_BUNDLE');
    regularWithin(directory, patch);
    for (const reference of referencesFromPatches(readYaml(path.resolve(directory, patch)))) {
      verifyEntry(root, reference, directory);
    }
  }
}
function seedManifest(seed: string): Json {
  const manifest = readJson(path.join(seed, 'package.json'));
  const deps = object(manifest.dependencies);
  for (const [name, version] of Object.entries(deps)) {
    if (!new RegExp(`^${packagePattern}$`).test(name) || typeof version !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) reject('UNREVIEWED_SEED');
  }
  if (deps['@deepseek-ai/dsh'] !== MIGRATION_TARGET.kernel || deps[RENDERER] !== MIGRATION_TARGET.kernel
      || deps[COMPAT] !== '1.0.0' || Object.hasOwn(deps, LEGACY_RENDERER)) reject('UNREVIEWED_SEED');
  return manifest;
}
/** Read-only digest; it is a review binding, not an assertion of native/boot health. */
export function inspectMigrationSeed(seedProfile: string, verifyReferences = false): { digest: string; target: typeof MIGRATION_TARGET } {
  return safe(() => {
    const seed = plain(seedProfile);
    const manifest = seedManifest(seed);
    if (verifyReferences) {
      verifyProjection(seed, { dependencies: manifest.dependencies, overrides: manifest.overrides || {},
        bundles: manifest.dsh?.profile?.bundles || [], references: sourceReferences(seed) });
    }
    return { digest: snapshot(seed, false).digest, target: MIGRATION_TARGET };
  });
}
function mergeManifest(source: Json, seed: Json): Json {
  const dependencies = object(source.dependencies);
  const normalized = { ...dependencies };
  if (Object.hasOwn(normalized, RENDERER)) {
    if (Object.hasOwn(normalized, LEGACY_RENDERER)) reject('UNKNOWN_SOURCE_GRAPH');
    normalized[LEGACY_RENDERER] = normalized[RENDERER];
    delete normalized[RENDERER];
  }
  if (Object.keys(normalized).length !== 16) reject('UNKNOWN_SOURCE_GRAPH');
  for (const [name, versions] of Object.entries(REVIEWED_SOURCE_DEPENDENCIES)) {
    if (!versions.includes(normalized[name])) reject('UNKNOWN_SOURCE_GRAPH');
  }
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces',
    'resolutions', 'bundledDependencies', 'bundleDependencies', 'pnpm']) {
    if (source[field] && Object.keys(source[field]).length) reject('UNKNOWN_SOURCE_GRAPH');
  }
  for (const name of Object.keys(source.overrides || {})) {
    if (!Object.hasOwn(seed.overrides || {}, name) && !Object.hasOwn(normalized, name)) reject('UNKNOWN_SOURCE_GRAPH');
  }
  const dsh = object(source.dsh);
  const profile = object(dsh.profile);
  const bundles = profile.bundles;
  if (!Array.isArray(bundles) || bundles.length !== 12 || new Set(bundles).size !== 12
      || bundles.some(name => !REVIEWED_BASELINE_BUNDLES.includes(name))) reject('UNKNOWN_SOURCE_GRAPH');
  return {
    ...source, dependencies: { ...seed.dependencies }, overrides: { ...(seed.overrides || {}) },
    dsh: { ...dsh, profile: { ...profile, bundles: [...bundles, COMPAT] } },
  };
}

function paths(transaction: string, sourceName: string): Omit<MigrationView, 'state'> {
  const tx = plain(transaction);
  if (!sourceName || sourceName === '.' || sourceName === '..' || /[\\/:]/.test(sourceName)
      || !path.basename(tx).startsWith(`.${sourceName}-seed-migration-`)
      || !/^[0-9a-f-]{36}$/.test(path.basename(tx).slice(`.${sourceName}-seed-migration-`.length))) {
    reject('INVALID_JOURNAL');
  }
  const profile = plain(path.join(path.dirname(tx), sourceName));
  const candidate = plain(path.join(tx, 'candidate'));
  const backup = plain(path.join(tx, 'backup'));
  const retainedActive = plain(path.join(tx, 'retained-active'));
  const parentDevice = identity(path.dirname(tx)).dev;
  if (identity(tx).dev !== parentDevice) reject('CROSS_VOLUME');
  for (const directory of [profile, candidate, backup, retainedActive]) {
    if (exists(directory) && identity(directory).dev !== parentDevice) reject('CROSS_VOLUME');
  }
  return { transaction: tx, profile, candidate, backup, retainedActive };
}
const states: MigrationState[] = ['preparing', 'prepare-failed', 'prepared', 'activating',
  'pending-health', 'rolling-back', 'rolled-back', 'committed'];
function readJournal(transaction: string): Journal {
  const tx = plain(transaction);
  const files = fs.readdirSync(tx).filter(name => /^journal-\d{6}\.json$/.test(name)).sort();
  if (!files.length || files.length > 1000) return reject('INVALID_JOURNAL');
  let previous = '';
  let last: Journal | undefined;
  for (const name of files) {
    const value = readJson(path.join(tx, name)) as Journal;
    if (value.schema !== 1 || value.previous !== previous || !states.includes(value.state)
        || JSON.stringify(value.target) !== JSON.stringify(MIGRATION_TARGET)
        || name !== `journal-${String(value.sequence).padStart(6, '0')}.json`
        || !/^[a-f0-9]{64}$/.test(value.sourceDigest) || !/^[a-f0-9]{64}$/.test(value.seedDigest)
        || (value.retirement !== undefined && (value.retirement?.policy?.seedDigest !== value.seedDigest
          || !Array.isArray(value.retirement.patches) || !Array.isArray(value.retirement.policy.patches)
          || value.retirement.patches.length !== value.retirement.policy.patches.length
          || value.retirement.patches.some((patch, index) =>
            patch.file !== value.retirement!.policy.patches[index]?.file
            || patch.originalSha256 !== value.retirement!.policy.patches[index]?.originalSha256)))
        || (value.inheritProfile !== undefined && value.inheritProfile !== 'none')
        || (last && ['sourceName', 'sourceDigest', 'sourceIdentity', 'userDigest', 'seedDigest',
          'dependencies', 'overrides', 'bundles', 'references', 'inheritProfile', 'retirement'].some(key =>
          JSON.stringify((last as unknown as Json)[key]) !== JSON.stringify((value as unknown as Json)[key])))
        || (last?.candidateDigest && (last.candidateDigest !== value.candidateDigest
          || JSON.stringify(last.candidateIdentity) !== JSON.stringify(value.candidateIdentity)))) reject('INVALID_JOURNAL');
    paths(tx, value.sourceName);
    previous = sha(fs.readFileSync(path.join(tx, name)));
    last = value;
  }
  return last!;
}
function writeJournal(transaction: string, value: Journal): Journal {
  const tx = plain(transaction);
  const occupied = fs.readdirSync(tx).map(name => /^journal-(\d{6})\.(?:json|tmp)$/.exec(name))
    .filter((match): match is RegExpExecArray => !!match).map(match => Number(match[1]));
  const completed = fs.readdirSync(tx).filter(name => /^journal-\d{6}\.json$/.test(name)).sort();
  const sequence = occupied.length ? Math.max(...occupied) + 1 : 0;
  if (sequence >= 1000) reject('JOURNAL_LIMIT');
  const previous = completed.length ? sha(fs.readFileSync(path.join(tx, completed.at(-1)!))) : '';
  const record = { ...value, sequence, previous };
  const base = path.join(tx, `journal-${String(sequence).padStart(6, '0')}`);
  const fd = fs.openSync(`${base}.tmp`, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(`${base}.tmp`, `${base}.json`);
  return record;
}
function mark(transaction: string, journal: Journal, state: MigrationState, options: OfflineLease): Journal {
  lease(options);
  const next = writeJournal(transaction, { ...journal, state });
  options.checkpoint?.(state as Checkpoint);
  return next;
}
function view(transaction: string, journal: Journal): MigrationView {
  return { ...paths(transaction, journal.sourceName), state: journal.state };
}
function copyUserFiles(source: string, candidate: string, tree: Snapshot): void {
  for (const entry of tree.entries) {
    if (!entry.relative || !isUser(entry.relative)) continue;
    const target = path.join(candidate, entry.relative);
    if (entry.kind === 'directory') fs.mkdirSync(target, { recursive: true });
    else if (entry.kind === 'file') fs.copyFileSync(path.join(source, entry.relative), target, fs.constants.COPYFILE_EXCL);
    else reject('UNREVIEWED_LINK');
  }
}

function copyOriginalBackup(backup: string, restore: string): void {
  // fs.cp can change Windows junctions into a different link representation.
  // Recreate only the package-directory links accepted by snapshot, without
  // following their targets (including unavailable old package-manager stores).
  for (const entry of snapshot(backup, true).entries) {
    const target = path.join(restore, entry.relative);
    if (entry.kind === 'directory') fs.mkdirSync(target, { recursive: true });
    else if (entry.kind === 'file') fs.copyFileSync(path.join(backup, entry.relative), target, fs.constants.COPYFILE_EXCL);
    else fs.symlinkSync(entry.link!, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function moveToEmpty(source: string, destination: string, options: OfflineLease): void {
  lease(options);
  plain(source);
  plain(destination);
  if (exists(destination)) reject('RECOVERY_CONFLICT');
  if (identity(source).dev !== identity(path.dirname(destination)).dev) reject('CROSS_VOLUME');
  // The caller-held exclusive lease closes the check/rename race. Never use
  // rename's platform-dependent overwrite behavior to discard another entry.
  fs.renameSync(source, destination);
}

export function prepareSeedMigration(options: OfflineLease & {
  sourceProfile: string; seedProfile: string; reviewedSeedDigest: string;
  inheritProfile?: 'none';
  retirementPolicy?: ApprovedRetirementPolicy;
}): MigrationView {
  return safe(() => {
    lease(options);
    const source = plain(options.sourceProfile);
    const seed = plain(options.seedProfile);
    distinct(source, seed);
    if (identity(source).dev !== identity(path.dirname(source)).dev) reject('CROSS_VOLUME');
    const sourceIdentity = identity(source);
    const original = snapshot(source, true);
    const seedTree = snapshot(seed, false);
    if (options.reviewedSeedDigest !== seedTree.digest) reject('SEED_REVIEW_MISMATCH');
    const targetManifest = seedManifest(seed);
    const replaceProfile = options.inheritProfile === 'none';
    if (replaceProfile && options.retirementPolicy !== undefined) reject('INVALID_RETIREMENT_POLICY');
    const manifest = replaceProfile
      ? targetManifest
      : mergeManifest(readJson(path.join(source, 'package.json')), targetManifest);
    if (!replaceProfile && exists(path.join(source, 'pnpm-workspace.yaml'))) {
      const workspace = object(readYaml(path.join(source, 'pnpm-workspace.yaml')));
      if (workspace.packages && JSON.stringify(workspace.packages) !== JSON.stringify(['.'])) reject('UNKNOWN_SOURCE_GRAPH');
      if (workspace.overrides || workspace.catalog || workspace.catalogs) reject('UNKNOWN_SOURCE_GRAPH');
    }
    const retirement = replaceProfile
      ? { files: new Map<PatchFile, Buffer>(), references: sourceReferences(seed) }
      : retirementProjection(source, seed, seedTree.digest, options.retirementPolicy);
    const references = retirement.references;
    const expected = { dependencies: manifest.dependencies, overrides: manifest.overrides,
      bundles: manifest.dsh.profile.bundles, references };
    verifyProjection(seed, expected);
    lease(options);
    if (!sameIdentity(source, sourceIdentity) || snapshot(source, true).digest !== original.digest) reject('SOURCE_CHANGED');
    const transaction = path.join(path.dirname(source), `.${path.basename(source)}-seed-migration-${randomUUID()}`);
    fs.mkdirSync(transaction, { mode: 0o700 });
    let journal: Journal = {
      schema: 1, sequence: 0, previous: '', sourceName: path.basename(source), target: MIGRATION_TARGET,
      state: 'preparing', sourceDigest: original.digest, sourceIdentity, userDigest: original.userDigest,
      seedDigest: seedTree.digest, ...expected,
      ...(replaceProfile ? { inheritProfile: 'none' as const } : {}),
      ...(retirement.record ? { retirement: retirement.record } : {}),
    };
    try {
      journal = mark(transaction, journal, 'preparing', options);
      if (retirement.record) {
        const archive = path.join(transaction, 'retirement-originals');
        fs.mkdirSync(archive, { mode: 0o700 });
        for (const patch of retirement.record.patches) {
          fs.copyFileSync(path.join(source, patch.file), path.join(archive, patch.file), fs.constants.COPYFILE_EXCL);
        }
        verifyRetirementArchive(transaction, retirement.record);
      }
      const { candidate } = paths(transaction, journal.sourceName);
      if (replaceProfile) {
        fs.cpSync(seed, candidate,
          { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
      } else {
        fs.mkdirSync(candidate);
        fs.cpSync(path.join(seed, 'node_modules'), path.join(candidate, 'node_modules'),
          { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
        copyUserFiles(source, candidate, original);
        for (const [file, bytes] of retirement.files) fs.writeFileSync(path.join(candidate, file), bytes);
        const oldText = fs.readFileSync(path.join(source, 'package.json'), 'utf8');
        let text = `${JSON.stringify(manifest, null, 2)}\n`;
        if (oldText.includes('\r\n')) text = text.replaceAll('\n', '\r\n');
        if (oldText.startsWith('\uFEFF')) text = `\uFEFF${text}`;
        fs.writeFileSync(path.join(candidate, 'package.json'), text, { flag: 'wx' });
      }
      options.checkpoint?.('candidate-copied');
      verifyProjection(candidate, expected);
      const ready = snapshot(candidate, false);
      if (replaceProfile) {
        if (ready.digest !== seedTree.digest) reject('SEED_CHANGED');
      } else {
        const projectedUserDigest = sha(JSON.stringify(original.entries
          .filter(entry => entry.relative !== '' && isUser(entry.relative))
          .map(entry => retirement.files.has(entry.relative as PatchFile)
            ? { ...entry, hash: sha(retirement.files.get(entry.relative as PatchFile)!) } : entry)));
        if (ready.userDigest !== projectedUserDigest) reject('USER_FILES_CHANGED');
      }
      verifyRetirementArchive(transaction, retirement.record);
      if (!sameIdentity(source, sourceIdentity) || snapshot(source, true).digest !== original.digest) reject('SOURCE_CHANGED');
      if (snapshot(seed, false).digest !== seedTree.digest) reject('SEED_CHANGED');
      journal = mark(transaction, { ...journal, candidateDigest: ready.digest, candidateIdentity: identity(candidate) }, 'prepared', options);
      return view(transaction, journal);
    } catch (error) {
      if (error instanceof MigrationInterruption) throw error;
      try { writeJournal(transaction, { ...journal, state: 'prepare-failed' }); } catch { /* retain all artifacts */ }
      const diagnostic = error instanceof SeedMigrationError ? error : new SeedMigrationError('PREPARE_FAILED');
      diagnostic.transaction = transaction;
      throw diagnostic;
    }
  });
}

function restoreOriginal(transaction: string, journal: Journal, options: OfflineLease): Journal {
  const p = paths(transaction, journal.sourceName);
  if (!exists(p.backup)) {
    if (!exists(p.profile) || snapshot(p.profile, true).digest !== journal.sourceDigest) reject('RECOVERY_CONFLICT');
    return mark(transaction, journal, 'rolled-back', options);
  }
  if (snapshot(p.backup, true).digest !== journal.sourceDigest) reject('BACKUP_CHANGED');
  journal = mark(transaction, journal, 'rolling-back', options);
  // If restoration already completed before its final journal write, do nothing.
  if (exists(p.profile) && snapshot(p.profile, true).digest === journal.sourceDigest) {
    return mark(transaction, journal, 'rolled-back', options);
  }
  if (exists(p.profile) && !sameIdentity(p.profile, journal.candidateIdentity)) reject('ACTIVE_REPLACED');
  const restore = plain(path.join(transaction, 'restore'));
  if (exists(restore) && snapshot(restore, true).digest !== journal.sourceDigest) {
    moveToEmpty(restore, path.join(transaction, `incomplete-restore-${randomUUID()}`), options);
  }
  if (!exists(restore)) {
    lease(options);
    copyOriginalBackup(p.backup, restore);
  }
  if (snapshot(restore, true).digest !== journal.sourceDigest) reject('RESTORE_CHANGED');
  options.checkpoint?.('restore-copied');
  if (exists(p.profile)) {
    if (exists(p.retainedActive)) reject('RECOVERY_CONFLICT');
    moveToEmpty(p.profile, p.retainedActive, options);
    options.checkpoint?.('active-retained');
  }
  moveToEmpty(restore, p.profile, options);
  options.checkpoint?.('original-restored');
  return mark(transaction, journal, 'rolled-back', options);
}

export function activateSeedMigration(transaction: string, options: OfflineLease): MigrationView {
  return safe(() => {
    lease(options);
    let journal = readJournal(transaction);
    const p = paths(transaction, journal.sourceName);
    if (journal.state === 'pending-health') {
      if (!sameIdentity(p.profile, journal.candidateIdentity)) reject('ACTIVE_REPLACED');
      return view(transaction, journal);
    }
    if (journal.state !== 'prepared') reject('NOT_PREPARED');
    verifyRetirementArchive(transaction, journal.retirement);
    if (!sameIdentity(p.profile, journal.sourceIdentity) || snapshot(p.profile, true).digest !== journal.sourceDigest) reject('SOURCE_CHANGED');
    if (!sameIdentity(p.candidate, journal.candidateIdentity)
      || snapshot(p.candidate, false).digest !== journal.candidateDigest) reject('CANDIDATE_CHANGED');
    if (exists(p.backup) || exists(p.retainedActive)) reject('RECOVERY_CONFLICT');
    try {
      journal = mark(transaction, journal, 'activating', options);
      lease(options);
      if (!sameIdentity(p.profile, journal.sourceIdentity) || snapshot(p.profile, true).digest !== journal.sourceDigest) reject('SOURCE_CHANGED');
      moveToEmpty(p.profile, p.backup, options);
      options.checkpoint?.('source-renamed');
      lease(options);
      if (!sameIdentity(p.candidate, journal.candidateIdentity)
          || snapshot(p.candidate, false).digest !== journal.candidateDigest) reject('CANDIDATE_CHANGED');
      moveToEmpty(p.candidate, p.profile, options);
      options.checkpoint?.('candidate-renamed');
      journal = mark(transaction, journal, 'pending-health', options);
      return view(transaction, journal);
    } catch (error) {
      if (error instanceof MigrationInterruption) throw error;
      if (!exists(p.backup) && error instanceof SeedMigrationError && error.code === 'SOURCE_CHANGED') {
        writeJournal(transaction, { ...journal, state: 'prepare-failed' });
        throw error;
      }
      // Never call caller's fault hook during compensating rollback.
      try { restoreOriginal(transaction, readJournal(transaction), { assertQuiescent: options.assertQuiescent }); }
      catch { reject('RECOVERY_REQUIRED'); }
      throw new SeedMigrationError('ACTIVATION_ROLLED_BACK');
    }
  });
}

export function rollbackSeedMigration(transaction: string, options: OfflineLease): MigrationView {
  return safe(() => {
    lease(options);
    const journal = readJournal(transaction);
    if (journal.state === 'rolled-back') return view(transaction, journal);
    if (!['activating', 'pending-health', 'rolling-back', 'committed'].includes(journal.state)) reject('NOT_ROLLBACKABLE');
    return view(transaction, restoreOriginal(transaction, journal, options));
  });
}

export function recoverSeedMigration(transaction: string, options: OfflineLease): MigrationView {
  return safe(() => {
    lease(options);
    let journal = readJournal(transaction);
    if (journal.state === 'activating' || journal.state === 'rolling-back') {
      journal = restoreOriginal(transaction, journal, options);
    } else if (journal.state === 'preparing') {
      const p = paths(transaction, journal.sourceName);
      if (snapshot(p.profile, true).digest !== journal.sourceDigest) reject('SOURCE_CHANGED');
      journal = mark(transaction, journal, 'prepare-failed', options);
    }
    return view(transaction, journal);
  });
}

export function commitSeedMigration(transaction: string, options: OfflineLease & {
  validateBoot: (profile: string, target: typeof MIGRATION_TARGET) => boolean;
}): MigrationView {
  return safe(() => {
    lease(options);
    let journal = readJournal(transaction);
    if (journal.state === 'committed') return view(transaction, journal);
    if (journal.state !== 'pending-health') reject('HEALTH_NOT_PENDING');
    verifyRetirementArchive(transaction, journal.retirement);
    const p = paths(transaction, journal.sourceName);
    if (!sameIdentity(p.profile, journal.candidateIdentity)) reject('ACTIVE_REPLACED');
    if (snapshot(p.backup, true).digest !== journal.sourceDigest) reject('BACKUP_CHANGED');
    // A desktop boot can replace official shadow copies with the installation
    // fallback. The caller must verify that running graph and native/boot health;
    // this API verifies retained manifest pins, identity and immutable backup.
    const manifest = readJson(path.join(p.profile, 'package.json'));
    if (JSON.stringify(manifest.dependencies) !== JSON.stringify(journal.dependencies)
        || JSON.stringify(manifest.overrides) !== JSON.stringify(journal.overrides)
        || JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify(journal.bundles)) reject('TARGET_VERSION');
    if (typeof options.validateBoot !== 'function' || options.validateBoot(p.profile, MIGRATION_TARGET) !== true) {
      reject('BOOT_NOT_VALIDATED');
    }
    journal = mark(transaction, journal, 'committed', options);
    return view(transaction, journal);
  });
}

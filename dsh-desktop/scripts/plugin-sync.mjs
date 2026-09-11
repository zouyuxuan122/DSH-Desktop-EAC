#!/usr/bin/env node

/*
 * Manifest/lock validation and auditable plugin synchronization for the bundled
 * plugin tree.  Source acquisition is isolated from candidate validation and
 * promotion; every promotion updates the plugin tree, manifest, registry, and
 * lock as one recoverable local transaction.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const FORBIDDEN_NAMES = new Set(['node_modules', 'vendor', 'cache']);
const IGNORED_TREE_NAMES = new Set(['.git', ...FORBIDDEN_NAMES]);
const HEX_256 = /^[0-9a-f]{64}$/;

const INVENTORY_ROOTS = [
  { kind: 'plugin', manifestKey: 'plugins', relative: 'dsh-desktop/assets/plugins' },
  { kind: 'skin', manifestKey: 'skins', relative: 'dsh-desktop/assets/skins' },
  { kind: 'sdk-plugin', manifestKey: 'sdkPlugins', relative: 'dsh-desktop/assets/sdk-plugins' },
];
const ALLOWED_CLASSES = new Set([
  'follow-upstream',
  'patched',
  'internal',
  'manual',
  'resource',
  'isolated-sdk',
]);
const ALLOWED_SYNC_MODES = new Set(['mirror', 'patch-rebase', 'metadata-only', 'manual']);
const ALLOWED_SOURCE_KINDS = new Set(['npm', 'github', 'internal', 'unknown']);
const ALLOWED_RUNTIME_SOURCE_KINDS = new Set(['npm', 'github']);

export class PluginSyncError extends Error {
  constructor(message, code = 'validation') {
    super(message);
    this.name = 'PluginSyncError';
    this.code = code;
  }
}

class ValidationFailure extends PluginSyncError {
  constructor(errors) {
    super(errors.join('\n'), 'validation');
    this.errors = errors;
  }
}

function fail(message, code = 'validation') {
  throw new PluginSyncError(message, code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSlashes(value) {
  return String(value).replaceAll('\\', '/');
}

function relativePosix(from, to) {
  return normalizeSlashes(path.relative(from, to));
}

function isSafeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) return false;
  const normalized = normalizeSlashes(value);
  const segments = normalized.split('/');
  return normalized !== '..'
    && !normalized.startsWith('../')
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.startsWith('//')
    && !segments.some((segment) => segment === '..')
    && !normalized.includes('\0');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function prettyJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'));
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function sortedDirEntries(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => byteCompare(a.name, b.name));
}

function collectTreeFiles(directory) {
  const files = [];
  const excluded = [];
  const root = path.resolve(directory);

  function visit(current, relativeDirectory) {
    for (const entry of sortedDirEntries(current)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (IGNORED_TREE_NAMES.has(entry.name)) {
        excluded.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({ absolutePath, relativePath: normalizeSlashes(relativePath), type: 'file' });
      } else if (entry.isSymbolicLink()) {
        // Hash the link itself rather than following it.  A link cannot smuggle
        // outside bytes into an otherwise local, reproducible tree digest.
        files.push({
          absolutePath,
          relativePath: normalizeSlashes(relativePath),
          type: 'symlink',
          target: readlinkSync(absolutePath),
        });
      } else {
        fail(`unsupported filesystem entry in plugin tree: ${relativePath}`);
      }
    }
  }

  if (!existsSync(root) || !lstatSync(root).isDirectory()) fail(`plugin tree is not a directory: ${directory}`);
  visit(root, '');
  files.sort((a, b) => byteCompare(a.relativePath, b.relativePath));
  excluded.sort(byteCompare);
  return { files, excluded };
}

/**
 * Hash included file paths and bytes.  mtime, mode and directory mtimes are
 * intentionally absent so a checkout on another filesystem has the same hash.
 */
export function treeSha256(directory) {
  const digest = createHash('sha256');
  for (const file of collectTreeFiles(directory).files) {
    digest.update(Buffer.from(`file\0${file.relativePath}\0`, 'utf8'));
    if (file.type === 'symlink') digest.update(Buffer.from(`symlink:${file.target}`, 'utf8'));
    else digest.update(readFileSync(file.absolutePath));
    digest.update(Buffer.from('\0', 'utf8'));
  }
  return digest.digest('hex');
}

export function treeSnapshot(directory) {
  const result = collectTreeFiles(directory);
  const digest = createHash('sha256');
  for (const file of result.files) {
    digest.update(Buffer.from(`file\0${file.relativePath}\0`, 'utf8'));
    if (file.type === 'symlink') digest.update(Buffer.from(`symlink:${file.target}`, 'utf8'));
    else digest.update(readFileSync(file.absolutePath));
    digest.update(Buffer.from('\0', 'utf8'));
  }
  return {
    treeSha256: digest.digest('hex'),
    files: result.files.map((file) => file.relativePath),
    excludedPaths: result.excluded,
  };
}

function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function allFilesUnder(root) {
  const output = [];
  function visit(current, relativeDirectory) {
    for (const entry of sortedDirEntries(current)) {
      if (IGNORED_TREE_NAMES.has(entry.name)) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) output.push({ absolutePath, relativePath: normalizeSlashes(relativePath) });
    }
  }
  if (existsSync(root) && lstatSync(root).isDirectory()) visit(root, '');
  output.sort((a, b) => byteCompare(a.relativePath, b.relativePath));
  return output;
}

function resolvePatchMatches(root, declaredPath) {
  if (!isSafeRelative(declaredPath)) fail(`unsafe patch path: ${declaredPath}`);
  const pattern = normalizeSlashes(declaredPath);
  const candidates = allFilesUnder(root);
  const regex = globToRegExp(pattern);
  const matches = candidates.filter((candidate) => regex.test(candidate.relativePath));
  if (matches.length === 0 && !pattern.includes('*') && !pattern.includes('?')) {
    const absolute = path.resolve(root, pattern);
    if (existsSync(absolute) && lstatSync(absolute).isFile()) {
      return [{ absolutePath: absolute, relativePath: pattern }];
    }
  }
  if (matches.length === 0) fail(`declared patch file does not exist: ${declaredPath}`);
  return matches;
}

/** Hash the declared patch set, including sorted paths and bytes. */
export function patchSetSha256(root, patches = []) {
  if (!Array.isArray(patches)) fail('patch set must be an array');
  const resolved = [];
  for (const patch of patches) resolved.push(...resolvePatchMatches(root, patch));
  const unique = new Map(resolved.map((file) => [file.relativePath, file]));
  const digest = createHash('sha256');
  for (const file of [...unique.values()].sort((a, b) => byteCompare(a.relativePath, b.relativePath))) {
    digest.update(Buffer.from(`patch\0${file.relativePath}\0`, 'utf8'));
    digest.update(readFileSync(file.absolutePath));
    digest.update(Buffer.from('\0', 'utf8'));
  }
  return digest.digest('hex');
}

function patchSetFiles(root, patches = []) {
  const resolved = [];
  for (const patch of patches) resolved.push(...resolvePatchMatches(root, patch));
  return [...new Map(resolved.map((file) => [file.relativePath, file])).values()]
    .sort((a, b) => byteCompare(a.relativePath, b.relativePath))
    .map((file) => file.relativePath);
}

function safePathWithin(root, relative, label = 'path') {
  if (!isSafeRelative(relative)) fail(`unsafe ${label}: ${relative}`);
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relative);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    fail(`unsafe ${label}: ${relative}`);
  }
  return absolute;
}

function normalizeRelativePath(value) {
  const normalized = normalizeSlashes(value).replace(/^\.\//, '');
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function pathMatchesPattern(pattern, value) {
  const normalizedPattern = normalizeRelativePath(pattern);
  const normalizedValue = normalizeRelativePath(value);
  if (normalizedPattern === normalizedValue) return true;
  if (!normalizedPattern.includes('*') && !normalizedPattern.includes('?')) {
    return normalizedValue.startsWith(`${normalizedPattern}/`);
  }
  return globToRegExp(normalizedPattern).test(normalizedValue);
}

function patchPathBelongsToEntry(entryId, declaredPath) {
  if (typeof declaredPath !== 'string') return false;
  const normalized = normalizeRelativePath(declaredPath);
  const prefix = `.sync/patches/${entryId}/`;
  return normalized.startsWith(prefix) && normalized.length > prefix.length;
}

function sourceTreeForbiddenPaths(directory) {
  const forbidden = [];
  const root = path.resolve(directory);

  function visit(current, relativeDirectory) {
    for (const entry of sortedDirEntries(current)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (entry.name === '.git') continue;
      if (FORBIDDEN_NAMES.has(entry.name)) {
        forbidden.push(normalizeSlashes(relativePath));
        continue;
      }
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isSymbolicLink()) forbidden.push(normalizeSlashes(relativePath));
    }
  }

  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    fail(`source tree is not a directory: ${directory}`, 'source');
  }
  visit(root, '');
  return forbidden.sort(byteCompare);
}

function copyTreeContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of sortedDirEntries(source)) {
    if (entry.name === '.git') continue;
    if (FORBIDDEN_NAMES.has(entry.name)) {
      fail(`source contains forbidden ${entry.name}: ${entry.name}`, 'source');
    }
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTreeContents(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    } else {
      fail(`source contains unsupported symbolic link or filesystem entry: ${entry.name}`, 'source');
    }
  }
}

function copyRelativeFile(sourceRoot, destinationRoot, relativePath) {
  const source = safePathWithin(sourceRoot, relativePath, 'preserved path');
  const destination = safePathWithin(destinationRoot, relativePath, 'preserved path');
  if (!existsSync(source)) return;
  const sourceStat = lstatSync(source);
  if (sourceStat.isDirectory()) {
    copyTreeContents(source, destination);
    return;
  }
  if (!sourceStat.isFile()) {
    fail(`preserved path must be a file or directory: ${relativePath}`, 'source');
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function copyPreservedPaths(sourceRoot, destinationRoot, preservePaths) {
  for (const preserve of preservePaths) {
    if (!isSafeRelative(preserve)
      || normalizeSlashes(preserve).split('/').some((part) => FORBIDDEN_NAMES.has(part))) {
      fail(`unsafe preservePaths entry: ${preserve}`, 'validation');
    }
    const normalized = normalizeRelativePath(preserve);
    if (!normalized.includes('*') && !normalized.includes('?')) {
      copyRelativeFile(sourceRoot, destinationRoot, normalized);
      continue;
    }
    for (const file of allFilesUnder(sourceRoot)) {
      if (pathMatchesPattern(normalized, file.relativePath)) {
        copyRelativeFile(sourceRoot, destinationRoot, file.relativePath);
      }
    }
  }
}

function fileMap(directory) {
  return new Map(collectTreeFiles(directory).files.map((file) => [file.relativePath, file]));
}

function treeDiff(before, after) {
  const beforeFiles = fileMap(before);
  const afterFiles = fileMap(after);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [relativePath, file] of afterFiles) {
    if (!beforeFiles.has(relativePath)) {
      added.push(relativePath);
      continue;
    }
    const oldFile = beforeFiles.get(relativePath);
    const oldBytes = oldFile.type === 'symlink'
      ? `symlink:${oldFile.target}`
      : readFileSync(oldFile.absolutePath);
    const newBytes = file.type === 'symlink'
      ? `symlink:${file.target}`
      : readFileSync(file.absolutePath);
    if (byteCompare(oldBytes, newBytes) !== 0) changed.push(relativePath);
  }
  for (const relativePath of beforeFiles.keys()) {
    if (!afterFiles.has(relativePath)) removed.push(relativePath);
  }
  return {
    added: added.sort(byteCompare),
    removed: removed.sort(byteCompare),
    changed: changed.sort(byteCompare),
  };
}

function packageRepository(packageJson) {
  const repository = packageJson?.repository;
  if (typeof repository === 'string') return repository;
  if (isObject(repository) && typeof repository.url === 'string') return repository.url;
  if (typeof packageJson?.homepage === 'string' && packageJson.homepage.includes('github.com/')) {
    return packageJson.homepage;
  }
  return null;
}

function normalizeRepository(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let source = value.trim().replace(/^git\+/, '');
  if (source.startsWith('git@github.com:')) {
    source = `https://github.com/${source.slice('git@github.com:'.length)}`;
  }
  source = source.replace(/\.git$/, '').replace(/\/$/, '');
  try {
    const parsed = new URL(source);
    if (parsed.hostname.toLowerCase() !== 'github.com') return source.toLowerCase();
    return `https://github.com/${parsed.pathname.replace(/^\//, '').toLowerCase()}`;
  } catch {
    return source.toLowerCase();
  }
}

function githubRepositoryParts(value) {
  const normalized = normalizeRepository(value);
  if (!normalized) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(normalized);
  return match ? { owner: match[1], name: match[2], repository: normalized } : null;
}

function packageEntrypointTargets(packageJson) {
  const targets = [];
  if (typeof packageJson?.main === 'string') targets.push(packageJson.main);
  targets.push(...packageExportTargets(packageJson?.exports));
  return targets;
}

const LIFECYCLE_SCRIPTS = new Set([
  'prepublish',
  'prepare',
  'prepublishOnly',
  'prepack',
  'postpack',
  'preprepare',
  'postprepare',
  'preinstall',
  'install',
  'postinstall',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'preversion',
  'version',
  'postversion',
  'dependencies',
  'publish',
  'postpublish',
]);

function packageWiring(packageJson) {
  return {
    dsh: packageJson?.dsh ?? null,
  };
}

function candidatePackageErrors(entry, candidateRoot, currentRoot, mode, expectedVersion, sourceReference) {
  const errors = [];
  const packageFile = path.join(candidateRoot, 'package.json');
  if (!existsSync(packageFile)) return { errors: [`sync ${entry.id}: source package.json is missing`] };
  let packageJson;
  try {
    packageJson = readJson(packageFile, `sync ${entry.id} package.json`);
  } catch (error) {
    return { errors: [error.message] };
  }
  if (!isObject(packageJson)) {
    return { errors: [`sync ${entry.id}: source package.json must contain an object`] };
  }
  if (packageJson.name !== entry.packageName) {
    errors.push(`sync ${entry.id}: package name ${String(packageJson.name)} does not match ${entry.packageName}`);
  }
  if (typeof packageJson.version !== 'string' || !packageJson.version) {
    errors.push(`sync ${entry.id}: source package version is missing`);
  } else if (expectedVersion && packageJson.version !== expectedVersion) {
    errors.push(`sync ${entry.id}: exact version ${expectedVersion} does not match source package ${packageJson.version}`);
  }
  if (entry.license?.expected !== packageLicense(packageJson)) {
    errors.push(`sync ${entry.id}: license ${packageLicense(packageJson)} does not match ${entry.license?.expected}`);
  }
  const lifecycle = isObject(packageJson.scripts)
    ? Object.keys(packageJson.scripts).filter((name) => LIFECYCLE_SCRIPTS.has(name))
    : [];
  if (lifecycle.length > 0) {
    errors.push(`sync ${entry.id}: lifecycle scripts are forbidden: ${lifecycle.join(', ')}`);
  }

  for (const entrypoint of Array.isArray(entry.validation?.entrypoints)
    ? entry.validation.entrypoints
    : []) {
    if (!isSafeRelative(entrypoint)) {
      errors.push(`sync ${entry.id}: entrypoint is unsafe ${entrypoint}`);
      continue;
    }
    const target = safePathWithin(candidateRoot, entrypoint, 'entrypoint');
    if (!existsSync(target) || !lstatSync(target).isFile()) {
      errors.push(`sync ${entry.id}: entrypoint is missing ${entrypoint}`);
    }
  }
  if (typeof packageJson.main === 'string') {
    const relativeTarget = packageJson.main.startsWith('./')
      ? packageJson.main.slice(2)
      : packageJson.main;
    if (!isSafeRelative(relativeTarget)) {
      errors.push(`sync ${entry.id}: package entrypoint is unsafe ${packageJson.main}`);
    } else {
      const absoluteTarget = safePathWithin(candidateRoot, relativeTarget, 'entrypoint');
      if (!relativeTarget.includes('*')
        && (!existsSync(absoluteTarget) || !lstatSync(absoluteTarget).isFile())) {
        errors.push(`sync ${entry.id}: package entrypoint is missing ${packageJson.main}`);
      }
    }
  }
  for (const target of packageExportTargets(packageJson.exports)) {
    if (typeof target !== 'string' || !target.startsWith('./')) continue;
    const relativeTarget = target.slice(2);
    if (!isSafeRelative(relativeTarget)) {
      errors.push(`sync ${entry.id}: package entrypoint is unsafe ${target}`);
      continue;
    }
    const absoluteTarget = safePathWithin(candidateRoot, relativeTarget, 'entrypoint');
    if (!relativeTarget.includes('*')
      && (!existsSync(absoluteTarget) || !lstatSync(absoluteTarget).isFile())) {
      errors.push(`sync ${entry.id}: package entrypoint is missing ${target}`);
    }
  }

  if (entry.source?.kind === 'npm' && entry.source.name !== packageJson.name) {
    errors.push(`sync ${entry.id}: source package name ${String(packageJson.name)} does not match ${entry.source.name}`);
  }
  const expectedRepository = normalizeRepository(entry.source?.repository);
  const actualRepository = normalizeRepository(packageRepository(packageJson));
  if (expectedRepository && expectedRepository !== actualRepository) {
    const expectedParts = githubRepositoryParts(entry.source.repository);
    const actualParts = githubRepositoryParts(packageRepository(packageJson));
    const expectedLabel = expectedParts
      ? `${expectedParts.owner}/${expectedParts.name}`
      : String(entry.source.repository);
    const actualLabel = actualParts
      ? `${actualParts.owner}/${actualParts.name}`
      : String(packageRepository(packageJson));
    errors.push(`sync ${entry.id}: source owner/name ${actualLabel} does not match ${expectedLabel}`);
  }
  if (expectedRepository && sourceReference?.repository
    && normalizeRepository(sourceReference.repository) !== expectedRepository) {
    errors.push(`sync ${entry.id}: source owner/name does not match manifest repository`);
  }

  if (mode === 'patch-rebase' && currentRoot) {
    const currentPackageFile = path.join(currentRoot, 'package.json');
    if (existsSync(currentPackageFile)) {
      let currentPackage;
      try {
        currentPackage = readJson(currentPackageFile, `sync ${entry.id} current package.json`);
      } catch (error) {
        errors.push(error.message);
      }
      if (currentPackage) {
        if (stableJson(packageWiring(currentPackage)) !== stableJson(packageWiring(packageJson))) {
          errors.push(`sync ${entry.id}: dsh wiring changed outside the explicit patch-set`);
        }
        if (stableJson(packageEntrypointTargets(currentPackage))
          !== stableJson(packageEntrypointTargets(packageJson))) {
          errors.push(`sync ${entry.id}: package entrypoint changed during patch-rebase`);
        }
      }
    }
  }
  return { errors, packageJson };
}

function parseTarString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function parseTarSize(buffer) {
  const raw = parseTarString(buffer, 124, 12).replace(/\0/g, '').trim();
  if (!raw) return 0;
  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size) || size < 0) fail(`invalid tar entry size: ${raw}`, 'source');
  return size;
}

function parsePaxAttributes(buffer) {
  const attributes = {};
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) fail('invalid pax header', 'source');
    const record = buffer.subarray(offset, newline).toString('utf8');
    const separator = record.indexOf(' ');
    const length = Number.parseInt(record.slice(0, separator), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > buffer.length) {
      fail('invalid pax record length', 'source');
    }
    const value = buffer.subarray(offset, offset + length).toString('utf8').replace(/\n$/, '');
    const equals = value.indexOf('=');
    if (equals > 0) attributes[value.slice(value.indexOf(' ') + 1, equals)] = value.slice(equals + 1);
    offset += length;
  }
  return attributes;
}

function extractTarArchive(bytes, destination) {
  mkdirSync(destination, { recursive: true });
  let offset = 0;
  let zeroBlocks = 0;
  let pendingPax = {};
  let longName = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    const type = String.fromCharCode(header[156] || 0);
    const size = parseTarSize(header);
    const payload = bytes.subarray(offset, offset + size);
    if (payload.length !== size) fail('truncated tar archive', 'source');
    offset += Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      pendingPax = type === 'x' ? parsePaxAttributes(payload) : pendingPax;
      continue;
    }
    if (type === 'L') {
      longName = payload.toString('utf8').replace(/\0.*$/, '').replace(/\n$/, '');
      continue;
    }
    if (type === 'K' || type === '1' || type === '2' || type === '3' || type === '4' || type === '6') {
      fail(`unsupported tar link or device entry: ${parseTarString(header, 0, 100)}`, 'source');
    }
    const prefix = parseTarString(header, 345, 155);
    const name = pendingPax.path || longName || (prefix ? `${prefix}/${parseTarString(header, 0, 100)}` : parseTarString(header, 0, 100));
    pendingPax = {};
    longName = null;
    const relative = normalizeRelativePath(name);
    if (!isSafeRelative(relative) || relative.startsWith('../') || relative.includes('/../')) {
      fail(`unsafe tar path: ${name}`, 'source');
    }
    if (relative.split('/').some((part) => FORBIDDEN_NAMES.has(part))) {
      fail(`tar archive contains forbidden path: ${relative}`, 'source');
    }
    const target = safePathWithin(destination, relative, 'tar path');
    if (type === '5' || relative.endsWith('/')) {
      mkdirSync(target, { recursive: true });
    } else if (type === '0' || type === '\0' || type === '') {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, payload);
    } else {
      fail(`unsupported tar entry type ${type || '0'}: ${relative}`, 'source');
    }
  }
}

function locatePackageRoot(extractedRoot) {
  if (existsSync(path.join(extractedRoot, 'package.json'))) return extractedRoot;
  const directories = sortedDirEntries(extractedRoot).filter((entry) => entry.isDirectory());
  const candidates = directories.filter((entry) => existsSync(path.join(extractedRoot, entry.name, 'package.json')));
  if (candidates.length === 1) return path.join(extractedRoot, candidates[0].name);
  const packageFiles = allFilesUnder(extractedRoot)
    .filter((file) => path.basename(file.relativePath) === 'package.json');
  if (packageFiles.length === 1) return path.dirname(packageFiles[0].absolutePath);
  fail(`source archive must contain exactly one package.json (found ${packageFiles.length})`, 'source');
}

function archiveIntegrity(bytes, expectedSha256, expectedIntegrity) {
  const archiveSha256 = sha256Bytes(bytes);
  const digests = {
    sha256: createHash('sha256').update(bytes).digest('base64'),
    sha384: createHash('sha384').update(bytes).digest('base64'),
    sha512: createHash('sha512').update(bytes).digest('base64'),
  };
  const integrity = expectedIntegrity || `sha512-${digests.sha512}`;
  if (expectedSha256 && archiveSha256 !== expectedSha256) {
    fail(`archive SHA-256 mismatch: expected ${expectedSha256}, received ${archiveSha256}`, 'integrity');
  }
  if (expectedIntegrity) {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+=*)$/.exec(expectedIntegrity);
    if (!match || match[2] !== digests[match[1]]) {
      fail(`archive integrity mismatch: expected ${expectedIntegrity}, received ${integrity}`, 'integrity');
    }
  }
  return { archiveSha256, integrity };
}

async function fetchBytes(url, headers = {}) {
  if (url.startsWith('file://')) {
    try {
      return readFileSync(new URL(url));
    } catch (error) {
      fail(`source download failed for ${url}: ${error instanceof Error ? error.message : String(error)}`, 'network');
    }
  }
  if (typeof fetch !== 'function') fail('network source requires Node fetch support', 'network');
  let response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': 'dsh-plugin-sync/1', ...headers },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(120000) : undefined,
    });
  } catch (error) {
    fail(`source download failed for ${url}: ${error instanceof Error ? error.message : String(error)}`, 'network');
  }
  if (!response.ok) fail(`source download failed for ${url}: HTTP ${response.status}`, 'network');
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    fail(`source download failed for ${url}: ${error instanceof Error ? error.message : String(error)}`, 'network');
  }
}

async function fetchJson(url) {
  const bytes = await fetchBytes(url, { accept: 'application/json' });
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`source metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'network');
  }
}

function npmPackagePath(name) {
  return name.startsWith('@')
    ? name.split('/').map((part) => encodeURIComponent(part)).join('/')
    : encodeURIComponent(name);
}

function requestedResolution(entry, flags) {
  const explicitVersion = flags.get('version');
  const explicitCommit = flags.get('commit') || flags.get('source-commit');
  const modeFlag = flags.get('mode');
  const mode = explicitVersion || explicitCommit ? 'exact' : (modeFlag || entry.request?.mode);
  if (mode !== 'latest' && mode !== 'exact') fail(`unsupported sync mode: ${mode}`, 'usage');
  const version = explicitVersion || (mode === 'exact' ? entry.request?.version : undefined);
  const commit = explicitCommit || (mode === 'exact' ? entry.request?.commit : undefined);
  if (mode === 'exact' && !version && !commit) {
    fail('exact sync requires --version or an exact manifest version/commit', 'usage');
  }
  return {
    mode,
    version: typeof version === 'string' && version ? version : null,
    commit: typeof commit === 'string' && commit ? commit : null,
    requested: version || commit || (mode === 'latest' ? 'latest' : null),
  };
}

async function resolveNetworkSource(entry, resolution, flags) {
  const explicitUrl = flags.get('source-url') || flags.get('url');
  if (explicitUrl) {
    const url = String(explicitUrl);
    const bytes = await fetchBytes(url);
    const local = url.startsWith('file://');
    return {
      bytes,
      ...(local ? {} : { tarball: url }),
      ...archiveIntegrity(bytes, flags.get('sha256'), flags.get('integrity')),
      networkAccessed: !local,
    };
  }
  if (entry.source?.kind === 'npm') {
    const registry = String(flags.get('registry') || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
    const metadata = await fetchJson(`${registry}/${npmPackagePath(entry.source.name)}`);
    const version = resolution.version || metadata?.['dist-tags']?.latest;
    if (!version || !metadata?.versions?.[version]) {
      fail(`npm source has no exact version ${version || '<latest>'}`, 'network');
    }
    const dist = metadata.versions[version].dist;
    if (!dist?.tarball) fail(`npm source ${entry.source.name}@${version} has no tarball URL`, 'network');
    const bytes = await fetchBytes(dist.tarball);
    return {
      bytes,
      tarball: dist.tarball,
      integrity: dist.integrity || archiveIntegrity(bytes).integrity,
      ...archiveIntegrity(bytes, flags.get('sha256'), flags.get('integrity') || dist.integrity),
      resolvedVersion: version,
      networkAccessed: true,
    };
  }
  if (entry.source?.kind === 'github') {
    const parts = githubRepositoryParts(entry.source.repository);
    if (!parts) fail(`GitHub source repository is invalid: ${entry.source.repository}`, 'network');
    let archiveUrl;
    let resolvedCommit = resolution.commit;
    let resolvedVersion = resolution.version;
    if (resolvedCommit) {
      archiveUrl = `https://github.com/${parts.owner}/${parts.name}/archive/${encodeURIComponent(resolvedCommit)}.tar.gz`;
    } else if (resolvedVersion) {
      archiveUrl = `https://github.com/${parts.owner}/${parts.name}/archive/refs/tags/v${encodeURIComponent(resolvedVersion)}.tar.gz`;
    } else {
      const release = await fetchJson(`https://api.github.com/repos/${parts.owner}/${parts.name}/releases/latest`);
      const tag = release?.tag_name;
      archiveUrl = release?.tarball_url;
      resolvedVersion = typeof tag === 'string' ? tag.replace(/^v/, '') : null;
      resolvedCommit = null;
      if (!archiveUrl) fail(`GitHub source has no release archive for ${parts.owner}/${parts.name}`, 'network');
    }
    const bytes = await fetchBytes(archiveUrl, { accept: 'application/octet-stream' });
    return {
      bytes,
      tarball: archiveUrl,
      resolvedVersion,
      resolvedCommit,
      ...archiveIntegrity(bytes, flags.get('sha256'), flags.get('integrity')),
      networkAccessed: true,
    };
  }
  fail(`source kind ${entry.source?.kind} cannot be downloaded`, 'unsupported');
}

async function prepareSource(entry, resolution, flags) {
  const sourceDirFlag = flags.get('source-dir') || flags.get('source');
  if (sourceDirFlag) {
    const sourceRoot = path.resolve(String(sourceDirFlag));
    const forbidden = sourceTreeForbiddenPaths(sourceRoot);
    if (forbidden.length > 0) {
      fail(`source contains forbidden paths: ${forbidden.join(', ')}`, 'source');
    }
    return { sourceRoot, networkAccessed: false, artifact: {} };
  }
  const archiveFlag = flags.get('archive') || flags.get('artifact');
  if (archiveFlag) {
    let bytes;
    try {
      bytes = readFileSync(path.resolve(String(archiveFlag)));
    } catch (error) {
      fail(`source archive cannot be read: ${error instanceof Error ? error.message : String(error)}`, 'source');
    }
    const integrity = archiveIntegrity(bytes, flags.get('sha256'), flags.get('integrity'));
    const extractedRoot = mkdtempSync(path.join(tmpdir(), 'dsh-plugin-source-'));
    try {
      const archiveBytes = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
      extractTarArchive(archiveBytes, extractedRoot);
      const sourceRoot = locatePackageRoot(extractedRoot);
      const forbidden = sourceTreeForbiddenPaths(sourceRoot);
      if (forbidden.length > 0) {
        fail(`source contains forbidden paths: ${forbidden.join(', ')}`, 'source');
      }
      return { sourceRoot, networkAccessed: false, artifact: { ...integrity }, cleanup: extractedRoot };
    } catch (error) {
      try { rmSync(extractedRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
  if (flags.get('dry-run')) return null;
  const downloaded = await resolveNetworkSource(entry, resolution, flags);
  const extractedRoot = mkdtempSync(path.join(tmpdir(), 'dsh-plugin-source-'));
  try {
    const archiveBytes = downloaded.bytes[0] === 0x1f && downloaded.bytes[1] === 0x8b
      ? gunzipSync(downloaded.bytes)
      : downloaded.bytes;
    extractTarArchive(archiveBytes, extractedRoot);
    const sourceRoot = locatePackageRoot(extractedRoot);
    const forbidden = sourceTreeForbiddenPaths(sourceRoot);
    if (forbidden.length > 0) {
      fail(`source contains forbidden paths: ${forbidden.join(', ')}`, 'source');
    }
    return {
      sourceRoot,
      networkAccessed: downloaded.networkAccessed !== false,
      artifact: {
        archiveSha256: downloaded.archiveSha256,
        integrity: downloaded.integrity,
        tarball: downloaded.tarball,
        sourceCommit: downloaded.resolvedCommit || resolution.commit || null,
        resolvedVersion: downloaded.resolvedVersion || resolution.version || null,
      },
      cleanup: extractedRoot,
    };
  } catch (error) {
    try { rmSync(extractedRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Atomically replace a file.  The temporary file is in the target directory so
 * rename remains atomic; the old target is never removed before the new bytes
 * are ready.  `hooks.beforeRename` is intentionally exposed for interruption
 * tests and is not used by the CLI.
 */
export function writeFileAtomic(file, content, hooks = {}) {
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const temporary = `${target}.tmp-${token}`;
  let backup = null;
  let movedOld = false;
  try {
    writeFileSync(temporary, content);
    if (typeof hooks.beforeRename === 'function') hooks.beforeRename();
    try {
      renameSync(temporary, target);
    } catch (firstError) {
      // Windows may reject replacing an open target.  Keep a recoverable old
      // name while trying the second rename; a failure restores it.
      backup = `${target}.old-${token}`;
      try {
        renameSync(target, backup);
        movedOld = true;
      } catch {
        backup = null;
      }
      try {
        renameSync(temporary, target);
      } catch (secondError) {
        if (movedOld) {
          try { renameSync(backup, target); } catch { /* leave old backup for diagnosis */ }
        }
        throw secondError || firstError;
      }
    }
    if (movedOld && backup) {
      try { rmSync(backup, { force: true }); } catch { /* next write cleans stale backups */ }
    }
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    if (movedOld && backup && !existsSync(target)) {
      try { renameSync(backup, target); } catch { /* preserve backup rather than overwrite */ }
    }
    throw error;
  }
}

export function writeJsonAtomic(file, value, hooks = {}) {
  writeFileAtomic(file, prettyJson(value), hooks);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} cannot be parsed: ${detail}`);
  }
}

function projectPaths(root) {
  return {
    root,
    sync: path.join(root, '.sync'),
    manifest: path.join(root, '.sync', 'plugins.json'),
    schema: path.join(root, '.sync', 'plugins.schema.json'),
    policies: path.join(root, '.sync', 'policies.json'),
    lock: path.join(root, '.sync', 'plugins.lock.json'),
    companion: path.join(root, 'dsh-desktop', 'lib', 'desktop', 'companion-sync.ts'),
    registry: path.join(root, 'dsh-desktop', 'lib', 'desktop', 'plugin-sync-registry.ts'),
  };
}

export function loadProject(root = DEFAULT_ROOT) {
  const paths = projectPaths(path.resolve(root));
  return {
    paths,
    manifest: readJson(paths.manifest, 'manifest'),
    schema: readJson(paths.schema, 'schema'),
    policies: readJson(paths.policies, 'policies'),
  };
}

function schemaTypeMatches(value, type) {
  if (type === 'object') return isObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function resolveSchemaRef(schemaRoot, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let current = schemaRoot;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    current = current?.[key];
  }
  return current;
}

function schemaMatches(value, schema, schemaRoot) {
  if (!isObject(schema)) return true;
  if (schema.$ref) {
    const referenced = resolveSchemaRef(schemaRoot, schema.$ref);
    return referenced ? schemaMatches(value, referenced, schemaRoot) : false;
  }
  if (schema.const !== undefined && stableJson(value) !== stableJson(schema.const)) return false;
  if (schema.enum && !schema.enum.some((item) => stableJson(item) === stableJson(value))) return false;
  if (schema.type && !schemaTypeMatches(value, schema.type)) return false;
  if (schema.required && isObject(value) && schema.required.some((key) => !(key in value))) return false;
  if (schema.properties && isObject(value)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (key in value && !schemaMatches(value[key], child, schemaRoot)) return false;
    }
  }
  if (schema.additionalProperties === false && isObject(value)) {
    const known = new Set(Object.keys(schema.properties || {}));
    if (Object.keys(value).some((key) => !known.has(key))) return false;
  }
  if (schema.items && Array.isArray(value) && value.some((item) => !schemaMatches(item, schema.items, schemaRoot))) return false;
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) return false;
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) return false;
  if (schema.anyOf && !schema.anyOf.some((child) => schemaMatches(value, child, schemaRoot))) return false;
  if (schema.allOf && schema.allOf.some((child) => !schemaMatches(value, child, schemaRoot))) return false;
  if (schema.not && schemaMatches(value, schema.not, schemaRoot)) return false;
  if (schema.if && schemaMatches(value, schema.if, schemaRoot) && schema.then && !schemaMatches(value, schema.then, schemaRoot)) return false;
  return true;
}

function validateSchema(value, schema, label) {
  const errors = [];
  const root = schema;

  function visit(current, rule, pointer) {
    if (!isObject(rule)) return;
    if (rule.$ref) {
      const referenced = resolveSchemaRef(root, rule.$ref);
      if (!referenced) errors.push(`${pointer}: unresolved schema reference ${rule.$ref}`);
      else visit(current, referenced, pointer);
      return;
    }
    if (rule.const !== undefined && stableJson(current) !== stableJson(rule.const)) {
      errors.push(`${pointer}: must equal ${JSON.stringify(rule.const)}`);
    }
    if (rule.enum && !rule.enum.some((item) => stableJson(item) === stableJson(current))) {
      errors.push(`${pointer}: must be one of ${rule.enum.join(', ')}`);
    }
    if (rule.type && !schemaTypeMatches(current, rule.type)) {
      errors.push(`${pointer}: expected ${rule.type}`);
      return;
    }
    if (rule.required && isObject(current)) {
      for (const key of rule.required) {
        if (!(key in current)) errors.push(`${pointer}: missing required property ${key}`);
      }
    }
    if (rule.additionalProperties === false && isObject(current)) {
      const known = new Set(Object.keys(rule.properties || {}));
      for (const key of Object.keys(current)) {
        if (!known.has(key)) errors.push(`${pointer}/${key}: additional property is not allowed`);
      }
    }
    if (rule.properties && isObject(current)) {
      for (const [key, child] of Object.entries(rule.properties)) {
        if (key in current) visit(current[key], child, `${pointer}/${key}`);
      }
    }
    if (rule.items && Array.isArray(current)) {
      current.forEach((item, index) => visit(item, rule.items, `${pointer}/${index}`));
    }
    if (rule.pattern && typeof current === 'string' && !new RegExp(rule.pattern).test(current)) {
      errors.push(`${pointer}: does not match ${rule.pattern}`);
    }
    if (rule.minLength !== undefined && typeof current === 'string' && current.length < rule.minLength) {
      errors.push(`${pointer}: must contain at least ${rule.minLength} characters`);
    }
    if (rule.minimum !== undefined && typeof current === 'number' && current < rule.minimum) {
      errors.push(`${pointer}: must be at least ${rule.minimum}`);
    }
    if (rule.anyOf && !rule.anyOf.some((child) => schemaMatches(current, child, root))) {
      errors.push(`${pointer}: does not match any allowed schema branch`);
    }
    if (rule.allOf) {
      for (const child of rule.allOf) visit(current, child, pointer);
    }
    if (rule.if && schemaMatches(current, rule.if, root) && rule.then) visit(current, rule.then, pointer);
    if (rule.not && schemaMatches(current, rule.not, root)) errors.push(`${pointer}: must not match prohibited schema`);
  }

  visit(value, schema, '$');
  return errors.map((error) => `${label}: ${error}`);
}

function allManifestEntries(manifest) {
  if (!isObject(manifest)) return [];
  return INVENTORY_ROOTS.flatMap((root) => (
    Array.isArray(manifest[root.manifestKey]) ? manifest[root.manifestKey] : []
  ));
}

function packageRoot(root, entry) {
  if (!isSafeRelative(entry.path)) fail(`unsafe package path: ${entry.path}`);
  return path.resolve(root, entry.path);
}

function packageLicense(pkg) {
  return typeof pkg.license === 'string' && pkg.license ? pkg.license : 'UNKNOWN';
}

function packageExportTargets(exportsField) {
  const targets = [];
  function visit(value) {
    if (typeof value === 'string') {
      targets.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isObject(value)) Object.values(value).forEach(visit);
  }
  visit(exportsField);
  return targets;
}

function sourceMapFromText(text) {
  const marker = /plugin-sync:update-sources\s+([^\n]+)/.exec(text);
  if (marker) {
    try {
      const parsed = JSON.parse(marker[1]);
      if (isObject(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  const start = text.indexOf('export const PLUGIN_UPDATE_SOURCES');
  if (start < 0) return null;
  const end = text.indexOf('};', start);
  if (end < 0) return null;
  const block = text.slice(start, end);
  const result = {};
  const pattern = /['"]([^'"]+)['"]\s*:\s*\{\s*(npm|github)\s*:\s*['"]([^'"]+)['"]\s*\}/g;
  for (const match of block.matchAll(pattern)) result[match[1]] = { [match[2]]: match[3] };
  return result;
}

function sourceMap(paths) {
  // Task 2 still reads the legacy source block.  Accept the generated marker
  // as a fallback so the validator remains usable after Task 4 removes the
  // second hand-maintained source table.
  for (const file of [paths.companion, paths.registry]) {
    if (!existsSync(file)) continue;
    const map = sourceMapFromText(readFileSync(file, 'utf8'));
    if (map !== null) return map;
  }
  return null;
}

function pushError(errors, message) {
  errors.push(message);
}

function validateManifestInternal(project) {
  const { paths, manifest, schema, policies } = project;
  const { root } = paths;
  const errors = validateSchema(manifest, schema, 'manifest');
  const manifestObject = isObject(manifest) ? manifest : {};
  const entries = allManifestEntries(manifestObject);
  const ids = new Map();
  const pathsSeen = new Map();
  const rootsByKind = new Map(INVENTORY_ROOTS.map((item) => [item.kind, item]));

  if (manifestObject.schemaVersion !== 1) pushError(errors, 'manifest: schemaVersion must be 1');
  if (manifestObject.generatedRegistry !== 'dsh-desktop/lib/desktop/plugin-sync-registry.ts') {
    pushError(errors, 'manifest: generatedRegistry must point to the runtime registry');
  }
  if (!isObject(policies)) pushError(errors, 'policies: expected an object');

  for (const inventory of INVENTORY_ROOTS) {
    const configured = Array.isArray(policies?.inventoryRoots)
      ? policies.inventoryRoots.find((item) => item?.kind === inventory.kind)
      : null;
    if (!configured || configured.path !== inventory.relative || configured.manifestKey !== inventory.manifestKey) {
      pushError(errors, `policies: inventory root mismatch for ${inventory.kind}`);
    }
    const directory = path.join(root, inventory.relative);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
      pushError(errors, `inventory directory missing: ${inventory.relative}`);
      continue;
    }
    const actualDirectories = readdirSync(directory, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort(byteCompare);
    const listedDirectories = entries
      .filter((entry) => entry?.kind === inventory.kind)
      .map((entry) => normalizeSlashes(entry?.path || '').split('/').pop())
      .sort(byteCompare);
    if (stableJson(actualDirectories) !== stableJson(listedDirectories)) {
      pushError(errors, `${inventory.kind}: manifest directories do not match the inventory tree`);
    }
  }

  for (const entry of entries) {
    const pointer = `manifest entry ${entry?.id || '<missing>'}`;
    if (!isObject(entry)) {
      pushError(errors, `${pointer}: expected an object`);
      continue;
    }
    if (ids.has(entry.id)) pushError(errors, `${pointer}: duplicate id (also ${ids.get(entry.id)})`);
    else ids.set(entry.id, entry.path);
    if (pathsSeen.has(entry.path)) pushError(errors, `${pointer}: duplicate path (also ${pathsSeen.get(entry.path)})`);
    else pathsSeen.set(entry.path, entry.id);

    const inventory = rootsByKind.get(entry.kind);
    const normalizedEntryPath = normalizeSlashes(entry.path || '');
    if (!inventory || !normalizedEntryPath.startsWith(`${inventory.relative}/`)) {
      pushError(errors, `${pointer}: path is outside its ${entry.kind} inventory root`);
    }
    if (!isSafeRelative(entry.path)) pushError(errors, `${pointer}: path must be a safe relative path`);
    if (entry.class && !ALLOWED_CLASSES.has(entry.class)) pushError(errors, `${pointer}: invalid class ${entry.class}`);
    if (entry.sync?.mode && !ALLOWED_SYNC_MODES.has(entry.sync.mode)) {
      pushError(errors, `${pointer}: invalid sync mode ${entry.sync.mode}`);
    }
    if (entry.source?.kind && !ALLOWED_SOURCE_KINDS.has(entry.source.kind)) {
      pushError(errors, `${pointer}: invalid source kind ${entry.source.kind}`);
    }
    if (entry.source?.kind === 'unknown' && entry.source.repository !== undefined) {
      pushError(errors, `${pointer}: unknown source must not contain a repository`);
    }
    if ((entry.source?.kind === 'unknown' || entry.source?.kind === 'internal') && !entry.source?.reason) {
      pushError(errors, `${pointer}: ${entry.source.kind} source requires a reason`);
    }
    if (entry.source?.kind === 'npm' && !entry.source.name) pushError(errors, `${pointer}: npm source requires name`);
    if (entry.source?.kind === 'github' && !entry.source.repository) pushError(errors, `${pointer}: github source requires repository`);
    if (entry.request?.mode === 'latest') {
      if (typeof entry.request.range !== 'string') pushError(errors, `${pointer}: latest request requires range`);
      if (typeof entry.request.releaseAgeHours !== 'number' || entry.request.releaseAgeHours < 0) {
        pushError(errors, `${pointer}: latest request requires a non-negative releaseAgeHours`);
      }
    } else if (entry.request?.mode === 'exact') {
      if (!entry.request.version && !entry.request.commit) pushError(errors, `${pointer}: exact request requires version or commit`);
    }
    if (entry.runtimeUpdate?.allowed === true) {
      if (!entry.runtimeUpdate.source) pushError(errors, `${pointer}: enabled runtime update requires a source`);
      if (!ALLOWED_RUNTIME_SOURCE_KINDS.has(entry.runtimeUpdate.source?.kind)) {
        pushError(errors, `${pointer}: runtime update source kind is invalid`);
      }
    } else if (entry.runtimeUpdate?.source !== undefined) {
      pushError(errors, `${pointer}: disabled runtime update must not declare a source`);
    }
    const ownerPaths = Array.isArray(policies?.owners?.[entry.owner]) ? policies.owners[entry.owner] : [];
    if (ownerPaths.length === 0 || !ownerPaths.some((prefix) => (
      typeof prefix === 'string' && normalizedEntryPath.startsWith(prefix)
    ))) {
      pushError(errors, `${pointer}: owner ${entry.owner} does not own ${normalizedEntryPath}`);
    }
    if (entry.kind === 'skin') {
      if (entry.class !== 'resource') pushError(errors, `${pointer}: skins must use class resource`);
      if (entry.sync?.mode !== 'metadata-only') pushError(errors, `${pointer}: skins must use metadata-only sync`);
      if (entry.runtimeUpdate?.allowed !== false) pushError(errors, `${pointer}: skins cannot use runtime updates`);
    }
    if (entry.kind === 'sdk-plugin') {
      if (entry.class !== 'isolated-sdk') pushError(errors, `${pointer}: SDK plugins must use class isolated-sdk`);
      if (entry.runtimeUpdate?.allowed !== false) pushError(errors, `${pointer}: SDK plugins cannot use runtime updates`);
    }

    const packageDirectory = packageRoot(root, entry);
    const packageFile = path.join(packageDirectory, 'package.json');
    if (!existsSync(packageDirectory) || !lstatSync(packageDirectory).isDirectory()) {
      pushError(errors, `${pointer}: package directory is missing`);
      continue;
    }
    if (!existsSync(packageFile)) {
      pushError(errors, `${pointer}: package.json is missing`);
      continue;
    }
    let pkg;
    try {
      pkg = readJson(packageFile, `${pointer} package.json`);
    } catch (error) {
      pushError(errors, error.message);
      continue;
    }
    if (!isObject(pkg)) {
      pushError(errors, `${pointer}: package.json must contain an object`);
      continue;
    }
    if (entry.packageName !== pkg.name) pushError(errors, `${pointer}: packageName ${entry.packageName} does not match package.json name ${pkg.name}`);
    if (typeof pkg.version !== 'string' || !pkg.version) pushError(errors, `${pointer}: package.json version is missing`);
    if (entry.request?.mode === 'exact' && entry.request.version && pkg.version !== entry.request.version) {
      pushError(errors, `${pointer}: exact request version ${entry.request.version} does not match package.json ${pkg.version}`);
    }
    if (entry.license?.expected !== packageLicense(pkg)) {
      pushError(errors, `${pointer}: license ${entry.license?.expected} does not match package.json ${packageLicense(pkg)}`);
    }
    const entrypoints = Array.isArray(entry.validation?.entrypoints) ? entry.validation.entrypoints : [];
    if (entrypoints.length === 0) pushError(errors, `${pointer}: at least one entrypoint is required`);
    for (const entrypoint of entrypoints) {
      if (!isSafeRelative(entrypoint) || entrypoint.startsWith('/')) {
        pushError(errors, `${pointer}: unsafe entrypoint ${entrypoint}`);
      } else if (!existsSync(path.join(packageDirectory, entrypoint))
        || !lstatSync(path.join(packageDirectory, entrypoint)).isFile()) {
        pushError(errors, `${pointer}: entrypoint is missing ${entrypoint}`);
      }
    }
    if (pkg.main !== undefined) {
      if (typeof pkg.main !== 'string' || !isSafeRelative(pkg.main)) {
        pushError(errors, `${pointer}: package.json main is unsafe ${String(pkg.main)}`);
      } else if (!existsSync(path.join(packageDirectory, pkg.main))
        || !lstatSync(path.join(packageDirectory, pkg.main)).isFile()) {
        pushError(errors, `${pointer}: package.json main is missing ${pkg.main}`);
      }
    }
    for (const target of packageExportTargets(pkg.exports)) {
      if (target.startsWith('./')) {
        const relativeTarget = target.slice(2);
        if (!isSafeRelative(relativeTarget)) {
          pushError(errors, `${pointer}: package.json export is unsafe ${target}`);
        } else if (!relativeTarget.includes('*')
          && (!existsSync(path.join(packageDirectory, relativeTarget))
            || !lstatSync(path.join(packageDirectory, relativeTarget)).isFile())) {
          pushError(errors, `${pointer}: package.json export is missing ${target}`);
        }
      } else if (target.startsWith('../') || path.isAbsolute(target)) {
        pushError(errors, `${pointer}: package.json export is unsafe ${target}`);
      }
    }
    for (const field of ['patches', 'preservePaths']) {
      for (const declared of Array.isArray(entry.sync?.[field]) ? entry.sync[field] : []) {
        const segments = normalizeSlashes(declared).split('/');
        if (!isSafeRelative(declared)) {
          pushError(errors, `${pointer}: ${field} must be a safe relative path ${declared}`);
        }
        if (segments.some((segment) => FORBIDDEN_NAMES.has(segment))) {
          pushError(errors, `${pointer}: ${field} may not target forbidden path ${declared}`);
        }
        if (field === 'patches' && !patchPathBelongsToEntry(entry.id, declared)) {
          pushError(errors, `${pointer}: patches must stay under .sync/patches/${entry.id}/`);
        }
      }
    }
  }

  const updates = sourceMap(paths);
  if (updates === null) {
    pushError(errors, 'runtime source registry is missing from companion-sync.ts/generated registry');
  } else {
    const runtimeEntries = entries.filter((entry) => entry.runtimeUpdate?.allowed === true);
    const expectedCount = policies?.runtimeUpdates?.legacySourceCount;
    if (typeof expectedCount === 'number' && expectedCount !== Object.keys(updates).length) {
      pushError(errors, `runtime source registry count ${Object.keys(updates).length} does not match policy ${expectedCount}`);
    }
    const expectedIds = new Set(runtimeEntries.map((entry) => entry.id));
    for (const id of Object.keys(updates)) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) {
        pushError(errors, `runtime source ${id} has no manifest entry`);
        continue;
      }
      if (!entry.runtimeUpdate?.allowed) pushError(errors, `runtime source ${id} is not allowed by the manifest`);
      const update = updates[id];
      const runtime = entry.runtimeUpdate?.source;
      if (update.npm && (runtime?.kind !== 'npm' || runtime.name !== update.npm)) {
        pushError(errors, `runtime source ${id} npm mapping differs from manifest`);
      }
      if (update.github && (runtime?.kind !== 'github' || runtime.repository !== `https://github.com/${update.github}`)) {
        pushError(errors, `runtime source ${id} GitHub mapping differs from manifest`);
      }
    }
    for (const id of expectedIds) if (!Object.hasOwn(updates, id)) pushError(errors, `manifest runtime source ${id} is missing from registry`);
    if (policies?.runtimeUpdates?.sourceMapMustBeOneToOne && Object.keys(updates).length !== expectedIds.size) {
      pushError(errors, 'runtime source registry must map one-to-one to allowed manifest entries');
    }
  }

  return { errors, entries, updates: updates || {} };
}

export function validateManifest(root = DEFAULT_ROOT) {
  const project = loadProject(root);
  const result = validateManifestInternal(project);
  if (result.errors.length > 0) throw new ValidationFailure(result.errors);
  return {
    root: project.paths.root,
    manifest: project.manifest,
    policies: project.policies,
    entries: result.entries,
    updates: result.updates,
    counts: {
      plugins: Array.isArray(project.manifest.plugins) ? project.manifest.plugins.length : 0,
      skins: Array.isArray(project.manifest.skins) ? project.manifest.skins.length : 0,
      sdkPlugins: Array.isArray(project.manifest.sdkPlugins) ? project.manifest.sdkPlugins.length : 0,
    },
  };
}

function registryPayload(manifest) {
  const entries = {};
  const updates = {};
  for (const entry of allManifestEntries(manifest).sort((a, b) => byteCompare(a.id, b.id))) {
    entries[entry.id] = {
      kind: entry.kind,
      path: entry.path,
      packageName: entry.packageName,
      class: entry.class,
      syncMode: entry.sync.mode,
      source: entry.source,
      runtimeUpdate: entry.runtimeUpdate,
    };
    if (entry.runtimeUpdate.allowed) {
      const source = entry.runtimeUpdate.source;
      updates[entry.id] = source.kind === 'npm'
        ? { npm: source.name }
        : { github: source.repository.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') };
    }
  }
  return {
    schemaVersion: manifest?.schemaVersion,
    manifest: '.sync/plugins.json',
    entries,
    updateSources: updates,
  };
}

export function generateRegistryText(manifest) {
  const payload = registryPayload(manifest);
  return [
    '// GENERATED FILE — do not edit by hand.',
    '// Source: .sync/plugins.json (run plugin-sync.mjs generate-registry).',
    `// plugin-sync:update-sources ${JSON.stringify(payload.updateSources)}`,
    '',
    `export const PLUGIN_SYNC_REGISTRY = ${prettyJson(payload).replace(/\n$/, '')} as const;`,
    'export const PLUGIN_UPDATE_SOURCES = PLUGIN_SYNC_REGISTRY.updateSources;',
    'export default PLUGIN_SYNC_REGISTRY;',
    '',
  ].join('\n');
}

export function generateRegistry(root = DEFAULT_ROOT, { check = false } = {}) {
  const result = validateManifest(root);
  const file = projectPaths(path.resolve(root)).registry;
  const expected = generateRegistryText(result.manifest);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (check) {
    if (current !== expected) {
      throw new ValidationFailure([`generated registry drift: ${relativePosix(path.resolve(root), file)}`]);
    }
    return { file, changed: false, checked: true };
  }
  if (current !== expected) writeFileAtomic(file, expected);
  return { file, changed: current !== expected, checked: false };
}

function lockedRequest(entry, packageJson) {
  if (entry.request?.version) return entry.request.version;
  if (entry.request?.commit) return entry.request.commit;
  if (entry.request?.mode === 'latest' && typeof packageJson?.version === 'string' && packageJson.version) {
    return packageJson.version;
  }
  return null;
}

function resolvedSource(entry, packageJson, treeHash, artifact = {}) {
  const source = { kind: entry.source.kind };
  if (entry.source.name) source.name = entry.source.name;
  if (entry.source.repository) source.repository = entry.source.repository;
  if (packageJson.version) source.version = packageJson.version;
  if (entry.request.commit) source.commit = entry.request.commit;
  // This is the digest of the local source snapshot available offline.  A
  // future network resolver may replace it with a tarball/archive digest, but
  // it must not pretend that a network artifact was fetched here.
  source.sha256 = treeHash;
  if (artifact.archiveSha256) source.archiveSha256 = artifact.archiveSha256;
  if (artifact.integrity) source.integrity = artifact.integrity;
  if (artifact.tarball) source.tarball = artifact.tarball;
  if (artifact.resolvedVersion) source.version = artifact.resolvedVersion;
  if (artifact.sourceCommit) source.commit = artifact.sourceCommit;
  return source;
}

export function buildLock(root = DEFAULT_ROOT) {
  const result = validateManifest(root);
  const project = loadProject(root);
  const lockEntries = {};
  for (const entry of [...result.entries].sort((a, b) => byteCompare(a.id, b.id))) {
    const directory = packageRoot(project.paths.root, entry);
    const pkg = readJson(path.join(directory, 'package.json'), `${entry.id} package.json`);
    const snapshot = treeSnapshot(directory);
    const patches = Array.isArray(entry.sync?.patches) ? entry.sync.patches : [];
    const patchHash = patchSetSha256(project.paths.root, patches);
    const requested = lockedRequest(entry, pkg);
    if (!requested) fail(`${entry.id}: exact lock resolution requires a version or commit`, 'validation');
    lockEntries[entry.id] = {
      requested,
      source: resolvedSource(entry, pkg, snapshot.treeSha256),
      local: {
        path: entry.path,
        packageName: pkg.name,
        packageVersion: pkg.version,
        license: packageLicense(pkg),
        entrypoints: entry.validation.entrypoints,
        treeSha256: snapshot.treeSha256,
        fileCount: snapshot.files.length,
        excludedPaths: snapshot.excludedPaths,
      },
      sourceCommit: entry.request.commit || null,
      patchSet: patches.length > 0 ? `sha256:${patchHash}` : 'none',
      patchSetSha256: patchHash,
      patchFiles: patchSetFiles(project.paths.root, patches),
      compatibility: {},
      runtimeUpdate: entry.runtimeUpdate.allowed ? 'enabled' : 'disabled',
      manifestEntrySha256: sha256Text(stableJson(entry)),
    };
  }
  const manifestBytes = readFileSync(project.paths.manifest);
  return {
    schemaVersion: 1,
    manifest: '.sync/plugins.json',
    manifestRevision: sha256Bytes(manifestBytes),
    generatedRegistry: project.manifest.generatedRegistry,
    plugins: lockEntries,
  };
}

function validateLockShape(lock, errors) {
  if (!isObject(lock)) {
    errors.push('lock: expected an object');
    return;
  }
  if (lock.schemaVersion !== 1) errors.push('lock: schemaVersion must be 1');
  if (lock.manifest !== '.sync/plugins.json') errors.push('lock: manifest must be .sync/plugins.json');
  if (typeof lock.manifestRevision !== 'string' || !HEX_256.test(lock.manifestRevision)) errors.push('lock: manifestRevision must be a SHA-256 digest');
  if (lock.generatedRegistry !== 'dsh-desktop/lib/desktop/plugin-sync-registry.ts') errors.push('lock: generatedRegistry must point to the runtime registry');
  if (!isObject(lock.plugins)) errors.push('lock: plugins must be an object');
}

function validateLockInternal(project, manifestResult, lock) {
  const errors = [];
  validateLockShape(lock, errors);
  if (!isObject(lock) || !isObject(lock.plugins)) return errors;
  const entries = manifestResult.entries;
  const expectedIds = new Set(entries.map((entry) => entry.id));
  const actualIds = new Set(isObject(lock.plugins) ? Object.keys(lock.plugins) : []);
  for (const id of expectedIds) if (!actualIds.has(id)) errors.push(`lock completeness: missing ${id}`);
  for (const id of actualIds) if (!expectedIds.has(id)) errors.push(`lock completeness: unexpected ${id}`);
  if (HEX_256.test(lock.manifestRevision || '') && lock.manifestRevision !== sha256File(project.paths.manifest)) {
    errors.push('lock: manifestRevision does not match .sync/plugins.json');
  }

  for (const entry of entries) {
    const item = lock.plugins?.[entry.id];
    if (item === undefined) continue;
    const pointer = `lock ${entry.id}`;
    if (!isObject(item)) {
      errors.push(`${pointer}: expected an object`);
      continue;
    }
    const directory = packageRoot(project.paths.root, entry);
    let pkg;
    try { pkg = readJson(path.join(directory, 'package.json'), `${entry.id} package.json`); } catch (error) {
      errors.push(error.message);
      continue;
    }
    const snapshot = treeSnapshot(directory);
    const patches = Array.isArray(entry.sync?.patches) ? entry.sync.patches : [];
    let patchHash;
    try { patchHash = patchSetSha256(project.paths.root, patches); } catch (error) {
      errors.push(`${pointer}: ${error.message}`);
      continue;
    }
    if (!isObject(item.local)) {
      errors.push(`${pointer}: local lock record is missing`);
      continue;
    }
    if (item.local.path !== entry.path) errors.push(`${pointer}: local path differs from manifest`);
    if (item.local.packageName !== pkg.name || item.local.packageName !== entry.packageName) errors.push(`${pointer}: package name differs from manifest/package.json`);
    if (item.local.packageVersion !== pkg.version) errors.push(`${pointer}: package version differs from package.json`);
    if (item.local.license !== packageLicense(pkg) || item.local.license !== entry.license.expected) errors.push(`${pointer}: license differs from manifest/package.json`);
    if (stableJson(item.local.entrypoints) !== stableJson(entry.validation.entrypoints)) errors.push(`${pointer}: entrypoints differ from manifest`);
    if (!HEX_256.test(item.local.treeSha256 || '')) errors.push(`${pointer}: tree digest is missing or malformed`);
    else if (item.local.treeSha256 !== snapshot.treeSha256) errors.push(`${pointer}: tree digest mismatch`);
    if (item.local.fileCount !== snapshot.files.length) errors.push(`${pointer}: file count mismatch`);
    if (stableJson(item.local.excludedPaths || []) !== stableJson(snapshot.excludedPaths)) errors.push(`${pointer}: excluded forbidden paths changed`);
    const expectedSource = resolvedSource(entry, pkg, snapshot.treeSha256);
    if (!isObject(item.source)) {
      errors.push(`${pointer}: source identity/resolution is missing`);
    } else {
      // A fetched artifact may add immutable archive evidence to the lock.
      // Manifest-derived identity must still match exactly; optional evidence
      // is checked for shape without being silently discarded.
      for (const key of Object.keys(expectedSource)) {
        if (stableJson(item.source[key]) !== stableJson(expectedSource[key])) {
          errors.push(`${pointer}: source identity/resolution differs from manifest or local package`);
          break;
        }
      }
      if (item.source.archiveSha256 !== undefined && !HEX_256.test(item.source.archiveSha256)) {
        errors.push(`${pointer}: archive SHA-256 is malformed`);
      }
      if (item.source.integrity !== undefined
        && (typeof item.source.integrity !== 'string'
          || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/.test(item.source.integrity))) {
        errors.push(`${pointer}: archive integrity is malformed`);
      }
      if (item.source.tarball !== undefined && typeof item.source.tarball !== 'string') {
        errors.push(`${pointer}: tarball reference must be a string`);
      }
    }
    if (item.sourceCommit !== (entry.request.commit || null)) {
      errors.push(`${pointer}: sourceCommit differs from manifest`);
    }
    if (!HEX_256.test(item.patchSetSha256 || '') || item.patchSetSha256 !== patchHash) errors.push(`${pointer}: patch-set digest mismatch`);
    if (stableJson(item.patchFiles || []) !== stableJson(patchSetFiles(project.paths.root, patches))) errors.push(`${pointer}: patch file list mismatch`);
    if (patches.length === 0 && item.patchSet !== 'none') errors.push(`${pointer}: empty patch set must be recorded as none`);
    if (patches.length > 0 && item.patchSet !== `sha256:${patchHash}`) errors.push(`${pointer}: patch-set identifier mismatch`);
    const expectedRequested = lockedRequest(entry, pkg);
    if (!expectedRequested) errors.push(`${pointer}: exact lock resolution is missing a version or commit`);
    if (item.requested !== expectedRequested) errors.push(`${pointer}: requested version/commit differs from manifest`);
    if (item.requested === 'latest') errors.push(`${pointer}: formal lock must not contain latest`);
    if (item.runtimeUpdate !== (entry.runtimeUpdate.allowed ? 'enabled' : 'disabled')) errors.push(`${pointer}: runtime update policy differs from manifest`);
    if (item.manifestEntrySha256 !== sha256Text(stableJson(entry))) errors.push(`${pointer}: manifest entry digest mismatch`);
    if (entry.request.mode === 'latest' && item.source?.version !== pkg.version) errors.push(`${pointer}: latest resolution is not pinned to a local exact version`);
    if (entry.request.mode === 'exact' && entry.request.version && item.source?.version !== entry.request.version) errors.push(`${pointer}: exact source version mismatch`);
    if (entry.request.commit && item.source?.commit !== entry.request.commit) errors.push(`${pointer}: exact source commit mismatch`);
    if (item.source?.kind !== entry.source.kind) errors.push(`${pointer}: source kind differs from manifest`);
    if (item.local.files) {
      const forbidden = item.local.files.filter((file) => normalizeSlashes(file).split('/').some((part) => FORBIDDEN_NAMES.has(part)));
      if (forbidden.length > 0) errors.push(`${pointer}: lock attempts to include forbidden files ${forbidden.join(', ')}`);
    }
  }
  return errors;
}

export function validateLocked(root = DEFAULT_ROOT) {
  const manifestResult = validateManifest(root);
  const project = loadProject(root);
  if (!existsSync(project.paths.lock)) fail('lock: .sync/plugins.lock.json is missing');
  const lock = readJson(project.paths.lock, 'lock');
  const errors = validateLockInternal(project, manifestResult, lock);
  try {
    generateRegistry(root, { check: true });
  } catch (error) {
    errors.push(error.message);
  }
  if (errors.length > 0) throw new ValidationFailure(errors);
  return {
    root: project.paths.root,
    lock,
    counts: { entries: Object.keys(lock.plugins).length },
  };
}

function sourceReferenceFor(prepared) {
  const packageFile = path.join(prepared.sourceRoot, 'package.json');
  const packageJson = readJson(packageFile, 'sync source package.json');
  const repository = packageRepository(packageJson);
  return repository ? { repository } : {};
}

function applyPatchSet(candidateRoot, root, entry) {
  const patches = Array.isArray(entry.sync?.patches) ? entry.sync.patches : [];
  if (entry.sync?.mode !== 'patch-rebase') {
    if (patches.length > 0) fail(`sync ${entry.id}: patches require patch-rebase mode`, 'patch');
    return;
  }
  if (patches.length === 0) return;

  const patchFiles = patches.flatMap((declared) => resolvePatchMatches(root, declared));
  const args = [
    'apply',
    '--check',
    '--recount',
    '--whitespace=nowarn',
    ...patchFiles.map((patch) => patch.absolutePath),
  ];
  const check = spawnSync('git', args, { cwd: candidateRoot, encoding: 'utf8' });
  if (check.error || check.status !== 0) {
    const details = String(check.stderr || check.stdout || check.error?.message || '').trim();
    fail(
      `sync ${entry.id}: patch conflict or invalid patch-set${details ? `: ${details}` : ''}`,
      'patch',
    );
  }

  const applied = spawnSync(
    'git',
    ['apply', '--recount', '--whitespace=nowarn', ...patchFiles.map((patch) => patch.absolutePath)],
    { cwd: candidateRoot, encoding: 'utf8' },
  );
  if (applied.error || applied.status !== 0) {
    const details = String(applied.stderr || applied.stdout || applied.error?.message || '').trim();
    fail(
      `sync ${entry.id}: patch-set was not completely applied${details ? `: ${details}` : ''}`,
      'patch',
    );
  }
}

function materializeCandidate(sourceRoot, destination, preservePaths, temporaryRoot) {
  const candidateRoot = mkdtempSync(path.join(
    path.resolve(temporaryRoot),
    `${path.basename(path.resolve(destination))}.candidate-`,
  ));
  try {
    copyTreeContents(sourceRoot, candidateRoot);
    copyPreservedPaths(destination, candidateRoot, preservePaths);
    return candidateRoot;
  } catch (error) {
    try { rmSync(candidateRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function assertCandidatePaths(entry, candidateRoot) {
  const forbidden = sourceTreeForbiddenPaths(candidateRoot);
  if (forbidden.length > 0) {
    fail(`sync ${entry.id}: candidate contains forbidden paths: ${forbidden.join(', ')}`, 'source');
  }
}

function assertPreservePaths(entry, currentRoot, candidateRoot) {
  const currentSnapshot = treeSnapshot(currentRoot);
  const candidateSnapshot = treeSnapshot(candidateRoot);
  const preservePaths = Array.isArray(entry.sync?.preservePaths) ? entry.sync.preservePaths : [];
  const unaccounted = [];
  for (const currentPath of currentSnapshot.files) {
    if (!candidateSnapshot.files.includes(currentPath)
      && !preservePaths.some((pattern) => pathMatchesPattern(pattern, currentPath))) {
      unaccounted.push(currentPath);
    }
  }
  if (unaccounted.length > 0) {
    fail(
      `sync ${entry.id}: local extra files are not listed in preservePaths: ${unaccounted.join(', ')}`,
      'preserve',
    );
  }
}

function promoteDirectory(candidateRoot, destination) {
  const target = path.resolve(destination);
  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const staged = `${target}.new-${token}`;
  const backup = `${target}.old-${token}`;
  renameSync(candidateRoot, staged);
  let movedOld = false;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      movedOld = true;
    }
    renameSync(staged, target);
    if (movedOld) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    try { if (existsSync(staged)) rmSync(staged, { recursive: true, force: true }); } catch { /* preserve diagnostics */ }
    if (movedOld && !existsSync(target)) {
      try { renameSync(backup, target); } catch { /* preserve diagnostics */ }
    }
    throw error;
  }
}

function lockEntryForSync(root, entry, artifact = {}) {
  const project = loadProject(root);
  const directory = packageRoot(root, entry);
  const packageJson = readJson(path.join(directory, 'package.json'), `${entry.id} package.json`);
  const snapshot = treeSnapshot(directory);
  const patches = Array.isArray(entry.sync?.patches) ? entry.sync.patches : [];
  const patchHash = patchSetSha256(root, patches);
  const source = resolvedSource(entry, packageJson, snapshot.treeSha256, artifact);
  const lock = buildLock(root);
  lock.plugins[entry.id] = {
    requested: lockedRequest(entry, packageJson),
    source,
    local: {
      path: entry.path,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      license: packageLicense(packageJson),
      entrypoints: entry.validation.entrypoints,
      treeSha256: snapshot.treeSha256,
      fileCount: snapshot.files.length,
      excludedPaths: snapshot.excludedPaths,
    },
    sourceCommit: artifact.sourceCommit || entry.request.commit || null,
    patchSet: patches.length > 0 ? `sha256:${patchHash}` : 'none',
    patchSetSha256: patchHash,
    patchFiles: patchSetFiles(root, patches),
    compatibility: {},
    runtimeUpdate: entry.runtimeUpdate.allowed ? 'enabled' : 'disabled',
    manifestEntrySha256: sha256Text(stableJson(entry)),
  };
  return lock;
}

function updateManifestEntry(entry, resolution, artifact) {
  const updated = { ...entry, request: { mode: 'exact' } };
  const resolvedVersion = artifact.resolvedVersion || resolution.version;
  if (resolvedVersion) updated.request.version = resolvedVersion;
  if (resolution.commit) updated.request.commit = resolution.commit;
  if (!updated.request.version && !updated.request.commit) {
    fail(`sync ${entry.id}: exact resolution did not produce a version or commit`, 'validation');
  }
  return updated;
}

function replaceManifestEntry(manifest, updatedEntry) {
  const output = structuredClone(manifest);
  for (const inventory of INVENTORY_ROOTS) {
    const items = Array.isArray(output[inventory.manifestKey]) ? output[inventory.manifestKey] : [];
    const index = items.findIndex((item) => item.id === updatedEntry.id);
    if (index >= 0) {
      items[index] = updatedEntry;
      return output;
    }
  }
  fail(`sync ${updatedEntry.id}: manifest entry disappeared`, 'validation');
}

async function syncEntry(root, project, entry, flags) {
  const resolution = requestedResolution(entry, flags);
  const destination = packageRoot(root, entry);
  const currentPackage = readJson(path.join(destination, 'package.json'), `${entry.id} package.json`);
  const reportBase = {
    id: entry.id,
    syncMode: entry.sync?.mode,
    mode: resolution.mode,
    requested: resolution.requested,
    currentVersion: currentPackage.version,
  };

  if (entry.sync?.mode === 'metadata-only') {
    return {
      ...reportBase,
      action: 'manual-review',
      wouldWrite: false,
      reason: 'metadata-only entries are not source synchronized',
      networkAccessed: false,
    };
  }
  if (entry.sync?.mode === 'manual' || entry.class === 'manual' || entry.class === 'internal'
    || entry.source?.kind === 'internal' || entry.source?.kind === 'unknown') {
    return {
      ...reportBase,
      syncMode: entry.sync?.mode || 'manual',
      action: 'manual-review',
      wouldWrite: false,
      reason: entry.source?.reason || 'manual/internal entry requires an explicit human PR',
      networkAccessed: false,
    };
  }

  const prepared = await prepareSource(entry, resolution, flags);
  if (!prepared) {
    return {
      ...reportBase,
      source: entry.source,
      action: 'candidate-only',
      wouldWrite: false,
      networkAccessed: false,
    };
  }

  const destinationForbidden = sourceTreeForbiddenPaths(destination);
  if (destinationForbidden.length > 0) {
    fail(
      `sync ${entry.id}: destination contains forbidden paths: ${destinationForbidden.join(', ')}`,
      'source',
    );
  }

  let candidate;
  try {
    candidate = materializeCandidate(
      prepared.sourceRoot,
      destination,
      entry.sync?.preservePaths || [],
      project.paths.sync,
    );
  } catch (error) {
    if (prepared.cleanup) {
      try { rmSync(prepared.cleanup, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    throw error;
  }
  const cleanup = () => {
    try { rmSync(candidate, { recursive: true, force: true }); } catch { /* best effort */ }
    if (prepared.cleanup) {
      try { rmSync(prepared.cleanup, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };

  try {
    const expectedVersion = resolution.version || prepared.artifact.resolvedVersion || null;
    const sourceReference = sourceReferenceFor(prepared);
    const checked = candidatePackageErrors(
      entry,
      candidate,
      destination,
      entry.sync?.mode,
      expectedVersion,
      sourceReference,
    );
    if (checked.errors.length > 0) throw new ValidationFailure(checked.errors);
    assertPreservePaths(entry, destination, candidate);
    applyPatchSet(candidate, root, entry);
    assertCandidatePaths(entry, candidate);
    const postPatch = candidatePackageErrors(
      entry,
      candidate,
      destination,
      entry.sync?.mode,
      expectedVersion,
      sourceReference,
    );
    if (postPatch.errors.length > 0) throw new ValidationFailure(postPatch.errors);

    const diff = treeDiff(destination, candidate);
    const treeChanged = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
    if (entry.sync?.mode === 'patch-rebase'
      && (!Array.isArray(entry.sync.patches) || entry.sync.patches.length === 0)
      && treeChanged) {
      fail(`sync ${entry.id}: patch-rebase requires an explicit patch-set for upstream changes`, 'patch');
    }

    const artifact = { ...prepared.artifact };
    if (!artifact.resolvedVersion) artifact.resolvedVersion = postPatch.packageJson.version;
    const updatedEntry = updateManifestEntry(entry, resolution, artifact);
    const updatedManifest = replaceManifestEntry(project.manifest, updatedEntry);

    if (flags.get('dry-run')) {
      return {
        ...reportBase,
        resolvedVersion: artifact.resolvedVersion,
        source: entry.source,
        action: 'candidate-only',
        wouldWrite: treeChanged || stableJson(project.manifest) !== stableJson(updatedManifest),
        diff,
        networkAccessed: prepared.networkAccessed,
      };
    }

    const manifestTarget = project.paths.manifest;
    const manifestText = prettyJson(updatedManifest);
    const manifestUnchanged = stableJson(project.manifest) === stableJson(updatedManifest);
    if (!treeChanged && manifestUnchanged && existsSync(project.paths.lock)) {
      try {
        validateLocked(root);
        return {
          ...reportBase,
          resolvedVersion: artifact.resolvedVersion,
          source: entry.source,
          action: 'no-change',
          wouldWrite: false,
          diff,
          networkAccessed: prepared.networkAccessed,
        };
      } catch (error) {
        fail(`sync ${entry.id}: unchanged candidate lock check failed: ${error.message}`, 'validation');
      }
    }

    const oldManifest = readFileSync(manifestTarget);
    const oldLock = existsSync(project.paths.lock) ? readFileSync(project.paths.lock) : null;
    const oldRegistry = existsSync(project.paths.registry) ? readFileSync(project.paths.registry) : null;
    const oldTree = mkdtempSync(path.join(
      project.paths.sync,
      `${path.basename(path.resolve(destination))}.old-tree-`,
    ));
    copyTreeContents(destination, oldTree);
    try {
      promoteDirectory(candidate, destination);
      writeFileAtomic(manifestTarget, manifestText);
      generateRegistry(root);
      const lock = lockEntryForSync(root, updatedEntry, artifact);
      writeJsonAtomic(project.paths.lock, lock);
      validateLocked(root);
    } catch (error) {
      try { promoteDirectory(oldTree, destination); } catch { /* preserve diagnostics */ }
      writeFileAtomic(manifestTarget, oldManifest);
      if (oldLock) writeFileAtomic(project.paths.lock, oldLock);
      else rmSync(project.paths.lock, { force: true });
      if (oldRegistry) writeFileAtomic(project.paths.registry, oldRegistry);
      else rmSync(project.paths.registry, { force: true });
      throw error;
    } finally {
      try { rmSync(oldTree, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    project.manifest = updatedManifest;
    return {
      ...reportBase,
      resolvedVersion: artifact.resolvedVersion,
      source: entry.source,
      action: 'applied',
      wouldWrite: true,
      diff,
      networkAccessed: prepared.networkAccessed,
    };
  } finally {
    cleanup();
  }
}

function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check' || arg === '--dry-run' || arg === '--locked') flags.set(arg.slice(2), true);
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`missing value for --${key}`, 'usage');
      flags.set(key, value);
      index += 1;
    } else positionals.push(arg);
  }
  return { flags, positionals };
}

function printManifestReport(result) {
  console.log(`manifest valid: plugins=${result.counts.plugins} skins=${result.counts.skins} sdkPlugins=${result.counts.sdkPlugins}`);
}

export async function runSync(root, flags) {
  const validated = validateManifest(root);
  const project = loadProject(root);
  const requestedPlugin = flags.get('plugin');
  if (typeof requestedPlugin !== 'string' || !requestedPlugin) fail('sync requires --plugin <id|all>', 'usage');
  const selected = requestedPlugin === 'all'
    ? validated.entries
    : validated.entries.filter((entry) => entry.id === requestedPlugin);
  if (selected.length === 0) fail(`sync plugin is not in manifest: ${requestedPlugin}`, 'usage');

  const reports = [];
  let networkAccessed = false;
  for (const entry of selected.sort((a, b) => byteCompare(a.id, b.id))) {
    const report = await syncEntry(root, project, entry, flags);
    reports.push(report);
    networkAccessed ||= Boolean(report.networkAccessed);
  }
  return {
    dryRun: Boolean(flags.get('dry-run')),
    networkAccessed,
    candidates: reports,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positionals } = parseArgs(argv);
  const command = positionals[0];
  const root = path.resolve(String(flags.get('root') || DEFAULT_ROOT));
  if (!command) fail('a command is required: validate-manifest, validate, generate-registry, generate-lock, sync', 'usage');
  if (command === 'validate-manifest') {
    printManifestReport(validateManifest(root));
    return 0;
  }
  if (command === 'validate') {
    if (!flags.get('locked')) fail('validate currently requires --locked', 'usage');
    const result = validateLocked(root);
    console.log(`lock valid: entries=${result.counts.entries}`);
    return 0;
  }
  if (command === 'generate-registry') {
    const result = generateRegistry(root, { check: Boolean(flags.get('check')) });
    console.log(`${result.checked ? 'generated registry valid' : 'generated registry written'}: ${relativePosix(root, result.file)}`);
    return 0;
  }
  if (command === 'generate-lock') {
    const project = loadProject(root);
    const lock = buildLock(root);
    writeJsonAtomic(project.paths.lock, lock);
    console.log(`lock written: ${relativePosix(root, project.paths.lock)} entries=${Object.keys(lock.plugins).length}`);
    return 0;
  }
  if (command === 'sync') {
    const report = await runSync(root, flags);
    if (report !== undefined) console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  fail(`unknown command: ${command}`, 'usage');
}

const isMain = path.resolve(process.argv[1] || '') === path.resolve(SCRIPT_FILE);
if (isMain) {
  try {
    const status = await main();
    process.exitCode = status;
  } catch (error) {
    const code = error?.code === 'usage' ? 2 : error?.code === 'unsupported' ? 2 : 1;
    console.error(`plugin-sync: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = code;
  }
}

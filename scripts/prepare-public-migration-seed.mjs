import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { inspectSeedTree, inspectPublicConfig, inspectSeedArtifact } from './public-seed-privacy.mjs';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
const require = createRequire(path.join(repo, 'package.json'));
const yaml = require('js-yaml');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const publicConfigs = ['README.md', 'settings.yaml', 'profiles/web-desktop/package.json',
  'profiles/web-desktop/cordis.yml', 'profiles/web-desktop/cordis.patch.yml'];
const currentProfileConfigs = new Set([
  'profiles/web-desktop/cordis.yml',
  'profiles/web-desktop/cordis.patch.yml',
]);
const profileRelative = 'profiles/web-desktop';
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function plainPath(file) {
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('linked path rejected');
  }
  return absolute;
}

export function disjointPaths(...paths) {
  const resolved = paths.map(plainPath);
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      for (const [a, b] of [[resolved[i], resolved[j]], [resolved[j], resolved[i]]]) {
        const relative = path.relative(a, b);
        if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
          throw new Error('overlapping inputs or outputs rejected');
        }
      }
    }
  }
}

export function treeBinding(root) {
  const entries = [];
  let totalBytes = 0;
  function walk(relative) {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (entries.length >= 200000 || stat.isSymbolicLink()) throw new Error('unsupported or oversized input tree');
    if (stat.isDirectory()) {
      entries.push({ path: relative, directory: true });
      for (const name of fs.readdirSync(file).sort()) walk(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      totalBytes += stat.size;
      if (stat.size > 128 * 1024 ** 2 || totalBytes > 4 * 1024 ** 3) throw new Error('oversized input tree');
      entries.push({ path: relative, bytes: stat.size, sha256: sha(fs.readFileSync(file)) });
    } else throw new Error('unsupported input entry');
  }
  plainPath(root);
  walk('');
  return { digest: sha(JSON.stringify(entries)), files: entries.filter(entry => !entry.directory).length, totalBytes, entries };
}

function publicScan(seed) {
  const files = inspectSeedTree(seed);
  for (const { file, relative } of files) {
    const bytes = fs.readFileSync(file);
    try {
      inspectSeedArtifact(relative, bytes);
      if (publicConfigs.includes(relative) && relative !== 'README.md') inspectPublicConfig(yaml.load(bytes.toString('utf8')));
    } catch {
      // Paths here are within a proven public tree, never a user's profile.
      throw new Error(`public content validation failed: ${relative}`);
    }
  }
  const settings = yaml.load(fs.readFileSync(path.join(seed, 'settings.yaml'), 'utf8'));
  if (Object.keys(settings).sort().join(',') !== 'status-rotator,webui-modules') {
    throw new Error('unexpected public settings sections');
  }
  return files.length;
}

export function isolatedEnvironment(work) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT)$/i.test(key)));
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) env[name] = work;
  env.DSH_HOME = path.join(work, 'home');
  env.DSH_DESKTOP_USERDATA = path.join(work, 'user-data');
  env.NODE_PATH = path.join(repo, 'node_modules');
  return env;
}

function runNode(args, work, label, env = isolatedEnvironment(work)) {
  const result = childProcess.spawnSync(process.execPath, args, {
    cwd: repo, env, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 ** 2,
  });
  fs.writeFileSync(path.join(work, `${label}.log`), `${result.stdout || ''}${result.stderr || ''}`, { flag: 'wx' });
  if (result.error || result.status !== 0) throw new Error(`${label} failed; retained work log has details`);
  return { executable: process.execPath, args, exitCode: result.status };
}

function restrictWorker(work) {
  // The migration boundary checks lstat each ancestor. Node permissions grant
  // directories recursively, so do not grant CODEX (which contains private homes).
  // Supply only the plain-directory metadata attested by the parent before spawn.
  const ancestors = readJson(path.join(work, 'ancestor-metadata.json'));
  for (const [ancestor, metadata] of Object.entries(ancestors)) {
    if (metadata.directory !== true || ![repo, work].some(root => {
      const rel = path.relative(ancestor, root);
      return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    })) throw new Error('invalid ancestor metadata attestation');
  }
  const lstat = fs.lstatSync;
  const exists = fs.existsSync;
  const key = file => path.resolve(String(file)).toLowerCase();
  fs.lstatSync = (file, options) => Object.hasOwn(ancestors, key(file))
    ? { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
    : lstat(file, options);
  fs.existsSync = file => Object.hasOwn(ancestors, key(file)) || exists(file);
  const disabled = () => { throw new Error('public sync worker cannot launch processes or use network'); };
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) childProcess[name] = disabled;
  net.Server.prototype.listen = disabled;
  net.Socket.prototype.connect = disabled;
  net.connect = net.createConnection = disabled;
  http.request = http.get = https.request = https.get = disabled;
  dgram.createSocket = disabled;
  globalThis.fetch = disabled;
  syncBuiltinESMExports();
}

function syncWorker(work) {
  restrictWorker(work);
  if (fs.readdirSync(path.join(work, 'user-data')).length
      || treeBinding(path.join(work, 'home')).digest !== readJson(path.join(work, 'base-files.json')).digest) {
    throw new Error('sync worker requires the untouched public base and empty user-data');
  }
  const runtime = path.join(work, 'runtime');
  const { createDesktopCore } = require(path.join(runtime, 'desktop-core.js'));
  const logs = [];
  const core = createDesktopCore({
    appRoot: repo, userDataDir: path.join(work, 'user-data'), logsDir: path.join(work, 'logs'),
    dshHome: path.join(work, 'home'),
    nodeExe: () => path.join(work, 'process-launch-disabled'),
    npmCli: () => path.join(work, 'process-launch-disabled'),
    log: (tag, message) => { logs.push({ tag, message }); console.log(`[${tag}] ${message}`); },
    notify: (title, message) => { logs.push({ tag: 'notification', message: `${title}: ${message}` }); },
  });
  const result = core.syncAll();
  if (core.managedPackageNames().includes('dsh-aio-ui-compat')) {
    throw new Error('compat must remain bound to the reviewed base, not current UI sources');
  }
  const packages = core.managedPackageNames().map(name => {
    const manifest = readJson(path.join(work, 'home', profileRelative, 'node_modules', name, 'package.json'));
    if (manifest.name !== name) throw new Error('managed companion identity mismatch');
    return { name, version: manifest.version };
  });
  if (result?.ok !== true || logs.some(({ message }) => /failed|error|\u5931\u8d25|\u65e0\u6548|\u9519\u8bef/i.test(message))) {
    throw new Error('desktop sync reported incomplete work');
  }
  const loadedModules = Object.keys(require.cache).sort().map(file => ({
    file, sha256: sha(fs.readFileSync(file)),
  }));
  writeJson(path.join(work, 'sync-result.json'), {
    method: 'createDesktopCore(...).syncAll()', result, packages, loadedModules,
    serverStarted: false, childProcessesAllowed: false, networkAllowed: false,
  });
  console.log(`Synced ${packages.length} companion/skin packages`);
}

function sourceBinding() {
  // Compat comes exclusively from the reviewed base. Its in-progress source is
  // not consumed by desktop companion sync and must not masquerade as a seed input.
  const plugins = fs.readdirSync(path.join(repo, 'assets/plugins'), { withFileTypes: true })
    .filter(entry => entry.name !== 'dsh-aio-ui-compat').map(entry => `assets/plugins/${entry.name}`).sort();
  const trees = ['sidecar/src', ...plugins, 'assets/skins', 'assets/agent-presets',
    'tauri-app/node_modules/typescript', 'node_modules/js-yaml', 'node_modules/resolve.exports',
    'node_modules/@types/node', 'node_modules/undici-types'];
  const officialManifests = fs.readdirSync(path.join(repo, 'node_modules/@deepseek-ai'))
    .map(name => `node_modules/@deepseek-ai/${name}/package.json`)
    .filter(relative => fs.existsSync(path.join(repo, relative))).sort();
  const files = ['package.json', 'package-lock.json', 'sidecar/tsconfig.json',
    'scripts/prepare-public-migration-seed.mjs', 'scripts/sanitize-public-seed.mjs',
    'scripts/public-seed-privacy.mjs', 'scripts/public-seed-reviewed-content.mjs',
    ...[...currentProfileConfigs].map(relative => `distribution/profile-seed/${relative}`),
    ...officialManifests];
  return {
    trees: Object.fromEntries(trees.map(relative => [relative, treeBinding(path.join(repo, relative))])),
    files: Object.fromEntries(files.map(relative => [relative, sha(fs.readFileSync(path.join(repo, relative)))])),
  };
}

export function publicCompanionText(relative, text) {
  const skin = /^profiles\/web-desktop\/node_modules\/@linxin666\/dsh-client-ui-skin-(blue-fantasy|dragon-heir|miku|minecraft|qq98|ths|trading|whale-song|xp)\/lib\/client\.js$/;
  const sidebar = /^profiles\/web-desktop\/node_modules\/dsh-better-sidebar\/lib\/(client(?:-editor|-registry|-terminal)?|index)\.js$/;
  if (!skin.test(relative) && !sidebar.test(relative)) return text;
  return text.replace(/^([ \t]*)\/\/#region \\0dsh-css:[^\r\n]*/gm, '$1//#region dsh-css:public-source')
    .replace('(e.g. `C:\\Users\\Me` vs `c:/users/me/file.png`).', '(e.g. differing path case and separators).');
}

function cleanCompanionComments(stage, frozen) {
  const ts = require(path.join(frozen, 'tauri-app/node_modules/typescript'));
  const printer = ts.createPrinter({ removeComments: true });
  const executable = text => printer.printFile(ts.createSourceFile('public.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  const changes = [];
  for (const { relative, file } of inspectSeedTree(stage)) {
    if (!relative.endsWith('.js')) continue;
    const before = fs.readFileSync(file);
    const text = before.toString('utf8');
    const cleaned = publicCompanionText(relative, text);
    if (cleaned === text) continue;
    if (executable(text) !== executable(cleaned)) throw new Error('companion comment cleanup changed executable code');
    const after = Buffer.from(cleaned);
    changes.push({ path: relative, before: sha(before), after: sha(after), method: 'public source comments only; TS comment-free AST print identical' });
    fs.writeFileSync(file, after);
  }
  return changes;
}

export function buildPublicMigrationSeed({ base, output, work, expectedBaseDigest }) {
  base = plainPath(base);
  output = plainPath(output);
  work = plainPath(work);
  disjointPaths(repo, base, output, work);
  if (!['aio-1.2.0-public-seed-20260908-r4', 'aio-1.2.0-public-seed-20260908-r5',
    'aio-1.2.0-public-seed-20260908-r6', 'aio-1.2.0-public-seed-20260908-r7',
    'aio-1.2.0-public-seed-20260908-r8', 'aio-9.6.3-public-seed'].includes(path.basename(base))) {
    throw new Error('only the named reviewed public r4, r5, r6, r7 or r8 seed is accepted');
  }
  if (fs.existsSync(output) || fs.existsSync(work)) throw new Error('output and work must be NEW directories');
  if (!/^[a-f0-9]{64}$/.test(expectedBaseDigest || '')) throw new Error('explicit reviewed base digest required');
  const baseBinding = treeBinding(base);
  if (baseBinding.digest !== expectedBaseDigest) throw new Error('reviewed base digest mismatch');
  publicScan(base);
  const sources = sourceBinding();
  fs.mkdirSync(work);
  const ancestors = {};
  for (const root of [repo, work]) {
    let cursor = path.dirname(root);
    while (cursor !== path.dirname(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid ancestor');
      ancestors[cursor.toLowerCase()] = { directory: true };
      cursor = path.dirname(cursor);
    }
  }
  writeJson(path.join(work, 'ancestor-metadata.json'), ancestors);
  writeJson(path.join(work, 'base-files.json'), baseBinding);
  writeJson(path.join(work, 'source-files.json'), sources);
  const frozen = path.join(work, 'frozen-source');
  fs.mkdirSync(frozen);
  for (const relative of Object.keys(sources.trees)) {
    const target = path.join(frozen, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(repo, relative), target, { recursive: true, force: false, errorOnExist: true });
    if (treeBinding(target).digest !== sources.trees[relative].digest) throw new Error('source changed while freezing');
  }
  for (const [relative, digest] of Object.entries(sources.files)) {
    const target = path.join(frozen, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, relative), target, fs.constants.COPYFILE_EXCL);
    if (sha(fs.readFileSync(target)) !== digest) throw new Error('source file changed while freezing');
  }
  if (sha(JSON.stringify(sourceBinding())) !== sha(JSON.stringify(sources))) {
    throw new Error('public inputs changed while freezing; refusing mixed snapshot');
  }
  const frozenBinding = treeBinding(frozen);
  writeJson(path.join(work, 'frozen-files.json'), frozenBinding);
  fs.cpSync(base, path.join(work, 'home'), { recursive: true, force: false, errorOnExist: true });
  for (const name of ['user-data', 'logs']) fs.mkdirSync(path.join(work, name));
  const commands = [];
  const frozenEnv = { ...isolatedEnvironment(work), NODE_PATH: path.join(frozen, 'node_modules') };
  const frozenScript = path.join(frozen, 'scripts/prepare-public-migration-seed.mjs');
  commands.push(runNode([
    path.join(frozen, 'tauri-app/node_modules/typescript/bin/tsc'),
    '-p', path.join(frozen, 'sidecar/tsconfig.json'), '--outDir', path.join(work, 'runtime'),
  ], work, 'compile', frozenEnv));
  const runtimeBinding = treeBinding(path.join(work, 'runtime'));
  writeJson(path.join(work, 'runtime-files.json'), runtimeBinding);
  commands.push(runNode([
    '--permission', `--allow-fs-read=${work}`, `--allow-fs-write=${work}`,
    frozenScript, '--sync-worker', work,
  ], work, 'desktop-sync', frozenEnv));
  const stage = path.join(work, 'public-seed');
  fs.mkdirSync(path.join(stage, profileRelative), { recursive: true });
  // Root public defaults remain byte-identical to the reviewed base. The profile
  // manifest and patch files come from the current reviewed source so removed
  // plugins cannot survive through an older seed. Sync bookkeeping, presets,
  // guard snapshots and temporary home settings are never published.
  for (const relative of publicConfigs) {
    const source = currentProfileConfigs.has(relative)
      ? path.join(frozen, 'distribution/profile-seed', relative)
      : path.join(base, relative);
    fs.copyFileSync(source, path.join(stage, relative), fs.constants.COPYFILE_EXCL);
  }
  fs.cpSync(path.join(work, 'home', profileRelative, 'node_modules'), path.join(stage, profileRelative, 'node_modules'),
    { recursive: true, force: false, errorOnExist: true });
  const commentCleanup = cleanCompanionComments(stage, frozen);
  publicScan(stage);
  commands.push(runNode([path.join(frozen, 'scripts/sanitize-public-seed.mjs'), frozen],
    work, 'sanitize', { ...frozenEnv, DSH_PROFILE_SEED_DIR: stage }));
  for (const relative of publicConfigs) {
    const expected = currentProfileConfigs.has(relative)
      ? path.join(frozen, 'distribution/profile-seed', relative)
      : path.join(base, relative);
    if (!fs.readFileSync(expected).equals(fs.readFileSync(path.join(stage, relative)))) {
      throw new Error('reviewed public config bytes changed');
    }
  }
  const compatRelative = path.join(profileRelative, 'node_modules/dsh-aio-ui-compat');
  if (treeBinding(path.join(base, compatRelative)).digest !== treeBinding(path.join(stage, compatRelative)).digest) {
    throw new Error('reviewed base compat changed');
  }
  commands.push(runNode([
    '--permission', `--allow-fs-read=${work}`, `--allow-fs-write=${work}`,
    frozenScript, '--inspect-worker', work,
  ], work, 'inspect-migration-seed', frozenEnv));
  const inspection = readJson(path.join(work, 'migration-inspection.json'));
  const outputBinding = treeBinding(stage);
  if (treeBinding(base).digest !== baseBinding.digest || treeBinding(frozen).digest !== frozenBinding.digest
      || treeBinding(path.join(work, 'runtime')).digest !== runtimeBinding.digest) {
    throw new Error('public inputs changed during build; refusing publication');
  }
  if (fs.existsSync(output)) throw new Error('output appeared during build; refusing publication');
  fs.renameSync(stage, output);
  const report = {
    schema: 1, purpose: 'offline migration seed; native UI/boot health not qualified; no health commit',
    invocation: { executable: process.execPath, cwd: repo, args: [script, '--base', base, '--output', output,
      '--work', work, '--expected-base-digest', expectedBaseDigest] },
    base: { path: base, treeDigest: baseBinding.digest },
    source: { repo, binding: sha(JSON.stringify(sources)), files: 'source-files.json',
      frozenPath: frozen, frozenDigest: frozenBinding.digest, snapshotConsistentAtFreeze: true },
    commands, runtime: { node: process.version, treeDigest: runtimeBinding.digest,
      compiler: readJson(path.join(frozen, 'tauri-app/node_modules/typescript/package.json')).version },
    sync: readJson(path.join(work, 'sync-result.json')),
    commentCleanup,
    output: { path: output, profilePath: path.join(output, profileRelative),
      treeDigest: outputBinding.digest, migrationDigest: inspection.digest,
      files: outputBinding.files, bytes: outputBinding.totalBytes, target: inspection.target },
    validation: { publicPrivacy: 'passed', inspectMigrationSeedVerifyReferences: true,
      reviewedConfigBytesUnchanged: true, baseCompatUnchanged: true, consumedInputsUnchanged: true },
    exclusions: ['sync home settings', 'guard snapshots', 'presets', 'pnpm workspace', 'profile builtin marker'],
    unconsumedSource: ['assets/plugins/dsh-aio-ui-compat (compat supplied by reviewed base)'],
    nativeHealth: 'not tested; no native scripts or server executed',
  };
  writeJson(path.join(work, 'output-files.json'), outputBinding);
  writeJson(path.join(work, 'provenance.json'), report);
  console.log(JSON.stringify(report.output, null, 2));
  console.log('Public privacy scan and inspectMigrationSeed(profile, true) passed');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--sync-worker' && args.length === 2) syncWorker(path.resolve(args[1]));
    else if (args[0] === '--inspect-worker' && args.length === 2) {
      const work = path.resolve(args[1]);
      restrictWorker(work);
      const migration = require(path.join(work, 'runtime/lib/profile-seed-migration.js'));
      const result = migration.inspectMigrationSeed(path.join(work, 'public-seed', profileRelative), true);
      writeJson(path.join(work, 'migration-inspection.json'), result);
      console.log(JSON.stringify({ inspectMigrationSeedVerifyReferences: true, ...result }));
    }
    else if (args[0] === '--inspect-base' && args.length === 2) {
      publicScan(args[1]);
      const binding = treeBinding(args[1]);
      console.log(JSON.stringify({ path: path.resolve(args[1]), treeDigest: binding.digest, files: binding.files, bytes: binding.totalBytes }));
    } else {
      const options = {};
      const keys = { '--base': 'base', '--output': 'output', '--work': 'work', '--expected-base-digest': 'expectedBaseDigest' };
      for (let i = 0; i < args.length; i += 2) {
        const key = keys[args[i]];
        if (!key || !args[i + 1] || Object.hasOwn(options, key)) throw new Error('invalid arguments');
        options[key] = args[i + 1];
      }
      if (Object.keys(options).length !== 4) throw new Error('require --base --output --work --expected-base-digest');
      buildPublicMigrationSeed(options);
    }
  } catch (error) {
    console.error(error.stack);
    if (error.resource) console.error(`Denied resource: ${error.resource}`);
    process.exitCode = 1;
  }
}

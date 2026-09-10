// stage.ts —— V-D 打包 staging（新代码一律 TS）。
//
// 产出 tauri-app/resources/{app,node,npm}，与运行期路径解析严格对应：
//   · 打包后 appRoot = <resource>/app（paths.rs）
//   · NODE_EXE       = appRoot/../node/node.exe（shell-host 打包布局）
//   · NPM_CLI        = appRoot/../npm/bin/npm-cli.js
//
// app/ 内容：
//   · package.json + 生产依赖闭包 node_modules（npm ls --omit=dev --all --parseable）
//   · sidecar 运行时 JS 闭包（shell-host/desktop-core 及其全部本地依赖）
//   · scripts/{koffi-preflight.cjs,plugin-manager-patch.js}
//   · assets/**（插件/皮肤/preset —— 「万物皆插件」载体，原样拷贝零改动）
//   · bundle-manifest.json（与 src/integrity.rs build_bundle_manifest 同口径：
//     顶层包 + @scope 深度 2，键为完整包名，值为 {files: 计数}；符号链接计文件）
//
// 用法：node scripts/stage.ts （在 tauri-app/ 下；Node ≥24 原生跑 TS）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAURI_APP = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(TAURI_APP, '..');
const RESOURCES = path.join(TAURI_APP, 'resources');
const APP = path.join(RESOURCES, 'app');
const NM_SRC = path.join(REPO_ROOT, 'node_modules');
const PROFILE_SEED = process.env.DSH_PROFILE_SEED_DIR
  ? path.resolve(process.env.DSH_PROFILE_SEED_DIR)
  : path.join(REPO_ROOT, 'distribution', 'profile-seed');

// sidecar 运行时 = TypeScript 编译产物（sidecar/dist 整树，含 shell-host 与
// 全部 lib 模块）。构建顺序：npm run sidecar:build 先行，再跑本脚本。
const SIDECAR_DIST = path.join(REPO_ROOT, 'sidecar', 'dist');
// koffi 冒烟探针仍以独立 .cjs 脚本形态被 spawn（非 require）。
const SCRIPTS_JS = ['koffi-preflight.cjs'];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
  if (!fs.existsSync(p)) return;
  if (process.platform === 'win32') {
    // Some Windows filesystem/AV combinations acknowledge Node rmSync but keep
    // the tree. Use a constant PowerShell command with the path passed as a
    // positional argument; no project-controlled text is interpolated.
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '& { Remove-Item -LiteralPath $args[0] -Recurse -Force -ErrorAction Stop }',
      p,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  }
  if (fs.existsSync(p)) throw new Error(`无法清空旧 staging: ${p}`);
}

function copyFile(rel) {
  const src = path.join(REPO_ROOT, rel);
  const dst = path.join(APP, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

const releaseSkip = { files: 0, dirs: 0, bytes: 0 };

function skipReleaseFile(name) {
  const ext = path.extname(name).toLowerCase();
  return ext === '.map' || ext === '.pdb' || /\.d\.(?:c|m)?ts$/i.test(name);
}

function copyTree(src, dst) {
  const stat = fs.statSync(src);
  const nativeBuild = src.replace(/\\/g, '/').match(/\/node_modules\/fs-ext\/build(\/.*)?$/);
  if (nativeBuild && !['', '/Release', '/Release/fs_ext.node'].includes(nativeBuild[1] || '')) {
    if (stat.isDirectory()) releaseSkip.dirs += 1;
    else {
      releaseSkip.files += 1;
      releaseSkip.bytes += stat.size;
    }
    return;
  }
  if (!stat.isDirectory()) {
    if (skipReleaseFile(path.basename(src))) {
      releaseSkip.files += 1;
      releaseSkip.bytes += stat.size;
      return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const destination = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      const normalized = source.replace(/\\/g, '/');
      const foreignArch = entry.name === 'win32-arm64' || entry.name === 'win10-arm64';
      const duplicateOtelBuild =
        /\/node_modules\/@opentelemetry\/resources\/build$/.test(normalized.replace(/\/(?:esm|esnext)$/, '')) &&
        (entry.name === 'esm' || entry.name === 'esnext');
      if (foreignArch || duplicateOtelBuild) {
        releaseSkip.dirs += 1;
        releaseSkip.bytes += dirSize(source);
        continue;
      }
      copyTree(source, destination);
    } else if (entry.isSymbolicLink()) {
      copyTree(fs.realpathSync(source), destination);
    } else if (entry.isFile()) {
      copyTree(source, destination);
    }
  }
}

function longPath(p) {
  return process.platform === 'win32' ? path.toNamespacedPath(p) : p;
}

function pruneReleaseTree(root) {
  let removedFiles = 0;
  let removedBytes = 0;
  let removedDirs = 0;
  const errors = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(longPath(dir), { withFileTypes: true });
    } catch (err) {
      errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The installer is x64-only. Foreign node-pty binaries cannot be loaded
        // and add thousands of decompression and antivirus scan operations.
        if (entry.name === 'win32-arm64' || entry.name === 'win10-arm64') {
          removedBytes += dirSize(target);
          fs.rmSync(longPath(target), { recursive: true, force: true });
          removedDirs += 1;
          continue;
        }
        walk(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const declaration = /\.d\.(?:c|m)?ts$/i.test(entry.name);
      if (ext === '.map' || ext === '.pdb' || declaration) {
        try { removedBytes += fs.statSync(longPath(target)).size; } catch { /* race */ }
        try {
          fs.rmSync(longPath(target), { force: true });
          if (fs.existsSync(longPath(target))) throw new Error('file still exists after rmSync');
          removedFiles += 1;
        } catch (err) {
          errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  walk(root);
  return { removedFiles, removedDirs, removedBytes, errors };
}

function findForbiddenReleaseFiles(root) {
  const found = [];
  function walk(dir) {
    const entries = fs.readdirSync(longPath(dir), { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.map' || ext === '.pdb' || /\.d\.(?:c|m)?ts$/i.test(entry.name)) found.push(target);
      }
    }
  }
  walk(root);
  return found;
}

/// 与 integrity.rs count_files 同口径：目录递归计数，符号链接计为文件。
function countFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

/// 与 integrity.rs build_bundle_manifest 同口径：顶层包 + @scope/* 深度 2。
/// 键排序输出（Rust 端 BTreeMap 反序列化不敏感，但保证产物确定性便于比对）。
function buildBundleManifest(nmRoot) {
  const packages = {};
  const top = fs.readdirSync(nmRoot, { withFileTypes: true });
  const scopedChildren = [];
  for (const e of top) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const name = e.name;
    if (name.startsWith('@')) {
      scopedChildren.push([name, path.join(nmRoot, name)]);
    } else {
      packages[name] = { files: countFiles(path.join(nmRoot, name)) };
    }
  }
  for (const [scope, scopeDir] of scopedChildren) {
    for (const s of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!s.isDirectory() || s.isSymbolicLink()) continue;
      packages[`${scope}/${s.name}`] = { files: countFiles(path.join(scopeDir, s.name)) };
    }
  }
  const sorted = {};
  for (const k of Object.keys(packages).sort()) sorted[k] = packages[k];
  return { version: 1, packages: sorted };
}

/// 自检：与 integrity.rs verify_bundle 同口径（缺失/骨架/文件数下降=失败）。
function verifyStagedBundle(nmRoot, manifest) {
  const problems = [];
  for (const [name, meta] of Object.entries(manifest.packages)) {
    const expected = meta.files;
    const pkgDir = path.join(nmRoot, ...name.split('/'));
    if (!fs.existsSync(pkgDir)) {
      problems.push(`${name}: missing`);
      continue;
    }
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
      problems.push(`${name}: empty skeleton`);
      continue;
    }
    const actual = countFiles(pkgDir);
    if (actual < expected) problems.push(`${name}: files lost (${actual}<${expected})`);
  }
  return problems;
}

function productionClosure() {
  const npmCli = path.join(REPO_ROOT, 'vendor', 'npm', 'bin', 'npm-cli.js');
  const npmArgs = [npmCli, 'ls', '--omit=dev', '--all', '--parseable'];
  if (!fs.existsSync(npmCli)) throw new Error(`缺少内置 npm CLI: ${npmCli}`);
  let out;
  try {
    // Execute npm-cli.js with the current Node process. This avoids .cmd and
    // shell interpolation entirely (Node DEP0190 / CVE-2024-27980 boundary).
    out = execFileSync(process.execPath, npmArgs, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
  } catch (e) {
    // npm ls 在缺依赖/越权树时退出码非 0，但 stdout 仍给出可达闭包；
    // 只有完全拿不到输出才视为致命。
    out = String(e.stdout || '');
    if (!out.trim()) throw new Error(`npm ls 失败: ${e.stderr || e.message}`);
  }
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => path.resolve(l)).filter((p) => p.startsWith(NM_SRC + path.sep));
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try { total += fs.statSync(p).size; } catch { /* race */ }
    }
  }
  return total;
}

function main() {
  const t0 = Date.now();
  console.log(`[stage] repoRoot=${REPO_ROOT}`);

  // 0) 清空旧产物
  rmrf(APP);
  rmrf(path.join(RESOURCES, 'node'));
  rmrf(path.join(RESOURCES, 'npm'));
  rmrf(path.join(RESOURCES, 'profile-seed'));
  // resources/ 完全由本脚本重建（仅 .gitkeep 入库）。历史残留的顶层目录会混入
  // NSIS 打包清单，深层路径或中途被删的文件会让 makensis 直接中止。
  for (const entry of fs.readdirSync(RESOURCES, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    rmrf(path.join(RESOURCES, entry.name));
  }

  // 1) 根 package.json + sidecar TS 编译产物 + koffi 探针脚本 + assets
  copyFile('package.json');
  if (!fs.existsSync(path.join(SIDECAR_DIST, 'shell-host.js'))) {
    console.error('[stage] 缺少 sidecar/dist/shell-host.js —— 请先运行: npm --prefix tauri-app run sidecar:build');
    process.exit(1);
  }
  copyTree(SIDECAR_DIST, path.join(APP, 'sidecar', 'dist'));
  for (const f of SCRIPTS_JS) copyFile(path.join('scripts', f));
  copyTree(path.join(REPO_ROOT, 'assets'), path.join(APP, 'assets'));
  console.log('[stage] app: package.json + sidecar/dist 编译产物 + scripts + assets 完成');

  if (!fs.existsSync(path.join(PROFILE_SEED, 'profiles', 'web-desktop', 'node_modules'))) {
    console.error('[stage] 缺少离线 profile seed 的 node_modules；请准备审核后的 seed 并设置 DSH_PROFILE_SEED_DIR');
    process.exit(1);
  }
  copyTree(PROFILE_SEED, path.join(RESOURCES, 'profile-seed'));
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'prepare-aio-staged-seed.mjs'),
    path.join(RESOURCES, 'profile-seed', 'profiles', 'web-desktop'),
  ], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'patch-webui-prompt-optimize.mjs'),
    path.join(RESOURCES, 'profile-seed', 'profiles', 'web-desktop',
      'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'client.js'),
  ], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'patch-webui-native-model-selection.mjs'),
    path.join(RESOURCES, 'profile-seed', 'profiles', 'web-desktop',
      'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'client.js'),
  ], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'patch-webui-layout.mjs'),
    path.join(RESOURCES, 'profile-seed', 'profiles', 'web-desktop',
      'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'client.js'),
  ], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'patch-webui-continue.mjs'),
    path.join(RESOURCES, 'profile-seed', 'profiles', 'web-desktop',
      'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'client.js'),
  ], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'patch-status-rotator.mjs'),
    path.join(RESOURCES, 'profile-seed', 'profiles', 'web-desktop',
      'node_modules', 'dsh-status-rotator', 'lib', 'client.js'),
  ], { stdio: 'inherit' });
  // Patch only the staged copy; unknown plugin builds must stop packaging.
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'patch-done-pill.cjs'),
    '--write',
    path.join(RESOURCES, 'profile-seed', 'profiles', 'web-desktop',
      'node_modules', '@dsh-external', 'dsh-webui'),
  ], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'patch-webui-katex.mjs'),
    path.join(RESOURCES, 'profile-seed', 'profiles', 'web-desktop',
      'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'client.js'),
  ], { stdio: 'inherit' });
  console.log('[stage] 当前 web-desktop 插件与技能快照完成');

  // 2) 生产依赖闭包
  const closure = productionClosure();
  for (const pkgPath of closure) {
    const rel = path.relative(REPO_ROOT, pkgPath);
    const dst = path.join(APP, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    copyTree(pkgPath, dst);
  }
  console.log(`[stage] app: node_modules 闭包 ${closure.length} 个包`);

  // 3) 内置 node / npm 运行时
  const vendNode = path.join(REPO_ROOT, 'vendor', 'node');
  const vendNpm = path.join(REPO_ROOT, 'vendor', 'npm');
  if (!fs.existsSync(path.join(vendNode, 'node.exe'))) {
    console.error('[stage] 缺少 vendor/node/node.exe —— 请先运行: npm run fetch-node');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(vendNpm, 'bin', 'npm-cli.js'))) {
    console.error('[stage] 缺少 vendor/npm/bin/npm-cli.js —— 请先运行: npm run fetch-npm');
    process.exit(1);
  }
  copyTree(vendNode, path.join(RESOURCES, 'node'));
  copyTree(vendNpm, path.join(RESOURCES, 'npm'));
  console.log('[stage] node/npm 运行时完成');

  // Release-only filtering happens while copying, never by mutating the source
  // tree. Avoiding the write is faster and works even when antivirus or the
  // host filesystem virtualizes delete operations.
  console.log(
    `[stage] release filter: files=${releaseSkip.files} dirs=${releaseSkip.dirs} ` +
    `saved=${(releaseSkip.bytes / 1024 / 1024).toFixed(1)} MB`,
  );
  const forbiddenLeft = [...findForbiddenReleaseFiles(APP), ...findForbiddenReleaseFiles(path.join(RESOURCES, 'profile-seed'))];
  if (forbiddenLeft.length) {
    console.error(`[stage] release filter incomplete: remaining=${forbiddenLeft.length}`);
    for (const p of forbiddenLeft.slice(0, 30)) console.error('  ' + p);
    process.exit(1);
  }

  // 4) Generate the integrity manifest after pruning so the first launch
  // validates the exact shipped tree instead of the pre-prune source tree.
  const nmDst = path.join(APP, 'node_modules');
  const manifest = buildBundleManifest(nmDst);
  fs.writeFileSync(path.join(APP, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const problems = verifyStagedBundle(nmDst, manifest);
  if (problems.length) {
    console.error('[stage] 完整性自检失败:');
    for (const p of problems.slice(0, 20)) console.error('  ' + p);
    process.exit(1);
  }
  console.log(`[stage] app: bundle-manifest.json（${Object.keys(manifest.packages).length} 个包）自检通过`);

  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(`[stage] app=${mb(dirSize(APP))} node=${mb(dirSize(path.join(RESOURCES, 'node')))} npm=${mb(dirSize(path.join(RESOURCES, 'npm')))}`);
  console.log(`[stage] 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();

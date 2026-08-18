'use strict';

// electron-builder afterPack hook.
//
// electron-builder's file copier strips nested node_modules directories from
// extraResources, but the bundled npm CLI needs its own bundled deps
// (graceful-fs, semver, ...). Copy vendor/npm verbatim into the packed app
// after packaging; Windows and Linux targets then archive this copy.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildBundleManifest } = require('../bundle-integrity.js');
const { checkFile: checkGlibcFile } = require('./check-glibc.cjs');

async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  const src = path.resolve(__dirname, '..', 'vendor', 'npm');
  const dest = path.join(appOutDir, 'resources', 'npm');
  if (!fs.existsSync(src)) {
    console.warn('afterPack: vendor/npm missing — npm CLI will not be bundled');
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const deps = fs.readdirSync(path.join(dest, 'node_modules')).length;
  console.log(`afterPack: bundled npm copied (deps: ${deps})`);

  // Same copier also strips nested node_modules / vendor trees inside the
  // app files (assets/**). The community plugins (tdai-memory in particular)
  // ship self-contained runtime deps (sqlite-vec, jieba, ai sdk, BM25 corpus
  // data) that must survive verbatim — copy the plugins tree back in.
  const pluginsSrc = path.resolve(__dirname, '..', 'assets', 'plugins');
  const pluginsDest = path.join(appOutDir, 'resources', 'app', 'assets', 'plugins');
  if (fs.existsSync(pluginsSrc)) {
    fs.rmSync(pluginsDest, { recursive: true, force: true });
    fs.cpSync(pluginsSrc, pluginsDest, { recursive: true });
    if (electronPlatformName !== 'win32') trimPlatformForeignPlugins(pluginsDest, electronPlatformName);
    console.log('afterPack: bundled plugins copied verbatim');
    auditBundledPluginRuntime(pluginsDest, electronPlatformName);
  }

  if (electronPlatformName === 'win32') {
    trimLongPathFiles(appOutDir);
    dedupeNestedModules(appOutDir);
    auditLongPaths(appOutDir);
  }
  // 把只在 app 层声明的依赖补进 bundled dsh 闭包（better-sidebar → schemastery），
  // 让 dsh-app-boot 的 fallback junction BFS 能发现它们。Linux/Windows 都执行。
  injectDshClosureExtras(appOutDir);
  // node-pty 原生模块审计：必须在写 bundle manifest 之前执行，否则缺 pty.node
  // 的坏树会被当成基准记进 manifest，启动完整性校验形同虚设（3.0.1 Arch 事故）。
  auditNodePty(appOutDir, electronPlatformName);
  // Linux 包同样生成 bundle manifest，让启动时的完整性校验在 Linux 上也生效。
  writeBundleManifest(appOutDir);
}

module.exports = afterPack;
module.exports.auditNodePty = auditNodePty;

// The profile fallback closure (profiles/node_modules junctions) is maintained
// by dsh-app-boot, whose BFS starts at the BUNDLED dsh package's package.json.
// Companion plugin deps that only exist in the app-layer package.json (e.g.
// better-sidebar → schemastery) are unreachable from that BFS, so the fallback
// never gains a schemastery junction and dsh web dies with ERR_MODULE_NOT_FOUND
// (exit code 1, "启动失败" loop — v3.0.0 field report). Fix at the mechanism
// level: declare those deps in the bundled dsh package too; the BFS then
// resolves them through the app closure (top-level node_modules) and maintains
// the junctions on every launch, idempotently. cosmokit comes along as
// schemastery's own dependency.
function injectDshClosureExtras(appOutDir) {
  const appNm = path.join(appOutDir, 'resources', 'app', 'node_modules');
  const dshPkgPath = path.join(appNm, '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(dshPkgPath)) return;
  let dshPkg;
  try { dshPkg = JSON.parse(fs.readFileSync(dshPkgPath, 'utf8')); }
  catch (err) { console.warn('afterPack: cannot parse bundled dsh package.json:', err.message); return; }
  dshPkg.dependencies = dshPkg.dependencies || {};

  const extras = ['schemastery'];
  let injected = 0;
  for (const name of extras) {
    if (dshPkg.dependencies[name]) continue;
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(appNm, name, 'package.json'), 'utf8')).version || ''; }
    catch { console.warn(`afterPack: ${name} not found in app closure — skipped`); continue; }
    dshPkg.dependencies[name] = '^' + version;
    injected++;
  }
  if (injected) {
    fs.writeFileSync(dshPkgPath, JSON.stringify(dshPkg, null, 2) + '\n');
    console.log(`afterPack: injected into dsh closure: ${extras.join(', ')} (fallback junctions will heal on next launch)`);
  }
}

// Issue #7: record a per-package file-count manifest of the FINAL payload
// (after trim/dedupe) so the installed app can detect stripped packages
// (empty skeletons after a botched upgrade) at boot and tell the user to
// reinstall instead of looping on ERR_MODULE_NOT_FOUND.
function writeBundleManifest(appOutDir) {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(nmRoot)) return;
  const manifest = buildBundleManifest(nmRoot);
  const out = path.join(appOutDir, 'resources', 'app', 'bundle-manifest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
  console.log(`afterPack: bundle manifest written (${Object.keys(manifest.packages).length} packages)`);
}

// node-pty 原生模块审计（3.0.1 Arch 事故的直接根因）。
//
// node-pty@1.1.0 不提供 linux-x64 预编译包，
// 必须在安装时由 node-gyp 现场编译出 build/Release/pty.node。3.0.1 的 Arch 包
// 三种候选路径（build/Release、build/Debug、prebuilds/linux-x64）全缺，导致
// dsh-subprocess-local / better-sidebar 加载失败、dsh web 以退出码 1 反复
// 启动失败。electron-builder 的 afterPack 阶段必须拦截，而不是把坏树交给
// 用户。node-pty 是 N-API 插件（node-addon-api），ABI 稳定，缺的主要是「文件
// 有没有被装进去」，所以既要查存在性，也要用捆绑 Node 实际导入一次。
const NODE_PTY_PLATFORM_CANDIDATES = {
  linux: ['build/Release/pty.node', 'prebuilds/linux-x64/pty.node'],
  win32: ['build/Release/pty.node', 'prebuilds/win32-x64/pty.node'],
};

function auditNodePty(appOutDir, electronPlatformName, nodeBinOverride) {
  const nodePtyRoot = path.join(appOutDir, 'resources', 'app', 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyRoot)) {
    throw new Error(
      'afterPack: 打包产物缺少 node-pty（' + nodePtyRoot + '）。\n' +
      'dsh-subprocess-local 与 better-sidebar 都依赖它，缺了 dsh web 启动即失败。'
    );
  }
  const candidates = NODE_PTY_PLATFORM_CANDIDATES[electronPlatformName] || [];
  const present = candidates.filter((rel) => fs.existsSync(path.join(nodePtyRoot, rel)));
  if (present.length === 0) {
    throw new Error(
      'afterPack: node-pty 缺少 ' + electronPlatformName + ' 原生模块 pty.node。\n' +
      '已检查: ' + candidates.map((rel) => path.join('node-pty', rel)).join('、') + '（均不存在）\n' +
      'Linux 安装时 node-pty 须由 node-gyp 编译（需要 python / make / gcc 工具链），\n' +
      '若 npm ci 阶段脚本被跳过或编译失败，必须先修好依赖树再打包。'
    );
  }
  console.log('afterPack: node-pty 原生模块存在（' + present.join('、') + '）');
  if (electronPlatformName !== 'linux') return;

  // 用捆绑的 plain Node 实际导入：如果捆绑 Node 与编译时 Node 的 ABI 不一致，
  // 或 pty.node 损坏，在这里就报错，而不是等用户启动 dsh web 才发现。
  const nodeBin = nodeBinOverride || path.join(appOutDir, 'resources', 'node', 'node');
  if (!fs.existsSync(nodeBin)) {
    throw new Error('afterPack: 打包产物缺少捆绑 Node（' + nodeBin + '），无法验证 node-pty 可加载性。');
  }
  const r = spawnSync(nodeBin, ['-e',
    'const pty = require(process.argv[1]);' +
    'if (typeof pty.spawn !== "function") { console.error("node-pty API 异常"); process.exit(2); }' +
    'console.log("node-pty loadable @ " + process.version);',
    nodePtyRoot], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(
      'afterPack: 捆绑 Node 无法加载 node-pty（exit ' + r.status + '）。\n' +
      (r.stderr || r.stdout || (r.error && r.error.message) || '').trim() + '\n' +
      '检查 pty.node 是否按捆绑 Node 的 ABI 编译，或重新 npm ci 后再打包。'
    );
  }
  console.log('afterPack: ' + (r.stdout || '').trim());

  // glibc 兼容性审计（2026-08 Debian 事故）：node-pty 在构建机（Arch glibc 2.42
  // 或最新 Ubuntu runner）上现场编译会绑定新 glibc，Debian 13（2.41）及更老
  // 系统加载即崩（GLIBC_2.42 not found）。基线与扫描逻辑统一在
  // scripts/check-glibc.cjs（阈值 GLIBC_2.34，见 docs/support-matrix.md）。
  // 超标直接 fail 构建，回到低 glibc chroot 重编。
  const presentBinary = present.find((rel) => rel.endsWith('pty.node'));
  if (presentBinary) {
    const r = checkGlibcFile(path.join(nodePtyRoot, presentBinary));
    if (!r.ok) {
      throw new Error(
        'afterPack: ' + r.message + '。\n' +
        '在构建机（Arch / 最新 Ubuntu）上 node-gyp 现场编译会绑定新 glibc，Debian 13 及更老系统无法加载。\n' +
        '必须回到低 glibc chroot 重编：见 docs/support-matrix.md（debootstrap bookworm + 官方 node）。'
      );
    }
    console.log('afterPack: ' + r.message);
  }
}

// dsh-dafeiyu（V4 桌宠）随包携带 win32-x64 的 PyInstaller helper（约 50MB），
// 且只在 process.platform === 'win32' 时被 helper-process.js 引用；Linux
// 上桌面端走 python3 + runtime/helper.py。整树 verbatim 拷贝后按平台剔除，
// Linux 包省 50MB 死重。删除只针对列明的目录，未来插件新增其它
// 平台负载需在这里补条目。
function trimPlatformForeignPlugins(pluginsRoot, platform) {
  const kill = [
    platform !== 'win32' && path.join(pluginsRoot, 'dsh-dafeiyu', 'runtime', 'bin', 'win32-x64'),
  ].filter(Boolean);
  for (const dir of kill) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`afterPack: trimmed platform-foreign payload ${path.relative(pluginsRoot, dir)} (${platform})`);
    }
  }
}

function auditBundledPluginRuntime(pluginsRoot, platform) {  const tdai = path.join(pluginsRoot, 'dsh-tdai-memory', 'node_modules');
  const required = [
    path.join(tdai, '@tencentdb-agent-memory', 'tcvdb-text', 'dist', 'index.js'),
    path.join(tdai, '@ai-sdk', 'gateway', 'dist', 'index.mjs'),
    path.join(tdai, '@ai-sdk', 'openai', 'dist', 'index.mjs'),
    path.join(tdai, '@ai-sdk', 'provider', 'dist', 'index.mjs'),
    path.join(tdai, '@ai-sdk', 'provider-utils', 'dist', 'index.mjs'),
    path.join(tdai, '@standard-schema', 'spec', 'dist', 'index.js'),
    path.join(tdai, '@vercel', 'oidc', 'dist', 'index.js'),
    path.join(tdai, 'ai', 'dist', 'index.mjs'),
    path.join(tdai, 'eventsource-parser', 'dist', 'index.js'),
    path.join(tdai, 'json5', 'dist', 'index.mjs'),
  ];
  if (platform === 'linux') {
    required.push(
      path.join(tdai, '@node-rs', 'jieba-linux-x64-gnu', 'jieba.linux-x64-gnu.node'),
      path.join(tdai, 'sqlite-vec-linux-x64', 'vec0.so')
    );
  } else if (platform === 'win32') {
    required.push(
      path.join(tdai, '@node-rs', 'jieba-win32-x64-msvc', 'jieba.win32-x64-msvc.node'),
      path.join(tdai, 'sqlite-vec-windows-x64', 'vec0.dll')
    );
  }
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(
      `afterPack: bundled tdai-memory runtime is incomplete for ${platform}:\n` +
      missing.map((file) => `  ${path.relative(pluginsRoot, file)}`).join('\n')
    );
  }
  console.log(`afterPack: bundled tdai-memory runtime audit passed (${platform})`);
}

// electron-builder's dependency collector needlessly nests some deps under
// their dependents (e.g. @opentelemetry/resources@2.10.0 under
// dsh-session-telemetry-otel) even when the exact same version is already
// hoisted at the top level. The nested copies are the deepest paths in the
// whole tree and triggered the NSIS MAX_PATH silent-drop (issue #4), so drop
// them when identical to the hoisted one — node resolution falls back up to
// the top-level copy, which is byte-identical.
function dedupeNestedModules(appOutDir) {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  if (!fs.existsSync(nmRoot)) return;
  const readVersion = (p) => {
    try { return JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version || ''; }
    catch { return null; }
  };
  let removed = 0;
  const scopes = fs.existsSync(nmRoot) ? fs.readdirSync(nmRoot, { withFileTypes: true }) : [];
  for (const s of scopes) {
    if (!s.isDirectory() || !s.name.startsWith('@')) continue;
    for (const pkg of fs.readdirSync(path.join(nmRoot, s.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const nested = path.join(nmRoot, s.name, pkg.name, 'node_modules');
      if (!fs.existsSync(nested)) continue;
      for (const ns of fs.readdirSync(nested, { withFileTypes: true })) {
        if (!ns.isDirectory()) continue;
        const nsDir = path.join(nested, ns.name);
        let candidates = [];
        if (ns.name.startsWith('@')) {
          for (const p2 of fs.readdirSync(nsDir, { withFileTypes: true })) {
            if (p2.isDirectory()) candidates.push([path.join(nsDir, p2.name), `${ns.name}/${p2.name}`]);
          }
        } else {
          candidates.push([nsDir, ns.name]);
        }
        for (const [copyDir, name] of candidates) {
          const topDir = path.join(nmRoot, ...name.split('/'));
          if (!fs.existsSync(path.join(topDir, 'package.json'))) continue;
          if (readVersion(copyDir) === readVersion(topDir)) {
            fs.rmSync(copyDir, { recursive: true, force: true });
            removed++;
            console.log(`afterPack: deduped nested ${name} (== top-level ${readVersion(topDir)})`);
          }
        }
      }
      // drop the node_modules dir itself if we emptied it
      const again = path.join(nmRoot, s.name, pkg.name, 'node_modules');
      try { if (fs.readdirSync(again).length === 0) fs.rmSync(again, { recursive: true, force: true }); } catch {}
    }
  }
  if (!removed) console.log('afterPack: no redundant nested modules found');
}

// The NSIS installer's 7z extractor silently drops files whose full path
// exceeds MAX_PATH (260) — no error, just missing modules at runtime
// (issue #4). Keep the tree short by removing platform-irrelevant payloads
// that also happen to be the deepest ones.
function trimLongPathFiles(appOutDir) {
  const nmRoot = path.join(appOutDir, 'resources', 'app', 'node_modules');
  const kill = [];
  const collect = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // node-pty arm64 payloads are useless in an x64-only build
        if (e.name === 'win32-arm64' && dir.endsWith(path.join('node-pty', 'prebuilds'))) {
          kill.push(p);
        } else if (e.name === 'win10-arm64' && /node-pty[\\/]third_party[\\/]conpty[\\/][^\\/]+$/.test(dir)) {
          kill.push(p);
        } else if (e.name === 'esnext' && /@opentelemetry[\\/]+[^\\/]+[\\/]build$/.test(dir)) {
          // ESM build of @opentelemetry pkgs: runtime dsh is CJS and loads
          // build/src (see issue #4 stack traces) — and esnext holds the
          // deepest paths in the tree (nested copies > MAX_PATH after install)
          kill.push(p);
        } else if (e.name === 'browser' && /@opentelemetry[\\/]+[^\\/]+[\\/]build[\\/]+(esnext|src)[\\/]detectors[\\/]platform$/.test(dir)) {
          // browser-platform telemetry detectors never load under plain node
          kill.push(p);
        } else if (depth < 12) {
          collect(p, depth + 1);
        }
      }
    }
  };
  if (fs.existsSync(nmRoot)) collect(nmRoot, 0);
  for (const p of kill) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`afterPack: trimmed ${path.relative(appOutDir, p)}`);
  }
  // Nested otel copies still hold .js.map files at the deepest runtime paths
  // (the CJS build itself must stay) — source maps are dev-only, drop them.
  let maps = 0;
  const dropMaps = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) dropMaps(p);
      else if (e.name.endsWith('.js.map')) { fs.rmSync(p, { force: true }); maps++; }
    }
  };
  const otelNested = path.join(nmRoot, '@deepseek-ai');
  if (fs.existsSync(otelNested)) {
    for (const pkg of fs.readdirSync(otelNested, { withFileTypes: true })) {
      const nestedNm = path.join(otelNested, pkg.name, 'node_modules', '@opentelemetry');
      if (pkg.isDirectory() && fs.existsSync(nestedNm)) dropMaps(nestedNm);
    }
  }
  if (maps) console.log(`afterPack: dropped ${maps} nested .js.map files`);
}

// Fail loudly at build time if any packed file would risk the silent
// MAX_PATH drop again. Paths are re-based onto a realistic install prefix
// (20-char user name, default per-user Programs dir, version-less product
// folder) — NOT the build machine path — so the numbers reflect what the
// NSIS extractor will actually see.
function auditLongPaths(appOutDir) {
  const INSTALL_PREFIX = 'C:\\Users\\12345678901234567890\\AppData\\Local\\Programs\\Deepseek Harness EAC\\';
  const LIMIT = 260;
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (INSTALL_PREFIX.length + path.relative(appOutDir, p).length >= LIMIT) offenders.push(p);
    }
  };
  walk(appOutDir);
  if (offenders.length) {
    console.warn(`afterPack: WARNING ${offenders.length} file(s) would hit MAX_PATH(${LIMIT}) after install:`);
    for (const p of offenders.slice(0, 20)) console.warn('  ' + p);
    if (offenders.length > 20) console.warn(`  … and ${offenders.length - 20} more`);
  } else {
    console.log(`afterPack: long-path audit clean (install prefix ${INSTALL_PREFIX.length} + relpath < ${LIMIT})`);
  }
}

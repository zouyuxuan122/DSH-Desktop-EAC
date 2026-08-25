'use strict';
// Tauri 打包资源装配（P4）：把运行所需的一切装进 staged-resources/，
// 供 tauri.conf.json 的 resources 映射进安装包。
//
// 布局（= main.rs resource_root() 的约定）：
//   staged-resources/sidecar/server.js|bridge.js|rescue-integration.js
//   staged-resources/dsh-desktop/<Electron 时代的精确文件清单 + 生产 node_modules
//                              + assets + vendor/node + vendor/npm>
//
// 用法：node stage-resources.mjs [--target=win32|linux] [--skip-npm]

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canReuseStagedNodeModules, writeStagedPlatformStamp } from './stage-platform-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dd = path.join(root, 'dsh-desktop');
const staged = path.join(root, 'tauri-shell', 'staged-resources');
const skipNpm = process.argv.includes('--skip-npm');
const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
const targetPlatform = targetArg ? targetArg.slice('--target='.length) : process.platform;
if (targetPlatform !== 'win32' && targetPlatform !== 'linux') {
  throw new Error(`[stage] 不支持目标平台: ${targetPlatform}`);
}

// 人工同步：新增根模块要加进来（Electron 时代的 main.js / preload.js 已废弃，不再打包）。
const ROOT_FILES = [
  'updater.js', 'client-updater.js', 'logger.js', 'plugin-updater.js',
  'balance.js', 'session-watcher.js', 'session-encoding-heal.js', 'profile-module-heal.js',
  'patch-row-heal.js', 'builtin-collision.js', 'plugin-manager-state.js', 'plugin-guard.js',
  'rescue-agent.js', 'preset-sync.js', 'compact-preset-migrate.js', 'error-detail.js',
  'bundle-integrity.js', 'stable-port.js', 'stream-write-guard.js', 'koffi-preflight.js',
  'renderer-recovery.js', 'watchdog.js', 'shortcut-maintenance.js',
  'host-bootstrap.js',
];
const LIB_DESKTOP = [
  'file-roots.js', 'proc.js', 'platform.js', 'runtime-paths.js', 'profile.js', 'guard-box.js',
  'runtime-patches.js', 'companion-sync.js', 'plugin-ops.js', 'market.js',
  'shortcuts.js', 'junction-patrol.js', 'client-update.js', 'static-preview.js',
  'boot-server.js',
];
const SCRIPTS = [
  'koffi-preflight.cjs', 'patch-session-manage.js', 'plugin-manager-patch.js',
  'onboarding.js', 'make-release-hashes.js', 'patch-deps.js',
];

// vnext 隔离体系（vnext-absorb Phase 2）：sidecar require 的 lib/{state,log,
// supervisor,extension-host,recovery-center} 编译产物 + 原生模块。
const LIB_VNEXT = [
  'state.js', 'log.js', 'plugin-copy.js',
  'supervisor/registry.js', 'supervisor/state-machine.js', 'supervisor/installer.js',
  'supervisor/permissions.js', 'supervisor/incidents.js',
  'extension-host/manager.js', 'extension-host/bridge-server.js',
  'extension-host/job-fence.js', 'extension-host/rpc.js', 'extension-host/sdk/index.js',
  'recovery-center/register.js',
];
const NATIVE_MODULES = ['supervisor/index.node', 'snapshot/index.node'];

function requireFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`[stage] 缺少${label || '文件'}: ${path.relative(root, file)}`);
  }
}

function copyRequired(src, dest, label) {
  requireFile(src, label);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
}

function isLinuxX64Elf(file) {
  const data = readFileSync(file);
  return data.length >= 20
    && data[0] === 0x7f && data.subarray(1, 4).toString('ascii') === 'ELF'
    && data.readUInt16LE(18) === 62;
}

function pruneLinuxPayloads(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneLinuxPayloads(file);
      if (readdirSync(file).length === 0) rmSync(file, { recursive: true, force: true });
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(?:exe|dll)$/i.test(entry.name) || (/\.node$/i.test(entry.name) && !isLinuxX64Elf(file))) {
      rmSync(file, { force: true });
    }
  }
}

function pruneNonLinuxPrebuilds(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (entry.name === 'prebuilds') {
      for (const platformDir of readdirSync(child, { withFileTypes: true })) {
        if (platformDir.isDirectory() && platformDir.name !== 'linux-x64') {
          rmSync(path.join(child, platformDir.name), { recursive: true, force: true });
        }
      }
    } else {
      pruneNonLinuxPrebuilds(child);
    }
  }
}

function pruneMuslPackages(nodeModules) {
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(nodeModules, entry.name);
    if (/linuxmusl/i.test(entry.name)) {
      rmSync(packageDir, { recursive: true, force: true });
    } else if (entry.name.startsWith('@')) {
      for (const scopedEntry of readdirSync(packageDir, { withFileTypes: true })) {
        if (scopedEntry.isDirectory() && /linuxmusl/i.test(scopedEntry.name)) {
          rmSync(path.join(packageDir, scopedEntry.name), { recursive: true, force: true });
        }
      }
    }
  }
}

function pluginEntrypoints(pkg) {
  const result = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) result.push(value.replace(/^\.\//, ''));
  };
  add(pkg.main);
  add(pkg.module);
  if (typeof pkg.exports === 'string') add(pkg.exports);
  else if (pkg.exports && typeof pkg.exports === 'object') {
    const walk = (value) => {
      if (typeof value === 'string') add(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(pkg.exports);
  }
  return [...new Set(result)].filter((entry) => !entry.includes('*') && !/\.d\.(?:ts|mts|cts)$/i.test(entry));
}

function validatePluginTree(dir, label) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifest = path.join(pluginDir, 'package.json');
    if (!existsSync(manifest)) {
      throw new Error(`[stage] ${label}插件目录没有 package.json: ${path.relative(root, pluginDir)}`);
    }
    let pkg;
    try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); }
    catch (err) { throw new Error(`[stage] ${label}插件 manifest 无法解析: ${path.relative(root, manifest)} (${err.message})`); }
    const points = pluginEntrypoints(pkg);
    if (points.length === 0) throw new Error(`[stage] ${label}插件没有可校验入口: ${path.relative(root, manifest)}`);
    for (const rel of points) requireFile(path.join(pluginDir, rel), `${label}插件入口`);
  }
}

console.log(`[stage] 目标平台 ${targetPlatform}；清理旧装配目录` + (skipNpm ? '（--skip-npm：保留上次的生产 node_modules）' : ''));
// 注意：node_modules 必须在整树清空前判定并豁免，否则 --skip-npm 永远不生效
// （先 rm 全目录再 existsSync 检查，检查对象必不存在）。
const stagedNm = path.join(staged, 'dsh-desktop', 'node_modules');
const platformStamp = path.join(staged, '.node-modules-platform');
const keepStagedNm = canReuseStagedNodeModules(skipNpm, targetPlatform, stagedNm, platformStamp);
if (skipNpm && existsSync(stagedNm) && !keepStagedNm) {
  console.log('[stage] 上次 node_modules 的目标平台未知或不匹配，将重新安装');
}
rmSync(path.join(staged, 'sidecar'), { recursive: true, force: true });
if (keepStagedNm) {
  for (const entry of readdirSync(path.join(staged, 'dsh-desktop'))) {
    if (entry === 'node_modules') continue;
    rmSync(path.join(staged, 'dsh-desktop', entry), { recursive: true, force: true });
  }
} else {
  rmSync(staged, { recursive: true, force: true });
}
mkdirSync(path.join(staged, 'sidecar'), { recursive: true });
mkdirSync(path.join(staged, 'dsh-desktop'), { recursive: true });

console.log('[stage] 编译 TypeScript（tsc 就地产物）');
execSync('npx tsc -p tsconfig.json', { cwd: dd, stdio: 'inherit' });

console.log('[stage] sidecar 产物');
for (const f of ['server.js', 'bridge.js', 'rescue-integration.js']) {
  cpSync(path.join(root, 'tauri-shell', 'sidecar', f), path.join(staged, 'sidecar', f));
}

console.log('[stage] dsh-desktop 根模块 + lib/desktop + scripts + package.json');
for (const f of ROOT_FILES) {
  const src = path.join(dd, f);
  copyRequired(src, path.join(staged, 'dsh-desktop', f), '根模块');
}
mkdirSync(path.join(staged, 'dsh-desktop', 'lib', 'desktop'), { recursive: true });
for (const f of LIB_DESKTOP) {
  copyRequired(path.join(dd, 'lib', 'desktop', f), path.join(staged, 'dsh-desktop', 'lib', 'desktop', f), '桌面库');
}
console.log('[stage] vnext 隔离体系（lib 模块 + shared 协议 + 原生 .node）');
for (const f of LIB_VNEXT) {
  copyRequired(path.join(dd, 'lib', f), path.join(staged, 'dsh-desktop', 'lib', f), 'vnext 库');
}
// shared/protocol.js：隔离体系单点协议源，extension-host/rpc.js 运行时 require
// （../../shared/protocol.js）——漏装配会让 sidecar 启动即 MODULE_NOT_FOUND。
copyRequired(path.join(dd, 'shared', 'protocol.js'), path.join(staged, 'dsh-desktop', 'shared', 'protocol.js'), '共享协议');
mkdirSync(path.join(staged, 'dsh-desktop', 'native'), { recursive: true });
for (const f of NATIVE_MODULES) {
  copyRequired(path.join(dd, 'native', f), path.join(staged, 'dsh-desktop', 'native', f), '原生模块');
}
mkdirSync(path.join(staged, 'dsh-desktop', 'scripts'), { recursive: true });
for (const f of SCRIPTS) {
  copyRequired(path.join(dd, 'scripts', f), path.join(staged, 'dsh-desktop', 'scripts', f), '脚本');
}
// package.json + lock 原样拷贝（npm ci 要求两者一致；--omit=dev 只装生产树）。
// .npmrc（legacy-peer-deps）必须随行：内核包互相声明 peer，staged 目录里的
// npm ci 若不带该配置会因 lock 缺 peer 闭包直接 EUSAGE 拒装（全新打包必踩）。
copyRequired(path.join(dd, 'package.json'), path.join(staged, 'dsh-desktop', 'package.json'), 'package.json');
copyRequired(path.join(dd, 'package-lock.json'), path.join(staged, 'dsh-desktop', 'package-lock.json'), 'package-lock.json');
copyRequired(path.join(dd, '.npmrc'), path.join(staged, 'dsh-desktop', '.npmrc'), '.npmrc');

console.log('[stage] assets（114MB：38 插件 + 10 皮肤 + 图标）');
cpSync(path.join(dd, 'assets'), path.join(staged, 'dsh-desktop', 'assets'), { recursive: true });
validatePluginTree(path.join(dd, 'assets', 'plugins'), '源');
validatePluginTree(path.join(staged, 'dsh-desktop', 'assets', 'plugins'), 'staging');

console.log('[stage] vendor node/npm 运行时');
mkdirSync(path.join(staged, 'dsh-desktop', 'vendor'), { recursive: true });
const runtimeName = targetPlatform === 'win32' ? 'node.exe' : 'node';
copyRequired(
  path.join(dd, 'vendor', 'node', runtimeName),
  path.join(staged, 'dsh-desktop', 'vendor', 'node', runtimeName),
  `${targetPlatform} Node runtime`,
);
if (targetPlatform === 'linux') {
  chmodSync(path.join(staged, 'dsh-desktop', 'vendor', 'node', runtimeName), 0o755);
}
if (existsSync(path.join(dd, 'vendor', 'npm'))) {
  cpSync(path.join(dd, 'vendor', 'npm'), path.join(staged, 'dsh-desktop', 'vendor', 'npm'), { recursive: true });
}

console.log('[stage] 生产 node_modules（npm ci --omit=dev，首次较慢）');
const nmDest = path.join(staged, 'dsh-desktop', 'node_modules');
if (!keepStagedNm) {
  execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: path.join(staged, 'dsh-desktop'), stdio: 'inherit' });
}

if (targetPlatform === 'linux') {
  console.log('[stage] 移除 Linux 不可达的 Windows/macOS native payload');
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'plugins', 'computer-user'), { recursive: true, force: true });
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'plugins', 'dsh-dafeiyu'), { recursive: true, force: true });
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'agent-presets'), { recursive: true, force: true });
  pruneLinuxPayloads(path.join(staged, 'dsh-desktop', 'assets'));
  pruneNonLinuxPrebuilds(nmDest);
  pruneLinuxPayloads(nmDest);
  pruneMuslPackages(nmDest);
  rmSync(
    path.join(nmDest, '@koromix', 'koffi-linux-x64', 'musl_x64'),
    { recursive: true, force: true },
  );
}
writeStagedPlatformStamp(platformStamp, targetPlatform);

// dsh-desktop 锚点补丁（patch-deps：可选升级字段 / picker 退出码 / 设置左栏滚动）——
// npm ci 从 registry 全新安装会还原成未打补丁的内核文件，必须在 staged 树上重放。
// 脚本幂等：npm ci 的 postinstall（patch-deps.js 已随 SCRIPTS 入 staged）若已应用则直接跳过。
console.log('[stage] 重放 dsh-desktop 锚点补丁（patch-deps）');
execSync('node scripts/patch-deps.js', { cwd: path.join(staged, 'dsh-desktop'), stdio: 'inherit' });

// 上游修复的 vendored 覆盖（bash 输出折叠，PR #181）——npm ci 会还原成
// registry 版本，把仓库内的修复副本盖回去。
// （dsh-subprocess-local 的 pwsh 超时 vendored 修复已废弃：0.1.1-rc.2 上游以
//  Promise.race(done, delay(graceMs)) 原生实现同类兜底，随 registry 版本走。）
const vendoredBashFix = path.join(dd, 'node_modules', '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js');
if (existsSync(vendoredBashFix)) {
  cpSync(vendoredBashFix, path.join(nmDest, '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js'));
  console.log('[stage] 已回填 dsh-tool-bash 的 vendored 修复');
}

// Tauri 的增量资源复制不会删除上一次 bundle 中已经消失的文件。只清理可由
// staged-resources 完整重建的副本，避免切换目标平台后残留异平台 payload。
for (const profile of ['debug', 'release']) {
  rmSync(path.join(root, 'tauri-shell', 'target', profile, 'sidecar'), { recursive: true, force: true });
  rmSync(path.join(root, 'tauri-shell', 'target', profile, 'dsh-desktop'), { recursive: true, force: true });
}
const appImageBundleDir = path.join(root, 'tauri-shell', 'target', 'release', 'bundle', 'appimage');
if (existsSync(appImageBundleDir)) {
  for (const entry of readdirSync(appImageBundleDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.AppDir')) {
      rmSync(path.join(appImageBundleDir, entry.name), { recursive: true, force: true });
    }
  }
}
rmSync(
  path.join(root, 'tauri-shell', 'target', 'release', 'bundle', 'appimage_deb'),
  { recursive: true, force: true },
);

console.log('[stage] 完成：' + staged);

// WebView2Loader.dll：webview2-com-sys 提供的 x64 loader，必须与壳 exe 同级
// （否则 dsh-eac-shell.exe 启动即 0xC0000135 崩）。从 cargo registry 的
// webview2-com-sys 包定位（tauri build 不再重新生成该文件）。
{
  const loader = (() => {
    const homeDir = process.env.USERPROFILE || process.env.HOME || '';
    const roots = [
      path.join(process.env.CARGO_HOME || path.join(homeDir, '.cargo'), 'registry', 'src'),
      path.join(homeDir, '.cargo', 'registry', 'src'),
    ];
    for (const base of roots) {
      if (!existsSync(base)) continue;
      const hits = readdirSync(base).sort().reverse();
      for (const bucket of hits) {
        const webview2Dir = path.join(base, bucket);
        if (!existsSync(webview2Dir)) continue;
        const subdirs = readdirSync(webview2Dir);
        for (const dir of subdirs) {
          if (!dir.startsWith('webview2-com-sys-')) continue;
          const cand = path.join(webview2Dir, dir, 'x64', 'WebView2Loader.dll');
          if (existsSync(cand)) return cand;
        }
      }
    }
    return '';
  })();
  const dest = path.join(staged, 'WebView2Loader.dll');
  if (loader && existsSync(loader)) {
    cpSync(loader, dest);
    console.log('[stage] WebView2Loader.dll 已装配: ' + path.relative(root, dest));
  } else {
    console.warn('[stage] 未找到 WebView2Loader.dll（webview2-com-sys），安装包可能启动即崩');
  }
}

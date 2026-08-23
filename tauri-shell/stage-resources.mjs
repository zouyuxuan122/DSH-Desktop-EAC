'use strict';
// Tauri 打包资源装配（P4）：把运行所需的一切装进 staged-resources/，
// 供 tauri.conf.json 的 resources 映射进安装包。
//
// 布局（= main.rs resource_root() 的约定）：
//   staged-resources/sidecar/server.js|bridge.js|rescue-integration.js
//   staged-resources/dsh-desktop/<Electron 时代的精确文件清单 + 生产 node_modules
//                              + assets + vendor/node + vendor/npm>
//
// 用法：node stage-resources.mjs [--skip-npm]（--skip-npm 复用上次 npm ci 产物）

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dd = path.join(root, 'dsh-desktop');
const staged = path.join(root, 'tauri-shell', 'staged-resources');
const skipNpm = process.argv.includes('--skip-npm');

// electron-builder.yml 的 files 清单（人工同步：新增根模块要加进来）。
const ROOT_FILES = [
  'main.js', 'updater.js', 'client-updater.js', 'logger.js', 'plugin-updater.js',
  'balance.js', 'session-watcher.js', 'session-encoding-heal.js', 'profile-module-heal.js',
  'patch-row-heal.js', 'builtin-collision.js', 'plugin-manager-state.js', 'plugin-guard.js',
  'rescue-agent.js', 'preset-sync.js', 'compact-preset-migrate.js', 'error-detail.js',
  'bundle-integrity.js', 'stable-port.js', 'stream-write-guard.js', 'koffi-preflight.js',
  'renderer-recovery.js', 'watchdog.js', 'shortcut-maintenance.js', 'preload.js',
  'wsl-backend.js',
];
const LIB_DESKTOP = [
  'file-roots.js', 'proc.js', 'runtime-paths.js', 'profile.js', 'guard-box.js',
  'runtime-patches.js', 'companion-sync.js', 'plugin-ops.js', 'market.js',
  'shortcuts.js', 'junction-patrol.js', 'client-update.js', 'static-preview.js',
  'boot-server.js',
];
const SCRIPTS = [
  'koffi-preflight.cjs', 'patch-session-manage.js', 'plugin-manager-patch.js',
  'onboarding.js', 'make-release-hashes.js',
];

console.log('[stage] 清理旧装配目录');
rmSync(staged, { recursive: true, force: true });
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
  if (existsSync(src)) cpSync(src, path.join(staged, 'dsh-desktop', f));
}
mkdirSync(path.join(staged, 'dsh-desktop', 'lib', 'desktop'), { recursive: true });
for (const f of LIB_DESKTOP) {
  cpSync(path.join(dd, 'lib', 'desktop', f), path.join(staged, 'dsh-desktop', 'lib', 'desktop', f));
}
mkdirSync(path.join(staged, 'dsh-desktop', 'scripts'), { recursive: true });
for (const f of SCRIPTS) {
  cpSync(path.join(dd, 'scripts', f), path.join(staged, 'dsh-desktop', 'scripts', f));
}
// package.json + lock 原样拷贝（npm ci 要求两者一致；--omit=dev 只装生产树）。
// .npmrc（legacy-peer-deps）必须随行：内核包互相声明 peer，staged 目录里的
// npm ci 若不带该配置会因 lock 缺 peer 闭包直接 EUSAGE 拒装（全新打包必踩）。
cpSync(path.join(dd, 'package.json'), path.join(staged, 'dsh-desktop', 'package.json'));
cpSync(path.join(dd, 'package-lock.json'), path.join(staged, 'dsh-desktop', 'package-lock.json'));
cpSync(path.join(dd, '.npmrc'), path.join(staged, 'dsh-desktop', '.npmrc'));

console.log('[stage] assets（114MB：38 插件 + 10 皮肤 + 图标）');
cpSync(path.join(dd, 'assets'), path.join(staged, 'dsh-desktop', 'assets'), { recursive: true });

console.log('[stage] vendor node/npm 运行时');
mkdirSync(path.join(staged, 'dsh-desktop', 'vendor'), { recursive: true });
cpSync(path.join(dd, 'vendor', 'node'), path.join(staged, 'dsh-desktop', 'vendor', 'node'), { recursive: true });
if (existsSync(path.join(dd, 'vendor', 'npm'))) {
  cpSync(path.join(dd, 'vendor', 'npm'), path.join(staged, 'dsh-desktop', 'vendor', 'npm'), { recursive: true });
}

console.log('[stage] 生产 node_modules（npm ci --omit=dev，首次较慢）');
const nmDest = path.join(staged, 'dsh-desktop', 'node_modules');
if (!skipNpm || !existsSync(nmDest)) {
  execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: path.join(staged, 'dsh-desktop'), stdio: 'inherit' });
}

// 上游修复的 vendored 覆盖（bash 输出折叠，PR #181）——npm ci 会还原成
// registry 版本，把仓库内的修复副本盖回去。
// （dsh-subprocess-local 的 pwsh 超时 vendored 修复已废弃：0.1.1-rc.2 上游以
//  Promise.race(done, delay(graceMs)) 原生实现同类兜底，随 registry 版本走。）
const vendoredBashFix = path.join(dd, 'node_modules', '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js');
if (existsSync(vendoredBashFix)) {
  cpSync(vendoredBashFix, path.join(nmDest, '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js'));
  console.log('[stage] 已回填 dsh-tool-bash 的 vendored 修复');
}

console.log('[stage] 完成：' + staged);

// 内核替换：用本地 deepseek-harness 构建产物覆盖 npm registry 版本。
const localKernelRoot = process.env.DSH_LOCAL_KERNEL
  ? path.resolve(process.env.DSH_LOCAL_KERNEL)
  : null;
if (localKernelRoot && existsSync(path.join(localKernelRoot, 'apps', 'cli', 'lib', 'bin.js'))) {
  console.log('[stage] 替换 dsh 内核（来自本地源码 ' + localKernelRoot + '）');
  const pkgMapping = [
    ['dsh', 'apps/cli'],
    ['dsh-anonymous-user-id', 'packages/identity/anonymous-user-id'],
    ['dsh-atomic-write', 'packages/util/atomic-write'],
    ['dsh-bash-local', 'packages/shell/bash-local'],
    ['dsh-code-runtime', 'packages/code-runtime/code-runtime'],
    ['dsh-compaction', 'packages/compaction/compaction'],
    ['dsh-fs', 'packages/fs/fs'],
    ['dsh-invariants', 'packages/runtime-diagnostics/invariants'],
    ['dsh-output-retention', 'packages/util/output-retention'],
    ['dsh-sandbox', 'packages/sandbox/sandbox'],
    ['dsh-scope', 'packages/core/scope'],
    ['dsh-session-telemetry', 'packages/session/session-telemetry'],
    ['dsh-session-title-llm', 'packages/session/session-title-llm'],
    ['dsh-shell', 'packages/shell/shell'],
    ['dsh-spill', 'packages/spill/spill'],
    ['dsh-subagent-in-process-driver', 'packages/subagent/subagent-in-process-driver'],
    ['dsh-subprocess', 'packages/subprocess/subprocess'],
    ['dsh-timeout', 'packages/util/timeout'],
    ['dsh-workflow', 'packages/workflow/workflow'],
    ['dsh-credentials-local', 'packages/credentials/credentials-local'],
  ];
  for (const [pkgName, relPath] of pkgMapping) {
    const srcPkg = path.join(localKernelRoot, relPath);
    const dstPkg = path.join(nmDest, '@deepseek-ai', pkgName);
    if (!existsSync(srcPkg)) { console.log('[stage] 跳过（未找到）@deepseek-ai/' + pkgName); continue; }
    rmSync(dstPkg, { recursive: true, force: true });
    mkdirSync(dstPkg, { recursive: true });
    if (existsSync(path.join(srcPkg, 'package.json'))) cpSync(path.join(srcPkg, 'package.json'), path.join(dstPkg, 'package.json'));
    if (existsSync(path.join(srcPkg, 'lib'))) cpSync(path.join(srcPkg, 'lib'), path.join(dstPkg, 'lib'), { recursive: true });
    if (existsSync(path.join(srcPkg, 'config'))) cpSync(path.join(srcPkg, 'config'), path.join(dstPkg, 'config'), { recursive: true });
    console.log('[stage] 已替换 @deepseek-ai/' + pkgName);
  }
} else { console.log('[stage] 使用 npm registry 内核版本'); }

// 闭包注入 schemastery + dsh-client-web-react
const EXTRA_DEPS = ['schemastery', '@deepseek-ai/dsh-client-web-react'];
const dshPkgPath = path.join(nmDest, '@deepseek-ai', 'dsh', 'package.json');
if (existsSync(dshPkgPath)) {
  let dshPkg;
  try { dshPkg = JSON.parse(readFileSync(dshPkgPath, 'utf8')); }
  catch { console.warn('[stage] 无法解析 dsh package.json，跳过闭包注入'); }
  if (dshPkg) {
    dshPkg.dependencies = dshPkg.dependencies || {};
    let injected = 0;
    for (const name of EXTRA_DEPS) {
      if (dshPkg.dependencies[name]) continue;
      const depPkgPath = path.join(nmDest, name, 'package.json');
      if (!existsSync(depPkgPath)) { console.warn('[stage] ' + name + ' 不在闭包中，跳过'); continue; }
      try {
        const ver = JSON.parse(readFileSync(depPkgPath, 'utf8')).version || '';
        dshPkg.dependencies[name] = '^' + ver;
        injected++;
        console.log('[stage] 已注入 ' + name + '@' + ver + ' → dsh 闭包');
      } catch { console.warn('[stage] 读取 ' + name + ' version 失败，跳过'); }
    }
    if (injected) {
      writeFileSync(dshPkgPath, JSON.stringify(dshPkg, null, 2) + '\n');
      console.log('[stage] dsh 闭包注入完成（' + injected + ' 个 extra dep）');
    }
  }
}

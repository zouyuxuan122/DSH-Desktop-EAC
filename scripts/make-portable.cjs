// scripts/make-portable.cjs — 构建方案1「一键安装」便携包
//
// 输出：dist-portable/
//   ├─ Deepseek-Harness-EAC/    —— 插件运行时所需的仓库根资产（精简）
//   │   ├─ *.js                 —— 根模块（desktop-core 依赖闭包 + stable-port）
//   │   ├─ scripts/plugin-manager-patch.js
//   │   ├─ assets/{plugins,skins,agent-presets}/
//   │   ├─ node_modules/
//   │   └─ vendor/{node,npm}/
//   ├─ dsh-eac-vscode.vsix      —— 插件安装包
//   ├─ 安装.bat                 —— 一键安装（设环境变量 + 装 vsix）
//   └─ 使用说明.txt
// 用法：node scripts/make-portable.cjs（在仓库根运行）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = process.cwd();
const outRoot = path.join(root, 'dist-portable');
const outRepo = path.join(outRoot, 'Deepseek-Harness-EAC');

// 根模块：desktop-core 依赖闭包（scripts/scan-root-deps.cjs 的结果）+ 插件直接 require 的 stable-port.js
const ROOT_MODULES = [
  'balance.js',
  'builtin-collision.js',
  'desktop-core.js',
  'koffi-preflight.js',
  'patch-row-heal.js',
  'plugin-guard.js',
  'plugin-manager-state.js',
  'plugin-updater.js',
  'preset-sync.js',
  'profile-module-heal.js',
  'updater.js',
  'stable-port.js',
  'package.json',
];
const SCRIPTS = ['scripts/plugin-manager-patch.js'];
const ASSETS = ['plugins', 'skins', 'agent-presets'];
const DIRS = ['node_modules', 'vendor'];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: false });
  console.log(`  已复制: ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
}

console.log('===== DSH EAC 便携包构建 =====');
fs.mkdirSync(outRoot, { recursive: true });
rmrf(outRepo);

// 1. 重新打包插件 vsix（保证最新）
console.log('[1/5] 打包插件 vsix…');
execSync('npx vsce package -o dsh-eac-vscode.vsix', { cwd: path.join(root, 'vscode'), stdio: 'inherit' });
const vsixSrc = path.join(root, 'vscode', 'dsh-eac-vscode.vsix');
const vsixDest = path.join(outRoot, 'dsh-eac-vscode.vsix');
fs.copyFileSync(vsixSrc, vsixDest);
console.log('  vsix:', vsixDest);

// 2. 复制根模块与 scripts
console.log('[2/5] 复制根模块…');
for (const rel of [...ROOT_MODULES, ...SCRIPTS]) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) {
    console.error(`  缺失: ${rel}`);
    process.exit(1);
  }
  const dest = path.join(outRepo, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
console.log(`  已复制 ${ROOT_MODULES.length + SCRIPTS.length} 个根模块`);

// 3. 复制 assets（内置插件/皮肤/agent preset）
console.log('[3/5] 复制 assets…');
for (const a of ASSETS) {
  const src = path.join(root, 'assets', a);
  if (!fs.existsSync(src)) {
    console.error(`  缺失 assets/${a}`);
    process.exit(1);
  }
  copyDir(src, path.join(outRepo, 'assets', a));
}

// 4. 复制 node_modules / vendor（内置运行时）
console.log('[4/5] 复制 node_modules 与 vendor（约 400MB，请稍候）…');
for (const d of DIRS) {
  copyDir(path.join(root, d), path.join(outRepo, d));
}

// 5. 生成安装脚本与说明
console.log('[5/5] 生成 安装.bat 与 使用说明.txt…');
const bat = `@echo off
chcp 65001 >nul
echo ============================================
echo   DSH EAC (DeepSeek Harness) VS Code 插件
echo   一键安装脚本
echo ============================================
echo.

set "REPO_ROOT=%~dp0Deepseek-Harness-EAC"

rem 1) 写入 DSH_EAC_REPO_ROOT 环境变量（用户级，本机生效）
echo [1/2] 设置环境变量 DSH_EAC_REPO_ROOT = %REPO_ROOT%
setx DSH_EAC_REPO_ROOT "%REPO_ROOT%" >nul
if errorlevel 1 (
  echo   设置环境变量失败，请以管理员身份重试。
  pause
  exit /b 1
)
echo   完成。

rem 2) 安装插件
echo [2/2] 安装插件 dsh-eac-vscode.vsix ...
where code >nul 2>nul
if errorlevel 1 (
  echo.
  echo   未找到 code 命令。请先安装 VS Code：
  echo   1. 打开 https://code.visualstudio.com 下载安装
  echo   2. 安装时勾选 "添加到 PATH"
  echo   3. 重开本脚本
  pause
  exit /b 1
)
code --install-extension "%~dp0dsh-eac-vscode.vsix"
if errorlevel 1 (
  echo   插件安装失败，请检查 VS Code 是否正在运行（需先关闭）。
  pause
  exit /b 1
)

echo.
echo ============================================
echo  安装完成！
echo  请完全退出并重新打开 VS Code，
echo  然后点击左侧活动栏（或右侧侧边栏）的
echo  DSH EAC 鲸鱼图标开始使用。
echo ============================================
pause
`;
fs.writeFileSync(path.join(outRoot, '安装.bat'), bat, 'utf8');

const readme = `DSH EAC VS Code 插件 — 便携包
===============================

【内容】
  Deepseek-Harness-EAC/   插件运行所需的完整运行时（dsh 内核、内置插件、Node 运行时）
  dsh-eac-vscode.vsix     VS Code 插件安装包
  安装.bat                一键安装脚本

【安装步骤】
  1. 目标电脑安装 VS Code（https://code.visualstudio.com），
     安装时务必勾选 "添加到 PATH"。
  2. 把整个便携包文件夹解压到纯英文路径（如 D:\\dsh-eac），
     注意不要放在中文或带空格的路径下。
  3. 双击运行 安装.bat，等待提示"安装完成"。
  4. 完全退出并重新打开 VS Code。
  5. 点击左侧活动栏（或右侧辅助侧边栏）的 DSH EAC 鲸鱼图标。

【说明】
  - 首次打开面板会自动同步内置插件并启动 DSH Web 服务，
    此过程需要联网（从 npm 仓库拉取 profile 依赖），之后即可离线使用。
  - 数据目录默认在 C:\\Users\\<用户名>\\.dsh-v4lite（会话/API Key/插件）。
  - 卸载：VS Code 扩展面板中卸载 dsh-eac-vscode 即可，
    数据目录不会被删除。
`;
fs.writeFileSync(path.join(outRoot, '使用说明.txt'), readme, 'utf8');

console.log('便携包目录完成：', outRoot);

// 6. 压缩成 zip（PowerShell Compress-Archive，避免中文路径问题）
console.log('压缩 zip（约数百 MB，请稍候）…');
const zipDest = path.join(outRoot, 'dsh-eac-vscode-便携包.zip');
rmrf(zipDest);
const ps = `Compress-Archive -Path '${outRepo.replace(/'/g, "''")}' -DestinationPath '${zipDest.replace(/'/g, "''")}' -CompressionLevel Fastest`;
execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
console.log('zip 完成：', zipDest);
console.log('===== 完成 =====');
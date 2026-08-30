// scripts/make-ide.cjs — 组装「Deepseek Harness EAC IDE」独立 IDE
//
// 输入底座（按优先级）：
//   1. 环境变量 IDE_BASE_ZIP（或第一个 CLI 参数）：VS Code zip 或已解压目录
//      —— 既可以是 vscode-fork 的 gulp 构建产物（VSCode-win32-x64-1.134.0.zip），
//         也可以是官方/缓存的 VS Code 安装包目录（无 MSVC 机器上的降级路径）
//   2. 自动探测：vscode-fork/ 下构建产物 zip → vscode/.vscode-test/ 缓存目录
//
// 输出：dist-ide/
//   ├─ Deepseek-Harness-EAC-IDE/         —— 完整 IDE（无空格路径）
//   │   ├─ dsh-eac-ide.exe / Code.exe    —— VS Code 底座
//   │   ├─ <hash>/resources/app/
//   │   │   ├─ product.json              —— 品牌补丁（标题栏 = Deepseek Harness EAC IDE）
//   │   │   └─ extensions/dsh-eac-vscode/ —— 内置扩展（随底座启动，无需安装）
//   │   │       ├─ out/extension.js …
//   │   │       └─ runtime/              —— dsh 运行时闭包（desktop-core + node_modules + vendor）
//   │   ├─ Deepseek Harness EAC IDE.bat  —— 启动器
//   │   └─ 使用说明.txt
//   ├─ Deepseek-Harness-EAC-IDE.zip
//   └─ （NSIS 安装器由 scripts/build-ide-installer.cjs 产出）
//
// 用法：node scripts/make-ide.cjs [baseZipOrDir]   （在仓库根运行）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = process.cwd();
const outRoot = path.join(root, 'dist-ide');
const FOLDER_NAME = 'Deepseek-Harness-EAC-IDE';
const DISPLAY_NAME = 'Deepseek Harness EAC IDE';
const outIde = path.join(outRoot, FOLDER_NAME);
const EXT_NAME = 'dsh-eac-vscode';

// —— 运行时闭包（与 scripts/make-portable.cjs 一致：desktop-core 依赖 + 内置资产）——
const ROOT_MODULES = [
  'balance.js', 'builtin-collision.js', 'desktop-core.js', 'koffi-preflight.js',
  'patch-row-heal.js', 'plugin-guard.js', 'plugin-manager-state.js', 'plugin-updater.js',
  'preset-sync.js', 'profile-module-heal.js', 'updater.js', 'stable-port.js', 'package.json',
];
const SCRIPTS = ['scripts/plugin-manager-patch.js'];
const ASSETS = ['plugins', 'skins', 'agent-presets'];
const RUNTIME_DIRS = ['node_modules', 'vendor'];

// —— 内置扩展需要随扩展分发的文件（编译产物在 vscode/out）——
const EXT_FILES = ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'README.md', 'LICENSE', 'assets'];
const EXT_DIRS = ['out'];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: false });
}
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** 在 dist 下定位 resources/app 目录（布局随版本变化：<hash>/resources/app 或 resources/app） */
function findAppDir(dist) {
  const direct = path.join(dist, 'resources', 'app');
  if (fs.existsSync(path.join(direct, 'product.json'))) return direct;
  for (const entry of fs.readdirSync(dist)) {
    const cand = path.join(dist, entry, 'resources', 'app');
    if (fs.existsSync(path.join(cand, 'product.json'))) return cand;
  }
  throw new Error(`未找到 resources/app/product.json：${dist}`);
}

/** 解压/拷贝底座到输出目录（同底座目录已就绪则跳过，省磁盘与时间） */
function prepareBase(base, dist) {
  const marker = path.join(outRoot, '.base-info');
  const baseKey = path.isAbsolute(base) ? base : path.resolve(base);
  if (!fs.statSync(base).isFile()) {
    const prev = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    const hasExe = fs.existsSync(dist) && fs.readdirSync(dist).some((f) => /\.exe$/i.test(f));
    if (prev === baseKey && hasExe) {
      console.log(`底座目录未变，跳过重新拷贝（${baseKey}）`);
      return;
    }
  }
  rmrf(dist);
  fs.mkdirSync(dist, { recursive: true });
  if (fs.statSync(base).isFile()) {
    console.log(`解压底座: ${base}`);
    execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${base.replace(/'/g, "''")}' -DestinationPath '${dist.replace(/'/g, "''")}' -Force"`, { stdio: 'inherit' });
  } else {
    console.log(`复制底座目录: ${base}`);
    copyDir(base, dist);
  }
  fs.writeFileSync(marker, baseKey, 'utf8');
}

/** 品牌补丁：确保显示名为 DISPLAY_NAME、数据目录独立（官方底座或旧产物都会修正；幂等） */
function patchProductJson(appDir) {
  const p = path.join(appDir, 'product.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  let changed = false;
  if (d.nameShort !== DISPLAY_NAME || d.nameLong !== DISPLAY_NAME) {
    d.nameShort = DISPLAY_NAME;
    d.nameLong = DISPLAY_NAME;
    changed = true;
  }
  if (!d.dataFolderName || d.dataFolderName === '.vscode' || d.dataFolderName === 'Code') {
    d.dataFolderName = 'Deepseek-Harness-EAC-IDE';
    changed = true;
  }
  if (!d.serverDataFolderName || d.serverDataFolderName === '.vscode-server') {
    d.serverDataFolderName = '.dsh-eac-ide-server';
    changed = true;
  }
  if (d.win32MutexName === 'vscode') {
    d.win32MutexName = 'dsh-eac-ide';
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(p, JSON.stringify(d, null, '\t'), 'utf8');
    console.log(`product.json 品牌补丁完成 → ${d.nameShort}（数据目录 ${d.dataFolderName}）`);
  } else {
    console.log(`product.json 已是目标品牌（${d.nameShort}）`);
  }
}

/** 注入内置扩展 + 运行时闭包 */
function injectExtension(appDir) {
  const extDest = path.join(appDir, 'extensions', EXT_NAME);
  const runtimeDest = path.join(extDest, 'runtime');
  const vscodeDir = path.join(root, 'vscode');

  console.log(`注入内置扩展 → ${path.relative(root, extDest)}`);
  rmrf(extDest);
  for (const rel of EXT_FILES) {
    const src = path.join(vscodeDir, rel);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) {
      copyDir(src, path.join(extDest, rel));
    } else {
      copyFile(src, path.join(extDest, rel));
    }
  }
  for (const rel of EXT_DIRS) {
    const src = path.join(vscodeDir, rel);
    if (!fs.existsSync(src)) throw new Error(`扩展编译产物缺失: ${rel}（先执行 vscode/ 下 npm run compile）`);
    copyDir(src, path.join(extDest, rel));
  }

  console.log(`拷贝 dsh 运行时闭包 → ${path.relative(root, runtimeDest)}（约数百 MB，请稍候）…`);
  rmrf(runtimeDest);
  for (const rel of ROOT_MODULES) {
    copyFile(path.join(root, rel), path.join(runtimeDest, rel));
  }
  for (const rel of SCRIPTS) {
    copyFile(path.join(root, rel), path.join(runtimeDest, rel));
  }
  for (const a of ASSETS) {
    copyDir(path.join(root, 'assets', a), path.join(runtimeDest, 'assets', a));
  }
  for (const dir of RUNTIME_DIRS) {
    copyDir(path.join(root, dir), path.join(runtimeDest, dir));
  }
}

/** 启动器 bat：动态定位可执行文件（fork 产物 exe 名 = applicationName，官方底座 = Code.exe） */
function writeLauncher(dist) {
  const candidates = fs
    .readdirSync(dist)
    .filter((f) => /\.exe$/i.test(f) && !/unins/i.test(f));
  const exeName = candidates.find((f) => /deepseek/i.test(f)) || candidates.find((f) => /dsh-eac-ide/i.test(f)) || candidates.find((f) => /code/i.test(f)) || candidates[0];
  const bat = `@echo off
rem Deepseek Harness EAC IDE 启动器
set "ROOT=%~dp0"
start "" "%ROOT%${exeName}" %*
`;
  fs.writeFileSync(path.join(dist, 'Deepseek Harness EAC IDE.bat'), bat, 'utf8');
  // IDE 图标（安装器快捷方式用）
  const icoSrc = path.join(root, 'assets', 'icon.ico');
  if (fs.existsSync(icoSrc)) {
    fs.copyFileSync(icoSrc, path.join(dist, 'Deepseek-Harness-EAC-IDE.ico'));
  }
  console.log(`启动器完成（exe: ${exeName}）`);
  return exeName;
}

function writeReadme(dist) {
  const readme = `Deepseek Harness EAC IDE
=====================

【这是什么】
  一个内置了 DSH EAC 插件的 VS Code 系 IDE：
  启动即内置「DeepSeek Harness EAC」侧边栏面板（dsh-eac-vscode 内置扩展），
  dsh 内核、内置插件、Node 运行时全部捆绑在扩展目录内（runtime/），开箱即用。

【启动】
  双击「Deepseek Harness EAC IDE.bat」（或直接运行 ${fs.readdirSync(dist).filter((f) => /\.exe$/i.test(f) && !/unins/i.test(f))[0] || 'Code.exe'}）。

【使用】
  1. 点击左侧活动栏（或右侧辅助侧边栏）的 DSH EAC 鲸鱼图标打开面板。
  2. 首次打开会自动同步内置插件并启动 DSH Web 服务，需要联网
     （从 npm 拉取 profile 依赖），之后可离线使用。
  3. 面板右上角按钮：外部浏览器打开 / 重启服务 / 停止 / 复制网址 / 查看日志。

【数据目录】
  - DSH 数据（会话/API Key/插件）：C:\\Users\\<用户名>\\.dsh-v4lite
  - IDE 用户数据（设置/扩展）：%APPDATA%\\Deepseek-Harness-EAC-IDE
  - 日志：%APPDATA%\\Deepseek Harness EAC v4Lite\\logs

【卸载】
  直接删除本目录（便携形态）。安装器形态请在「设置 → 应用」中卸载。
`;
  fs.writeFileSync(path.join(dist, '使用说明.txt'), readme, 'utf8');
}

/** 打包 zip（优先 7za——比 PowerShell Compress-Archive 快一个量级；兜底用 Compress-Archive） */
function packZip() {
  const zipDest = path.join(outRoot, `${FOLDER_NAME}.zip`);
  rmrf(zipDest);
  console.log('打包 zip（约数百 MB，请稍候）…');
  const sevenZa = [
    path.join(root, '..', 'tools', '7z', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(root, '..', 'tools', '7z', '7za.exe'),
  ].find((p) => fs.existsSync(p));
  if (sevenZa) {
    execSync(`"${sevenZa}" a -tzip -mx=5 -y "${zipDest}" "${path.basename(outIde)}"`, { cwd: outRoot, stdio: 'ignore' });
  } else {
    const ps = `Compress-Archive -Path '${outIde.replace(/'/g, "''")}' -DestinationPath '${zipDest.replace(/'/g, "''")}' -CompressionLevel Fastest`;
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  }
  const size = (fs.statSync(zipDest).size / 1024 / 1024).toFixed(0);
  console.log(`zip 完成：${zipDest}（${size} MB）`);
}

function resolveBase() {
  const arg = process.argv[2] || process.env.IDE_BASE_ZIP;
  if (arg) {
    if (!fs.existsSync(arg)) throw new Error(`底座不存在: ${arg}`);
    return arg;
  }
  const forkZip = path.join(root, '..', 'vscode-fork', 'VSCode-win32-x64-1.134.0.zip');
  if (fs.existsSync(forkZip)) return forkZip;
  const cache = path.join(root, 'vscode', '.vscode-test');
  if (fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache).filter((f) => f.startsWith('vscode-win32-x64-archive'));
    if (dirs.length) return path.join(cache, dirs[0]);
  }
  throw new Error('未找到底座：请传 zip 或目录参数，或设置 IDE_BASE_ZIP');
}

/** 品牌图标：rcedit 替换 exe 图标（覆盖窗口左上角/任务栏/资源管理器）+ app 资源 code.ico。
 *  fork 底座在源码构建时已嵌入鲸鱼图标（resources/win32/code.ico 替换过），幂等重复执行无害。 */
function brandIcons(appDir, dist) {
  const ico = path.join(root, 'assets', 'icon.ico');
  if (!fs.existsSync(ico)) {
    console.log('跳过图标替换（缺 assets/icon.ico）');
    return;
  }
  const rcedit = [
    path.join(root, '..', 'vscode-fork', 'node_modules', 'rcedit', 'bin', 'rcedit.exe'),
  ].find((p) => fs.existsSync(p));
  const exe = fs
    .readdirSync(dist)
    .filter((f) => /\.exe$/i.test(f) && !/unins/i.test(f))
    .find((f) => /deepseek|dsh-eac-ide|code/i.test(f)) || null;
  if (rcedit && exe) {
    execSync(`"${rcedit}" "${path.join(dist, exe)}" --set-icon "${ico}"`, { stdio: 'ignore' });
    console.log(`exe 图标已替换（${exe}）`);
  } else {
    console.log('跳过 exe 图标替换（无 rcedit 或未定位 exe）');
  }
  const win32Ico = path.join(appDir, 'resources', 'win32', 'code.ico');
  if (fs.existsSync(win32Ico)) {
    fs.copyFileSync(ico, win32Ico);
    console.log('app 资源 code.ico 已替换');
  }
  // 自定义标题栏「菜单栏最左」图标（CSS background-image，与 exe 图标无关；替换为白色鲸鱼，深色标题栏可见）。
  // 注意：构建后的 CSS 会把 url() 重定向到 out 根的 media/——workbench.desktop.main.css 与
  // sessions.desktop.main.css 实际加载 out/media/code-icon.svg，out/vs/workbench/browser/media/code-icon.svg
  // 只是源码路径副本；out/media/vscode-icon.svg 是 sessions「Open in VS Code」挂件的 dev 回退图标。
  const whaleSvg = path.join(root, 'assets', 'whale-icon-titlebar.svg');
  if (!fs.existsSync(whaleSvg)) throw new Error('缺 assets/whale-icon-titlebar.svg');
  const BRAND_ICONS = new Set(['code-icon.svg', 'vscode-icon.svg']);
  const titleIcons = [
    path.join(appDir, 'out', 'media', 'code-icon.svg'),
    path.join(appDir, 'out', 'media', 'vscode-icon.svg'),
    path.join(appDir, 'out', 'vs', 'workbench', 'browser', 'media', 'code-icon.svg'),
  ];
  let replaced = 0;
  for (const titleIcon of titleIcons) {
    if (fs.existsSync(titleIcon)) {
      fs.copyFileSync(whaleSvg, titleIcon);
      replaced++;
    }
  }
  if (!replaced) throw new Error('未找到品牌图标（out/media/code-icon.svg 与 out/media/vscode-icon.svg 均不存在）');
  // 防回归校验：扫描 out 下所有 CSS 里品牌图标（code-icon/vscode-icon.svg）的 url() 引用，
  // 解析后的目标文件必须已是鲸鱼，否则说明构建器又把 URL 重定向到了未替换的副本（直接报错而不是默默出蓝色图标）。
  const outDir = path.join(appDir, 'out');
  if (fs.existsSync(outDir)) {
    const whaleBuf = fs.readFileSync(whaleSvg);
    const cssFiles = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.css')) cssFiles.push(p);
      }
    })(outDir);
    let refs = 0;
    for (const cssFile of cssFiles) {
      const css = fs.readFileSync(cssFile, 'utf8');
      for (const m of css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
        const ref = decodeURIComponent(m[2]);
        if (!BRAND_ICONS.has(ref.split(/[\\/]/).pop())) continue;
        const target = path.resolve(path.dirname(cssFile), ref);
        refs++;
        if (!fs.existsSync(target) || !fs.readFileSync(target).equals(whaleBuf)) {
          throw new Error(`品牌图标校验失败：${path.relative(appDir, cssFile)} 引用的 ${m[2]} 不是鲸鱼图标`);
        }
      }
    }
    console.log(`品牌图标已替换为白色鲸鱼（${replaced} 份；CSS 引用校验 ${refs} 处全部通过）`);
  } else {
    console.log(`品牌图标已替换为白色鲸鱼（${replaced} 份）`);
  }
}

/** 欢迎页鲸鱼虚影水印：拷贝 SVG 到 out/media + 向内置 CSS 追加 ::after 规则（幂等，带 marker）。
 *  .gettingStartedContainer 本身 position:relative + overflow:hidden，伪元素水印不溢出、不挡交互。 */
function brandWelcomeWatermark(appDir) {
  const svg = path.join(root, 'assets', 'whale-icon-watermark.svg');
  const cssPath = path.join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.css');
  if (!fs.existsSync(svg)) throw new Error('缺 assets/whale-icon-watermark.svg');
  if (!fs.existsSync(cssPath)) throw new Error('未找到 workbench.desktop.main.css，无法注入欢迎页水印');
  copyFile(svg, path.join(appDir, 'out', 'media', 'whale-icon-watermark.svg'));
  const marker = '/* dsh-eac-ide welcome whale watermark */';
  const css = fs.readFileSync(cssPath, 'utf8');
  if (css.includes(marker)) {
    console.log('欢迎页鲸鱼水印已存在，跳过注入');
    return;
  }
  const rule = `
${marker}
.monaco-workbench .part.editor > .content .gettingStartedContainer::after {
	content: '';
	position: absolute;
	left: 50%;
	top: 50%;
	transform: translate(-50%, -50%);
	height: min(80%, 780px);
	aspect-ratio: 1 / 1;
	background: url('../../media/whale-icon-watermark.svg') no-repeat center / contain;
	opacity: 0.06;
	pointer-events: none;
	z-index: 0;
}
.monaco-workbench.vs .part.editor > .content .gettingStartedContainer::after {
	filter: invert(1);
}`;
  fs.writeFileSync(cssPath, css + '\n' + rule + '\n', 'utf8');
  console.log('欢迎页鲸鱼水印已注入');
}

console.log('===== Deepseek Harness EAC IDE 组装 =====');
const base = resolveBase();
console.log('底座:', base);
prepareBase(base, outIde);
const appDir = findAppDir(outIde);
console.log('app 目录:', path.relative(outIde, appDir));
patchProductJson(appDir);
injectExtension(appDir);
writeLauncher(outIde);
brandIcons(appDir, outIde);
brandWelcomeWatermark(appDir);
writeReadme(outIde);
packZip();
console.log('===== IDE 组装完成 =====');
console.log('目录:', outIde);
console.log('zip :', path.join(outRoot, `${FOLDER_NAME}.zip`));

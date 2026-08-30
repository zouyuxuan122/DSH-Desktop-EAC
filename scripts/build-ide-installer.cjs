// scripts/build-ide-installer.cjs — 编译 Deepseek Harness EAC IDE 的 NSIS 安装器
//
// 背景：运行时闭包（extension/runtime/）内存在路径超过 260 字符的深路径文件
//（如 chromium-bidi 的 out/Default/gen/...，插件实际运行需要，不可裁剪），
// NSIS 的 File 命令无法处理 → 采用「NSIS + 运行时压缩包」混合方案：
//   1. runtime/ 整体用 7za 打成 runtime.7z（7-Zip 原生支持长路径）
//   2. 安装器本体只打包除 runtime 外的其余文件（无超长路径）
//   3. 安装时由捆绑的 7za.exe 把 runtime.7z 解压回原位（长路径无忧）
//   4. 卸载时用 PowerShell 递归删除 runtime（同样无 260 限制）
//
// 前置：dist-ide/Deepseek-Harness-EAC-IDE 已由 make-ide.cjs 产出（缺失时自动先组装）
// 工具：7za（优先 node_modules/7zip-bin，否则临时安装到仓库依赖）；平铺到 staging 后交给 makensis。
// NSIS：优先 D:\vs code\tools\nsis，否则下载 nsis-3.09.zip。
// 产物：dist-ide/Deepseek-Harness-EAC-IDE-Setup-x64.exe
//
// 用法：node scripts/build-ide-installer.cjs （在仓库根运行）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = process.cwd();
const IDE_DIR = path.join(root, 'dist-ide', 'Deepseek-Harness-EAC-IDE');
const outExe = path.join(root, 'dist-ide', 'Deepseek-Harness-EAC-IDE-Setup-x64.exe');

/** 动态定位 app 目录（官方底座带 <hash>/ 前缀，fork 底座直连 resources/app）并求 runtime 相对路径 */
function resolveRuntimeRel() {
  const direct = path.join(IDE_DIR, 'resources', 'app');
  const candidates = fs.existsSync(direct)
    ? [direct]
    : fs.readdirSync(IDE_DIR).map((e) => path.join(IDE_DIR, e, 'resources', 'app')).filter((p) => fs.existsSync(p));
  const appDir = candidates.find((p) => fs.existsSync(path.join(p, 'product.json')));
  if (!appDir) throw new Error('未找到 resources/app: ' + IDE_DIR);
  const rel = path.relative(IDE_DIR, path.join(appDir, 'extensions', 'dsh-eac-vscode', 'runtime')).replace(/\\/g, path.sep);
  console.log('runtime 相对路径:', rel);
  return rel;
}

// 安装器 staging（短路径，避免 NSIS 源路径超长；含除 runtime 外全部文件 + runtime.7z + 7za.exe）
const STAGE = path.join(root, 'dist-ide', '.stage');
const RUNTIME_REL = resolveRuntimeRel();

function find7za() {
  const cands = [
    path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(root, '..', 'tools', '7z', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(root, '..', 'tools', '7z', '7za.exe'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  // 兜底：临装到仓库 devDependencies
  execSync('npm install --no-save 7zip-bin --no-audit --no-fund', { cwd: root, stdio: 'inherit' });
  return cands[0];
}

function ensureNsis() {
  const base = path.join(root, '..', 'tools', 'nsis');
  const zip = path.join(root, '..', 'tools', 'nsis-3.09.zip');
  const direct = path.join(base, 'makensis.exe');
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const cand = path.join(base, entry, 'makensis.exe');
    if (fs.existsSync(cand)) return cand;
  }
  fs.mkdirSync(base, { recursive: true });
  if (!fs.existsSync(zip)) {
    console.log('下载 NSIS 3.09（约 2.5MB）…');
    execSync(`curl -sL -o "${zip}" "https://downloads.sourceforge.net/project/nsis/NSIS%203/3.09/nsis-3.09.zip"`, { stdio: 'inherit' });
  }
  console.log('解压 NSIS…');
  execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${base.replace(/'/g, "''")}' -Force"`, { stdio: 'inherit' });
  for (const entry of fs.readdirSync(base)) {
    const cand = path.join(base, entry, 'makensis.exe');
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error('NSIS 解压后未找到 makensis.exe: ' + base);
}

function stage() {
  console.log('== [1/5] 准备安装器 staging（排除 runtime，深路径单独打包）==');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  const runtimeAbs = path.join(IDE_DIR, RUNTIME_REL);
  try {
    execSync(`robocopy "${IDE_DIR}" "${STAGE}" /E /XD "${runtimeAbs}" /R:3 /W:2 /NODCOPY /NFL /NDL /NJH /NJS`, { stdio: 'inherit' });
  } catch (err) {
    if ((err.status ?? 0) >= 8) throw err;
  }
  console.log('staging 文件复制完成');
}

function packRuntime7z(sevenZa) {
  console.log('== [2/5] 打包 runtime.7z（7za 支持长路径；约数百 MB，请稍候）==');
  const out7z = path.join(STAGE, 'runtime.7z');
  fs.rmSync(out7z, { force: true });
  execSync(`"${sevenZa}" a -t7z -mx=5 -y "${out7z}" "${RUNTIME_REL}"`, { cwd: IDE_DIR, stdio: 'inherit' });
  fs.copyFileSync(sevenZa, path.join(STAGE, '7za.exe'));
  const size = (fs.statSync(out7z).size / 1024 / 1024).toFixed(0);
  console.log(`runtime.7z 完成（${size} MB）`);
}

function buildNsis(makensis) {
  console.log('== [3/5] 编译 NSIS 安装器（请耐心等待）==');
  fs.rmSync(outExe, { force: true });
  execSync(`"${makensis}" /NOCD /DDIST_DIR="${STAGE}" "${path.join(root, 'build', 'ide-installer.nsh')}"`, { cwd: root, stdio: 'inherit' });
  if (!fs.existsSync(outExe)) throw new Error('makensis 未产出安装器: ' + outExe);
  const size = (fs.statSync(outExe).size / 1024 / 1024).toFixed(0);
  console.log('== [4/5] 清理 staging ==');
  fs.rmSync(STAGE, { recursive: true, force: true });
  console.log(`✅ 安装器完成：${outExe}（${size} MB）`);
}

function main() {
  if (!fs.existsSync(IDE_DIR)) {
    console.log('IDE 目录缺失，先运行 make-ide.cjs…');
    execSync('node scripts/make-ide.cjs', { cwd: root, stdio: 'inherit' });
  }
  const sevenZa = find7za();
  const makensis = ensureNsis();
  console.log('7za:', sevenZa);
  console.log('makensis:', makensis);
  stage();
  packRuntime7z(sevenZa);
  buildNsis(makensis);
}

try {
  main();
} catch (err) {
  console.error('❌ 安装器构建失败:', err.message);
  process.exit(1);
}
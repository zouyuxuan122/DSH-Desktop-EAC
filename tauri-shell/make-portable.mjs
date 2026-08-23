'use strict';
// Tauri 便携版装配（P4/R6）：把 release 构建产物打成 zip 分发包。
//
// 布局（= NSIS 安装树同构，resource_root() exe 同级解析）：
//   dsh-eac-shell.exe
//   .dsh-portable          ← 便携标记（client-updater isTauriPortable 判定）
//   sidecar/{server,bridge,rescue-integration}.js
//   dsh-desktop/<完整运行树>
//
// 用法：node make-portable.mjs [--out <dir>]
//   前置：tauri build 已完成（target/release/{dsh-eac-shell.exe, sidecar/, dsh-desktop/}）。
//   产物：Deepseek-Harness-EAC-<version>-portable.zip + SHA256SUMS.txt

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.resolve(shellDir, '..');
const rel = path.join(shellDir, 'target', 'release');
const version = JSON.parse(readFileSync(path.join(repo, 'dsh-desktop', 'package.json'), 'utf8')).version || '0.0.0';

const outArg = process.argv.indexOf('--out');
const outDir = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(rel, 'portable');

const exe = path.join(rel, 'dsh-eac-shell.exe');
for (const need of [exe, path.join(rel, 'sidecar', 'server.js'), path.join(rel, 'dsh-desktop', 'package.json')]) {
  if (!existsSync(need)) {
    console.error('[portable] 缺少构建产物: ' + need);
    console.error('[portable] 请先完成 tauri build（或 node stage-resources.mjs 后 cargo tauri build）');
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `Deepseek-Harness-EAC-${version}-portable.zip`);
rmSync(zipPath, { force: true });

console.log('[portable] 装配暂存目录（zip 根 = 安装树同构，顶层无包裹目录）');
const staging = path.join(outDir, '.staging-portable');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
copyFileSync(exe, path.join(staging, 'dsh-eac-shell.exe'));
writeFileSync(path.join(staging, '.dsh-portable'), '');

// robocopy 退出码 0-7 均为成功语义（1=有文件复制）；execSync 对非零会抛，需容错。
function robocopy(src, dest) {
  let code = 0;
  try {
    execSync(`robocopy "${src}" "${dest}" /E /NFL /NDL /NJH /NJS /NP`, { stdio: ['ignore', 'ignore', 'ignore'], shell: 'cmd.exe' });
  } catch (e) {
    code = e.status == null ? 8 : e.status;
  }
  if (code >= 8) throw new Error(`robocopy 失败 (${code}): ${src} -> ${dest}`);
}

console.log('[portable] 复制 sidecar + dsh-desktop（数万文件，耐心等）');
robocopy(path.join(rel, 'sidecar'), path.join(staging, 'sidecar'));
robocopy(path.join(rel, 'dsh-desktop'), path.join(staging, 'dsh-desktop'));

console.log('[portable] 压缩 zip（Compress-Archive，约 500MB 需几分钟）');
const psZip = [
  "$ProgressPreference='SilentlyContinue'",
  'Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $env:P_STAGE | ForEach-Object { $_.FullName }) -DestinationPath $env:P_ZIP -Force',
].join('; ');
execSync('powershell -NoProfile -Command "' + psZip.replace(/"/g, '\\"') + '"', {
  env: { ...process.env, P_STAGE: staging, P_ZIP: zipPath },
  stdio: 'inherit',
});

console.log('[portable] 计算 SHA256');
const hash = createHash('sha256');
hash.update(readFileSync(zipPath));
const sha256 = hash.digest('hex').toUpperCase();
writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sha256}  ${path.basename(zipPath)}\n`);

console.log('[portable] 清理暂存');
rmSync(staging, { recursive: true, force: true });

const mb = (statSync(zipPath).size / 1048576).toFixed(1);
console.log(`[portable] 完成: ${zipPath} (${mb} MB)`);
console.log(`[portable] SHA256: ${sha256}`);

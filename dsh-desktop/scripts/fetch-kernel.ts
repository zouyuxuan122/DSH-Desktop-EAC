'use strict';

// 一键重建 vendored 内核 tarball 缓存（vendor/kernel/<version>/）。
//
// Why: @deepseek-ai/dsh 0.1.2-alpha.1 尚未发布 npm，只能从 GitHub tag 源码
// 构建官方 release:pack 链。tarball 缓存不入库（vendor/ 已 gitignore），本
// 脚本保证缓存可复现：下载 tag → 解包 → 套 Windows 构建补丁 → pnpm install
// → build:official → 双家族 pack → 落位 vendor/kernel/<version>/。
//
// Windows 补丁两处（均为构建工具脚本，不进任何包产物）：
//   1. scripts/release/pack.ts  —— 裸 spawn('pnpm') 在 Windows 找不到 .cmd，
//      改走 pnpmInvocation（npm_execpath + node）；
//   2. scripts/release/tarball.ts —— GNU tar 把 `D:\...` 当远程 tape 主机，
//      win32 下加 --force-local。
//
// 前置：pnpm 版本必须等于内核 packageManager 钉住的版本（脚本自校验）。
// 用法：npm run fetch-kernel [-- <tag>]（默认 dsh-v0.1.2-alpha.1）

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import cp = require('node:child_process');

const REPO = 'deepseek-ai/deepseek-harness';
const DEFAULT_TAG = 'dsh-v0.1.2-alpha.1';
const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'vendor', 'kernel', '.build');

interface StepEnv {
  npm_execpath?: string;
  TEMP?: string;
  TMP?: string;
  DSH_CLIENT_COMMIT_HASH?: string;
  npm_config_registry?: string;
}

function run(command: string, args: string[], cwd: string, env?: StepEnv): void {
  const result = cp.spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`命令失败（${String(result.status)}）: ${command} ${args.join(' ')}`);
}

function capture(command: string, args: string[]): string {
  const result = cp.spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`命令失败: ${command} ${args.join(' ')}`);
  }
  return (result.stdout ?? '').trim();
}

/** 解析 pnpm 的 JS 入口，优先使用 CI 显式提供的 PNPM_HOME。 */
function resolvePnpmEntry(): { entry: string; version: string } {
  const prefix = process.env.PNPM_HOME;
  const candidates = prefix === undefined ? [] : [
    path.join(prefix, 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
  const command = process.platform === 'win32' ? 'where' : 'which';
  const located = capture(command, ['pnpm']).split(/\r?\n/)[0];
  if (located === undefined || located === '') throw new Error('PATH 中找不到 pnpm');
  const binDir = path.dirname(located.replace(/\.cmd$/i, ''));
  candidates.push(
    path.join(binDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(binDir, '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  );
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  if (!entry) {
    throw new Error(`找不到 pnpm 的 JS 入口（${candidates.join(', ')}）。请先 npm install -g pnpm@<内核钉住的版本>`);
  }
  const version = capture(process.execPath, [entry, '--version']);
  return { entry, version };
}

function main(): void {
  const tag = process.argv[2] || DEFAULT_TAG;
  const version = tag.replace(/^dsh-v/, '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
    throw new Error(`无法从 tag 推导版本号: ${tag}`);
  }
  const dest = path.join(ROOT, 'vendor', 'kernel', version);
  if (fs.existsSync(dest)) {
    console.log(`fetch-kernel: 缓存已存在 ${dest}（如需重建请先删除）`);
    return;
  }

  const pnpm = resolvePnpmEntry();
  console.log(`fetch-kernel: tag=${tag} version=${version} pnpm=${pnpm.version}`);

  // 内核 packageManager 钉死 pnpm 版本（当前 11.7.0）：build.ts 内部会再起
  // `pnpm` 子进程，版本不符会直接拒绝执行。
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const tgzPath = path.join(WORK, `${tag}.tar.gz`);
  const url = `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`;
  const curlArgs = ['-fsSL', '-o', tgzPath, url];
  if (process.platform === 'win32') curlArgs.splice(1, 0, '--ssl-no-revoke'); // 本机证书库校验坑
  console.log(`fetch-kernel: 下载 ${url}`);
  run('curl', curlArgs, WORK);

  console.log('fetch-kernel: 解包');
  const tarArgs = ['-xzf', tgzPath];
  run('tar', tarArgs, WORK);
  const srcDir = fs.readdirSync(WORK).find((e) => e.startsWith('deepseek-harness-') && fs.statSync(path.join(WORK, e)).isDirectory());
  if (!srcDir) throw new Error('解包后找不到源码目录');
  const src = path.join(WORK, srcDir);

  // 补丁 1：pack.ts 走 pnpmInvocation（Windows spawn('pnpm') ENOENT）。
  const packTs = path.join(src, 'scripts', 'release', 'pack.ts');
  let pack = fs.readFileSync(packTs, 'utf8');
  const packAnchor = "await runConcurrent('pnpm', ['--dir', member.directory, 'pack', '--pack-destination', destination])";
  if (!pack.includes(packAnchor)) throw new Error('pack.ts 锚点未命中，上游脚本已变化，需人工评估补丁');
  pack = pack.replace(
    "import { isEntry, runConcurrent } from './process.ts'",
    "import { pnpmInvocation } from '../pnpm-invocation.ts'\nimport { isEntry, runConcurrent } from './process.ts'",
  ).replace(
    packAnchor,
    "const invocation = pnpmInvocation(['--dir', member.directory, 'pack', '--pack-destination', destination])\n  await runConcurrent(invocation.command, invocation.args)",
  );
  fs.writeFileSync(packTs, pack);

  // 补丁 2：使用相对归档路径，兼容 Windows BSD tar 与 GNU tar。
  const tarballTs = path.join(src, 'scripts', 'release', 'tarball.ts');
  let tarball = fs.readFileSync(tarballTs, 'utf8');
  tarball = tarball.replace("import { capture } from './process.ts'", "import path from 'node:path'\nimport { capture } from './process.ts'\nconst { relative } = path");
  const tarAnchors = ["capture('tar', ['-tzf', tarball])", "capture('tar', ['-xOzf', tarball, 'package/package.json'])"];
  for (const anchor of tarAnchors) {
    if (!tarball.includes(anchor)) throw new Error(`tarball.ts 锚点未命中: ${anchor}`);
    const replacement = anchor.replace('tarball])', "relative(process.cwd(), tarball)])");
    tarball = tarball.replace(anchor, replacement);
  }
  fs.writeFileSync(tarballTs, tarball);

  // git init：lefthook postinstall 等 git 探针在无仓库目录会失败。
  cp.spawnSync('git', ['init', '-q'], { cwd: src });
  // commit hash：构建元数据要求 7 位以上十六进制；tarball 无 .git，取 tag 指向的 commit。
  const refJson = capture('curl', process.platform === 'win32'
    ? ['--ssl-no-revoke', '-fsSL', `https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`]
    : ['-fsSL', `https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`]);
  const commitSha = JSON.parse(refJson).object.sha as string;

  const tempDir = process.platform === 'win32' ? path.join(WORK, 'tmp') : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-'));
  const baseEnv: StepEnv = {
    npm_execpath: pnpm.entry,
    TEMP: tempDir,
    TMP: tempDir,
    DSH_CLIENT_COMMIT_HASH: commitSha.slice(0, 7).toLowerCase(),
  };
  fs.mkdirSync(path.join(WORK, 'tmp'), { recursive: true });

  console.log('fetch-kernel: pnpm install（首次较慢）');
  run(process.execPath, [pnpm.entry, 'install'], src, baseEnv);
  console.log('fetch-kernel: build:official');
  run(process.execPath, [pnpm.entry, 'run', 'build:official'], src, baseEnv);
  console.log('fetch-kernel: pack dsh / vendor');
  run(process.execPath, [pnpm.entry, 'exec', 'tsx', 'scripts/release/pack.ts', '--family', 'dsh', '--out', 'dist/npm-dsh', '--concurrency', '8'], src, baseEnv);
  run(process.execPath, [pnpm.entry, 'exec', 'tsx', 'scripts/release/pack.ts', '--family', 'vendor', '--out', 'dist/npm-vendor', '--concurrency', '8'], src, baseEnv);

  fs.mkdirSync(dest, { recursive: true });
  for (const family of ['npm-dsh', 'npm-vendor']) {
    const from = path.join(src, 'dist', family);
    for (const file of fs.readdirSync(from)) fs.copyFileSync(path.join(from, file), path.join(dest, file));
  }
  const count = fs.readdirSync(dest).filter((f) => f.endsWith('.tgz')).length;
  console.log(`fetch-kernel: 完成，${count} 个 tarball → ${path.relative(ROOT, dest)}（${os.EOL}接线：npm run gen-kernel-overrides && npm install）`);
}

try {
  main();
} catch (err) {
  console.error('fetch-kernel:', (err as Error).message);
  process.exit(1);
}

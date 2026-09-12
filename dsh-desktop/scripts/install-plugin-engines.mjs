#!/usr/bin/env node
// 按目标平台安装引擎型内置插件的运行时依赖（零依赖，CI 可直接跑）。
//
// 背景：dsh-stt 0.3.0 起不再 vendored sherpa-onnx 原生引擎（~22MB 且仅单
// 平台），改为构建/安装时按 runner 平台 npm install 拉取对应原生包
// （win-x64 / darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64，由
// sherpa-onnx-node 的 optionalDependencies 自动选择）。runner 平台 ==
// staging 目标平台（stage-resources.mjs 拒绝跨平台装配），所以本脚本装
// 出来的 node_modules 就是发行包需要的载荷；prune 规则会清掉异平台残留。
//
// 引擎清单静态维护（EAC 托管的引擎型插件目前仅 dsh-stt）；未出现在清单
// 里的插件目录不受影响。幂等：依赖已就位时 npm install 秒级返回。
//
// 用法：node scripts/install-plugin-engines.mjs [--cwd <插件目录>]
//   无参数 = 安装清单内全部插件。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 引擎型内置插件（目录名 = assets/plugins 下的目录）。新增引擎型插件时
// 在此登记，并保持其 package.json dependencies 只含运行时依赖（构建工具
// 一律放 devDependencies，--omit=dev 不进发行包）。
const ENGINE_PLUGINS = ['dsh-stt'];

function resolveNpmCli() {
  const executableDir = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(executableDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

const npmCli = resolveNpmCli();
const targets = process.argv.includes('--cwd')
  ? [resolve(process.argv[process.argv.indexOf('--cwd') + 1])]
  : ENGINE_PLUGINS.map((dir) => join(ROOT, 'assets', 'plugins', dir));

let failed = 0;
for (const dir of targets) {
  if (!existsSync(join(dir, 'package.json'))) {
    console.error(`[plugin-engines] 跳过（无 package.json）: ${dir}`);
    failed++;
    continue;
  }
  const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = npmCli ? [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'] : ['install', '--omit=dev', '--no-audit', '--no-fund'];
  console.log(`[plugin-engines] npm install --omit=dev（${process.platform}）→ ${dir}`);
  const result = spawnSync(command, args, {
    cwd: dir,
    stdio: 'inherit',
    shell: !npmCli && process.platform === 'win32',
  });
  if (result.error) { console.error(`[plugin-engines] 启动失败: ${result.error.message}`); failed++; continue; }
  if (result.status !== 0) { console.error(`[plugin-engines] 安装失败（${dir}），退出码 ${result.status}`); failed++; }
}

if (failed) {
  console.error(`[plugin-engines] ${failed} 个插件安装失败`);
  process.exit(1);
}
console.log(`[plugin-engines] 完成：${targets.length} 个插件引擎就绪（${process.platform}）`);

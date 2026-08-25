'use strict';
// 测试启动器：为 `node --test test/*.test.*` 选定 Node 运行时。
//
// 移植自 refactor/vnext-ts-isolation（vnext-absorb Phase 0）。差异：
// 1) 阈值放宽到 Node >= 24 —— Node 24 的原生 type-stripping 已稳定
//    （.test.ts 直跑无旗标；项目 tsconfig 未开 erasableSyntaxOnly，
//    测试文件本就是可擦除 ESM 语法）；
// 2) 默认 glob 为 test/*.test.ts（Phase 4 起全部测试为 .ts，Node 直跑）。
// 系统 node 版本不可控（开发机常见 22.x），这里优先用随包分发的
// vendor/node（fetch-node 后存在、版本固定），否则回退当前 node 并在
// 版本不足时给出可操作的错误信息。
//
//   node scripts/test-runner.js            # npm test 入口
//   node scripts/test-runner.js test/foo.test.mjs …  # 透传指定文件

import cp = require('node:child_process');
import fs = require('node:fs');
import path = require('node:path');
import { nodeExecutableName } from '../lib/desktop/platform';

const VENDOR_NODE = path.join(__dirname, '..', 'vendor', 'node', nodeExecutableName());

/** 取 node 主版本号（--version 输出形如 v24.11.1）；失败返回 0。 */
function majorOf(exe: string): number {
  const r = cp.spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
  const out = typeof r.stdout === 'string' ? r.stdout : '';
  const m = r.status === 0 ? /^v(\d+)/.exec(out.trim()) : null;
  return m && m[1] ? Number(m[1]) : 0;
}

function pickRuntime(): { exe: string; major: number } {
  if (fs.existsSync(VENDOR_NODE)) {
    const major = majorOf(VENDOR_NODE);
    if (major >= 24) return { exe: VENDOR_NODE, major };
  }
  const self = { exe: process.execPath, major: Number(process.versions.node.split('.')[0]) };
  if (self.major >= 24) return self;
  // 都不满足：优先报 vendor 缺失（可执行 npm run fetch-node 修复）
  return self;
}

const rt = pickRuntime();
if (rt.major < 24) {
  console.error(`[test-runner] 需要 Node >= 24（type-stripping 直跑 .test.ts），当前 ${rt.exe} 为 v${process.versions.node}`);
  console.error('[test-runner] 请先运行 npm run fetch-node 获取随包 Node，或升级系统 Node 至 24+');
  process.exit(2);
}

const args = ['--test', ...(process.argv.length > 2 ? process.argv.slice(2) : ['test/*.test.ts'])];
const testEnv = { ...process.env };
if (process.platform !== 'win32' && !testEnv.TMPDIR) testEnv.TMPDIR = '/tmp';
const r = cp.spawnSync(rt.exe, args, {
  stdio: 'inherit',
  windowsHide: true,
  cwd: path.join(__dirname, '..'),
  env: testEnv,
});
process.exit(r.status === null ? 1 : r.status);

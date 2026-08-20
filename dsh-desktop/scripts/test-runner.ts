'use strict';
// 测试启动器：为 `node --test test/*.test.ts` 选定 Node ≥ 26 运行时。
//
// 测试迁移 .test.ts 后依赖原生 type-stripping 直跑（Node ≥ 26 才无旗标）。
// 系统	node 版本不可控（开发机常见 22.x），这里优先用随包分发的
// vendor/node（fetch-node 后存在、版本固定），否则回退当前 node 并在
// 版本不足时给出可操作的错误信息。
//
//   node scripts/test-runner.js            # npm test 入口
//   node scripts/test-runner.js test/foo.test.ts …  # 透传指定文件

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const VENDOR_NODE = path.join(__dirname, '..', 'vendor', 'node', 'node.exe');

/** 取 node 主版本号（--version 输出形如 v26.7.0）；失败返回 0。 */
function majorOf(exe: string): number {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
  const m = r.status === 0 && r.stdout ? /^v(\d+)/.exec(r.stdout.trim()) : null;
  return m && m[1] ? Number(m[1]) : 0;
}

function pickRuntime(): { exe: string; major: number } {
  if (fs.existsSync(VENDOR_NODE)) {
    const major = majorOf(VENDOR_NODE);
    if (major >= 26) return { exe: VENDOR_NODE, major };
  }
  const self = { exe: process.execPath, major: Number(process.versions.node.split('.')[0]) };
  if (self.major >= 26) return self;
  // 都不满足：优先报 vendor 缺失（可执行 npm run fetch-node 修复）
  return self;
}

const rt = pickRuntime();
if (rt.major < 26) {
  console.error(`[test-runner] 需要 Node >= 26（type-stripping 直跑 .test.ts），当前 ${rt.exe} 为 v${process.versions.node}`);
  console.error('[test-runner] 请先运行 npm run fetch-node 获取随包 Node，或升级系统 Node 至 26+');
  process.exit(2);
}

const args = ['--test', ...(process.argv.length > 2 ? process.argv.slice(2) : ['test/*.test.ts'])];
const r = spawnSync(rt.exe, args, { stdio: 'inherit', windowsHide: true, cwd: path.join(__dirname, '..') });
process.exit(r.status === null ? 1 : r.status);

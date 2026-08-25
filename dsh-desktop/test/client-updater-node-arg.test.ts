// v4.4（PR79 集成回归）：applyUpdate 必须把应用自带的 node.exe 内联进
// apply-update.cmd 脚本体。
//
// manifest.json 的生成（备份分支）需要执行一段内联 JS。目标用户机器普遍
// 没有系统 Node —— 脚本必须用打包在 resources\node\node.exe 的运行时
// 路径，绝不能裸调 PATH 上的 node（errorlevel 9009 → BAD=2 → 更新永远
// 中止回滚，与 v3.0.1 自举陷阱同类）。
//
// 传递方式的坑：
//   · 第 10 参 %~10 —— batch 直接引用只到 %9，`%~10` 解析为 `%~1`+`0`
//     （实测 NODEEXE 接成 "<第1参>0" → 备份被静默跳过）
//   · shift 接第 10 参 —— 曾被误判为「脚本静默死亡」，2x2 矩阵探针
//     （shift × 结尾 CRLF，32 轮真实 e2e）已证伪：shift 无辜，当年的
//     死亡是探针自身缺陷（删除临时目录后才断言、日志读错路径）。
// 因此 nodeExe 由 buildApplyScript 直接内联进脚本（% 转义为 %%），
// 不经命令行参数传递 —— 内联无参数位数限制，是最稳方案。
//
// 本文件在 require('../client-updater.js') 之前拦截 child_process.spawn；
// node --test 每个文件独立进程，不会影响其他测试文件拿到真实的 spawn。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const recordedSpawns = [];
const realSpawn = cp.spawn;
cp.spawn = function interceptedSpawn(cmd, args, opts) {
  recordedSpawns.push({ cmd, args, opts });
  return { unref() {}, kill() {}, on() {}, once() {}, pid: -1 };
};

const clientUpdater = require('../client-updater.js');

test('applyUpdate inlines the bundled node exe into the script body', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-arg-'));
  // 生产环境中 updates/ 由下载器创建（Setup 就躺在里面）；applyUpdate 只写文件不建目录
  fs.mkdirSync(path.join(dir, 'updates'), { recursive: true });
  const prevFile = process.env.PORTABLE_EXECUTABLE_FILE;
  // oldExe 取 PORTABLE_EXECUTABLE_FILE，便于断言安装版参数与脚本内容。
  process.env.PORTABLE_EXECUTABLE_FILE = path.join(dir, 'FakeOldApp.exe');
  try {
    const ctx = { userDataDir: dir, log() {} };
    const pending = { path: path.join(dir, 'setup.exe'), version: '4.4.0' };
    const nodeExe = process.execPath;
    clientUpdater.applyUpdate(ctx, pending, {
      userDataDir: dir,
      dshHome: path.join(dir, 'dsh'),
      installDir: path.join(dir, 'inst'),
      profileDir: path.join(dir, 'prof'),
      currentVersion: '4.3.0',
      newVersion: '4.4.0',
      nodeExe,
    });
    assert.ok(recordedSpawns.length >= 1, 'spawn must have been called');
    const last = recordedSpawns[recordedSpawns.length - 1];
    assert.equal(path.basename(last.cmd).toLowerCase(), 'powershell.exe');
    assert.equal(last.args[last.args.indexOf('-WindowStyle') + 1], 'Hidden');
    assert.equal(
      last.args[last.args.indexOf('-ActionScriptPath') + 1],
      path.join(dir, 'updates', 'apply-update.cmd')
    );
    // 写盘的脚本必须内联 node 路径（% 转义 %%），且不得依赖 PATH node，
    // 也不得用 %~10 / shift 接参数（两条均已实测会坏）。
    const scriptText = fs.readFileSync(path.join(dir, 'updates', 'apply-update.cmd'), 'utf8');
    const escaped = nodeExe.replace(/%/g, '%%');
    assert.ok(scriptText.includes(`set "NODEEXE=${escaped}"`),
      'script must inline the bundled node exe path');
    assert.ok(scriptText.includes('"%NODEEXE%" -e'), 'manifest step must use the passed node exe');
    assert.doesNotMatch(scriptText, /%~10/, 'must never reference %~10');
    assert.doesNotMatch(scriptText, /^\s*shift\s*$/m, 'must not rely on shift');
    assert.doesNotMatch(scriptText, /(^|[^"%\w])node\s+-e/, 'script must not invoke bare `node`');
  } finally {
    if (prevFile === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = prevFile;
    cp.spawn = realSpawn;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

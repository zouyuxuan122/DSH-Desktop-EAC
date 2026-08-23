'use strict';

// koffi FFI 预检与目录选择器降级（integrated from upstream dsh_desktop）。
//
// koffi 3.1.3 / 3.1.4 的 win32-x64 预编译二进制在部分 Windows 机器上会在
// koffi.load() 处原生崩溃（0xC0000005），目录选择器 worker 随之无消息退出，
// 用户卡在 native 目录选择器上。启动前用内置 node 在子进程里跑一次 FFI
// 冒烟探针（scripts/koffi-preflight.cjs）；失败则写入 browse 后端 overlay
// （--patch 交给 dsh web），把目录选择器降级为浏览器内 browse 选择器。
//
// 本模块只做纯逻辑与文件管理，进程/文件系统依赖全部注入，便于单元测试；
// main.js 负责接线（传 nodeExe / spawnSync / userDataDir）。

import fs = require('node:fs');
import type { SpawnSyncReturns } from 'node:child_process';

// 自动生成的 overlay 文件首行 marker：clear 时只删自己写的文件，
// 用户手工维护的同名 overlay 永不触碰。
const PICKER_BROWSE_OVERLAY_MARKER = '# DSH-DESKTOP-AUTO: picker browse fallback';

// 运行 koffi 冒烟探针（同步版，保留给脚本/测试场景）。deps：
//   spawnSync / nodeExe / script / existsSync / log
// 返回 true=通过（或跳过），false=失败（应启用降级 overlay）。
interface SyncDeps {
  spawnSync(cmd: string, args: string[], opts: Record<string, unknown>): SpawnSyncReturns<Buffer | string>;
  nodeExe: string;
  script: string;
  existsSync?(p: string): boolean;
  log?(m: string): void;
  timeout?: number;
}

function runKoffiPreflight(deps: SyncDeps): boolean {
  const {
    spawnSync, nodeExe, script,
    existsSync: exists = fs.existsSync,
    log = () => {},
    timeout = 20000,
  } = deps;
  if (!exists(script)) {
    log('koffi 预检脚本不存在，跳过（视为通过）');
    return true;
  }
  try {
    const r = spawnSync(nodeExe, [script], { timeout, windowsHide: true, encoding: 'utf8' });
    const output = (String(r.stdout || '') + String(r.stderr || '')).trim();
    if (r.error) {
      log('koffi 预检无法执行: ' + r.error.message);
      return false;
    }
    if (r.status === 0) {
      log('koffi 预检通过');
      return true;
    }
    log(`koffi 预检失败（退出码 0x${(r.status! >>> 0).toString(16)}）: ${output.slice(0, 400)}`);
    return false;
  } catch (err) {
    log('koffi 预检异常: ' + String(((err as Error) && (err as Error).message) || err));
    return false;
  }
}

// V4：异步版探针（spawn 而非 spawnSync）。同步版会在启动期阻塞 Electron
// 主进程事件循环最长 20 秒 —— 托盘/菜单/IPC 全部无响应，是「启动卡死」
// 体感的一部分。启动链路改用本函数，语义与同步版一致。
interface AsyncDeps {
  spawn(cmd: string, args: string[], opts: Record<string, unknown>): import('node:child_process').ChildProcess;
  nodeExe: string;
  script: string;
  existsSync?(p: string): boolean;
  log?(m: string): void;
  timeout?: number;
}

function runKoffiPreflightAsync(deps: AsyncDeps): Promise<boolean> {
  const {
    spawn, nodeExe, script,
    existsSync: exists = fs.existsSync,
    log = () => {},
    timeout = 20000,
  } = deps;
  return new Promise<boolean>((resolve) => {
    if (!exists(script)) {
      log('koffi 预检脚本不存在，跳过（视为通过）');
      return resolve(true);
    }
    let settled = false;
    const finish = (ok: boolean): void => { if (!settled) { settled = true; resolve(ok); } };
    let child: import('node:child_process').ChildProcess;
    try {
      child = spawn(nodeExe, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log('koffi 预检无法执行: ' + String(((err as Error) && (err as Error).message) || err));
      return resolve(false);
    }
    let output = '';
    const onData = (c: Buffer): void => { output += c.toString(); };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const timer = setTimeout(() => {
      log('koffi 预检超时，按失败处理');
      try { child.kill(); } catch {}
      finish(false);
    }, timeout);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      log('koffi 预检无法执行: ' + (err && err.message));
      finish(false);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        log('koffi 预检通过');
        return finish(true);
      }
      log(`koffi 预检失败（退出码 0x${((code ?? -1) >>> 0).toString(16)}）: ${output.trim().slice(0, 400)}`);
      finish(false);
    });
  });
}

// 降级 overlay 的完整内容（纯函数，便于测试）。
function buildPickerOverlayContent(): string {
  return [
    PICKER_BROWSE_OVERLAY_MARKER,
    '# koffi 预检未通过：禁用 native 目录选择器，改用浏览器内 browse 选择器。',
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: directory-picker-browse',
    "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: directory-picker-browse-client',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '',
  ].join('\n');
}

// 写入降级 overlay（幂等：内容相同不重写）。返回 overlay 路径，失败返回 null。
interface OverlayDeps {
  file: string;
  fs?: typeof fs;
  log?: (m: string) => void;
}

function enablePickerBrowseOverlay({ file, fs: fsys = fs, log = () => {} }: OverlayDeps): string | null {
  const content = buildPickerOverlayContent();
  try {
    let prev = '';
    try { prev = fsys.readFileSync(file, 'utf8'); } catch {}
    if (prev !== content) fsys.writeFileSync(file, content);
    log('已启用目录选择器降级 overlay: ' + file);
    return file;
  } catch (err) {
    log('写入目录选择器降级 overlay 失败: ' + String(((err as Error) && (err as Error).message) || err));
    return null;
  }
}

// 移除自动生成的 overlay（预检恢复后调用）。只删带 marker 的文件；
// 返回是否实际删除。
function clearAutoPickerBrowseOverlay({ file, fs: fsys = fs, log = () => {} }: OverlayDeps): boolean {
  try {
    if (!fsys.existsSync(file)) return false;
    const text = fsys.readFileSync(file, 'utf8');
    if (!text.includes(PICKER_BROWSE_OVERLAY_MARKER)) return false;
    fsys.rmSync(file, { force: true });
    log('koffi 预检已恢复，移除目录选择器降级 overlay');
    return true;
  } catch (err) {
    log('移除目录选择器降级 overlay 失败: ' + String(((err as Error) && (err as Error).message) || err));
    return false;
  }
}

export = {
  PICKER_BROWSE_OVERLAY_MARKER,
  runKoffiPreflight,
  runKoffiPreflightAsync,
  buildPickerOverlayContent,
  enablePickerBrowseOverlay,
  clearAutoPickerBrowseOverlay,
};

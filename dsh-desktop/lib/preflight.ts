/**
 * lib/preflight.ts — koffi FFI 预检与目录选择器降级（Task 5b 自 main.js 提取）。
 *
 * koffi 3.1.3/3.1.4 的 win32-x64 预编译二进制在部分 Windows 机器上会在
 * load 时原生崩溃（0xC0000005），目录选择器 worker 无消息退出。启动前用
 * 内置 node 在子进程里做一次 FFI 冒烟；失败则注入 browse 后端 overlay
 * （state.pickerBrowseOverlay，由 startAndShow 以 --patch 交给 dsh web）。
 */

import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  runKoffiPreflightAsync,
  enablePickerBrowseOverlay,
  clearAutoPickerBrowseOverlay,
} from '../koffi-preflight.js';
import { state } from './state.js';
import { log } from './log.js';
import { nodeExe } from './proc.js';

/** 降级 overlay 文件路径（userData 目录）。 */
export function pickerBrowseOverlayPath(): string {
  return path.join(state.userDataDir, 'picker-browse.overlay.yml');
}

/** 预检日志适配（tag=preflight）。 */
function preflightLogger(msg: string): void {
  log('preflight', msg);
}

// V4：异步版（spawn 而非 spawnSync）—— 同步探针会把主进程事件循环卡住
// 最长 20 秒（托盘/菜单/IPC 全无响应）。boot 链改走这里，语义不变。
export function applyKoffiPreflightAsync(): Promise<boolean> {
  const file = pickerBrowseOverlayPath();
  return runKoffiPreflightAsync({
    spawn,
    nodeExe: nodeExe(),
    script: path.join(__dirname, '..', 'scripts', 'koffi-preflight.cjs'),
    log: preflightLogger,
  }).then((ok) => {
    if (ok) {
      clearAutoPickerBrowseOverlay({ file, log: preflightLogger });
      state.pickerBrowseOverlay = null;
    } else {
      state.pickerBrowseOverlay = enablePickerBrowseOverlay({ file, log: preflightLogger });
    }
    return ok;
  });
}

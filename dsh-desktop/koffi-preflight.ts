/**
 * koffi-preflight.ts — koffi FFI 预检与目录选择器降级（集成自上游
 * dsh_desktop）（Task 7.1 自 koffi-preflight.js 迁 TS）。
 *
 * koffi 3.1.3 / 3.1.4 的 win32-x64 预编译二进制在部分 Windows 机器上会在
 * koffi.load() 处原生崩溃（0xC0000005），目录选择器 worker 随之无消息退出，
 * 用户卡在 native 目录选择器上。启动前用内置 node 在子进程里跑一次 FFI
 * 冒烟探针（scripts/koffi-preflight.cjs）；失败则写入 browse 后端 overlay
 * （--patch 交给 dsh web），把目录选择器降级为浏览器内 browse 选择器。
 *
 * 本模块只做纯逻辑与文件管理，进程/文件系统依赖全部注入，便于单元测试；
 * lib/preflight.ts 负责接线（传 nodeExe / spawnSync / userDataDir）。
 */

import * as fs from 'node:fs';

/** 自动生成的 overlay 文件首行 marker：clear 时只删自己写的文件，
 *  用户手工维护的同名 overlay 永不触碰。 */
export const PICKER_BROWSE_OVERLAY_MARKER = '# DSH-DESKTOP-AUTO: picker browse fallback';

/** spawnSync 的最小结构类型（依赖注入，便于测试替身）。 */
export interface SpawnSyncLike {
  (cmd: string, args: string[], opts: Record<string, unknown>): {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    status?: number | null;
    error?: Error;
  };
}

/** spawn 的最小结构类型（异步版探针用）。 */
export interface SpawnLike {
  (cmd: string, args: string[], opts: Record<string, unknown>): {
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    on(ev: 'error', cb: (err: Error) => void): unknown;
    on(ev: 'close', cb: (code: number | null) => void): unknown;
    kill(): void;
  };
}

/** 文件系统依赖的最小面（默认 node:fs，测试可注入内存实现）。 */
export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, data: string): void;
  rmSync(p: string, opts?: { force?: boolean }): void;
}

/** 同步探针的依赖。 */
export interface PreflightSyncDeps {
  spawnSync: SpawnSyncLike;
  nodeExe: string;
  script: string;
  existsSync?: (p: string) => boolean;
  log?: (msg: string) => void;
  timeout?: number;
}

/** 异步探针的依赖。 */
export interface PreflightAsyncDeps {
  spawn: SpawnLike;
  nodeExe: string;
  script: string;
  existsSync?: (p: string) => boolean;
  log?: (msg: string) => void;
  timeout?: number;
}

/** overlay 读写操作的依赖。 */
export interface OverlayDeps {
  file: string;
  fs?: FsLike;
  log?: (msg: string) => void;
}

/**
 * 运行 koffi 冒烟探针（同步版，保留给脚本/测试场景）。
 * 返回 true=通过（或跳过），false=失败（应启用降级 overlay）。
 */
export function runKoffiPreflight(deps: PreflightSyncDeps): boolean {
  const {
    spawnSync,
    nodeExe,
    script,
    existsSync: exists = fs.existsSync,
    log = (): void => {},
    timeout = 20_000,
  } = deps;
  if (!exists(script)) {
    log('koffi 预检脚本不存在，跳过（视为通过）');
    return true;
  }
  try {
    const r = spawnSync(nodeExe, [script], { timeout, windowsHide: true, encoding: 'utf8' });
    const output = (String(r.stdout ?? '') + String(r.stderr ?? '')).trim();
    if (r.error) {
      log('koffi 预检无法执行: ' + r.error.message);
      return false;
    }
    if (r.status === 0) {
      log('koffi 预检通过');
      return true;
    }
    log(`koffi 预检失败（退出码 0x${((r.status ?? -1) >>> 0).toString(16)}）: ${output.slice(0, 400)}`);
    return false;
  } catch (err) {
    log('koffi 预检异常: ' + String((err as Error).message));
    return false;
  }
}

/**
 * V4：异步版探针（spawn 而非 spawnSync）。同步版会在启动期阻塞 Electron
 * 主进程事件循环最长 20 秒 —— 托盘/菜单/IPC 全部无响应，是「启动卡死」
 * 体感的一部分。启动链路改用本函数，语义与同步版一致。
 */
export function runKoffiPreflightAsync(deps: PreflightAsyncDeps): Promise<boolean> {
  const {
    spawn,
    nodeExe,
    script,
    existsSync: exists = fs.existsSync,
    log = (): void => {},
    timeout = 20_000,
  } = deps;
  return new Promise((resolve) => {
    if (!exists(script)) {
      log('koffi 预检脚本不存在，跳过（视为通过）');
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    let child: ReturnType<SpawnLike>;
    try {
      child = spawn(nodeExe, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log('koffi 预检无法执行: ' + String((err as Error).message));
      resolve(false);
      return;
    }
    let output = '';
    const onData = (c: Buffer | string): void => {
      output += c.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      log('koffi 预检超时，按失败处理');
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish(false);
    }, timeout);
    timer.unref();
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      log('koffi 预检无法执行: ' + err.message);
      finish(false);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        log('koffi 预检通过');
        finish(true);
        return;
      }
      log(`koffi 预检失败（退出码 0x${((code ?? -1) >>> 0).toString(16)}）: ${output.trim().slice(0, 400)}`);
      finish(false);
    });
  });
}

/** 降级 overlay 的完整内容（纯函数，便于测试）。 */
export function buildPickerOverlayContent(): string {
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

/** 写入降级 overlay（幂等：内容相同不重写）。返回 overlay 路径，失败返回 null。 */
export function enablePickerBrowseOverlay(deps: OverlayDeps): string | null {
  const { file, fs: fsys = fs, log = (): void => {} } = deps;
  const content = buildPickerOverlayContent();
  try {
    let prev = '';
    try {
      prev = fsys.readFileSync(file, 'utf8');
    } catch {
      /* 无既有文件 */
    }
    if (prev !== content) fsys.writeFileSync(file, content);
    log('已启用目录选择器降级 overlay: ' + file);
    return file;
  } catch (err) {
    log('写入目录选择器降级 overlay 失败: ' + String((err as Error).message));
    return null;
  }
}

/** 移除自动生成的 overlay（预检恢复后调用）。只删带 marker 的文件；
 *  返回是否实际删除。 */
export function clearAutoPickerBrowseOverlay(deps: OverlayDeps): boolean {
  const { file, fs: fsys = fs, log = (): void => {} } = deps;
  try {
    if (!fsys.existsSync(file)) return false;
    const text = fsys.readFileSync(file, 'utf8');
    if (!text.includes(PICKER_BROWSE_OVERLAY_MARKER)) return false;
    fsys.rmSync(file, { force: true });
    log('koffi 预检已恢复，移除目录选择器降级 overlay');
    return true;
  } catch (err) {
    log('移除目录选择器降级 overlay 失败: ' + String((err as Error).message));
    return false;
  }
}

/**
 * lib/logger/rotate.ts — 大小轮转写流（Task 6.2 自 logger.js 提取）。
 *
 * 轮转策略（不引入 shell/文件名竞态）：
 *   - 活动文件固定为 <logsDir>/main.00，只写它；轮转在写之前同步完成；
 *   - 超过 maxBytes 时重命名链：删 main.<maxFiles-1> → main.07→main.08 → …
 *     → main.00→main.01 → 重建空 main.00；
 *   - maxFiles 默认 10（编号 00..09），maxBytes 默认 20MB；
 *   - 不做缓冲，直通 fs 写（崩溃安全优先于吞吐）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Writable } from 'node:stream';

/** 单文件大小上限（默认 20MB）。 */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** 保留文件数（默认 10，编号 00..09）。 */
export const DEFAULT_MAX_FILES = 10;

/** 索引 → 文件名（main.00 … main.09）。 */
export function _idxName(i: number): string {
  return 'main.' + String(i).padStart(2, '0');
}

/** RotateWriteStream 构造选项。 */
export interface RotateOpts {
  maxBytes?: number | undefined;
  maxFiles?: number | undefined;
  [k: string]: unknown;
}

export class RotateWriteStream extends Writable {
  readonly logsDir: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  private _fd: number | null = null;
  private readonly _path: string;
  private _size = 0;
  private _closed = false;

  constructor(logsDir: string, opts: RotateOpts = {}) {
    super({ ...(opts as object), decodeStrings: false });
    this.logsDir = logsDir;
    this.maxBytes = (opts.maxBytes as number) || DEFAULT_MAX_BYTES;
    this.maxFiles = (opts.maxFiles as number) || DEFAULT_MAX_FILES;
    this._path = path.join(this.logsDir, _idxName(0));
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
    this._openNew();
  }

  /** 关旧 fd 并截断/重建 main.00。 */
  private _openNew(): void {
    if (this._fd !== null) {
      try {
        fs.closeSync(this._fd);
      } catch {
        /* 已关 */
      }
      this._fd = null;
    }
    this._fd = fs.openSync(this._path, 'w', 0o644);
    try {
      this._size = this._fd !== null ? fs.fstatSync(this._fd).size : 0;
    } catch {
      this._size = 0;
    }
    this._closed = false;
  }

  /** 写入前检查：超限则整链轮转（删最老 → 逐级重命名 → 重建 main.00）。 */
  private _rollIfNeeded(extraBytes: number): void {
    if (this._size + extraBytes <= this.maxBytes) return;
    // 1) 删最老文件（若存在）
    const lastIdx = this.maxFiles - 1;
    const lastPath = path.join(this.logsDir, _idxName(lastIdx));
    try {
      fs.unlinkSync(lastPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    // 2) 高编号 → +1（从 lastIdx-1 到 0）
    for (let i = lastIdx - 1; i >= 0; i--) {
      const src = path.join(this.logsDir, _idxName(i));
      const dst = path.join(this.logsDir, _idxName(i + 1));
      try {
        fs.renameSync(src, dst);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    // 3) 打开新 main.00
    this._openNew();
  }

  override _write(chunk: Buffer | string, enc: BufferEncoding | undefined, cb: (err?: Error | null) => void): void {
    if (this._closed) {
      // flush 后复用：重新打开。
      this._openNew();
    }
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, enc || 'utf8') : chunk;
    try {
      this._rollIfNeeded(buf.length);
      if (this._fd !== null) {
        fs.writeSync(this._fd, buf, 0, buf.length, null);
      }
      this._size += buf.length;
      cb(null);
    } catch (e) {
      cb(e as Error);
    }
  }

  override _final(cb: (err?: Error | null) => void): void {
    try {
      this.closeSync();
      cb(null);
    } catch (e) {
      cb(e as Error);
    }
  }

  /** 关闭底层 fd（幂等）。 */
  closeSync(): void {
    if (this._fd !== null) {
      try {
        fs.closeSync(this._fd);
      } catch {
        /* 已关 */
      }
      this._fd = null;
    }
    this._closed = true;
  }

  /** fsync 当前 fd（退出前强制落盘）。 */
  flushSync(): void {
    if (this._fd !== null) {
      try {
        fs.fsyncSync(this._fd);
      } catch {
        /* fsync 失败不致命 */
      }
    }
  }
}

'use strict';

// 流写入守卫（Wave 3 自 stream-write-guard.js 类型化迁出，行为零变更）：
// 把 Writable 的异步错误（含 write-after-end）圈进 onError 回调，写侧不再
// 需要为每次 write 包 try/catch。

interface GuardedStream {
  write(chunk: unknown): boolean;
  end(): boolean;
  readonly closing: boolean;
  readonly ended: boolean;
}

interface GuardOpts {
  onError?(err: unknown): void;
}

interface MinimalWritable {
  write(chunk: unknown): boolean;
  end(cb?: () => void): void;
  on(event: string, listener: (err: unknown) => void): unknown;
  destroyed?: boolean;
  writableEnded?: boolean;
  writable?: boolean;
}

function createStreamWriteGuard(stream: MinimalWritable, opts: GuardOpts = {}): GuardedStream {
  if (!stream || typeof stream.write !== 'function' || typeof stream.end !== 'function') {
    throw new TypeError('createStreamWriteGuard: writable stream is required');
  }

  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  let closing = false;
  let ended = false;

  const report = (err: unknown): void => {
    try { onError(err); } catch { /* 回调异常不再上抛 */ }
  };

  // Writable failures, including write-after-end, are commonly emitted
  // asynchronously and cannot be contained by a try/catch around write().
  stream.on('error', report);

  return {
    write(chunk: unknown): boolean {
      if (closing || ended || stream.destroyed || stream.writableEnded || stream.writable === false) {
        return false;
      }
      try {
        return stream.write(chunk);
      } catch (err) {
        report(err);
        return false;
      }
    },

    end(): boolean {
      if (closing || ended) return false;
      closing = true;
      if (stream.destroyed || stream.writableEnded) {
        ended = true;
        return false;
      }
      try {
        stream.end(() => { ended = true; });
        return true;
      } catch (err) {
        ended = true;
        report(err);
        return false;
      }
    },

    get closing(): boolean { return closing; },
    get ended(): boolean { return ended || !!stream.writableEnded || !!stream.destroyed; },
  };
}

export = { createStreamWriteGuard };

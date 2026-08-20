/**
 * lib/logger/api.ts — 结构化日志器实例（pino 封装 + trace 助手 + 诊断 zip）
 * （Task 6.2 自 logger.js 提取）。
 *
 * 双 trace-id 体系：BOOT_TRACE_ID（每次 init 生成，贯穿整个进程生命周期）+
 * action_trace_id（makeActionTrace/withTrace 按动作生成，跨进程关联用）。
 *
 * 未 init 时全部方法为 no-op（与旧 noopLogger 兼容，绝不因日志崩溃）。
 * 依赖（pino/archiver）缺失时优雅降级：值掩码与轮转仍可用，仅 pino/zip
 * 不可用（RED 阶段单测即此形态）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Writable } from 'node:stream';
import { RedactTransform } from './redact.js';
import { RotateWriteStream, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from './rotate.js';
import { buildDiagnosticsZip } from './diagnostics.js';

// pino 的最小结构类型（避免绑定 pino 自带类型声明；依赖缺失时为 null）。
interface PinoLogger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): PinoLogger;
  on(ev: 'error', cb: (e: Error) => void): void;
}

/** pino 工厂函数（含 stdTimeFunctions 静态成员）。 */
interface PinoFactory {
  (opts: Record<string, unknown>, stream: Writable): PinoLogger;
  stdTimeFunctions?: { isoTime?: unknown };
}

// 惰性依赖加载：未安装时优雅降级（RED 阶段单测环境）。
let pino: PinoFactory | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pino = require('pino');
} catch {
  /* deps not installed yet in RED */
}
let nanoidFn: (() => string) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('nanoid') as { nanoid?: () => string };
  nanoidFn = m.nanoid || (() => Math.random().toString(36).slice(2, 12));
} catch {
  nanoidFn = () => Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
}

/** 兜底 id（nanoid 不可用时）。 */
function fallbackId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 单个动作 trace（bootId + actionId + kind）。 */
export interface ActionTrace {
  bootId: string;
  actionId: string;
  kind: string;
}

/** logger 级别方法集（loggerAPI 与 child shell 共同的形状）。 */
export interface LoggerShell {
  trace(...args: unknown[]): LoggerShell;
  debug(...args: unknown[]): LoggerShell;
  info(...args: unknown[]): LoggerShell;
  warn(...args: unknown[]): LoggerShell;
  error(...args: unknown[]): LoggerShell;
  fatal(...args: unknown[]): LoggerShell;
  tag(...tags: string[]): LoggerShell;
  withTrace(kind: string, extra?: Record<string, unknown>): LoggerShell;
  child(bindings?: Record<string, unknown>): LoggerShell;
}

/** init 选项。 */
export interface LoggerInitOpts {
  logsDir: string;
  level?: string;
  appVersion?: string;
  env?: string;
  maxBytes?: number;
  maxFiles?: number;
}

/** buildDiagnosticsZip 选项。 */
export interface DiagnosticsZipOpts {
  logsDir: string;
  userDataDir: string;
  dshHome: string;
  outDir?: string;
}

/** 内部状态（测试/诊断只读暴露）。 */
export interface LoggerState {
  initialized: boolean;
  rotateStream: RotateWriteStream | null;
  redactStream: RedactTransform | null;
  pino: PinoLogger | null;
  bootTraceId: string | null;
  logsDir: string | null;
  level: string;
  appVersion: string;
  env: string;
  onError(err: unknown): void;
}

export const _state: LoggerState = {
  initialized: false,
  rotateStream: null,
  redactStream: null,
  pino: null,
  bootTraceId: null,
  logsDir: null,
  level: 'info',
  appVersion: '0.0.0',
  env: 'production',
  onError(err: unknown): void {
    try {
      process.stderr.write('[logger] ' + ((err as { stack?: string })?.stack || String(err)) + '\n');
    } catch {
      /* stderr 不可用则静默 */
    }
  },
};

function _safePinoChild(bindings: Record<string, unknown>): PinoLogger | null {
  if (!_state.pino) return null;
  try {
    return _state.pino.child(bindings || {});
  } catch (e) {
    _state.onError(e);
    return null;
  }
}

/** 生成一个动作 trace（bootId 复用当前 BOOT_TRACE_ID）。 */
export function makeActionTrace(kind: string): ActionTrace {
  const bootId = _state.bootTraceId || '';
  const actionId = typeof nanoidFn === 'function' ? nanoidFn() : fallbackId();
  return { bootId, actionId, kind: kind || '' };
}

/** 当前 BOOT_TRACE_ID（未 init 为 null）。 */
export function getBootTraceId(): string | null {
  return _state.bootTraceId || null;
}

/** 构造 child shell（pino 缺失时为全 no-op 的安全壳）。 */
export function child(bindings?: Record<string, unknown>): LoggerShell {
  const pChild = _safePinoChild(bindings || {});
  // 返回一个 API 壳：级别方法代理到 pino child；child 为 null（未 init）
    // 时优雅降级为 no-op。壳带同样的助手方法。
  const shell: LoggerShell = {
    trace(...a: unknown[]): LoggerShell {
      if (pChild) {
        try {
          pChild.trace(...a);
        } catch (e) {
          _state.onError(e);
        }
      }
      return shell;
    },
    debug(...a: unknown[]): LoggerShell {
      if (pChild) {
        try {
          pChild.debug(...a);
        } catch (e) {
          _state.onError(e);
        }
      }
      return shell;
    },
    info(...a: unknown[]): LoggerShell {
      if (pChild) {
        try {
          pChild.info(...a);
        } catch (e) {
          _state.onError(e);
        }
      }
      return shell;
    },
    warn(...a: unknown[]): LoggerShell {
      if (pChild) {
        try {
          pChild.warn(...a);
        } catch (e) {
          _state.onError(e);
        }
      }
      return shell;
    },
    error(...a: unknown[]): LoggerShell {
      if (pChild) {
        try {
          pChild.error(...a);
        } catch (e) {
          _state.onError(e);
        }
      }
      return shell;
    },
    fatal(...a: unknown[]): LoggerShell {
      if (pChild) {
        try {
          pChild.fatal(...a);
        } catch (e) {
          _state.onError(e);
        }
      }
      return shell;
    },
    tag(...tags: string[]): LoggerShell {
      return shell.child({ tags: ((bindings && bindings.tags as string[]) || []).concat(tags) });
    },
    withTrace(k: string, extra?: Record<string, unknown>): LoggerShell {
      return shell.child(Object.assign({ action_trace: makeActionTrace(k) }, extra || {}));
    },
    child(b2?: Record<string, unknown>): LoggerShell {
      return child(Object.assign({}, bindings || {}, b2 || {}));
    },
  };
  return shell;
}

/** 按标签派生 child（等价 child({tags})）。 */
export function tag(...tags: string[]): LoggerShell {
  return child({ tags });
}

/** 带 action_trace 的 child。 */
export function withTrace(kind: string, extraBindings?: Record<string, unknown>): LoggerShell {
  const tr = makeActionTrace(kind);
  return child(Object.assign({ action_trace: tr }, extraBindings || {}));
}

// 级别方法：代理到 pino；未 init / 异常时静默（返回自身保持链式）。
function levelFn(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'): (...args: unknown[]) => LoggerShell {
  return (...args: unknown[]): LoggerShell => {
    if (_state.pino) {
      try {
        _state.pino[level](...args);
      } catch (e) {
        _state.onError(e);
      }
    }
    return loggerAPI;
  };
}

/**
 * 旧调用兼容：ctx.log({ level, message, ...props }) →
 * logger[level]({ ...props }, message)。
 */
export function logCompat(ctxLevelMsgObj: unknown): void {
  if (!ctxLevelMsgObj || typeof ctxLevelMsgObj !== 'object') return;
  const o = ctxLevelMsgObj as Record<string, unknown>;
  const lvl = String(o.level || 'info').toLowerCase();
  const msg = (o.message as string) || '';
  const rest = Object.assign({}, o);
  delete rest.level;
  delete rest.message;
  const fn = (loggerAPI as unknown as Record<string, (...a: unknown[]) => unknown>)[lvl] || loggerAPI.info;
  if (Object.keys(rest).length === 0) fn(msg);
  else fn(rest, msg);
}

/**
 * 给 ctx 绑定 ctx.log（预绑定 context_id 的 child logger）。
 * 守卫：ctx 已有 .log 时不覆盖。
 */
export function wrapChild(kind: string, ctx: Record<string, unknown>, extraBindings?: Record<string, unknown>): void {
  if (!ctx || typeof ctx !== 'object') return;
  if (ctx.log) return; // 不覆盖既有 ctx.log
  const tr = { action_trace: makeActionTrace(kind) };
  const bindings = Object.assign({}, tr, extraBindings || {});
  if (ctx.id) bindings.context_id = String(ctx.id);
  ctx.log = child(bindings);
}

/**
 * 初始化日志管线：pino → RedactTransform（deep）→ RotateWriteStream。
 * 可重复调用（测试场景）：先关旧流再重建。成功后写首条 boot 行并 flush。
 */
export function init(opts: LoggerInitOpts): boolean {
  const logsDir = opts.logsDir;
  if (!logsDir || typeof logsDir !== 'string') {
    throw new Error('logger.init: logsDir is required');
  }
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  // 关旧流（测试可能多次 init）。
  if (_state.rotateStream) {
    try {
      _state.rotateStream.closeSync();
    } catch {
      /* 已关 */
    }
    _state.rotateStream = null;
  }
  if (_state.redactStream) {
    try {
      _state.redactStream.end();
    } catch {
      /* 已关 */
    }
    _state.redactStream = null;
  }

  _state.logsDir = logsDir;
  _state.level = opts.level || 'info';
  _state.appVersion = opts.appVersion || '0.0.0';
  _state.env = opts.env || 'production';

  _state.bootTraceId = typeof nanoidFn === 'function' ? nanoidFn() : fallbackId();

  // 先建轮转流（终点 sink）。
  _state.rotateStream = new RotateWriteStream(logsDir, {
    maxBytes: opts.maxBytes || DEFAULT_MAX_BYTES,
    maxFiles: opts.maxFiles || DEFAULT_MAX_FILES,
  });
  _state.rotateStream.on('error', (e: Error) => _state.onError(e));

  // Redact 恒用 deep 模式（内部 try/catch 兜底回 shallow 行为）。
  _state.redactStream = new RedactTransform({
    redactLevel: 'deep',
    warnHandler: (m: unknown) => _state.onError(m),
  });
  // redact → rotate。崩溃安全优先，push 直通即可（无需背压处理）。
  _state.redactStream.pipe(_state.rotateStream);
  _state.redactStream.on('error', (e: Error) => _state.onError(e));

  // 构建 pino。
  if (pino) {
    try {
      const pinoOpts: Record<string, unknown> = {
        level: _state.level,
        // pino 默认每行加 \n；保持默认，RedactTransform 按行切分。
        timestamp: pino.stdTimeFunctions && pino.stdTimeFunctions.isoTime
          ? pino.stdTimeFunctions.isoTime
          : () => (',"time":' + '"' + new Date().toISOString() + '"'),
        base: {
          pid: process.pid,
          hostname: os.hostname().slice(0, 64),
          env: _state.env,
          platform: os.platform(),
          arch: os.arch(),
          appVersion: _state.appVersion,
          bootTraceId: _state.bootTraceId,
        },
      };
      _state.pino = pino(pinoOpts, _state.redactStream as unknown as Writable);
      _state.pino.on('error', (e: Error) => _state.onError(e));
    } catch (e) {
      _state.onError(e);
      _state.pino = null;
    }
  }

  _state.initialized = true;

  // ---- AC-1: 首条 boot 行（普通对象，JSON.stringify 可用）----
  const bootBindings = {
    bootTraceId: _state.bootTraceId,
    env: _state.env,
    platform: os.platform(),
    arch: os.arch(),
    appVersion: _state.appVersion,
    pid: process.pid,
    cpus: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    nodeVersion: process.version,
    uptime: process.uptime(),
  };
  const bootMsg = 'boot ' + _state.bootTraceId + ' ' + _state.env + ' ' + os.platform();
  loggerAPI.info(bootBindings, bootMsg);
  // flush 让测试立即可读 main.00。
  loggerAPI.flush();
  return true;
}

/** 强制冲刷（redact 缓冲 + rotate fsync）。 */
export function flush(): boolean {
  try {
    if (_state.redactStream) {
      // 调用自有的 _flush（不 end 流）；类内部方法，安全。
      try {
        const r = _state.redactStream as unknown as { _flush?: (cb: () => void) => void };
        if (typeof r._flush === 'function') {
          r._flush(() => {});
        }
      } catch {
        /* 缓冲为空 */
      }
    }
    if (_state.rotateStream) {
      try {
        _state.rotateStream.flushSync();
      } catch {
        /* fsync 失败不致命 */
      }
    }
  } catch (e) {
    _state.onError(e);
  }
  return true;
}

/** 关闭管线（redact end + rotate closeSync）。 */
export function close(): void {
  try {
    if (_state.redactStream) {
      try {
        _state.redactStream.end();
      } catch {
        /* 已关 */
      }
    }
    if (_state.rotateStream) {
      try {
        _state.rotateStream.closeSync();
      } catch {
        /* 已关 */
      }
    }
  } catch (e) {
    _state.onError(e);
  }
}

/** 内部状态只读暴露（诊断/测试）。 */
export function _internalState(): LoggerState {
  return _state;
}

// --- 诊断 zip（AC-8）已拆至 ./diagnostics.ts（Task 14 规模约束）；本文件
// 经下方 import 组装进 loggerAPI，公开面不变。---

// --- loggerAPI 组装（方法间经 loggerAPI 标识符互引，勿解构 this）------------
// 形状与原 logger.js 的 module.exports 完全一致；named exports 见 index.ts。

export interface LoggerAPI extends LoggerShell {
  getBootTraceId(): string | null;
  makeActionTrace(kind: string): ActionTrace;
  logCompat(obj: unknown): void;
  wrapChild(kind: string, ctx: Record<string, unknown>, extra?: Record<string, unknown>): void;
  init(opts: LoggerInitOpts): boolean;
  flush(): boolean;
  close(): void;
  buildDiagnosticsZip(opts: DiagnosticsZipOpts): Promise<string>;
  _internalState(): LoggerState;
}

export const loggerAPI: LoggerAPI = {
  trace: levelFn('trace'),
  debug: levelFn('debug'),
  info: levelFn('info'),
  warn: levelFn('warn'),
  error: levelFn('error'),
  fatal: levelFn('fatal'),
  getBootTraceId,
  makeActionTrace,
  child,
  tag,
  withTrace,
  logCompat,
  wrapChild,
  init,
  flush,
  close,
  buildDiagnosticsZip,
  _internalState,
};

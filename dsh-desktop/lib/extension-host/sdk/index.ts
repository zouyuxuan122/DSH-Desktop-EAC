/**
 * lib/extension-host/sdk/index.ts — Extension SDK V1 运行时（VNext Phase 2，Task 11.1）。
 *
 * 运行位置：Extension Host 进程内（host-bootstrap 加载插件时构建 ctx）。
 * 插件作者可见的全部能力面（架构文档 §5「Extension SDK」）：
 *   - registerTool(name, meta | handler, handler?)：注册 Agent 工具，
 *     meta.description/parameters 会经 Core Bridge 原样透传给 dsh 的
 *     defineTool（同一参数描述符方言）；调用前做轻量校验（required/type）；
 *   - on(event, cb)：只读事件订阅（Supervisor 广播，如 turn-end）；
 *   - provideContext(fn)：回合上下文贡献（超时即丢弃，绝不阻塞回合）；
 *   - settings.get/set：插件私有设置命名空间（data/settings.json，原子写）；
 *   - log(level, msg)：结构化日志（notify 回 Supervisor 统一落盘）；
 *   - net/fs/shell/env：deny-by-default 权限门（未声明即不可见）。
 *
 * 不暴露（安全边界）：Cordis 实例、Core Profile 写权限、任意 require。
 * 注意 ctx.net 等能力字段是「SDK 面约定」——插件仍可裸 require node 内建，
 * 硬边界是进程围栏 + Core Profile 零写入（诚实边界见 spec §11）。
 */

import fs = require('node:fs');
import path = require('node:path');
import cp = require('node:child_process');
import type {
  ContextContribution,
  HostLogParams,
  HostToolMeta,
  SdkEventParams,
} from '../../../shared/protocol.js';
import type { HostInitParams } from '../../../shared/protocol.js';
import { writeJsonAtomic } from '../../atomic-json.js';

/** SDK 与 host-bootstrap 之间的 IO 通道（宿主注入，便于单测）。 */
export interface SdkIo {
  /** 插件日志 → Supervisor。 */
  log(level: HostLogParams['level'], msg: string): void;
  /** 注册的工具表（host 侧 invoke 分发 + init 应答共享）。 */
  tools: Map<string, { meta: HostToolMeta; handler: (args: unknown) => Promise<unknown> | unknown }>;
}

/** 轻量参数校验（dsh 风格描述符；失败抛错由 RPC 层转为错误响应）。 */
export function validateArgs(
  params: HostToolMeta['parameters'],
  args: unknown,
): Record<string, unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (!params) return a;
  for (const [key, d] of Object.entries(params)) {
    const v = a[key];
    if (v === undefined || v === null || v === '') {
      if (d.required) throw new Error(`参数 ${key} 必填`);
      continue;
    }
    const t = d.type ?? 'string';
    const ok =
      t === 'string' ? typeof v === 'string'
      : t === 'number' || t === 'integer' ? typeof v === 'number' && (t !== 'integer' || Number.isInteger(v))
      : t === 'boolean' ? typeof v === 'boolean'
      : t === 'any' ? true
      : typeof v === 'string'; // 未知类型按字符串容忍
    if (!ok) throw new Error(`参数 ${key} 须为 ${t}（收到 ${typeof v}）`);
  }
  return a;
}

// ---------------------------------------------------------------------------
// 权限门：路径围栏与受控能力面（deny-by-default：未声明即不可见）
// ---------------------------------------------------------------------------

/** 路径是否落在任一白名单根内（含自身；防 ../ 逃逸）。 */
function withinRoots(p: string, roots: readonly string[]): boolean {
  const norm = path.resolve(p);
  return roots.some((r) => {
    const root = path.resolve(r);
    return norm === root || norm.startsWith(root + path.sep);
  });
}

/** 授权目录白名单下的受控 fs 面。 */
export function scopedFs(roots: readonly string[]) {
  const guard = (p: string): string => {
    if (!withinRoots(p, roots)) throw new Error(`fs 越权：${p} 不在授权目录内`);
    return p;
  };
  return {
    readFile: (p: string): string => fs.readFileSync(guard(p), 'utf8'),
    writeFile: (p: string, data: string): void => {
      fs.mkdirSync(path.dirname(guard(p)), { recursive: true });
      fs.writeFileSync(guard(p), data);
    },
    readdir: (p: string): string[] => fs.readdirSync(guard(p)),
    mkdir: (p: string): void => {
      fs.mkdirSync(guard(p), { recursive: true });
    },
    stat: (p: string): fs.Stats => fs.statSync(guard(p)),
    unlink: (p: string): void => {
      fs.rmSync(guard(p), { force: true });
    },
  };
}

/** 域名白名单下的受控 fetch（'*' = 任意主机；其余精确匹配 hostname）。 */
function scopedFetch(allow: readonly string[]) {
  return async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: string }> => {
    const u = new URL(url);
    if (!(allow.includes('*') || allow.includes(u.hostname))) {
      throw new Error(`net 越权：${u.hostname} 不在授权主机白名单内`);
    }
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status, body: await res.text() };
  };
}

// ---------------------------------------------------------------------------
// 设置命名空间（data/settings.json，tmp+rename 原子写）
// ---------------------------------------------------------------------------

interface SettingsStore {
  get<T>(key: string, fallback?: T): T;
  set(key: string, value: unknown): void;
  all(): Record<string, unknown>;
}

function createSettings(dataDir: string): SettingsStore {
  const file = path.join(dataDir, 'settings.json');
  const read = (): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  return {
    get<T>(key: string, fallback?: T): T {
      const all = read();
      return (key in all ? all[key] : fallback) as T;
    },
    set(key: string, value: unknown): void {
      const all = read();
      all[key] = value;
      writeJsonAtomic(file, all);
    },
    all(): Record<string, unknown> {
      return read();
    },
  };
}

// ---------------------------------------------------------------------------
// SDK ctx 构建
// ---------------------------------------------------------------------------

/** 事件处理器表（host-bootstrap 持有分发）。 */
export type EventHandlers = Map<string, Array<(payload: unknown) => void>>;

/** 上下文贡献器（provideContext 注册）。 */
export type ContextProvider = (ev: { sessionId: string }) => Promise<string> | string;

/** host-bootstrap 持有的 SDK 运行时句柄（工具表之外的可派发状态）。 */
export interface SdkRuntime {
  events: EventHandlers;
  contextProviders: ContextProvider[];
}

/**
 * 构建 SDK ctx（host-bootstrap 在 init 时调用；插件 activate 收到的即此对象）。
 * 返回 { ctx, runtime }：ctx 交插件，runtime 留宿主做事件/上下文分发。
 */
export function buildSdk(params: HostInitParams, io: SdkIo): { ctx: Record<string, unknown>; runtime: SdkRuntime } {
  const { permissions, dataDir } = params;
  const runtime: SdkRuntime = { events: new Map(), contextProviders: [] };

  const ctx: Record<string, unknown> = {
    id: params.pluginId,
    dataDir,
    /** 插件日志：notify 回 Supervisor 统一落盘（不占插件自身 IO）。 */
    log: (level: HostLogParams['level'], msg: string): void => {
      io.log(level, String(msg).slice(0, 2000));
    },
    /**
     * 注册 Agent 工具：registerTool(name, handler) 或
     * registerTool(name, {description, parameters}, handler)。
     * meta 随 init 应答上报，Core Bridge 以同名描述符向 dsh 注册。
     */
    registerTool: (
      name: string,
      metaOrHandler: HostToolMeta | ((args: unknown) => Promise<unknown> | unknown),
      handler?: (args: unknown) => Promise<unknown> | unknown,
    ): void => {
      const meta: HostToolMeta =
        typeof metaOrHandler === 'function' ? { name } : { ...metaOrHandler, name: metaOrHandler.name || name };
      const fn = typeof metaOrHandler === 'function' ? metaOrHandler : handler;
      if (typeof fn !== 'function') throw new Error(`registerTool(${name}) 缺少处理函数`);
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error(`工具名 ${name} 非法（[A-Za-z0-9_.-]，≤64）`);
      io.tools.set(name, { meta, handler: fn });
    },
    /** 只读事件订阅（Supervisor 广播：turn-end 等）。 */
    on: (event: string, cb: (payload: unknown) => void): void => {
      const list = runtime.events.get(event) ?? [];
      list.push(cb);
      runtime.events.set(event, list);
    },
    /**
     * 注册上下文贡献器：每个 Agent 回合的 system-prompt/assemble 前被调用，
     * 返回文本注入 assembly.contexts；超时（宿主侧）即丢弃，绝不阻塞回合。
     */
    provideContext: (fn: ContextProvider): void => {
      runtime.contextProviders.push(fn);
    },
    /** 插件私有设置命名空间（data/settings.json 原子落盘）。 */
    settings: createSettings(dataDir),
  };

  // —— deny-by-default 权限门：未声明的能力直接不存在 ——
  if (permissions.net !== undefined && permissions.net.length > 0) {
    ctx.net = { fetch: scopedFetch(permissions.net) };
  }
  ctx.fs = scopedFs(permissions.fs !== undefined && permissions.fs.length > 0
    ? [dataDir, ...permissions.fs]
    : [dataDir]);
  if (permissions.shell === true) {
    ctx.shell = {
      exec: (cmd: string, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          cp.exec(String(cmd), { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            const code = typeof err?.code === 'number' ? err.code : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          });
        }),
    };
  }
  if (permissions.env === true) {
    ctx.env = { get: (k: string): string | undefined => process.env[k] };
  }
  return { ctx, runtime };
}

/** 分发一个 Supervisor 广播事件（host-bootstrap 收 notify 后调用）。 */
export function dispatchEvent(rt: SdkRuntime, ev: SdkEventParams): void {
  for (const cb of rt.events.get(ev.name) ?? []) {
    try {
      cb(ev.payload);
    } catch (err) {
      // 单个订阅者抛错不影响其他订阅者与宿主。
      process.stderr.write(`[sdk] event ${ev.name} handler error: ${String((err as Error).message)}\n`);
    }
  }
}

/** 收集上下文贡献（宿主侧；每个 provider 单独限时，超时丢弃）。 */
export async function collectContext(
  rt: SdkRuntime,
  sessionId: string,
  perProviderTimeoutMs = 500,
): Promise<string[]> {
  const out: string[] = [];
  await Promise.all(
    rt.contextProviders.map(async (p) => {
      try {
        const text = await Promise.race([
          Promise.resolve(p({ sessionId })),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), perProviderTimeoutMs).unref?.()),
        ]);
        if (typeof text === 'string' && text.length > 0) out.push(text);
      } catch {
        /* 该 provider 本回合贡献被丢弃 */
      }
    }),
  );
  return out;
}

/** 上下文贡献打包（Supervisor 侧组装为 assembly.contexts 追加项）。 */
export function toContributions(pluginId: string, texts: string[]): ContextContribution[] {
  // order=500：晚于核心 systemPrompt 固有段（低 order 在前），先于 tdai 等
  // 回忆注入（1000+）——扩展上下文位于「核心之后、重召回之前」的稳定档位。
  return texts.map((text, i) => ({ name: `eac:${pluginId}:${i}`, order: 500 + i, text }));
}

/**
 * host-bootstrap.ts — Extension Host 进程入口（VNext Phase 2，Task 10.2/11.1）。
 *
 * 运行形态：每个启用的 SDK 插件一个独立 Node 子进程（内置 node.exe 拉起
 * 本文件的编译产物 host-bootstrap.js），经 Win32 Job Object 围栏（见
 * lib/extension-host/job-fence.ts）与 Supervisor 隔离。
 *
 * 协议（长度前缀帧 JSON-RPC，见 lib/extension-host/rpc.ts）：
 *   1. Supervisor → req `init`（插件 id/入口/数据目录/权限）—— **本进程在
 *      收到 init 之前不加载任何插件代码**，这是混合围栏（Node spawn + Rust
 *      assign）的安全前提：插件代码不可能在围栏外执行；
 *   2. Supervisor → req `ping`（心跳，超时即被判死）；
 *   3. Supervisor → req `invoke`（工具调用，调用级超时由 RPC 层执行）；
 *   4. Supervisor → req `collect-context`（回合上下文收集，超时丢弃）；
 *   5. Supervisor → notify `event`（只读事件广播，SDK ctx.on 分发）；
 *   6. Host → notify `log`（插件结构化日志，Supervisor 转发落盘）。
 *
 * SDK 能力面（ctx）全部由 lib/extension-host/sdk 构建；本文件只做协议装配。
 */

import { RpcPeer } from './lib/extension-host/rpc.js';
import {
  buildSdk, dispatchEvent, collectContext,
  validateArgs, type SdkRuntime,
} from './lib/extension-host/sdk/index.js';
import type {
  CollectContextParams, HostInitParams, HostInvokeParams, HostLogParams,
  PingParams, SdkEventParams,
} from './shared/protocol.js';

// ---------------------------------------------------------------------------
// 插件装载状态（init 后填充）
// ---------------------------------------------------------------------------

let runtime: SdkRuntime | null = null;
/** 工具表：name → {meta, handler}（init 前为空，invoke 未注册工具即报错）。 */
const tools = new Map<string, { meta: { name: string; description?: string; parameters?: Record<string, { type?: string; required?: boolean; description?: string }> }; handler: (args: unknown) => Promise<unknown> | unknown }>();

// ---------------------------------------------------------------------------
// RPC 端点
// ---------------------------------------------------------------------------

const peer = new RpcPeer({
  write: process.stdout,
  onClosed: (reason) => {
    // Supervisor 断开（退出/被杀）：host 无存活意义，立即退（Job 也会兜底）。
    process.stderr.write(`[host-bootstrap] supervisor 断开: ${reason}\n`);
    process.exit(0);
  },
  // 事件广播（notify）：runtime 未就绪（init 前）时静默丢弃。
  onNotify: (method, params) => {
    if (method === 'event' && runtime) {
      dispatchEvent(runtime, params as SdkEventParams);
    }
  },
});

// 心跳：原样回带发出时间戳（Supervisor 侧测 RTT / 超时判死）
peer.handle('ping', (params) => {
  const p = params as PingParams;
  return { t: p.t, now: Date.now() };
});

// 工具调用：不存在/参数非法/异常 → error 响应（调用级超时由 Supervisor 侧执行）
peer.handle('invoke', async (params) => {
  const p = params as HostInvokeParams;
  const t = tools.get(p.tool);
  if (!t) throw new Error(`unknown tool: ${p.tool}`);
  const args = validateArgs(t.meta.parameters, p.args);
  return await t.handler(args);
});

// init：加载插件并激活（在此之前本进程不执行任何插件代码）
peer.handle('init', async (params) => {
  const p = params as HostInitParams;
  const mod = require(p.entryPath) as
    | { activate?: (ctx: Record<string, unknown>) => unknown }
    | ((ctx: Record<string, unknown>) => unknown);
  const activate = typeof mod === 'function' ? mod : mod.activate;
  if (typeof activate !== 'function') {
    throw new Error(`插件入口无 activate 导出: ${p.entryPath}`);
  }
  const { ctx, runtime: rt } = buildSdk(p, {
    log: (level, msg) => peer.notify('log', { level, msg } satisfies HostLogParams),
    tools,
  });
  runtime = rt;
  await activate(ctx);
  return { tools: [...tools.values()].map((t) => t.meta) };
});

// 上下文收集：每个 provider 限时（默认 500ms），超时丢弃，绝不阻塞回合
peer.handle('collect-context', async (params) => {
  const p = params as CollectContextParams;
  if (!runtime) return [];
  const texts = await collectContext(runtime, p.sessionId, 500);
  return texts;
});

process.stdin.on('data', (chunk: Buffer) => peer.feed(chunk));

// 插件把宿主搞崩：留最后一行 stderr 给诊断，快速退出（Supervisor 感知 exit）
process.on('uncaughtException', (err) => {
  process.stderr.write(`[host-bootstrap] uncaughtException: ${String((err as Error)?.stack || err)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[host-bootstrap] unhandledRejection: ${String(reason)}\n`);
  process.exit(1);
});

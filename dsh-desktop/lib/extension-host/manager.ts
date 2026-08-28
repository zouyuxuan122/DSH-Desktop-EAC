/**
 * lib/extension-host/manager.ts — Extension Host 管理器（VNext Phase 2，Task 10.3）。
 *
 * 职责（Supervisor 侧）：
 *   - 拉起：为启用的 SDK 插件并行 spawn Host（Node spawn + Rust assignToJob
 *     混合围栏），init 握手成功才算启动成功（驱动状态机 starting→running）；
 *   - 心跳：周期 ping，超时即判死（卡死 = 崩溃），kill + 状态机处置；
 *   - 重启：崩溃 → running→retrying（指数退避，读注册表 nextRetryAt 排期）；
 *     连续失败达阈值由状态机自动 quarantined，Manager 不再拉起；
 *   - 事务留痕：全部转移经 applyTransition 落盘 + 事故记录（Task 9 机制）；
 *   - 退出：shutdownAll() 树杀全部 Host —— Job 模式下 Supervisor 自身崩溃
 *     也无孤儿（KILL_ON_JOB_CLOSE 由 OS 兜底）。
 *
 * 状态机协作约定：本模块**只**通过 applyTransition/noteStableRunning 触碰
 * 注册表动态字段，不自造状态，保证恢复中心与这里的视图一致。
 */

import path = require('node:path');
import fs = require('node:fs');
import { createFence, fenceMode, type FenceHandle, type FenceMode } from './job-fence.js';
import { RpcPeer } from './rpc.js';
import { readRegistry, writeRegistry } from '../supervisor/registry.js';
import type { RegistryEntry } from '../supervisor/registry.js';
import { extensionsRoot, installSdkPlugin } from '../supervisor/installer.js';
import { applyTransition, noteStableRunning, STABLE_MS } from '../supervisor/state-machine.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { toContributions } from './sdk/index.js';
import type {
  CollectContextParams, ContextContribution, HostInitParams, HostInitResult,
  HostInvokeParams, HostLogParams, HostToolMeta, PingParams, SdkEventParams,
} from '../../shared/protocol.js';

/** Manager 可调参数（生产默认值适合常驻；测试注入短周期）。 */
export interface ExtensionHostManagerOpts {
  /** 拉起 Host 的 Node 可执行文件（内置 node.exe；测试用 process.execPath）。 */
  nodeExe: string;
  /** host-bootstrap.js 编译产物绝对路径。 */
  hostBootstrapPath: string;
  /** 心跳间隔（默认 10s）。 */
  heartbeatIntervalMs?: number;
  /** 心跳超时（默认 5s；超时即判死）。 */
  heartbeatTimeoutMs?: number;
  /** 每插件 Host 内存硬上限（默认 512MB；仅 win32-job 模式生效）。 */
  memoryLimitBytes?: number;
  /** init 握手超时（默认 15s）。 */
  initTimeoutMs?: number;
  /**
   * 测试加速：崩溃/启动失败后的重启延迟覆盖值（生产 undefined =
   * 按注册表 nextRetryAt 指数退避）。设置后 startPlugin 也会先清空
   * 注册表里的退避门（nextRetryAt），否则状态机会按真实 30s 退避拒绝
   * 立即重试，测试将不可行。生产永不设置。
   */
  restartDelayOverrideMs?: number;
}

/** 单个 Host 的运行期句柄。 */
interface HostRuntime {
  readonly id: string;
  readonly fence: FenceHandle;
  readonly peer: RpcPeer;
  readonly startedAt: number;
  /** init 握手是否已完成（未完成时退出归 start-failed，不作 crash）。 */
  initDone: boolean;
  heartbeat?: NodeJS.Timeout;
  /** init 应答的工具元数据（Core Bridge 据此向 Agent 注册工具）。 */
  tools: HostToolMeta[];
  /** 稳定清零是否已生效（每次成功启动重置一次）。 */
  stableNoted: boolean;
  /** 主动停止中：不触发 crash 转移。 */
  stopping: boolean;
}

/** Host 单实例管理器。 */
export class ExtensionHostManager {
  private readonly hosts = new Map<string, HostRuntime>();
  /** 排期中的重启定时器（停用/隔离/卸载时取消）。 */
  private readonly pendingRestarts = new Map<string, NodeJS.Timeout>();
  private readonly o: {
    nodeExe: string;
    hostBootstrapPath: string;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    memoryLimitBytes: number;
    initTimeoutMs: number;
    restartDelayOverrideMs?: number;
  };

  constructor(opts: ExtensionHostManagerOpts) {
    this.o = {
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 5_000,
      memoryLimitBytes: 512 * 1024 * 1024,
      initTimeoutMs: 15_000,
      ...opts,
    };
  }

  /** 当前运行中的插件 id 列表（快照）。 */
  runningIds(): string[] {
    return [...this.hosts.keys()];
  }

  /** 插件已注册的工具元数据（未运行返回空）。 */
  toolMetas(id: string): HostToolMeta[] {
    return [...(this.hosts.get(id)?.tools ?? [])];
  }

  /** 全部运行中插件的工具元数据（Core Bridge /tools 端点用）。 */
  allToolMetas(): Array<HostToolMeta & { pluginId: string }> {
    const out: Array<HostToolMeta & { pluginId: string }> = [];
    for (const [id, rt] of this.hosts) {
      for (const t of rt.tools) out.push({ ...t, pluginId: id });
    }
    return out;
  }

  /** 广播只读事件到全部运行中的 Host（SDK ctx.on 分发）。 */
  broadcastEvent(name: string, payload?: unknown): void {
    const p: SdkEventParams = { name, payload };
    for (const [, rt] of this.hosts) {
      rt.peer.notify('event', p);
    }
  }

  /**
   * 收集回合上下文贡献（Core Bridge /context 端点用）：
   * 每个 Host 单独限时，超时/异常即丢弃该插件本回合的贡献 —— 扩展卡死
   * 绝不阻塞核心回合（架构文档 §5 Core Bridge 语义）。
   */
  async collectContexts(sessionId: string, perHostTimeoutMs = 800): Promise<ContextContribution[]> {
    const jobs: Promise<ContextContribution[]>[] = [];
    for (const [id, rt] of this.hosts) {
      jobs.push(
        rt.peer
          .request<string[]>('collect-context', { sessionId } satisfies CollectContextParams, perHostTimeoutMs)
          .then((texts) => toContributions(id, Array.isArray(texts) ? texts : []))
          .catch(() => [] as ContextContribution[]),
      );
    }
    const all = await Promise.all(jobs);
    return all.flat();
  }

  /** Host 围栏档位（恢复中心展示真实平台保障级别）。 */
  fenceMode(): FenceMode {
    return fenceMode();
  }

  /**
   * 拉起一个插件的 Host（幂等：已在运行则直接返回成功）。
   * 状态机：starting →（init 成功）running /（失败）failed|quarantined。
   */
  async startPlugin(id: string): Promise<boolean> {
    if (this.hosts.has(id)) return true;
    let reg = readRegistry();
    let e = reg.plugins[id] as RegistryEntry | undefined;
    if (!e) {
      log('ext-host', `拉起失败：${id} 未建档`);
      return false;
    }
    if (e.kind !== 'isolated') {
      log('ext-host', `跳过：${id} 非 SDK 插件（kind=${e.kind}，Legacy 走 Core 注入）`);
      return false;
    }
    // 残留 running 态对账：上方 hosts.has 已排除内存中的活宿主，故注册表里的
    // running 只可能是上次会话异常终止（sidecar 被杀/断电）留下的 stale 标记。
    // 按运行期崩溃转移（running→retrying/quarantined，自动退避），否则状态机
    // 拒绝 running→starting，该插件将从此永不拉起（安装态冒烟实测抓出）。
    if (e.state === 'running') {
      log('ext-host', `${id}: 对账残留 running（上次会话异常退出），按崩溃转移`);
      applyTransition(id, { type: 'crash', reason: 'stale-running-reconcile' });
      reg = readRegistry();
      e = reg.plugins[id] as RegistryEntry | undefined;
      if (!e) return false;
    }
    // 测试加速模式：清退避门（见 opts.restartDelayOverrideMs 注释）。
    if (this.o.restartDelayOverrideMs !== undefined && e.nextRetryAt) {
      delete e.nextRetryAt;
      reg.plugins[id] = e;
      writeRegistry(reg);
    }
    // 状态机入口：installed/failed/disabled → starting。注意 retrying 态：
    // 「starting」事件对 retrying 不适用（架构文档 §8 中 retrying → running 由
    // 重启成功即 started 完成），此时直接继续重拉，只尊重退避窗口。
    const t = applyTransition(id, { type: 'starting' });
    if (!t.changed) {
      const backoffLeft = e.nextRetryAt ? new Date(e.nextRetryAt).getTime() - Date.now() : 0;
      const isRetrying = e.state === 'retrying';
      if (t.reason === 'event-not-applicable' && isRetrying && backoffLeft <= 0) {
        // retrying 且退避已过：继续重拉（hosts 起来后 started 会完成
        // retrying → running 转移）。
      } else if (t.reason === 'event-not-applicable' && backoffLeft > 0) {
        // 退避窗口未到（启动链遇到上次失败/崩溃的排期）：顺延到窗口后再试。
        const delay = backoffLeft + 250;
        log('ext-host', `${id}: 退避窗口未到，${delay}ms 后再拉起`);
        const timer = setTimeout(() => {
          this.pendingRestarts.delete(id);
          void this.startPlugin(id);
        }, delay);
        timer.unref();
        this.pendingRestarts.set(id, timer);
        return false;
      } else {
        log('ext-host', `${id}: 拉起被状态机拒绝（${t.reason}，state=${e.state}）`);
        return false;
      }
    }

    const fence = createFence({ memoryLimitBytes: this.o.memoryLimitBytes });
    let handle: FenceHandle;
    try {
      handle = fence.launch(this.o.nodeExe, [this.o.hostBootstrapPath]);
    } catch (err) {
      fence.dispose(); // 未用的 Job 句柄立即回收
      this.startFailed(id, `围栏 spawn 失败: ${String((err as Error).message)}`);
      return false;
    }

    const peer = new RpcPeer({
      write: handle.stdin,
      onClosed: (reason) => log('ext-host', `${id}: RPC 断开（${reason}）`),
      onNotify: (method, params) => {
        if (method === 'log') {
          const p = params as HostLogParams;
          log(`ext:${id}:${p.level}`, String(p.msg));
        }
      },
    });
    handle.stdout.on('data', (c: Buffer) => peer.feed(c));
    handle.stderr.on('data', (c: Buffer) => log(`ext:${id}:stderr`, c.toString().trimEnd()));
    handle.onExit((code) => void this.onHostExit(id, code));
    // Host 死亡瞬间管道上仍在途的写会异步抛 EPIPE/ERR_STREAM_DESTROYED ——
    // stream 的 error 事件不经过 RpcPeer.send 的 try/catch，必须在此显式
    // 吞掉（断开语义已由 onExit/peer.close 处理）。
    for (const s of [handle.stdin, handle.stdout, handle.stderr]) {
      s.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code ?? '';
        if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED' && code !== 'EBADF') {
          log('ext-host', `${id}: 流异常 ${code}: ${String(err.message)}`);
        }
      });
    }

    const rt: HostRuntime = {
      id,
      fence: handle,
      peer,
      startedAt: Date.now(),
      initDone: false,
      tools: [],
      stableNoted: false,
      stopping: false,
    };
    this.hosts.set(id, rt);

    // init 握手：此刻之前 Host 内没有任何插件代码（混合围栏安全前提）。
    // 握手期间 Host 崩溃 → onHostExit 因 initDone=false 只做清理并 reject
    // 在途请求 → 由下方 catch 统一走 start-failed（状态机只触发一次）。
    try {
      const res = await peer.request<HostInitResult>('init', this.initParamsOf(id, e), this.o.initTimeoutMs);
      rt.tools = res.tools ?? [];
      rt.initDone = true;
      rt.heartbeat = setInterval(() => void this.heartbeatTick(id), this.o.heartbeatIntervalMs);
      rt.heartbeat.unref();
      applyTransition(id, { type: 'started', stableForMs: 0 });
      log('ext-host', `${id}: Host 已运行（pid=${handle.pid}，tools=[${rt.tools.map((t) => t.name).join(',')}]，围栏=${handle.mode}）`);
      return true;
    } catch (err) {
      // 握手失败：Host 可能活着但不可用 —— 杀掉再走 start-failed。
      await this.killHost(id);
      this.startFailed(id, `init 握手失败: ${String((err as Error).message)}`);
      return false;
    }
  }

  /** 全部启用中的 SDK 插件并行拉起（启动链 / 恢复中心「全部重试」用）。 */
  async startEnabled(): Promise<void> {
    const reg = readRegistry();
    const ids = Object.values(reg.plugins)
      .filter(
        (e) =>
          e.kind === 'isolated' &&
          e.enabled &&
          (e.state === 'installed' || e.state === 'failed' || e.state === 'retrying'),
      )
      .map((e) => e.id);
    await Promise.allSettled(ids.map((id) => this.startPlugin(id)));
  }

  /** 主动停用（恢复中心 / 卸载路径）：不触发 crash 转移，取消排期重启。 */
  async stopPlugin(id: string): Promise<void> {
    this.cancelPendingRestart(id);
    const rt = this.hosts.get(id);
    if (!rt) return;
    rt.stopping = true;
    await this.killHost(id);
  }

  /** 工具调用（调用级严格超时由 RPC 层执行）。 */
  async invoke(id: string, tool: string, args?: unknown, timeoutMs?: number): Promise<unknown> {
    const rt = this.hosts.get(id);
    if (!rt) throw new Error(`插件 ${id} 未运行`);
    const p: HostInvokeParams = { tool, args };
    return await rt.peer.request('invoke', p, timeoutMs ?? this.o.heartbeatTimeoutMs * 2);
  }

  /** Supervisor 退出路径：树杀全部 Host（幂等）。 */
  async shutdownAll(): Promise<void> {
    const ids = [...this.hosts.keys()];
    await Promise.allSettled(ids.map((id) => this.stopPlugin(id)));
  }

  /** 取消排期中的重启（停用/隔离/卸载路径调用）。 */
  cancelPendingRestart(id: string): void {
    const t = this.pendingRestarts.get(id);
    if (t) {
      clearTimeout(t);
      this.pendingRestarts.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private initParamsOf(id: string, e: RegistryEntry): HostInitParams {
    const pkgDir = path.join(extensionsRoot(), id, 'package');
    let main = 'index.js';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { main?: string };
      if (pkg.main && typeof pkg.main === 'string') main = pkg.main;
    } catch {
      /* 无 package.json（目录损坏）：入口回落 index.js，init 会失败并留痕 */
    }
    return {
      pluginId: id,
      entryPath: path.join(pkgDir, main),
      dataDir: path.join(extensionsRoot(), id, 'data'),
      permissions: e.permissions ?? {},
    };
  }

  /** 心跳一次：超时/对端断开 → 判死（crash 状态机 + 排期重启）。 */
  private async heartbeatTick(id: string): Promise<void> {
    const rt = this.hosts.get(id);
    if (!rt || rt.stopping) return;
    try {
      await rt.peer.request<{ t: number; now: number }>('ping', { t: Date.now() } satisfies PingParams, this.o.heartbeatTimeoutMs);
      if (!rt.stableNoted && Date.now() - rt.startedAt >= STABLE_MS) {
        rt.stableNoted = true;
        noteStableRunning(id);
      }
    } catch (err) {
      // 判死 = 崩溃的一种：kill（摘表，exit 事件随之 no-op）→ crash 转移。
      log('ext-host', `${id}: 心跳超时/失败（${String((err as Error).message)}），判死`);
      // 先记「是否仍在表」：killHost 的 peer.close 会拒绝在途 ping —— 若本次
      // 失败源于主动停止（stopPlugin/shutdownAll 已摘表）或 exit 事件已并发
      // 处置，则不是崩溃，绝不能再做 crash 转移/排期重启；否则会在
      // shutdownAll 之后复活一个永不回收的 Host（测试进程被挂死；降级围栏
      // 模式下生产亦会泄漏孤儿进程）。
      const stillTracked = this.hosts.has(id);
      await this.killHost(id);
      if (rt.stopping || !stillTracked) return;
      applyTransition(id, { type: 'crash', reason: `心跳超时（${String((err as Error).message).slice(0, 120)}）` });
      this.scheduleRestart(id);
    }
  }

  /** Host 退出（自退/被杀/围栏终结）：驱动状态机 + 排期重启。 */
  private async onHostExit(id: string, code: number | null): Promise<void> {
    const rt = this.hosts.get(id);
    if (!rt) return; // 已处置（killHost 摘表后的 exit 事件 / 重复回调）
    if (rt.heartbeat) clearInterval(rt.heartbeat);
    this.hosts.delete(id);
    rt.peer.close(`exit:${code}`);
    rt.fence.dispose();

    // 主动停止：状态由调用方（恢复中心）转移；
    // init 未完成：peer.close 已 reject 在途 init → startPlugin 的 catch 走
    // start-failed（避免 crash/start-failed 双重转移与双份重启定时器）。
    if (rt.stopping || !rt.initDone) return;

    applyTransition(id, { type: 'crash', reason: `Host 退出 code=${code}` });
    this.scheduleRestart(id);
  }

  /** 崩溃/启动失败后的重启排期：隔离/停用手；否则按退避延迟拉起。 */
  private scheduleRestart(id: string): void {
    const reg = readRegistry();
    const e = reg.plugins[id] as RegistryEntry | undefined;
    if (!e || e.state === 'quarantined' || e.state === 'disabled' || e.state === 'uninstalled') {
      log('ext-host', `${id}: 已隔离/停用（state=${e?.state ?? 'unknown'}），不再重启`);
      return;
    }
    const delay = this.restartDelay(e);
    log('ext-host', `${id}: ${delay}ms 后重试拉起（state=${e.state}）`);
    // 防双拉起：exit 事件与心跳判死可能并发触发两次排期，旧定时器若不清
    // 会照常触发（Map.set 只覆盖引用不取消定时器），导致重启风暴。
    this.cancelPendingRestart(id);
    const timer = setTimeout(() => {
      this.pendingRestarts.delete(id);
      void this.startPlugin(id);
    }, delay);
    timer.unref();
    this.pendingRestarts.set(id, timer);
  }

  /** 退避延迟：测试覆盖值优先，否则按注册表 nextRetryAt（+250ms 缓冲，
   *  防定时器比窗口早几毫秒触发、被状态机拒绝后丢失重试）。 */
  private restartDelay(e: RegistryEntry): number {
    if (this.o.restartDelayOverrideMs !== undefined) return this.o.restartDelayOverrideMs;
    if (e.nextRetryAt) {
      return Math.max(0, new Date(e.nextRetryAt).getTime() - Date.now()) + 250;
    }
    return 0;
  }

  /** 启动失败：状态机 start-failed + 排期重试（隔离后停手）。 */
  private startFailed(id: string, reason: string): void {
    applyTransition(id, { type: 'start-failed', reason });
    this.scheduleRestart(id);
  }

  /** 树杀 Host 并清理本地句柄（不触碰状态机）。 */
  private async killHost(id: string): Promise<void> {
    const rt = this.hosts.get(id);
    if (!rt) return;
    if (rt.heartbeat) clearInterval(rt.heartbeat);
    this.hosts.delete(id);
    rt.peer.close('supervisor-kill');
    await rt.fence.kill();
  }
}

// ---------------------------------------------------------------------------
// 生产单例（Electron 主进程装配；测试直接 new ExtensionHostManager(opts)）
// ---------------------------------------------------------------------------

let defaultManager: ExtensionHostManager | null = null;

/** 生产 Manager：内置 node.exe + 根目录 host-bootstrap.js。 */
export function getExtensionHostManager(): ExtensionHostManager {
  if (defaultManager) return defaultManager;
  // 本地 Tauri 架构：nodeExe 走 lib/desktop/runtime-paths（dev=vendor/node，
  // 打包=resources/node）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { nodeExe } = require('../desktop/runtime-paths.js') as typeof import('../desktop/runtime-paths.js');
  defaultManager = new ExtensionHostManager({
    nodeExe: nodeExe(),
    hostBootstrapPath: path.resolve(__dirname, '..', '..', 'host-bootstrap.js'),
  });
  return defaultManager;
}

/** 启动链入口：并行拉起全部启用的 SDK 插件（无插件时为空操作）。 */
export async function startEnabledExtensionHosts(): Promise<void> {
  try {
    await getExtensionHostManager().startEnabled();
  } catch (err) {
    log('ext-host', '启动 SDK 插件宿主失败（不影响核心）: ' + String((err as Error).message));
  }
}

/**
 * 首启安装随包分发的 SDK 示例插件（幂等：注册表已有档案即跳过——包括
 * 用户主动卸载后的 uninstalled 态，绝不擅自重装）。
 */
export function ensureBundledSdkPlugins(): void {
  try {
    const id = 'sample-sdk-plugin';
    if (readRegistry().plugins[id]) return;
    const srcDir = path.join(__dirname, '..', '..', 'assets', 'sdk-plugins', 'sample-sdk-plugin');
    if (!fs.existsSync(srcDir)) return;
    const r = installSdkPlugin(id, { srcDir });
    if (r.ok) log('ext-host', `示例 SDK 插件已安装（sha256=${(r.packageSha256 ?? '').slice(0, 12)}…）`);
    else log('warn', `示例 SDK 插件安装失败: ${r.error ?? ''}`);
  } catch (err) {
    log('warn', '示例 SDK 插件安装异常: ' + String((err as Error).message));
  }
}

/** 退出链入口：树杀全部 Host + 关闭 Core Bridge 端点（before-quit 调用；幂等）。 */
export async function shutdownExtensionHosts(): Promise<void> {
  try {
    if (state.eacBridge) {
      state.eacBridge.close();
      state.eacBridge = null;
    }
  } catch {
    /* 端点已关 */
  }
  if (!defaultManager) return;
  try {
    await defaultManager.shutdownAll();
  } catch (err) {
    log('ext-host', '关闭插件宿主异常: ' + String((err as Error).message));
  }
}

'use strict';

// dsh web 服务进程编排（ADR 0002 L2 业务服务层；P2 自 main.js 的
// startServer / watchServerProc / waitUntilUp 提取，启动语义零变更，
// GUI 相关部分（loadURL / 「服务已停止」对话框）经 ctx 回调交给宿主）。
//
// 双轨说明：Electron main.js 在 M3 切换前保留原实现（可回退主线）；
// Tauri sidecar 挂载本模块，经 RPC 暴露：
//   boot.start   {overlays?} → {webUrl, port}
//   boot.stop    {}           → {ok}
//   boot.restart 编排由 sidecar 组合（市场排队 → 同步 → 本模块起停）
//   boot.state   {}           → {running, webUrl}
// 服务意外死亡经 ctx.onServerDied 上抛，宿主决定恢复页 / 对话框 / 静默。

import fs = require('node:fs');
import http = require('node:http');
import path = require('node:path');
import cp = require('node:child_process');
import type { ChildProcess } from 'node:child_process';

// 兄弟 / 根模块窄签名消费（Wave 3 收编完成后改为具名类型化导入）。
const { killTree, killTreeAndWait, waitForProcExit, childEnv } = require('./proc') as {
  killTree(p: ChildProcess | null | undefined): void;
  killTreeAndWait(p: ChildProcess | null | undefined, o?: { graceMs?: number; hardMs?: number }): Promise<void>;
  waitForProcExit(p: ChildProcess | null | undefined, timeoutMs: number): Promise<void>;
  childEnv(): NodeJS.ProcessEnv;
};
const { restrictedPortOf, chooseStableWebPort } = require('../../stable-port') as {
  restrictedPortOf(url: string): number;
  chooseStableWebPort(ctx: unknown): Promise<number>;
};
const { createStreamWriteGuard } = require('../../stream-write-guard') as {
  createStreamWriteGuard(
    stream: fs.WriteStream,
    opts: { onError(err: unknown): void },
  ): { write(chunk: unknown): boolean; end(): void };
};

/** 注入接口：由宿主（Tauri sidecar；未来可收敛 Electron）在启动时提供。 */
export interface BootServerCtx {
  log(tag: string, msg: string): void;
  getUserDataDir(): string;
  getDesktopProfile(): string;
  desktopProfileDir(): string;
  nodeExe(): string;
  dshBin(): string;
  loadSettings(): { webPort?: number } & Record<string, unknown>;
  saveSettings(s: Record<string, unknown>): void;
  isQuitting(): boolean;
  /** 服务就绪后意外死亡（非主动重启、非退出中）时上抛。 */
  onServerDied?(info: { code: number | null; signal: string | null; logPath: string }): void;
}

let ctx!: BootServerCtx;
export function init(d: BootServerCtx): void { ctx = d; }

let serverProc: ChildProcess | null = null;
let restartingServer = false;
let webUrl = '';

export function getServerProc(): ChildProcess | null { return serverProc; }
export function getWebUrl(): string { return webUrl; }
export function setWebUrl(url: string): void { webUrl = url; }
export function isRestarting(): boolean { return restartingServer; }
export function setIsRestarting(v: boolean): void { restartingServer = v; }

function logsDir(): string { return path.join(ctx.getUserDataDir(), 'logs'); }
function dshWebLogPath(): string { return path.join(logsDir(), 'dsh-web.log'); }

async function startServer(unsafePortRetries = 4, overlays: string[] = []): Promise<string> {
  // M1 修复：重入前先终结旧进程，避免孤儿 harness 同时写同一 DSH_HOME。
  if (serverProc && !serverProc.killed && !ctx.isQuitting()) {
    ctx.log('dsh', 'startServer 重入：先终结旧进程再启动');
    killTree(serverProc);
    serverProc = null;
  }
  // 稳定端口（stable-port）：复用 settings.webPort，避免每次 --port 0 换
  // origin 导致 localStorage 偏好丢失；同时避开 Chromium 受限端口。
  const webPort = await chooseStableWebPort({
    loadSettings: () => ctx.loadSettings(),
    saveSettings: (_c: unknown, s: unknown) => ctx.saveSettings(s as Record<string, unknown>),
  });
  return new Promise<string>((resolve, reject) => {
    const nodeBin = ctx.nodeExe();
    const bin = ctx.dshBin();
    if (!fs.existsSync(nodeBin)) {
      return reject(new Error('找不到内置 Node 运行时: ' + nodeBin));
    }
    fs.mkdirSync(logsDir(), { recursive: true });
    const out = fs.createWriteStream(dshWebLogPath(), { flags: 'a' });
    ctx.log('dsh', `启动: "${nodeBin}" "${bin}" web --host 127.0.0.1 --port ${webPort}`);
    // --use-system-ca：让 dsh web 进程信任系统证书库（代理/MITM 场景下内置
    // node 的默认 CA 无法验证，导致插件市场等对外 fetch 失败）。
    const patchArgs = overlays
      .filter((p) => typeof p === 'string' && p && fs.existsSync(p))
      .flatMap((p) => ['--patch', p]);
    // `--profile <name>` 直接在根命令上（本版本的 `web` 是 --profile web 的
    // 硬编码别名，不接受父级 --profile）；--host/--port 透传给该 app。
    const proc = cp.spawn(
      nodeBin,
      ['--use-system-ca', bin, '--profile', ctx.getDesktopProfile(), '--host', '127.0.0.1', '--port', String(webPort), '--no-open', ...patchArgs],
      {
        cwd: ctx.getUserDataDir(),
        env: childEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    serverProc = proc;
    // profile 首次引导（node_modules 缺失）时 dsh 要先跑 pnpm 装齐依赖，
    // 就绪等待放宽（下方 bootTimeoutMs）。
    const firstBoot = !fs.existsSync(path.join(ctx.desktopProfileDir(), 'node_modules'));
    watchServerProc(proc, out, { expectedPort: webPort, unsafePortRetries, overlays, firstBoot }).then(resolve, reject);
  });
}

// 等待 dsh web 子进程 stdout 出现就绪 URL 行；进程提前退出 / 启动超时则拒绝。
interface WatchOpts {
  expectedPort: number;
  unsafePortRetries: number;
  overlays: string[];
  firstBoot: boolean;
}

function watchServerProc(proc: ChildProcess, out: fs.WriteStream, opts: WatchOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let handedOff = false; // 受限端口重启：本实例的退出不再影响外层 Promise
    let bootTimer: NodeJS.Timeout | null = null;
    const output = createStreamWriteGuard(out, {
      onError: (err) => ctx.log('warn', 'dsh web 日志流异常: ' + String((err && (err as Error).message) || err)),
    });
    let onSettled: ((err: Error | null, url: string) => void) | null = (err, url) => {
      if (err) reject(err); else resolve(url);
    };
    const finish = (err: Error | null, url: string) => {
      if (!settled) {
        settled = true;
        onSettled?.(err, url);
        onSettled = null;
      }
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    };
    const onData = (chunk: Buffer) => {
      output.write(chunk);
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/dsh web:\s+(https?:\/\/\S+)/);
        if (!m) continue;
        const blocked = restrictedPortOf(m[1]);
        if (blocked && opts.unsafePortRetries > 0) {
          // 端口命中 Chromium 受限列表：结束该实例重启换端口（有上限）。
          handedOff = true;
          ctx.log('dsh', `端口 ${blocked} 属于 Chromium 受限端口（ERR_UNSAFE_PORT），重启服务换端口（剩余重试 ${opts.unsafePortRetries} 次）`);
          killTree(proc);
          setTimeout(() => {
            if (ctx.isQuitting()) return finish(new Error('应用正在退出'), '');
            startServer(opts.unsafePortRetries - 1, opts.overlays).then(
              (url) => finish(null, url),
              (err) => finish(err, ''),
            );
          }, 600);
          return;
        }
        // 稳定端口：若 dsh 最终监听端口与请求的不同（极端兜底），以实际为准并保存。
        try {
          const actual = Number(new URL(m[1]).port) || 0;
          if (actual > 0 && actual !== opts.expectedPort) {
            const settings = ctx.loadSettings();
            settings.webPort = actual;
            ctx.saveSettings(settings);
          }
        } catch { /* URL 解析失败时忽略 */ }
        finish(null, m[1]);
      }
    };
    const onStderrData = (chunk: Buffer) => output.write(chunk);
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onStderrData);
    proc.once('error', (err) => finish(err, ''));
    // close 在 exit 之后、stdio 全部关闭后触发：此时再结束文件流，既保留尾部
    // 输出，也不会让迟到的 data 写入已 end 的 Writable。
    proc.once('close', () => {
      proc.stdout!.removeListener('data', onData);
      proc.stderr!.removeListener('data', onStderrData);
      output.end();
    });
    // HTTP 就绪探测与 stdout 就绪行并行竞争 —— 就绪行被管道缓冲吞掉或格式
    // 变化时不再白白等满 bootTimer（「启动 60 秒超时」的主要假阳性来源）。
    if (restrictedPortOf(`http://127.0.0.1:${opts.expectedPort}`) === 0) {
      const probeUrl = `http://127.0.0.1:${opts.expectedPort}`;
      void (async () => {
        while (!settled) {
          const ok = await new Promise<boolean>((res) => {
            const req = http.get(probeUrl + '/', { timeout: 2500 }, (r) => {
              r.resume();
              res(!!r.statusCode && r.statusCode < 500);
            });
            req.on('error', () => res(false));
            req.on('timeout', () => { req.destroy(); res(false); });
          }).catch(() => false);
          if (ok) { finish(null, probeUrl); return; }
          await new Promise((r) => setTimeout(r, 350));
        }
      })();
    }
    proc.once('exit', (code, signal) => {
      ctx.log('dsh', `进程退出 code=${code} signal=${signal}`);
      // 原地重启（插件市场）或已替换为新进程时，不打扰用户、也不清新句柄。
      const intentional = restartingServer || serverProc !== proc;
      if (serverProc === proc) serverProc = null;
      if (!handedOff) {
        finish(new Error(`dsh web 启动失败（退出码 ${code}）。日志: ${dshWebLogPath()}`), '');
      }
      if (!ctx.isQuitting() && !intentional && !handedOff && webUrl) {
        ctx.onServerDied?.({ code, signal, logPath: dshWebLogPath() });
      }
    });
    // 兜底：就绪行与 HTTP 探测都未按时落地时超时。首次引导（pnpm 装依赖）
    // 放宽到 180 秒，稳态 60 秒。
    const bootTimeoutMs = opts.firstBoot ? 180000 : 60000;
    bootTimer = setTimeout(
      () => finish(new Error(`等待 dsh web 启动超时（${Math.round(bootTimeoutMs / 1000)} 秒）`), ''),
      bootTimeoutMs,
    );
    bootTimer.unref();
  });
}

function waitUntilUp(url: string, timeoutMs = 120000): Promise<string> {
  const started = Date.now();
  return new Promise<string>((resolve, reject) => {
    const tick = () => {
      const req = http.get(url + '/', { timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(url);
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error('Web UI 未在预期时间内就绪'));
      else setTimeout(tick, 300);
    };
    tick();
  });
}

/** 拉起服务并等待 Web UI 就绪（= main.js startAndShow 的非 GUI 部分）。 */
export async function startAndWait(overlays: string[] = []): Promise<{ webUrl: string; port: number }> {
  const url = await startServer(4, overlays).then((u) => waitUntilUp(u));
  webUrl = url;
  let port = 0;
  try { port = Number(new URL(url).port) || 0; } catch { /* 保持 0 */ }
  return { webUrl: url, port };
}

/** 退出路径专用：有界同步回收服务进程树（grace → 强杀 → 再等）。 */
export async function stopServer(): Promise<void> {
  const proc = serverProc;
  serverProc = null;
  await killTreeAndWait(proc);
}

/** 原地重启前置：终结旧进程并等待真正退出（DLL 文件锁释放），供 sidecar
 *  在“无锁窗口”里执行市场排队任务 / 同步配套插件后再拉起新服务。 */
export async function killAndWaitForRestart(): Promise<void> {
  const old = serverProc;
  serverProc = null;
  killTree(old);
  await waitForProcExit(old, 20000);
}

export function state(): { running: boolean; webUrl: string } {
  return { running: !!(serverProc && serverProc.exitCode === null), webUrl };
}

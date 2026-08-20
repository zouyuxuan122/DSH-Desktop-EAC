/**
 * lib/server.ts — Core Harness（dsh web 服务）生命周期（Task 2.3 自 main.js 提取）。
 *
 * 职责链：
 *   childEnv → stablePortCtx → startServer → watchServerProc（就绪行/HTTP 探测
 *   双竞争 + 受限端口重启交接）→ waitUntilUp → startAndShow / startAndShowGuarded
 *   （守护启动：快照→拉起→失败 preRetry 修复→重试）；bootRescuePreRetry 汇聚
 *   会话编码自愈（Issue #77）与 pnpm allowBuilds 放行（V4.2）两类「体检看不到」
 *   的数据/配置层修复；restartWebServiceCore 供插件安装后的原地重启。
 *
 * 关键时序注释（受限端口 handedOff、首启 180s 超时等）均为历史事故修复，
 * 原样保留，勿改动节奏。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { app, clipboard } from 'electron';
import * as updater from '../updater.js';
import { restrictedPortOf, chooseStableWebPort } from '../stable-port.js';
import type { StablePortCtx } from '../stable-port.js';
import { buildErrorDetail } from '../error-detail.js';
import {
  isEncodingMismatch,
  healSessionEncodingConflicts,
} from '../session-encoding-heal.js';
import { state } from './state.js';
import { log } from './log.js';
import { killTree, waitForProcExit, nodeExe, updCtx, dshBin } from './proc.js';
import { desktopProfile, desktopProfileDir } from './paths.js';
import { bridge } from './bridge.js';
import { allowBuilds } from './market-modules.js';

/** dsh 子进程环境：剔除 harness/session 残留变量，保留其余（代理/API Key）。 */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    'DSH_WEB_URL',
    'DSH_SESSION_ID',
    'DSH_SESSION_JSONL',
    'DSH_SHELL',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
  ]) {
    delete env[k];
  }
  if (state.dshHome) env.DSH_HOME = state.dshHome;
  // 桌面端标记 + 实际 profile：配套插件的 host 半边（插件市场 / Skills 与
  // MCP 等）据此把安装/读写落到桌面专属 profile，而不是原生的 web profile。
  env.DSH_DESKTOP = '1';
  env.DSH_DESKTOP_PROFILE = desktopProfile();
  env.NO_COLOR = '1';
  // VNext Phase 2：Core Bridge 回环端点（受信组件据此回调 Supervisor 调用
  // 隔离插件工具/收集上下文；仅回环 + 每会话一次性 token）。
  if (state.eacBridge) {
    env.DSH_EAC_BRIDGE_URL = state.eacBridge.url;
    env.DSH_EAC_BRIDGE_TOKEN = state.eacBridge.token;
  }
  return env;
}

/** stable-port.js 的依赖注入适配器：把 updater 的 settings 读写桥接过去。 */
export function stablePortCtx(): StablePortCtx {
  const c = updCtx();
  return {
    loadSettings: () => updater.loadSettings(c) as Record<string, unknown>,
    saveSettings: (_ctx, s) => updater.saveSettings(c, s as updater.DshSettings),
  };
}

/** startServer 参数：受限端口重试次数 + 额外 overlay patch 文件。 */
export async function startServer(
  unsafePortRetries = 4,
  overlays: string[] = [],
): Promise<string> {
  // M1 修复：重入前先终结旧进程，避免孤儿 harness 同时写同一 DSH_HOME。
  if (state.serverProc && !state.serverProc.killed && !state.quitting) {
    log('dsh', 'startServer 重入：先终结旧进程再启动');
    killTree(state.serverProc);
    state.serverProc = null;
  }
  // 稳定端口（stable-port.js）：复用 settings.webPort，避免每次 --port 0
  // 换 origin 导致 localStorage 偏好丢失；同时避开 Chromium 受限端口。
  const webPort = await chooseStableWebPort(stablePortCtx());
  return new Promise((resolve, reject) => {
    const nodeBin = nodeExe();
    const bin = dshBin();
    if (!fs.existsSync(nodeBin)) {
      reject(
        new Error(
          '找不到内置 Node 运行时: ' +
            nodeBin +
            '\n' +
            (app.isPackaged ? '安装包可能不完整，请重新安装。' : '开发模式请先运行: npm run fetch-node'),
        ),
      );
      return;
    }
    const out = fs.createWriteStream(path.join(state.logsDir, 'dsh-web.log'), { flags: 'a' });
    log('dsh', `启动: "${nodeBin}" "${bin}" web --host 127.0.0.1 --port ${webPort}`);
    // --use-system-ca: 让 dsh web 进程信任系统证书库（代理/MITM 场景下内置 node 的
    // 默认 CA 无法验证，导致插件市场等对外 fetch 失败）。
    const patchArgs = overlays
      .filter((p) => typeof p === 'string' && p && fs.existsSync(p))
      .flatMap((p) => ['--patch', p]);
    // `--profile <name>` 直接在根命令上（本版本的 `web` 是 --profile web 的
    // 硬编码别名，不接受父级 --profile）；app 入口由 profile bundles 决定，
    // --host/--port 等透传给该 app。已实机冒烟验证 web-desktop 可启动。
    const proc = spawn(
      nodeBin,
      [
        '--use-system-ca',
        bin,
        '--profile',
        desktopProfile(),
        '--host',
        '127.0.0.1',
        '--port',
        String(webPort),
        ...patchArgs,
      ],
      {
        cwd: state.userDataDir,
        env: childEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    state.serverProc = proc;
    // V4：profile 首次引导（node_modules 缺失）时 dsh 要先跑 pnpm 装齐依赖，
    // 就绪等待放宽（见 watchServerProc 的 bootTimer）。
    const firstBoot = !fs.existsSync(path.join(desktopProfileDir(), 'node_modules'));
    watchServerProc(proc, out, {
      expectedPort: webPort,
      unsafePortRetries,
      overlays,
      firstBoot,
    }).then(resolve, reject);
  });
}

/** watchServerProc 的可选参数。 */
export interface WatchOpts {
  expectedPort?: number;
  unsafePortRetries?: number;
  overlays?: string[];
  firstBoot?: boolean;
}

// 等待 dsh web 子进程 stdout 出现就绪 URL 行；进程提前退出 / 启动超时则拒绝。
// 退出时若服务已就绪过（webUrl 已设）且非主动重启，弹「DSH 服务已停止」对话框。
export function watchServerProc(
  proc: ChildProcess,
  out: fs.WriteStream,
  opts: WatchOpts = {},
): Promise<string> {
  const unsafePortRetries = opts.unsafePortRetries ?? 0;
  const overlays = opts.overlays ?? [];
  return new Promise((resolve, reject) => {
    let settled = false;
    let handedOff = false; // 受限端口重启：本实例的退出不再影响外层 Promise/弹窗
    let bootTimer: NodeJS.Timeout | null = null;
    const finish = (fn: (v: never) => void, value: unknown): void => {
      if (!settled) {
        settled = true;
        (fn as (v: unknown) => void)(value);
      }
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
    };
    const onData = (chunk: Buffer): void => {
      out.write(chunk);
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/dsh web:\s+(https?:\/\/\S+)/);
        const url = m && m[1];
        if (!url) continue;
        let blocked: number;
        if (state.testForceUnsafeOnce) {
          state.testForceUnsafeOnce = false;
          blocked = 6000; // 测试钩子：仅第一次强制视为受限端口
        } else {
          blocked = restrictedPortOf(url);
        }
        if (blocked && unsafePortRetries > 0) {
          // 端口命中 Chromium 受限列表：结束该实例重启换端口（有上限）。
          // 标记 handedOff，本实例的 exit 事件不得提前 reject 外层 Promise
          // 或弹出「服务已停止」对话框，结果交由递归重启决定。
          handedOff = true;
          log(
            'dsh',
            `端口 ${blocked} 属于 Chromium 受限端口（ERR_UNSAFE_PORT），重启服务换端口（剩余重试 ${unsafePortRetries} 次）`,
          );
          killTree(proc);
          setTimeout(() => {
            if (state.quitting) {
              finish(reject, new Error('应用正在退出'));
              return;
            }
            startServer(unsafePortRetries - 1, overlays).then(
              (u) => finish(resolve, u),
              (err) => finish(reject, err),
            );
          }, 600);
          return;
        }
        // 稳定端口：若 dsh 最终监听端口与请求的不同（极端兜底），以实际为准并保存。
        try {
          const actual = Number(new URL(url).port) || 0;
          if (opts.expectedPort != null && actual > 0 && actual !== opts.expectedPort) {
            const c = updCtx();
            const settings = updater.loadSettings(c);
            settings.webPort = actual;
            updater.saveSettings(c, settings);
          }
        } catch {
          /* 保存失败不影响就绪 */
        }
        finish(resolve, url);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', (c: Buffer) => out.write(c));
    proc.on('error', (err) => finish(reject, err));
    // V4：HTTP 就绪探测与 stdout 就绪行并行竞争 —— 就绪行被管道缓冲吞掉
    // 或格式变化时不再白白等满 bootTimer（「启动 60 秒超时」的主要假阳性
    // 来源）。expectedPort 由 chooseStableWebPort 挑选、已避开 Chromium
    // 受限端口，探测命中的 URL 与请求端口一致；受限端口重启交接（handedOff）
    // 期间 settled 由递归重启决定，探测自然退出。
    if (opts.expectedPort && restrictedPortOf(`http://127.0.0.1:${opts.expectedPort}`) === 0) {
      const probeUrl = `http://127.0.0.1:${opts.expectedPort}`;
      void (async () => {
        while (!settled) {
          const ok = await new Promise<boolean>((res) => {
            const req = http.get(probeUrl + '/', { timeout: 2500 }, (r) => {
              r.resume();
              res(!!r.statusCode && r.statusCode < 500);
            });
            req.on('error', () => res(false));
            req.on('timeout', () => {
              req.destroy();
              res(false);
            });
          }).catch(() => false);
          if (ok) {
            finish(resolve, probeUrl);
            return;
          }
          await new Promise((r) => setTimeout(r, 350));
        }
      })();
    }
    proc.on('exit', (code, signal) => {
      out.end();
      log('dsh', `进程退出 code=${code} signal=${signal}`);
      // 原地重启（插件市场）或已替换为新进程时，不打扰用户、也不清掉新进程的句柄。
      const intentional = state.restartingServer || state.serverProc !== proc;
      if (state.serverProc === proc) state.serverProc = null;
      if (!handedOff) {
        finish(
          reject,
          new Error(
            `dsh web 启动失败（退出码 ${code}）。日志: ${path.join(state.logsDir, 'dsh-web.log')}`,
          ),
        );
      }
      if (
        !state.quitting &&
        !intentional &&
        !handedOff &&
        state.webUrl &&
        state.mainWindow &&
        !state.mainWindow.isDestroyed()
      ) {
        const detail = buildErrorDetail(
          new Error(`dsh web 进程退出（code=${code} signal=${signal}）`),
          state.logsDir,
          ['dsh-web.log'],
        );
        bridge
          .showBox({
            type: 'error',
            title: 'DSH 服务已停止',
            message: 'Deepseek Harness 服务意外退出。',
            detail,
            buttons: ['复制日志', '重新启动', '退出'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
          })
          .then(({ response }) => {
            if (response === 0) clipboard.writeText(detail);
            else if (response === 1)
              startAndShow().catch((err) => void bridge.handleBootFailure(err));
            else app.quit();
          });
      }
    });
    // Safety net in case neither the URL line nor the HTTP probe lands in time.
    // V4：profile 首次引导（node_modules 尚不存在）需要 pnpm 从网络装齐
    // dsh-base + dsh-web-app，慢网络下 60 秒不够 —— 首启放宽到 180 秒，
    // 稳态启动维持 60 秒。
    const bootTimeoutMs = opts.firstBoot ? 180000 : 60000;
    bootTimer = setTimeout(
      () =>
        finish(
          reject,
          new Error(`等待 dsh web 启动超时（${Math.round(bootTimeoutMs / 1000)} 秒）`),
        ),
      bootTimeoutMs,
    );
    bootTimer.unref();
  });
}

/** 轮询 HTTP 探测直至 Web UI 真正可答（<500）。 */
export function waitUntilUp(url: string, timeoutMs = 120000): Promise<string> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const req = http.get(url + '/', { timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(url);
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = (): void => {
      if (Date.now() - started > timeoutMs) reject(new Error('Web UI 未在预期时间内就绪'));
      else setTimeout(tick, 300);
    };
    tick();
  });
}

/** 启动服务并加载到主窗（合并 koffi 降级 overlay）。 */
export function startAndShow(overlays: string[] = []): Promise<string> {
  // koffi 预检失败注入的目录选择器降级 overlay 一并交给 dsh web（--patch）。
  const merged: string[] = [];
  if (state.pickerBrowseOverlay && fs.existsSync(state.pickerBrowseOverlay))
    merged.push(state.pickerBrowseOverlay);
  for (const p of overlays) {
    if (typeof p === 'string' && p && fs.existsSync(p) && !merged.includes(p)) merged.push(p);
  }
  return startServer(4, merged)
    .then(waitUntilUp)
    .then((url) => {
      state.webUrl = url;
      log('boot', 'Web UI 就绪: ' + url);
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        return state.mainWindow.loadURL(url).then(() => url);
      }
      return url;
    });
}

// 守护启动（plugin-guard.js）：快照 → 拉起 → 失败则体检/修复/回滚再试，
// 仍失败落事故报告。调用方统一走这里，用户不再面对「装完插件起不来」。
export async function startAndShowGuarded(overlays: string[] = []): Promise<string> {
  const g = bridge.ensureGuard();
  // 回滚分支的重试也要能更新「最后良好」标记（restore 会留 pre-restore 快照，
  // 成功拉起后它就是最新一份 = 当前良好状态）。
  g.setRollbackLift(async () => {
    const url = await startAndShow(overlays);
    const snaps = g.listSnapshots();
    if (snaps.length && snaps[0]) g.markGood(snaps[0].id);
    return url;
  });
  return g.guardedBoot(
    () => startAndShow(overlays),
    () => '日志文件：' + path.join(state.logsDir, 'dsh-web.log'),
    // V4.2：pnpm 封锁构建脚本会让整棵 profile 起不来 —— 这是配置级问题，
    // 体检（只扫插件层）发现不了，必须走 preRetry 钩子自动放行后重试。
    // V4.4：会话目录同时存在 zstd + 明文两种编码时，会话持久化后端会抛
    // encodingMismatch 让整棵插件树起不来（Issue #77）—— 同样是体检看不到
    // 的数据层问题，一并走 preRetry 归档相反格式文件后重试。
    { preRetry: bootRescuePreRetry },
  );
}

// V4.4：守护启动 preRetry 汇聚 —— 把两类「体检看不到的数据/配置层修复」
// 合并为一次钩子调用（guardedBoot 只调用 preRetry 一次）。任一命中即返回
// 合并后的 { applied }，均未命中返回 false（走原失败链路）。
export async function bootRescuePreRetry(
  errText: string,
): Promise<{ applied: string[] } | false> {
  const applied: string[] = [];
  // 1) 会话编码冲突（Issue #77）：归档相反格式的遗留日志文件（数据无损）。
  try {
    let text = String(errText || '');
    if (!isEncodingMismatch(text)) {
      // 报错详情常只落在 dsh-web.log 里，补充解析尾部。
      try {
        text += '\n' + fs.readFileSync(path.join(state.logsDir, 'dsh-web.log'), 'utf8').slice(-40000);
      } catch {
        /* 日志缺失 */
      }
    }
    if (isEncodingMismatch(text)) {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const archived = healSessionEncodingConflicts(path.join(home, 'sessions'), {
        compression: 'zstd',
        log,
      });
      if (archived.length)
        applied.push('会话编码冲突自愈：已归档 ' + archived.length + ' 个相反格式的遗留会话日志');
    }
  } catch (err) {
    log('session-heal', 'preRetry 会话编码自愈失败: ' + String((err && (err as Error).message) || err));
  }
  // 2) pnpm allowBuilds 自动放行（原 V4.2 逻辑）。
  try {
    const ab = await allowBuildsPreRetry(errText);
    if (ab && Array.isArray(ab.applied)) applied.push(...ab.applied);
    else if (ab) applied.push('pnpm allowBuilds 自动放行');
  } catch (err) {
    log('guard', 'preRetry allowBuilds 失败: ' + String((err && (err as Error).message) || err));
  }
  return applied.length ? { applied } : false;
}

// V4.2：启动失败链的 pnpm allowBuilds 自动放行钩子（preRetry）。
// 解析错误文案 + dsh-web.log 尾部，命中被封锁的包名就写入 profile 的
// pnpm-workspace.yaml（allowBuilds / onlyBuiltDependencies），返回
// { applied } 交给守护启动合并进修复项后重试一次。
async function allowBuildsPreRetry(errText: string): Promise<{ applied: string[] } | false> {
  try {
    const ab = await allowBuilds();
    const parse = ab.parseBlockedBuildKeys;
    if (typeof parse !== 'function') return false;
    const keys = (parse(String(errText || '')) as string[]) || [];
    // 报错详情可能只落在 dsh-web.log 里，补充解析尾部。
    try {
      const tail = fs.readFileSync(path.join(state.logsDir, 'dsh-web.log'), 'utf8').slice(-40000);
      for (const k of (parse(tail) as string[]) || []) {
        if (!keys.includes(k)) keys.push(k);
      }
    } catch {
      /* 日志缺失 */
    }
    if (keys.length === 0) return false;
    const ensure = ab.ensureAllowBuilds as
      | ((file: string, keys: string[]) => Promise<{ wrote: boolean; added: string[] }>)
      | undefined;
    if (typeof ensure !== 'function') return false;
    const r = await ensure(path.join(desktopProfileDir(), 'pnpm-workspace.yaml'), keys);
    if (!r || !r.wrote) return false;
    log('guard', '[allowBuilds] 启动失败疑似 pnpm 封锁构建脚本，已自动放行: ' + r.added.join(', '));
    return { applied: ['pnpm allowBuilds 自动放行: ' + r.added.join(', ')] };
  } catch (err) {
    log('guard', '[allowBuilds] 预检失败: ' + String((err && (err as Error).message) || err));
    return false;
  }
}

/** 原地重启结果。 */
export interface RestartResult {
  ok: boolean;
  url?: string;
  error?: string;
}

// 原地重启 dsh web 服务（安装/卸载插件后生效，窗口重载到新端口）。
// V4：抽出核心逻辑，⋯ 菜单「重启 Web 服务」与托盘菜单共用（用户建议：
// 不关闭软件即可重启服务）。
export async function restartWebServiceCore(): Promise<RestartResult> {
  if (!state.serverProc || state.restartingServer) return { ok: false, error: 'not-running' };
  log('service', '请求重启 dsh web 服务');
  state.restartingServer = true;
  try {
    const oldProc = state.serverProc;
    killTree(state.serverProc);
    state.serverProc = null;
    // 等旧进程真正退出（DLL 文件锁随之释放），再执行插件市场排队任务，
    // 最后才拉起新服务 —— 排队安装正需要这个"无锁窗口"。
    await waitForProcExit(oldProc, 20000);
    await bridge.processPendingMarketOps();
    // pnpm（排队安装/卸载）会重写 profile node_modules：可能删掉配套插件
    // 副本、重新 hoist 核心包。服务拉起前重建 + 清理，顺序不能反。
    bridge.syncCompanionPlugins();
    bridge.healProfileModules();
    await bridge.restoreKeptArtifacts(desktopProfile());
    const url = await startAndShowGuarded();
    log('service', 'dsh web 服务已重启: ' + url);
    return { ok: true, url };
  } catch (err) {
    log('service', '重启失败: ' + String((err && (err as Error).message) || err));
    return { ok: false, error: String((err && (err as Error).message) || err) };
  } finally {
    state.restartingServer = false;
  }
}

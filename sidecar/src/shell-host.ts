// shell-host.ts — Tauri 壳的 Node sidecar 入口（stdio 行式 JSON-RPC 服务）。
// 忠实移植自仓库根 shell-host.js。
//
// 协议：
//   请求  {"id":N,"method":"ns.fn","params":{...}}
//   响应  {"id":N,"ok":true,"result":...} | {"id":N,"ok":false,"error":"..."}
//   事件  {"event":"log","tag":..,"msg":..} | {"event":"notify",..}
//         | {"event":"balance","data":..}   （无 id，壳层单向消费）
//
// 职责只有三件事：解析 argv、装配 desktop-core、按方法表分发 RPC。
// 全部业务在 desktop-core（可单测）；本文件不写业务逻辑。

import path from 'node:path';
import fs from 'node:fs';
import { createDesktopCore } from './desktop-core';
import type { UpdaterCtx } from './lib/updater';

/// desktop-core 装配结果的最小结构面（完整类型由 desktop-core 模块承载）。
export interface DesktopCoreLike {
  upgradePreflight: () => Promise<{ ok: true }> | { ok: true };
  migrateAndSync: () => Promise<unknown> | unknown;
  syncAll: () => Promise<unknown> | unknown;
  koffiPreflight: () => Promise<unknown> | unknown;
  guardAction: (p: unknown) => Promise<unknown> | unknown;
  ensureGuard: () => {
    snapshot: (reason: string) => unknown;
    markGood: (id: unknown) => void;
    healthCheck: () => unknown;
    repair: (findings: unknown) => unknown;
    lastGoodSnapshot: () => unknown;
    restore: (id: unknown) => unknown;
    listSnapshots: () => unknown;
    reportIncident: (title: unknown, detail: unknown) => unknown;
  };
  junctionTick: () => Promise<unknown> | unknown;
  guardAllowBuildsPreRetry: (p: unknown) => Promise<unknown> | unknown;
  pluginManagerCollect: () => Promise<unknown> | unknown;
  pluginManagerSetEnabled: (id: unknown, enabled: boolean) => Promise<unknown> | unknown;
  pluginManagerSetRemoved: (id: string, removed: boolean) => Promise<unknown> | unknown;
  updatesCheck: (p: unknown) => Promise<unknown> | unknown;
  updatesList: (p: unknown) => Promise<unknown> | unknown;
  updatesUpdateOne: (p: unknown) => Promise<unknown> | unknown;
  updatesSetAutoUpdate: (p: unknown) => Promise<unknown> | unknown;
  refreshBalance: () => Promise<unknown>;
  balancePricesGet: (model: unknown) => Promise<unknown> | unknown;
  balancePricesSet: (model: unknown, prices: unknown) => { ok: boolean };
  balancePricesReset: (model: unknown) => { ok: boolean };
  desktopProfile: () => string;
  confirmHealthyOverlay: () => boolean;
}

export interface DesktopCoreInput {
  appRoot: string;
  userDataDir: string;
  logsDir: string;
  dshHome: string;
  nodeExe: () => string;
  npmCli: () => string;
  log: (tag: string, msg: string) => void;
  notify: (title: string, body: string) => void;
}

type RpcHandler = (params: any) => Promise<unknown> | unknown;

function argOf(name: string, fallback: string): string {
  const eq = '--' + name + '=';
  const hit = process.argv.find((a) => a.startsWith(eq));
  if (hit) return hit.slice(eq.length);
  // 兼容空格分隔形式（Rust 侧 Command::arg 的传法）：--name value
  const idx = process.argv.indexOf('--' + name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1] as string;
  return fallback;
}

const appRoot = argOf('app-root', __dirname);
const userDataDir = argOf('user-data', '');
const logsDir = argOf('logs-dir', '');
const dshHome = argOf('dsh-home', '');

if (!userDataDir || !logsDir || !dshHome) {
  process.stderr.write('[shell-host] missing required args: user-data/logs-dir/dsh-home\n');
  process.exit(1);
}

/// RPC 写出：单行 JSON + \n。stdout 只承载协议流量。
function send(obj: unknown): void {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    // 管道断了（壳已退出）：静默退出。
    process.exit(0);
  }
}

// 内置运行时定位：打包布局 <resource>/app 与 <resource>/node|npm 平级；
// dev 布局：仓库根下 vendor/。两种位置统一探测。
const NODE_EXE =
  [path.join(appRoot, '..', 'node', 'node.exe'), path.join(appRoot, 'vendor', 'node', 'node.exe')].find((p) =>
    fs.existsSync(p),
  ) || path.join(appRoot, 'vendor', 'node', 'node.exe');
const NPM_CLI =
  [path.join(appRoot, '..', 'npm', 'bin', 'npm-cli.js'), path.join(appRoot, 'vendor', 'npm', 'bin', 'npm-cli.js')].find(
    (p) => fs.existsSync(p),
  ) || path.join(appRoot, 'vendor', 'npm', 'bin', 'npm-cli.js');

const rpcLog = (tag: string, msg: string): void => send({ event: 'log', tag, msg });
const settingsCtx: UpdaterCtx = {
  userDataDir,
  nodeExe: () => NODE_EXE,
  npmCli: () => NPM_CLI,
  log: (m) => rpcLog('update', m),
};

const core = createDesktopCore({
  appRoot,
  userDataDir,
  logsDir,
  dshHome,
  nodeExe: () => NODE_EXE,
  npmCli: () => NPM_CLI,
  log: rpcLog,
  notify: (title: string, body: string) => send({ event: 'notify', title, body }),
}) as DesktopCoreLike;

async function refreshBalanceAndEmit(): Promise<unknown> {
  const result = await core.refreshBalance();
  send({ event: 'balance', data: result });
  return result;
}

// 方法表：ns.fn → handler(params)。全部 async 化以便统一错误处理。
const METHODS: Record<string, RpcHandler> = {
  // ---- profile 编排 ----
  'profile.upgradePreflight': () => core.upgradePreflight(),
  'profile.migrateAndSync': (_p) => core.migrateAndSync(),
  'profile.syncAll': (_p) => core.syncAll(),

  // ---- koffi 预检 ----
  'koffi.preflight': (_p) => core.koffiPreflight(),

  // ---- 保护中心 ----
  'guard.action': (p) => core.guardAction(p),
  'guard.snapshot': ({ reason } = {} as any) => core.ensureGuard().snapshot(String(reason || 'manual')),
  'guard.markGood': ({ id } = {} as any) => {
    core.ensureGuard().markGood(id);
    return { ok: true };
  },
  'guard.healthCheck': () => core.ensureGuard().healthCheck(),
  'guard.repair': ({ findings } = {} as any) => core.ensureGuard().repair(findings),
  'guard.lastGood': () => core.ensureGuard().lastGoodSnapshot(),
  'guard.restore': ({ id } = {} as any) => core.ensureGuard().restore(id),
  'guard.listSnapshots': () => core.ensureGuard().listSnapshots(),
  'guard.reportIncident': ({ title, detail } = {} as any) => core.ensureGuard().reportIncident(title, detail),
  'guard.junctionTick': () => core.junctionTick(),
  'guard.allowBuildsPreRetry': (p) => core.guardAllowBuildsPreRetry(p),

  // ---- 插件管理 / 更新 ----
  'plugin.list': () => core.pluginManagerCollect(),
  'plugin.setEnabled': ({ id, enabled } = {} as any) => core.pluginManagerSetEnabled(id, !!enabled),
  'plugin.setRemoved': ({ id, removed } = {} as any) => core.pluginManagerSetRemoved(String(id), !!removed),
  'updates.check': (p) => core.updatesCheck(p),
  'updates.list': (p) => core.updatesList(p),
  'updates.updateOne': (p) => core.updatesUpdateOne(p),
  'updates.setAutoUpdate': (p) => core.updatesSetAutoUpdate(p),

  // ---- 余额 ----
  'balance.refresh': () => refreshBalanceAndEmit(),
  'balance.pricesGet': ({ model } = {} as any) => core.balancePricesGet(model),
  'balance.pricesSet': ({ model, prices } = {} as any) => {
    const r = core.balancePricesSet(model, prices);
    if (r.ok) refreshBalanceAndEmit().catch(() => {}); // 保存后立即重推
    return r;
  },
  'balance.pricesReset': ({ model } = {} as any) => {
    const r = core.balancePricesReset(model);
    if (r.ok) refreshBalanceAndEmit().catch(() => {});
    return r;
  },

  // ---- updater（启动失败对话框链用）----
  'updater.previousAgentInfo': () => require('./lib/updater').previousAgentInfo(settingsCtx),
  'updater.rollbackToPrevious': () => require('./lib/updater').rollbackToPrevious(settingsCtx),
  'updater.rollback': () => require('./lib/updater').rollback(settingsCtx),
  'updater.confirmHealthy': () => core.confirmHealthyOverlay(),
};

// 心跳保活：stdin EOF 即退出（壳退出时关闭管道 → sidecar 自然收场）。
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
process.on('uncaughtException', (err) => {
  send({ event: 'log', tag: 'sidecar', msg: '未捕获异常: ' + String((err && err.stack) || err) });
});

let nextId = 0; // 请求 id 由壳分配，这里仅回显。

interface RpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

async function dispatch(msg: RpcRequest): Promise<void> {
  const id = Number.isFinite(msg.id as number) ? (msg.id as number) : ++nextId;
  const method = METHODS[msg.method as string];
  if (!method) {
    send({ id, ok: false, error: '未知方法: ' + String(msg.method) });
    return;
  }
  try {
    const result = await method(msg.params || {});
    send({ id, ok: true, result: result === undefined ? null : result });
  } catch (err) {
    send({ id, ok: false, error: String((err instanceof Error && err.message) || err) });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: RpcRequest;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      send({ event: 'log', tag: 'sidecar', msg: '无法解析请求行: ' + (err instanceof Error ? err.message : String(err)) });
      continue;
    }
    dispatch(msg);
  }
});

send({ event: 'log', tag: 'sidecar', msg: `shell-host ready appRoot=${appRoot} profile=${core.desktopProfile()}` });

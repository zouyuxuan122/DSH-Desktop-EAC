'use strict';

// L2 Node sidecar 实体化（ADR 0002；T3-a 第二阶段）。
// 职责：
//   1. stdio 行分隔 JSON-RPC 分发器（协议与 ping.js 一致，Rust L1 唯一对话面）
//   2. 挂载 dsh-desktop/lib/desktop/* 全部 13 个模块（ctx 注入按宿主语义提供）
//   3. 白名单方法注册表
//
// 纪律：stdout 只走协议帧；一切日志/兜底输出走 stderr。

import path = require('node:path');
import os = require('node:os');
import fs = require('node:fs');
import cp = require('node:child_process');
import readline = require('node:readline');

// 资源根：开发态 tauri-shell/sidecar → 仓库根/dsh-desktop；
// 打包态 resources/sidecar → resources/dsh-desktop（少一级）。
function resolveDesktopRoot(): string {
  const upTwo = path.resolve(__dirname, '..', '..', 'dsh-desktop');
  if (fs.existsSync(path.join(upTwo, 'package.json'))) return upTwo;
  const upOne = path.resolve(__dirname, '..', 'dsh-desktop');
  if (fs.existsSync(path.join(upOne, 'package.json'))) return upOne;
  return upTwo;
}
const DSH_DESKTOP_ROOT = process.env.DSH_RESOURCE_ROOT
  ? path.join(process.env.DSH_RESOURCE_ROOT, 'dsh-desktop')
  : resolveDesktopRoot();
const LIB = (m: string): string => path.join(DSH_DESKTOP_ROOT, 'lib', 'desktop', m);

function say(s: string): void { process.stderr.write('[sidecar] ' + s + '\n'); }

// ---- 宿主语义（对齐 Electron main.js 的注入值） --------------------------
const log = (tag: string, msg: string): void => say('[' + tag + '] ' + msg);

let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(DSH_DESKTOP_ROOT, 'package.json'), 'utf8')).version || pkgVersion;
} catch { /* 保持缺省 */ }

type Mod = { init: (d: unknown) => void } & Record<string, unknown>;
const mount = (name: string): Mod => require(LIB(name)) as Mod;

const procMod = mount('proc');
const platformMod = mount('platform') as Mod & {
  createDesktopPlatform(): {
    userDataDir(): string;
    capabilities(): Record<string, unknown>;
  };
  pluginCapabilityDetails(platform?: NodeJS.Platform): Record<string, { status: string; reason: string }>;
};
const desktopPlatform = platformMod.createDesktopPlatform();
const userDataDir = desktopPlatform.userDataDir();
const appDataDir = path.dirname(userDataDir);
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const pathsMod = mount('runtime-paths');
const profileMod = mount('profile');
const guardBoxMod = mount('guard-box');
const runtimePatchesMod = mount('runtime-patches');
const companionSyncMod = mount('companion-sync');
const pluginOpsMod = mount('plugin-ops');
const marketMod = mount('market');
const shortcutsMod = mount('shortcuts');
const junctionPatrolMod = mount('junction-patrol');
const clientUpdateMod = mount('client-update');
const previewMod = mount('static-preview');
const fileRootsMod = mount('file-roots');
const bootMod = mount('boot-server');

const MOUNTED = ['proc', 'platform', 'runtime-paths', 'profile', 'guard-box', 'runtime-patches', 'companion-sync', 'plugin-ops', 'market', 'shortcuts', 'junction-patrol', 'client-update', 'static-preview', 'file-roots', 'boot-server'];

// 打包态判定 + 资源根：Rust 壳 spawn sidecar 时注入 DSH_SHELL_EXE /
// DSH_RESOURCE_ROOT（main.rs Sidecar::spawn）。DSH_RESOURCE_ROOT 存在即打包态；
// 开发态两者缺省 → isPackaged=false（快捷方式/完整性校验等打包态功能自动跳过）。
function isPackagedRuntime(): boolean {
  return Boolean(process.env.DSH_RESOURCE_ROOT);
}
function resourceRoot(): string {
  return process.env.DSH_RESOURCE_ROOT || '';
}

// ---- vnext 隔离体系（vnext-absorb Phase 2）：supervisor / extension-host / 恢复中心 ----
// 这些模块位于 lib/{state,log,supervisor,extension-host,recovery-center}，
// 不走 lib/desktop 的 mount 通道，按绝对路径 require（编译产物 .js）。
const vnextState = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'state.js')) as {
  initVNextState(d: { dshHome?: string; userDataDir?: string; logsDir?: string }): void;
  state: { eacBridge: { url: string; token: string; close(): void } | null; restartingServer: boolean };
};
const supervisorInstaller = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'supervisor', 'installer.js')) as {
  sweepInstallerResidue(keep?: number): { staging: number; trash: number; rollback: number };
};
const vnextLog = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'log.js')) as {
  setLogSink(fn: ((tag: string, msg: string) => void) | null): void;
};
const recoveryCenter = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'recovery-center', 'register.js')) as {
  init(d: {
    appVersion: string;
    profile: string;
    restartWebService(): Promise<{ ok: boolean; url?: string; error?: string }>;
    requestSafeModeRelaunch(): void;
  }): void;
  handleRcAction(action: string, value?: unknown): Promise<Record<string, unknown>>;
  archivePluginProfiles(): void;
};
const extHost = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'extension-host', 'manager.js')) as {
  ensureBundledSdkPlugins(): void;
  startEnabledExtensionHosts(): Promise<void>;
  shutdownExtensionHosts(): Promise<void>;
  getExtensionHostManager(): unknown;
};
const bridgeServer = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'extension-host', 'bridge-server.js')) as {
  startExtensionBridgeServer(manager: unknown): Promise<{ url: string; token: string; close(): void }>;
};
// 旧 credentials-format-heal（versioned→flat 反向迁移）已删除：0.1.2 内核
// credentials-local 只认 version:1 + refs:/records: 版式，扁平版式会被拒启
//（"uses the pre-release flat layout"）。正向自愈见 boot-server 的
// healCredentialsVersion（引号 version 规整 + 扁平→versioned 迁移）。

// ---- ctx 注入（与 main.js 注入块逐项对齐；GUI 类能力走兜底/委托） --------
const desktopProfileFn = profileMod.desktopProfile as () => string;
const showBoxFallback = async (opts: Record<string, unknown>) => {
  say('[dialog] ' + String((opts && opts.title) || '') + ': ' + String((opts && opts.message) || ''));
  // 无头兜底答 cancelId（fail-closed）：绝不自动应答「立即更新/立即重启」，
  // 否则周期检查会无人值守地杀服务换 exe 退出（5.3.0 前的隐性自动更新）。
  // 纯提示框（['确定']）没有 cancelId 也不分支读 response，回 0 占位。
  const cancelId = opts && (opts.cancelId as number);
  return { response: Number.isInteger(cancelId) ? cancelId : 0 };
};
const notifyFallback = (n: { title: string; body: string }): void => {
  say('[notify] ' + n.title + ': ' + n.body);
  notify('shell.system-notification', { title: n.title, body: n.body });
};
// .lnk 驱动（硬门槛④）：PowerShell WScript.Shell COM 实现，接口对齐 Electron
// shell.readShortcutLink / writeShortcutLink（失败抛错）。路径经环境变量传入，
// 规避引号/空格/中文转义；读取返回的 IconLocation 剥掉 ',N' 索引。
// ⚠️ 全异步（execFile）：旧同步版（execFileSync/spawnSync 逐文件起 PowerShell）
// 是真实桌面 boot 后事件循环冻结的主源 —— 桌面 N 个 .lnk × 每个 1-3s 同步
// 阻塞，用户在 boot 后点「开始配对」的 RPC 全排在后面（5.3.5 复现实测）。

function psLnkWrite(p: string, op: string, opts: Record<string, unknown>): Promise<void> {
  const script = String.raw`
$ErrorActionPreference='Stop'
$lnk = $env:DSH_LNK_PATH
if (($env:DSH_LNK_OP -eq 'create') -and (Test-Path -LiteralPath $lnk)) { exit 2 }
try {
  $sh = New-Object -ComObject WScript.Shell
  $sc = $sh.CreateShortcut($lnk)
  $sc.TargetPath = $env:DSH_LNK_TARGET
  if ($env:DSH_LNK_ARGS) { $sc.Arguments = $env:DSH_LNK_ARGS }
  if ($env:DSH_LNK_CWD) { $sc.WorkingDirectory = $env:DSH_LNK_CWD }
  if ($env:DSH_LNK_DESC) { $sc.Description = $env:DSH_LNK_DESC }
  if ($env:DSH_LNK_ICON) { $sc.IconLocation = $env:DSH_LNK_ICON }
  $sc.Save()
  exit 0
} catch { exit 1 }
`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_LNK_PATH: p,
    DSH_LNK_OP: String(op || 'replace'),
    DSH_LNK_TARGET: String(opts.target || ''),
    DSH_LNK_ARGS: opts.args == null ? '' : String(opts.args),
    DSH_LNK_CWD: opts.cwd == null ? '' : String(opts.cwd),
    DSH_LNK_DESC: opts.description == null ? '' : String(opts.description),
    DSH_LNK_ICON: opts.icon == null ? '' : String(opts.icon),
  };
  // 异步（execFile）：spawnSync 会整段冻结 sidecar 事件循环（boot 后用户
  // 点「开始配对」正好撞在这串同步 PowerShell 上 —— 5.3.5 复现实测）。
  return new Promise<void>((resolve, reject) => {
    cp.execFile('powershell', ['-NoProfile', '-Command', script], { env, windowsHide: true, timeout: 10000 }, (err) => {
      if (err) reject(new Error('lnk ' + String(op) + ' failed (' + String((err as { code?: unknown }).code) + '): ' + p));
      else resolve();
    });
  });
}

// 批量读 .lnk：桌面/开始菜单逐个起 PowerShell（每个 1-3s 同步阻塞）是真实
// 机器 boot 后事件循环冻结的主源 —— N 个图标一次 PowerShell 进程读完，
// JSONL 逐行回（行序与输入路径序一致，失败行 '{}' 兜底）。整批失败按全部
// 读不出处理（与逐个 readLnkSafe 的「读不到 = null」语义一致）。
async function psLnkReadBatchAsync(paths: string[]): Promise<(Record<string, unknown> | null)[]> {
  if (!paths.length) return [];
  const script = String.raw`
$ErrorActionPreference='Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sh = New-Object -ComObject WScript.Shell
Get-Content -LiteralPath $env:DSH_LNK_LIST -Encoding UTF8 | ForEach-Object {
  $p = $_
  try {
    $sc = $sh.CreateShortcut($p)
    $icon = [string]$sc.IconLocation
    if ($icon -match ',\s*\d+$') { $icon = $icon -replace ',\s*\d+$', '' }
    @{ target = [string]$sc.TargetPath; args = [string]$sc.Arguments; cwd = [string]$sc.WorkingDirectory; description = [string]$sc.Description; icon = $icon } | ConvertTo-Json -Compress
  } catch { '{}' }
}
`;
  // 路径清单走临时文件（环境变量有长度上限；逐行无引号转义坑）。
  const listFile = path.join(os.tmpdir(), `dsh-lnklist-${process.pid}-${Date.now()}.txt`);
  await fs.promises.writeFile(listFile, paths.join('\n'), 'utf8');
  try {
    const stdout: string = await new Promise((resolve, reject) => {
      cp.execFile('powershell', ['-NoProfile', '-Command', script], {
        env: { ...process.env, DSH_LNK_LIST: listFile },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
      }, (err, out) => { if (err) reject(err); else resolve(String(out ?? '')); });
    });
    const lines = stdout.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    const out: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < paths.length; i++) {
      const line = lines[i];
      if (!line) { out.push(null); continue; }
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        out.push(rec && rec.target ? rec : null); // 读不出 target 视为坏链接
      } catch { out.push(null); }
    }
    return out;
  } catch {
    return paths.map(() => null);
  } finally {
    try { await fs.promises.rm(listFile, { force: true }); } catch { /* noop */ }
  }
}

function psLnkRead(p: string): Promise<Record<string, unknown>> {
  return psLnkReadBatchAsync([p]).then(([rec]) => {
    if (!rec) throw new Error('lnk read failed: ' + p);
    return rec;
  });
}

procMod.init({ log, getDshHome: () => dshHome, getDesktopProfile: desktopProfileFn });
pathsMod.init({ log, getUserDataDir: () => userDataDir, isPackaged: () => isPackagedRuntime(), resourcesPath: () => resourceRoot(), platform: process.platform });
profileMod.init({ log, getDshHome: () => dshHome });
guardBoxMod.init({
  log,
  getDshHome: () => dshHome,
  getDesktopProfile: desktopProfileFn,
  getDshBin: () => (pathsMod.dshBin as () => string)(),
});
runtimePatchesMod.init({ log, getDshHome: () => dshHome, getUserDataDir: () => userDataDir });
shortcutsMod.init({
  log,
  showBox: showBoxFallback,
  getUserDataDir: () => userDataDir,
  getDshHome: () => dshHome,
  isPackaged: isPackagedRuntime,
  systemPath: (kind: string) => (kind === 'appData' ? appDataDir : kind === 'desktop' ? path.join(os.homedir(), 'Desktop') : ''),
  links: { read: psLnkRead, write: psLnkWrite, readAll: psLnkReadBatchAsync },
});
junctionPatrolMod.init({
  log,
  isQuitting: () => quitting,
  // 真实接线（5.3.3 批次 D）：此前是硬编码桩（isRestartingServer 恒 false、
  // getServerProc 恒 null）——直接按桩启动 watchdog 会把桌面端自己的 dsh web
  // 判成「外部 dsh」，修复被永久搁置。透传 boot-server 的真实状态。
  isRestartingServer: () => vnextState.state.restartingServer === true,
  getServerProc: () => {
    const proc = (bootMod.getServerProc as () => { pid?: number } | null)();
    return proc && proc.pid ? { pid: proc.pid } : null;
  },
  showMainWindow: () => { notify('shell.show-main-window', {}); },
  notify: notifyFallback,
});
// /update 进度页开关状态（showUpdateWindow/destroy 维护）。
let updateWindowOpen = false;
clientUpdateMod.init({
  log,
  showBox: showBoxFallback,
  getPlatform: () => process.platform,
  openExternal: async (url: string) => {
    notify('shell.open-external', { url });
    return true;
  },
  isQuitting: () => quitting,
  getAppVersion: () => pkgVersion,
  getUserDataDir: () => userDataDir,
  getDshHome: () => dshHome,
  // 更新进度窗 = 壳层 /update 页（boot.server-died 同款「通知 → 壳导航」模式）。
  // 返回句柄只维护 isDestroyed/destroy 语义，供流程 finally 清理。
  showUpdateWindow: (version: string, kind: string) => {
    updateWindowOpen = true;
    notify('client-update.show', { version: version || '', kind: kind || 'client' });
    return {
      isDestroyed: () => !updateWindowOpen,
      destroy: () => {
        if (updateWindowOpen) {
          updateWindowOpen = false;
          notify('client-update.hide', {});
        }
      },
    };
  },
  // 进度推送 → WS 广播（/update 页经 _onNotify 渲染）。
  makeUpdateProgressPusher: () => ({
    client: (received: number, total: number, meta?: unknown) =>
      notify('client-update.progress', Object.assign({ channel: 'client', received: received, total: total }, meta && typeof meta === 'object' ? meta : {})),
    agent: (stage: string) => notify('client-update.progress', { channel: 'agent', stage: stage }),
    force: (m: unknown) => notify('client-update.progress', Object.assign({ channel: 'force' }, m && typeof m === 'object' ? m : {})),
  }),
  // 更新交接前有界关停 dsh web（= Electron prepareQuitForClientUpdate 的服务面）。
  prepareQuitForClientUpdate: async () => {
    say('prepareQuitForClientUpdate: 关停 dsh web');
    try { await (bootMod.stopServer as () => Promise<void>)(); } catch (e) { say('关停失败（继续交接）: ' + String(((e as Error).message) || e)); }
  },
  // 更新交接后的「退出进程」= 壳整体优雅退出（ExitRequested 有界收口
  // sidecar/dsh web）。不在 sidecar 直接 process.exit：通知帧可能未冲刷即截断。
  exitProcess: () => { notify('shell.quit-for-update', {}); },
  // 打包态取壳层 exe 目录（DSH_SHELL_EXE）；开发态 sidecar 的 node 不适用。
  getExecDir: () => (process.env.DSH_SHELL_EXE ? path.dirname(process.env.DSH_SHELL_EXE) : path.dirname(process.execPath)),
});
previewMod.init({
  log, showBox: showBoxFallback, exitDamaged: () => process.exit(1), isPackaged: isPackagedRuntime, resourcesPath: () => resourceRoot(),
  // 预览静态服务围栏：白名单 = 会话 cwd（fileRoots）+ skills 根；.credentials*
  // 一律拒绝。此前接受任意绝对路径，等于把全盘任意文件读原语交给知道
  // staticPort 的页面（该端口经 chrome.init 主动下发）。
  fence: (p: string): boolean => {
    try {
      // NTFS 8.3 短名别名绕过：.credentials-probe-zz.yaml 的短名 CREDEN~1.YAM
      // 不匹配 dotfile 拒绝模式，且 realpath 不展开短名（实测）。短名形态
      // （~N）时经目录枚举 + dev/ino 比对还原真实长名，再对长名做判定 ——
      // 无 Win32 API 依赖，合法 ~N 文件名（ino 指向自身）不误伤。
      let judge = path.basename(p);
      if (/~\d/.test(judge)) {
        try {
          const want = fs.statSync(p);
          const parent = path.dirname(p);
          for (const entry of fs.readdirSync(parent)) {
            try {
              const st = fs.statSync(path.join(parent, entry));
              if (st.dev === want.dev && st.ino === want.ino) { judge = entry; break; }
            } catch { /* 逐项尽力 */ }
          }
        } catch { /* 还原失败保持原名判定（后续 stat 同样会失败，fail-closed） */ }
      }
      if (/^\.credentials/i.test(judge)) return false;
      if ((fileRootsMod.isUnderFileRoots as (x: string) => boolean)(p)) return true;
      const lower = (x: string): string => (process.platform === 'win32' ? x.toLowerCase() : x);
      const fpL = lower(fs.realpathSync(p));
      const skillsRoots = [
        path.join(home(), 'skills'),
        path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'),
      ].map((r) => lower(path.resolve(r)));
      return skillsRoots.some((r) => fpL === r || fpL.startsWith(r + path.sep));
    } catch { return false; }
  },
});
marketMod.init({ log, getDshHome: () => dshHome, getUserDataDir: () => userDataDir });
pluginOpsMod.init({ log });
companionSyncMod.init({
  log,
  getDshHome: () => dshHome,
  getUserDataDir: () => userDataDir,
  applyLegacySkinChoice: () => (shortcutsMod.applyLegacySkinChoice as () => void)(),
  showMainWindow: () => say('showMainWindow (host-delegated)'),
  notify: notifyFallback,
  platform: process.platform,
});

// ---- boot-server（P2：dsh web 服务编排） --------------------------------
// settings 兼容层：与 updater.js 的 userData/settings.json 同文件同语义
// （load 回退 {}，save 2 空格缩进 + 尾换行），端号偏好双壳共享。
let quitting = false;

// 当前内核 Web 服务地址（手机桥 RPC 转发用）。boot.start / boot.restart
// 成功后更新，服务停止时清空。
let currentWebInfo: { webUrl: string; port: number } | null = null;

// 手机连接桥（5.1.1：LAN 配对 + 白名单 RPC + 手机端占位页，见 phone-bridge.ts）。
const phoneBridgeMod = require('./phone-bridge.js') as {
  createPhoneBridge(options: {
    getWebUrl: () => string | null;
    log: (message: string) => void;
    sessionFile: string;
  }): {
    start(): Promise<{ url: string; port: number }>;
    stop(): Promise<void>;
    status(): { running: boolean; port: number; lanUrl: string; mobileReady: boolean; pairing: { state: string; expiresAt: number | null } };
    decide(approved: boolean): { ok: boolean; error?: string };
    disconnect(): { ok: boolean };
  };
};
const phoneBridge = phoneBridgeMod.createPhoneBridge({
  getWebUrl: () => (currentWebInfo ? currentWebInfo.webUrl : null),
  log: (m) => say(m),
  sessionFile: path.join(userDataDir, 'phone-bridge-session.json'),
});
function handlePhoneMethod(method: string, p: RpcParams): RpcResult | Promise<RpcResult> {
  if (method === 'phone.start') return phoneBridge.start().then((r) => ({ ok: true, ...r }));
  if (method === 'phone.stop') return phoneBridge.stop().then(() => ({ ok: true }));
  if (method === 'phone.status') return { ok: true, ...phoneBridge.status() };
  if (method === 'phone.decide') return phoneBridge.decide(p?.approved === true) as RpcResult;
  if (method === 'phone.disconnect') return phoneBridge.disconnect() as RpcResult;
  return { ok: false, error: 'unknown phone method' };
}

const settingsFile = path.join(userDataDir, 'settings.json');
const { readJsonFile } = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'plugin-copy.js')) as {
  readJsonFile(file: string): Record<string, unknown> | null;
};
const { writeJsonAtomic } = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'atomic-json.js')) as {
  writeJsonAtomic(file: string, value: unknown): void;
};
function loadSettings(): Record<string, unknown> {
  return readJsonFile(settingsFile) ?? {};
}
function saveSettings(s: Record<string, unknown>): void {
  try { writeJsonAtomic(settingsFile, s); } catch (e) { say('保存 settings 失败: ' + String(e)); }
}

/** 无 id 的 JSON-RPC 通知帧（Rust 侧经 WS 广播给页面，并自行订阅壳层事件）。 */
function notify(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params: params == null ? {} : params }) + '\n');
}

// 全局兜底：sidecar 裸崩 = 整壳失去桥能力（页面卡死/恢复中心失效）。
// unhandledRejection 记日志继续跑（主线 Promise 均已 guard，这兜的是 lib
// 深处漏网的）；uncaughtException 记日志后退场 —— 壳层 reader 会立即回绝
// 在途调用并广播 boot.server-died 走 /died 恢复链，好过无声僵死。
process.on('unhandledRejection', (reason) => {
  log('fatal', 'unhandledRejection: ' + String((reason instanceof Error ? reason.stack : reason) || reason));
});
process.on('uncaughtException', (err) => {
  try { log('fatal', 'uncaughtException: ' + String(err && err.stack || err)); } catch { /* 尽力而为 */ }
  process.exit(1);
});

bootMod.init({
  log,
  getUserDataDir: () => userDataDir,
  getDesktopProfile: desktopProfileFn,
  desktopProfileDir: () => (profileMod.desktopProfileDir as () => string)(),
  nodeExe: () => (pathsMod.nodeExe as () => string)(),
  dshBin: () => (pathsMod.dshBin as () => string)(),
  loadSettings,
  saveSettings,
  isQuitting: () => quitting,
  onServerDied: (info: unknown) => {
    currentWebInfo = null;
    notify('boot.server-died', info);
  },
});

say('modules mounted; dshHome=' + dshHome + '; profile=' + desktopProfileFn());

// ---- SessionWatcher（5.3.3 批次 D 接线，= Electron main.js onSessionTurnEnd）----
// 会话任务完成通知：2s 轮询 <dshHome>/sessions 的 zstd 日志，turn/end 时经
// 壳层系统通知提醒（notifyOnTurnEnd 设置项控制，同会话 30s 限频）。
const sessionWatcherMod = require(path.join(DSH_DESKTOP_ROOT, 'session-watcher.js')) as {
  SessionWatcher: new (opts: {
    sessionsDir: string;
    log: (tag: string, msg: string) => void;
    onTurnEnd: (info: { sessionId: string; title?: string; body?: string }) => void;
  }) => { start(): void; stop(): void };
};
let sessionWatcher: { start(): void; stop(): void } | null = null;
const turnEndNotifyAt = new Map<string, number>();
function startSessionWatcher(): void {
  if (sessionWatcher) return;
  try {
    const s = loadSettings() as { notifyOnTurnEnd?: boolean };
    if (s.notifyOnTurnEnd === false) return;
    sessionWatcher = new sessionWatcherMod.SessionWatcher({
      sessionsDir: path.join(dshHome, 'sessions'),
      log,
      onTurnEnd: (info) => {
        if (quitting) return;
        const now = Date.now();
        const last = turnEndNotifyAt.get(info.sessionId) || 0;
        if (now - last < 30000) return; // 同会话至多一条 toast / 30s
        // sidecar 与壳同生命周期：会话数按月累积，Map 从不清理就是慢速泄漏。
        // 超限先淘汰最旧一半（时间戳序），限频语义不受影响。
        if (turnEndNotifyAt.size >= 500) {
          const oldest = [...turnEndNotifyAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 250);
          for (const [k] of oldest) turnEndNotifyAt.delete(k);
        }
        turnEndNotifyAt.set(info.sessionId, now);
        notifyFallback({
          title: info.title || 'DSH 任务完成',
          body: info.body || '会话任务已完成',
        });
      },
    });
    sessionWatcher.start();
  } catch (e) {
    say('SessionWatcher 启动失败（不影响主流程）: ' + String(((e as Error).message) || e));
  }
}

// ---- vnext 初始化：日志 sink + 共享状态 + 恢复中心 ctx ----------------------
vnextLog.setLogSink(log);
vnextState.initVNextState({ dshHome, userDataDir, logsDir: path.join(userDataDir, 'logs') });

// 前置文件树准备：旧凭据格式迁移 → 市场排队 → 退役清理 → 配套插件/技能
// 同步 → 模块遮蔽修复 → 构建产物回填。boot.start 与重启/恢复中心
// retry-boot 共用。
async function preBootSync(): Promise<void> {
  // （旧 credentials-format-heal 反向迁移已删除，见文件头部说明）
  await (marketMod.processPendingMarketOps as () => Promise<void>)();
  (companionSyncMod.retireRemovedBuiltinPluginsGated as (dir: string) => void)((profileMod.desktopProfileDir as () => string)());
  (companionSyncMod.syncCompanionPlugins as () => void)();
  (marketMod.syncBundledSkills as () => void)();
  (companionSyncMod.healProfileModules as () => void)();
  try {
    const swept = supervisorInstaller.sweepInstallerResidue();
    if (swept.staging || swept.trash || swept.rollback) {
      say(`已清扫 SDK 插件安装残留：.staging×${swept.staging}、.trash×${swept.trash}、.rollback×${swept.rollback}`);
    }
  } catch (e) {
    say('安装残留清扫失败（不影响启动）: ' + String(((e as Error).message) || e));
  }
  await (marketMod.restoreKeptArtifacts as (profile: string) => Promise<void>)(desktopProfileFn());
}

// 原地重启（= main.js restartWebServiceCore）：无锁窗口内消费市场排队 →
// 同步配套插件 → 修复模块遮蔽 → 恢复保留产物 → 重新拉起。boot.restart 与
// 恢复中心的 retry-boot 共用；服务未在运行（恢复中心直开模式）时走 boot.start
// 同款前置链直接拉起。
async function restartWebServiceCore(): Promise<{ ok: boolean; webUrl?: string; port?: number; error?: string }> {
  const running = (bootMod.state as () => { running: boolean })().running;
  (bootMod.setIsRestarting as (v: boolean) => void)(true);
  // 5.3.3 接线：boot-server 的模块私有重启标志同步写共享 state —— 恢复中心
  // 的重启竞态护栏（safeModeEnable 等：running && !restartingServer 才放行）
  // 此前读到的是恒 false 的死字段，护栏从未生效。
  vnextState.state.restartingServer = true;
  try {
    if (!running) {
      log('service', '请求启动 dsh web 服务（未在运行）');
      await preBootSync();
      const r = await guardedStartAndWait([]);
      log('service', 'dsh web 服务已启动: ' + r.webUrl);
      currentWebInfo = { webUrl: r.webUrl, port: r.port };

      notify('boot.web-ready', r);
      return { ok: true, webUrl: r.webUrl, port: r.port };
    }
    log('service', '请求重启 dsh web 服务');
    await (bootMod.killAndWaitForRestart as () => Promise<void>)();
    await (marketMod.processPendingMarketOps as () => Promise<void>)();
    (companionSyncMod.syncCompanionPlugins as () => void)();
    (companionSyncMod.healProfileModules as () => void)();
    await (marketMod.restoreKeptArtifacts as (profile: string) => Promise<void>)(desktopProfileFn());
    const r = await guardedStartAndWait([]);
    log('service', 'dsh web 服务已重启: ' + r.webUrl);
    currentWebInfo = { webUrl: r.webUrl, port: r.port };

    notify('boot.web-ready', r);
    return { ok: true, webUrl: r.webUrl, port: r.port };
  } catch (e) {
    log('service', '重启失败: ' + String(((e as Error).message) || e));
    // 失败路径同样清缓存：旧 webUrl 已不可达，手机桥按「未运行」处理。
    currentWebInfo = null;
    return { ok: false, error: String(((e as Error).message) || e) };
  } finally {
    (bootMod.setIsRestarting as (v: boolean) => void)(false);
    vnextState.state.restartingServer = false;
  }
}

// ---- 5.3.3：守护启动接线（guardedBoot 在 Tauri 化时断线的最小恢复）--------
// 启动前取 profile 快照；成功 → markGood 标「最后良好」（恢复中心
// 「回退最后良好快照」的数据来源，此前永不写入、恒空转）；失败 →
// 事故留痕。完整 guardedBoot 重试链不接：sidecar 启动链已自带有界重试
// 与救援引导，重试语义重复。
let agentPreviousConfirmed = false;
async function guardedStartAndWait(overlays: string[]): Promise<{ webUrl: string; port: number }> {
  const g = (guardBoxMod.ensureGuard as () => {
    snapshot(r: string): { id: string } | null;
    markGood(id: string): void;
    reportIncident(t: string, d: string): { ok: boolean };
    quarantineFatal(o?: { quarantinePeers?: boolean }): { checked: number; quarantined: string[] };
  })();
  // 版本兼容防线（v0.2）：启动前静态核对插件与内核的对应关系 —— patch 引用的
  // 插件包/入口缺失（实战根因：行在包被清 → ERR_MODULE_NOT_FOUND → 整棵插件
  // 树起不来）与关键 peer 不满足 → 自动隔离（快照 + patch disabled + incident），
  // 让内核照常启动而非整树崩溃。快照先行保证任何时刻可回滚。
  try {
    const pre = g.quarantineFatal({});
    if (pre.quarantined.length) say('版本兼容预检: 自动隔离 ' + pre.quarantined.length + ' 个不兼容插件');
  } catch (e) {
    say('版本兼容预检失败（继续启动）: ' + String(((e as Error).message) || e));
  }
  const snap = g.snapshot('boot');
  try {
    const r = await (bootMod.startAndWait as (o: string[]) => Promise<{ webUrl: string; port: number }>)(overlays);
    if (snap) g.markGood(snap.id);
    // agent-previous 备份生命周期：更新后的首次健康启动即清理上一版备份
    // （5.3.2 及以前 confirmPreviousAgentHealthy 零调用，数百 MB 备份永滞）。
    if (!agentPreviousConfirmed) {
      agentPreviousConfirmed = true;
      // 两个「确认健康后的清理」都【严禁】在 boot.start 关键路径上同步执行：
      // backups/<ts> 全量镜像与 agent-previous 覆盖层可达数百 MB～数 GB，
      // 同步 rm 冻结事件循环数分钟 → 全部 RPC 卡死 + boot.start 180s 超时
      // 弹 died 页（5.3.5 首发实测事故）。推迟 30s 且清理本体走 fs.promises。
      setTimeout(() => {
        void (async () => {
          try {
            // async（fs.promises.rm）：agent-previous 数百 MB 级，严禁同步删。
            await updater.confirmPreviousAgentHealthy((pathsMod.updCtx as () => unknown)());
          } catch (e) {
            log('update', '确认上一版健康失败: ' + String(((e as Error).message) || e));
          }
          try {
            const cu = require(path.join(DSH_DESKTOP_ROOT, 'client-updater.js')) as {
              cleanupClientBackupIfHealthy(c: unknown, o?: unknown): Promise<{ removed: string[]; kept: string[] }>;
            };
            const r = await cu.cleanupClientBackupIfHealthy((pathsMod.updCtx as () => unknown)());
            if (r.removed.length) log('update', '已延迟清理更新备份 ' + r.removed.length + ' 份');
          } catch (e) {
            log('update', '清理更新备份失败: ' + String(((e as Error).message) || e));
          }
        })();
      }, 30_000).unref();
    }
    return r;
  } catch (e) {
    try {
      g.reportIncident('boot-failed', 'dsh web 服务拉起失败。\n\n错误：\n' + String(((e as Error).message) || e));
    } catch { /* 尽力而为 */ }
    throw e;
  }
}

recoveryCenter.init({
  appVersion: pkgVersion,
  profile: desktopProfileFn(),
  restartWebService: async () => restartWebServiceCore(),
  requestSafeModeRelaunch: () => notify('shell.relaunch-safe-mode', {}),
});

// ---- 方法注册表 -----------------------------------------------------------
interface RpcReq { id: number | null; method: string; params?: Record<string, unknown> }
type RpcResult = Record<string, unknown>;
type RpcParams = Record<string, unknown> | undefined;

// 图标 dataUri 模块级缓存：bridge openMenu 每次开菜单都调 chrome.init，
// 5.3.2 及以前每次重读 146KB 图标 + base64 并经 WS 回环发 ~195KB JSON。
let chromeIconDataUri: string | null = null;
function chromeIcon(): string {
  if (chromeIconDataUri !== null) return chromeIconDataUri;
  try {
    const buf = fs.readFileSync(path.join(DSH_DESKTOP_ROOT, 'assets', 'icon.png'));
    chromeIconDataUri = buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50
      ? 'data:image/png;base64,' + buf.toString('base64')
      : '';
  } catch { chromeIconDataUri = ''; /* 无图标不致命 */ }
  return chromeIconDataUri;
}

const methods: Record<string, (p: RpcParams) => unknown> = {
  'shell.info': (): RpcResult => ({
    sidecar: 'server.ts',
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    dshHome,
    userDataDir,
    capabilities: desktopPlatform.capabilities(),
    version: pkgVersion,
    modules: MOUNTED,
    balance: balanceCache,
  }),
  'profile.name': (): RpcResult => ({ name: desktopProfileFn() }),
  'profile.dir': (): RpcResult => ({ dir: (profileMod.desktopProfileDir as () => string)() }),
  'runtime.nodeExe': (): RpcResult => ({ exe: (pathsMod.nodeExe as () => string)() }),
  'runtime.dshBin': (): RpcResult => ({ bin: (pathsMod.dshBin as () => string)() }),
  'plugins.removedIds': (): RpcResult => ({ ids: (companionSyncMod.removedPluginIds as () => unknown[])() }),
  'guard.ensure': (): RpcResult => ({ ok: !!(guardBoxMod.ensureGuard as () => unknown)() }),
  // ---- boot.*（P2：dsh web 服务编排，Rust 壳的启动主链路） ----
  'boot.start': async (p): Promise<RpcResult> => {
    const overlays = Array.isArray(p && p.overlays) ? (p!.overlays as string[]) : [];
    // 打包态捆绑依赖完整性校验（issue #7，= Electron startAndShowGuarded 前置）：
    // 空壳包以明确文案提示重装，用户选「仍然启动」才继续。
    await (previewMod.verifyBundledModules as () => Promise<void>)();
    // 前置文件树准备（= main.js boot() 在 startAndShowGuarded 之前的序列，
    // 摘除 GUI 项）：市场排队 → 退役清理 → 配套插件/技能同步 → 模块遮蔽
    // 修复 → 构建产物回填。koffi 预检与 junction 巡检属 P3 壳层集成。
    try {
      await preBootSync();
    } catch (e) {
      say('boot 前置准备失败（继续尝试拉起服务）: ' + String(((e as Error).message) || e));
    }
    // 共享 profile 一次性迁移（= Electron main.js boot() 序列）：必须在
    // syncCompanionPlugins 写新 profile 之后、皮肤行落位（applyLegacySkinChoice
    // 在 sync 内消费）之前判定 —— preBootSync 已完成 sync，此处执行迁移清理。
    try {
      (shortcutsMod.migrateFromSharedWebProfile as () => void)();
    } catch (e) {
      say('共享 profile 迁移失败（不影响启动）: ' + String(((e as Error).message) || e));
    }
    // vnext（Phase 2）：插件档案登记 + 示例 SDK 插件安装（幂等）。
    try {
      recoveryCenter.archivePluginProfiles();
    } catch (e) {
      say('插件档案登记失败: ' + String(((e as Error).message) || e));
    }
    try {
      extHost.ensureBundledSdkPlugins();
    } catch (e) {
      say('示例 SDK 插件安装失败: ' + String(((e as Error).message) || e));
    }
    // 恢复中心直开模式（Rust 壳检测 DSH_DESKTOP_RECOVERY=1 已打开恢复中心
    // 窗口）：跳过 dsh web 启动，sidecar 只保持存活供恢复中心动作调用。
    if (process.env.DSH_DESKTOP_RECOVERY === '1') {
      say('[vnext] DSH_DESKTOP_RECOVERY=1，跳过 dsh web 启动（恢复中心直开模式）');
      return { ok: true, recoveryMode: true };
    }
    // vnext（Phase 2）：Core Bridge 回环端点必须在拉起 dsh web 之前就绪，
    // 其 URL/token 经 process.env 注入（childEnv 展开 process.env）。
    try {
      const mgr = extHost.getExtensionHostManager();
      const bridge = await bridgeServer.startExtensionBridgeServer(mgr);
      vnextState.state.eacBridge = bridge;
      process.env.DSH_EAC_BRIDGE_URL = bridge.url;
      process.env.DSH_EAC_BRIDGE_TOKEN = bridge.token;
      say('[vnext] Core Bridge 端点就绪: ' + bridge.url);
    } catch (e) {
      say('[vnext] Core Bridge 端点启动失败（隔离工具桥接不可用）: ' + String(((e as Error).message) || e));
    }
    let r: { webUrl: string; port: number };
    try {
      r = await guardedStartAndWait(overlays);
    } catch (e) {
      // 崩溃循环计数（= main.js recordBootFailureNow）：连续失败达阈值后，
      // 救援页据 rescue.state.crash 引导安全模式。
      rescueIntegration.recordBootFailureNow(String(((e as Error).message) || e));
      notify('boot.failed', { error: String(((e as Error).message) || e) });
      throw e;
    }
    rescueIntegration.clearRescueState?.();
    currentWebInfo = { webUrl: r.webUrl, port: r.port };

    notify('boot.web-ready', r);
    // 应答必须立刻返回：boot.start 是 Rust 壳 180s 超时的同步等待点，下面
    // 的桌面集成序列（余额轮询/更新调度/快捷方式 PowerShell/junction 巡检）
    // 全是同步重活，旧实现串行跑完才 return —— 慢机器/大 home 上事件循环
    // 被占几十秒，应答迟到甚至叠加其他同步作业后超时弹 died 页。全部挪进
    // setImmediate：应答先出，集成紧随其后照常执行。
    setImmediate(() => {
      try {
        startBalanceLoop(); // 服务就绪后启动 15min 余额轮询（= main.js startBalanceLoop）
        scheduleAutoUpdateChecks(); // 启动 60s 首检 + 12h 周期（P4 更新链）
        // vnext（Phase 2）：并行拉起全部启用的 SDK 插件宿主（不阻塞 boot）。
        void extHost.startEnabledExtensionHosts();
        // ---- 5.3.3 批次 D 接线（= Electron main.js boot() 成功路径的桌面集成）----
        // 预览静态服务：独立回环端口（不占 UI 的 6 连接池），chrome.init 的
        // staticPort 字段从此有真实值（dsh-client-file-changes 预览面板消费）。
        try {
          (previewMod.startPreviewStaticServer as () => void)();
        } catch (e) {
          say('预览静态服务启动失败（不影响主流程）: ' + String(((e as Error).message) || e));
        }
        // 快捷方式维护（打包态 Windows 才生效：开始菜单 + 便携版桌面）与
        // 临时目录运行告警（便携版解压在 %TEMP% 时提醒搬走）。
        // maintainShortcuts 是 Promise（PowerShell 全异步批量）：sync try 接
        // 不住 rejection，显式 .catch；旧同步实现逐图标起 PowerShell 冻结
        // 事件循环数十秒（boot 后点「开始配对」必卡 —— 5.3.5 复现实测）。
        try {
          void (shortcutsMod.maintainShortcuts as () => Promise<void>)().catch((e) => {
            say('快捷方式维护失败（不影响启动）: ' + String(((e as Error).message) || e));
          });
        } catch (e) {
          say('快捷方式维护失败（不影响启动）: ' + String(((e as Error).message) || e));
        }
        try {
          (shortcutsMod.warnTempRun as () => void)();
        } catch (e) {
          say('临时目录运行检测失败（不影响启动）: ' + String(((e as Error).message) || e));
        }
        // junction 归属巡检（5min 周期，外部原生 dsh 退出后自动修复指向）。
        try {
          (junctionPatrolMod.startJunctionWatchdog as () => void)();
        } catch (e) {
          say('junction 巡检启动失败（不影响启动）: ' + String(((e as Error).message) || e));
        }
      } catch (e) {
        say('boot 桌面集成序列失败（不影响服务）: ' + String(((e as Error).message) || e));
      }
    });
    // 会话任务完成通知（notifyOnTurnEnd 设置项控制）——同样属集成序列尾，
    // 随 setImmediate 之后的下一拍执行，不占应答路径。
    setImmediate(() => {
      try { startSessionWatcher(); } catch (e) {
        say('会话监听启动失败（不影响启动）: ' + String(((e as Error).message) || e));
      }
    });
    return { ok: true, webUrl: r.webUrl, port: r.port };
  },
  'boot.stop': async (): Promise<RpcResult> => {
    await (bootMod.stopServer as () => Promise<void>)();
    // 显式停服后必须清掉缓存：手机桥 getWebUrl() 拿着旧 webUrl 会逐请求
    // 打死端口 502，而不是语义正确的「服务未运行」。
    currentWebInfo = null;
    return { ok: true };
  },
  'boot.state': (): RpcResult => (bootMod.state as () => unknown)() as RpcResult,
  // ---- phone.*（手机连接桥：LAN 配对 + 白名单 RPC + 手机端占位页） ----
  'phone.start': (p): RpcResult | Promise<RpcResult> => handlePhoneMethod('phone.start', p),
  'phone.stop': (p): RpcResult | Promise<RpcResult> => handlePhoneMethod('phone.stop', p),
  'phone.status': (p): RpcResult => handlePhoneMethod('phone.status', p) as RpcResult,
  'phone.decide': (p): RpcResult => handlePhoneMethod('phone.decide', p) as RpcResult,
  'phone.disconnect': (p): RpcResult => handlePhoneMethod('phone.disconnect', p) as RpcResult,
  // ---- chrome.init（getInfo；字段集对齐 main.js chrome:init handler） ----
  'chrome.init': (): RpcResult => {
    const s = loadSettings() as {
      closeToTray?: boolean; exitAction?: string; shortcutPolicy?: string;
      notifyOnTurnEnd?: boolean; repos?: { github?: string; gitee?: string };
    };
    const iconDataUri = chromeIcon();
    const exitAction = s.exitAction === 'ask' || s.exitAction === 'minimize' || s.exitAction === 'quit'
      ? s.exitAction
      : s.closeToTray === false ? 'quit' : s.closeToTray === true ? 'minimize' : 'ask';
    let repos = { github: '', gitee: '' };
    try {
      const cu = require(path.join(DSH_DESKTOP_ROOT, 'client-updater.js')) as { resolveRepos(r: unknown): { github: string; gitee: string } };
      repos = cu.resolveRepos(s.repos);
    } catch { /* 回退空串（菜单隐藏更新源区） */ }
    return {
      appVersion: pkgVersion,
      agentVersion: (pathsMod.dshVersion as () => string)(),
      agentSource: (pathsMod.dshVersionSource as () => string)(),
      notifyOnTurnEnd: s.notifyOnTurnEnd !== false,
      closeToTray: s.closeToTray !== false,
      exitAction,
      shortcutPolicy: s.shortcutPolicy === 'never' ? 'never' : 'auto',
      capabilities: desktopPlatform.capabilities(),
      iconDataUri,
      repoUrls: { github: repos.github ? 'https://github.com/' + repos.github : '', gitee: repos.gitee ? 'https://gitee.com/' + repos.gitee : '' },
      // 预览静态服务端口（boot.start 里 startPreviewStaticServer 已 listen；
      // 服务未起时 0 = 插件侧回退宿主 /dsh-files/static/ 路由）。
      staticPort: (previewMod.getPreviewStaticPort as () => number)(),
    };
  },
  // 原地重启 Web 服务核心：无锁窗口内消费市场排队 → 同步配套插件 →
  // 修复模块遮蔽 → 恢复保留产物 → 重新拉起。
  'boot.restart': async (): Promise<RpcResult> => restartWebServiceCore(),
  // bridge.ts 的 restartService() 调 service.restart（此前无注册 → -32601 被插件
  // 静默吞掉，「重启服务后生效」实际不重启）：与 boot.restart 同一核心。
  'service.restart': async (): Promise<RpcResult> => restartWebServiceCore(),
  // ---- 恢复中心（vnext-absorb Phase 2）：Rust 壳创建的恢复中心窗口经专用
  // preload（WS JSON-RPC）调用这两个方法；动作分发在 lib/recovery-center。----
  'rc.action': async (p): Promise<RpcResult> => {
    const action = String((p && p.action) || '');
    return await recoveryCenter.handleRcAction(action, p && p.value);
  },
  'rc.close': (): RpcResult => ({ ok: true }),
};

// ---- 真实现面（P3：对齐原 Electron 主链路各 ipcMain.handle 语义，去 GUI 化） --------
const balance = require(path.join(DSH_DESKTOP_ROOT, 'balance.js')) as {
  queryBalance(home: string): Promise<Record<string, unknown> & { prices?: Record<string, unknown> }>;
  readActiveModel(home: string): string;
  DEFAULT_PRICES: Record<string, unknown>;
  FALLBACK_PRICES: Record<string, unknown>;
  computePricingState(peakWindows?: unknown): { period: string } & Record<string, unknown>;
  tierPrices(base: unknown, override: unknown, tier: string): Record<string, number>;
  sanitizePrices(prices: unknown): { peak: Record<string, number>; offpeak: Record<string, number> };
};
const pluginUpdater = require(path.join(DSH_DESKTOP_ROOT, 'plugin-updater.js')) as Record<string, (...a: unknown[]) => unknown>;

function home(): string { return dshHome; }

let balanceTimer: NodeJS.Timeout | null = null;
let balanceCache: unknown = null;

async function refreshBalance(): Promise<unknown> {
  const s = loadSettings() as { pricing?: { peakWindows?: unknown }; balancePrices?: Record<string, unknown> };
  let result: Record<string, unknown> & { prices?: Record<string, unknown> };
  try {
    result = await balance.queryBalance(home()) as typeof result;
  } catch (e) {
    result = { ok: false, error: String(((e as Error).message) || e), balances: [] };
  }
  const model = balance.readActiveModel(home()) || 'deepseek-v4-pro';
  const table = result.prices || balance.DEFAULT_PRICES;
  const pricing = balance.computePricingState(s.pricing && s.pricing.peakWindows);
  const base = (table as Record<string, unknown>)[model] || balance.FALLBACK_PRICES;
  const ov = (s.balancePrices && s.balancePrices[model]) || {};
  const tier = (src: string): Record<string, number> => balance.tierPrices(base, ov, src);
  result.prices = tier(pricing.period) as Record<string, unknown>;
  result.pricing = { ...pricing, prices: { peak: tier('peak'), offpeak: tier('offpeak') } };
  balanceCache = result;
  // 推送（= Electron 的 webContents.send('dsh:balance')；桥转发成 window 事件）。
  notify('dsh.balance', result);
  return result;
}

function startBalanceLoop(): void {
  if (balanceTimer) return;
  void refreshBalance().catch(() => {});
  balanceTimer = setInterval(() => { void refreshBalance().catch(() => {}); }, 15 * 60 * 1000);
  if (balanceTimer.unref) balanceTimer.unref();
}

const batch: Record<string, (p: RpcParams) => unknown> = {
  'balance.refresh': async (): Promise<unknown> => refreshBalance(),
  'balance.prices-get': (p): Record<string, unknown> => {
    const model = String((p && p.model) || '');
    const s = loadSettings() as { balancePrices?: Record<string, unknown> };
    const defaults = (balance.DEFAULT_PRICES as Record<string, unknown>)[model] || balance.FALLBACK_PRICES;
    const current = (s.balancePrices && s.balancePrices[model]) || null;
    return { ok: true, model, defaults, current };
  },
  'balance.prices-set': async (p): Promise<Record<string, unknown>> => {
    const m = String((p && p.model) || '');
    if (!m) return { ok: false, error: '模型名称不能为空' };
    try {
      const cleaned = balance.sanitizePrices(p && p.prices);
      const s = loadSettings();
      if (!s.balancePrices || typeof s.balancePrices !== 'object') s.balancePrices = {};
      (s.balancePrices as Record<string, unknown>)[m] = cleaned;
      saveSettings(s);
      await refreshBalance();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'balance.prices-reset': async (p): Promise<Record<string, unknown>> => {
    const m = String((p && p.model) || '');
    try {
      const s = loadSettings() as { balancePrices?: Record<string, unknown> };
      if (s.balancePrices && s.balancePrices[m]) {
        delete s.balancePrices[m];
        saveSettings(s as Record<string, unknown>);
      }
      await refreshBalance();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'balance.models': (): Record<string, unknown> => {
    // 与 main.js dsh:balance-models 同款轻量 YAML 扫描（llm-pi-ai.providers.models）。
    try {
      const settingsPath = path.join(home(), 'settings.yaml');
      if (!fs.existsSync(settingsPath)) return { ok: true, models: [] };
      const text = fs.readFileSync(settingsPath, 'utf8');
      const lines = text.split(/\r?\n/);
      const models: { id: string; name: string; provider: string }[] = [];
      let inProviders = false;
      let providerIndent = -1;
      let currentProvider = '';
      let inModels = false;
      let modelsIndent = -1;
      let currentModel: { id: string; name: string; provider: string } | null = null;
      for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const indent = line.search(/\S/);
        if (/^llm-pi-ai\s*:/i.test(line)) { inProviders = true; providerIndent = -1; continue; }
        if (inProviders && /^\s+providers\s*:/i.test(line)) { providerIndent = indent; continue; }
        if (providerIndent >= 0) {
          if (indent <= providerIndent && line.trim()) {
            if (/^[a-z]/i.test(line.trim())) break;
            continue;
          }
          const providerMatch = line.match(new RegExp(`^\\s{${providerIndent + 2},${providerIndent + 6}}([a-z][\\w-]*)\\s*:`));
          if (providerMatch && !inModels && !['models', 'baseurl', 'apikeyenv', 'displayname', 'api'].includes(providerMatch[1]!.toLowerCase())) {
            currentProvider = providerMatch[1]!;
            continue;
          }
          if (/^\s+models\s*:/i.test(line) && indent > providerIndent) { inModels = true; modelsIndent = indent; continue; }
          if (inModels) {
            if (indent <= modelsIndent && line.trim()) {
              inModels = false;
              currentModel = null;
              const reProvider = line.match(new RegExp(`^\\s{${providerIndent + 2},${providerIndent + 6}}([\\w][\\w-]*)\\s*:`));
              if (reProvider) currentProvider = reProvider[1]!;
              continue;
            }
            const modelMatch = line.match(/^\s+-\s+id\s*:\s*(\S+)/);
            if (modelMatch) {
              const modelId = modelMatch[1]!.replace(/^["']|["']$/g, '');
              currentModel = { id: modelId, name: modelId, provider: currentProvider };
              models.push(currentModel);
              continue;
            }
            const nameMatch = line.match(/^\s+name\s*:\s*(.+)/);
            if (nameMatch && currentModel) {
              currentModel.name = nameMatch[1]!.trim().replace(/^["']|["']$/g, '');
              continue;
            }
          }
        }
      }
      const seen = new Set<string>();
      const uniqueModels = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
      return { ok: true, models: uniqueModels };
    } catch (e) {
      return { ok: true, models: [] };
    }
  },
  'image-paste.save': (p): Record<string, unknown> => {
    try {
      return (pluginOpsMod.imagePasteSave as (d: string, n: string) => Record<string, unknown>)(String((p && p.dataUrl) || ''), String((p && p.name) || '粘贴图片'));
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  // 拖入文件保存（dsh-file-drop-eac）：任意文件 data URL → 临时目录 → 真实路径。
  'file-drop.save': (p): Record<string, unknown> => {
    try {
      return (pluginOpsMod.fileDropSave as (d: string, n: string) => Record<string, unknown>)(String((p && p.dataUrl) || ''), String((p && p.name) || '拖入文件'));
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'files.revert': (p): Record<string, unknown> => {
    const changes = (p && p.changes) as Array<{ path?: string; oldText?: string; newText?: string }>;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) return { results: [] };
    const results: Record<string, unknown>[] = [];
    for (const c of changes) {
      const fp = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(fp) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: fp, status: 'invalid' });
        continue;
      }
      if (!(fileRootsMod.isUnderFileRoots as (x: string) => boolean)(fp)) {
        results.push({ path: fp, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(fp);
        const content = exists ? fs.readFileSync(fp, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          if (content !== null && content === newText) { fs.rmSync(fp); results.push({ path: fp, status: 'reverted' }); }
          else results.push({ path: fp, status: content === null ? 'missing' : 'conflict' });
        } else if (newText === '' && oldText !== '') {
          if (content === null) { fs.writeFileSync(fp, oldText, 'utf8'); results.push({ path: fp, status: 'reverted' }); }
          else results.push({ path: fp, status: 'conflict' });
        } else {
          if (content !== null && content.includes(newText)) {
            // replace 只回滚第一处匹配：同一改动在文件中出现多处时只换一处
            // 却报 reverted 会误导调用方。行为保持单处替换（与写入侧对称），
            // 多于一处时附带 occurrences 供上层判断。
            const occurrences = content.split(newText).length - 1;
            fs.writeFileSync(fp, content.replace(newText, () => oldText), 'utf8');
            results.push(occurrences > 1
              ? { path: fp, status: 'reverted', occurrences, note: 'oldText 多处匹配，仅回滚第一处' }
              : { path: fp, status: 'reverted' });
          } else if (content !== null && content === oldText) {
            results.push({ path: fp, status: 'skipped' });
          } else {
            results.push({ path: fp, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (err) {
        results.push({ path: fp, status: 'failed', error: String(((err as Error).message) || err) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  },
  'files.authorize-open': (p): Record<string, unknown> => {
    let fp = (p && p.path) as string;
    if (typeof fp !== 'string' || !path.isAbsolute(fp)) return { ok: false, error: 'path must be absolute' };
    // 归一化必须先于前缀比对：原始串可携带 `..`/大小写变体/符号链接骗过
    // 字面前缀命中，短路 isUnderFileRoots 后经壳层 files.open（ShellExecuteW
    // 无二次校验）打开任意文件。realPath 跟随符号链接与 ..；叶子不存在时
    // 用已解析的父目录拼回（随后 existsSync 把关）。
    try {
      fp = fs.realpathSync(fp);
    } catch {
      try {
        fp = path.resolve(fs.realpathSync(path.dirname(fp)), path.basename(fp));
      } catch { /* 连父目录都不可解析：保持原串，交给下方围栏判定 */ }
    }
    const lower = (x: string): string => (process.platform === 'win32' ? x.toLowerCase() : x);
    const skillsRoots = [
      path.join(home(), 'skills'),
      path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'),
    ].map((r) => lower(path.resolve(r)));
    const fpL = lower(fp);
    const underSkillsRoot = skillsRoots.some((r) => fpL === r || fpL.startsWith(r + path.sep));
    if (!underSkillsRoot && !(fileRootsMod.isUnderFileRoots as (x: string) => boolean)(fp)) {
      return { ok: false, error: 'path outside session workspace' };
    }
    if ((fileRootsMod.DANGEROUS_EXT as RegExp).test(fp)) {
      return { ok: false, error: 'executable files are not openable from the file view' };
    }
    if (!fs.existsSync(fp)) return { ok: false, error: 'file not found' };
    return { ok: true, path: fp };
  },
  'plugins.list': (): Record<string, unknown> => {
    return { list: (pluginOpsMod.pluginManagerCollect as () => unknown[])() };
  },
  'plugins.set-enabled': (p): Record<string, unknown> => {
    return (pluginOpsMod.pluginManagerSetEnabled as (id: string, en: boolean) => Record<string, unknown>)(String((p && p.id) || ''), !!(p && p.enabled));
  },
  'plugins.set-removed': (p): Record<string, unknown> => {
    return (pluginOpsMod.pluginManagerSetRemoved as (id: string, rm: boolean) => Record<string, unknown>)(String((p && p.id) || ''), !!(p && p.removed));
  },
  'plugins.updates': async (p): Promise<Record<string, unknown>> => {
    try {
      const ctx = (pathsMod.updCtx as () => unknown)();
      const sources = (companionSyncMod.pluginUpdateSources as () => Array<{ id: string }>)();
      const list = await (pluginUpdater.checkPluginUpdates as (c: unknown, s: unknown[], o: unknown) => Promise<unknown[]>)(ctx, sources, {
        force: !!(p && p.force),
        profileDirP: (profileMod.desktopProfileDir as () => string)(),
      });
      return {
        list,
        autoUpdate: (pluginUpdater.isAutoUpdateEnabled as (c: unknown) => boolean)(ctx),
        checkedAt: (loadSettings() as { pluginUpdateCheckedAt?: string }).pluginUpdateCheckedAt || null,
      };
    } catch (e) {
      log('plugin-update', '插件更新清单加载失败: ' + String(((e as Error).message) || e));
      return { list: [], autoUpdate: false, error: String(((e as Error).message) || e) };
    }
  },
  'plugins.update': async (p): Promise<Record<string, unknown>> => {
    const sources = (companionSyncMod.pluginUpdateSources as () => Array<{ id: string }>)();
    const source = sources.find((s) => s.id === String(p && p.id));
    if (!source) return { ok: false, error: '未知或不可更新的内置插件: ' + String(p && p.id) };
    try {
      const res = await (pluginUpdater.applyBuiltinPluginUpdate as (c: unknown, s: unknown, o: unknown) => Promise<Record<string, unknown>>)((pathsMod.updCtx as () => unknown)(), source, {
        profileDirP: (profileMod.desktopProfileDir as () => string)(),
        guard: (guardBoxMod.ensureGuard as () => unknown)(),
        copyIntoProfile: (overlayDir: string, name: string) => (companionSyncMod.copyPluginPackage as (d: string, o: string, n: string) => void)((profileMod.desktopProfileDir as () => string)(), overlayDir, name),
      });
      if (!res.ok) return res;
      if (res.noop) return { ok: true, noop: true, current: res.current, latest: res.latest };
      log('plugin-update', '手动更新内置插件 ' + String(p && p.id) + ' → ' + res.latest + (res.restartRequired ? '（重启服务生效）' : ''));
      return { ok: true, version: res.latest, restartRequired: res.restartRequired };
    } catch (e) {
      log('plugin-update', '更新插件 ' + String(p && p.id) + ' 失败: ' + String(((e as Error).message) || e));
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'plugins.auto-update': (p): Record<string, unknown> => {
    try {
      const s = loadSettings();
      s.pluginAutoUpdate = !!(p && p.enabled);
      saveSettings(s);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'guard.action': (p): Record<string, unknown> => {
    const action = String((p && p.action) || '');
    const value = p && p.value;
    const g = (guardBoxMod.ensureGuard as () => Record<string, (...a: unknown[]) => unknown>)();
    switch (action) {
      case 'status': {
        const st = loadSettings() as { shareWebProfile?: boolean };
        return {
          ok: true,
          profile: desktopProfileFn(),
          shareWebProfile: st.shareWebProfile === true,
          snapshots: (g.listSnapshots as () => unknown[])().slice(0, 20),
          incidents: (g.listIncidents as () => unknown[])().slice(0, 20),
          lastGood: (g.lastGoodSnapshot as () => unknown)(),
        };
      }
      case 'snapshot': {
        const s = (g.snapshot as (r: string) => unknown)(String(value || 'manual'));
        return { ok: !!s, snapshot: s };
      }
      case 'restore': {
        const running = (bootMod.state as () => { running: boolean })().running;
        if (running) {
          return { ok: false, error: 'service-running', hint: '请先重启 Web 服务（或让回滚在重启间隙执行）' };
        }
        return (g.restore as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      }
      case 'check':
        return { ok: true, report: (g.healthCheck as () => unknown)() };
      case 'repair': {
        const r = (g.repair as () => { applied: unknown })();
        return { ok: true, applied: r.applied };
      }
      case 'version':
        // 版本兼容防线（v0.2）：内核版本 + 每条 patch 条目的安装/入口/peer/inject 状态
        return { ok: true, report: (g.versionReport as () => unknown)() };
      case 'quarantine': {
        const r = (g.quarantineById as (v: unknown) => Record<string, unknown>)(String(value || ''));
        if (r.ok && r.restartRequired) log('guard', '手动隔离插件: ' + String(value));
        return r;
      }
      case 'incident':
        return (g.readIncident as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      case 'resolve-incident':
        return (g.resolveIncident as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      default:
        return { ok: false, error: 'unknown action' };
    }
  },
  'menu.action': async (p): Promise<Record<string, unknown> | null> => {
    const action = String((p && p.action) || '');
    const s = loadSettings() as { notifyOnTurnEnd?: boolean; shortcutPolicy?: string; exitAction?: string; closeToTray?: boolean };
    switch (action) {
      case 'toggle-notify': {
        s.notifyOnTurnEnd = s.notifyOnTurnEnd === false;
        saveSettings(s as Record<string, unknown>);
        return { notifyOnTurnEnd: s.notifyOnTurnEnd, exitAction: s.exitAction || 'ask' };
      }
      case 'toggle-shortcut-policy': {
        s.shortcutPolicy = s.shortcutPolicy === 'never' ? 'auto' : 'never';
        saveSettings(s as Record<string, unknown>);
        return { shortcutPolicy: s.shortcutPolicy, exitAction: s.exitAction || 'ask' };
      }
      case 'set-exit-action': {
        const v = String((p && p.value) || '');
        if (v !== 'ask' && v !== 'minimize' && v !== 'quit') return null;
        s.exitAction = v;
        s.closeToTray = v !== 'quit'; // 同步旧字段，降级回旧版时行为不回退
        saveSettings(s as Record<string, unknown>);
        return { notifyOnTurnEnd: s.notifyOnTurnEnd !== false, closeToTray: s.closeToTray !== false, exitAction: v };
      }
      case 'restart-service': {
        const r = await (methods['boot.restart'] as (p2?: unknown) => Promise<Record<string, unknown>>)({} as Record<string, unknown>);
        return r;
      }
      // ---- P4 更新链 + 壳页动作（对齐 main.js 各 case 语义） ----
      case 'check-client-update': {
        try {
          await (clientUpdateMod.runClientUpdateFlow as (manual: boolean) => Promise<void>)(true);
        } catch (e) {
          log('client-update', '手动检查失败: ' + String(((e as Error).message) || e));
        }
        return { ok: true };
      }
      case 'check-agent-update': {
        try {
          await runAgentUpdateFlow(true);
        } catch (e) {
          log('update', '手动检查失败: ' + String(((e as Error).message) || e));
        }
        return { ok: true };
      }
      case 'export-logs': {
        const f = methods['recovery.export-logs'] as () => Promise<Record<string, unknown>>;
        return typeof f === 'function' ? await f() : { ok: false, error: 'unavailable' };
      }
      case 'about': {
        // 壳层把主窗导航到 /about（back=当前 webUrl），菜单本身无返回值。
        notify('shell.about', {});
        return { ok: true };
      }
      default:
        // 未知动作：菜单静默关闭，无报错（对齐占位语义）。
        return null;
    }
  },
};
Object.assign(methods, batch);

// ---- P4 更新链（agent 内核更新流，对齐 main.js runUpdateFlow） -------------
const updater = require(path.join(DSH_DESKTOP_ROOT, 'updater.js')) as {
  checkLatest(c: unknown): Promise<string>;
  activeVersion(c: unknown): string;
  loadSettings(c: unknown): Record<string, unknown>;
  saveSettings(c: unknown, s: unknown): void;
  compareVersions(a: string, b: string): number;
  applyUpdate(c: unknown, latest: string, o: { onProgress: (ev: string) => void }): Promise<void>;
  confirmPreviousAgentHealthy(c: unknown): Promise<boolean>;
};
const onboardingLogic = require(path.join(DSH_DESKTOP_ROOT, 'scripts', 'onboarding.js')) as {
  CORE_PLUGIN_IDS: string[];
  RECOMMENDED_PLUGIN_IDS: string[];
  pluginCurrentState(entries: unknown[], plugins: unknown[]): Record<string, boolean>;
  buildSelectionOps(plugins: unknown[], coreIds: string[], want: Set<string>, current: Record<string, boolean> | null): Array<{ id: string; enable: boolean }>;
  sanitizeSelection(ids: unknown, plugins: unknown[], coreIds: string[]): Set<string>;
  buildCatalog(plugins: unknown[], o: unknown): unknown[];
};
let agentUpdateBusy = false;

async function runAgentUpdateFlow(manual: boolean): Promise<void> {
  if (quitting) return;
  if (agentUpdateBusy) {
    if (manual) await showBoxFallback({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。' });
    return;
  }
  const c = (pathsMod.updCtx as () => unknown)();
  let latest: string;
  try {
    latest = await updater.checkLatest(c);
  } catch (err) {
    log('update', '检查失败: ' + String(((err as Error).message) || err));
    if (manual) {
      await showBoxFallback({ type: 'warning', title: '检查更新失败', message: '无法连接 npm registry。' });
    }
    return;
  }
  const current = updater.activeVersion(c);
  const settings = loadSettings();
  if (updater.compareVersions(latest, current) <= 0) {
    if (manual) await showBoxFallback({ type: 'info', title: '检查更新', message: '当前已是最新版本。' });
    return;
  }
  if (!manual && settings.skipVersion === latest) return;
  const { response } = await showBoxFallback({
    type: 'info',
    title: '发现新版本',
    message: `官方 @deepseek-ai/dsh 发布了新版本：${latest}`,
    buttons: ['立即更新', '跳过此版本', '稍后'],
    // 无头兜底按 cancelId 应答（fail-closed）：不传则回 0 =「立即更新」，
    // 周期检查会在无人确认的情况下直接开更（见 showBoxFallback 注释）。
    cancelId: 2,
  });
  if (response === 1) {
    settings.skipVersion = latest;
    saveSettings(settings);
    return;
  }
  if (response === 2) return;
  agentUpdateBusy = true;
  updateWindowOpen = true;
  notify('client-update.show', { version: latest, kind: 'agent' });
  const progressAgent = (ev: string): void => notify('client-update.progress', { channel: 'agent', stage: ev });
  try {
    const g = (guardBoxMod.ensureGuard as () => { snapshot(r: string): unknown })();
    if (!g.snapshot('pre-update:dsh:' + latest)) {
      throw new Error('更新前保护快照失败（profile 不可读），已中止更新以保证可回滚。');
    }
    await updater.applyUpdate(c, latest, { onProgress: progressAgent });
    updateWindowOpen = false;
    notify('client-update.hide', {});
    const { response: r2 } = await showBoxFallback({
      type: 'info',
      title: '更新完成',
      message: `已更新到 @deepseek-ai/dsh@${latest}`,
      detail: '重启应用后生效。',
      buttons: ['立即重启', '稍后重启'],
      // 同上：不传 cancelId 兜底会答 0 =「立即重启」，整壳无人值守重启。
      cancelId: 1,
    });
    if (r2 === 0) {
      // 整壳重启（sidecar 随壳有界收口；run-state 属 Electron watchdog 机制，Tauri 用崩溃计数替代）。
      notify('shell.relaunch', {});
    }
  } catch (err) {
    log('update', '更新失败: ' + String(((err as Error).message) || err));
    await showBoxFallback({ type: 'error', title: '更新失败', message: '未能完成更新，仍使用当前版本。' });
  } finally {
    agentUpdateBusy = false;
    if (updateWindowOpen) {
      updateWindowOpen = false;
      notify('client-update.hide', {});
    }
  }
}

// ---- 内置插件选择向导（wizard.open / onboard.*，对齐 main.js ipc 面） -------
// 页面 = 壳层 /wizard（serve assets/onboarding.html + 桥注入），RPC 走本表。
const companionPlugins = () => {
  const select = companionSyncMod.companionPluginsForPlatform as ((platform: NodeJS.Platform) => unknown[]) | undefined;
  return select ? select(process.platform) : (companionSyncMod.COMPANION_PLUGINS as unknown[]) || [];
};
const onboardingCapabilities = platformMod.pluginCapabilityDetails(process.platform);
const unavailablePluginIds = new Set(Object.entries(onboardingCapabilities)
  .filter(([, capability]) => capability.status === 'unavailable')
  .map(([id]) => id));
function pluginDirSize(dirName: string): number {
  let total = 0;
  try {
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      }
    };
    walk(path.join(DSH_DESKTOP_ROOT, 'assets', 'plugins', dirName));
  } catch { /* 未落盘按 0 展示 */ }
  return total;
}
function buildOnboardingCatalog(): unknown[] {
  return (onboardingLogic.buildCatalog as (p: unknown[], o: unknown) => unknown[])(companionPlugins(), {
    coreIds: onboardingLogic.CORE_PLUGIN_IDS,
    recommendedIds: onboardingLogic.RECOMMENDED_PLUGIN_IDS,
    describe: (name: string) => ((pluginOpsMod.pluginManagerPackageDescription as (n: string) => string)(name)),
    dirSize: (dirName: string) => pluginDirSize(dirName),
    capabilities: onboardingCapabilities,
  });
}
function pluginCurrentState(): Record<string, boolean> | null {
  const { entries } = (pluginOpsMod.pluginManagerReadPatch as () => { entries: unknown[] })();
  return (onboardingLogic.pluginCurrentState as (e: unknown[], p: unknown[]) => Record<string, boolean>)(entries, companionPlugins());
}
let wizardMode: 'first' | 'rerun' = 'rerun';

Object.assign(methods, {
  // 打开向导（设置页「选择向导」入口）：壳层导航主窗到 /wizard。
  'wizard.open': (): RpcResult => {
    wizardMode = 'rerun';
    notify('wizard.show', { mode: wizardMode });
    return { ok: true };
  },
  'onboard.list': (): RpcResult => ({
    mode: wizardMode,
    catalog: buildOnboardingCatalog(),
    current: wizardMode === 'rerun' ? pluginCurrentState() : null,
  }),
  'onboard.submit': async (p: RpcParams): Promise<RpcResult> => {
    const ids = p && Array.isArray(p.ids) ? p.ids : [];
    try {
      (profileMod.ensureDesktopProfileInit as () => void)();
      const want = (onboardingLogic.sanitizeSelection as (i: unknown, p: unknown[], c: string[], u: Set<string>) => Set<string>)(ids, companionPlugins(), onboardingLogic.CORE_PLUGIN_IDS, unavailablePluginIds);
      const current = wizardMode === 'rerun' ? pluginCurrentState() : null;
      const ops = (onboardingLogic.buildSelectionOps as unknown as (
        p: unknown[], c: string[], w: Set<string>, cur: Record<string, boolean> | null,
      ) => Array<{ id: string; enable: boolean }>)(companionPlugins(), onboardingLogic.CORE_PLUGIN_IDS, want, current);
      const errors: string[] = [];
      for (const op of ops) {
        try {
          const res = (pluginOpsMod.pluginManagerSetEnabled as (id: string, en: boolean) => { ok: boolean; error?: string })(op.id, op.enable);
          if (!res.ok) errors.push(op.id + ': ' + (res.error || 'unknown'));
          else log('plugin-manager', '向导已' + (op.enable ? '启用' : '停用') + '内置插件 ' + op.id);
        } catch (err) {
          errors.push(op.id + ': ' + String(((err as Error).message) || err));
        }
      }
      const s = loadSettings();
      s.pluginOnboardingDone = true;
      s.builtinPluginSelection = Array.from(want);
      saveSettings(s);
      log('boot', '插件选择向导已应用：' + ops.length + ' 个插件状态变更' + (errors.length ? '，失败 ' + errors.join('; ') : ''));
      const mode = wizardMode;
      notify('wizard.close', { applied: ops.length });
      if (mode === 'rerun') {
        // 二次向导：重启 Web 服务让 host 侧插件生效（与市场安装后同路径）。
        await (methods['boot.restart'] as (p2?: unknown) => Promise<Record<string, unknown>>)({} as Record<string, unknown>);
      }
      return { ok: true, applied: ops.length, errors };
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  'onboard.close': (): RpcResult => {
    notify('wizard.close', { cancelled: true });
    return { ok: true };
  },
});

// ---- 自动更新定时器（对齐 main.js：启动 60s 首检 + 12h 周期） ----------------
// boot.start 成功后调度一次；重复调用幂等。待装更新（下载完未安装）优先提示。
let autoUpdateScheduled = false;
function scheduleAutoUpdateChecks(): void {
  if (autoUpdateScheduled) return;
  autoUpdateScheduled = true;
  setTimeout(() => {
    try { (clientUpdateMod.offerPendingClientUpdate as () => void)(); } catch { /* 无待装更新 */ }
    (clientUpdateMod.runClientUpdateFlow as (m: boolean) => Promise<void>)(false).catch(() => { /* 网络失败不打扰 */ });
  }, 60000).unref();
  setInterval(() => {
    (clientUpdateMod.runClientUpdateFlow as (m: boolean) => Promise<void>)(false).catch(() => { /* 网络失败不打扰 */ });
  }, 12 * 3600 * 1000).unref();
}

// ---- 救援链（硬门槛②；实现于 rescue-integration.ts，同产物编译） ----------
const rescueIntegration = require('./rescue-integration') as {
  initRescue(host: unknown): void;
  rescueMethods(): Record<string, (p: Record<string, unknown> | undefined) => unknown>;
  recordBootFailureNow(errText: string): void;
  shouldEnterRescueNow(): boolean;
  clearRescueState(): void;
};
rescueIntegration.initRescue({
  dshHome,
  userDataDir,
  pkgVersion,
  desktopProfile: desktopProfileFn,
  desktopProfileDir: () => (profileMod.desktopProfileDir as () => string)(),
  dshVersion: () => (pathsMod.dshVersion as () => string)(),
  dshVersionSource: () => (pathsMod.dshVersionSource as () => string)(),
  log,
  notify,
  mods: {
    boot: {
      ...bootMod,
      // rescue retry / recovery.reload 直调 startAndWait 会绕过守护启动链
      //（快照/最后良好/事故留痕），更关键的是绕过 currentWebInfo 写入 ——
      // 救援拉起后手机桥 getWebUrl() 仍返回旧值/空，代理恒 503。统一走
      // guardedStartAndWait 并在成功后同步缓存。
      startAndWait: async (overlays: string[]) => {
        const r = await guardedStartAndWait(overlays);
        currentWebInfo = { webUrl: r.webUrl, port: r.port };
        return r;
      },
    },
    guardBox: guardBoxMod, pluginOps: pluginOpsMod, companionSync: companionSyncMod, balance,
  },
  bootRestart: () => (methods['boot.restart'] as (p?: unknown) => Promise<Record<string, unknown>>)({} as Record<string, unknown>),
});
Object.assign(methods, rescueIntegration.rescueMethods());

function respond(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line: string) => { void handleLine(line); });
rl.on('close', () => { void gracefulExit(); });

async function gracefulExit(): Promise<void> {
  quitting = true;
  try { if (sessionWatcher) { sessionWatcher.stop(); sessionWatcher = null; } } catch { /* 尽力回收 */ }
  try { await (bootMod.stopServer as () => Promise<void>)(); } catch { /* 尽力回收 */ }
  process.exit(0);
}

async function handleLine(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;
  let req: RpcReq;
  try { req = JSON.parse(text); } catch {
    return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const { id, method, params } = req;
  try {
    if (method === 'ping') return respond({ jsonrpc: '2.0', id, result: { pong: true, ts: Date.now() } });
    if (method === 'shutdown') {
      // vnext（Phase 2）：退出前树杀全部 Extension Host（含 Core Bridge 端点）。
      try {
        await extHost.shutdownExtensionHosts();
      } catch (e) {
        say('关闭插件宿主异常: ' + String(((e as Error).message) || e));
      }
      respond({ jsonrpc: '2.0', id, result: { bye: true } });
      rl.close();
      return;
    }
    const fixed = methods[method];
    if (fixed) {
      const result = await fixed(params);
      return respond({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    }
    respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) {
    respond({ jsonrpc: '2.0', id, error: { code: -32000, message: String(((e as Error).message) || e) } });
  }
}

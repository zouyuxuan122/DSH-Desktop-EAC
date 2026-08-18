'use strict';

// DSH Desktop — Electron shell around the DeepSeek Harness browser UI.
//
// What it does:
//   1. Boots the bundled dsh CLI ("dsh web") with a standalone Node runtime.
//   2. Waits until the web UI answers HTTP on 127.0.0.1:<free-port>.
//   3. Shows it in a native window; quits the server when the app exits.
//   4. Checks for official @deepseek-ai/dsh releases and, with the user's
//      consent, self-updates the agent (see updater.js).
//
// The dsh CLI is spawned with the bundled Node executable (vendor/node/node*
// in dev, resources/node/node* when packaged) so that prebuilt native
// modules (sharp, node-pty, koffi, ...) match the Node ABI they were
// installed for. We deliberately never rebuild them against Electron.

const { app, BrowserWindow, Menu, Tray, shell, dialog, Notification, ipcMain, clipboard } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const updater = require('./updater');
const clientUpdater = require('./client-updater');
const pluginUpdater = require('./plugin-updater');
const balance = require('./balance');
const { dshHomePath } = require('./dsh-home');
const { loadSettings, saveSettings } = require('./settings');
const { healProfileModuleShadowing } = require('./profile-module-heal');
const { createGuard } = require('./plugin-guard');
const bundleIntegrity = require('./bundle-integrity');
const { RendererRecovery } = require('./renderer-recovery');
const { restrictedPortOf, chooseStableWebPort } = require('./stable-port');
const { createWebServiceSupervisor } = require('./web-service-supervisor');
const { createShutdownCoordinator } = require('./shutdown-coordinator');
const { createProcessTree } = require('./platform/process-tree');
const { registerIpc } = require('./ipc/register-ipc');
const { createRuntimePatches } = require('./profile/runtime-patches');
const { createCompanionSync } = require('./profile/companion-sync');
const { createPluginManager } = require('./profile/plugin-manager');
const { createProfileGuard } = require('./profile/profile-guard');
const { createShortcutManager } = require('./platform/shortcuts');
const { createClientUpdateFlow } = require('./client-update-flow');
const {
  runKoffiPreflight,
  runKoffiPreflightAsync,
  enablePickerBrowseOverlay,
  clearAutoPickerBrowseOverlay,
} = require('./koffi-preflight');
const { configLinesFor, healSoulMdPatchRow, healRowConfig, healRowDisabled, removeBundledRowDuplicates, collectBundleEntryIds } = require('./patch-row-heal');
const { syncBundledPresets, ensureDefaultAgentPreset } = require('./preset-sync');
const { buildErrorDetail } = require('./error-detail');
const { SessionWatcher, scanZstdFrames } = require('./session-watcher');
const { patchSessionManage } = require('./scripts/patch-session-manage');
const { togglePluginInPatch, removePluginFromPatch, hasEntryId } = require('./scripts/plugin-manager-patch');
const { collectPluginRows } = require('./plugin-manager-state');
const onboardingLogic = require('./scripts/onboarding');
const {
  loadBuiltinPluginState,
  setBuiltinPluginState,
  clearBuiltinPluginState,
} = require('./builtin-plugin-state');
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// H2/H3 路径围栏：文件还原/打开只允许「会话 cwd」之下的项目文件。
// 任意绝对路径（如写入 Startup\*.bat）一律拒绝；缓存 5 分钟。
// ---------------------------------------------------------------------------
const DANGEROUS_EXT = /\.(bat|cmd|com|exe|ps1|vbs|lnk|js|jse|msi|scr|pif|reg)$/i;
const fileRootsCache = { at: 0, roots: [] };

function fileRoots() {
  if (Date.now() - fileRootsCache.at < 5 * 60 * 1000) return fileRootsCache.roots;
  const dshHome = dshHomePath();
  const roots = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'session.jsonl.zstd') continue;
      try {
        const buf = fs.readFileSync(p);
        const { frames } = scanZstdFrames(buf);
        if (frames.length === 0) continue;
        const text = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
        const header = JSON.parse(text.split('\n', 1)[0]);
        if (header && typeof header.cwd === 'string' && header.cwd) roots.push(header.cwd);
      } catch { /* 跳过损坏日志 */ }
    }
  };
  walk(path.join(dshHome, 'sessions'));
  fileRootsCache.roots = [...new Set(roots)];
  fileRootsCache.at = Date.now();
  return fileRootsCache.roots;
}

function isUnderFileRoots(p) {
  const resolved = path.resolve(p);
  return fileRoots().some((r) => {
    const rp = path.resolve(r);
    return resolved === rp || resolved.startsWith(rp + path.sep);
  });
}

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const APP_VERSION = app.getVersion();
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let serverProc = null;
let webServiceSupervisor = null;
let shutdownCoordinator = null;
let webUrl = null;
let quitting = false;
let updateBusy = false;
// V4 多窗口（会话浮窗，摘自上游 dsh_desktop）：同一会话只保留一个浮窗，
// 上限 8 个防资源滥用；主窗关闭/应用退出时统一回收。
const FLOAT_MAX = 8;
const floatWindows = new Set();
const floatBySession = new Map();
let notifyOnTurnEnd = true;
let sessionWatcher = null;
let userDataDir = '';
let logsDir = '';
let dshHome = '';
let desktopLog = null;
let tray = null;
let forceQuit = false;
let clientUpdateBusy = false;
let balanceCache = null;
let balanceTimer = null;
let restartingServer = false;
// V4 退出清理：当前正在执行的插件市场排队任务子进程（退出时强杀）。
let marketOpChild = null;
// 渲染进程崩溃/挂起自恢复状态机（renderer-recovery.js，上游 Issue #9 修复）。
let recovery = null;
// koffi 预检失败时注入的目录选择器降级 overlay 路径（koffi-preflight.js）。
let pickerBrowseOverlay = null;
// 集成测试钩子：DSH_DESKTOP_TEST_FORCE_UNSAFE=1 时把第一次探测到的端口强制
// 视为受限端口（6000），端到端验证「重启换端口」交接路径。
let testForceUnsafeOnce = process.env.DSH_DESKTOP_TEST_FORCE_UNSAFE === '1';

// ---------------------------------------------------------------------------
// 桌面专属 profile（与原生 CLI 彻底共存）：
//
// 历史冲突根因有二 ——
//   1. 桌面端把配套插件行/包直接写进原生 `web` profile，pnpm 安装、patch
//      行互踩，原生 CLI 跟着崩；
//   2. dsh-app-boot 会把 <home>/profiles/node_modules 的共享 junction 指向
//      「当前运行的 dsh 实例」自己的闭包 —— 原生 npx dsh 一跑，桌面端模块
//      解析被换血（版本错位 / npx 缓存清理后悬空）。
// 桌面端从此默认运行在独立 profile `web-desktop`（DSH_HOME 不变：会话、
// API Key、settings.yaml 依旧共享）；junction 归属由 plugin-guard 周期守卫。
// 旧共享模式仍可用（settings.shareWebProfile = true），仅供特殊需要。
// ---------------------------------------------------------------------------
const DESKTOP_PROFILE = 'web-desktop';
// 与官方 web profile 出厂模板一致（@deepseek-ai/dsh-base + dsh-web-app）。
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

function desktopProfile() {
  try {
    const s = updater.loadSettings(updCtx());
    return s.shareWebProfile === true ? 'web' : DESKTOP_PROFILE;
  } catch {
    return DESKTOP_PROFILE;
  }
}

function desktopProfileDir() {
  const home = dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', desktopProfile());
}

// 未知 profile 不会自动初始化（dsh 直接报错退出），桌面端自己按官方模板
// 创建：package.json（bundles）+ pnpm-workspace.yaml + 空 patch 层。
function ensureDesktopProfileInit() {
  try {
    const dir = desktopProfileDir();
    if (desktopProfile() === 'web') return; // 共享模式走官方模板
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(manifest, JSON.stringify({
        name: 'dsh-profile-' + desktopProfile(),
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
      }, null, 2) + '\n');
      log('boot', '已初始化桌面专属 profile: ' + dir);
    }
    if (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    }
    if (!fs.existsSync(path.join(dir, 'cordis.patch.yml'))) {
      fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n');
    }
  } catch (err) {
    log('boot', '初始化桌面 profile 失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 插件保护中心（plugin-guard.js）：快照 / 回滚 / 静态体检 / 自动修复 /
// 守护启动 / 事故报告。实例延迟创建（依赖 dshHome 与 settings 就绪）。
// ---------------------------------------------------------------------------
let guardInstance = null;
function ensureGuard() {
  if (!guardInstance) {
    guardInstance = createGuard({
      getHome: () => dshHome || path.join(os.homedir(), '.dsh'),
      getProfile: () => desktopProfile(),
      dshBin: () => dshBin(),
      log,
    });
  }
  return guardInstance;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(tag, msg) {
  // 本地时间 + 显式时区偏移：此前用 toISOString()（UTC），本地排查时易误判（issue #4）。
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    ` UTC${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  const line = `[${ts}] [${tag}] ${msg}\n`;
  try { if (desktopLog) desktopLog.write(line); } catch {}
  if (process.env.DSH_DESKTOP_DEBUG) process.stdout.write(line);
}

function nodeExe() {
  const executable = IS_WIN ? 'node.exe' : 'node';
  if (app.isPackaged) return path.join(process.resourcesPath, 'node', executable);
  return path.resolve(__dirname, 'vendor', 'node', executable);
}

function npmCli() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js');
  return path.resolve(__dirname, 'vendor', 'npm', 'bin', 'npm-cli.js');
}

// Context shared with the updater module.
function updCtx() {
  return { userDataDir, nodeExe, npmCli, log };
}

// Updated overlay (user-approved official release) takes precedence over the
// bundled copy; the bundled copy is the fallback.
function dshBin() {
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) return ov;
  return require.resolve('@deepseek-ai/dsh/lib/bin.js');
}

function dshVersion() { return updater.activeVersion(updCtx()) || '未知'; }

function dshVersionSource() {
  return updater.overlayVersion(updCtx()) ? '用户目录（已更新）' : '内置';
}

// 平台进程树唯一实现（platform/process-tree.js）：killTree / killTreeAndWait /
// waitForProcExit 由 web-service-supervisor、shutdown-coordinator、服务重启与
// 市场排队任务共用（依赖注入，见 web-service-supervisor.js / shutdown-coordinator.js）。
const processTree = createProcessTree({ log });
const { killTree, killTreeAndWait, waitForProcExit } = processTree;

// ---------------------------------------------------------------------------
// 退出/重启仪式（统一收口）。此前这段序列（quitting → 标记 cleanExit →
// 终结 dsh 子进程 → 重启/退出）在 agent 更新、恢复页面、客户端更新等
// 路径各写一遍，漏标任何一步（如 cleanExit）都会让看门狗误判为崩溃并
// 拉起旧实例。改动退出路径只改这两个函数。
// ---------------------------------------------------------------------------

function ensureShutdownCoordinator() {
  if (shutdownCoordinator) return shutdownCoordinator;
  shutdownCoordinator = createShutdownCoordinator({
    app,
    log,
    markCleanExit,
    setQuitting: (value) => { quitting = value; },
    setForceQuit: (value) => { forceQuit = value; },
    getServerProcess: () => serverProc,
    stopServerProcess: async (proc) => {
      await killTreeAndWait(proc);
      if (serverProc === proc) serverProc = null;
    },
    terminateChildTree: (child) => killTree(child),
    getMarketOpChild: () => marketOpChild,
    closeAllFloatWindows,
    abortUpdater: () => updater.abort(),
    stopSessionWatcher: () => { if (sessionWatcher) sessionWatcher.stop(); },
    clearBalanceTimer: () => {
      if (balanceTimer) clearInterval(balanceTimer);
      balanceTimer = null;
    },
    destroyTray: () => {
      if (tray) { try { tray.destroy(); } catch {} tray = null; }
    },
    applyClientUpdate: (ctx, pendingUpdate) => clientUpdater.applyUpdate(ctx, pendingUpdate),
  });
  return shutdownCoordinator;
}

// 干净退出并重启应用。应用级的服务回收和看门狗标记统一由协调器负责。
function restartApp(opts = {}) {
  return ensureShutdownCoordinator().restartApp(opts);
}

// 客户端（封装）更新专用：停止服务后交给更新脚本接管，避免新旧实例竞争。
function restartWithClientUpdate(ctx, pendingUpdate) {
  return ensureShutdownCoordinator().restartWithClientUpdate(ctx, pendingUpdate);
}

// ---------------------------------------------------------------------------
// 运行状态标记 + 看门狗（上游集成：防「进程/托盘凭空消失且无任何提醒」）。
// run-state.json 由主进程维护；watchdog.js 以分离的 Node 进程轮询父 PID：
//   cleanExit=true → 用户主动退出/更新，看门狗安静退出；
//   有更新实例接管 → 旧看门狗退出；
//   否则视为意外崩溃 → 拉起应用（10 分钟内最多 5 次）。
// ---------------------------------------------------------------------------

function runStatePath() {
  return path.join(userDataDir, 'run-state.json');
}

function writeRunState(extra = {}) {
  try {
    fs.writeFileSync(runStatePath(), JSON.stringify({
      pid: process.pid,
      exe: process.execPath,
      cleanExit: false,
      startedAt: new Date().toISOString(),
      version: APP_VERSION,
      ...extra,
    }));
  } catch (err) {
    log('watchdog', '写运行状态失败: ' + err.message);
  }
}

function markCleanExit() {
  try {
    const p = runStatePath();
    let state = {};
    try { state = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    state.cleanExit = true;
    state.endedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(state));
  } catch (err) {
    log('watchdog', '写退出标记失败: ' + err.message);
  }
}

function detectUncleanPreviousRun() {
  try {
    const prev = JSON.parse(fs.readFileSync(runStatePath(), 'utf8'));
    if (prev && prev.cleanExit !== true && prev.pid && Number(prev.pid) !== process.pid) {
      log('crash', '检测到上次运行未正常退出: ' + JSON.stringify(prev));
      return prev;
    }
  } catch {}
  return null;
}

function notifyUncleanRestart(prev) {
  try {
    const started = prev && prev.startedAt ? new Date(prev.startedAt) : null;
    const when = started && !Number.isNaN(started.getTime())
      ? started.toLocaleString('zh-CN', { hour12: false })
      : '上次';
    const n = new Notification({
      title: 'Deepseek Harness EAC 已自动恢复',
      body: `检测到应用在 ${when} 前后未正常退出，看门狗已重新启动应用。`,
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    n.on('click', () => showMainWindow());
    n.show();
  } catch (err) {
    log('crash', '恢复通知发送失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 客户端更新崩溃自回退（V4.1 更新保障③）：便携版更新脚本在成功替换后保留
// 上一版 exe（%EXE%.bak）并写 marker；新版若崩溃（上次运行非干净退出且
// marker 仍在 —— marker 只在健康启动成功链上被清），下次启动自动用上一版
// 还原。崩溃副本留作诊断，另发系统通知告知。
// ---------------------------------------------------------------------------
function clientBackupPaths() {
  if (!process.env.PORTABLE_EXECUTABLE_FILE) return null;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  return { exe, bak: exe + '.bak', marker: exe + '.bak.marker' };
}

function autoRollbackClientIfCrashed(prevUnclean) {
  const p = clientBackupPaths();
  if (!p || !prevUnclean) return false;
  if (!fs.existsSync(p.bak) || !fs.existsSync(p.marker)) return false;
  try {
    fs.copyFileSync(p.exe, p.exe + '.crash-' + Date.now());
    fs.copyFileSync(p.bak, p.exe);
    fs.rmSync(p.marker, { force: true });
    log('client-update', '检测到客户端更新后启动失败，已自动回退到上一版本');
    try {
      const n = new Notification({
        title: 'Deepseek Harness EAC 已自动回退',
        body: '更新后的版本启动失败，已自动回退到上一版本并保留崩溃副本。',
        icon: path.join(__dirname, 'assets', 'icon.png'),
      });
      n.on('click', () => showMainWindow());
      n.show();
    } catch (err) {
      log('client-update', '回退通知发送失败: ' + err.message);
    }
    return true;
  } catch (err) {
    log('client-update', '自动回退失败: ' + err.message);
    return false;
  }
}

// 新版健康启动（boot 成功链）后调用：清理上一版备份与 marker。
function cleanupClientBackupIfHealthy() {
  const p = clientBackupPaths();
  if (!p || !fs.existsSync(p.marker)) return;
  try {
    fs.rmSync(p.bak, { force: true });
    fs.rmSync(p.marker, { force: true });
    log('client-update', '新版启动确认健康，已清理上一版备份');
  } catch (err) {
    log('client-update', '清理上一版备份失败: ' + err.message);
  }
}

function startWatchdog() {
  // 仅安装版启用：开发模式下重启 Electron 会与调试流程互相干扰。
  if (!app.isPackaged || !IS_WIN) return;
  const watchdogJs = path.join(__dirname, 'watchdog.js');
  if (!fs.existsSync(watchdogJs)) return;
  try {
    const child = spawn(nodeExe(), [
      watchdogJs,
      '--pid=' + process.pid,
      '--exe=' + process.execPath,
      '--state=' + runStatePath(),
      '--log=' + path.join(logsDir, 'watchdog.log'),
    ], {
      cwd: path.dirname(process.execPath),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    log('watchdog', `看门狗已启动 pid=${child.pid}`);
  } catch (err) {
    log('watchdog', '看门狗启动失败: ' + err.message);
  }
}

// Environment for the dsh child: drop harness/session leftovers so the
// desktop instance boots clean, keep everything else (proxy, API keys, ...).
function childEnv() {
  const env = { ...process.env };
  for (const k of ['DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_SHELL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    delete env[k];
  }
  if (dshHome) env.DSH_HOME = dshHome;
  // 桌面端标记 + 实际 profile：配套插件的 host 半边（插件市场 / Skills 与
  // MCP 等）据此把安装/读写落到桌面专属 profile，而不是原生的 web profile。
  env.DSH_DESKTOP = '1';
  env.DSH_DESKTOP_PROFILE = desktopProfile();
  env.NO_COLOR = '1';
  return env;
}

// waitForProcExit 已随进程树抽取到 platform/process-tree.js（supervisor 经依赖注入使用）。

function showBox(opts) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, opts);
  return dialog.showMessageBox(opts);
}

// H1（共享给主窗/浮窗）：origin 精确比较（protocol+host+port），杜绝前缀/
// 异域/userinfo 逃逸；file: 一律拦截（同 webContents 下 file 页面仍持有
// preload 桥）。
function isAllowedWebUrl(url) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    if (webUrl) {
      const base = new URL(webUrl);
      return target.origin === base.origin;
    }
    return target.hostname === '127.0.0.1' || target.hostname === 'localhost' || target.hostname === '::1';
  } catch {
    return false;
  }
}

// V4（用户反馈）：浏览器风格的右键菜单。Electron 不展示 Chromium 的内置
// 右键菜单，需在 webContents 的 context-menu 事件自建：
//   · 可编辑区（输入框/编辑器）→ 撤销/重做/剪切/复制/粘贴/删除/全选
//     （role 菜单自动路由到焦点渲染进程的编辑器，enabled 用 editFlags
//     精确反映可操作性）；
//   · 图片 → 复制图片 / 图片另存为…；
//   · 选中文本 → 复制 / 全选；
//   · 其余页面区域 → 后退/前进/重新加载（浏览器同款导航段）。
// 页面自绘右键交互（DOM contextmenu 已处理并 preventDefault 时，
// params 仍会派发）—— Web UI 目前未使用原生右键，无冲突。
function attachEditContextMenu(wc) {
  wc.on('context-menu', (_e, params) => {
    const flags = params.editFlags || {};
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || win.isDestroyed()) return;
    let template = null;
    if (params.isEditable) {
      template = [
        { label: '撤销', role: 'undo', accelerator: 'Ctrl+Z', enabled: flags.canUndo !== false },
        { label: '重做', role: 'redo', accelerator: 'Ctrl+Y', enabled: flags.canRedo !== false },
        { type: 'separator' },
        { label: '剪切', role: 'cut', accelerator: 'Ctrl+X', enabled: flags.canCut !== false },
        { label: '复制', role: 'copy', accelerator: 'Ctrl+C', enabled: flags.canCopy !== false },
        { label: '粘贴', role: 'paste', accelerator: 'Ctrl+V', enabled: flags.canPaste !== false },
        { label: '删除', role: 'delete', enabled: flags.canDelete !== false },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', accelerator: 'Ctrl+A' },
      ];
    } else if (params.mediaType === 'image' && params.srcURL) {
      template = [
        { label: '复制图片', click: () => { try { wc.copyImageAt(params.x, params.y); } catch {} } },
        { label: '图片另存为…', click: () => { try { wc.downloadURL(params.srcURL); } catch {} } },
      ];
      if (flags.canCopy) {
        template.push({ type: 'separator' }, { label: '复制', role: 'copy', accelerator: 'Ctrl+C' });
      }
    } else if (flags.canCopy) {
      template = [
        { label: '后退', role: 'back', enabled: wc.navigationHistory.canGoBack?.() ?? wc.canGoBack() },
        { label: '前进', role: 'forward', enabled: wc.navigationHistory.canGoForward?.() ?? wc.canGoForward() },
        { label: '重新加载', role: 'reload', accelerator: 'Ctrl+R' },
        { type: 'separator' },
        { label: '复制', role: 'copy', accelerator: 'Ctrl+C' },
        { label: '全选', role: 'selectAll', accelerator: 'Ctrl+A' },
      ];
    } else {
      template = [
        { label: '后退', role: 'back', enabled: wc.navigationHistory.canGoBack?.() ?? wc.canGoBack() },
        { label: '前进', role: 'forward', enabled: wc.navigationHistory.canGoForward?.() ?? wc.canGoForward() },
        { label: '重新加载', role: 'reload', accelerator: 'Ctrl+R' },
      ];
    }
    if (template && template.length) {
      Menu.buildFromTemplate(template).popup({ window: win, x: params.x, y: params.y });
    }
  });
}

// ---------------------------------------------------------------------------
// dsh web server lifecycle
// ---------------------------------------------------------------------------

// stable-port.js 的依赖注入适配器：把 settings 读写桥接过去。
function stablePortCtx() {
  const c = updCtx();
  return {
    loadSettings: () => loadSettings(c),
    saveSettings: (_ctx, s) => saveSettings(c, s),
  };
}

function ensureWebServiceSupervisor() {
  if (webServiceSupervisor) return webServiceSupervisor;
  webServiceSupervisor = createWebServiceSupervisor({
    app,
    spawn,
    nodeExe,
    dshBin,
    childEnv,
    desktopProfile,
    desktopProfileDir,
    userDataDir,
    getLogsDir: () => logsDir,
    chooseStableWebPort,
    stablePortCtx,
    restrictedPortOf,
    overrideAnnouncedPort: () => {
      if (!testForceUnsafeOnce) return 0;
      testForceUnsafeOnce = false;
      return 6000;
    },
    loadSettings,
    saveSettings,
    updCtx,
    killTree,
    waitForProcExit,
    isQuitting: () => quitting,
    isRestarting: () => restartingServer,
    onProcessChanged: (proc) => { serverProc = proc; },
    onUnexpectedExit: ({ logPath: serviceLogPath }) => {
      if (!webUrl || !mainWindow || mainWindow.isDestroyed()) return;
      showBox({
        type: 'error',
        title: 'DSH 服务已停止',
        message: 'DeepSeek Harness 服务意外退出。',
        detail: `日志文件：${serviceLogPath}`,
        buttons: ['重新启动', '退出'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) startAndShow().catch((err) => handleBootFailure(err));
        else app.quit();
      });
    },
    log,
  });
  return webServiceSupervisor;
}

function startServer(unsafePortRetries = 4, overlays = []) {
  return ensureWebServiceSupervisor().start(unsafePortRetries, overlays);
}

function waitUntilUp(url, timeoutMs = 120000) {
  return ensureWebServiceSupervisor().waitUntilUp(url, timeoutMs);
}

function startAndShow(overlays = []) {
  // koffi 预检失败注入的目录选择器降级 overlay 一并交给 dsh web（--patch）。
  const merged = [];
  if (pickerBrowseOverlay && fs.existsSync(pickerBrowseOverlay)) merged.push(pickerBrowseOverlay);
  for (const p of overlays) {
    if (typeof p === 'string' && p && fs.existsSync(p) && !merged.includes(p)) merged.push(p);
  }
  return startServer(4, merged)
    .then(waitUntilUp)
    .then((url) => {
      webUrl = url;
      log('boot', 'Web UI 就绪: ' + url);
      if (mainWindow && !mainWindow.isDestroyed()) {
        return mainWindow.loadURL(url).then(() => url);
      }
      return url;
    });
}

// 守护启动（plugin-guard.js）：快照 → 拉起 → 失败则体检/修复/回滚再试，
// 仍失败落事故报告。调用方统一走这里，用户不再面对「装完插件起不来」。
async function startAndShowGuarded(overlays = []) {
  const g = ensureGuard();
  // 回滚分支的重试也要能更新「最后良好」标记（restore 会留 pre-restore 快照，
  // 成功拉起后它就是最新一份 = 当前良好状态）。
  g.setRollbackLift(async () => {
    const url = await startAndShow(overlays);
    const snaps = g.listSnapshots();
    if (snaps.length) g.markGood(snaps[0].id);
    return url;
  });
  return g.guardedBoot(
    () => startAndShow(overlays),
    () => '日志文件：' + path.join(logsDir, 'dsh-web.log'),
    // V4.2：pnpm 封锁构建脚本会让整棵 profile 起不来 —— 这是配置级问题，
    // 体检（只扫插件层）发现不了，必须走 preRetry 钩子自动放行后重试。
    { preRetry: allowBuildsPreRetry }
  );
}

// V4.2：启动失败链的 pnpm allowBuilds 自动放行钩子（preRetry）。
// 解析错误文案 + dsh-web.log 尾部，命中被封锁的包名就写入 profile 的
// pnpm-workspace.yaml（allowBuilds / onlyBuiltDependencies），返回
// { applied } 交给守护启动合并进修复项后重试一次。
async function allowBuildsPreRetry(errText) {
  try {
    const ab = await allowBuilds();
    if (typeof ab.parseBlockedBuildKeys !== 'function') return false;
    const keys = ab.parseBlockedBuildKeys(String(errText || ''));
    // 报错详情可能只落在 dsh-web.log 里，补充解析尾部。
    try {
      const tail = fs.readFileSync(path.join(logsDir, 'dsh-web.log'), 'utf8').slice(-40000);
      for (const k of ab.parseBlockedBuildKeys(tail)) {
        if (!keys.includes(k)) keys.push(k);
      }
    } catch {}
    if (keys.length === 0) return false;
    const r = await ab.ensureAllowBuilds(path.join(desktopProfileDir(), 'pnpm-workspace.yaml'), keys);
    if (!r || !r.wrote) return false;
    log('guard', '[allowBuilds] 启动失败疑似 pnpm 封锁构建脚本，已自动放行: ' + r.added.join(', '));
    return { applied: ['pnpm allowBuilds 自动放行: ' + r.added.join(', ')] };
  } catch (err) {
    log('guard', '[allowBuilds] 预检失败: ' + String((err && err.message) || err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// koffi 预检与目录选择器降级（koffi-preflight.js）：koffi 3.1.3/3.1.4 的
// win32-x64 预编译二进制在部分 Windows 机器上会在 load 时原生崩溃
// （0xC0000005），目录选择器 worker 无消息退出。启动前用内置 node 在子
// 进程里做一次 FFI 冒烟；失败则注入 browse 后端 overlay。
// ---------------------------------------------------------------------------
function pickerBrowseOverlayPath() {
  return path.join(userDataDir, 'picker-browse.overlay.yml');
}

function preflightLogger(msg) {
  log('preflight', msg);
}

function applyKoffiPreflight() {
  const file = pickerBrowseOverlayPath();
  const ok = runKoffiPreflight({
    spawnSync,
    nodeExe: nodeExe(),
    script: path.join(__dirname, 'scripts', 'koffi-preflight.cjs'),
    log: preflightLogger,
  });
  if (ok) {
    clearAutoPickerBrowseOverlay({ file, log: preflightLogger });
    pickerBrowseOverlay = null;
  } else {
    pickerBrowseOverlay = enablePickerBrowseOverlay({ file, log: preflightLogger });
  }
  return ok;
}

// V4：异步版（spawn 而非 spawnSync）—— 同步探针会把主进程事件循环卡住
// 最长 20 秒（托盘/菜单/IPC 全无响应）。boot 链改走这里，语义不变。
function applyKoffiPreflightAsync() {
  const file = pickerBrowseOverlayPath();
  return runKoffiPreflightAsync({
    spawn,
    nodeExe: nodeExe(),
    script: path.join(__dirname, 'scripts', 'koffi-preflight.cjs'),
    log: preflightLogger,
  }).then((ok) => {
    if (ok) {
      clearAutoPickerBrowseOverlay({ file, log: preflightLogger });
      pickerBrowseOverlay = null;
    } else {
      pickerBrowseOverlay = enablePickerBrowseOverlay({ file, log: preflightLogger });
    }
    return ok;
  });
}

function handleBootFailure(err) {
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) {
    // V4.1 更新保障②：上次更新保留的上一版本备份可用时，优先提供
    // 「回退到上一版本」（比退回内置版更贴近用户原状态）。
    const prev = updater.previousAgentInfo(updCtx());
    // V4.2 插件即时提醒：报错文案归因到 profile 里的插件时，提供
    // 「停用插件 X 并重试」（写盘停用，重启不还原）；另有最后良好快照时
    // 提供「回滚到最后良好快照并重试」。两项都失败才轮到版本级回退。
    let blame = null;
    let blameRow = null;
    try {
      const g = ensureGuard();
      if (typeof g.attributeBootFailure === 'function') {
        blame = g.attributeBootFailure(String((err && err.message) || err));
      }
      if (blame) {
        try {
          blameRow = pluginManagerCollect().find((r) => r.id === blame.rowId) || null;
        } catch { blameRow = null; }
      }
    } catch {}
    const lastGood = (() => { try { return ensureGuard().lastGoodSnapshot(); } catch { return null; } })();
    const btnDisable = blameRow && blameRow.toggleable ? '停用插件 ' + blameRow.name + ' 并重试' : null;
    const btnRollback = lastGood ? '回滚到最后良好快照并重试' : null;
    const buttons = [
      ...(btnDisable ? [btnDisable] : []),
      ...(btnRollback ? [btnRollback] : []),
      ...(prev ? ['回退到上一版本并重试', '回退到内置版本', '重试', '退出'] : ['回退到内置版本并重试', '重试', '退出']),
    ];
    const detailLines = [String((err && err.message) || err)];
    if (blame) {
      detailLines.push('', `报错指向插件「${blame.name}」（${blame.kind === 'patchRow' ? 'patch 行 ' + blame.rowId : blame.kind}），可先停用该插件后重试。`);
    }
    if (lastGood) {
      detailLines.push(`存在最后良好快照（${lastGood.reason || lastGood.id}），可一键回滚后重试。`);
    }
    if (prev) detailLines.push('', `可回退到上一版本（v${prev.version}）或内置版本继续使用。`);
    else detailLines.push('', '可回退到内置版本继续使用。');
    showBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: prev ? '更新后的 agent 无法启动。' : 'DeepSeek Harness 无法启动。',
      detail: detailLines.join('\n'),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    }).then(({ response }) => {
      let i = 0;
      const take = () => i++;
      // 归因到插件时，优先给「停用插件」——
      if (btnDisable && response === take()) {
        try {
          pluginManagerSetEnabled(blameRow.id, false);
          log('plugin-manager', `启动失败后停用插件: ${blameRow.id}`);
        } catch (e2) { log('plugin-manager', '停用插件失败: ' + ((e2 && e2.message) || e2)); }
        startAndShow().catch((e2) => handleBootFailure(e2));
        return;
      }
      if (btnRollback && response === take()) {
        try {
          ensureGuard().restore(lastGood.id);
        } catch (e2) { log('guard', '回滚快照失败: ' + ((e2 && e2.message) || e2)); }
        startAndShow().catch((e2) => handleBootFailure(e2));
        return;
      }
      if (prev && response === take()) {
        updater.rollbackToPrevious(updCtx());
        startAndShow().catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
      } else if ((prev && response === take()) || (!prev && response === take())) {
        updater.rollback(updCtx());
        startAndShow().catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
      } else if ((prev && response === take()) || (!prev && response === take())) {
        startAndShow().catch((e2) => handleBootFailure(e2));
      } else {
        app.quit();
      }
    });
  } else {
    fatal('Deepseek Harness 启动失败', err);
  }
  // dsh web 起不来（如 v3.0.0 schemastery 闭包缺陷）的用户永远走不到
  // 成功链上的自动更新定时器，只能手动重装。主动查一次客户端更新，
  // manual=true 绕过 skip/稍后 抑制，让修复版本能下载并自愈。
  scheduleClientUpdateRescue();
}

// 启动失败救援（防重入）：一次会话只主动查一次，避免与用户的重试操作
// 互相干扰；网络失败不打扰（runClientUpdateFlow 的 manual 弹窗已够）。
let clientUpdateRescueArmed = false;
function scheduleClientUpdateRescue() {
  if (clientUpdateRescueArmed || process.env.DSH_DESKTOP_SKIP_CLIENT_UPDATE) return;
  clientUpdateRescueArmed = true;
  setTimeout(() => {
    runClientUpdateFlow(true).catch((e) => log('client-update', '救援检查失败: ' + e.message));
  }, 5000).unref();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

// Windows/Linux 的全部功能由自绘 chrome 与托盘提供，不保留原生菜单栏。
function installAppMenu() {
  Menu.setApplicationMenu(null);
}

function createWindow({ startHidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Deepseek Harness EAC',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // 风格化无边框窗口：去掉原生标题栏/菜单栏，自绘玻璃栏 + Win11 原生圆角。
    ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'assets', 'loading.html'));
  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show(); });
  // Keep the app brand in the OS title bar (the web UI sets its own <title>).
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle('Deepseek Harness EAC');
  });

  // Open target=_blank / window.open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the app pinned to the local web UI; send external links out.
  // H1 修复：origin 精确比较（protocol+host+port），杜绝前缀/异域/userinfo 逃逸；
  // file: 一律拦截（同 webContents 下 file 页面仍持有 preload 桥）；will-redirect 同规则。
  const guardNavigation = (event, url) => {
    if (isAllowedWebUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);

  // 渲染进程错误捕获：插件/页面异常统一落到 desktop.log，便于排查空白视图。
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level === 'error' || level === 'warning') {
      log('page', `[${level}] ${message} (${sourceId || 'unknown'}:${line})`);
    }
  });
  // V4：浏览器风格右键菜单（编辑/图片/选区/导航四类场景）。
  attachEditContextMenu(mainWindow.webContents);
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('page', `渲染进程异常退出: ${details.reason} (exitCode=${details.exitCode})`);
  });

  // 移除菜单栏后仍保留的键盘快捷键。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (input.key === 'F11') { mainWindow.setFullScreen(!mainWindow.isFullScreen()); event.preventDefault(); }
    else if (input.key === 'F12') { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
    else if (input.control && input.shift && key === 'i') { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
    else if (input.control && key === 'r') { reloadMainWindow(); event.preventDefault(); }
    else if (input.alt && key === 'f4') { mainWindow.close(); event.preventDefault(); }
  });

  // 自绘最大化/还原按钮需要感知窗口状态。
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);
  mainWindow.on('enter-full-screen', sendMaxState);
  mainWindow.on('leave-full-screen', sendMaxState);

  // 关闭 → 按退出行为设置处理：ask 弹窗询问 / minimize 隐藏到托盘 / quit 退出。
  mainWindow.on('close', async (event) => {
    if (forceQuit || !IS_WIN || !tray) return;
    event.preventDefault();
    const action = getExitAction();
    let choice = action;
    if (action === 'ask') {
      choice = await askExitAction();
      // 弹窗期间用户可能已通过菜单真正退出（quitting/forceQuit 置位）。
      if (forceQuit || quitting) return;
    }
    if (choice === 'minimize') {
      mainWindow.hide();
      trayHintOnce();
    } else {
      forceQuit = true;
      app.quit();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 渲染进程崩溃/挂起的自恢复由 renderer-recovery.js 统一接管（保留上方
  // render-process-gone 的日志 handler，二者互补：一个记录、一个恢复）。
  wireWindowRecovery();
}

// ---------------------------------------------------------------------------
// 会话浮窗（V4 多窗口，移植自上游 dsh_desktop）：把某个会话弹出到独立
// 窗口实现分屏多任务。同一会话只保留一个浮窗，全局上限 FLOAT_MAX；浮窗
// 与主窗使用独立 partition（localStorage 隔离，避免互相覆盖当前会话选中
// 态）；preload 以 --dsh-float=<sessionId> 识别浮窗模式，注入更细的拖拽条。
// ---------------------------------------------------------------------------

function guardFloatWebContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (isAllowedWebUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  wc.on('will-navigate', guardNavigation);
  wc.on('will-redirect', guardNavigation);
  wc.on('console-message', (details, level, message, line, sourceId) => {
    const text = (details && details.message) || message || '';
    const lvl = (details && details.level) || level;
    const src = (details && details.sourceId) || sourceId || 'unknown';
    const lineNo = (details && details.lineNumber) ?? line;
    if (lvl === 'error' || lvl === 3 || lvl === 'warning' || lvl === 2 || /\[dsh-float-window\]/.test(text)) {
      log('float-page', `[${lvl}] ${text} (${src}:${lineNo})`);
    }
  });
}

// 创建并登记一个会话浮窗。返回 BrowserWindow；失败返回 null。
function createFloatWindow(sessionId, { title } = {}) {
  if (!webUrl || floatWindows.size >= FLOAT_MAX) return null;
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: title || 'DSH 会话',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // 与主窗一致的无边框；浮窗 preload 注入一条更细的纯拖拽条。
    ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 独立分区：浮窗与主窗隔离 localStorage，避免互相覆盖 dsh.sessions.current。
      // 会话数据在服务端（~/.dsh），localStorage 仅存 UI 选中态，无 cookie 认证。
      partition: 'persist:dsh-float',
      // 用 additionalArguments 而非 URL 参数，避免污染 Web UI 见到的地址；
      // preload 从 process.argv 读取 --dsh-float=<sessionId>。
      additionalArguments: ['--dsh-float=' + sessionId],
    },
  });
  floatWindows.add(win);
  floatBySession.set(sessionId, win);
  win.loadURL(webUrl).catch((err) => log('float', '浮窗加载失败: ' + ((err && err.message) || err)));

  // 窗口标题跟随会话（去掉通用前缀，保留会话相关标题）。
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    const raw = String(event.title || win.getTitle() || '');
    const cleaned = raw.replace(/^(DSH|Deepseek Harness EAC)[·\-—\s:]*/i, '').trim();
    win.setTitle(cleaned || 'DSH 会话');
  });

  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('closed', () => {
    floatWindows.delete(win);
    for (const [sid, w] of floatBySession) {
      if (w === win) { floatBySession.delete(sid); break; }
    }
  });
  guardFloatWebContents(win.webContents);
  attachEditContextMenu(win.webContents);
  if (recovery) recovery.attach(win, 'float');
  log('float', '已创建会话浮窗 sessionId=' + sessionId);
  return win;
}

// ---------------------------------------------------------------------------
// 内置插件选择向导（首次启动 first 模式 / 设置页二次打开 rerun 模式）
// ---------------------------------------------------------------------------

let wizardWindow = null;
let wizardMode = 'first';
let wizardDone = null;

function closeWizard(result) {
  const cb = wizardDone;
  wizardDone = null;
  if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.destroy();
  wizardWindow = null;
  if (cb) cb(result);
}

// 包目录体积（递归字节数，带缓存）。首次同步前 assets 尚未落盘到 profile，
// 以分发目录为准展示体积提示。
const pluginDirSizeCache = new Map();
function pluginDirSize(dirName) {
  if (pluginDirSizeCache.has(dirName)) return pluginDirSizeCache.get(dirName);
  let total = 0;
  try {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      }
    };
    walk(path.join(__dirname, 'assets', 'plugins', dirName));
  } catch {}
  pluginDirSizeCache.set(dirName, total);
  return total;
}

// 向导目录：核心/推荐标记 + 描述 + 包体积（数据来源与 sync 保持一致）。
function buildOnboardingCatalog() {
  return onboardingLogic.buildCatalog(COMPANION_PLUGINS, {
    coreIds: onboardingLogic.CORE_PLUGIN_IDS,
    recommendedIds: onboardingLogic.RECOMMENDED_PLUGIN_IDS,
    describe: (name) => pluginManagerPackageDescription(name),
    dirSize: (dirName) => pluginDirSize(dirName),
  });
}

// patch + 注册表 → 各内置插件当前启用状态（rerun 模式预填勾选用）。
function pluginCurrentState() {
  const { entries } = pluginManagerReadPatch();
  return onboardingLogic.pluginCurrentState(entries, COMPANION_PLUGINS);
}

// 打开向导窗口。返回 Promise：提交（{ok:true, applied, errors}）或关闭
// （{ok:false, cancelled:true}）时 resolve；窗口已存在时聚焦并直接 resolve。
function openPluginWizard({ mode = 'first' } = {}) {
  return new Promise((resolve) => {
    if (wizardWindow && !wizardWindow.isDestroyed()) {
      wizardWindow.focus();
      resolve({ ok: false, cancelled: true });
      return;
    }
    wizardMode = mode === 'rerun' ? 'rerun' : 'first';
    wizardDone = resolve;
    const win = new BrowserWindow({
      width: 920,
      height: 700,
      minWidth: 640,
      minHeight: 520,
      show: false,
      title: '内置插件选择向导',
      backgroundColor: '#0b1220',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'assets', 'onboarding-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    wizardWindow = win;
    win.loadFile(path.join(__dirname, 'assets', 'onboarding.html'));
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.on('closed', () => {
      const cb = wizardDone;
      wizardDone = null;
      wizardWindow = null;
      if (cb) cb({ ok: false, cancelled: true });
    });
    log('boot', '已打开内置插件选择向导（' + wizardMode + ' 模式）');
  });
}

// 启动门控：全新用户展示向导并等待提交；升级用户静默跳过并记完成标记。
// 关闭向导（取消）= 保持全部启用（等价老用户现状），只记完成标记不再打扰。
// onboardingNeeded 必须在任何写盘之前由 computeOnboardingNeed 预计算：
// settings.json 会在启动早期被迁移流程无条件创建，事后无法区分新老用户。
async function runPluginOnboardingIfNeeded(onboardingNeeded) {
  if (!onboardingNeeded) {
    const settings = updater.loadSettings(updCtx());
    if (!settings.pluginOnboardingDone) {
      settings.pluginOnboardingDone = true;
      updater.saveSettings(updCtx(), settings);
      log('boot', '升级用户：跳过插件选择向导，插件保持全量现状');
    }
    return { ran: false };
  }
  log('boot', '全新用户：展示内置插件选择向导');
  const result = await openPluginWizard({ mode: 'first' });
  if (!result.ok) {
    const s = updater.loadSettings(updCtx());
    s.pluginOnboardingDone = true;
    updater.saveSettings(updCtx(), s);
    log('boot', '用户关闭插件选择向导：保持全部插件启用');
  }
  return { ran: true, ...result };
}

// 关闭全部浮窗（应用退出时调用）。
function closeAllFloatWindows() {
  for (const win of floatWindows) {
    if (!win.isDestroyed()) win.destroy();
  }
  floatWindows.clear();
  floatBySession.clear();
}

// ---------------------------------------------------------------------------
// 渲染进程自恢复：装配 renderer-recovery 状态机（上游 Issue #9 根治修复）
// ---------------------------------------------------------------------------

function initRendererRecovery() {
  if (recovery) return recovery;
  const opts = {
    log: (msg) => log('recovery', msg),
    isQuitting: () => quitting,
    isServerAlive: () => !!serverProc && serverProc.exitCode === null && !serverProc.killed,
    getTarget: () => (webUrl ? { kind: 'url', url: webUrl } : null),
    loadingPage: path.join(__dirname, 'assets', 'loading.html'),
    recoveryPage: path.join(__dirname, 'assets', 'recovery.html'),
    rebuildMainWindow: ({ startHidden } = {}) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      createWindow({ startHidden: !!startHidden });
      return mainWindow;
    },
    waitServerUp: (maxMs) => {
      if (!webUrl) return Promise.reject(new Error('webUrl 未知'));
      return waitUntilUp(webUrl, maxMs);
    },
    onGaveUp: (lastFailure) => {
      writeRunState({ renderer: { state: 'gave-up', lastFailure, at: new Date().toISOString() } });
    },
    onStable: () => {
      writeRunState({ renderer: { state: 'healthy', at: new Date().toISOString() } });
    },
    notify: (title, body) => {
      try {
        const n = new Notification({
          title,
          body,
          icon: path.join(__dirname, 'assets', 'icon.png'),
        });
        n.on('click', () => showMainWindow());
        n.show();
      } catch (err) {
        log('recovery', '通知发送失败: ' + err.message);
      }
    },
  };
  recovery = new RendererRecovery(opts);
  return recovery;
}

function wireWindowRecovery() {
  if (recovery && mainWindow && !mainWindow.isDestroyed()) recovery.attach(mainWindow, 'main');
}

function startHeartbeatLoop() {
  // renderer 心跳由 preload 每 5s 上报；这里周期性判定「可见窗口」是否失联
  // （窗口不可见时页面定时器被节流，判定只针对可见窗口）。
  setInterval(() => { if (recovery) recovery.checkHeartbeats(); }, 15000).unref();
}

// 统一的「重新加载」入口：处于恢复页（已放弃自动恢复）时走恢复流程，
// 否则普通 reload。菜单与 Ctrl+R 共用。
function reloadMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const st = recovery ? recovery.stateOf(mainWindow) : null;
  if (st && st.gaveUp) {
    log('recovery', '用户在恢复页触发重新加载');
    recovery.retryNow(mainWindow);
    return;
  }
  mainWindow.reload();
}

function fatal(title, err) {
  log('fatal', title + ': ' + ((err && (err.stack || err.message)) || err));
  const detail = buildErrorDetail(err, logsDir, ['dsh-web.log', 'desktop.log']);
  if (!mainWindow || mainWindow.isDestroyed()) {
    dialog.showMessageBox({
      type: 'error',
      title,
      message: title,
      detail,
      buttons: ['复制日志', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) clipboard.writeText(detail);
      markCleanExit(); // 启动失败属已知退出：避免看门狗反复拉起反复失败
      app.exit(1);
    });
    return;
  }
  showBox({
    type: 'error',
    title,
    message: title,
    detail,
    buttons: ['复制日志', '重试', '退出'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }).then(({ response }) => {
    if (response === 0) clipboard.writeText(detail);
    else if (response === 1) startAndShow().catch((err2) => handleBootFailure(err2));
    else app.quit();
  });
}

// ---------------------------------------------------------------------------
// Self-update flow (official @deepseek-ai/dsh releases, user-consented)
// ---------------------------------------------------------------------------

function showUpdateWindow(version, kind = 'agent') {
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: true,
    title: '正在更新',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'assets', 'updating.html')).then(() => {
    win.webContents
      .executeJavaScript(`window.__init && window.__init(${JSON.stringify({ version, kind })})`)
      .catch(() => {});
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

// 更新弹窗进度推送（agent / client 共用）：把结构化进度渲染成文案，节流后
// 注入 updating.html 的 __setProgress(pct, receivedMB, totalMB, meta)。
// meta = { stage, speedMBps, etaSec } —— stage 为文案时进度条走不定态。
function makeUpdateProgressPusher(win) {
  let last = 0;
  const hostOf = (registry) => {
    try { return String(registry || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''); } catch { return ''; }
  };
  const push = (payload) => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    if (now - last < 300 && !payload.force) return;
    last = now;
    const meta = payload.meta || {};
    win.webContents
      .executeJavaScript(
        `window.__setProgress && window.__setProgress(${payload.pct}, ${payload.receivedMB || 0}, ${payload.totalMB || 0}, ${JSON.stringify(meta)})`
      )
      .catch(() => {});
  };
  return {
    // 客户端更新：真实字节进度 + 速度 + 剩余时间（meta 可选追加）。
    client: (received, total, meta) => {
      const pct = total > 0 ? Math.round((received * 100) / total) : -1;
      push({ pct, receivedMB: Math.round(received / 1048576), totalMB: Math.round(total / 1048576), meta });
    },
    force: (meta) => push({ pct: -1, meta, force: true }),
    // agent 更新：npm 阶段/包数/耗时 + 镜像源切换
    agent: (ev) => {
      let stage;
      if (ev.stage === 'fetch') {
        stage = `下载依赖 · 已获取 ${ev.count || 0} 项 · 用时 ${ev.elapsed || ''}` + (ev.registry ? ' · 源：' + hostOf(ev.registry) : '');
      } else if (ev.stage === 'install') {
        stage = '正在安装依赖…';
      } else if (ev.stage === 'done') {
        stage = '安装完成，正在切换版本…';
      } else if (ev.stage === 'mirror') {
        stage = ev.registry ? '下载停滞，已自动切换镜像源：' + hostOf(ev.registry) : '下载失败，正在尝试其他镜像源…';
      } else {
        stage = '正在更新…';
      }
      push({ pct: -1, meta: { stage } });
    },
  };
}

async function runUpdateFlow(manual) {
  if (quitting) return;
  if (updateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  const ctx = updCtx();
  let latest;
  try {
    latest = await updater.checkLatest(ctx);
  } catch (err) {
    log('update', '检查失败: ' + err.message);
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查更新失败',
        message: '无法连接 npm registry。',
        detail: err.message + '\n\n可通过环境变量 NPM_CONFIG_REGISTRY 配置镜像。',
        buttons: ['确定'],
      });
    }
    return;
  }
  const current = updater.activeVersion(ctx);
  const settings = loadSettings(ctx);
  if (updater.compareVersions(latest, current) <= 0) {
    if (manual) {
      await showBox({
        type: 'info',
        title: '检查更新',
        message: '当前已是最新版本。',
        detail: `@deepseek-ai/dsh@${current}`,
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!manual && settings.skipVersion === latest) return;

  const { response } = await showBox({
    type: 'info',
    title: '发现新版本',
    message: `官方 @deepseek-ai/dsh 发布了新版本：${latest}`,
    detail: `当前版本：${current}\n\n是否立即更新？\n· 从 npm 官方源下载新版本及其依赖（首次约 250MB）\n· 更新期间界面保持可用，完成后重启应用生效\n· 失败会自动保留当前版本`,
    buttons: ['立即更新', '跳过此版本', '稍后'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 1) {
    settings.skipVersion = latest;
    saveSettings(ctx, settings);
    log('update', '用户跳过版本 ' + latest);
    return;
  }
  if (response === 2) return;

  updateBusy = true;
  const progressWin = showUpdateWindow(latest);
  const progress = makeUpdateProgressPusher(progressWin);
  try {
    // V4.1 更新保障①：更新前强制插件/配置快照，失败则中止更新
    //（宁可不动，不可让用户失去回滚点）。
    const snap = ensureGuard().snapshot('pre-update:dsh:' + latest);
    if (!snap) {
      throw new Error('更新前保护快照失败（profile 不可读），已中止更新以保证可回滚。');
    }
    await updater.applyUpdate(ctx, latest, { onProgress: (ev) => progress.agent(ev) });
    const { response: r2 } = await showBox({
      type: 'info',
      title: '更新完成',
      message: `已更新到 @deepseek-ai/dsh@${latest}`,
      detail: '重启应用后生效。\n· 插件、皮肤与配置均保留在 profile，不受更新影响\n· 上一版本已备份，本次启动确认健康后自动清理',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r2 === 0) restartApp();
  } catch (err) {
    log('update', '更新失败: ' + err.message);
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成更新，仍使用当前版本。',
      detail: err.message,
      buttons: ['确定'],
    });
  } finally {
    updateBusy = false;
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

// ---------------------------------------------------------------------------
// 内置插件更新检查（V4.3）：启动后静默执行。
//   · settings.pluginAutoUpdate = false（默认）→ 发现更新仅系统通知，不下载
//   · true → 自动下载到覆盖层（服务运行中不写 profile），弹窗提示重启
// 24h 节流（settings.pluginUpdateCheckedAt）+ 单插件失败不阻塞。
// ---------------------------------------------------------------------------

function notifyPluginUpdates(updatable) {
  try {
    const names = updatable.slice(0, 5).map((x) => x.name).join('、');
    const n = new Notification({
      title: '有 ' + updatable.length + ' 个内置插件可更新',
      body: names + (updatable.length > 5 ? ' 等' : '') + ' 已发布新版本。打开「设置 → 插件 → 更新」查看并更新（自动更新默认关闭，仅提示）。',
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    n.on('click', () => showMainWindow());
    n.show();
  } catch (err) {
    log('plugin-update', '更新通知发送失败: ' + (err && err.message));
  }
}

async function runPluginUpdateCheck(manual) {
  if (quitting) return;
  const ctx = updCtx();
  const sources = pluginUpdateSources();
  if (sources.length === 0) return;
  if (!manual && !pluginUpdater.dueForCheck(ctx, Date.now())) return;
  let list;
  try {
    list = await pluginUpdater.checkPluginUpdates(ctx, sources, { force: !!manual, profileDirP: desktopProfileDir() });
    if (!manual) pluginUpdater.markChecked(ctx);
  } catch (err) {
    log('plugin-update', '内置插件更新检查失败: ' + String((err && err.message) || err));
    return;
  }
  const updatable = list.filter((x) => x.hasUpdate && !x.skipped);
  if (updatable.length === 0) return;
  if (!pluginUpdater.isAutoUpdateEnabled(ctx)) {
    // 默认行为：只检测并提示，下载交给用户在「更新」标签页手动完成。
    notifyPluginUpdates(updatable);
    return;
  }
  const { done, failed } = await pluginUpdater.autoApplyUpdates(ctx, sources, {
    profileDirP: desktopProfileDir(),
    guard: ensureGuard(),
    copyIntoProfile: (overlayDir, name) => copyPluginPackage(desktopProfileDir(), overlayDir, name),
  });
  log('plugin-update', '自动更新完成: ' + (done.map((d) => d.name).join('、') || '无') + (failed.length ? '；失败 ' + failed.length + ' 个' : ''));
  if (done.length) {
    const names = done.map((d) => d.name).join('、');
    const { response } = await showBox({
      type: 'info',
      title: '内置插件已更新',
      message: '已更新内置插件：' + names,
      detail: '更新已写入用户目录，重启 Web 服务后生效（无需重启应用）。' + (failed.length ? '\n\n失败 ' + failed.length + ' 个：' + failed.map((f) => f.name).join('、') + '（可在「设置 → 插件 → 更新」重试）' : ''),
      buttons: ['立即重启服务', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      try { await restartWebServiceCore(); } catch (err) {
        log('plugin-update', '重启服务失败: ' + String((err && err.message) || err));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session-completion notifications
// ---------------------------------------------------------------------------

const lastNotifyAt = new Map(); // sessionId -> timestamp (rate-limit)

function onSessionTurnEnd(info) {
  if (!notifyOnTurnEnd || quitting) return;
  const now = Date.now();
  const last = lastNotifyAt.get(info.sessionId) || 0;
  if (now - last < 30000) return; // same session: at most one toast per 30s
  lastNotifyAt.set(info.sessionId, now);
  log('notify', '任务完成: ' + JSON.stringify(info));
  try {
    const n = new Notification({
      title: info.title || 'DSH 任务完成',
      body: info.body || '会话任务已完成',
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    n.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
  } catch (err) {
    log('notify', '通知发送失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Chrome（自绘标题栏）IPC、托盘、余额、快捷方式
// ---------------------------------------------------------------------------

function closeToTrayEnabled() {
  const s = loadSettings(updCtx());
  return s.closeToTray !== false;
}

function setCloseToTray(v) {
  const s = loadSettings(updCtx());
  s.closeToTray = !!v;
  saveSettings(updCtx(), s);
}

// 退出行为三档：ask（每次询问）/ minimize（后台运行）/ quit（直接退出）。
// 旧版本只有 closeToTray 布尔开关，这里做迁移：closeToTray === false → quit，
// 显式 true → minimize（保持旧默认行为），未设置（新安装）→ ask。
function getExitAction() {
  const s = updater.loadSettings(updCtx());
  if (s.exitAction === 'ask' || s.exitAction === 'minimize' || s.exitAction === 'quit') return s.exitAction;
  if (s.closeToTray === false) return 'quit';
  if (s.closeToTray === true) return 'minimize';
  return 'ask';
}

function setExitAction(v) {
  if (v !== 'ask' && v !== 'minimize' && v !== 'quit') return;
  const s = updater.loadSettings(updCtx());
  s.exitAction = v;
  // 同步旧字段，避免降级回旧版本时行为回退。
  s.closeToTray = v !== 'quit';
  updater.saveSettings(updCtx(), s);
}

// 退出确认弹窗（exitAction === "ask"）。带「记住我的选择」勾选框。
async function askExitAction() {
  const { response, checkboxChecked } = await showBox({
    type: 'question',
    title: '退出 Deepseek Harness',
    message: '要退出程序，还是在后台运行？',
    detail: '后台运行时窗口会隐藏到系统托盘，任务完成后会发通知。',
    buttons: ['最小化到后台', '退出程序'],
    defaultId: 0,
    cancelId: -1,
    checkboxLabel: '记住我的选择，不再询问',
    checkboxChecked: false,
    noLink: true,
  });
  const choice = response === 1 ? 'quit' : 'minimize';
  if (checkboxChecked) setExitAction(choice);
  return choice;
}

function repoUrls() {
  const repos = clientUpdater.resolveRepos();
  return {
    github: 'https://github.com/' + repos.github,
    gitee: 'https://gitee.com/' + repos.gitee,
  };
}

async function showAbout() {
  const urls = repoUrls();
  const { response } = await showBox({
    type: 'info',
    title: '关于 Deepseek Harness EAC',
    message: 'Deepseek Harness EAC（封装版本 ' + APP_VERSION + '）',
    detail: 'DeepSeek Harness 桌面客户端\n\nagent 版本：' + dshVersion() + '（' + dshVersionSource() + '）\n数据目录：' + userDataDir + '\nDSH_HOME：' + (dshHome || '（dsh 默认）') +
      '\n\n项目仓库：\n  GitHub: ' + urls.github + '\n  Gitee:  ' + urls.gitee +
      '\n\n交流群：EAC 交流群（群号 523412163）\n反馈问题：⋯ 菜单 → 反馈建议',
    buttons: ['复制 GitHub 地址', '复制 Gitee 地址', '确定'],
  });
  if (response === 0) clipboard.writeText(urls.github);
  else if (response === 1) clipboard.writeText(urls.gitee);
}

// 原地重启 dsh web 服务（安装/卸载插件后生效，窗口重载到新端口）。
// V4：抽出核心逻辑，⋯ 菜单「重启 Web 服务」与托盘菜单共用（用户建议：
// 不关闭软件即可重启服务）。
async function restartWebServiceCore({ beforeSync = null } = {}) {
  if (!serverProc || restartingServer) return { ok: false, error: 'not-running' };
  log('service', '请求重启 dsh web 服务');
  restartingServer = true;
  try {
    const oldProc = serverProc;
    killTree(serverProc);
    serverProc = null;
    // 等旧进程真正退出（DLL 文件锁随之释放），再执行插件市场排队任务，
    // 最后才拉起新服务 —— 排队安装正需要这个"无锁窗口"。
    await waitForProcExit(oldProc, 20000);
    await processPendingMarketOps();
    if (typeof beforeSync === 'function') {
      const mutation = await beforeSync();
      if (mutation && mutation.ok === false) throw new Error(mutation.error || '服务重启前插件变更失败');
    }
    // pnpm（排队安装/卸载）会重写 profile node_modules：可能删掉配套插件
    // 副本、重新 hoist 核心包。服务拉起前重建 + 清理，顺序不能反。
    syncCompanionPlugins();
    healProfileModules();
    await restoreKeptArtifacts(desktopProfile());
    const url = await startAndShowGuarded();
    log('service', 'dsh web 服务已重启: ' + url);
    return { ok: true, url };
  } catch (err) {
    log('service', '重启失败: ' + ((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    restartingServer = false;
  }
}

// If a plugin mutation fails after the old service has already been stopped,
// bring the service back before returning the error to the renderer. The user
// should see a failed operation, not a permanently blank desktop window.
async function recoverWebServiceAfterPluginFailure() {
  if (serverProc || restartingServer) return { ok: true };
  try {
    syncCompanionPlugins();
    healProfileModules();
    await restoreKeptArtifacts(desktopProfile());
    const url = await startAndShowGuarded();
    return { ok: true, url };
  } catch (err) {
    log('plugin-manager', '插件操作失败后的 Web 服务恢复失败: ' + ((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// IPC 注册（ipc/register-ipc.js）：34 个 renderer→main 通道按领域分组。
// 稳定引用（函数 / 常量 / Set/Map）按引用传入；可变状态（mainWindow /
// serverProc / recovery / wizardWindow / …，模块级 let）用访问器闭包，
// 每次 handler 执行取当前值 —— 与原先模块作用域读取等价。
function registerAppIpc() {
  registerIpc({
    ipcMain,
    ctx: {
      // 稳定引用（按引用传入）
      app, fs, path, shell, clipboard,
      updater, pluginUpdater, balance, onboardingLogic,
      updCtx, loadSettings, saveSettings,
      desktopProfile, desktopProfileDir,
      APP_VERSION, FLOAT_MAX, COMPANION_PLUGINS, DANGEROUS_EXT,
      floatWindows, floatBySession,
      restartApp, startAndShowGuarded, restartWebServiceCore,
      runUpdateFlow, runClientUpdateFlow, showBox, closeWizard, openPluginWizard,
      createFloatWindow, pluginManagerCollect, pluginManagerSetEnabled,
      pluginManagerSetRemoved, pluginManagerUninstall, pluginManagerRestore,
      ensureDesktopProfileInit, buildOnboardingCatalog, pluginCurrentState,
      imagePasteSave, refreshBalance, isUnderFileRoots, repoUrls, ensureGuard,
      copyPluginPackage, pluginUpdateSources, dshVersion, dshVersionSource,
      getExitAction, closeToTrayEnabled, setCloseToTray, setExitAction, showAbout,
      // 可变状态访问器（每次 handler 执行取当前值）
      mainWindow: () => mainWindow,
      serverProc: () => serverProc,
      webUrl: () => webUrl,
      notifyOnTurnEnd: () => notifyOnTurnEnd,
      balanceCache: () => balanceCache,
      restartingServer: () => restartingServer,
      recovery: () => recovery,
      wizardWindow: () => wizardWindow,
      wizardMode: () => wizardMode,
      previewStaticPort: () => previewStaticPort,
      logsDir: () => logsDir,
      // 可变状态写入
      setNotifyOnTurnEnd: (v) => { notifyOnTurnEnd = v; },
      setForceQuit: (v) => { forceQuit = v; },
    },
    log,
  });
}

let trayHintShown = false;
function trayHintOnce() {
  if (trayHintShown || !tray) return;
  trayHintShown = true;
  try {
    tray.displayBalloon({
      title: 'Deepseek Harness EAC 仍在运行',
      content: '窗口已隐藏到系统托盘，点击托盘图标可重新打开。',
      iconType: 'info',
    });
  } catch (err) {
    log('tray', '气泡通知发送失败: ' + err.message);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (!IS_WIN) return;
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    tray.setToolTip('Deepseek Harness EAC');
    const menu = Menu.buildFromTemplate([
      { label: '显示 Deepseek Harness EAC', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '检查 dsh 更新…', click: () => { showMainWindow(); runUpdateFlow(true); } },
      { label: '检查客户端更新…', click: () => { showMainWindow(); runClientUpdateFlow(true); } },
      {
        label: '会话完成通知',
        type: 'checkbox',
        checked: notifyOnTurnEnd,
        click: (item) => {
          notifyOnTurnEnd = item.checked;
          const s = loadSettings(updCtx());
          s.notifyOnTurnEnd = item.checked;
          saveSettings(updCtx(), s);
        },
      },
      { type: 'separator' },
      // V4（用户建议④）：不关闭应用重启 dsh web 服务（皮肤/插件生效路径）。
      { label: '重启 Web 服务', click: () => { showMainWindow(); restartWebServiceCore(); } },
      { type: 'separator' },
      { label: '反馈建议…', click: () => { showMainWindow(); shell.openExternal('https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues'); } },
      { type: 'separator' },
      { label: '退出', click: () => { forceQuit = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
      else showMainWindow();
    });
    tray.on('double-click', () => showMainWindow());
    log('boot', '系统托盘已就绪');
  } catch (err) {
    log('boot', '创建系统托盘失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// DeepSeek 余额（推送到 Web UI 的 dsh-balance 插件）
// ---------------------------------------------------------------------------

async function refreshBalance() {
  const home = dshHomePath();
  let result;
  try {
    result = await balance.queryBalance(home);
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err), balances: [] };
  }
  // 按当前默认模型选择价格档（settings.json 可覆盖 balancePrices.<model>，
  // 兼容旧扁平覆盖与新的 { peak, offpeak } 双档覆盖）。
  // 峰谷定价（2026-08-17 起）：按当前时段 pick 高峰/空闲档，两档随 pricing
  // 一起推给页面，时段切换后 client 可本地换档无需等下一次轮询。
  const model = balance.readActiveModel(home) || 'deepseek-v4-pro';
  const table = result.prices || balance.DEFAULT_PRICES;
  const s = loadSettings(updCtx());
  const pricing = balance.computePricingState(s.pricing && s.pricing.peakWindows);
  const base = table[model] || balance.FALLBACK_PRICES;
  const ov = (s.balancePrices && s.balancePrices[model]) || {};
  const tier = (src) => balance.tierPrices(base, ov, src);
  result.prices = tier(pricing.period);
  result.pricing = { ...pricing, prices: { peak: tier('peak'), offpeak: tier('offpeak') } };
  balanceCache = result;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:balance', result);
  }
  return result;
}

function startBalanceLoop() {
  refreshBalance().catch(() => {});
  balanceTimer = setInterval(() => refreshBalance().catch(() => {}), 15 * 60 * 1000);
  if (balanceTimer.unref) balanceTimer.unref();
}

// ---------------------------------------------------------------------------
// 配套 dsh 插件同步（注入 web profile：余额小部件 + 文件更改追踪/还原 + 皮肤）
// ---------------------------------------------------------------------------

const COMPANION_PLUGINS = [
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal' },
  // 社区插件市场（awesome-dsh-plugin.com 目录）：内置分发，替换早期 npm 检索版市场。
  { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin', dir: 'dsh-webui-market' },
  { id: 'skin-switch', name: '@deepseek-ai/dsh-skin-switch' },
  { id: 'easy-setup', name: '@deepseek-ai/dsh-easy-setup' },
  // 社区功能插件（视觉 / 人设 / 长期记忆 / 移动端布局修复）：npm registry
  // 拉取后随应用内置分发。绝不能写进 profile package.json 依赖 ——
  // pnpm 安装会 hoist @deepseek-ai 核心包形成模块双实例（Symbol 冲突，
  // 插件命名空间注册失效，即 "设置命名空间不可用" 故障的根因）。
  // 默认禁用：其 llm/stream 监听器是 async 函数（index.js attachRequestGuard），
  // 返回 Promise 破坏 cordis waterfall 契约 —— checkpoint-policy 的 yield* next()
  // 拿到 Promise 即抛 "yield* (intermediate value) is not async iterable"，
  // 每轮模型请求必失败。修复上游插件前不要恢复默认启用。
  { id: 'tool-vision', name: 'dsh-tool-vision', dir: 'dsh-tool-vision', disabled: true },
  // config.path 必须随行写入：v2.0.0 只写了 id+name，而当时插件 schema 的
  // path 是 required 无默认值，全新安装校验失败拖垮整个插件树（dsh web
  // 退出码 1，应用持续闪退“启动失败”）。schema 现已带默认值，这里显式
  // 写 config 是双保险，healSoulMdPatchRow 另负责修复存量坏行。
  { id: 'soul-md', name: 'dsh-soul-md', dir: 'dsh-soul-md', config: { path: 'soul.md' } },
  { id: 'tdai-memory', name: 'dsh-tdai-memory', dir: 'dsh-tdai-memory' },
  { id: 'mobile-fix', name: 'dsh-web-mobile-fix', dir: 'dsh-web-mobile-fix' },
  // VSCode 风格右侧边栏（文件树 / 编辑器 / 终端 / Git，按会话隔离）。
  // lib/ 预编译自包含（codemirror、xterm 已内嵌），服务端仅额外依赖
  // schemastery（已加入 app 闭包，见 package.json）。
  { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar' },
  // Trae 风格对话回退：用户消息 hover 出「编辑并回退」，按上一完整回合
  // 分叉新会话（sessions.fork）并以编辑后内容重发（inputActions）。
  // 纯客户端实现，host 半边为 no-op。
  { id: 'message-rewind', name: 'dsh-message-rewind', dir: 'dsh-message-rewind' },
  // 页面桌宠（npm: dsh-pet 0.1.3）：28 个透明动画的悬浮宠物，即装即用。
  // assets/ 15MB 播放资源随包分发；peer 依赖全部由 dsh 宿主提供。
  // V4 关键修复：行必须带 config —— dsh-pet 的 apply 读 config.fullRoot，
  // 无 config 块的行会让 loader 传 undefined 直接拖垮插件树（v3.1.0 全新
  // 安装即「启动失败」的根因之一；老用户因市场装过的行带 config 才幸免）。
  // 值沿用包内 cordis.patch.yml 的出厂默认。
  // 默认禁用 —— 需要页面桌宠时在「设置 → 插件 → 管理」或「桌宠」分区开启。
  { id: 'dsh-pet', name: 'dsh-pet', dir: 'dsh-pet', config: { size: 260, position: 'bottom-right' }, disabled: true },
  // 第二插件市场 Zat-DSH Engine（GitHub releases 分发，v0.5.0 vendor 自
  // 源码 tag）：GitHub dsh-plugin topic 检索 + 中文简介 + 国内镜像兜底。
  // 运行时依赖 zod ^4 由 profiles 闭包（junction 指向 app node_modules，
  // 内含 zod 4.4.3）解析，无需 vendor。
  { id: 'zat-market', name: 'zat-dsh-engine', dir: 'zat-dsh-engine' },
  // 设置页「Skills 与 MCP」分区：Skills 目录浏览（来源徽标/打开目录）+
  // MCP 服务增删改（读写 profile patch 中的 dsh-mcp-client 行）+ 从
  // Claude Code / Codex 一键导入 MCP 配置。
  { id: 'dock-settings', name: 'dsh-dock-settings', dir: 'dsh-dock-settings' },
  // 外观自定义：字体家族/字号/文字与代码颜色的设置页分区，实时预览，
  // localStorage 持久化（纯客户端，无宿主半边）。
  { id: 'font-custom', name: 'dsh-font-custom', dir: 'dsh-font-custom' },
  // 自动压缩：监听 contextPressure 投影，接近上下文上限（默认 80%）时
  // 自动向当前会话发送 /compact（dsh 原生命令，压缩事务由内核执行）。
  { id: 'auto-compact', name: 'dsh-auto-compact', dir: 'dsh-auto-compact' },
  // 插件保护中心 UI：快照列表/一键回滚/健康检查/事故报告，经桌面壳
  // IPC（guard:action）驱动 plugin-guard.js 引擎。
  { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
  // AI 变更审核（V4，用户建议⑤）：监控官方 fileChanges 投影，手动/自动向
  // 当前对话发送审核请求，让模型复查自己刚做的改动（正确性/安全性/一致
  // 性），结论配合「文件」页一键还原。纯客户端实现，host 半边 no-op。
  { id: 'change-review', name: 'dsh-change-review', dir: 'dsh-change-review' },
  // —— V4 自上游 dsh_desktop（myYangyunfan）移植的配套插件 ——
  // 会话浮窗（多窗口分屏）：会话头部「弹出到独立窗口」按钮；窗口由壳层
  // IPC chrome:float-window / preload 的 __DSH_FLOAT__ 承载。
  { id: 'float-window', name: '@deepseek-ai/dsh-float-window' },
  // 对话节点导航条（vlln/dsh-navbar，MIT）：对话区右缘节点串快速跳转
  // user 消息（悬停预览/点击跳转/滚轮切换）。
  { id: 'dsh-navbar', name: '@vlln/dsh-navbar', dir: 'dsh-navbar' },
  // 对话删除与归档管理：会话行菜单「删除对话」+ 设置内归档管理面板。
  // 前置依赖 scripts/patch-session-manage.js 的官方包运行时补丁
  // （applySessionManageFix，随启动幂等应用、覆盖 agent overlay）。
  { id: 'dsh-session-manager', name: 'dsh-session-manager' },
  // 对话界面微调：隐藏大量工具调用/结果/思考输出（保留每轮最终总结）。
  { id: 'conversation-tweaks', name: '@deepseek-ai/dsh-conversation-tweaks' },
  // 自定义注入提示词：整体替换/追加官方 persona，应用到 standard 预设。
  { id: 'prompt-custom', name: '@deepseek-ai/dsh-prompt-custom' },
  // 第三方 OpenAI 兼容模型的 reasoning_effort 控件（字段名可自定义）。
  { id: 'third-party-thinking', name: '@deepseek-ai/dsh-third-party-thinking' },
  // 侧边临时会话：浮窗追问、不写主会话、多种回答引擎（Ctrl+Shift+S）。
  { id: 'side-session', name: '@dsh-external/dsh-side-session', dir: 'dsh-side-session' },
  // 插件启停管理：设置页「插件 → 管理」标签，不重启切换插件启停
  // （IPC dsh:plugin-list / dsh:plugin-set-enabled，见下方接线）。
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', required: true, uninstallable: false },
  // 插件选择向导入口（设置页「插件 → 选择向导」分区）：重新打开首次启动的
  // 内置插件选择向导，按需启用/停用内置插件。纯客户端 UI + 壳层 IPC
  // （onboard:*），host 半边 no-op；核心插件组内锁定，永不被向导停用。
  { id: 'plugin-wizard', name: 'dsh-plugin-wizard', dir: 'dsh-plugin-wizard' },
  // 微信 ClawBot / OpenClaw 桥（openclaw-dsh-bridge v0.7.0，MIT）：设置页
  // 「ClawBot」栏（扫码绑定微信官方 ClawBot 小程序）+ OpenAI 兼容端点
  // （/openclaw-bridge/v1/chat/completions）。前置依赖 dsh-host-apiproxy 的
  // 设置命名空间白名单补丁（patchApiproxyBridgeNamespace，随启动幂等应用）。
  { id: 'openclaw-bridge', name: '@deepseek-ai/dsh-openclaw-bridge', dir: 'dsh-openclaw-bridge' },
  // 崩溃急救/撤销回退（dsh-undo-savepoint，lire1131，MIT）：配置文件 + 插件
  // 代码树快照、undo/redo、一键安全模式、密钥脱敏 vault。与插件保护中心
  // （配置面快照）和「文件」还原（会话内改动）互补，覆盖「配置改坏、dsh
  // 起不来」的急救场景。GitHub 分发锁定拷贝（npm 未发布）。
  { id: 'dsh-undo', name: 'dsh-undo-savepoint', dir: 'dsh-undo-savepoint' },
  // 大肥鱼桌宠（dsh-dafeiyu，QCYTSN；代码 MIT、角色素材按 ASSET_LICENSE.md
  // 随包分发保留署名）：真实会话状态驱动的原生置顶桌宠（空闲/思考/工作/
  // 等待/完成/错误 六态 + 项目状态卡）。默认开启 —— 可在「设置 → 插件 →
  // 管理」或「桌宠」分区关闭（含 49MB PyInstaller helper，按需运行）。
  { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu', dir: 'dsh-dafeiyu' },
  // 桌宠设置分区（V4.2，dsh-pet-settings）：设置页「桌宠」分区，集中管理
  // 页面桌宠（dsh-pet 开关，重启生效）与大肥鱼桌面伴侣（启用/角色大小/
  // 空闲微动作频率/减少动态，走 dsh-dafeiyu config 端点即时生效）。
  { id: 'dsh-pet-settings', name: 'dsh-pet-settings', dir: 'dsh-pet-settings' },
  // 峰谷价格卫士（dsh-offpeak，christophersmith2737-commits，MIT）：DeepSeek
  // 峰谷定价（2026-08-17 起）高峰时段（北京时间 9-12 / 14-18 点）在发送前
  // 拦截提醒，可一键继续或定时到闲时价自动执行（浏览器不在线也会到点
  // 执行）。与余额小部件互补（事前拦截 vs 事后显示）；程序化提交
  // （auto-compact / 变更审核 / 消息回退 / openclaw 桥）不被拦截。
  // 可在「设置 → 插件 → 管理」关闭。
  { id: 'offpeak', name: 'dsh-offpeak', dir: 'dsh-offpeak' },
  // 拖入文件到对话（V4.1，用户建议）：文本/代码文件拖进输入框自动注入
  // 内容（上限 256KB），图片/二进制/超大文件注入路径提示配合
  // inspect_image 与文件工具；纯客户端实现（host 半边 no-op）。
  { id: 'file-drop', name: 'dsh-file-drop', dir: 'dsh-file-drop' },
  // 设置页左侧边栏自定义（V4.1，用户建议）：设置面板导航底部「自定义
  // 边栏」按钮，按需显示/隐藏与排序 settings.section 导航项，
  // localStorage 持久化，默认全显；纯客户端实现（host 半边 no-op）。
  { id: 'settings-nav-custom', name: 'dsh-settings-nav-custom', dir: 'dsh-settings-nav-custom' },
  // 设置页「常规」页内高级选项折叠（V4.2，用户建议）：按行标题关键词把
  // 低频选项行（外观/语言/权限预设等）收进底部「高级选项」折叠组，
  // localStorage 持久化展开状态；纯客户端实现（host 半边 no-op）。
  { id: 'settings-groups', name: 'dsh-settings-groups', dir: 'dsh-settings-groups' },
  // 图片粘贴发送（V4.2，用户建议）：Ctrl/Cmd+V 粘贴剪贴板图片 → 保存到
  // 临时目录 → 注入完整路径提示（配合 inspect_image 视觉工具）；纯客户端
  // 实现（host 半边 no-op，仅用受控 IPC dsh:image-paste-save）。
  { id: 'image-paste', name: 'dsh-image-paste', dir: 'dsh-image-paste' },
];

// ---------------------------------------------------------------------------
// 内置插件上游更新源（V4.3，plugin-updater.js 消费）：
//
// 只登记「上游仍在 npm / GitHub 发布」的社区插件 —— 内置分发的副本可以
// 跟随上游修复而更新。EAC 独占插件（package.json 标记 private，如
// dsh-balance / dsh-terminal）绝不登记；zat-market 自带 selfupdate 不登记。
// 运行时 npm 404（未上架/改名）优雅降级为「无上游」，绝不阻塞。
// ---------------------------------------------------------------------------
const PLUGIN_UPDATE_SOURCES = {
  'tool-vision': { npm: 'dsh-tool-vision' },
  'soul-md': { npm: 'dsh-soul-md' },
  'tdai-memory': { npm: 'dsh-tdai-memory' },
  'dsh-pet': { npm: 'dsh-pet' },
  'better-sidebar': { npm: 'dsh-better-sidebar' },
  'dsh-navbar': { npm: '@vlln/dsh-navbar' },
  'mobile-fix': { npm: 'dsh-web-mobile-fix' },
  'offpeak': { npm: 'dsh-offpeak' },
  'dsh-market-plugin': { npm: '@sanqi-normal/dsh-webui-market-plugin' },
  'dsh-session-manager': { npm: 'dsh-session-manager' },
  // GitHub 分发（npm 未发布）：dsh-undo-savepoint。
  'dsh-undo': { github: 'lire1131/dsh-undo-savepoint' },
};

/** 把内置插件表 + 更新源注册表合并成 plugin-updater 的 sources 输入。 */
function pluginUpdateSources() {
  const removed = removedPluginIds();
  const out = [];
  for (const p of COMPANION_PLUGINS) {
    const update = PLUGIN_UPDATE_SOURCES[p.id];
    if (!update) continue;
    if (removed.has(p.id)) continue;
    const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
    const assetsDir = path.join(__dirname, 'assets', 'plugins', dirName);
    if (!fs.existsSync(path.join(assetsDir, 'package.json'))) continue;
    out.push({ id: p.id, name: p.name, assetsDir, update });
  }
  return out;
}

/** 内置插件当前生效的源目录：覆盖层（已更新版本）优先，资产版本回退。 */
function builtinPluginSourceDir(dirName) {
  const assets = path.join(__dirname, 'assets', 'plugins', dirName);
  const overlay = path.join(userDataDir, 'builtin-plugin-updates', dirName);
  if (!fs.existsSync(path.join(overlay, 'package.json'))) return assets;
  if (!fs.existsSync(path.join(assets, 'package.json'))) return overlay;
  // 覆盖层版本 >= 资产版本才优先：应用自身升级后，新资产自动接管覆盖层。
  const vOverlay = pluginUpdater.versionOfDir(overlay);
  const vAssets = pluginUpdater.versionOfDir(assets);
  if (vOverlay && vAssets && updater.compareVersions(vOverlay, vAssets) < 0) return assets;
  return overlay;
}

// 皮肤包目录：assets/skins/<id>/。每个皮肤是一个完整的 dsh client 插件包
// （package.json + lib/ + skin.json + LICENSE/NOTICE），随桌面端分发；
// 默认全部以 disabled: true 注册（不启用任何皮肤），由「设置 → 皮肤」切换。
const SKINS_DIR = path.join(__dirname, 'assets', 'skins');

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// 拷贝一个插件包目录到 profile node_modules（按包名 scope 落位，幂等）。
// 除运行必需文件外，LICENSE/NOTICE/README 等许可与出处文件以及 preview/
// 目录（皮肤预览图）一并随包分发。
// V4：先比对「源 vs 目标」的内容戳记（版本+文件数+字节数），一致则跳过 ——
// 旧逻辑每次启动全量重拷（dsh-pet 15MB、dsh-dafeiyu ~58MB 资产，拖慢启动）。
// 戳记文件放在包目录内（.eac-copy-stamp.json），pnpm 重写 node_modules 时
// 随目录消失，天然触发重建。
const COPY_STAMP = '.eac-copy-stamp.json';

// 与 copyPluginPackage 的拷贝清单保持一致（多算/漏算都会导致每次都重拷，
// 只会浪费不会出错）。
function pluginCopyEntries(src) {
  const out = [];
  const copyFile = (rel) => {
    const sf = path.join(src, rel);
    if (!fs.existsSync(sf) || fs.statSync(sf).isDirectory()) return;
    out.push(rel);
  };
  const copyDir = (rel) => {
    const sd = path.join(src, rel);
    if (!fs.existsSync(sd) || !fs.statSync(sd).isDirectory()) return;
    for (const entry of fs.readdirSync(sd, { withFileTypes: true })) {
      const sub = rel + '/' + entry.name;
      if (entry.isDirectory()) copyDir(sub);
      else copyFile(sub);
    }
  };
  for (const f of ['package.json', 'skin.json', ...EXTRA_PACKAGE_FILES]) copyFile(f);
  for (const f of ['index.js', 'client.js', 'recall-inject.js', 'cordis.patch.yml']) copyFile(f);
  for (const d of ['lib', 'preview', 'vendor', 'node_modules', 'data', 'assets', 'runtime', 'src', 'client']) copyDir(d);
  return out;
}

function pluginStampOf(src) {
  try {
    const pkg = readJsonFile(path.join(src, 'package.json')) || {};
    let files = 0;
    let bytes = 0;
    for (const rel of pluginCopyEntries(src)) {
      files += 1;
      try { bytes += fs.statSync(path.join(src, rel)).size; } catch {}
    }
    return JSON.stringify({ v: String(pkg.version || ''), f: files, b: bytes });
  } catch {
    return null;
  }
}

function copyPluginPackage(profileDirP, src, name) {
  const destRoot = path.join(profileDirP, 'node_modules', ...name.split('/'));
  const stampFile = path.join(destRoot, COPY_STAMP);
  const want = pluginStampOf(src);
  try {
    if (want && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === want) {
      return; // 内容未变：跳过全量重拷
    }
  } catch { /* 比对失败按需重拷 */ }
  fs.mkdirSync(path.dirname(destRoot), { recursive: true });
  const copyFile = (rel) => {
    const sf = path.join(src, rel);
    if (!fs.existsSync(sf) || fs.statSync(sf).isDirectory()) return;
    const df = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(df), { recursive: true });
    fs.copyFileSync(sf, df);
  };
  const copyDir = (rel) => {
    const sd = path.join(src, rel);
    if (!fs.existsSync(sd) || !fs.statSync(sd).isDirectory()) return;
    for (const entry of fs.readdirSync(sd, { withFileTypes: true })) {
      const sub = rel + '/' + entry.name;
      if (entry.isDirectory()) copyDir(sub);
      else copyFile(sub);
    }
  };
  // lib 整目录随包（配套插件可能有 logic.js 等额外模块，按清单拷会漏文件
  // 导致 dsh web 启动时 ERR_MODULE_NOT_FOUND）。
  for (const f of ['package.json', 'skin.json', ...EXTRA_PACKAGE_FILES]) copyFile(f);
  // 社区插件（soul-md / tdai-memory / tool-vision）入口在包根目录而非
  // lib/，vendor/ 是其内置依赖，同样必须随包分发。
  for (const f of ['index.js', 'client.js', 'recall-inject.js', 'cordis.patch.yml']) copyFile(f);
  copyDir('lib');
  copyDir('preview');
  copyDir('vendor');
  // 内置插件自带的嵌套 node_modules（vendored 运行时依赖）：放在包内部，
  // pnpm 重写 profile node_modules 顶层时不会波及，插件保持自包含。
  copyDir('node_modules');
  // dsh-webui-market 的离线目录快照（官网不可达时的兜底数据）。
  copyDir('data');
  // dsh-pet / dsh-dafeiyu 等带运行时静态资源的插件（宠物动画 webp/png 帧、
  // PyInstaller helper 等）。
  copyDir('assets');
  copyDir('runtime');
  // dsh-dafeiyu 的入口在 src/（lib/ 只有 client 半边）；dsh-offpeak 的
  // client 半边在 client/（包 exports 映射）。
  copyDir('src');
  copyDir('client');
  if (want) {
    try {
      fs.mkdirSync(destRoot, { recursive: true });
      fs.writeFileSync(stampFile, want);
    } catch { /* 戳记写失败不影响功能 */ }
  }
}

// Remove only a package that the desktop shell owns. Marketplace packages,
// pnpm links, and malformed/unrelated directories are never recursively
// deleted by the built-in plugin lifecycle.
function removeOwnedPluginPackage(profileDirP, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('..')) {
    return { ok: false, error: '非法内置插件包名: ' + String(name) };
  }
  const modulesDir = path.resolve(path.join(profileDirP, 'node_modules'));
  const dest = path.resolve(path.join(modulesDir, ...name.split('/')));
  if (dest !== modulesDir && !dest.startsWith(modulesDir + path.sep)) {
    return { ok: false, error: '内置插件路径越界: ' + name };
  }
  let stat;
  try { stat = fs.lstatSync(dest); } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, error: String((err && err.message) || err) };
  }
  // A user may have replaced the desktop copy with a link. Do not follow or
  // remove it: the user-owned target is outside the desktop lifecycle.
  if (stat.isSymbolicLink()) return { ok: false, error: '拒绝删除非桌面托管链接: ' + name };
  if (!stat.isDirectory()) return { ok: false, error: '内置插件路径不是目录: ' + name };
  const pkg = readJsonFile(path.join(dest, 'package.json'));
  if (!pkg || pkg.name !== name) {
    return { ok: false, error: '插件目录不是桌面托管副本，已保留: ' + name };
  }
  try {
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { ok: !fs.existsSync(dest), removed: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// 随插件/皮肤包一起拷贝到 profile 的许可与出处文件（存在才拷贝）。
const EXTRA_PACKAGE_FILES = ['LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md', 'README.md', 'README.zh.md', 'THIRD-PARTY-NOTICES.md'];

// pnpm（dsh plugin add / 插件市场）hoist 进 profile node_modules 的
// @deepseek-ai 核心包真实拷贝，会遮蔽 <home>/profiles/node_modules 里指向
// 随应用分发的安装闭包 junction，形成模块双实例：Symbol 身份不一致，
// 作用域注册失效（如 "deployment:persona is already registered"），
// 模型列表刷新、模式切换、工作区添加等全部瘫痪。启动时清掉这些
// 遮蔽拷贝，让解析回落到 junction —— 与宿主同源、全局单实例。
function healProfileModules() {
  try {
    const home = dshHomePath();
    const removed = healProfileModuleShadowing(home, desktopProfile());
    if (removed.length) log('boot', '已清理 profile node_modules 中遮蔽安装闭包的包拷贝: ' + removed.join(', '));
  } catch (err) {
    log('boot', '清理 profile 模块遮蔽失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 插件市场排队任务：服务运行中安装/卸载撞上 Windows 文件锁（EPERM，如
// sqlite-vec 的 vec0.dll 被运行中的 web 进程加载）时，市场插件把任务写进
// profile 的 .dsh-market-pending.json。这里在"无服务进程持锁"的窗口期
// （应用启动时 / 原地重启 kill 完旧进程后）用 dsh CLI 完成它。
// ---------------------------------------------------------------------------
const MARKER_NAME = '.dsh-market-pending.json';
const MARKER_MAX_ATTEMPTS = 3;

// 删除排队标记文件。曾有残留进程短暂持锁导致 rmSync 静默失败、标记
// "复活"并反复触发 pnpm 的案例 —— 这里带重试 + 改名兜底，并返回是否
// 真正删除，调用方据此决定是否放弃任务。
function removeMarkerFile(file) {
  try {
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* 落到改名兜底 */ }
  if (!fs.existsSync(file)) return true;
  try {
    fs.renameSync(file, file + '.stale-' + Date.now());
  } catch { /* 锁着也无可奈何，交给 attempts 上限 */ }
  return !fs.existsSync(file);
}

function pendingMarketMarkers() {
  const out = [];
  try {
    const home = dshHomePath();
    const profilesRoot = path.join(home, 'profiles');
    if (!fs.existsSync(profilesRoot)) return out;
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const marker = path.join(profilesRoot, entry.name, MARKER_NAME);
      if (!fs.existsSync(marker)) continue;
      try {
        // 去掉可能的 UTF-8 BOM（外部编辑器写入的标记）再解析。
        const job = JSON.parse(fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, ''));
        if (job && typeof job.target === 'string' && job.target
          && typeof job.profile === 'string' && /^[A-Za-z0-9_-]+$/.test(job.profile)
          && (job.kind === 'install' || job.kind === 'uninstall')) {
          // V4.2：旧版 host 可能把目录默认 profile 'web' 写进标记（桌面壳跑
          // 在 web-desktop，profiles/web 不存在）—— 归一化后再执行，避免对
          // 不存在的 profile 跑 pnpm（spawn 报 node.exe ENOENT）。
          job.profile = job.profile === 'web' ? desktopProfile() : job.profile;
          out.push({ marker, job });
        } else {
          log('market-pending', '标记字段不完整，已删除: ' + marker);
          removeMarkerFile(marker);
        }
      } catch (err) {
        log('market-pending', `标记损坏，已删除: ${marker} (${err.message})`);
        removeMarkerFile(marker);
      }
    }
  } catch (err) {
    log('market-pending', '扫描排队任务失败: ' + err.message);
  }
  return out;
}

function finishMarketMarker(marker, job, attempts, ok, tail) {
  if (ok) {
    log('market-pending', '排队任务完成: ' + (job.label || job.target));
    if (!removeMarkerFile(marker)) {
      log('market-pending', '警告: 排队标记删除失败（文件被占用？），已尝试改名兜底');
    }
    return;
  }
  if (attempts >= MARKER_MAX_ATTEMPTS) {
    const last = String(tail || '').split(/\r?\n/).filter(Boolean).pop() || '';
    log('market-pending', `排队任务连续 ${attempts} 次失败，放弃并清除: ${job.label || job.target}${last ? ' — ' + last.slice(0, 200) : ''}`);
    removeMarkerFile(marker);
    return;
  }
  try { fs.writeFileSync(marker, JSON.stringify({ ...job, attempts }, null, 2)); }
  catch (err) { log('market-pending', '写回重试计数失败（下次可能重跑）: ' + err.message); }
  log('market-pending', '排队任务失败（下次启动重试）: ' + (job.label || job.target));
}

// ---------------------------------------------------------------------------
// 第三方插件构建产物保留（V4）：pnpm 重写 profile node_modules 后，把快照
// 里「磁盘上消失」的文件补回去。实现与市场 host 半边共用一份（ESM）：
// assets/plugins/dsh-webui-market/lib/artifact-keep.mjs。
// ---------------------------------------------------------------------------
const ARTIFACT_KEEP_MODULE = path.join(__dirname, 'assets', 'plugins', 'dsh-webui-market', 'lib', 'artifact-keep.mjs');
let artifactKeepMod = null;

async function artifactKeep() {
  if (artifactKeepMod) return artifactKeepMod;
  try {
    artifactKeepMod = await import(pathToFileURL(ARTIFACT_KEEP_MODULE).href);
  } catch (err) {
    log('artifact-keep', '模块加载失败: ' + err.message);
    artifactKeepMod = {};
  }
  return artifactKeepMod;
}

// V4.2：pnpm allowBuilds 自动放行（排队任务 + 守护启动失败链共用同一份
// ESM：assets/plugins/dsh-webui-market/lib/allow-builds.mjs）。
const ALLOW_BUILDS_MODULE = path.join(__dirname, 'assets', 'plugins', 'dsh-webui-market', 'lib', 'allow-builds.mjs');
let allowBuildsMod = null;

async function allowBuilds() {
  if (allowBuildsMod) return allowBuildsMod;
  try {
    allowBuildsMod = await import(pathToFileURL(ALLOW_BUILDS_MODULE).href);
  } catch (err) {
    log('allow-builds', '模块加载失败: ' + err.message);
    allowBuildsMod = {};
  }
  return allowBuildsMod;
}

function profileDirFor(profile) {
  const home = dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', profile);
}

function artifactCacheDirFor(profile) {
  const home = dshHome || path.join(os.homedir(), '.dsh');
  return path.join(home, 'plugin-artifact-cache', profile);
}

// 由桌面壳重建的包（配套插件 + 皮肤）不进快照：丢了也会被 syncCompanion
// Plugins / 皮肤同步立刻补回，缓存它们只浪费空间。
function managedPackageNames() {
  const names = COMPANION_PLUGINS.map((p) => p.name);
  try {
    for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = readJsonFile(path.join(SKINS_DIR, entry.name, 'package.json'));
      if (pkg && typeof pkg.name === 'string') names.push(pkg.name);
    }
  } catch {}
  return names;
}

// 启动兜底回填：上次 pnpm 运行后若应用异常退出没来得及回填（或回填被
// 中断），这里补上。只补缺失文件，安全幂等。
async function restoreKeptArtifacts(profile) {
  const ak = await artifactKeep();
  if (typeof ak.restoreArtifacts !== 'function') return;
  try {
    ak.restoreArtifacts(profileDirFor(profile), artifactCacheDirFor(profile), {
      log: (m) => log('artifact-keep', m),
    });
  } catch (err) {
    log('artifact-keep', '回填失败: ' + err.message);
  }
}

// 必须在"没有任何 dsh web 进程持锁"时调用；调用方负责先等待旧进程退出。
async function processPendingMarketOps() {
  const items = pendingMarketMarkers();
  if (items.length === 0) return;
  const nodeBin = nodeExe();
  const bin = dshBin();
  if (!fs.existsSync(nodeBin) || !fs.existsSync(bin)) {
    log('market-pending', '找不到 node/dsh CLI，跳过排队任务');
    return;
  }
  log('market-pending', `发现 ${items.length} 个排队任务，开始执行（Web 服务启动前，无文件锁）`);
  // V4：pnpm 即将重写 node_modules —— 先快照第三方包（含人工补齐的
  // lib/ 等构建产物），任务结束后回填被清掉的部分（meow-memory 修复）。
  const profiles = [...new Set(items.map((it) => it.job.profile))];
  const ak = await artifactKeep();
  if (typeof ak.snapshotArtifacts === 'function') {
    for (const profile of profiles) {
      try {
        ak.snapshotArtifacts(profileDirFor(profile), artifactCacheDirFor(profile), {
          managedNames: managedPackageNames(),
          log: (m) => log('artifact-keep', m),
        });
      } catch (err) {
        log('artifact-keep', `snapshot ${profile} 失败: ` + err.message);
      }
    }
  }
  await new Promise((resolve) => {
    let idx = 0;
    // V4.2：allowBuilds 自动放行后的重试只允许一次（同一 marker）。
    const retriedMarkers = new Set();
    const next = async () => {
      if (idx >= items.length) {
        // pnpm 可能重新 hoist 出 @deepseek-ai 遮蔽拷贝，装完立刻清理，
        // 避免模块双实例（Symbol 身份不一致）问题拖到下次启动。
        healProfileModules();
        return resolve();
      }
      const { marker, job } = items[idx];
      const retried = retriedMarkers.has(marker);
      const attempts = Number(job.attempts || 0) + 1;
      const action = job.kind === 'uninstall' ? 'remove' : 'add';
      // 安装前快照（保护中心）：排队任务改的是 profile 配置面，出问题可
      // 一键/自动回滚到这里。
      ensureGuard().snapshot('market:' + job.target);
      log('market-pending', `执行(${attempts}/${MARKER_MAX_ATTEMPTS}): dsh plugin --profile ${job.profile} ${action} ${job.target}`);
      const child = spawn(nodeBin, [bin, 'plugin', '--profile', job.profile, action, job.target], {
        cwd: userDataDir,
        // CI=true 与市场插件 host 侧一致：pnpm v10 无 TTY 时对被忽略的构建
        // 脚本（如 node-llama-cpp）静默放行，而不是 ERR_PNPM_IGNORED_BUILDS 硬失败。
        env: { ...childEnv(), CI: 'true' },
        detached: !IS_WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      marketOpChild = child;
      let tail = '';
      const onData = (c) => {
        const text = c.toString();
        tail = (tail + text).slice(-8000);
        for (const line of text.split(/\r?\n/)) {
          const s = line.trim();
          // Progress: \r 进度条不进日志，只保留有信息量的行。
          if (s && !/^Progress:/.test(s)) log('market-pending', s.slice(0, 300));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => {
        log('market-pending', '排队任务超时（5 分钟），强制终止');
        killTree(child);
      }, 5 * 60 * 1000);
      child.on('error', (err) => {
        clearTimeout(timer);
        if (marketOpChild === child) marketOpChild = null;
        finishMarketMarker(marker, job, attempts, false, String(err.message));
        idx += 1;
        next();
      });
      child.on('close', async (code) => {
        clearTimeout(timer);
        if (marketOpChild === child) marketOpChild = null;
        // V4.2：pnpm 封锁构建脚本硬失败时，从输出解析包名、自动写入
        // pnpm-workspace.yaml 的 allowBuilds（兼容旧名 onlyBuiltDependencies）
        // 后重试同一任务一次（不消耗 attempts）。
        if (code !== 0 && !retried) {
          try {
            const ab = await allowBuilds();
            const keys = (ab.parseBlockedBuildKeys || (() => []))(tail);
            if (keys.length > 0) {
              const r = await ab.ensureAllowBuilds(path.join(profileDirFor(job.profile), 'pnpm-workspace.yaml'), keys);
              if (r && r.wrote) {
                log('market-pending', `[allowBuilds] 已自动放行 ${r.added.join(', ')}，自动重试`);
                retriedMarkers.add(marker);
                next();
                return;
              }
            }
          } catch (err) {
            log('market-pending', '[allowBuilds] 自动放行失败: ' + String((err && err.message) || err));
          }
        }
        finishMarketMarker(marker, job, attempts, code === 0, tail);
        idx += 1;
        next();
      });
    };
    next();
  });
  // pnpm 重写完成：回填被清掉的第三方构建产物（lib/ 等）。
  if (typeof ak.restoreArtifacts === 'function') {
    for (const profile of profiles) {
      try {
        ak.restoreArtifacts(profileDirFor(profile), artifactCacheDirFor(profile), {
          log: (m) => log('artifact-keep', m),
        });
      } catch (err) {
        log('artifact-keep', `restore ${profile} 失败: ` + err.message);
      }
    }
  }
}

// 内置 skills 分发目录：assets/skills/<kebab-name>/SKILL.md。~/.dsh/skills
// 内置资产同步 + 运行时补丁（profile/runtime-patches.js）：内置 skills 分发、
// dsh-session-manager 对话删除补丁、apiproxy 设置命名空间白名单。
// 全部幂等、失败仅记录；启动与 syncCompanionPlugins 时重放。
const runtimePatches = createRuntimePatches({
  dshHome: () => dshHome,
  userDataDir: () => userDataDir,
  readJsonFile,
  patchSessionManage,
  log,
});
const {
  syncBundledSkills,
  runtimePatchRoots,
  applySessionManageFix,
  patchApiproxyBridgeNamespace,
} = runtimePatches;

// ---------------------------------------------------------------------------
// 插件启停/卸载管理（V4，移植自上游）：设置页「插件 → 管理」标签的数据与写盘。
// 插件启停/卸载管理（profile/plugin-manager.js）：设置页「插件 → 管理」标签的
// 数据与写盘（dsh:plugin-list / set-enabled / uninstall / restore 四个 IPC 驱动
// 的实现 + 图片粘贴保存）。syncCompanionPlugins 经调用时包装传入 —— 它在下方
// companionSync 接线之后才初始化，运行时解引用，无 TDZ 问题。
const pluginManager = createPluginManager({
  desktopProfileDir,
  ensureDesktopProfileInit,
  builtinPluginSourceDir, copyPluginPackage, removeOwnedPluginPackage,
  collectPluginRows, loadBuiltinPluginState, setBuiltinPluginState, clearBuiltinPluginState,
  COMPANION_PLUGINS, onboardingLogic,
  updater, updCtx, readJsonFile,
  togglePluginInPatch, removePluginFromPatch, hasEntryId, configLinesFor,
  ensureGuard, syncCompanionPlugins: () => syncCompanionPlugins(),
  restartWebServiceCore, recoverWebServiceAfterPluginFailure,
  getServerProc: () => serverProc,
  getRestartingServer: () => restartingServer,
  fs, path, os, log,
});
const {
  pluginManagerCollect,
  pluginManagerSetEnabled,
  pluginManagerSetRemoved,
  pluginManagerUninstall,
  pluginManagerRestore,
  imagePasteSave,
  removedPluginIds,
} = pluginManager;

// profile 守卫域（profile/profile-guard.js）：共享 profile → 专属 profile 一次性
// 迁移、迁移皮肤落位、junction 归属巡检（Windows）、外部 dsh 进程探测。
// 可变状态（dshHome/quitting/restartingServer/serverProc）经 getter 调用期取值。
const profileGuard = createProfileGuard({
  isWin: IS_WIN,
  getDshHome: () => dshHome,
  getQuitting: () => quitting,
  getRestartingServer: () => restartingServer,
  getServerProc: () => serverProc,
  ensureGuard, showMainWindow, Notification,
  updater, updCtx, desktopProfileDir,
  readJsonFile, loadBuiltinPluginState, setBuiltinPluginState,
  DESKTOP_PROFILE, COMPANION_PLUGINS,
  fs, path, os, log,
});
const {
  migrateFromSharedWebProfile,
  applyLegacySkinChoice,
  startJunctionWatchdog,
  detectExternalDsh,
} = profileGuard;

// 配套插件 / 皮肤同步（profile/companion-sync.js）：内置配套插件与皮肤同步进
// 桌面专属 profile + 维护 patch overlay 行。幂等，启动 / 服务重启 / agent
// 更新后重放；失败仅记录不阻塞。
const companionSync = createCompanionSync({
  dshHomePath, ensureDesktopProfileInit,
  applySessionManageFix, patchApiproxyBridgeNamespace,
  desktopProfileDir, syncBundledPresets, ensureDefaultAgentPreset,
  loadBuiltinPluginState, removedPluginIds, removeOwnedPluginPackage,
  builtinPluginSourceDir, copyPluginPackage,
  healSoulMdPatchRow, healRowConfig, healRowDisabled,
  collectBundleEntryIds, removeBundledRowDuplicates,
  hasEntryId, configLinesFor, removePluginFromPatch,
  applyLegacySkinChoice, showMainWindow, ensureGuard,
  COMPANION_PLUGINS, SKINS_DIR, readJsonFile,
  fs, path, Notification, log,
});
const { syncCompanionPlugins } = companionSync;

// ---------------------------------------------------------------------------
// 快捷方式维护（platform/shortcuts.js）：修复「没有桌面快捷方式 / 快捷方式
// 指向的文件消失」，图标跟随设计版本刷新（.lnk 单独指定 icon.ico）；便携版
// 从系统临时目录运行时告警。仅 Windows。
// ---------------------------------------------------------------------------
const shortcutManager = createShortcutManager({
  app, shell, path, fs, os,
  isWin: IS_WIN,
  getUserDataDir: () => userDataDir,
  loadSettings, saveSettings, updCtx,
  showBox, log,
});
// ---------------------------------------------------------------------------
// 客户端自更新流程（updates/client-update-flow.js）：更新 DSH Desktop 封装本身
// （区别于 agent 更新）。Linux 由系统包管理器更新，仅提示。
// ---------------------------------------------------------------------------
const clientUpdateFlow = createClientUpdateFlow({
  isWin: IS_WIN,
  getQuitting: () => quitting,
  getClientUpdateBusy: () => clientUpdateBusy,
  setClientUpdateBusy: (v) => { clientUpdateBusy = v; },
  showBox, showUpdateWindow, makeUpdateProgressPusher,
  ensureGuard, restartWithClientUpdate,
  clientUpdater, updater,
  updCtx, loadSettings, saveSettings,
  APP_VERSION, fs, log,
});
const { runClientUpdateFlow, offerPendingClientUpdate } = clientUpdateFlow;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 预览静态文件服务：独立端口的只读文件服务，供「站内 HTML 预览」的 iframe 使用。
// 为什么要独立端口：浏览器对同一主机 HTTP/1.1 并发连接上限 6，web UI 自身
// 长连接已占满；预览 iframe 及其相对资源若走 dsh 宿主会被排队。仅接受回环。
// ---------------------------------------------------------------------------

let previewStaticPort = 0;

function startPreviewStaticServer() {
  const MIME = {
    ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
    ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
    ".json": "application/json", ".map": "application/json", ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf", ".xml": "application/xml"
  };
  const TEXT_MIME = /^(text\/|application\/(json|javascript|xhtml\+xml|xml)|image\/svg)/;
  const server = http.createServer((req, res) => {
    const ra = req.socket && req.socket.remoteAddress;
    if (ra !== "127.0.0.1" && ra !== "::1" && ra !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname.slice(1));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    if (!path.isAbsolute(p)) {
      res.writeHead(400);
      res.end();
      return;
    }
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const mime = MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "content-type": TEXT_MIME.test(mime) ? mime + "; charset=utf-8" : mime,
        "content-length": String(st.size),
        "cache-control": "no-store"
      });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(p).pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    previewStaticPort = server.address().port;
    log("boot", "预览静态服务已启动: http://127.0.0.1:" + previewStaticPort);
  });
  server.on("error", (err) => log("boot", "预览静态服务失败: " + err.message));
}

// Issue #7: verify the bundled node_modules against the build-time manifest
// before starting dsh web. A botched upgrade leaves empty package skeletons;
// Node then dies with ERR_MODULE_NOT_FOUND in a loop. Tell the user to
// reinstall instead (with an escape hatch to continue anyway).
function verifyBundledModules() {
  if (!app.isPackaged) return Promise.resolve();
  const appDir = path.join(process.resourcesPath, 'app');
  const manifestPath = path.join(appDir, 'bundle-manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return Promise.resolve(); }
  const r = bundleIntegrity.verifyBundle(path.join(appDir, 'node_modules'), manifest);
  if (r.skipped || r.ok) return Promise.resolve();
  const sample = r.damaged.slice(0, 5).map((d) => `${d.name}（${d.reason}）`).join('、');
  log('boot', `捆绑依赖完整性校验失败（${r.damaged.length} 个包受损）: ${sample}${r.damaged.length > 5 ? ' 等' : ''}`);
  return showBox({
    type: 'error',
    title: '程序文件受损',
    message: `检测到 ${r.damaged.length} 个捆绑依赖包文件缺失，可能是升级中断或安全软件清理所致。`,
    detail: `受损包: ${sample}${r.damaged.length > 5 ? `（共 ${r.damaged.length} 个）` : ''}\n\n建议重新下载安装包覆盖安装（GitHub Releases 最新版）。\n选择「仍然启动」大概率无法正常运行。`,
    buttons: ['仍然启动', '退出'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response !== 0) {
      forceQuit = true;
      markCleanExit(); // 用户选择退出：不让看门狗拉起一个已知损坏的安装
      app.exit(1);
    }
  });
}

// 全新 vs 老用户判定（须在 run-state / migrate 标记 / 稳定端口等任何写盘
// 之前调用）：settings.json 在迁移流程里会被无条件创建，事后无法区分。
function computeOnboardingNeed() {
  const settings = updater.loadSettings(updCtx());
  return onboardingLogic.needsPluginOnboarding({
    settings,
    settingsFileExists: fs.existsSync(updater.settingsPath(updCtx())),
    profileDirExists: fs.existsSync(path.join(desktopProfileDir(), 'node_modules')),
    sharedProfileExists: fs.existsSync(path.join(dshHome || path.join(os.homedir(), '.dsh'), 'profiles', 'web')),
  });
}

async function boot() {
  // Portable builds keep all data next to the exe.
  if (!app.isPackaged && process.env.DSH_DESKTOP_USERDATA) {
    app.setPath('userData', process.env.DSH_DESKTOP_USERDATA);
  } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
  }

  userDataDir = app.getPath('userData');
  logsDir = path.join(userDataDir, 'logs');
  // DSH_HOME: respect an explicit override; otherwise let dsh use its own
  // default (~/.dsh), so the desktop app shares config/sessions with the CLI.
  dshHome = process.env.DSH_HOME || '';
  fs.mkdirSync(logsDir, { recursive: true });
  if (dshHome) fs.mkdirSync(dshHome, { recursive: true });
  desktopLog = fs.createWriteStream(path.join(logsDir, 'desktop.log'), { flags: 'a' });
  log('boot', `Deepseek Harness EAC（封装 ${APP_VERSION}）  userData=${userDataDir}  dshHome=${dshHome || '(dsh 默认)'}  agent=${dshVersion()}(${dshVersionSource()})`);

  // 移除原生菜单栏（文件/视图/帮助），全部功能由自绘 chrome 与托盘提供。
  installAppMenu();
  startPreviewStaticServer();
  registerAppIpc();
  createTray();
  // 新老用户判定必须在任何写盘之前：run-state / migrate 标记 / 稳定端口
  // 都会在启动早期创建 settings.json，事后无法区分全新安装与升级。
  const onboardingNeeded = computeOnboardingNeed();
  // 看门狗 + 运行状态标记（安装版）：意外崩溃后自动拉起并告知用户。
  writeRunState();
  startWatchdog();
  const uncleanPrev = detectUncleanPreviousRun();
  // V4.1 更新保障③：便携版客户端更新后若新版崩溃（非干净退出 + 上一版
  // 备份 marker 仍在），先用上一版还原再继续启动，随后再告知用户。
  autoRollbackClientIfCrashed(uncleanPrev);
  if (uncleanPrev) notifyUncleanRestart(uncleanPrev);
  // 渲染进程崩溃/挂起自恢复状态机：必须在 createWindow 之前装配。
  initRendererRecovery();
  startHeartbeatLoop();
  // 一次性迁移：从共享 web profile 切到桌面专属 profile（与原生 CLI 共存）。
  migrateFromSharedWebProfile();
  // 首次启动内置插件选择向导：仅全新用户展示（升级用户静默跳过）。提交的
  // 选择在 onboard:submit 里已写入 patch（disabled/裸条目），此后 sync 的
  // 「已有行不重写」规则天然保留用户选择。
  await runPluginOnboardingIfNeeded(onboardingNeeded);
  syncCompanionPlugins();
  syncBundledSkills();
  healProfileModules();
  createWindow();
  // koffi FFI 预检（koffi-preflight.js，V4 改异步：同步 spawnSync 会把主
  // 进程事件循环卡住最长 20 秒）：失败则注入目录选择器降级 overlay，
  // 由 startAndShow 以 --patch 交给 dsh web。必须在 startAndShow 之前完成。
  // 仅 Windows：探针加载 kernel32.dll，Linux 上必然失败，不应误注入降级
  // overlay，直接放行后续链。
  // junction 归属守卫：原生 dsh 会把共享模块指到它自己的闭包，这里先纠偏
  // 一次，并启动周期巡检（原生进程退出后自动恢复指向）。
  (IS_WIN ? applyKoffiPreflightAsync() : Promise.resolve())
    .then(() => {
      ensureGuard().repairJunctions();
      startJunctionWatchdog();
    })
    // 插件市场排队任务（服务运行中撞文件锁转待重启的安装/卸载）：趁服务
    // 尚未启动、无文件锁时先完成，再拉起 Web 服务。
    .then(() => processPendingMarketOps())
    .then(async () => {
      // 排队的 pnpm 操作可能刚重写 profile node_modules（删掉配套插件副本、
      // hoist 核心包形成双实例）—— 服务启动前重建副本并清理遮蔽，
      // 保证加载的始终是内置分发版本。
      syncCompanionPlugins();
      syncBundledSkills();
      healProfileModules();
      // V4 兜底：上次 pnpm 后异常退出没回填的第三方构建产物（meow-memory
      // 的 lib/ 等）在这里补上（processPendingMarketOps 正常路径已含回填，
      // 这里覆盖崩溃/强杀场景；无缓存时为空操作）。
      await restoreKeptArtifacts(desktopProfile());
    })
    .then(() => verifyBundledModules())
    .then(() => startAndShowGuarded())
    .then(() => {
      // V4.1 更新保障②/③：新版健康启动 —— 清理官方 dsh 上一版本备份与
      // 便携版客户端旧 exe 备份（崩溃自回退的保险丝就此解除）。
      updater.confirmPreviousAgentHealthy(updCtx());
      cleanupClientBackupIfHealthy();
      // Session-completion notifications: watch dsh session logs under the
      // effective DSH_HOME (same config the CLI uses).
      const s = loadSettings(updCtx());
      notifyOnTurnEnd = s.notifyOnTurnEnd !== false;
      const home = dshHomePath();
      sessionWatcher = new SessionWatcher({
        sessionsDir: path.join(home, 'sessions'),
        log,
        onTurnEnd: (info) => onSessionTurnEnd(info),
      });
      sessionWatcher.start();
      maintainShortcuts();
      warnTempRun();
      startBalanceLoop();
      if (IS_WIN) offerPendingClientUpdate();

      if (!process.env.DSH_DESKTOP_SKIP_AUTO_UPDATE) {
        // dsh agent 更新：启动 15 秒后 + 每 6 小时。
        setTimeout(() => runUpdateFlow(false), 15000).unref();
        setInterval(() => runUpdateFlow(false), AUTO_UPDATE_INTERVAL_MS).unref();
      }
      if (IS_WIN && !process.env.DSH_DESKTOP_SKIP_CLIENT_UPDATE) {
        // 客户端（封装）更新：启动 60 秒后 + 每 12 小时。
        setTimeout(() => runClientUpdateFlow(false), 60000).unref();
        setInterval(() => runClientUpdateFlow(false), 12 * 3600 * 1000).unref();
      }
      if (!process.env.DSH_DESKTOP_SKIP_PLUGIN_UPDATE) {
        // 内置插件上游更新检查：启动 20 秒后 + 每 6 小时（24h 落盘节流
        // 在 runPluginUpdateCheck 内；默认仅提示，见 plugin-updater.js）。
        setTimeout(() => runPluginUpdateCheck(false), 20000).unref();
        setInterval(() => runPluginUpdateCheck(false), 6 * 3600 * 1000).unref();
      }
    })
    .catch((err) => handleBootFailure(err));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.deepseek.dsh.desktop');
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('before-quit', (event) => {
    ensureShutdownCoordinator().beforeQuit(event);
  });
  app.on('window-all-closed', () => {
    if (!IS_WIN || !tray) app.quit();
  });
  app.whenReady().then(() => {
    if (!IS_WIN && !IS_LINUX) {
      dialog.showErrorBox('不支持的操作系统', '当前版本仅支持 Windows 和 Linux。');
      app.quit();
      return;
    }
    boot();
  }).catch((err) => fatal('应用初始化失败', err));
}

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
// The dsh CLI is spawned with the bundled node.exe (vendor/node/node.exe in
// dev, resources/node/node.exe when packaged) so that prebuilt native
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
const structuredLogger = require('./logger');
const balance = require('./balance');
const { healProfileModuleShadowing } = require('./profile-module-heal');
const { createGuard } = require('./plugin-guard');
const bundleIntegrity = require('./bundle-integrity');
const { RendererRecovery } = require('./renderer-recovery');
const { restrictedPortOf, chooseStableWebPort } = require('./stable-port');
const {
  runKoffiPreflight,
  runKoffiPreflightAsync,
  enablePickerBrowseOverlay,
  clearAutoPickerBrowseOverlay,
} = require('./koffi-preflight');
const { configLinesFor, healSoulMdPatchRow, healRowConfig, removeBundledRowDuplicates, collectBundleEntryIds } = require('./patch-row-heal');
const { syncBundledPresets, ensureDefaultAgentPreset } = require('./preset-sync');
const { buildErrorDetail } = require('./error-detail');
const { SessionWatcher, scanZstdFrames } = require('./session-watcher');
const { isEncodingMismatch, healSessionEncodingConflicts } = require('./session-encoding-heal');
const { patchSessionManage } = require('./scripts/patch-session-manage');
const { togglePluginInPatch, removePluginFromPatch, hasEntryId } = require('./scripts/plugin-manager-patch');
const { collectPluginRows } = require('./plugin-manager-state');
const onboardingLogic = require('./scripts/onboarding');
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// H2/H3 路径围栏：文件还原/打开只允许「会话 cwd」之下的项目文件。
// 任意绝对路径（如写入 Startup\*.bat）一律拒绝；缓存 5 分钟。
// ---------------------------------------------------------------------------
const DANGEROUS_EXT = /\.(bat|cmd|com|exe|ps1|vbs|lnk|js|jse|msi|scr|pif|reg)$/i;
const fileRootsCache = { at: 0, roots: [] };

function fileRoots() {
  if (Date.now() - fileRootsCache.at < 5 * 60 * 1000) return fileRootsCache.roots;
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
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
const APP_VERSION = app.getVersion();
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let serverProc = null;
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
// V4 退出清理：before-quit 只允许进入一次异步清理（防止重复触发）。
let shutdownInProgress = false;
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
  // 双通道记录（日志系统接入 AC-1 / AC-3）：
  //   1) 旧 desktop.log 纯文本 —— 保留，便于 tail/外部脚本、NSIS 卸载诊断、非结构化查看。
  //   2) 结构化 logger.{level}(msg, { tag, ... }) —— JSON lines + PII 脱敏 + rotation + 诊断 zip 导出。
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
  try {
    const level = /^(warn|warning|err|error|fatal)$/i.test(tag) ? 'warn'
      : /^debug$|trace$/i.test(tag) ? 'debug' : 'info';
    structuredLogger[level](msg, { tag });
  } catch {}
}

function nodeExe() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'node', 'node.exe');
  return path.resolve(__dirname, 'vendor', 'node', 'node.exe');
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

function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WIN) {
      // M2 修复：先优雅（无 /F）给进程收尾机会（避免撕裂 session.jsonl.zstd），
      // 短等待后仍存活再强杀。
      spawn('taskkill', ['/pid', String(proc.pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      const pid = proc.pid;
      setTimeout(() => {
        try {
          const query = 'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH';
          const alive = require('node:child_process').execSync(query, { encoding: 'utf8', windowsHide: true });
          if (alive.includes(String(pid))) {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          }
        } catch { /* 进程已退出或查询失败 */ }
      }, 1500);
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
    }
  } catch (err) {
    log('killTree', String(err));
  }
}

// V4 修复「退出后残留一对进程」：退出路径专用的有界同步回收。
// 旧实现在 before-quit 里调用 killTree —— 强杀补刀挂在 1500ms 的
// setTimeout 上，而 Electron 在 before-quit 后数百毫秒内就退出，定时器
// 随主进程湮灭；无 /F 的 taskkill 对控制台进程（node.exe 没有顶层窗口，
// 无处投递 WM_CLOSE）基本无效。结果是 dsh web 的 node.exe 连同它的
// conhost.exe 每次退出都原样残留（用户实测三次，三次成对）。
// 这里：优雅 taskkill → 等待 graceMs → 仍存活则 taskkill /T /F → 再等
// hardMs，全程有界，绝不无限阻塞退出。
async function killTreeAndWait(proc, { graceMs = 1200, hardMs = 4000 } = {}) {
  if (!proc || !proc.pid || proc.exitCode !== null) return;
  const pid = proc.pid;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      await waitForProcExit(proc, graceMs);
      if (proc.exitCode !== null) return;
      try {
        const alive = require('node:child_process').execSync(
          'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
        if (!alive.includes('"' + pid + '"')) return;
      } catch { return; }
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await waitForProcExit(proc, hardMs);
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
      await waitForProcExit(proc, graceMs);
      if (proc.exitCode !== null) return;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      await waitForProcExit(proc, hardMs);
    }
  } catch (err) {
    log('killTree', String(err));
  }
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

// V4.3 PR（独有价值，review 保留项）：客户端更新成功后 24h 内非阻塞询问
// 是否清理 4 目录 robocopy 备份。超 24h 不自动弹（避免打扰）；用户取消则写
// pendingBackupCleanup 进 settings，设置页可手动清理；确认则递归删除备份
// 目录，但保留 manifest.json 诊断副本到 backups/<ts>.manifest.json 。
//
// Review 特别提示：offerBackupCleanupConfirm 曾留有一个「空操作 setTimeout」
// 死代码，本实现明确不引入无副作用定时器，避免 review 打回。
function offerBackupCleanupConfirm() {
  if (!IS_WIN) return;
  const marker = path.join(userDataDir, 'updates', '.backup-ts');
  if (!fs.existsSync(marker)) return;
  let ts = '';
  try { ts = String(fs.readFileSync(marker, 'utf8')).trim(); } catch { ts = ''; }
  if (!ts) { try { fs.rmSync(marker, { force: true }); } catch {} return; }
  // 24h 窗口：超期不弹（marker 先保留，settings 里可看到并清理）。
  const tsNum = Number(ts);
  const ageSec = Number.isFinite(tsNum) && tsNum > 1e9 ? Math.floor(Date.now() / 1000) - tsNum : 0;
  if (ageSec > 24 * 3600) {
    log('client-update', `备份 ${ts} 已超 24h（${Math.floor(ageSec/3600)}h），跳过自动清理确认（可在设置页手动清理）`);
    try {
      const c = updCtx();
      const s = updater.loadSettings(c);
      s.pendingBackupCleanup = ts;
      updater.saveSettings(c, s);
    } catch {}
    return;
  }
  // 删除 marker（无论用户确认/取消，本提示只弹一次）
  try { fs.rmSync(marker, { force: true }); } catch {}
  // 非阻塞异步（不阻塞 mainWindow 显示）；dialog.showMessageBox 返回 Promise
  // （Electron 下主进程调用即异步，回调中处理用户选择）。
  const { dialog } = require('electron');
  const ageInfo = ageSec > 0 ? `（已保留 ${Math.floor(ageSec / 3600)} 小时 ${Math.floor((ageSec % 3600) / 60)} 分钟）` : '';
  // 等主窗口就绪后再弹，避免在启动早期抢焦点
  const fire = () => {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'question',
      title: '更新成功',
      message: '客户端更新成功，是否删除更新前的备份？',
      detail: `备份包含用户目录、安装目录等 4 个目录${ageInfo}；保留可随时在「设置 - 存储管理」手动清理。`,
      buttons: ['保留备份', '删除备份'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => {
      const backupDir = path.join(userDataDir, 'backups', ts);
      if (response === 1) {
        // 1 = 删除备份：保留 manifest 诊断副本，递归删目录
        try {
          const srcManifest = path.join(backupDir, 'manifest.json');
          const dstManifest = path.join(userDataDir, 'backups', `${ts}.manifest.json`);
          if (fs.existsSync(srcManifest)) {
            try { fs.copyFileSync(srcManifest, dstManifest); } catch (err) { log('client-update', '备份 manifest 诊断副本保留失败: ' + err.message); }
          }
          if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true, maxRetries: 3 });
          log('client-update', `已清理备份 ${ts}（保留诊断副本）`);
          try {
            const n = new Notification({
              title: '备份已清理',
              body: '更新前的备份已删除，诊断清单保留在 backups 目录下。',
              icon: path.join(__dirname, 'assets', 'icon.png'),
            });
            n.on('click', () => showMainWindow());
            n.show();
          } catch {}
        } catch (err) {
          log('client-update', `清理备份 ${ts} 失败: ` + err.message);
        }
      } else {
        // 0 = 保留：写 pendingBackupCleanup 进 settings
        try {
          const c = updCtx();
          const s = updater.loadSettings(c);
          s.pendingBackupCleanup = ts;
          updater.saveSettings(c, s);
          log('client-update', `已登记保留备份 ${ts}，设置页可手动清理`);
        } catch (err) {
          log('client-update', '写 pendingBackupCleanup 失败: ' + err.message);
        }
      }
    }).catch((err) => {
      log('client-update', '备份确认对话框失败: ' + err.message);
    });
  };
  if (mainWindow && mainWindow.isVisible()) {
    fire();
  } else {
    // 若主窗口尚未 ready，等 once('ready-to-show') 再弹
    const onceReady = () => { fire(); if (mainWindow) mainWindow.removeListener('ready-to-show', onceReady); };
    if (mainWindow) mainWindow.once('ready-to-show', onceReady);
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

// 等待一个子进程真正退出（taskkill 先优雅后强杀，锁住的 DLL 要等进程
// 终止才释放）。轮询 tasklist，超时后放行由调用方自行处理。
function waitForProcExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (!proc || !proc.pid) return resolve();
    const pid = proc.pid;
    const started = Date.now();
    const isAlive = () => {
      if (proc.exitCode !== null) return false;
      if (!IS_WIN) {
        try { process.kill(pid, 0); return true; } catch { return false; }
      }
      try {
        const out = require('node:child_process').execSync(
          'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
        return out.includes('"' + pid + '"');
      } catch { return false; }
    };
    const check = () => {
      if (!isAlive()) return resolve();
      if (Date.now() - started >= timeoutMs) {
        log('service', '等待旧服务进程退出超时（PID ' + pid + '），继续');
        return resolve();
      }
      setTimeout(check, 200);
    };
    check();
  });
}

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

// stable-port.js 的依赖注入适配器：把 updater 的 settings 读写桥接过去。
function stablePortCtx() {
  const c = updCtx();
  return {
    loadSettings: () => updater.loadSettings(c),
    saveSettings: (_ctx, s) => updater.saveSettings(c, s),
  };
}

async function startServer(unsafePortRetries = 4, overlays = []) {
  // M1 修复：重入前先终结旧进程，避免孤儿 harness 同时写同一 DSH_HOME。
  if (serverProc && !serverProc.killed && !quitting) {
    log('dsh', 'startServer 重入：先终结旧进程再启动');
    killTree(serverProc);
    serverProc = null;
  }
  // 稳定端口（stable-port.js）：复用 settings.webPort，避免每次 --port 0
  // 换 origin 导致 localStorage 偏好丢失；同时避开 Chromium 受限端口。
  const webPort = await chooseStableWebPort(stablePortCtx());
  return new Promise((resolve, reject) => {
    const nodeBin = nodeExe();
    const bin = dshBin();
    if (!fs.existsSync(nodeBin)) {
      return reject(new Error(
        '找不到内置 Node 运行时: ' + nodeBin + '\n' +
        (app.isPackaged ? '安装包可能不完整，请重新安装。' : '开发模式请先运行: npm run fetch-node')
      ));
    }
    const out = fs.createWriteStream(path.join(logsDir, 'dsh-web.log'), { flags: 'a' });
    log('dsh', `启动: "${nodeBin}" "${bin}" web --host 127.0.0.1 --port ${webPort}`);
    // --use-system-ca: 让 dsh web 进程信任系统证书库（代理/MITM 场景下内置 node 的
    // 默认 CA 无法验证，导致插件市场等对外 fetch 失败）。
    const patchArgs = overlays
      .filter((p) => typeof p === 'string' && p && fs.existsSync(p))
      .flatMap((p) => ['--patch', p]);
    // `--profile <name>` 直接在根命令上（本版本的 `web` 是 --profile web 的
    // 硬编码别名，不接受父级 --profile）；app 入口由 profile bundles 决定，
    // --host/--port 等透传给该 app。已实机冒烟验证 web-desktop 可启动。
    const proc = spawn(nodeBin, ['--use-system-ca', bin, '--profile', desktopProfile(), '--host', '127.0.0.1', '--port', String(webPort), ...patchArgs], {
      cwd: userDataDir,
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc = proc;
    // V4：profile 首次引导（node_modules 缺失）时 dsh 要先跑 pnpm 装齐依赖，
    // 就绪等待放宽（见 watchServerProc 的 bootTimer）。
    const firstBoot = !fs.existsSync(path.join(desktopProfileDir(), 'node_modules'));
    watchServerProc(proc, out, { expectedPort: webPort, unsafePortRetries, overlays, firstBoot }).then(resolve, reject);
  });
}

// 等待 dsh web 子进程 stdout 出现就绪 URL 行；进程提前退出 / 启动超时则拒绝。
// 退出时若服务已就绪过（webUrl 已设）且非主动重启，弹「DSH 服务已停止」对话框。
function watchServerProc(proc, out, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let handedOff = false; // 受限端口重启：本实例的退出不再影响外层 Promise/弹窗
    let bootTimer = null;
    const finish = (fn, value) => {
      if (!settled) { settled = true; fn(value); }
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    };
    const onData = (chunk) => {
      out.write(chunk);
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/dsh web:\s+(https?:\/\/\S+)/);
        if (!m) continue;
        let blocked;
        if (testForceUnsafeOnce) {
          testForceUnsafeOnce = false;
          blocked = 6000; // 测试钩子：仅第一次强制视为受限端口
        } else {
          blocked = restrictedPortOf(m[1]);
        }
        if (blocked && opts.unsafePortRetries > 0) {
          // 端口命中 Chromium 受限列表：结束该实例重启换端口（有上限）。
          // 标记 handedOff，本实例的 exit 事件不得提前 reject 外层 Promise
          // 或弹出「服务已停止」对话框，结果交由递归重启决定。
          handedOff = true;
          log('dsh', `端口 ${blocked} 属于 Chromium 受限端口（ERR_UNSAFE_PORT），重启服务换端口（剩余重试 ${opts.unsafePortRetries} 次）`);
          killTree(proc);
          setTimeout(() => {
            if (quitting) return finish(reject, new Error('应用正在退出'));
            startServer(opts.unsafePortRetries - 1, opts.overlays).then(
              (url) => finish(resolve, url),
              (err) => finish(reject, err)
            );
          }, 600);
          return;
        }
        // 稳定端口：若 dsh 最终监听端口与请求的不同（极端兜底），以实际为准并保存。
        try {
          const actual = Number(new URL(m[1]).port) || 0;
          if (opts.expectedPort != null && actual > 0 && actual !== opts.expectedPort) {
            const c = updCtx();
            const settings = updater.loadSettings(c);
            settings.webPort = actual;
            updater.saveSettings(c, settings);
          }
        } catch {}
        finish(resolve, m[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (c) => out.write(c));
    proc.on('error', (err) => finish(reject, err));
    // V4：HTTP 就绪探测与 stdout 就绪行并行竞争 —— 就绪行被管道缓冲吞掉
    // 或格式变化时不再白白等满 bootTimer（「启动 60 秒超时」的主要假阳性
    // 来源）。expectedPort 由 chooseStableWebPort 挑选、已避开 Chromium
    // 受限端口，探测命中的 URL 与请求端口一致；受限端口重启交接（handedOff）
    // 期间 settled 由递归重启决定，探测自然退出。
    if (opts.expectedPort && restrictedPortOf(`http://127.0.0.1:${opts.expectedPort}`) === 0) {
      const probeUrl = `http://127.0.0.1:${opts.expectedPort}`;
      (async () => {
        while (!settled) {
          const ok = await new Promise((res) => {
            const req = http.get(probeUrl + '/', { timeout: 2500 }, (r) => {
              r.resume();
              res(!!r.statusCode && r.statusCode < 500);
            });
            req.on('error', () => res(false));
            req.on('timeout', () => { req.destroy(); res(false); });
          }).catch(() => false);
          if (ok) { finish(resolve, probeUrl); return; }
          await new Promise((r) => setTimeout(r, 350));
        }
      })();
    }
    proc.on('exit', (code, signal) => {
      out.end();
      log('dsh', `进程退出 code=${code} signal=${signal}`);
      // 原地重启（插件市场）或已替换为新进程时，不打扰用户、也不清掉新进程的句柄。
      const intentional = restartingServer || serverProc !== proc;
      if (serverProc === proc) serverProc = null;
      if (!handedOff) {
        finish(reject, new Error(`dsh web 启动失败（退出码 ${code}）。日志: ${path.join(logsDir, 'dsh-web.log')}`));
      }
      if (!quitting && !intentional && !handedOff && webUrl && mainWindow && !mainWindow.isDestroyed()) {
        const detail = buildErrorDetail(new Error(`dsh web 进程退出（code=${code} signal=${signal}）`), logsDir, ['dsh-web.log']);
        showBox({
          type: 'error',
          title: 'DSH 服务已停止',
          message: 'DeepSeek Harness 服务意外退出。',
          detail,
          buttons: ['复制日志', '重新启动', '退出'],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        }).then(({ response }) => {
          if (response === 0) clipboard.writeText(detail);
          else if (response === 1) startAndShow().catch((err) => handleBootFailure(err));
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
      () => finish(reject, new Error(`等待 dsh web 启动超时（${Math.round(bootTimeoutMs / 1000)} 秒）`)),
      bootTimeoutMs
    );
    bootTimer.unref();
  });
}

function waitUntilUp(url, timeoutMs = 120000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
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
    // V4.4：会话目录同时存在 zstd + 明文两种编码时，会话持久化后端会抛
    // encodingMismatch 让整棵插件树起不来（Issue #77）—— 同样是体检看不到
    // 的数据层问题，一并走 preRetry 归档相反格式文件后重试。
    { preRetry: bootRescuePreRetry }
  );
}

// V4.4：守护启动 preRetry 汇聚 —— 把两类「体检看不到的数据/配置层修复」
// 合并为一次钩子调用（guardedBoot 只调用 preRetry 一次）。任一命中即返回
// 合并后的 { applied }，均未命中返回 false（走原失败链路）。
async function bootRescuePreRetry(errText) {
  const applied = [];
  // 1) 会话编码冲突（Issue #77）：归档相反格式的遗留日志文件（数据无损）。
  try {
    let text = String(errText || '');
    if (!isEncodingMismatch(text)) {
      // 报错详情常只落在 dsh-web.log 里，补充解析尾部。
      try { text += '\n' + fs.readFileSync(path.join(logsDir, 'dsh-web.log'), 'utf8').slice(-40000); } catch {}
    }
    if (isEncodingMismatch(text)) {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const archived = healSessionEncodingConflicts(path.join(home, 'sessions'), { compression: 'zstd', log });
      if (archived.length) applied.push('会话编码冲突自愈：已归档 ' + archived.length + ' 个相反格式的遗留会话日志');
    }
  } catch (err) {
    log('session-heal', 'preRetry 会话编码自愈失败: ' + String((err && err.message) || err));
  }
  // 2) pnpm allowBuilds 自动放行（原 V4.2 逻辑）。
  try {
    const ab = await allowBuildsPreRetry(errText);
    if (ab && Array.isArray(ab.applied)) applied.push(...ab.applied);
    else if (ab) applied.push('pnpm allowBuilds 自动放行');
  } catch (err) {
    log('guard', 'preRetry allowBuilds 失败: ' + String((err && err.message) || err));
  }
  return applied.length ? { applied } : false;
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
  const settings = updater.loadSettings(ctx);
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
    updater.saveSettings(ctx, settings);
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
    if (r2 === 0) {
      quitting = true;
      markCleanExit();
      killTree(serverProc);
      app.relaunch();
      app.exit(0);
    }
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
  const s = updater.loadSettings(updCtx());
  return s.closeToTray !== false;
}

function setCloseToTray(v) {
  const s = updater.loadSettings(updCtx());
  s.closeToTray = !!v;
  updater.saveSettings(updCtx(), s);
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
async function restartWebServiceCore() {
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

function registerChromeIpc() {
  ipcMain.handle('chrome:init', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    let iconDataUri = '';
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
      if (buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50) {
        iconDataUri = 'data:image/png;base64,' + buf.toString('base64');
      }
    } catch {}
    const s = updater.loadSettings(updCtx());
    const urls = repoUrls();
    return {
      appVersion: APP_VERSION,
      agentVersion: dshVersion(),
      agentSource: dshVersionSource(),
      notifyOnTurnEnd,
      closeToTray: s.closeToTray !== false,
      exitAction: getExitAction(),
      shortcutPolicy: s.shortcutPolicy === 'never' ? 'never' : 'auto',
      iconDataUri,
      repoUrls: urls,
      staticPort: previewStaticPort,
    };
  });

  // Renderer 心跳：preload 每 5s 上报一次，恢复状态机用它兜底判定
  // 「挂起但 Chromium 未发出 unresponsive」的场景。
  ipcMain.on('dsh:renderer-heartbeat', (event) => {
    if (recovery) recovery.noteHeartbeat(event.sender.id);
  });

  // 恢复页面（assets/recovery.html）的按钮与状态读取。全部校验来源必须是主窗。
  ipcMain.handle('chrome:recovery-state', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    return {
      appVersion: APP_VERSION,
      logsDir,
      crashDumpsDir: app.getPath('crashDumps'),
      state: recovery ? recovery.stateOf(mainWindow) : null,
    };
  });

  ipcMain.handle('chrome:recovery-reload', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    // 服务进程已退出时先重启服务（可能换新端口），再恢复加载。
    if (!serverProc || serverProc.exitCode !== null || serverProc.killed) {
      try {
        await startAndShowGuarded();
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    recovery.retryNow(mainWindow);
    return { ok: true };
  });

  ipcMain.handle('chrome:recovery-restart', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    log('recovery', '用户在恢复页面选择重启客户端');
    quitting = true;
    forceQuit = true;
    markCleanExit();
    killTree(serverProc);
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // 一键导出诊断日志 zip（AC-8）：调用 structuredLogger.buildDiagnosticsZip，
  // 打包 logs + configs + updater meta + 最新备份 manifest，PII 二次脱敏后
  // 在文件管理器中选中 zip 文件，方便用户拖到反馈/GitHub issue 里。
  ipcMain.handle('chrome:export-logs', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const zipPath = await structuredLogger.buildDiagnosticsZip({ logsDir, userDataDir, dshHome });
      shell.showItemInFolder(zipPath);
      return { ok: true, zipPath };
    } catch (err) {
      log('boot', '导出诊断日志失败: ' + (err && err.message || err));
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('chrome:window', (event, { action } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    switch (action) {
      case 'minimize': mainWindow.minimize(); break;
      case 'toggle-maximize': mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); break;
      case 'close': mainWindow.close(); break;
      case 'is-maximized': return mainWindow.isMaximized();
    }
    return null;
  });

  ipcMain.handle('chrome:menu', async (event, { action, value } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { notifyOnTurnEnd, closeToTray: closeToTrayEnabled(), exitAction: getExitAction() };
    }
    switch (action) {
      case 'reload': mainWindow.reload(); break;
      case 'devtools': mainWindow.webContents.toggleDevTools(); break;
      case 'fullscreen': mainWindow.setFullScreen(!mainWindow.isFullScreen()); break;
      case 'open-browser': if (webUrl) shell.openExternal(webUrl); break;
      case 'open-logs': shell.openPath(logsDir); break;
      case 'feedback': shell.openExternal('https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues'); break;
      case 'check-agent-update': runUpdateFlow(true); break;
      case 'check-client-update': runClientUpdateFlow(true); break;
      case 'toggle-notify': {
        notifyOnTurnEnd = !notifyOnTurnEnd;
        const s = updater.loadSettings(updCtx());
        s.notifyOnTurnEnd = notifyOnTurnEnd;
        updater.saveSettings(updCtx(), s);
        break;
      }
      case 'toggle-close-to-tray': setCloseToTray(!closeToTrayEnabled()); break;
      case 'set-exit-action': setExitAction(value); break;
      case 'restart-service': {
        // 不关闭应用重启 dsh web 服务（皮肤/插件切换后生效，等同市场安装
        // 后的自动重启路径）。窗口由 startAndShow 重载到新端口。
        const r = await restartWebServiceCore();
        if (!r.ok && r.error !== 'not-running') {
          showBox({
            type: 'error',
            title: '重启 Web 服务失败',
            message: 'dsh web 服务重启未成功。',
            detail: r.error,
            buttons: ['确定'],
          }).catch(() => {});
        }
        break;
      }
      case 'toggle-shortcut-policy': {
        // V4（用户建议③）：桌面快捷方式自动维护开关。关掉后启动不再自动
        // 创建/修复桌面快捷方式（开始菜单的仍维护 —— 系统通知的前置条件）。
        const s = updater.loadSettings(updCtx());
        s.shortcutPolicy = s.shortcutPolicy === 'never' ? 'auto' : 'never';
        updater.saveSettings(updCtx(), s);
        log('boot', '桌面快捷方式自动维护: ' + s.shortcutPolicy);
        break;
      }
      case 'about': showAbout(); break;
      case 'quit': forceQuit = true; app.quit(); break;
    }
    const menuState = updater.loadSettings(updCtx());
    return {
      notifyOnTurnEnd,
      closeToTray: closeToTrayEnabled(),
      exitAction: getExitAction(),
      shortcutPolicy: menuState.shortcutPolicy === 'never' ? 'never' : 'auto',
    };
  });

  // 插件市场：原地重启 dsh web 服务（安装/卸载插件后生效，窗口重载到新端口）。
  // 核心逻辑 restartWebServiceCore 在模块作用域（⋯ 菜单与托盘共用）。
  ipcMain.handle('chrome:restart-service', async (event, payload = {}) => {
    if (payload?.intent !== 'restart-service') return { ok: false, error: 'missing-intent' };
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    return restartWebServiceCore();
  });

  // 插件保护中心（plugin-guard.js）：快照 / 回滚 / 体检 / 修复 / 事故报告。
  // 设置页「插件保护」分区（dsh-plugin-shield 插件）从这里取数与触发动作。
  ipcMain.handle('guard:action', async (event, { action, value } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const g = ensureGuard();
    switch (action) {
      case 'status': {
        const st = (() => { try { return updater.loadSettings(updCtx()); } catch { return {}; } })();
        return {
          ok: true,
          profile: desktopProfile(),
          shareWebProfile: st.shareWebProfile === true,
          snapshots: g.listSnapshots().slice(0, 20),
          incidents: g.listIncidents().slice(0, 20),
          lastGood: g.lastGoodSnapshot(),
        };
      }
      case 'snapshot': {
        const s = g.snapshot(String(value || 'manual'));
        return { ok: !!s, snapshot: s };
      }
      case 'restore': {
        if (serverProc && !restartingServer) {
          // 服务运行中不能换配置文件（文件锁 + 进程内存态）：走标准重启窗口。
          return { ok: false, error: 'service-running', hint: '请先重启 Web 服务（或让回滚在重启间隙执行）' };
        }
        return g.restore(value);
      }
      case 'check':
        return { ok: true, report: g.healthCheck() };
      case 'repair': {
        const r = g.repair();
        return { ok: true, applied: r.applied };
      }
      case 'incident':
        return g.readIncident(value);
      case 'resolve-incident':
        return g.resolveIncident(value);
      default:
        return { ok: false, error: 'unknown action' };
    }
  });

  // 插件管理（V4，设置页「插件 → 管理」标签，dsh-plugin-manager 插件消费）：
  //   list —— 收集配套/用户/核心插件：id、包名、描述、启用状态
  //   set  —— 写入/移除 profile cordis.patch.yml 的用户层 disabled 条目
  //           （纯文本手术；完全退出并重启应用后生效）
  ipcMain.handle('dsh:plugin-list', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return [];
    return pluginManagerCollect();
  });

  ipcMain.handle('dsh:plugin-set-enabled', async (event, { id, enabled } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const row = pluginManagerCollect().find((r) => r.id === id);
    if (!row) return { ok: false, error: '未知插件: ' + String(id) };
    if (!row.toggleable) return { ok: false, error: '该插件不可关闭: ' + String(id) };
    try {
      const res = pluginManagerSetEnabled(id, !!enabled);
      if (!res.ok) return res;
      log('plugin-manager', '已' + (enabled ? '启用' : '关闭') + '插件 ' + id);
      return { ok: true, restartRequired: true };
    } catch (err) {
      log('plugin-manager', '设置插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 内置插件移除/恢复（V4.2）：移除 = 卸载语义（清 patch 行 + 删包副本 +
  // 记入 settings.removedPlugins 跳过下次 sync）；恢复 = 清跳过清单 + 立即
  // 复制包与行。两者都需重启 Web 服务生效。
  ipcMain.handle('dsh:plugin-set-removed', async (event, { id, removed } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const res = pluginManagerSetRemoved(String(id), !!removed);
      return res.ok ? { ok: true, restartRequired: true } : res;
    } catch (err) {
      log('plugin-manager', '移除/恢复插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 插件更新（V4.3，设置页「插件 → 更新」标签，dsh-plugin-marketplace 插件
  // 消费）：内置插件上游更新 —— 检测清单 / 手动更新单个 / 自动更新开关。
  // 数据与动作都在主进程完成（npm 镜像链 + 覆盖层），Web 端只做展示。
  ipcMain.handle('dsh:plugin-updates', async (event, { force = false } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    try {
      const ctx = updCtx();
      const list = await pluginUpdater.checkPluginUpdates(ctx, pluginUpdateSources(), {
        force: !!force,
        profileDirP: desktopProfileDir(),
      });
      return {
        list,
        autoUpdate: pluginUpdater.isAutoUpdateEnabled(ctx),
        checkedAt: updater.loadSettings(ctx).pluginUpdateCheckedAt || null,
      };
    } catch (err) {
      log('plugin-update', '插件更新清单加载失败: ' + String((err && err.message) || err));
      return { list: [], autoUpdate: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:plugin-update', async (event, { id } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const source = pluginUpdateSources().find((s) => s.id === String(id));
    if (!source) return { ok: false, error: '未知或不可更新的内置插件: ' + String(id) };
    try {
      const res = await pluginUpdater.applyBuiltinPluginUpdate(updCtx(), source, {
        profileDirP: desktopProfileDir(),
        guard: ensureGuard(),
        copyIntoProfile: (overlayDir, name) => copyPluginPackage(desktopProfileDir(), overlayDir, name),
      });
      if (!res.ok) return res;
      if (res.noop) return { ok: true, noop: true, current: res.current, latest: res.latest };
      log('plugin-update', '手动更新内置插件 ' + id + ' → ' + res.latest + (res.restartRequired ? '（重启服务生效）' : ''));
      return { ok: true, version: res.latest, restartRequired: res.restartRequired };
    } catch (err) {
      log('plugin-update', '更新插件 ' + id + ' 失败: ' + String((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:plugin-auto-update', async (event, { enabled } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      s.pluginAutoUpdate = !!enabled;
      updater.saveSettings(ctx, s);
      log('plugin-update', '内置插件自动更新已' + (enabled ? '开启' : '关闭'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 图片粘贴（V4.2，dsh-image-paste 插件）：把剪贴板图片存到临时目录供
  // agent 的 inspect_image 读取。只接受 image/* 的 data URL，限 15MB，
  // 文件名清洗（防路径穿越），写入路径固定为 %TEMP%/dsh-paste/。
  ipcMain.handle('dsh:image-paste-save', async (event, { dataUrl, name } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const res = imagePasteSave(String(dataUrl || ''), String(name || '粘贴图片'));
      if (!res.ok) return res;
      log('plugin-manager', '已保存粘贴图片: ' + res.path);
      return res;
    } catch (err) {
      log('plugin-manager', '保存粘贴图片失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 内置插件选择向导（assets/onboarding.html，onboarding-preload.js 桥）：
  //   list   —— 目录（核心/推荐标记 + 描述 + 体积）+ 模式 + 当前启停状态
  //   submit —— 校验选择 → 写 disabled/裸条目 → 持久化 settings → 关窗；
  //             rerun 模式随后重启 Web 服务使 host 侧插件生效
  //   close  —— 用户点「跳过」/关闭窗口（走 closed 事件的 cancelled 分支）
  // 来源校验：只接受向导窗口自身的 webContents。
  ipcMain.handle('onboard:list', async (event) => {
    if (!wizardWindow || event.sender !== wizardWindow.webContents) return null;
    return {
      mode: wizardMode,
      catalog: buildOnboardingCatalog(),
      current: wizardMode === 'rerun' ? pluginCurrentState() : null,
    };
  });

  ipcMain.handle('onboard:submit', async (event, { ids } = {}) => {
    if (!wizardWindow || event.sender !== wizardWindow.webContents) return { ok: false, error: 'unauthorized' };
    // 首次向导时 sync 尚未运行、profile 目录可能还不存在：先按官方模板初始化
    // （package.json / pnpm-workspace.yaml / 空 patch 层），否则写盘 ENOENT。
    ensureDesktopProfileInit();
    const want = onboardingLogic.sanitizeSelection(ids, COMPANION_PLUGINS, onboardingLogic.CORE_PLUGIN_IDS);
    // 首次：patch 行尚未写全，normalize 全部非核心插件（current=null）；
    // 二次：只切换与用户选择不同的插件。
    const current = wizardMode === 'rerun' ? pluginCurrentState() : null;
    const ops = onboardingLogic.buildSelectionOps(COMPANION_PLUGINS, onboardingLogic.CORE_PLUGIN_IDS, want, current);
    const errors = [];
    for (const op of ops) {
      try {
        const res = pluginManagerSetEnabled(op.id, op.enable);
        if (!res.ok) errors.push(op.id + ': ' + (res.error || 'unknown'));
        else log('plugin-manager', '向导已' + (op.enable ? '启用' : '停用') + '内置插件 ' + op.id);
      } catch (err) {
        errors.push(op.id + ': ' + ((err && err.message) || err));
      }
    }
    const s = updater.loadSettings(updCtx());
    s.pluginOnboardingDone = true;
    s.builtinPluginSelection = Array.from(want);
    updater.saveSettings(updCtx(), s);
    log('boot', '插件选择向导已应用：' + ops.length + ' 个插件状态变更' + (errors.length ? '，失败 ' + errors.join('; ') : ''));
    const mode = wizardMode;
    closeWizard({ ok: true, applied: ops.length, errors });
    if (mode === 'rerun' && serverProc && serverProc.exitCode === null) {
      // 二次向导：重启 Web 服务让 host 侧插件生效（与插件市场安装后同路径）。
      restartWebServiceCore();
    }
    return { ok: true, applied: ops.length, errors };
  });

  ipcMain.on('onboard:close', (event) => {
    if (!wizardWindow || event.sender !== wizardWindow.webContents) return;
    closeWizard({ ok: false, cancelled: true });
  });

  // 设置页「插件 → 选择向导」（dsh-plugin-wizard 插件）二次打开入口。
  ipcMain.handle('onboard:open', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    if (wizardWindow && !wizardWindow.isDestroyed()) {
      wizardWindow.focus();
      return { ok: true, reused: true };
    }
    openPluginWizard({ mode: 'rerun' });
    return { ok: true };
  });

  // 会话浮窗（V4 多窗口）：主窗请求把某个会话弹出到独立窗口（校验来源与
  // 数量上限）；浮窗自己只允许关闭自身。
  ipcMain.handle('chrome:float-window', (event, { action, sessionId } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    if (action !== 'open') return { ok: false, error: 'bad-action' };
    if (!webUrl) return { ok: false, error: 'not-ready' };
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'bad-session' };
    // 同一会话只保留一个浮窗：拖出/按钮连续触发或重复请求时，
    // 复用已有窗口而不是再开第二个。
    const existing = floatBySession.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true, id: existing.id, reused: true };
    }
    if (existing) floatBySession.delete(sessionId);
    if (floatWindows.size >= FLOAT_MAX) return { ok: false, error: 'too-many' };
    const win = createFloatWindow(sessionId);
    if (!win) return { ok: false, error: 'too-many' };
    return { ok: true, id: win.id };
  });

  // 浮窗关闭：仅允许浮窗关闭自身（校验发送者属于某个浮窗）。
  ipcMain.on('float:close', (event) => {
    for (const win of floatWindows) {
      if (!win.isDestroyed() && win.webContents === event.sender) { win.close(); break; }
    }
  });

  // 复制文本到剪贴板（菜单「更新源」复制按钮 / 关于对话框）。
  ipcMain.handle('dsh:copy-text', (event, { text } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false };
    if (typeof text !== 'string' || !text || text.length > 2048) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  // preload 转发的页面异常（window.onerror / unhandledrejection）。
  ipcMain.on('dsh:page-error', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    log('page-error', String(payload));
  });

  ipcMain.handle('dsh:balance-refresh', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return balanceCache;
    return refreshBalance();
  });

  // Token 价格自定义（V4.2，dsh-balance 插件「价格设置」页）：读写
  // settings.json 的 balancePrices.<model>.{peak,offpeak}（¥/百万 token，
  // 三字段 cacheMiss/cacheHit/output，必须为 >= 0 的数字）。保存后立即
  // 重推余额数据，dock 的费用估算即时生效。
  ipcMain.handle('dsh:balance-prices-get', async (event, { model } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const s = updater.loadSettings(updCtx());
    const defaults = balance.DEFAULT_PRICES[String(model || '')] || balance.FALLBACK_PRICES;
    const current = (s.balancePrices && s.balancePrices[String(model || '')]) || null;
    return { ok: true, model: String(model || ''), defaults, current };
  });

  ipcMain.handle('dsh:balance-prices-set', async (event, { model, prices } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const m = String(model || '');
    if (!balance.DEFAULT_PRICES[m]) return { ok: false, error: '未知模型: ' + m };
    try {
      const cleaned = balance.sanitizePrices(prices);
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      if (!s.balancePrices || typeof s.balancePrices !== 'object') s.balancePrices = {};
      s.balancePrices[m] = cleaned;
      updater.saveSettings(ctx, s);
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:balance-prices-reset', async (event, { model } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const m = String(model || '');
    try {
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      if (s.balancePrices && s.balancePrices[m]) {
        delete s.balancePrices[m];
        updater.saveSettings(ctx, s);
      }
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 文件还原（「文件」视图的回退）：按会话日志里已持久化的写前/写后全文，
  // 做精确内容匹配后替换 —— 只有内容一致才动手，天然幂等且安全。
  ipcMain.handle('dsh:file-revert', async (event, { changes } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { results: [] };
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) return { results: [] };
    const results = [];
    for (const c of changes) {
      const p = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(p) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: p, status: 'invalid' });
        continue;
      }
      if (!isUnderFileRoots(p)) {
        results.push({ path: p, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(p);
        const content = exists ? fs.readFileSync(p, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          // 新建 → 删除（内容必须仍是 agent 写入的原文）
          if (content !== null && content === newText) { fs.rmSync(p); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
        } else if (newText === '' && oldText !== '') {
          // 删除 → 恢复（文件必须仍不存在）
          if (content === null) { fs.writeFileSync(p, oldText, 'utf8'); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: 'conflict' });
        } else {
          if (content !== null && content.includes(newText)) {
            fs.writeFileSync(p, content.replace(newText, oldText), 'utf8');
            results.push({ path: p, status: 'reverted' });
          } else if (content !== null && content === oldText) {
            results.push({ path: p, status: 'skipped' });
          } else {
            results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (err) {
        results.push({ path: p, status: 'failed', error: String((err && err.message) || err) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  });

  // 「全部文件」视图的打开请求：用系统默认程序打开项目文件。
  ipcMain.handle('dsh:file-open', async (event, { path: p } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'forbidden' };
    if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'path must be absolute' };
    // Skills 根目录（~/.dsh/skills、~/.agents/skills）不在会话工作区内，但
    // 「设置 → Skills 与 MCP → 打开目录」需要放行；严格限定为两个根本身及其
    // 子路径（白名单，非任意路径），危险扩展名检查仍生效。
    const skillsRoots = [
      path.join(dshHome || path.join(os.homedir(), '.dsh'), 'skills'),
      path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'),
    ];
    const underSkillsRoot = skillsRoots.some((r) => {
      const rp = path.resolve(r);
      return p === rp || p.startsWith(rp + path.sep);
    });
    if (!underSkillsRoot && !isUnderFileRoots(p)) return { ok: false, error: 'path outside session workspace' };
    if (DANGEROUS_EXT.test(p)) return { ok: false, error: 'executable files are not openable from the file view' };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: 'file not found' };
      const msg = await shell.openPath(p);
      if (msg) return { ok: false, error: msg };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 预览面板：用系统浏览器打开 http(s) URL。
  ipcMain.handle('dsh:open-external', async (event, { url } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'forbidden' };
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
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
  } catch {}
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
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
          const s = updater.loadSettings(updCtx());
          s.notifyOnTurnEnd = item.checked;
          updater.saveSettings(updCtx(), s);
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
  const home = dshHome || path.join(os.homedir(), '.dsh');
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
  const s = updater.loadSettings(updCtx());
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
  // 外观皮肤（dsh-skin, wei-806206088, MIT）：调色盘按钮 + 主题/主色/文字色/图片/GIF/视频背景 + 预设。纯客户端。
  { id: 'dsh-skin', name: 'dsh-skin', dir: 'dsh-skin' },
  { id: 'easy-setup', name: '@deepseek-ai/dsh-easy-setup' },
  // 社区功能插件（视觉 / 人设 / 长期记忆 / 移动端布局修复）：npm registry
  // 拉取后随应用内置分发。绝不能写进 profile package.json 依赖 ——
  // pnpm 安装会 hoist @deepseek-ai 核心包形成模块双实例（Symbol 冲突，
  // 插件命名空间注册失效，即 "设置命名空间不可用" 故障的根因）。
  { id: 'tool-vision', name: 'dsh-tool-vision', dir: 'dsh-tool-vision' },
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
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
  // 插件选择向导入口（设置页「插件 → 选择向导」分区）：重新打开首次启动的
  // 内置插件选择向导，按需启用/停用内置插件。纯客户端 UI + 壳层 IPC
  // （onboard:*），host 半边 no-op；核心插件组内锁定，永不被向导停用。
  { id: 'plugin-wizard', name: 'dsh-plugin-wizard', dir: 'dsh-plugin-wizard' },
  // 微信 ClawBot / OpenClaw 桥（openclaw-dsh-bridge v0.7.0，MIT）：设置页
  // 「ClawBot」栏（扫码绑定微信官方 ClawBot 小程序）+ OpenAI 兼容端点
  // （/openclaw-bridge/v1/chat/completions）。设置命名空间经 dsh-host-apiproxy
  // 的 settings.describe 全量暴露（rc.7+ 已移除 WEB_SETTINGS_NAMESPACES 白名单）。
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
  'dsh-skin': { github: 'wei-806206088/dsh-skin' },
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
    const home = dshHome || path.join(os.homedir(), '.dsh');
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
    const home = dshHome || path.join(os.homedir(), '.dsh');
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
  try { fs.writeFileSync(marker, JSON.stringify({ ...job, attempts }, null, 2)); } catch {}
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
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
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
// 本就是 dsh-skill-filesystem 的默认扫描根（rank 400），这里只需把内置
// 技能同步过去 —— 内核零配置。同步规则：带 .eac-skill.json 标记的目录由
// EAC 管理（版本变化时覆盖更新）；用户自建同名目录（无标记）永不覆盖。
const BUNDLED_SKILLS_DIR = path.join(__dirname, 'assets', 'skills');

function syncBundledSkills() {
  try {
    const src = BUNDLED_SKILLS_DIR;
    if (!fs.existsSync(src)) return;
    const destRoot = path.join(dshHome || path.join(os.homedir(), '.dsh'), 'skills');
    fs.mkdirSync(destRoot, { recursive: true });
    const installed = [];
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillSrc = path.join(src, entry.name);
      if (!fs.existsSync(path.join(skillSrc, 'SKILL.md'))) continue;
      const skillDst = path.join(destRoot, entry.name);
      const markerSrc = readJsonFile(path.join(skillSrc, '.eac-skill.json')) || { version: 1, managed: true };
      const markerDst = readJsonFile(path.join(skillDst, '.eac-skill.json'));
      if (markerDst && markerDst.version === markerSrc.version) continue;
      if (!markerDst && fs.existsSync(skillDst)) continue; // 用户自建同名技能：不动
      fs.cpSync(skillSrc, skillDst, { recursive: true });
      installed.push(entry.name);
    }
    if (installed.length) log('boot', '已同步内置 skills 到 ' + destRoot + ': ' + installed.join(', '));
  } catch (err) {
    log('boot', '同步内置 skills 失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// V4 运行时补丁（移植自上游 dsh_desktop，幂等）：覆盖三处运行副本 ——
// profile 共享 junction 根、内置 app 副本（__dirname/node_modules）、用户
// 更新过的 agent overlay（<userData>/agent/node_modules）。agent 更新会换掉
// overlay 整树，补丁随 syncCompanionPlugins 每次启动重放。
// ---------------------------------------------------------------------------

function runtimePatchRoots() {
  const home = dshHome || path.join(os.homedir(), '.dsh');
  return [
    path.join(home, 'profiles', 'node_modules'),
    path.join(__dirname, 'node_modules'),
    path.join(userDataDir, 'agent', 'node_modules'),
  ];
}

// 对话删除 / 归档管理（dsh-session-manager 插件的前置依赖）：
// dsh-workspace + dsh-host-apiproxy + dsh-session + dsh-client-connection +
// dsh-client-ui-workspace 的外科手术式扩展（详见 scripts/patch-session-manage.js
// 头注释）。锚点不匹配（官方包结构变化）时自动跳过，绝不损坏文件。
function applySessionManageFix() {
  for (const root of runtimePatchRoots()) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      const n = patchSessionManage(root, (m) => log('boot', m));
      if (n > 0) log('boot', '对话删除补丁: 已应用到 ' + root);
    } catch (err) {
      log('boot', '对话删除补丁失败(' + root + '): ' + err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 插件启停管理（V4，移植自上游）：设置页「插件 → 管理」标签的数据与写盘。
// dsh:plugin-list / dsh:plugin-set-enabled 两个 IPC 驱动；写盘用纯文本手术
// （scripts/plugin-manager-patch.js），保留文件其它内容与注释。
// ---------------------------------------------------------------------------

// 惰性加载 js-yaml（内置 dsh 的传递依赖）；缺失时管理页降级为空列表。
let dshYamlDialect = null;
let dshYamlTried = false;
function loadDshYamlDialect() {
  if (dshYamlTried) return dshYamlDialect;
  dshYamlTried = true;
  try {
    const yaml = require('js-yaml');
    // 与 dsh 相同的 entry-list 方言：`!!js` 表达式是合法标量。
    const jsType = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data) => typeof data === 'string',
      construct: (data) => ({ __jsExpr: data }),
    });
    dshYamlDialect = { load: (content) => yaml.load(content, { schema: yaml.JSON_SCHEMA.extend(jsType) }) };
  } catch {
    dshYamlDialect = null;
  }
  return dshYamlDialect;
}

function pluginManagerReadPatch() {
  const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const yaml = loadDshYamlDialect();
  if (!yaml) return { file, text, entries: [] };
  try {
    const parsed = yaml.load(text);
    return { file, text, entries: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { file, text, entries: [] };
  }
}

function pluginManagerPackageDescription(name) {
  if (!name) return '';
  const candidates = [
    path.join(desktopProfileDir(), 'node_modules', ...name.split('/')),
    path.join(__dirname, 'assets', 'plugins', name.includes('/') ? name.slice(name.indexOf('/') + 1) : name),
  ];
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && typeof pkg.description === 'string' && pkg.description) return pkg.description;
    } catch {}
  }
  return '';
}

function pluginManagerCollect() {
  const { entries } = pluginManagerReadPatch();
  let bundles = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(desktopProfileDir(), 'package.json'), 'utf8'));
    bundles = (m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles)) ? m.dsh.profile.bundles : [];
  } catch {}
  return collectPluginRows(entries, {
    companion: COMPANION_PLUGINS.map((p) => ({ id: p.id, name: p.name })),
    coreIds: onboardingLogic.CORE_PLUGIN_IDS,
    removedIds: removedPluginIds(),
    describe: (name) => pluginManagerPackageDescription(name),
    bundles,
  });
}

function pluginManagerResolveName(id) {
  const c = COMPANION_PLUGINS.find((p) => p.id === id);
  if (c) return c.name;
  const { entries } = pluginManagerReadPatch();
  for (const entry of entries) {
    if (entry && Array.isArray(entry.insert)) {
      const it = entry.insert.find((x) => x && x.id === id);
      if (it && it.name) return it.name;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// 内置插件「移除」（V4.2）：把插件的 id 记入 settings.removedPlugins 跳过
// syncCompanionPlugins，同时清掉 profile 里的 patch 行与 node_modules 副本。
// 区别于「禁用」（停用但保留，随时可开）——移除是卸载语义，重启不还原；
// 市场里重复安装同名内置包也不被拒绝（内置清单已不含它）。
// ---------------------------------------------------------------------------

function removedPluginIds() {
  try {
    const s = updater.loadSettings(updCtx());
    return new Set(Array.isArray(s.removedPlugins) ? s.removedPlugins : []);
  } catch { return new Set(); }
}

function saveRemovedPluginIds(ids) {
  const ctx = updCtx();
  const s = updater.loadSettings(ctx);
  s.removedPlugins = Array.from(ids);
  updater.saveSettings(ctx, s);
}

// 恢复单个配套插件：立即复制包 + 补写 patch 行（与 syncCompanionPlugins
// 的写入规则一致），重启服务后生效。源目录走「覆盖层优先」（V4.3）：
// 被恢复的内置插件若是已更新版本，恢复回来的就是更新版。
function restoreCompanionPlugin(p) {
  const profileDirP = desktopProfileDir();
  const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
  const src = builtinPluginSourceDir(dirName);
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    return { ok: false, error: '配套插件源目录无效: ' + src };
  }
  copyPluginPackage(profileDirP, src, p.name);
  const patchFile = path.join(profileDirP, 'cordis.patch.yml');
  let patch = '';
  try { patch = fs.readFileSync(patchFile, 'utf8'); } catch {}
  if (!hasEntryId(patch, p.id)) {
    let bundled = [];
    try { bundled = readJsonFile(path.join(profileDirP, 'package.json'))?.dsh?.profile?.bundles || []; } catch { bundled = []; }
    if (!bundled.includes(p.name)) {
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config);
      if (p.disabled) block += `      disabled: true\n`;
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      try { fs.writeFileSync(patchFile, patch); } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
  }
  return { ok: true };
}

// removed=true 移除（卸载语义）；removed=false 恢复。核心插件拒绝移除。
function pluginManagerSetRemoved(id, removed) {
  const p = COMPANION_PLUGINS.find((x) => x.id === id);
  if (!p) return { ok: false, error: '未知内置插件: ' + String(id) };
  if (onboardingLogic.CORE_PLUGIN_IDS.has(id)) {
    return { ok: false, error: '核心插件不可移除: ' + String(id) };
  }
  const removedSet = removedPluginIds();
  const patchFile = path.join(desktopProfileDir(), 'cordis.patch.yml');
  try {
    if (removed) {
      // 1) 清 patch 行（顶层 + insert 内层）
      let text = '';
      try { text = fs.readFileSync(patchFile, 'utf8'); } catch {}
      const patched = removePluginFromPatch(text, id);
      if (patched !== text) fs.writeFileSync(patchFile, patched, 'utf8');
      // 2) 删 profile node_modules 里的包副本（copyPluginPackage 的产物）
      const pkgDir = path.join(desktopProfileDir(), 'node_modules', p.name);
      fs.rmSync(pkgDir, { recursive: true, force: true });
      // 3) 记入跳过清单（下次 sync 不再写回）
      removedSet.add(id);
      saveRemovedPluginIds(removedSet);
      log('plugin-manager', '已移除内置插件 ' + id);
      return { ok: true, restartRequired: true };
    }
    // 恢复：清出跳过清单 + 立即复制包与行
    removedSet.delete(id);
    saveRemovedPluginIds(removedSet);
    const res = restoreCompanionPlugin(p);
    if (!res.ok) return res;
    log('plugin-manager', '已恢复内置插件 ' + id);
    return { ok: true, restartRequired: true };
  } catch (err) {
    log('plugin-manager', '移除/恢复插件 ' + id + ' 失败: ' + ((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// 图片粘贴保存（dsh-image-paste 插件）：只接受 image/* 的 data URL，
// base64 解码后原子写入 %TEMP%/dsh-paste/<清洗名>-<时间戳><ext>，返回
// { ok, path, size }。文件在临时目录，随系统清理，不污染工作区。
const IMAGE_PASTE_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_PASTE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/ico': '.ico',
  'image/x-icon': '.ico',
  'image/tiff': '.tiff',
};

function imagePasteSave(dataUrl, name) {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return { ok: false, error: '不是合法的图片 data URL' };
  const mime = m[1].toLowerCase();
  if (!IMAGE_PASTE_EXT[mime]) return { ok: false, error: '不支持的图片类型: ' + mime };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return { ok: false, error: '图片内容为空' };
  if (buf.length > IMAGE_PASTE_MAX_BYTES) return { ok: false, error: '图片超过 15MB 上限' };
  const dir = path.join(os.tmpdir(), 'dsh-paste');
  fs.mkdirSync(dir, { recursive: true });
  const base = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40) || '粘贴图片';
  const file = path.join(dir, base + '-' + Date.now() + IMAGE_PASTE_EXT[mime]);
  fs.writeFileSync(file, buf);
  return { ok: true, path: file, size: buf.length };
}

// 写入/移除用户层 disabled 条目（纯文本手术见 scripts/plugin-manager-patch.js）：
// 与上游的差异 —— 「启用」保留顶层裸条目 {id, name} 而不是整条移除，这样
// 默认禁用的配套插件（dsh-pet）被用户启用后不会被下次 sync 重新插回
// disabled 行（sync 的「已有行不重写」规则自然接管）。
function pluginManagerSetEnabled(id, enabled) {
  const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  if (!text.trim()) text = '# dsh web profile patch（由 Deepseek Harness EAC 维护）\n';

  const name = pluginManagerResolveName(id);
  if (!enabled && !name) return { ok: false, error: '无法解析插件包名: ' + id };

  let patched;
  try {
    patched = togglePluginInPatch(text, id, !!enabled, name);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  if (patched !== text) {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, patched, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
  return { ok: true };
}

function syncCompanionPlugins() {
  if (!IS_WIN) return;
  try {
    const home = dshHome || path.join(os.homedir(), '.dsh');
    // 桌面专属 profile 必须先存在（未知 profile 不会被 dsh 自动初始化）。
    ensureDesktopProfileInit();
    // V4 运行时补丁（幂等，随启动 / 服务重启 / agent 更新后重放）：
    //  · 对话删除/归档 —— dsh-session-manager 插件的全链路前置依赖；
    applySessionManageFix();
    const profileDirP = desktopProfileDir();
    // 内置社区 agent preset（anchored-standard：首请求锚定 Minimal 工具对，
    // 首次工具调用/回复后开放完整 Standard 目录）：安装到用户 preset 根。
    // preset 不进插件树，坏 preset 不会拖垮启动；已存在则跳过（用户手装
    // 或改过的版本优先），见 preset-sync.js。
    const presetsSynced = syncBundledPresets(
      path.join(__dirname, 'assets', 'agent-presets'),
      path.join(home, '.agent-presets'),
      (m) => log('boot', m)
    );
    if (presetsSynced.installed.length) log('boot', '已安装内置 agent preset: ' + presetsSynced.installed.join(', '));
    // 默认 preset 指到内置的 anchored-standard（用户已在 settings.yaml 写过
    // default 则一律保留）。失败只降级为官方默认 preset，不影响启动。
    const defaultResult = ensureDefaultAgentPreset(home, 'anchored-standard', (m) => log('boot', m));
    if (defaultResult === 'set') log('boot', '已设置默认 agent preset: anchored-standard');
    else if (defaultResult === 'kept') log('boot', '用户已设置默认 agent preset，保持不变');
    fs.mkdirSync(path.join(profileDirP, 'node_modules'), { recursive: true });
    const pending = [];
    const removedIds = removedPluginIds();
    // V4.2：用户曾从市场安装过与内置插件同名的包时，写包前先迁移残留
    // （package.json 依赖/bundles + patch 行），让内置版干净接管，避免
    // duplicate loader entry；完成后系统通知告知「插件树变化」。
    const migratedBuiltins = [];
    for (const p of COMPANION_PLUGINS) {
      // V4.2：用户移除过的内置插件不再复制/登记（见 pluginManagerSetRemoved）。
      if (removedIds.has(p.id)) {
        log('boot', `已按用户选择跳过被移除的内置插件: ${p.id}`);
        continue;
      }
      // 非 @deepseek-ai 作用域的配套包用显式 dir 指定 assets/plugins 下的目录名；
      // 回退解析按「最后一个路径段」取（@scope/name → name；无 scope → 原名）。
      // V4 修复：旧回退是 name.slice('@deepseek-ai/'.length) —— 对无 scope 的
      // 长包名会截出错误目录（dsh-session-manager → 'manager'），该插件被
      // 静默跳过（行与包都不落盘）。
      const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
      // V4.3：覆盖层优先 —— 用户更新过的内置插件从 <userData>/builtin-plugin-updates
      // 拷贝（不被资产版本还原）；应用升级后资产版本更新则自动接管。
      const src = builtinPluginSourceDir(dirName);
      if (!fs.existsSync(path.join(src, 'package.json'))) {
        log('boot', `配套插件源目录无效，跳过: ${p.id} → ${src}`);
        continue;
      }
      try {
        const { removeMarketDuplicate, patchHasForeignRows } = require('./builtin-collision');
        // 市场同名包残留预检（v4.2，用户反馈问题 5）：只有「非应用自写」证据
        // （package.json 依赖/bundles 或非自写 patch 行）才算残留。
        const dupPreCheck = (() => {
          try {
            const pkg = readJsonFile(path.join(profileDirP, 'package.json'));
            const spec = pkg && pkg.dependencies && pkg.dependencies[p.name];
            if (spec && !String(spec).startsWith('link:') && !String(spec).startsWith('file:')) return true;
            if (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) && pkg.dsh.profile.bundles.includes(p.name)) return true;
            const patchText = fs.readFileSync(path.join(profileDirP, 'cordis.patch.yml'), 'utf8');
            // 只认「非应用自写」的登记行：sync 的 insert 内层行、插件管理/向导
            // togglePluginInPatch 写的（带「关闭」标记注释的）顶层行都是应用自己
            // 的启停状态，不是市场残留。否则 v4.4 首次向导的取消勾选会在同一启动
            // 里被剥离后按注册表默认回写（dsh-dafeiyu 等默认启用插件被静默重新
            // 启用），且每次启动产生「剥离-回写」空转与孤儿 `- insert:` 行堆积。
            return patchHasForeignRows(patchText, p.name);
          } catch { return false; }
        })();
        if (dupPreCheck) {
          // 先快照（保护中心）：迁移属于配置面手术，出问题可一键回滚。
          ensureGuard().snapshot('builtin-migrate:' + p.id);
          // 只在确有市场残留证据时才动手术。v4.2 曾无条件执行迁移 —— 它的
          // 「剥离-回写」对无重复用户是空转，且会把应用自写的行（向导/插件
          // 管理的 disabled 行、sync 自己的 insert 行）一并剥掉后按注册表
          // 默认回写：v4.4 首次向导的取消勾选被静默重新启用，孤儿 insert
          // 行每次启动堆积。
          const migrated = removeMarketDuplicate(profileDirP, p.name, { log: (m) => log('boot', m) });
          if (migrated.changed && migrated.ok) {
            migratedBuiltins.push({ name: p.name, dep: migrated.removedDep.length > 0, rows: migrated.removedRows });
            log('boot', `内置插件 ${p.name} 已接管市场同名包（移除依赖 ${migrated.removedDep.length} 个、patch 行 ${migrated.removedRows.length} 个）`);
          }
        }
      } catch (err) {
        log('boot', `内置插件同名迁移失败(${p.id}): ${String((err && err.message) || err)}`);
      }
      copyPluginPackage(profileDirP, src, p.name);
      // p.disabled: true 的配套插件默认以禁用行注册（如 dsh-pet 页面桌宠），
      // 用户可在「设置 → 插件 → 管理」里启用；已有行不重写，用户选择优先。
      pending.push({ id: p.id, name: p.name, disabled: p.disabled === true, config: p.config });
    }
    if (migratedBuiltins.length) {
      try {
        const names = migratedBuiltins.map((m) => m.name).join('、');
        const n = new Notification({
          title: '内置插件已接管同名市场包',
          body: `检测到市场安装的重复包，已改用内置版本（${names}）。插件树已自动整理，本次启动生效。`,
          icon: path.join(__dirname, 'assets', 'icon.png'),
        });
        n.on('click', () => showMainWindow());
        n.show();
      } catch (err) {
        log('boot', '内置接管通知发送失败: ' + err.message);
      }
    }
    // 内置皮肤：行 id 取皮肤包 skin.json 的 wiring.id（ui-skin-*）。
    for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(SKINS_DIR, entry.name);
      const pkg = readJsonFile(path.join(src, 'package.json'));
      if (!pkg || typeof pkg.name !== 'string' || !pkg.name.includes('/')) continue;
      const skin = readJsonFile(path.join(src, 'skin.json'));
      const rowId = skin && skin.wiring && typeof skin.wiring.id === 'string' ? skin.wiring.id : '';
      if (!/^ui-skin-[\w-]+$/.test(rowId)) continue;
      copyPluginPackage(profileDirP, src, pkg.name);
      pending.push({ id: rowId, name: pkg.name, disabled: true });
    }
    // 内置插件清单标记：插件市场据此把目录里的同名插件标为「已内置」并
    // 拒绝重复安装 —— 内置包每次启动都被重新同步，市场覆盖安装会产生
    // duplicate loader entry / 模块双实例，必须从源头拦截。
    try {
      const builtinNames = pending.map((p) => p.name);
      const marker = path.join(profileDirP, '.dsh-builtin-plugins.json');
      const prev = readJsonFile(marker);
      const next = { names: builtinNames, updatedAt: new Date().toISOString() };
      if (!prev || JSON.stringify(prev.names) !== JSON.stringify(next.names)) {
        fs.writeFileSync(marker, JSON.stringify(next, null, 2) + '\n');
      }
    } catch (err) {
      log('boot', '写入内置插件清单失败: ' + err.message);
    }
    // 注册到 profile 的 patch 层（幂等：已有行不重写，用户选择的皮肤/disabled 状态保留）。
    const patchFile = path.join(profileDirP, 'cordis.patch.yml');
    let patch = '';
    try { patch = fs.readFileSync(patchFile, 'utf8'); } catch { patch = ''; }
    let changed = false;
    // 先修存量坏行：v2.0.0 写入的 soul-md 行缺 config.path（见 patch-row-heal.js
    // 头注释），不修则升级用户仍会 “dsh web 启动失败 (退出码 1)”。
    const healed = healSoulMdPatchRow(patch);
    if (healed.healed.length) {
      patch = healed.patch;
      changed = true;
      log('boot', '已修复 profile patch 中缺 config.path 的 soul-md 行');
    }
    // V4：修复 v3.1.0 及以前写出的「无 config 的 dsh-pet 行」（loader 传
    // undefined → dsh-pet 读 config.fullRoot 崩 → 插件树整体加载失败）。
    const healedPet = healRowConfig(patch, 'dsh-pet', { size: 260, position: 'bottom-right' });
    if (healedPet.healed.length) {
      patch = healedPet.patch;
      changed = true;
      log('boot', '已修复 profile patch 中缺 config 的 dsh-pet 行（v3 存量坏行）');
    }
    // 市场安装（dsh plugin add）会把插件登记进 package.json 的
    // dsh.profile.bundles，加载时执行其包内 patch 挂载行；若 overlay 里
    // 也有一行（syncCompanionPlugins 写的），整个插件树会以
    // “duplicate loader entry id” 崩溃。清掉 overlay 重复行（包内行保留）。
    let bundled = [];
    try { bundled = readJsonFile(path.join(profileDirP, 'package.json'))?.dsh?.profile?.bundles || []; } catch { bundled = []; }
    // 同一 entry id 被两处声明（bundle 的包内 patch + overlay 的配套行）会以
    // “duplicate loader entry id” 拖垮整个插件树。旧逻辑只按「包名 ∈ bundles」
    // 匹配，git/fork/link 安装的插件包名与配套行包名不符时永远删不掉（issue
    // #16）。这里再解析每个 bundle 包实际声明的 entry id 集合：overlay 中 id
    // 已被任一 bundle 声明（无论包名如何）即视为重复。
    const declaredBundleIds = collectBundleEntryIds(bundled, path.join(profileDirP, 'node_modules'));
    const rowIds = {};
    for (const p of COMPANION_PLUGINS) rowIds[p.id] = p.name;
    const deduped = removeBundledRowDuplicates(patch, rowIds, bundled, declaredBundleIds);
    if (deduped.removed.length) {
      patch = deduped.patch;
      changed = true;
      log('boot', '已移除与 bundle 登记重复的 patch 行: ' + deduped.removed.join(', '));
    }
    for (const p of pending) {
      if (hasEntryId(patch, p.id)) continue;
      // 已在 bundle 列表里的插件由其包内 patch 挂载，overlay 不能再写行
      // （会 duplicate loader entry id，拖垮整个插件树）。issue #16：
      // 补充按 entry id 判断 —— git/fork 插件包名不同但 id 相同同样要跳过，
      // 否则每次启动把崩溃行写回，用户删掉也没用。
      if (bundled.includes(p.name) || declaredBundleIds.has(p.id)) continue;
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config);
      if (p.disabled) block += `      disabled: true\n`;
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      changed = true;
    }
    if (changed) {
      // 顺带清理历史遗留的孤儿 `- insert:` 行（v4.2/4.3 每次启动「剥离-回写」
      // 残留的空块；对 cordis 无效果，仅文件卫生）。强制一次写盘，之后幂等。
      const lines = patch.split(/\r?\n/);
      const cleaned = lines.filter((line, idx) => {
        if (!/^[ \t]*- insert:\s*$/.test(line)) return true;
        let k = idx + 1;
        while (k < lines.length && lines[k].trim() === '') k += 1;
        return k < lines.length && /^[ \t]+- /.test(lines[k]);
      }).join('\n');
      if (cleaned !== patch) {
        patch = cleaned;
        log('boot', '已清理 profile patch 中的孤儿 - insert: 行');
      }
      fs.writeFileSync(patchFile, patch);
      log('boot', '已同步配套插件/皮肤到 web profile: ' + pending.map((p) => p.id).join(', '));
    }
    // 迁移带来的皮肤选择（migrateFromSharedWebProfile 记录）在此落位。
    applyLegacySkinChoice();
  } catch (err) {
    log('boot', '同步配套插件失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 快捷方式维护：修复「没有桌面快捷方式 / 快捷方式指向的文件消失」，
// 并让快捷方式图标跟随图标设计更新（.lnk 单独指定 icon.ico）。
// ---------------------------------------------------------------------------

// 图标设计版本：更换图标时 +1，触发所有快捷方式图标刷新。
const SHORTCUT_ICON_VERSION = 'whale-2';

function shortcutIconPath() {
  // 复制到 userData 保证路径稳定（便携版 exe 解压目录每次启动都会变）。
  const ico = path.join(userDataDir, 'icon.ico');
  try {
    const src = path.join(__dirname, 'assets', 'icon.ico');
    if (!fs.existsSync(src)) return '';
    if (!fs.existsSync(ico) || fs.statSync(src).size !== fs.statSync(ico).size) {
      fs.copyFileSync(src, ico);
    }
    return ico;
  } catch (err) {
    log('boot', '复制快捷方式图标失败: ' + err.message);
    return path.join(__dirname, 'assets', 'icon.ico');
  }
}

// V4 修复「更换快捷方式图标后重启又多出一个快捷方式」：
//   旧逻辑只认「桌面\Deepseek Harness EAC.lnk」这个精确文件名。用户换
//   图标时通常删掉旧 .lnk 自建一个新的（名字几乎必然不同），下次启动
//   existsSync 判定缺失 → 再造一个标准名快捷方式 → 桌面上出现两个。
//   且图标版本分支会无条件 replace，把用户自定义图标静默还原成默认。
// 新逻辑：
//   1. 按「.lnk 的 target 是否指向本应用 exe」识别既有快捷方式（任意
//      文件名都算）—— 只要桌面上存在一个指向我们的 .lnk 就不再新建；
//   2. 图标刷新只在 .lnk 的 icon 仍指向我们自管的 icon.ico（即用户没有
//      自定义图标）时进行，用户自定义图标绝不覆盖；
//   3. settings.shortcutPolicy = 'never' 时完全不碰桌面快捷方式（⋯ 菜
//      单可切换），开始菜单快捷方式仍维护（系统通知的前置条件）。
function listLnkFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.lnk'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function readLnkSafe(p) {
  try { return shell.readShortcutLink(p); } catch { return null; }
}

function lnkTargetsApp(lnkPath, target) {
  const link = readLnkSafe(lnkPath);
  if (!link || !link.target) return false;
  return path.resolve(String(link.target)).toLowerCase() === path.resolve(target).toLowerCase();
}

function lnkUsesManagedIcon(lnkPath, ico) {
  if (!ico) return false;
  const link = readLnkSafe(lnkPath);
  if (!link) return false;
  // 无自定义图标（icon 为空，用 target 自带）视为可接管。
  if (!link.icon) return true;
  return path.resolve(String(link.icon)).toLowerCase() === path.resolve(ico).toLowerCase();
}

function maintainShortcuts() {
  if (!app.isPackaged || !IS_WIN) return;
  // E2E / 自动化：跳过快捷方式维护（临时 exe 不得改写真实开始菜单/桌面
  // 快捷方式的指向）。与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同一约定。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const settings = updater.loadSettings(updCtx());
    const policy = settings.shortcutPolicy === 'never' ? 'never' : 'auto';
    const linksDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const APP_TITLE = 'Deepseek Harness EAC';
    const desktopDir = app.getPath('desktop');
    const startMenu = path.join(linksDir, APP_TITLE + '.lnk');
    const desktop = path.join(desktopDir, APP_TITLE + '.lnk');
    const ico = shortcutIconPath();
    const opts = {
      target,
      description: 'DeepSeek Harness 桌面客户端',
      ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      appUserModelId: 'com.deepseek.dsh.desktop',
    };
    let changed = false;
    // 清理旧名称（DSH Desktop）快捷方式：改名后它们指向的 exe 已不存在。
    for (const legacy of [
      path.join(linksDir, 'DSH Desktop.lnk'),
      path.join(desktopDir, 'DSH Desktop.lnk'),
    ]) {
      try { if (fs.existsSync(legacy)) { fs.rmSync(legacy); changed = true; } } catch {}
    }
    // exe 被移动过或图标设计更新：只刷新「确认属于本应用」的快捷方式。
    // 归属判定：target 指向当前 exe，或指向上次记录的 exe 位置（搬家后
    // 的旧快捷方式）；指向其它程序的 .lnk 绝不动。
    const targetMoved = settings.shortcutTarget && settings.shortcutTarget !== target;
    const iconOutdated = settings.shortcutIcon !== SHORTCUT_ICON_VERSION;
    if (targetMoved || iconOutdated) {
      const isOurs = (p) => fs.existsSync(p)
        && (lnkTargetsApp(p, target) || (targetMoved && lnkTargetsApp(p, settings.shortcutTarget)));
      const candidates = [startMenu].concat(policy === 'never' ? [] : listLnkFiles(desktopDir));
      for (const p of candidates) {
        if (!isOurs(p)) continue;
        // 仅图标过时且用户自定义了图标：尊重用户选择，跳过；target 移动
        // 时即使图标被自定义也要修指向（否则快捷方式失效）。
        if (!targetMoved && !lnkUsesManagedIcon(p, ico)) continue;
        try { shell.writeShortcutLink(p, 'replace', opts); changed = true; } catch {}
      }
    }
    // 开始菜单快捷方式：系统通知（Toast）的前置条件，按 target 匹配维护。
    const startMenuOk = fs.existsSync(startMenu) && lnkTargetsApp(startMenu, target);
    if (!startMenuOk) {
      try { shell.writeShortcutLink(startMenu, 'create', opts); changed = true; } catch {}
    }
    // 桌面快捷方式：policy=never 不创建；已有任意名称指向本应用的 .lnk
    // （用户自定义/改名/换图标后的产物）即视为存在，绝不重复新建。
    if (policy !== 'never' && !fs.existsSync(desktop)) {
      const hasOursOnDesktop = listLnkFiles(desktopDir).some((p) => lnkTargetsApp(p, target));
      if (!hasOursOnDesktop) {
        try { shell.writeShortcutLink(desktop, 'create', opts); changed = true; } catch {}
      } else {
        log('boot', '检测到用户自定义的桌面快捷方式（指向本应用），不再重复创建');
      }
    }
    if (changed) {
      settings.shortcutTarget = target;
      settings.shortcutIcon = SHORTCUT_ICON_VERSION;
      updater.saveSettings(updCtx(), settings);
      log('boot', '快捷方式已维护（开始菜单/桌面 → ' + target + '，图标 ' + SHORTCUT_ICON_VERSION + '）');
    }
  } catch (err) {
    log('boot', '快捷方式维护失败: ' + err.message);
  }
}

function warnTempRun() {
  if (!app.isPackaged || !IS_WIN || !process.env.PORTABLE_EXECUTABLE_DIR) return;
  // E2E（scripts/e2e-v4.js）从临时目录跑便携版：告警弹窗会卡住无头验证。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  const dir = process.env.PORTABLE_EXECUTABLE_DIR.toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  if (dir === tmp || dir.startsWith(tmp + path.sep)) {
    showBox({
      type: 'warning',
      title: '正在从临时目录运行',
      message: '当前便携版位于系统临时目录。',
      detail: '临时目录中的文件可能被系统自动清理，导致快捷方式失效或程序“消失”。\n建议把 Deepseek Harness EAC exe 移动到固定位置（如桌面或 D 盘）后再运行。',
      buttons: ['知道了'],
    });
  }
}

// ---------------------------------------------------------------------------
// 一次性迁移：桌面端从共享 web profile 切到专属 web-desktop profile。
//
// 只做三件事，全部幂等：
//   1. 记住用户在旧 profile 里启用的皮肤（迁移后在专属 profile 里复活）；
//   2. 清掉旧 web profile 里桌面端写入的配套插件行 + 拷贝的配套包 + 内置
//      清单标记 —— 原生 CLI 从此加载干净的 web profile（冲突面消除）；
//   3. 标记 settings.desktopProfileMigrated，永不重复执行。
// 用户用市场装进旧 profile 的插件（package.json bundles）是原生端资产，
// 一律不动；桌面端如需继续使用，重新从市场安装即可（有保护中心兜底）。
function migrateFromSharedWebProfile() {
  try {
    const s = updater.loadSettings(updCtx());
    if (s.desktopProfileMigrated) return;
    s.desktopProfileMigrated = new Date().toISOString();
    updater.saveSettings(updCtx(), s); // 先落标记：即使下面失败也不反复折腾
    if (s.shareWebProfile === true) return; // 用户显式选择共享模式

    const home = dshHome || path.join(os.homedir(), '.dsh');
    const oldDir = path.join(home, 'profiles', 'web');
    const marker = path.join(oldDir, '.dsh-builtin-plugins.json');
    if (!fs.existsSync(marker)) return; // 旧版本从没在共享 profile 跑过桌面端
    const builtinNames = readJsonFile(marker)?.names || [];

    // 1) 提取用户启用的皮肤行 id。
    let enabledSkin = null;
    const patchFile = path.join(oldDir, 'cordis.patch.yml');
    let oldPatch = '';
    try { oldPatch = fs.readFileSync(patchFile, 'utf8'); } catch { oldPatch = ''; }
    {
      const lines = oldPatch.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^- id: (ui-skin-[\w-]+)\s*$/.exec(lines[i]);
        if (!m) continue;
        let disabled = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^- /.test(lines[j])) break;
          if (/^\s+disabled:\s*true/.test(lines[j])) disabled = true;
        }
        if (!disabled) enabledSkin = m[1];
      }
    }

    // 2) 清理旧 profile 的桌面端痕迹。
    const rowIdSet = new Set();
    for (const p of COMPANION_PLUGINS) rowIdSet.add(p.id);
    for (const id of extractPatchRowIds(oldPatch)) {
      if (/^ui-skin-[\w-]+$/.test(id)) rowIdSet.add(id);
    }
    const cleaned = removePatchRowsById(oldPatch, rowIdSet);
    if (cleaned.removed.length) fs.writeFileSync(patchFile, cleaned.patch);
    for (const name of builtinNames) {
      try { fs.rmSync(path.join(oldDir, 'node_modules', ...String(name).split('/')), { recursive: true, force: true, maxRetries: 2 }); } catch {}
    }
    try { fs.rmSync(marker, { force: true }); } catch {}
    log('boot', '已迁移到桌面专属 profile（' + DESKTOP_PROFILE + '）：旧 web profile 清理了 ' + cleaned.removed.length + ' 条桌面配套行 / ' + builtinNames.length + ' 个配套包');

    // 3) 在专属 profile 里复活用户选择的皮肤（等 syncCompanionPlugins 写完
    //    全部皮肤行之后执行，见 applyLegacySkinChoice）。
    if (enabledSkin) {
      const s2 = updater.loadSettings(updCtx());
      s2.legacySkinChoice = enabledSkin;
      updater.saveSettings(updCtx(), s2);
      log('boot', '将迁移用户皮肤选择: ' + enabledSkin);
    }
  } catch (err) {
    log('boot', '共享 profile 迁移失败（不影响启动）: ' + err.message);
  }
}

function extractPatchRowIds(patch) {
  const ids = [];
  const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
  let m;
  while ((m = re.exec(String(patch || ''))) !== null) ids.push(m[1]);
  return ids;
}

// 按 id 集合删除 patch 里的 insert 行块（与 removeBundledRowDuplicates 同
// 语法约定：id 紧跟 `- insert:` 之后）。
function removePatchRowsById(patch, ids) {
  const removed = [];
  if (typeof patch !== 'string' || patch === '' || !ids || ids.size === 0) return { patch, removed };
  const lines = patch.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s*insert:/.test(line)) {
      const mid = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(lines[i + 1] || '');
      if (mid && ids.has(mid[1])) {
        removed.push(mid[1]);
        let j = i + 1;
        while (j < lines.length && !/^-\s*insert:/.test(lines[j]) && /^#/.test(lines[j]) === false && /^\s+\S/.test(lines[j])) j++;
        i = j - 1;
        continue;
      }
    }
    out.push(line);
  }
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!text.endsWith('\n')) text += '\n';
  return { patch: text, removed };
}

// syncCompanionPlugins 之后调用一次：把迁移带来的皮肤选择落到新 profile。
function applyLegacySkinChoice() {
  try {
    const s = updater.loadSettings(updCtx());
    const skin = s.legacySkinChoice;
    if (!skin || !/^ui-skin-[\w-]+$/.test(skin)) return;
    const patchFile = path.join(desktopProfileDir(), 'cordis.patch.yml');
    if (!fs.existsSync(patchFile)) return;
    const text = fs.readFileSync(patchFile, 'utf8');
    const re = new RegExp('(- id: ' + skin + '\\b[^\\n]*\\n(?:      [^\\n]*\\n)*?)      disabled: true\\n');
    const next = text.replace(re, '$1');
    if (next !== text) {
      fs.writeFileSync(patchFile, next);
      log('boot', '已在专属 profile 启用迁移的皮肤: ' + skin);
    }
    delete s.legacySkinChoice;
    updater.saveSettings(updCtx(), s);
  } catch (err) {
    log('boot', '应用迁移皮肤选择失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// junction 归属巡检：原生 dsh（npx / 全局安装）启动时会把 <home>/profiles/
// node_modules 的共享 junction 重新指向它自己的闭包 —— 桌面端正在运行的
// 服务随后解析到错误版本（「设置命名空间不可用」的一大根因），npx 缓存
// 被清理后更是直接悬空。这里周期性检查：发现异动且外部 dsh 进程已退出，
// 就把指向修复回客户端闭包（原生 CLI 重启时会再次指回它自己，互不纠缠：
// 各自启动时各自纠正，运行中互不打扰）。
// ---------------------------------------------------------------------------
function startJunctionWatchdog() {
  if (!IS_WIN) return;
  let notified = false;
  const tick = async () => {
    if (quitting || restartingServer) return;
    try {
      const g = ensureGuard();
      const findings = g.junctionFindings();
      if (findings.length === 0) return;
      const ext = await detectExternalDsh();
      if (ext.running) {
        log('guard', '共享模块被外部 dsh 接管（PID ' + ext.pids.join(', ') + '），待其退出后自动修复');
        return;
      }
      const res = g.repairJunctions();
      if (res.repaired.length && !notified) {
        notified = true;
        try {
          const n = new Notification({
            title: '已自动修复共享模块指向',
            body: '检测到原生 dsh 改写了共享模块目录，桌面端已恢复指向自身版本。原生 CLI 如有异常，重启它即可。',
            icon: path.join(__dirname, 'assets', 'icon.png'),
          });
          n.on('click', () => showMainWindow());
          n.show();
        } catch {}
      }
    } catch { /* 巡检失败静默 */ }
  };
  setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000).unref();
}

// 检测本机是否有其它 dsh 进程在跑（原生 CLI / 另一份安装）。Windows 下用
// CIM 查 node 进程命令行；超时或失败按「无外部进程」处理（宁可漏报）。
function detectExternalDsh() {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ running: false, pids: [] });
    const own = new Set([process.pid]);
    if (serverProc && serverProc.pid) own.add(serverProc.pid);
    let out = '';
    try {
      out = require('node:child_process').execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\'\'node.exe\'\'\' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
        { encoding: 'utf8', windowsHide: true, timeout: 12000 });
    } catch {
      return resolve({ running: false, pids: [] });
    }
    try {
      const arr = out.trim() === '' ? [] : JSON.parse(out);
      const list = Array.isArray(arr) ? arr : [arr];
      const pids = [];
      for (const it of list) {
        const pid = Number(it && it.ProcessId);
        const cmd = String((it && it.CommandLine) || '');
        if (!Number.isFinite(pid) || own.has(pid)) continue;
        if (!/dsh|deepseek-ai/i.test(cmd)) continue;
        if (!/(\s|\/|\\)(web|plugin|run|tui)(\s|$)|bin\.(js|ts)/i.test(cmd)) continue;
        pids.push(pid);
      }
      resolve({ running: pids.length > 0, pids });
    } catch {
      resolve({ running: false, pids: [] });
    }
  });
}

// ---------------------------------------------------------------------------
// 客户端自更新流程（更新 DSH Desktop 封装本身）
// ---------------------------------------------------------------------------

async function runClientUpdateFlow(manual) {
  if (quitting) return;
  if (clientUpdateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '客户端更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  const ctx = updCtx();
  const settings = updater.loadSettings(ctx);
  let release;
  try {
    release = await clientUpdater.checkLatest(ctx, APP_VERSION);
  } catch (err) {
    log('client-update', '检查失败: ' + err.message);
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查客户端更新失败',
        message: '无法连接上游发布源。',
        detail: err.message + '\n\n可通过环境变量 DSH_DESKTOP_RELEASE_API 指定镜像 API。',
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!release.isNewer) {
    if (manual) {
      await showBox({
        type: 'info',
        title: '检查客户端更新',
        message: '当前已是最新版本。',
        detail: `Deepseek Harness EAC（封装版本 v${APP_VERSION}）\n上游最新：${release.version}（${release.source}）`,
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!manual && settings.skipClientVersion === release.version) return;
  // M7 修复：用户选过"稍后"的同版本不再每 12h 重复弹窗/重复下载。
  if (!manual && settings.pendingClientVersion === release.version) return;
  // E2E 自动化钩子（与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同惯例）：自动接受
  // 「立即更新」，让 scripts/e2e-v4.js 能无人值守跑完整更新链路。默认关闭。
  const autoAcceptUpdate = process.env.DSH_DESKTOP_TEST_AUTO_UPDATE === '1';
  const notes = release.body ? '\n\n更新说明：\n' + release.body.slice(0, 800) : '';
  const { response } = autoAcceptUpdate ? { response: 0 } : await showBox({
    type: 'info',
    title: '发现新版本客户端',
    message: `Deepseek Harness EAC 封装发布了新版本：v${release.version}`,
    detail: `当前版本：v${APP_VERSION}\n发布来源：${release.source}${notes}\n\n是否立即更新？下载后自动替换并重启应用。`,
    buttons: ['立即更新', '跳过此版本', '稍后'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 1) {
    settings.skipClientVersion = release.version;
    updater.saveSettings(ctx, settings);
    log('client-update', '用户跳过版本 ' + release.version);
    return;
  }
  if (response === 2) {
    // M7 修复：记录"稍后"版本，周期检查不再重复打扰（新版本出现时仍会提示）。
    settings.pendingClientVersion = release.version;
    updater.saveSettings(ctx, settings);
    log('client-update', '用户稍后处理版本 ' + release.version);
    return;
  }

  clientUpdateBusy = true;
  const progressWin = showUpdateWindow(release.version, 'client');
  const progress = makeUpdateProgressPusher(progressWin);
  try {
    // V4.1 更新保障①：客户端更新前同样强制插件/配置快照，失败则中止
    //（下载与安装都不动 profile，但多一道回滚点总比少一道强）。
    if (!ensureGuard().snapshot('pre-update:client:' + release.version)) {
      throw new Error('更新前保护快照失败（profile 不可读），已中止客户端更新。');
    }
    // V4.2：探测其余发布源的同版本 release 作为备用下载源（GitHub ↔ Gitee），
    // 主源多次失败/卡住时自动切换，全程在弹窗内提示。
    const fallbacks = await clientUpdater.releaseFallbacks(ctx, release);
    const speedState = { t: 0, bytes: 0, speed: null };
    const { filePath, size } = await clientUpdater.downloadRelease(ctx, release, {
      fallbacks,
      onSourceChange: (source, idx, urls) => {
        log('client-update', `切换备用下载源（${idx + 1}/${urls.length}）`);
        progress.force({ stage: '下载停滞，已自动切换下载源（' + (idx + 1) + '/' + urls.length + '）…' });
      },
      onProgress: (received, total) => {
        const now = Date.now();
        if (speedState.t && now - speedState.t >= 500) {
          const inst = (received - speedState.bytes) / ((now - speedState.t) / 1000);
          speedState.speed = speedState.speed == null ? inst : speedState.speed * 0.7 + inst * 0.3;
        }
        speedState.t = now;
        speedState.bytes = received;
        const sp = speedState.speed || 0;
        const pct = total > 0 ? Math.round((received * 100) / total) : -1;
        const meta = {};
        if (pct >= 0 && sp > 0 && received < total) {
          meta.speedMBps = sp / 1048576;
          meta.etaSec = (total - received) / sp;
        }
        progress.client(received, total, meta);
      },
    });
    settings.pendingClientUpdate = { version: release.version, path: filePath, source: release.source };
    settings.skipClientVersion = null;
    settings.pendingClientVersion = null;
    updater.saveSettings(ctx, settings);
    const { response: r2 } = autoAcceptUpdate ? { response: 0 } : await showBox({
      type: 'info',
      title: '下载完成',
      message: `已准备好 Deepseek Harness EAC 封装 v${release.version}（${Math.round(size / 1048576)} MB）。`,
      detail: '立即重启应用完成更新？\n· 重启后自动安装新版本并启动\n· 插件、皮肤、会话与配置全部保留（仅替换程序本体）\n· 选择稍后重启：下次启动时再提示安装',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r2 === 0) {
      quitting = true;
      forceQuit = true;
      markCleanExit();
      updater.abort();
      if (sessionWatcher) sessionWatcher.stop();
      // V4：先等 dsh web 进程树真正退出（旧实现 killTree 的强杀补刀在
      // 主进程退出后不会执行，node.exe+conhost.exe 成对残留）。
      await killTreeAndWait(serverProc);
      serverProc = null;
      const clientUpdateOpts = {
        userDataDir,
        dshHome,
        installDir: path.dirname(process.execPath),
        profileDir: path.join(dshHome, 'profiles', desktopProfile()),
        currentVersion: APP_VERSION,
        newVersion: release.version,
        nodeExe: nodeExe(),
      };
      clientUpdater.applyUpdate(ctx, settings.pendingClientUpdate, clientUpdateOpts);
      setTimeout(() => app.exit(0), 400);
    }
  } catch (err) {
    log('client-update', '更新失败: ' + err.message);
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成客户端更新，仍使用当前版本。',
      detail: err.message,
      buttons: ['确定'],
    });
  } finally {
    clientUpdateBusy = false;
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

function offerPendingClientUpdate() {
  const ctx = updCtx();
  const settings = updater.loadSettings(ctx);
  const pending = settings.pendingClientUpdate;
  if (!pending || !pending.path) return;
  if (!fs.existsSync(pending.path)) {
    settings.pendingClientUpdate = null;
    updater.saveSettings(ctx, settings);
    return;
  }
  if (updater.compareVersions(pending.version, APP_VERSION) <= 0) {
    settings.pendingClientUpdate = null;
    updater.saveSettings(ctx, settings);
    return;
  }
  showBox({
    type: 'info',
    title: '有待安装的客户端更新',
    message: `已下载 Deepseek Harness EAC 封装 v${pending.version}，是否现在安装并重启？`,
    detail: '安装包保存在数据目录的 updates 文件夹中。\n插件、皮肤、会话与配置全部保留（仅替换程序本体）。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then(async ({ response }) => {
    if (response !== 0) return;
    quitting = true;
    forceQuit = true;
    markCleanExit();
    updater.abort();
    if (sessionWatcher) sessionWatcher.stop();
    // V4：同 runClientUpdateFlow —— 等进程树退出再交给更新脚本接管。
    await killTreeAndWait(serverProc);
    serverProc = null;
    const clientUpdateOpts2 = {
      userDataDir,
      dshHome,
      installDir: path.dirname(process.execPath),
      profileDir: path.join(dshHome, 'profiles', desktopProfile()),
      currentVersion: APP_VERSION,
      newVersion: pending.version,
      nodeExe: nodeExe(),
    };
    clientUpdater.applyUpdate(ctx, pending, clientUpdateOpts2);
    setTimeout(() => app.exit(0), 400);
  });
}

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
  // 日志系统（AC-1：先 init，后 log() 调用，保证结构化 boot 行落到 main.00）
  try {
    structuredLogger.init({
      logsDir,
      level: process.env.DSH_LOG_LEVEL || (app.isPackaged ? 'info' : 'debug'),
      appVersion: APP_VERSION,
      env: app.isPackaged ? 'production' : 'development',
    });
  } catch (e) {
    // 日志系统初始化失败不影响启动（仍然写 desktop.log）。
    try { console.error('[logger.init fail]', e && e.message); } catch {}
  }
  desktopLog = fs.createWriteStream(path.join(logsDir, 'desktop.log'), { flags: 'a' });
  log('boot', `Deepseek Harness EAC（封装 ${APP_VERSION}）  userData=${userDataDir}  dshHome=${dshHome || '(dsh 默认)'}  agent=${dshVersion()}(${dshVersionSource()})`);

  // 移除原生菜单栏（文件/视图/帮助），全部功能由自绘 chrome 与托盘提供。
  Menu.setApplicationMenu(null);
  startPreviewStaticServer();
  registerChromeIpc();
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
  // junction 归属守卫：原生 dsh 会把共享模块指到它自己的闭包，这里先纠偏
  // 一次，并启动周期巡检（原生进程退出后自动恢复指向）。
  applyKoffiPreflightAsync()
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
      // V4.3 PR（独有价值）：客户端更新成功后 24h 内非阻塞询问是否清理 4 目录备份
      // （超 24h 自动登记 pendingBackupCleanup；确认删时保留 manifest.json 诊断副本）；
      // 无空 setTimeout 死代码。
      offerBackupCleanupConfirm();
      // Session-completion notifications: watch dsh session logs under the
      // effective DSH_HOME (same config the CLI uses).
      const s = updater.loadSettings(updCtx());
      notifyOnTurnEnd = s.notifyOnTurnEnd !== false;
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      sessionWatcher = new SessionWatcher({
        sessionsDir: path.join(home, 'sessions'),
        log,
        onTurnEnd: (info) => onSessionTurnEnd(info),
      });
      sessionWatcher.start();
      maintainShortcuts();
      warnTempRun();
      startBalanceLoop();
      offerPendingClientUpdate();

      if (!process.env.DSH_DESKTOP_SKIP_AUTO_UPDATE) {
        // dsh agent 更新：启动 15 秒后 + 每 6 小时。
        setTimeout(() => runUpdateFlow(false), 15000).unref();
        setInterval(() => runUpdateFlow(false), AUTO_UPDATE_INTERVAL_MS).unref();
      }
      if (!process.env.DSH_DESKTOP_SKIP_CLIENT_UPDATE) {
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
    // V4：退出必须等 dsh web 进程树真正死透再退（见 killTreeAndWait 注释）。
    // 首次事件里阻止默认退出，完成异步清理后 app.exit(0)；后续重复事件
    // （window-all-closed 触发的 app.quit 等）直接放行。
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    event.preventDefault();
    quitting = true;
    forceQuit = true;
    const t0 = Date.now();
    log('boot', '正在退出，停止 dsh web 进程树…');
    markCleanExit();
    (async () => {
      try {
        closeAllFloatWindows();
        // 正在跑的插件市场排队任务：直接强杀（它只是 pnpm 的转发器，
        // 标记文件的 attempts 机制会在下次启动重试）。
        if (marketOpChild && marketOpChild.pid && marketOpChild.exitCode === null) {
          try {
            spawn('taskkill', ['/pid', String(marketOpChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch {}
        }
        await killTreeAndWait(serverProc);
        updater.abort();
        if (sessionWatcher) sessionWatcher.stop();
      } catch (err) {
        log('boot', '退出清理异常: ' + err.message);
      } finally {
        if (balanceTimer) clearInterval(balanceTimer);
        if (tray) { try { tray.destroy(); } catch {} tray = null; }
        log('boot', `退出清理完成（耗时 ${Date.now() - t0}ms）`);
        // 日志系统 flush：结构化 logger 先关（flush 缓冲区+结束 rotation stream），
        // 再关 desktop.log 纯文本，保证退出前两条通道都落盘。
        try { structuredLogger.close(); } catch {}
        try { if (desktopLog) desktopLog.end(); } catch {}
        app.exit(0);
      }
    })();
  });
  // 关闭窗口后常驻托盘；托盘不存在时才随窗口退出。
  app.on('window-all-closed', () => {
    if (!IS_WIN || !tray) app.quit();
  });
  app.whenReady().then(boot).catch((err) => fatal('应用初始化失败', err));
}

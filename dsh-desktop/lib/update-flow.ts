/**
 * lib/update-flow.ts — 双更新流（Task 5b 自 main.js 提取）。
 *
 * agent 更新流（官方 @deepseek-ai/dsh releases，用户确认）：
 *   runUpdateFlow + 内置插件更新检查（runPluginUpdateCheck，24h 节流）。
 * client 更新流（更新 DSH Desktop 封装本身）：
 *   runClientUpdateFlow + offerPendingClientUpdate + scheduleClientUpdateRescue。
 * 共用：showUpdateWindow（updating.html 进度窗）/ makeUpdateProgressPusher
 * （字节进度 + 速度 + ETA / npm 阶段文案，300ms 节流注入）。
 *
 * 更新保障（V4.1）：任何更新前强制 plugin-guard 快照，失败即中止
 * （宁可不动，不可让用户失去回滚点）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, Notification } from 'electron';
import * as updater from '../updater.js';
import type { AgentProgressEvent } from '../updater.js';
import * as clientUpdater from '../client-updater.js';
import * as pluginUpdater from '../plugin-updater.js';
import { state } from './state.js';
import { log } from './log.js';
import { updCtx, killTree, killTreeAndWait, nodeExe } from './proc.js';
import { desktopProfile, desktopProfileDir } from './paths.js';
import { markCleanExit } from './run-state.js';
import { restartWebServiceCore } from './server.js';
import { showBox } from './window.js';
import { showMainWindow } from './tray.js';
import { ensureGuard } from './guard.js';
import { pluginUpdateSources } from './plugin-registry-data.js';
import { copyPluginPackage } from './plugin-copy.js';
import { removedPluginIds } from './plugin-manager-core.js';

// ---------------------------------------------------------------------------
// 进度窗与进度推送（agent / client 共用）
// ---------------------------------------------------------------------------

/** 更新进度窗（模态 updating.html）。 */
function showUpdateWindow(version: string, kind: 'agent' | 'client' = 'agent'): BrowserWindow {
  const parent = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null;
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    ...(parent ? { parent } : {}),
    modal: true,
    title: '正在更新',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void win.loadFile(path.join(__dirname, '..', 'assets', 'updating.html')).then(() => {
    void win.webContents
      .executeJavaScript(`window.__init && window.__init(${JSON.stringify({ version, kind })})`)
      .catch(() => {});
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

/** 进度元信息：stage 文案时进度条走不定态（-1）。 */
interface ProgressMeta {
  stage?: string;
  speedMBps?: number;
  etaSec?: number;
}

interface PushPayload {
  pct: number;
  receivedMB?: number;
  totalMB?: number;
  meta: ProgressMeta;
  force?: boolean;
}

// 更新弹窗进度推送：把结构化进度渲染成文案，节流后注入 updating.html 的
// __setProgress(pct, receivedMB, totalMB, meta)。
function makeUpdateProgressPusher(win: BrowserWindow): {
  client(received: number, total: number, meta?: ProgressMeta): void;
  force(meta: ProgressMeta): void;
  agent(ev: AgentProgressEvent): void;
} {
  let last = 0;
  const hostOf = (registry: string | undefined): string => {
    try {
      return String(registry ?? '')
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
    } catch {
      return '';
    }
  };
  const push = (payload: PushPayload): void => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    if (now - last < 300 && !payload.force) return;
    last = now;
    void win.webContents
      .executeJavaScript(
        `window.__setProgress && window.__setProgress(${payload.pct}, ${payload.receivedMB ?? 0}, ${payload.totalMB ?? 0}, ${JSON.stringify(payload.meta)})`,
      )
      .catch(() => {});
  };
  return {
    // 客户端更新：真实字节进度 + 速度 + 剩余时间（meta 可选追加）。
    client: (received, total, meta = {}) => {
      const pct = total > 0 ? Math.round((received * 100) / total) : -1;
      push({
        pct,
        receivedMB: Math.round(received / 1048576),
        totalMB: Math.round(total / 1048576),
        meta,
      });
    },
    force: (meta) => push({ pct: -1, meta, force: true }),
    // agent 更新：npm 阶段/包数/耗时 + 镜像源切换
    agent: (ev) => {
      let stage: string;
      if (ev.stage === 'fetch') {
        stage =
          `下载依赖 · 已获取 ${ev.count ?? 0} 项 · 用时 ${ev.elapsed ?? ''}` +
          (ev.registry ? ' · 源：' + hostOf(ev.registry) : '');
      } else if (ev.stage === 'install') {
        stage = '正在安装依赖…';
      } else if (ev.stage === 'done') {
        stage = '安装完成，正在切换版本…';
      } else if (ev.stage === 'mirror') {
        stage = ev.registry
          ? '下载停滞，已自动切换镜像源：' + hostOf(ev.registry)
          : '下载失败，正在尝试其他镜像源…';
      } else {
        stage = '正在更新…';
      }
      push({ pct: -1, meta: { stage } });
    },
  };
}

// ---------------------------------------------------------------------------
// agent 更新流（官方 @deepseek-ai/dsh releases，用户确认）
// ---------------------------------------------------------------------------

/**
 * agent（@deepseek-ai/dsh）更新流：检查官方 releases → 用户确认 → 下载
 * 安装到 overlay（失败自动切换镜像源）→ 重启 Web 服务切版本。manual=true
 * 来自「检查更新」入口（跳过节流、弹窗提示已是最新）。
 */
export async function runUpdateFlow(manual: boolean): Promise<void> {
  if (state.quitting) return;
  if (state.updateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  const ctx = updCtx();
  let latest: string;
  try {
    latest = await updater.checkLatest(ctx);
  } catch (err) {
    log('update', '检查失败: ' + String((err as Error).message));
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查更新失败',
        message: '无法连接 npm registry。',
        detail: String((err as Error).message) + '\n\n可通过环境变量 NPM_CONFIG_REGISTRY 配置镜像。',
        buttons: ['确定'],
      });
    }
    return;
  }
  const current = updater.activeVersion(ctx) ?? '';
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

  state.updateBusy = true;
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
      state.quitting = true;
      markCleanExit();
      killTree(state.serverProc);
      app.relaunch();
      app.exit(0);
    }
  } catch (err) {
    log('update', '更新失败: ' + String((err as Error).message));
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成更新，仍使用当前版本。',
      detail: String((err as Error).message),
      buttons: ['确定'],
    });
  } finally {
    state.updateBusy = false;
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

// ---------------------------------------------------------------------------
// 内置插件更新检查（V4.3）：启动后静默执行。
//   · settings.pluginAutoUpdate = false（默认）→ 发现更新仅系统通知，不下载
//   · true → 自动下载到覆盖层（服务运行中不写 profile），弹窗提示重启
// 24h 节流（settings.pluginUpdateCheckedAt）+ 单插件失败不阻塞。
// ---------------------------------------------------------------------------

interface PluginUpdateItem {
  name: string;
  hasUpdate: boolean;
  skipped?: boolean;
}

function notifyPluginUpdates(updatable: PluginUpdateItem[]): void {
  try {
    const names = updatable.slice(0, 5).map((x) => x.name).join('、');
    const n = new Notification({
      title: '有 ' + updatable.length + ' 个内置插件可更新',
      body: names + (updatable.length > 5 ? ' 等' : '') + ' 已发布新版本。打开「设置 → 插件 → 更新」查看并更新（自动更新默认关闭，仅提示）。',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    });
    n.on('click', () => showMainWindow());
    n.show();
  } catch (err) {
    log('plugin-update', '更新通知发送失败: ' + String((err as Error).message));
  }
}

/**
 * 内置插件上游更新检查（npm 源 vs 随包资产）：默认只提示不打扰，开启自动
 * 更新时经 staging 合并 + 覆盖层原子切换后拷入 profile（详见文件头）。
 * 24h 落盘节流；manual=true 强制检查。
 */
export async function runPluginUpdateCheck(manual: boolean): Promise<void> {
  if (state.quitting) return;
  const ctx = updCtx();
  const sources = pluginUpdateSources(removedPluginIds());
  if (sources.length === 0) return;
  if (!manual && !pluginUpdater.dueForCheck(ctx, Date.now())) return;
  let list: PluginUpdateItem[];
  try {
    list = (await pluginUpdater.checkPluginUpdates(ctx, sources, {
      force: !!manual,
      profileDirP: desktopProfileDir(),
    })) as PluginUpdateItem[];
    if (!manual) pluginUpdater.markChecked(ctx);
  } catch (err) {
    log('plugin-update', '内置插件更新检查失败: ' + String((err as Error).message));
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
    copyIntoProfile: (overlayDir: string, name: string) =>
      copyPluginPackage(desktopProfileDir(), overlayDir, name),
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
      try {
        await restartWebServiceCore();
      } catch (err) {
        log('plugin-update', '重启服务失败: ' + String((err as Error).message));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 客户端自更新流（更新 DSH Desktop 封装本身）
// ---------------------------------------------------------------------------

/** 组装 applyUpdate 的目录参数（两个入口共用）。 */
function clientUpdateOpts(newVersion: string): clientUpdater.ApplyUpdateOpts {
  return {
    userDataDir: state.userDataDir,
    dshHome: state.dshHome,
    installDir: path.dirname(process.execPath),
    profileDir: path.join(state.dshHome, 'profiles', desktopProfile()),
    currentVersion: app.getVersion(),
    newVersion,
    nodeExe: nodeExe(),
  };
}

/**
 * 客户端（DSH Desktop 封装本体）更新流：检查 GitHub/Gitee releases →
 * 用户确认（跳过版本/稍后有记忆）→ 下载（断点续传）→ 杀进程树 → 备份 →
 * 原子替换 → 重启（详见 client-updater 域）。manual=true 来自菜单「检查
 * 更新」（失败/已是最新弹窗提示）；定时自动检查静默失败。E2E 可用
 * DSH_DESKTOP_TEST_AUTO_UPDATE=1 自动接受。
 */
export async function runClientUpdateFlow(manual: boolean): Promise<void> {
  if (state.quitting) return;
  if (state.clientUpdateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '客户端更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  const ctx = updCtx();
  const settings = updater.loadSettings(ctx);
  let release: clientUpdater.NormalizedRelease;
  try {
    release = await clientUpdater.checkLatest(ctx, app.getVersion());
  } catch (err) {
    log('client-update', '检查失败: ' + String((err as Error).message));
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查客户端更新失败',
        message: '无法连接上游发布源。',
        detail: String((err as Error).message) + '\n\n可通过环境变量 DSH_DESKTOP_RELEASE_API 指定镜像 API。',
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
        detail: `Deepseek Harness EAC（封装版本 v${app.getVersion()}）\n上游最新：${release.version}（${release.source}）`,
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
  const { response } = autoAcceptUpdate
    ? { response: 0 }
    : await showBox({
        type: 'info',
        title: '发现新版本客户端',
        message: `Deepseek Harness EAC 封装发布了新版本：v${release.version}`,
        detail: `当前版本：v${app.getVersion()}\n发布来源：${release.source}${notes}\n\n是否立即更新？下载后自动替换并重启应用。`,
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

  state.clientUpdateBusy = true;
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
    const speedState = { t: 0, bytes: 0, speed: null as number | null };
    const { filePath, size } = await clientUpdater.downloadRelease(ctx, release, {
      fallbacks,
      onSourceChange: (source, idx, urls) => {
        void source;
        log('client-update', `切换备用下载源（${idx + 1}/${urls.length}）`);
        progress.force({ stage: '下载停滞，已自动切换下载源（' + (idx + 1) + '/' + urls.length + '）…' });
      },
      onProgress: (received: number, total: number) => {
        const now = Date.now();
        if (speedState.t && now - speedState.t >= 500) {
          const inst = (received - speedState.bytes) / ((now - speedState.t) / 1000);
          speedState.speed = speedState.speed == null ? inst : speedState.speed * 0.7 + inst * 0.3;
        }
        speedState.t = now;
        speedState.bytes = received;
        const sp = speedState.speed ?? 0;
        const pct = total > 0 ? Math.round((received * 100) / total) : -1;
        const meta: ProgressMeta = {};
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
    const { response: r2 } = autoAcceptUpdate
      ? { response: 0 }
      : await showBox({
          type: 'info',
          title: '下载完成',
          message: `已准备好 Deepseek Harness EAC 封装 v${release.version}（${Math.round(size / 1048576)} MB）。`,
          detail: '立即重启应用完成更新？\n· 重启后自动安装新版本并启动\n· 插件、皮肤、会话与配置全部保留（仅替换程序本体）\n· 选择稍后重启：下次启动时再提示安装',
          buttons: ['立即重启', '稍后重启'],
          defaultId: 0,
          cancelId: 1,
        });
    if (r2 === 0) {
      state.quitting = true;
      state.forceQuit = true;
      markCleanExit();
      updater.abort();
      if (state.sessionWatcher) state.sessionWatcher.stop();
      // V4：先等 dsh web 进程树真正退出（旧实现 killTree 的强杀补刀在
      // 主进程退出后不会执行，node.exe+conhost.exe 成对残留）。
      await killTreeAndWait(state.serverProc);
      state.serverProc = null;
      clientUpdater.applyUpdate(ctx, settings.pendingClientUpdate as { path: string; version?: string }, clientUpdateOpts(release.version));
      setTimeout(() => app.exit(0), 400);
    }
  } catch (err) {
    log('client-update', '更新失败: ' + String((err as Error).message));
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成客户端更新，仍使用当前版本。',
      detail: String((err as Error).message),
      buttons: ['确定'],
    });
  } finally {
    state.clientUpdateBusy = false;
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

/** 待安装更新的设置形状（settings.pendingClientUpdate）。 */
interface PendingClientUpdate {
  version: string;
  path: string;
  source?: string;
}

/** 下次启动时提示安装已下载的客户端更新。 */
export function offerPendingClientUpdate(): void {
  const ctx = updCtx();
  const settings = updater.loadSettings(ctx);
  const pending = settings.pendingClientUpdate as PendingClientUpdate | null | undefined;
  if (!pending || !pending.path) return;
  if (!fs.existsSync(pending.path)) {
    settings.pendingClientUpdate = null;
    updater.saveSettings(ctx, settings);
    return;
  }
  if (updater.compareVersions(pending.version, app.getVersion()) <= 0) {
    settings.pendingClientUpdate = null;
    updater.saveSettings(ctx, settings);
    return;
  }
  void showBox({
    type: 'info',
    title: '有待安装的客户端更新',
    message: `已下载 Deepseek Harness EAC 封装 v${pending.version}，是否现在安装并重启？`,
    detail: '安装包保存在数据目录的 updates 文件夹中。\n插件、皮肤、会话与配置全部保留（仅替换程序本体）。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then(async ({ response }) => {
    if (response !== 0) return;
    state.quitting = true;
    state.forceQuit = true;
    markCleanExit();
    updater.abort();
    if (state.sessionWatcher) state.sessionWatcher.stop();
    // V4：同 runClientUpdateFlow —— 等进程树退出再交给更新脚本接管。
    await killTreeAndWait(state.serverProc);
    state.serverProc = null;
    clientUpdater.applyUpdate(ctx, pending, clientUpdateOpts(pending.version));
    setTimeout(() => app.exit(0), 400);
  });
}

// 启动失败救援（防重入）：一次会话只主动查一次，避免与用户的重试操作
// 互相干扰；网络失败不打扰（runClientUpdateFlow 的 manual 弹窗已够）。
export function scheduleClientUpdateRescue(): void {
  if (state.clientUpdateRescueArmed || process.env.DSH_DESKTOP_SKIP_CLIENT_UPDATE) return;
  state.clientUpdateRescueArmed = true;
  setTimeout(() => {
    void runClientUpdateFlow(true).catch((e) =>
      log('client-update', '救援检查失败: ' + String((e as Error).message)),
    );
  }, 5000).unref();
}

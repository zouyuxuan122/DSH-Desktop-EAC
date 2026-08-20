/**
 * lib/window.ts — 主窗/浮窗生命周期与渲染进程自恢复装配（Task 3.1 自 main.js 提取）。
 *
 *   showBox / isAllowedWebUrl / attachEditContextMenu 共享工具；
 *   createWindow（导航围栏、右键菜单、快捷键、最大化同步、退出策略接线）；
 *   会话浮窗族（guardFloatWebContents / createFloatWindow / closeAllFloatWindows，
 *   独立 partition + FLOAT_MAX 上限）；reloadMainWindow；
 *   initRendererRecovery / wireWindowRecovery / startHeartbeatLoop（renderer-
 *   recovery.js 状态机装配，上游 Issue #9 根治修复）。
 */

import * as path from 'node:path';
import { app, BrowserWindow, Menu, shell, dialog, Notification } from 'electron';
import type { WebContents } from 'electron';
import { RendererRecovery } from '../renderer-recovery.js';
import type { FailureRecord, RecoveryWindow } from '../renderer-recovery.js';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN } from './proc.js';
import { writeRunState } from './run-state.js';
import { waitUntilUp } from './server.js';
import { bridge } from './bridge.js';

/** 会话浮窗全局上限（防资源滥用）。 */
export const FLOAT_MAX = 8;

/** 消息框：有主窗时挂主窗（模态感），否则无父窗。 */
export function showBox(opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  if (state.mainWindow && !state.mainWindow.isDestroyed())
    return dialog.showMessageBox(state.mainWindow, opts);
  return dialog.showMessageBox(opts);
}

// H1（共享给主窗/浮窗）：origin 精确比较（protocol+host+port），杜绝前缀/
// 异域/userinfo 逃逸；file: 一律拦截（同 webContents 下 file 页面仍持有
// preload 桥）。
export function isAllowedWebUrl(url: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    if (state.webUrl) {
      const base = new URL(state.webUrl);
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
export function attachEditContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_e, params) => {
    const flags = params.editFlags || {};
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || win.isDestroyed()) return;
    let template: Electron.MenuItemConstructorOptions[] | null = null;
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
        { label: '复制图片', click: () => { try { wc.copyImageAt(params.x, params.y); } catch { /* 老版本无此 API */ } } },
        { label: '图片另存为…', click: () => { try { wc.downloadURL(params.srcURL); } catch { /* 老版本无此 API */ } } },
      ];
      if (flags.canCopy) {
        template.push({ type: 'separator' }, { label: '复制', role: 'copy', accelerator: 'Ctrl+C' });
      }
    } else if (flags.canCopy) {
      template = [
        { label: '后退', enabled: wc.navigationHistory.canGoBack?.() ?? wc.canGoBack(), click: () => { try { wc.navigationHistory.goBack?.(); } catch { wc.goBack(); } } },
        { label: '前进', enabled: wc.navigationHistory.canGoForward?.() ?? wc.canGoForward(), click: () => { try { wc.navigationHistory.goForward?.(); } catch { wc.goForward(); } } },
        { label: '重新加载', role: 'reload', accelerator: 'Ctrl+R' },
        { type: 'separator' },
        { label: '复制', role: 'copy', accelerator: 'Ctrl+C' },
        { label: '全选', role: 'selectAll', accelerator: 'Ctrl+A' },
      ];
    } else {
      template = [
        { label: '后退', enabled: wc.navigationHistory.canGoBack?.() ?? wc.canGoBack(), click: () => { try { wc.navigationHistory.goBack?.(); } catch { wc.goBack(); } } },
        { label: '前进', enabled: wc.navigationHistory.canGoForward?.() ?? wc.canGoForward(), click: () => { try { wc.navigationHistory.goForward?.(); } catch { wc.goForward(); } } },
        { label: '重新加载', role: 'reload', accelerator: 'Ctrl+R' },
      ];
    }
    if (template && template.length) {
      Menu.buildFromTemplate(template).popup({ window: win, x: params.x, y: params.y });
    }
  });
}

/** createWindow 参数。 */
export interface CreateWindowOpts {
  /** true 时 ready-to-show 不主动 show（后台重建场景）。 */
  startHidden?: boolean;
}

/**
 * 创建主窗口并装配全部行为（见文件头清单）：加载态页 → ready-to-show 再
 * 显示；导航/开窗围栏（外部链接转系统浏览器）；页面错误采集；F11/F12/
 * Ctrl+R/Alt+F4 快捷键；最大化状态同步（自绘标题栏按钮用）；关闭按退出
 * 策略分流；末尾接线 renderer-recovery。startHidden 供恢复流程后台重建。
 */
export function createWindow(opts: CreateWindowOpts = {}): void {
  const { startHidden = false } = opts;
  state.mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Deepseek Harness EAC',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // 风格化无边框窗口：去掉原生标题栏/菜单栏，自绘玻璃栏 + Win11 原生圆角。
    ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  state.mainWindow.loadFile(path.join(__dirname, '..', 'assets', 'loading.html'));
  state.mainWindow.once('ready-to-show', () => {
    if (!startHidden) state.mainWindow?.show();
  });
  // Keep the app brand in the OS title bar (the web UI sets its own <title>).
  state.mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    state.mainWindow?.setTitle('Deepseek Harness EAC');
  });

  // Open target=_blank / window.open in the system browser.
  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the app pinned to the local web UI; send external links out.
  // H1 修复：origin 精确比较（protocol+host+port），杜绝前缀/异域/userinfo 逃逸；
  // file: 一律拦截（同 webContents 下 file 页面仍持有 preload 桥）；will-redirect 同规则。
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isAllowedWebUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  state.mainWindow.webContents.on('will-navigate', guardNavigation);
  state.mainWindow.webContents.on('will-redirect', guardNavigation);

  // 渲染进程错误捕获：插件/页面异常统一落到 desktop.log，便于排查空白视图。
  // （新版 Electron 的 level 为数字，旧版为字符串——String 归一后比较，兼容两端。）
  state.mainWindow.webContents.on(
    'console-message',
    (_e, level, message, line, sourceId) => {
      const lvl = String(level);
      if (lvl === 'error' || lvl === '3' || lvl === 'warning' || lvl === '2') {
        log('page', `[${lvl}] ${String(message)} (${sourceId || 'unknown'}:${line})`);
      }
    },
  );
  // V4：浏览器风格右键菜单（编辑/图片/选区/导航四类场景）。
  attachEditContextMenu(state.mainWindow.webContents);
  state.mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('page', `渲染进程异常退出: ${details.reason} (exitCode=${details.exitCode})`);
  });

  // 移除菜单栏后仍保留的键盘快捷键。
  state.mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const mw = state.mainWindow;
    if (!mw) return;
    if (input.key === 'F11') { mw.setFullScreen(!mw.isFullScreen()); event.preventDefault(); }
    else if (input.key === 'F12') { mw.webContents.toggleDevTools(); event.preventDefault(); }
    else if (input.control && input.shift && key === 'i') { mw.webContents.toggleDevTools(); event.preventDefault(); }
    else if (input.control && key === 'r') { reloadMainWindow(); event.preventDefault(); }
    else if (input.alt && key === 'f4') { mw.close(); event.preventDefault(); }
  });

  // 自绘最大化/还原按钮需要感知窗口状态。
  const sendMaxState = (): void => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('chrome:maximized', state.mainWindow.isMaximized());
    }
  };
  state.mainWindow.on('maximize', sendMaxState);
  state.mainWindow.on('unmaximize', sendMaxState);
  state.mainWindow.on('enter-full-screen', sendMaxState);
  state.mainWindow.on('leave-full-screen', sendMaxState);

  // 关闭 → 按退出行为设置处理：ask 弹窗询问 / minimize 隐藏到托盘 / quit 退出。
  state.mainWindow.on('close', async (event) => {
    if (state.forceQuit || !IS_WIN || !state.tray) return;
    event.preventDefault();
    const action = bridge.getExitAction();
    let choice = action;
    if (action === 'ask') {
      choice = await bridge.askExitAction();
      // 弹窗期间用户可能已通过菜单真正退出（quitting/forceQuit 置位）。
      if (state.forceQuit || state.quitting) return;
    }
    if (choice === 'minimize') {
      state.mainWindow?.hide();
      bridge.trayHintOnce();
    } else {
      state.forceQuit = true;
      app.quit();
    }
  });

  state.mainWindow.on('closed', () => {
    state.mainWindow = null;
  });

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

/** 浮窗 webContents 围栏：与主窗同规则的导航/开窗拦截 + 浮窗专属错误采集。 */
export function guardFloatWebContents(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isAllowedWebUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  wc.on('will-navigate', guardNavigation);
  wc.on('will-redirect', guardNavigation);
  wc.on('console-message', (details, level, message, line, sourceId) => {
    const text = String((details && details.message) || message || '');
    const lvl = String((details && details.level) || level);
    const src = (details && details.sourceId) || sourceId || 'unknown';
    const lineNo = (details && details.lineNumber) ?? line;
    if (lvl === 'error' || lvl === '3' || lvl === 'warning' || lvl === '2' || /\[dsh-float-window\]/.test(text)) {
      log('float-page', `[${lvl}] ${text} (${String(src)}:${String(lineNo)})`);
    }
  });
}

/** createFloatWindow 参数。 */
export interface CreateFloatOpts {
  title?: string;
}

// 创建并登记一个会话浮窗。返回 BrowserWindow；失败返回 null。
export function createFloatWindow(
  sessionId: string,
  opts: CreateFloatOpts = {},
): BrowserWindow | null {
  const { title } = opts;
  if (!state.webUrl || state.floatWindows.size >= FLOAT_MAX) return null;
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: title || 'DSH 会话',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // 与主窗一致的无边框；浮窗 preload 注入一条更细的纯拖拽条。
    ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
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
  state.floatWindows.add(win);
  state.floatBySession.set(sessionId, win);
  win.loadURL(state.webUrl).catch((err) => log('float', '浮窗加载失败: ' + String((err && (err as Error).message) || err)));

  // 窗口标题跟随会话（去掉通用前缀，保留会话相关标题）。
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    // Electron 类型未标 title 字段（运行时存在）——宽化读取。
    const evTitle = (event as Electron.Event & { title?: string }).title;
    const raw = String(evTitle || win.getTitle() || '');
    const cleaned = raw.replace(/^(DSH|Deepseek Harness EAC)[·\-—\s:]*/i, '').trim();
    win.setTitle(cleaned || 'DSH 会话');
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    state.floatWindows.delete(win);
    for (const [sid, w] of state.floatBySession) {
      if (w === win) {
        state.floatBySession.delete(sid);
        break;
      }
    }
  });
  guardFloatWebContents(win.webContents);
  attachEditContextMenu(win.webContents);
  if (state.recovery) state.recovery.attach(win, 'float');
  log('float', '已创建会话浮窗 sessionId=' + sessionId);
  return win;
}

// 关闭全部浮窗（应用退出时调用）。
export function closeAllFloatWindows(): void {
  for (const win of state.floatWindows) {
    if (!win.isDestroyed()) win.destroy();
  }
  state.floatWindows.clear();
  state.floatBySession.clear();
}

// ---------------------------------------------------------------------------
// 渲染进程自恢复：装配 renderer-recovery 状态机（上游 Issue #9 根治修复）
// ---------------------------------------------------------------------------

/**
 * 构建渲染进程自恢复状态机（renderer-recovery.ts，上游 Issue #9 根治）：
 * 把日志/退出态/服务存活/窗口重建/服务就绪等待等宿主能力适配进恢复机，
 * 幂等（已构建直接复用）。挂载主窗由 wireWindowRecovery 单独接线。
 */
export function initRendererRecovery(): unknown {
  if (state.recovery) return state.recovery;
  const opts = {
    log: (msg: string): void => log('recovery', msg),
    isQuitting: (): boolean => state.quitting,
    isServerAlive: (): boolean =>
      !!state.serverProc && state.serverProc.exitCode === null && !state.serverProc.killed,
    getTarget: (): { kind: 'url'; url: string } | null =>
      state.webUrl ? { kind: 'url', url: state.webUrl } : null,
    loadingPage: path.join(__dirname, '..', 'assets', 'loading.html'),
    recoveryPage: path.join(__dirname, '..', 'assets', 'recovery.html'),
    rebuildMainWindow: ({ startHidden }: { startHidden?: boolean } = {}): RecoveryWindow | null => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy();
      createWindow({ startHidden: !!startHidden });
      return state.mainWindow;
    },
    waitServerUp: (maxMs: number): Promise<string> => {
      if (!state.webUrl) return Promise.reject(new Error('webUrl 未知'));
      return waitUntilUp(state.webUrl, maxMs);
    },
    onGaveUp: (lastFailure: FailureRecord | null): void => {
      writeRunState({
        renderer: {
          state: 'gave-up',
          lastFailure: lastFailure ? `${lastFailure.reason}（exitCode=${lastFailure.exitCode}）` : 'unknown',
          at: new Date().toISOString(),
        },
      });
    },
    onStable: (): void => {
      writeRunState({ renderer: { state: 'healthy', at: new Date().toISOString() } });
    },
    notify: (title: string, body: string): void => {
      try {
        const n = new Notification({
          title,
          body,
          icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        });
        n.on('click', () => bridge.showMainWindow());
        n.show();
      } catch (err) {
        log('recovery', '通知发送失败: ' + String((err as Error).message));
      }
    },
  };
  state.recovery = new RendererRecovery(opts);
  return state.recovery;
}

/** 把当前主窗挂到已构建的恢复状态机（createWindow 末尾与恢复流程重建后调用）。 */
export function wireWindowRecovery(): void {
  if (state.recovery && state.mainWindow && !state.mainWindow.isDestroyed())
    state.recovery.attach(state.mainWindow, 'main');
}

/** 每 15s 轮询一次恢复状态机的心跳判定（可见窗口失联才触发恢复流程）。 */
export function startHeartbeatLoop(): void {
  // renderer 心跳由 preload 每 5s 上报；这里周期性判定「可见窗口」是否失联
  // （窗口不可见时页面定时器被节流，判定只针对可见窗口）。
  setInterval(() => {
    if (state.recovery) state.recovery.checkHeartbeats();
  }, 15000).unref();
}

// 统一的「重新加载」入口：处于恢复页（已放弃自动恢复）时走恢复流程，
// 否则普通 reload。菜单与 Ctrl+R 共用。
export function reloadMainWindow(): void {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  // stateOf 的宽化类型见 lib/state.ts 的 RendererRecoveryLike（返回 unknown）。
  const st = state.recovery
    ? (state.recovery.stateOf(state.mainWindow) as { gaveUp?: boolean } | null)
    : null;
  if (st && st.gaveUp) {
    log('recovery', '用户在恢复页触发重新加载');
    state.recovery?.retryNow(state.mainWindow);
    return;
  }
  state.mainWindow.reload();
}

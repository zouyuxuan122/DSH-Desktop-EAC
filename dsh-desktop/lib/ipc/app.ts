/**
 * lib/ipc/app.ts — 应用外壳域 IPC（Task 4 自 registerChromeIpc 拆分）。
 *
 * chrome:init（preload 初始化握手）/ chrome:window（自绘标题栏按钮）/
 * chrome:menu（⋯ 菜单动作）/ chrome:restart-service（插件市场原地重启）/
 * dsh:copy-text / dsh:page-error / dsh:open-external。
 * channel 名与行为与拆分前逐一对齐。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import * as updater from '../../updater.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { updCtx, dshVersion, dshVersionSource } from '../proc.js';
import { restartWebServiceCore } from '../server.js';
import { showBox } from '../window.js';
import {
  closeToTrayEnabled, setCloseToTray, getExitAction, setExitAction,
  showAbout, repoUrls,
} from '../tray.js';
import { openBuiltinTerminal } from '../terminal.js';
import { runUpdateFlow, runClientUpdateFlow } from '../update-flow.js';
import { fromMainWindow } from './sender.js';

/** 注册应用外壳域全部 channel（清单见文件头；boot 时经 lib/ipc/index.ts 统一调用）。 */
export function registerAppIpc(): void {
  ipcMain.handle('chrome:init', async (event) => {
    if (!fromMainWindow(event)) return null;
    let iconDataUri = '';
    try {
      const buf = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
      if (buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50) {
        iconDataUri = 'data:image/png;base64,' + buf.toString('base64');
      }
    } catch {
      /* 图标缺失：空串 */
    }
    const s = updater.loadSettings(updCtx());
    const urls = repoUrls();
    return {
      appVersion: app.getVersion(),
      agentVersion: dshVersion(),
      agentSource: dshVersionSource(),
      notifyOnTurnEnd: state.notifyOnTurnEnd,
      closeToTray: s.closeToTray !== false,
      exitAction: getExitAction(),
      shortcutPolicy: s.shortcutPolicy === 'never' ? 'never' : 'auto',
      iconDataUri,
      repoUrls: urls,
      staticPort: state.previewStaticPort,
    };
  });

  ipcMain.handle('chrome:window', (event, { action } = {}) => {
    if (!fromMainWindow(event)) return null;
    const mw = state.mainWindow;
    if (!mw) return null;
    switch (action) {
      case 'minimize': mw.minimize(); break;
      case 'toggle-maximize': mw.isMaximized() ? mw.unmaximize() : mw.maximize(); break;
      case 'close': mw.close(); break;
      case 'is-maximized': return mw.isMaximized();
    }
    return null;
  });

  ipcMain.handle('chrome:menu', async (event, { action, value } = {}) => {
    if (!fromMainWindow(event)) {
      return {
        notifyOnTurnEnd: state.notifyOnTurnEnd,
        closeToTray: closeToTrayEnabled(),
        exitAction: getExitAction(),
      };
    }
    const mw = state.mainWindow;
    switch (action) {
      case 'reload': mw?.reload(); break;
      case 'open-terminal': openBuiltinTerminal(); break;
      case 'devtools': mw?.webContents.toggleDevTools(); break;
      case 'fullscreen': if (mw) mw.setFullScreen(!mw.isFullScreen()); break;
      case 'open-browser': if (state.webUrl) void shell.openExternal(state.webUrl); break;
      case 'open-logs': void shell.openPath(state.logsDir); break;
      case 'feedback': void shell.openExternal('https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues'); break;
      case 'check-agent-update': void runUpdateFlow(true); break;
      case 'check-client-update': void runClientUpdateFlow(true); break;
      case 'toggle-notify': {
        state.notifyOnTurnEnd = !state.notifyOnTurnEnd;
        const s = updater.loadSettings(updCtx());
        s.notifyOnTurnEnd = state.notifyOnTurnEnd;
        updater.saveSettings(updCtx(), s);
        break;
      }
      case 'toggle-close-to-tray': setCloseToTray(!closeToTrayEnabled()); break;
      case 'set-exit-action': setExitAction(String(value ?? '')); break;
      case 'restart-service': {
        // 不关闭应用重启 dsh web 服务（皮肤/插件切换后生效，等同市场安装
        // 后的自动重启路径）。窗口由 startAndShow 重载到新端口。
        const r = await restartWebServiceCore();
        if (!r.ok && r.error !== 'not-running') {
          void showBox({
            type: 'error',
            title: '重启 Web 服务失败',
            message: 'dsh web 服务重启未成功。',
            ...(r.error ? { detail: r.error } : {}),
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
        log('boot', '桌面快捷方式自动维护: ' + String(s.shortcutPolicy));
        break;
      }
      case 'about': void showAbout(); break;
      case 'quit': state.forceQuit = true; app.quit(); break;
    }
    const menuState = updater.loadSettings(updCtx());
    return {
      notifyOnTurnEnd: state.notifyOnTurnEnd,
      closeToTray: closeToTrayEnabled(),
      exitAction: getExitAction(),
      shortcutPolicy: menuState.shortcutPolicy === 'never' ? 'never' : 'auto',
    };
  });

  // 插件市场：原地重启 dsh web 服务（安装/卸载插件后生效，窗口重载到新端口）。
  // 核心逻辑 restartWebServiceCore 在 server 域（⋯ 菜单与托盘共用）。
  ipcMain.handle('chrome:restart-service', async (event, payload = {}) => {
    if ((payload as { intent?: string })?.intent !== 'restart-service')
      return { ok: false, error: 'missing-intent' };
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    return restartWebServiceCore();
  });

  // 复制文本到剪贴板（菜单「更新源」复制按钮 / 关于对话框）。
  ipcMain.handle('dsh:copy-text', (event, { text } = {}) => {
    if (!fromMainWindow(event)) return { ok: false };
    if (typeof text !== 'string' || !text || text.length > 2048) return { ok: false };
    const { clipboard } = require('electron') as typeof import('electron');
    clipboard.writeText(text);
    return { ok: true };
  });

  // preload 转发的页面异常（window.onerror / unhandledrejection）。
  ipcMain.on('dsh:page-error', (event, payload) => {
    if (!fromMainWindow(event)) return;
    log('page-error', String(payload));
  });

  // 预览面板：用系统浏览器打开 http(s) URL。
  ipcMain.handle('dsh:open-external', async (event, { url } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'forbidden' };
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
      return { ok: false, error: 'invalid url' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });
}

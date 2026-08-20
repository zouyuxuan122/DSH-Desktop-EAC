/**
 * lib/tray.ts — 系统托盘与退出策略（Task 3.2 自 main.js 提取）。
 *
 *   退出行为三档（ask/minimize/quit，含旧 closeToTray 布尔迁移）；
 *   showMainWindow（bridge 注入给各域通知回调）；
 *   createTray（常驻菜单：显示/双更新流/会话通知开关/重启服务/反馈/退出）；
 *   repoUrls / showAbout（关于对话框）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, Tray, Menu, shell, clipboard } from 'electron';
import * as updater from '../updater.js';
import * as clientUpdater from '../client-updater.js';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN, updCtx, dshVersion, dshVersionSource } from './proc.js';
import { restartWebServiceCore } from './server.js';
import { showBox } from './window.js';
import { openRecoveryCenter } from './recovery-center/register.js';
import { bridge } from './bridge.js';

/** 读取 closeToTray（默认 true：关闭主窗驻留托盘）。 */
export function closeToTrayEnabled(): boolean {
  const s = updater.loadSettings(updCtx());
  return s.closeToTray !== false;
}

/** 写 closeToTray 设置。 */
export function setCloseToTray(v: boolean): void {
  const s = updater.loadSettings(updCtx());
  s.closeToTray = !!v;
  updater.saveSettings(updCtx(), s);
}

// 退出行为三档：ask（每次询问）/ minimize（后台运行）/ quit（直接退出）。
// 旧版本只有 closeToTray 布尔开关，这里做迁移：closeToTray === false → quit，
// 显式 true → minimize（保持旧默认行为），未设置（新安装）→ ask。
export function getExitAction(): 'ask' | 'minimize' | 'quit' {
  const s = updater.loadSettings(updCtx());
  if (s.exitAction === 'ask' || s.exitAction === 'minimize' || s.exitAction === 'quit')
    return s.exitAction;
  if (s.closeToTray === false) return 'quit';
  if (s.closeToTray === true) return 'minimize';
  return 'ask';
}

/** 写退出行为（同步旧字段，避免降级回旧版本时行为回退）。 */
export function setExitAction(v: string): void {
  if (v !== 'ask' && v !== 'minimize' && v !== 'quit') return;
  const s = updater.loadSettings(updCtx());
  s.exitAction = v;
  // 同步旧字段，避免降级回旧版本时行为回退。
  s.closeToTray = v !== 'quit';
  updater.saveSettings(updCtx(), s);
}

// 退出确认弹窗（exitAction === "ask"）。带「记住我的选择」勾选框。
export async function askExitAction(): Promise<'quit' | 'minimize'> {
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
  const choice: 'quit' | 'minimize' = response === 1 ? 'quit' : 'minimize';
  if (checkboxChecked) setExitAction(choice);
  return choice;
}

/** 仓库地址（关于对话框与设置页展示）。 */
export function repoUrls(): { github: string; gitee: string } {
  const repos = clientUpdater.resolveRepos();
  return {
    github: 'https://github.com/' + repos.github,
    gitee: 'https://gitee.com/' + repos.gitee,
  };
}

/** 关于对话框（版本信息 + 仓库地址复制）。 */
export async function showAbout(): Promise<void> {
  const urls = repoUrls();
  const { response } = await showBox({
    type: 'info',
    title: '关于 Deepseek Harness EAC',
    message: 'Deepseek Harness EAC（封装版本 ' + app.getVersion() + '）',
    detail:
      'DeepSeek Harness 桌面客户端\n\nagent 版本：' +
      dshVersion() +
      '（' +
      dshVersionSource() +
      '）\n数据目录：' +
      state.userDataDir +
      '\nDSH_HOME：' +
      (state.dshHome || '（dsh 默认）') +
      '\n\n项目仓库：\n  GitHub: ' +
      urls.github +
      '\n  Gitee:  ' +
      urls.gitee +
      '\n\n交流群：EAC 交流群（群号 523412163）\n反馈问题：⋯ 菜单 → 反馈建议',
    buttons: ['复制 GitHub 地址', '复制 Gitee 地址', '确定'],
  });
  if (response === 0) clipboard.writeText(urls.github);
  else if (response === 1) clipboard.writeText(urls.gitee);
}

/** 首次驻留托盘时气泡提示一次。 */
export function trayHintOnce(): void {
  if (state.trayHintShown || !state.tray) return;
  state.trayHintShown = true;
  try {
    state.tray.displayBalloon({
      title: 'Deepseek Harness EAC 仍在运行',
      content: '窗口已隐藏到系统托盘，点击托盘图标可重新打开。',
      iconType: 'info',
    });
  } catch {
    /* 气球通知失败静默 */
  }
}

/** 显示/聚焦主窗口（托盘、各域通知回调共用；bridge 注入）。 */
export function showMainWindow(): void {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  if (state.mainWindow.isMinimized()) state.mainWindow.restore();
  state.mainWindow.show();
  state.mainWindow.focus();
}

/** 创建系统托盘（仅 Windows；图标缺失静默跳过）。 */
export function createTray(): void {
  if (!IS_WIN) return;
  try {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    if (!fs.existsSync(iconPath)) return;
    state.tray = new Tray(iconPath);
    state.tray.setToolTip('Deepseek Harness EAC');
    const menu = Menu.buildFromTemplate([
      { label: '显示 Deepseek Harness EAC', click: () => showMainWindow() },
      // VNext Phase 0：恢复中心常驻入口（不依赖 Web UI，插件故障时可达）。
      { label: '恢复中心…', click: () => openRecoveryCenter() },
      { type: 'separator' },
      { label: '检查 dsh 更新…', click: () => { showMainWindow(); void bridge.runUpdateFlow(true); } },
      { label: '检查客户端更新…', click: () => { showMainWindow(); void bridge.runClientUpdateFlow(true); } },
      {
        label: '会话完成通知',
        type: 'checkbox',
        checked: state.notifyOnTurnEnd,
        click: (item) => {
          state.notifyOnTurnEnd = item.checked;
          const s = updater.loadSettings(updCtx());
          s.notifyOnTurnEnd = item.checked;
          updater.saveSettings(updCtx(), s);
        },
      },
      { type: 'separator' },
      // V4（用户建议④）：不关闭应用重启 dsh web 服务（皮肤/插件生效路径）。
      { label: '重启 Web 服务', click: () => { showMainWindow(); void restartWebServiceCore(); } },
      { type: 'separator' },
      { label: '反馈建议…', click: () => { showMainWindow(); void shell.openExternal('https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues'); } },
      { type: 'separator' },
      { label: '退出', click: () => { state.forceQuit = true; app.quit(); } },
    ]);
    state.tray.setContextMenu(menu);
    state.tray.on('click', () => {
      if (state.mainWindow && state.mainWindow.isVisible()) state.mainWindow.hide();
      else showMainWindow();
    });
    state.tray.on('double-click', () => showMainWindow());
    log('boot', '系统托盘已就绪');
  } catch (err) {
    log('boot', '创建系统托盘失败: ' + String((err as Error).message));
  }
}

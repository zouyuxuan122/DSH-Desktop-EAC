/**
 * lib/ipc/sender.ts — IPC 来源校验（Task 4 提取）。
 *
 * H 系列安全边界：所有敏感 handler 只接受「主窗 webContents」的调用；
 * 向导 handler 只接受向导窗口。集中一个判定函数，杜绝各 handler 自写
 * 校验时的口径漂移。
 */

import type { IpcMainInvokeEvent, IpcMainEvent } from 'electron';
import { state } from '../state.js';

/** 事件来源是否为主窗 webContents。 */
export function fromMainWindow(
  event: IpcMainInvokeEvent | IpcMainEvent,
): boolean {
  return !!state.mainWindow && event.sender === state.mainWindow.webContents;
}

/** 事件来源是否为内置插件选择向导窗口。 */
export function fromWizardWindow(
  event: IpcMainInvokeEvent | IpcMainEvent,
): boolean {
  return !!state.wizardWindow && event.sender === state.wizardWindow.webContents;
}

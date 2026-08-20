/**
 * lib/ipc/index.ts — IPC 注册总入口（Task 4）。
 *
 * 按域拆分：app（外壳/菜单）/ recovery（恢复页/心跳/诊断导出）/ plugin
 * （保护中心/管理/更新/图片粘贴）/ onboard（选择向导）/ session（浮窗/
 * 余额/文件）。channel 名与行为与拆分前的 registerChromeIpc 一一对齐；
 * main.js 改调 registerIpc()。
 */

import { registerAppIpc } from './app.js';
import { registerRecoveryIpc } from './recovery.js';
import { registerPluginIpc } from './plugin.js';
import { registerOnboardIpc } from './onboard.js';
import { registerSessionIpc } from './session.js';

/** 注册全部 IPC handler（boot 链在 createWindow 之前调用一次）。 */
export function registerIpc(): void {
  registerAppIpc();
  registerRecoveryIpc();
  registerPluginIpc();
  registerOnboardIpc();
  registerSessionIpc();
}

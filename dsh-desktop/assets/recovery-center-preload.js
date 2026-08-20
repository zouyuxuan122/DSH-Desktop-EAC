/**
 * assets/recovery-center-preload.js — 恢复中心窗口的 contextBridge。
 *
 * 只暴露白名单动作（rc:action 单通道），不透出 ipcRenderer 原始对象。
 * 独立于主 preload（恢复中心不依赖 Web UI，见 vnext 架构文档 §3.4）。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rc', {
  /** 统一动作入口：{ action, value } → 结果对象。 */
  action: (action, value) => ipcRenderer.invoke('rc:action', { action, value }),
  /** 窗口自关闭。 */
  close: () => ipcRenderer.send('rc:close'),
});

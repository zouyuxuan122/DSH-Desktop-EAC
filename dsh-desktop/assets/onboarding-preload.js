'use strict';

// 内置插件选择向导 — sandbox-safe preload（仅暴露最小桥）。
//
//   window.onboarding.list()    → { mode, catalog, current }
//   window.onboarding.submit(ids) → { ok, applied, errors }（主进程随后关窗）
//   window.onboarding.close()   → 取消（跳过），主进程走 cancelled 分支

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onboarding', {
  list: () => ipcRenderer.invoke('onboard:list'),
  submit: (ids) => ipcRenderer.invoke('onboard:submit', { ids }),
  close: () => ipcRenderer.send('onboard:close'),
});

window.addEventListener('error', (e) => {
  try { ipcRenderer.send('dsh:page-error', 'onboarding window.onerror: ' + ((e && (e.message || e.error)) || 'unknown')); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { ipcRenderer.send('dsh:page-error', 'onboarding unhandledrejection: ' + String((e && e.reason && (e.reason.message || e.reason)) || e)); } catch {}
});
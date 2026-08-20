/**
 * preload.ts — frameless window chrome + IPC bridge 薄壳（Task 6.4）。
 *
 * 实现已按单一职责拆入 preload/：
 *   api.ts     contextBridge 桥接面（window.dshDesktop，API 面与拆分前
 *              逐项一致）+ 浮窗标记 + 异常上报 + 余额转发 + 渲染心跳
 *   chrome.ts  自绘窗口栏（主窗 36px 玻璃条 / 浮窗 24px 拖拽条）与菜单
 *
 * 本文件（编译产物 preload.js，窗口 webPreferences 的既有路径）只做装配：
 * 暴露桥接 → DOM ready 后注入 chrome。
 */

import { exposeBridge, FLOAT_MODE } from './preload/api.js';
import { injectChrome } from './preload/chrome.js';

const api = exposeBridge();
const floatMode = FLOAT_MODE;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => injectChrome(api, floatMode));
} else {
  injectChrome(api, floatMode);
}

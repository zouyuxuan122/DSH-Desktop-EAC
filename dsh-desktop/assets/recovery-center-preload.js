/**
 * assets/recovery-center-preload.js — 恢复中心窗口的 Tauri init script。
 *
 * 重构版为 Electron contextBridge；本地 Tauri 架构下该脚本由 Rust 壳作为
 * 恢复中心窗口的 initialization_script 注入（见 main.rs recovery_center_page），
 * 走既有 WS JSON-RPC 桥（127.0.0.1:19873，与主窗 bridge.js 同协议）调用
 * sidecar 的 `rc.action` / `rc.close` 方法。只暴露白名单动作，不透出底层 socket。
 * 独立于主窗 bridge.js（恢复中心不依赖 Web UI，见 vnext 架构文档 §3.4）。
 *
 * WS 客户端由单源 assets/ws-jsonrpc-client.js 提供（Rust 壳先注入本文件），
 * 这里只做白名单动作接线。
 */
'use strict';
(function () {
  var rpc = window.__DSH_WS_RPC__({ timeoutMs: 60000 });
  // 恢复中心页面只消费这两个方法（assets/recovery-center.html）。
  window.rc = {
    /** 统一动作入口：{ action, value } → 结果对象。 */
    action: function (action, value) { return rpc.call('rc.action', { action: action, value: value }); },
    /** 窗口自关闭（sidecar rc.close → Rust 关窗）。 */
    close: function () { return rpc.call('rc.close', {}); },
  };
})();
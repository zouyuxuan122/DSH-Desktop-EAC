/**
 * client-updater.ts — 客户端自更新引擎门面（Task 6.1）。
 *
 * 实现已按单一职责拆入 lib/client-update/：
 *   net.ts       统一 HTTP 传输（electron.net / node https 双路径）
 *   release.ts   发布源查询 / release 规范化 / 资产选择 / 哈希来源
 *   download.ts  断点续传下载 / 分片拼接 / SHA-256 校验 / downloadRelease 编排
 *   apply.ts     apply-update.cmd 生成与 detached 启动
 *
 * 本文件保持「原模块路径」的门面（require('./client-updater.js') 的既有
 * 调用方零改动），导出面与拆分前的 module.exports 逐项一致。
 */

export * from './lib/client-update/index.js';

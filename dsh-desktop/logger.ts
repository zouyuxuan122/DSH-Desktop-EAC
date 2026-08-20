/**
 * logger.ts — 结构化日志器门面（Task 6.2）。
 *
 * 实现已按单一职责拆入 lib/logger/：
 *   redact.ts   PII 脱敏引擎（键名黑名单 / 前缀规则 / 值正则 / deepRedact /
 *               RedactTransform）
 *   rotate.ts   大小轮转写流（main.00..09，20MB×10）
 *   api.ts      pino 封装 + 双 trace-id + 诊断 zip 构建
 *
 * 本文件保持「原模块路径」的门面（require('./logger') 的既有调用方零改动），
 * 导出面与拆分前的 module.exports（含 _testExports）逐项一致。
 */

export * from './lib/logger/index.js';

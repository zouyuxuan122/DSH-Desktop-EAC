/**
 * plugin-guard.ts — 插件保护中心门面（Task 6.3）。
 *
 * 实现已按领域拆入 lib/plugin-guard/：
 *   ctx.ts       共享上下文（路径派生 / JSON 原子读写 / 链接安全操作）
 *   snapshot.ts  快照 / 回滚 / 最后良好标记
 *   scan.ts      静态体检（模块遮蔽 / patch 行 / junction 归属 / 木马扫描）
 *   heal.ts      修复执行器 / 事故报告 / 守护启动 / 启动失败归因
 *
 * 本文件保持「原模块路径」的门面：导出面（createGuard + GUARD_FILES）与
 * 拆分前的 module.exports 一致，既有调用方零改动。
 */

export { createGuard, GUARD_FILES, MAX_SNAPSHOTS } from './lib/plugin-guard/index.js';
export type {
  Finding,
  GuardDeps,
  GuardInstance,
  HealthReport,
  SnapshotMeta,
} from './lib/plugin-guard/index.js';

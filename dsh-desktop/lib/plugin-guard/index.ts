/**
 * lib/plugin-guard/index.ts — 插件保护中心装配出口（Task 6.3）。
 *
 * 融合社区三大保护插件并升华（跑在 Electron 主进程，快照/回滚发生在
 * 「无服务进程持锁」的重启间隙）：
 *   lxzy-7/dsh-plugin-guard          → 安装前快照 / 一键与自动回滚 / 守护启动 /
 *                                      事故报告（snapshot.ts + heal.ts）
 *   LX2000WASD/dsh-web-plugin-manager → 安装守卫（安装后验证 + 失败回滚）、
 *                                      健康检查入口（scan.ts）
 *   chenw275-wq/dsh-plugin-healthcheck → 静态体检（模块遮蔽 / patch 行 / 高危
 *                                      静态扫描），绝不执行插件代码（scan.ts）
 *
 * 门面契约：createGuard(opts) 返回实例的方法面与原 plugin-guard.js 完全一致。
 */

import { buildCtx, type GuardDeps } from './ctx.js';
import { createSnapshotDomain, type SnapshotDomain } from './snapshot.js';
import { createScanDomain, type ScanDomain } from './scan.js';
import { createHealDomain, type HealDomain } from './heal.js';
import type { Finding, HealthReport, SnapshotMeta } from './ctx.js';

/** guard 实例的完整方法面（与原 plugin-guard.js 的返回对象逐项一致）。 */
export type GuardInstance = SnapshotDomain & ScanDomain & HealDomain;

export { GUARD_FILES, MAX_SNAPSHOTS } from './ctx.js';
export type { Finding, GuardDeps, HealthReport, SnapshotMeta } from './ctx.js';

/** 创建插件保护中心实例（路径/日志依赖由调用方注入）。 */
export function createGuard(deps: GuardDeps): GuardInstance {
  const ctx = buildCtx(deps);
  const snapshotDomain = createSnapshotDomain(ctx);
  const scanDomain = createScanDomain(ctx);
  const healDomain = createHealDomain(ctx, scanDomain, snapshotDomain);
  return {
    ...snapshotDomain,
    ...scanDomain,
    ...healDomain,
  };
}

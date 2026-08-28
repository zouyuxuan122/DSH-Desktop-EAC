'use strict';

// 插件保护中心入口（ADR 0002 L2 业务服务层；Wave 1 自 guard-box.js 类型化迁出）：
// 快照 / 回滚 / 静态体检 / 自动修复 / 守护启动 / 事故报告。
// 实例延迟创建（依赖 dshHome 与 settings 就绪）。

// CJS 直译导入：emit 结果与手写 require 逐行一致，避免 importStar 样板。
import path = require('node:path');
import os = require('node:os');

// plugin-guard.js 尚未类型化（Wave 3 收编），先以窄签名消费；届时改为
// import { createGuard } 的具名导入并获得真实返回类型。
const { createGuard } = require('../../plugin-guard') as {
  createGuard: (opts: GuardDeps) => GuardInstance;
};

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface GuardBoxCtx {
  log(tag: string, msg: string): void;
  getDshHome(): string | null;
  getDesktopProfile(): string;
  getDshBin(): string;
}

interface GuardDeps {
  getHome(): string;
  getProfile(): string;
  dshBin(): string;
  log(tag: string, msg: string): void;
}

/** 保护中心快照档案（对应 plugin-guard 的 meta.json 形态）。 */
export interface GuardSnapshot {
  id: string;
  reason: string;
  at: string;
  files: string[];
  pluginRows: string[];
}

/** 保护中心实例的已消费面（vnext-absorb：恢复中心补全快照/回滚/事故读取）。 */
export interface GuardInstance {
  snapshot(label: string): GuardSnapshot | null;
  listSnapshots(): GuardSnapshot[];
  restore(id: string): { ok: boolean; restored?: string[]; error?: string };
  lastGoodSnapshot(): GuardSnapshot | null;
  listIncidents(): { id: string; title: string }[];
  junctionFindings(): unknown[];
  repairJunctions(): { repaired: string[] };
}

let ctx!: GuardBoxCtx;

export function init(d: GuardBoxCtx): void {
  ctx = d;
}

let guardInstance: GuardInstance | null = null;

export function ensureGuard(): GuardInstance {
  if (!guardInstance) {
    guardInstance = createGuard({
      getHome: () => ctx.getDshHome() || path.join(os.homedir(), '.dsh'),
      getProfile: () => ctx.getDesktopProfile(),
      dshBin: () => ctx.getDshBin(),
      log: ctx.log,
    });
  }
  return guardInstance;
}

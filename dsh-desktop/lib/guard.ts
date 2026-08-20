/**
 * lib/guard.ts — 插件保护中心实例装配（Task 5b 自 main.js 提取）。
 *
 * plugin-guard.js：快照 / 回滚 / 静态体检 / 自动修复 / 守护启动 / 事故报告。
 * 实例延迟创建（依赖 dshHome 与 settings 就绪），缓存在 state.guardInstance。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { createGuard } from '../plugin-guard.js';
import { state } from './state.js';
import { log } from './log.js';
import { desktopProfile } from './paths.js';
import { dshBin } from './proc.js';

/** 获取（或延迟创建）插件保护中心单例。 */
export function ensureGuard(): ReturnType<typeof createGuard> {
  if (!state.guardInstance) {
    state.guardInstance = createGuard({
      getHome: () => state.dshHome || path.join(os.homedir(), '.dsh'),
      getProfile: () => desktopProfile(),
      dshBin: () => dshBin(),
      log,
    });
  }
  return state.guardInstance as ReturnType<typeof createGuard>;
}

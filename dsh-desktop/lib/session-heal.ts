/**
 * lib/session-heal.ts — V4 运行时补丁装配（Task 5.3 自 main.js 提取）。
 *
 * 覆盖三处运行副本：profile 共享 junction 根、内置 app 副本、用户更新过的
 * agent overlay。agent 更新会换掉 overlay 整树，补丁随 syncCompanionPlugins
 * 每次启动重放（幂等）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { patchSessionManage } from '../scripts/patch-session-manage.js';
import { state } from './state.js';
import { log } from './log.js';

/** 三个运行副本的 node_modules 根（补丁落点）。 */
export function runtimePatchRoots(): string[] {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  return [
    path.join(home, 'profiles', 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
    path.join(state.userDataDir, 'agent', 'node_modules'),
  ];
}

// 对话删除 / 归档管理（dsh-session-manager 插件的前置依赖）：
// dsh-workspace + dsh-host-apiproxy + dsh-session + dsh-client-connection +
// dsh-client-ui-workspace 的外科手术式扩展（详见 scripts/patch-session-manage.js
// 头注释）。锚点不匹配（官方包结构变化）时自动跳过，绝不损坏文件。
export function applySessionManageFix(): void {
  for (const root of runtimePatchRoots()) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      const n = patchSessionManage(root, (m) => log('boot', m));
      if (n > 0) log('boot', '对话删除补丁: 已应用到 ' + root);
    } catch (err) {
      log('boot', '对话删除补丁失败(' + root + '): ' + String((err as Error).message));
    }
  }
}

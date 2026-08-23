'use strict';

// V4 运行时补丁（ADR 0002 L2 业务服务层，幂等；Wave 1 自 runtime-patches.js
// 类型化迁出，行为零变更）：覆盖三处运行副本 —— profile 共享 junction 根、
// 内置 app 副本（__dirname/node_modules）、用户更新过的 agent overlay
// （<userData>/agent/node_modules）。agent 更新会换掉 overlay 整树，
// 补丁随 syncCompanionPlugins 每次启动重放。

import path = require('node:path');
import os = require('node:os');
import fs = require('node:fs');
import { APP_ROOT } from './runtime-paths';
// scripts/patch-session-manage.js 尚未类型化（工具链脚本，暂不收编）。
const { patchSessionManage } = require('../../scripts/patch-session-manage') as {
  patchSessionManage(root: string, log: (m: string) => void): number;
};

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface RuntimePatchesCtx {
  log(tag: string, msg: string): void;
  getDshHome(): string | null;
  getUserDataDir(): string;
}

let ctx!: RuntimePatchesCtx;
export function init(d: RuntimePatchesCtx): void { ctx = d; }

export function runtimePatchRoots(): string[] {
  const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
  return [
    path.join(home, 'profiles', 'node_modules'),
    path.join(APP_ROOT, 'node_modules'),
    path.join(ctx.getUserDataDir(), 'agent', 'node_modules'),
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
      const n = patchSessionManage(root, (m) => ctx.log('boot', m));
      if (n > 0) ctx.log('boot', '对话删除补丁: 已应用到 ' + root);
    } catch (err) {
      ctx.log('boot', '对话删除补丁失败(' + root + '): ' + (err as Error).message);
    }
  }
}

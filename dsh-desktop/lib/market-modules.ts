/**
 * lib/market-modules.ts — 插件市场 ESM 模块惰性加载器（Task 2 自 main.js 提取）。
 *
 * artifact-keep / allow-builds 两个 ESM 随市场插件（dsh-webui-market）分发，
 * 被 server 域（守护启动 preRetry）与 plugins 域（排队任务）共用，故独立
 * 成模块。加载结果缓存在 state（artifactKeepMod / allowBuildsMod），失败
 * 降级为空对象（调用方自行判空）。
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { state } from './state.js';
import { log } from './log.js';

const ARTIFACT_KEEP_MODULE = path.join(
  __dirname, '..', 'assets', 'plugins', 'dsh-webui-market', 'lib', 'artifact-keep.mjs',
);

const ALLOW_BUILDS_MODULE = path.join(
  __dirname, '..', 'assets', 'plugins', 'dsh-webui-market', 'lib', 'allow-builds.mjs',
);

/** 惰性加载市场插件的 artifact-keep ESM（失败降级空对象并缓存）。 */
export async function artifactKeep(): Promise<Record<string, unknown>> {
  if (state.artifactKeepMod) return state.artifactKeepMod;
  try {
    state.artifactKeepMod = (await import(pathToFileURL(ARTIFACT_KEEP_MODULE).href)) as Record<string, unknown>;
  } catch (err) {
    log('artifact-keep', '模块加载失败: ' + String((err as Error).message));
    state.artifactKeepMod = {};
  }
  return state.artifactKeepMod;
}

/** 惰性加载市场插件的 allow-builds ESM（失败降级空对象并缓存）。 */
export async function allowBuilds(): Promise<Record<string, unknown>> {
  if (state.allowBuildsMod) return state.allowBuildsMod;
  try {
    state.allowBuildsMod = (await import(pathToFileURL(ALLOW_BUILDS_MODULE).href)) as Record<string, unknown>;
  } catch (err) {
    log('allow-builds', '模块加载失败: ' + String((err as Error).message));
    state.allowBuildsMod = {};
  }
  return state.allowBuildsMod;
}

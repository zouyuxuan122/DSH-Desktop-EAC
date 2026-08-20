/**
 * lib/client-update/index.ts — 客户端自更新引擎的模块汇总出口（Task 6.1）。
 *
 * 门面契约：本模块导出面与原 client-updater.js 的 module.exports 逐项
 * 一致（17 个名字），client-updater.ts（编译产物 client-updater.js）只做
 * 再导出 —— 全部既有调用方（lib/update-flow.ts / lib/tray.ts / 7 个测试
 * 文件）零改动。
 */

export { getResponse, httpGetJson, isNoSpaceError, noSpaceError, headerValue } from './net.js';
export {
  DEFAULT_REPOS,
  MIN_VALID_BYTES,
  apiEndpoints,
  checkLatest,
  expectedSha256,
  fetchSumsMap,
  isPortable,
  normalizeRelease,
  releaseFallbacks,
  resolveRepos,
  selectAsset,
} from './release.js';
export {
  computeSha256,
  concatFiles,
  downloadFile,
  downloadRelease,
  downloadWithSourceSwitch,
} from './download.js';
export { applyUpdate, buildApplyScript, buildSpawnCommandLine } from './apply.js';
export type { ApplyScriptParams, ApplyUpdateOpts } from './apply.js';
export type {
  ApiEndpoint,
  AssetSelection,
  ClientUpdCtx,
  DownloadResult,
  NormalizedRelease,
  ReleaseAsset,
  ReleaseDownloadResult,
} from './types.js';

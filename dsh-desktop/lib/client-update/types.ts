/**
 * lib/client-update/types.ts — 客户端自更新的共享类型（Task 6.1 自
 * client-updater.js 提取）。
 *
 * ClientUpdCtx 即 lib/proc.ts 的 updCtx()（调用方注入 userDataDir 与日志
 * 通道；nodeExe/npmCli 字段对 agent 更新器有意义，客户端更新只消费
 * userDataDir 与 log，保留完整形状以共用同一 ctx 工厂）。
 */

/** 调用方注入的上下文。 */
export interface ClientUpdCtx {
  userDataDir: string;
  nodeExe(): string;
  npmCli(): string;
  log(tag: string, msg: string): void;
}

/** 规范化后的 release 资产条目。 */
export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** GitHub API digest 字段解析出的内容哈希（小写 hex，可选）。 */
  sha256?: string;
}

/** 规范化后的 release 描述（checkLatest / releaseFallbacks 的产物）。 */
export interface NormalizedRelease {
  source: string;
  version: string;
  name: string | null;
  body: string;
  htmlUrl: string | null;
  assets: ReleaseAsset[];
  /** checkLatest 附加：是否比当前版本新。 */
  isNewer?: boolean;
}

/** selectAsset 的选择结果（直连单资产或分片序列）。 */
export interface AssetSelection {
  parts: ReleaseAsset[];
  name: string;
  totalSize: number;
}

/** 单文件下载结果。 */
export interface DownloadResult {
  path: string;
  size: number;
}

/** downloadRelease 的完整结果。 */
export interface ReleaseDownloadResult {
  filePath: string;
  size: number;
  sha256Verified: boolean;
}

/** 上游 API 端点描述（GitHub / Gitee / 自定义镜像）。 */
export interface ApiEndpoint {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** getResponse 的统一响应形状（electron.net 与 node https 双路径归一）。 */
export interface HttpResponse {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  stream: NodeJS.ReadableStream & { resume(): void; setEncoding?(enc: string): void; destroy?(err?: Error): void };
}

export interface Settings {
  instanceRoot: string;
  mirrorPrefix: string;
  npmRegistry: string;
  confirmDelete: boolean;
  theme: "dark" | "light";
  reduceMotion: boolean;
  onboarded: boolean;
}

export type InstanceStatus = "installing" | "ready" | "error";

export interface QuarantinedPlugin {
  name: string;
  id: string;
  version: string;
  spec: string;
  reason: string;
  at: number;
}

export interface InstanceMeta {
  id: string;
  name: string;
  edition: "full" | "lite";
  version: string;
  tag: string;
  dir: string;
  appDir: string;
  dshHome: string;
  exePath: string | null;
  status: InstanceStatus;
  errorMessage: string | null;
  createdAt: number;
  lastLaunchedAt: number | null;
  launchCount: number;
  lastPid: number | null;
  lastGoodBundles?: string[];
  /** download = 启动器安装；imported = 本地导入（删除仅移除记录） */
  origin?: string;
  failStreak?: number;
  lastFailReason?: string | null;
  updateAvailable?: string | null;
  quarantine?: QuarantinedPlugin[];
}

export interface Config {
  settings: Settings;
  instances: InstanceMeta[];
}

export interface TaskInfo {
  id: string;
  kind: "instance" | "plugin";
  label: string;
  state: "active" | "done" | "error" | "cancelled";
  received: number;
  total: number;
  speedBps: number;
  message: string;
  instanceId: string | null;
  stage: string;
}

export interface EditionAsset {
  name: string;
  size: number;
  url: string;
}

export interface EditionInfo {
  edition: "full" | "lite";
  label: string;
  tag: string;
  releaseName: string;
  publishedAt: string;
  bodyExcerpt: string;
  asset: EditionAsset;
  shaUrl: string | null;
}

export interface MarketPlugin {
  id: string;
  name: string;
  descZh: string;
  descEn: string;
  supportVersions: string;
  homepage: string;
  repository: string;
}

export interface InstalledPlugin {
  name: string;
  id: string;
  version: string;
  isBundle: boolean;
  disabled: boolean;
  isCore: boolean;
}

export interface DoctorCheck {
  id: string;
  title: string;
  level: "ok" | "warn" | "err";
  detail: string;
  fix: string | null;
}

export interface PluginSnapshot {
  ts: number;
  reason: string;
  deps: number;
}

export interface ImportProbe {
  ok: boolean;
  reason: string;
  dir: string;
  exe: string | null;
  edition: string;
  version: string;
  suggestedName: string;
  dshHomeExists: boolean;
}

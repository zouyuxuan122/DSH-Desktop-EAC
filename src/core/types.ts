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

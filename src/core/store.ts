// 极简全局状态：单对象 + 订阅集合。视图按需重渲染。

import type {
  Config,
  EditionInfo,
  InstanceMeta,
  MarketPlugin,
  Settings,
  TaskInfo,
} from "./types";

export type ViewId = "home" | "safety" | "market" | "tasks" | "settings";

export interface AppState {
  view: ViewId;
  settings: Settings | null;
  instances: InstanceMeta[];
  running: Record<string, boolean>;
  tasks: TaskInfo[];
  editions: EditionInfo[];
  editionsState: "idle" | "loading" | "ok" | "error";
  editionsError: string;
  market: MarketPlugin[];
  marketState: "idle" | "loading" | "ok" | "error";
  marketError: string;
  drawerId: string | null;
  drawerTab: "overview" | "plugins";
  wizardOpen: boolean;
  sizeCache: Record<string, number>;
}

export const state: AppState = {
  view: "home",
  settings: null,
  instances: [],
  running: {},
  tasks: [],
  editions: [],
  editionsState: "idle",
  editionsError: "",
  market: [],
  marketState: "idle",
  marketError: "",
  drawerId: null,
  drawerTab: "overview",
  wizardOpen: false,
  sizeCache: {},
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  for (const l of [...listeners]) l();
}

/** 应用初始配置 */
export function hydrate(cfg: Config): void {
  setState({ settings: cfg.settings, instances: cfg.instances });
}

/** 任务事件：upsert 到列表头部 */
export function upsertTask(t: TaskInfo): void {
  const rest = state.tasks.filter((x) => x.id !== t.id);
  setState({ tasks: [t, ...rest] });
}

export function instanceById(id: string): InstanceMeta | undefined {
  return state.instances.find((i) => i.id === id);
}

/** 聚合下载速率（驱动脉冲线） */
export function aggSpeed(): number {
  return state.tasks
    .filter((t) => t.state === "active")
    .reduce((s, t) => s + t.speedBps, 0);
}

export function runningCount(): number {
  return Object.values(state.running).filter(Boolean).length;
}

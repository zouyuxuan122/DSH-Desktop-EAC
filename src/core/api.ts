// 后端命令封装 + 事件订阅 + 系统对话框/打开器。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  Config,
  EditionInfo,
  InstalledPlugin,
  InstanceMeta,
  MarketPlugin,
  Settings,
  TaskInfo,
} from "./types";

export const api = {
  getState: () => invoke<Config>("get_state"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  resolveEditions: () => invoke<EditionInfo[]>("resolve_editions"),
  createInstance: (name: string, edition: string, info: EditionInfo) =>
    invoke<InstanceMeta>("create_instance", { name, edition, info }),
  retryInstanceInstall: (id: string) => invoke<void>("retry_instance_install", { id }),
  getTasks: () => invoke<TaskInfo[]>("get_tasks"),
  cancelTask: (id: string) => invoke<void>("cancel_task", { id }),
  clearTask: (id: string) => invoke<void>("clear_task", { id }),
  launchInstance: (id: string) => invoke<number>("launch_instance", { id }),
  stopInstance: (id: string) => invoke<void>("stop_instance", { id }),
  isInstanceRunning: (id: string) => invoke<boolean>("is_instance_running", { id }),
  deleteInstance: (id: string) => invoke<void>("delete_instance", { id }),
  renameInstance: (id: string, name: string) =>
    invoke<void>("rename_instance", { id, name }),
  instanceSize: (id: string) => invoke<number>("instance_size", { id }),
  listPlugins: (id: string) => invoke<InstalledPlugin[]>("list_plugins", { id }),
  fetchMarket: (force = false) => invoke<MarketPlugin[]>("fetch_market", { force }),
  installPlugin: (id: string, spec: string) =>
    invoke<string>("install_plugin", { id, spec }),
  uninstallPlugin: (id: string, pkg: string) =>
    invoke<string>("uninstall_plugin", { id, pkg }),
  togglePlugin: (id: string, pkg: string, disabled: boolean) =>
    invoke<void>("toggle_plugin", { id, pkg, disabled }),
  appDirs: () => invoke<{ dataDir: string; cacheDir: string }>("app_dirs"),
};

export const sys = {
  pickFolder: async (title: string, start: string): Promise<string | null> => {
    const r = await dialogOpen({ directory: true, title, defaultPath: start });
    return typeof r === "string" ? r : null;
  },
  openPath: (p: string) => openPath(p),
  reveal: (p: string) => revealItemInDir(p),
};

export function onTaskUpdate(fn: (t: TaskInfo) => void): Promise<() => void> {
  return listen<TaskInfo>("task:update", (e) => fn(e.payload));
}

export function onInstanceEvent(
  name: "instance:ready" | "instance:error",
  fn: (id: string) => void,
): Promise<() => void> {
  return listen<string>(name, (e) => fn(e.payload));
}

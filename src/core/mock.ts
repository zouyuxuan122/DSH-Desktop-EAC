// 浏览器演示模式：无 Tauri 环境时挂载 IPC 桩，便于纯浏览器预览与视觉回归。
// 生产构建中 window.__TAURI_INTERNALS__ 恒存在，此模块不会生效。

import type { Config, EditionInfo, TaskInfo } from "./types";

type CmdHandler = (args: Record<string, unknown>) => unknown;

const FULL: EditionInfo = {
  edition: "full",
  label: "完整版 · 全功能桌面客户端",
  tag: "v5.1.0",
  releaseName: "v5.1.0",
  publishedAt: "2026-08-25T09:11:59Z",
  bodyExcerpt: "v5.1.0",
  asset: { name: "Deepseek-Harness-EAC-5.1.0-portable.zip", size: 221457327, url: "" },
  shaUrl: null,
};

const LITE: EditionInfo = {
  edition: "lite",
  label: "Lite · Tauri 轻量壳",
  tag: "v4.6-lite",
  releaseName: "DeepSeek Harness EAC v4.6.0 Lite（Windows x64 · Tauri）",
  publishedAt: "2026-08-24T14:16:15Z",
  bodyExcerpt: "v4.6-lite",
  asset: { name: "Deepseek.Harness.EAC.v4Lite_4.6.0_x64-setup.exe", size: 80111206, url: "" },
  shaUrl: null,
};

const demoConfig: Config = {
  settings: {
    instanceRoot: "D:\\eac-instances",
    mirrorPrefix: "",
    npmRegistry: "https://registry.npmmirror.com",
    confirmDelete: true,
    theme: "dark",
    reduceMotion: false,
    onboarded: true,
  },
  instances: [
    {
      id: "demo-lite",
      name: "轻量实例",
      edition: "lite",
      version: "4.6",
      tag: "v4.6-lite",
      dir: "D:\\eac-instances\\eac-instance-a1",
      appDir: "D:\\eac-instances\\eac-instance-a1\\app",
      dshHome: "D:\\eac-instances\\eac-instance-a1\\dsh-home",
      exePath: "D:\\eac-instances\\eac-instance-a1\\app\\Deepseek Harness EAC v4Lite.exe",
      status: "ready",
      errorMessage: null,
      createdAt: Date.now() - 86400_000 * 3,
      lastLaunchedAt: Date.now() - 3600_000 * 5,
      launchCount: 12,
      lastPid: null,
    },
    {
      id: "demo-full",
      name: "主力 · 完整版",
      edition: "full",
      version: "5.1.0",
      tag: "v5.1.0",
      dir: "D:\\eac-instances\\eac-instance-b2",
      appDir: "D:\\eac-instances\\eac-instance-b2\\app",
      dshHome: "D:\\eac-instances\\eac-instance-b2\\dsh-home",
      exePath: "D:\\eac-instances\\eac-instance-b2\\app\\dsh-eac-shell.exe",
      status: "ready",
      errorMessage: null,
      createdAt: Date.now() - 86400_000 * 9,
      lastLaunchedAt: Date.now() - 120_000,
      launchCount: 48,
      lastPid: 4242,
    },
    {
      id: "demo-beta",
      name: "试验场",
      edition: "full",
      version: "5.1.0",
      tag: "v5.1.0",
      dir: "D:\\eac-instances\\eac-instance-c3",
      appDir: "D:\\eac-instances\\eac-instance-c3\\app",
      dshHome: "D:\\eac-instances\\eac-instance-c3\\dsh-home",
      exePath: null,
      status: "error",
      errorMessage: "SHA256 校验失败：期望 bb00650b3df96433，实际 8f2c11a09e77d201（已删除损坏文件，可重试）",
      createdAt: Date.now() - 3600_000,
      lastLaunchedAt: null,
      launchCount: 0,
      lastPid: null,
    },
  ],
};

const demoTasks: TaskInfo[] = [
  {
    id: "demo-task-1",
    kind: "instance",
    label: "安装 试验场 · 5.1.0",
    state: "error",
    received: 148000000,
    total: 221457327,
    speedBps: 0,
    message: "SHA256 校验失败：期望 bb00650b3df96433，实际 8f2c11a09e77d201",
    instanceId: "demo-beta",
    stage: "verify",
  },
  {
    id: "demo-task-2",
    kind: "plugin",
    label: "安装 @dsh-plugin/dsh-loader",
    state: "done",
    received: 0,
    total: 0,
    speedBps: 0,
    message: "安装完成 · @dsh-plugin/dsh-loader@^1.3.3",
    instanceId: "demo-full",
    stage: "done",
  },
];

const market = [
  {
    id: "@dsh-plugin/dsh-approve-for-me",
    name: "DSH Approve For Me",
    descZh: "审查并自动批准命令执行，新增「替我同意」沙箱权限选项",
    descEn: "Reviews and auto-approves command execution",
    supportVersions: ">=0.1.0-rc.6",
    homepage: "",
    repository: "https://github.com/dsh-plugins/dsh-approve-for-me",
  },
  {
    id: "@dsh-plugin/dsh-auxiliary",
    name: "DSH Auxiliary",
    descZh: "DeepSeek Harness 辅助模型插件：为视觉理解、上下文压缩提供独立模型路由",
    descEn: "Auxiliary models for DeepSeek Harness",
    supportVersions: ">=0.1.0-rc.6",
    homepage: "",
    repository: "https://github.com/dsh-plugins/dsh-auxiliary",
  },
  {
    id: "@dsh-plugin/dsh-better-sidebar-loader",
    name: "DSH Better Sidebar Loader",
    descZh: "基于 dshloader 稳定 API 的 VSCode 风格右侧边栏（资源管理器 / 编辑器 / 终端 / Git / 浏览器）",
    descEn: "A VSCode-style right sidebar",
    supportVersions: ">=0.1.0-rc.6",
    homepage: "",
    repository: "https://github.com/dsh-plugins/dsh-better-sidebar-loader",
  },
  {
    id: "@dsh-plugin/dsh-code-review",
    name: "DSH Code Review",
    descZh: "逐轮代码变更摘要、审查标签页与受保护的撤销功能",
    descEn: "Codex-style code review sidebar",
    supportVersions: ">=0.1.0-rc.6",
    homepage: "",
    repository: "https://github.com/dsh-plugins/dsh-code-review",
  },
  {
    id: "@dsh-plugin/dsh-loader",
    name: "DSH Loader",
    descZh: "版本感知的运行时兼容层，让第三方插件在 dsh 升级后无需修改即可继续工作",
    descEn: "A version-aware adapter registry",
    supportVersions: ">=0.1.0-rc.1",
    homepage: "",
    repository: "https://github.com/dsh-plugins/dsh-loader",
  },
  {
    id: "@dsh-plugin/dsh-network-settings",
    name: "DSH Network Settings",
    descZh: "User-Agent 改写、HTTP/CONNECT/SOCKS5 代理与可配置请求自动重试，统一在「网络设置」标签页",
    descEn: "Network capabilities bundle",
    supportVersions: ">=0.1.0-rc.6",
    homepage: "",
    repository: "https://github.com/dsh-plugins/dsh-network-settings",
  },
  {
    id: "@dsh-plugin/dsh-thought-buddy",
    name: "DSH Thought Buddy",
    descZh: "在「Deep diving…」状态前插入动态小伙伴——GrokBot 风格动画头像，状态文字同步打字机变换",
    descEn: "A dynamic little buddy avatar",
    supportVersions: ">=0.1.0-rc.6",
    homepage: "",
    repository: "https://github.com/dsh-plugins/dsh-thought-buddy",
  },
];

const installed = [
  { name: "@dsh-plugin/dsh-loader", id: "dsh-loader", version: "1.3.3", isBundle: true, disabled: false, isCore: false },
  { name: "@dsh-plugin/dsh-code-review", id: "dsh-code-review", version: "0.8.1", isBundle: true, disabled: false, isCore: false },
  { name: "semver", id: "semver", version: "7.6.4", isBundle: false, disabled: true, isCore: false },
];

const handlers: Record<string, CmdHandler> = {
  get_state: () => demoConfig,
  set_settings: (a) => {
    demoConfig.settings = (a as { settings: Config["settings"] }).settings;
    return null;
  },
  resolve_editions: () => [FULL, LITE],
  create_instance: () => demoConfig.instances[0],
  retry_instance_install: () => null,
  get_tasks: () => demoTasks,
  cancel_task: () => null,
  clear_task: () => null,
  launch_instance: () => 4242,
  stop_instance: () => null,
  is_instance_running: () => false,
  delete_instance: () => null,
  rename_instance: () => null,
  instance_size: () => 441_000_000,
  list_plugins: () => installed,
  fetch_market: () => market,
  install_plugin: () => "plug-demo",
  uninstall_plugin: () => "plug-demo",
  toggle_plugin: () => null,
  app_dirs: () => ({ dataDir: "C:\\Users\\demo\\AppData\\Roaming\\dsh-eac-launcher", cacheDir: "C:\\Users\\demo\\AppData\\Roaming\\dsh-eac-launcher\\cache" }),
  "plugin:dialog|open": () => null,
  "plugin:event|listen": () => 1,
  "plugin:event|unlisten": () => null,
  "plugin:window|minimize": () => null,
  "plugin:window|toggle_maximize": () => null,
  "plugin:window|close": () => null,
  "plugin:window|show": () => null,
  "plugin:window|set_focus": () => null,
  "plugin:opener|open_path": () => null,
  "plugin:opener|reveal_item_in_dir": () => null,
};

export function installMock(): void {
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
    invoke: (cmd: string, args: Record<string, unknown> = {}) => {
      const handler = handlers[cmd];
      if (!handler) {
        return Promise.resolve(null);
      }
      return Promise.resolve(handler(args));
    },
    transformCallback: (cb: unknown) => cb,
  };
}

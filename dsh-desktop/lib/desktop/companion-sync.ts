'use strict';

// 配套 dsh 插件同步（ADR 0002 L2 业务服务层；Wave 2 收官自 companion-sync.js
// 类型化迁出，行为零变更）：注入 web profile：余额小部件 + 文件更改追踪/
// 还原 + 皮肤 + 内置插件治理。

import path = require('node:path');
import fs = require('node:fs');
import os = require('node:os');
import crypto = require('node:crypto');
import { updCtx, APP_ROOT } from './runtime-paths';
import { isLiteDisabled, readInstallProfile } from './install-profile';
import { desktopProfile, desktopProfileDir, ensureDesktopProfileInit, BUNDLED_BUILTIN_PLUGINS } from './profile';
import { ensureGuard } from './guard-box';
import { applySessionManageFix } from './runtime-patches';
import { pluginCapabilityDetails } from './platform';
import { writeFileAtomic } from '../atomic-json.js';
// 未类型化依赖（Wave 3 收编），先以窄签名消费。
const updater = require('../../updater') as {
  loadSettings(c: ReturnType<typeof updCtx>): { removedPlugins?: unknown };
  saveSettings(c: ReturnType<typeof updCtx>, s: unknown): void;
  compareVersions(a: string, b: string): number;
};
const pluginUpdater = require('../../plugin-updater') as {
  versionOfDir(dir: string): string | null;
};
const { healProfileModuleShadowing } = require('../../profile-module-heal') as {
  healProfileModuleShadowing(home: string, profile: string): string[];
};
const {
  configLinesFor,
  healSoulMdPatchRow,
  healRowConfig,
  removeBundledRowDuplicates,
  collectBundleEntryIds,
} = require('../../patch-row-heal') as {
  configLinesFor(config: unknown): string;
  healSoulMdPatchRow(patch: string): { healed: unknown[]; patch: string };
  healRowConfig(patch: string, id: string, config: unknown): { healed: unknown[]; patch: string };
  removeBundledRowDuplicates(patch: string, rowIds: Record<string, string>, bundled: unknown[], declared: Set<string>): { removed: string[]; patch: string };
  collectBundleEntryIds(bundled: unknown[], nodeModulesDir: string): Set<string>;
};
const { syncBundledPresets, ensureDefaultAgentPreset } = require('../../preset-sync') as {
  syncBundledPresets(src: string, dst: string, log: (m: string) => void): { installed: string[] };
  ensureDefaultAgentPreset(home: string, name: string, log: (m: string) => void): string;
};
const { migrateManagedCompactPresets } = require('../../compact-preset-migrate') as {
  migrateManagedCompactPresets(dir: string, log: (m: string) => void): { status: string; file: string }[];
};
const { migrateManagedRouterPersonaPresets } = require('../../router-persona-preset-migrate') as {
  migrateManagedRouterPersonaPresets(
    assetsDir: string,
    presetsDir: string,
    log: (m: string) => void,
  ): { status: string; file: string }[];
};
const { hasEntryId, removePluginFromPatch } = require('../../scripts/plugin-manager-patch') as {
  hasEntryId(patch: string, id: string): boolean;
  removePluginFromPatch(text: string, id: string): string;
};

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface CompanionSyncCtx {
  log(tag: string, msg: string): void;
  getDshHome(): string | null;
  getUserDataDir(): string;
  applyLegacySkinChoice(): void;
  showMainWindow(): void;
  notify(n: { title: string; body: string; icon?: string; onClick?: () => void }): void;
  platform?: NodeJS.Platform;
}

let ctx!: CompanionSyncCtx;
export function init(d: CompanionSyncCtx): void { ctx = d || ({} as CompanionSyncCtx); }

export interface CompanionPluginDef {
  id: string;
  name: string;
  dir?: string;
  disabled?: boolean;
  config?: unknown;
}

interface PendingRow {
  id: string;
  name: string;
  disabled: boolean;
  config?: unknown;
}

export const COMPANION_PLUGINS: CompanionPluginDef[] = [
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal' },
  // 统一插件市场（dsh-unified-market，内置）：聚合精选目录
  // （awesome-dsh-plugin.com）+ GitHub dsh-plugin 生态 + npm 检索三源；
  // EAC 特化（web-desktop profile），试装验证 + 冲突预检 + 后台自动更新 +
  // 自动更新排队与启动消费 + 市场自更新。取代曾被内置的 webui-market /
  // zat-market / 旧 npm 市场（各自 profile 定位错误或重复，已从清单移除）。
  { id: 'unified-market', name: 'dsh-unified-market', dir: 'dsh-unified-market' },
  { id: 'skin-switch', name: '@deepseek-ai/dsh-skin-switch' },
  { id: 'easy-setup', name: '@deepseek-ai/dsh-easy-setup' },
  // 旧版/社区客户端插件的英文兼容层：跟随官方 locale 状态翻译固定 UI
  // 文案，不触碰会话、代码、终端、编辑器或用户输入。作为界面底座始终启用。
  { id: 'eac-locale-compat', name: 'dsh-eac-locale-compat', dir: 'dsh-eac-locale-compat' },
  // VNext Core Bridge（受信组件，vnext-absorb Phase 2）：把隔离 SDK 插件的
  // 工具/上下文经回环端点桥接进 dsh Agent（DSH_EAC_BRIDGE_URL/TOKEN 由
  // sidecar 在拉起 dsh web 前注入）；必须随包分发并默认启用。
  { id: 'eac-core-bridge', name: 'dsh-eac-core-bridge', dir: 'dsh-eac-core-bridge' },
  // 社区功能插件（视觉 / 人设 / 长期记忆 / 移动端布局修复）：npm registry
  // 拉取后随应用内置分发。绝不能写进 profile package.json 依赖 ——
  // pnpm 安装会 hoist @deepseek-ai 核心包形成模块双实例（Symbol 冲突，
  // 插件命名空间注册失效，即 "设置命名空间不可用" 故障的根因）。
  { id: 'picturereader', name: 'picturereader', dir: 'picturereader' },
  // 读屏 + 鼠标键盘自动化（Codex-style computer use，配 picturereader；纯本地）。
  { id: 'computer-user', name: 'computer-user', dir: 'computer-user' },
  // config.path 必须随行写入：v2.0.0 只写了 id+name，而当时插件 schema 的
  // path 是 required 无默认值，全新安装校验失败拖垮整个插件树（dsh web
  // 退出码 1，应用持续闪退“启动失败”）。schema 现已带默认值，这里显式
  // 写 config 是双保险，healSoulMdPatchRow 另负责修复存量坏行。
  { id: 'soul-md', name: 'dsh-soul-md', dir: 'dsh-soul-md', config: { path: 'soul.md' } },
  { id: 'mobile-fix', name: 'dsh-web-mobile-fix', dir: 'dsh-web-mobile-fix' },
  // 视口钳制（文档级滚动根治）：html/body overflow:hidden + 稳定契约
  // （data-phase/data-conversation-scroll）hero 居中兜底。纯客户端 CSS，
  // 随内核页面加载 —— 桌面壳 / 浏览器 / 手机端三端同源生效，不再依赖
  // 桌面壳垫片与 CSS Modules 哈希类（内核更新换哈希即失效的旧方案）。
  { id: 'viewport-lock', name: 'dsh-viewport-lock', dir: 'dsh-viewport-lock' },
  // 喵丝滑（Phant0Meow/dsh-meow-smooth 0.5.0，MIT）：手机端 UI 交互优化
  // （输入框折叠/侧边栏手势/窄屏适配）+ 通知系统（页面卡片 / Web Push /
  // webhook）+ 审计投影只读路由。5.2 起取代自研 mobile-app.html 续聊客户端
  // —— 手机桥改为完整 Web UI 反向代理，手机直接获得真界面，本插件负责
  // 移动端体验。host 半边依赖 web-push（已加入 app 闭包 + 插件宿主依赖
  // 落位，缺省时优雅降级：仅系统推送不可用）。配置沿用上游出厂默认。
  { id: 'meow-smooth', name: 'meow-smooth', dir: 'dsh-meow-smooth', config: { enabled: true } },
  // VSCode 风格右侧边栏（文件树 / 编辑器 / 终端 / Git，按会话隔离）。
  // lib/ 预编译自包含（codemirror、xterm 已内嵌），服务端仅额外依赖
  // schemastery（已加入 app 闭包，见 package.json）。config 只随缺失的新行写入；
  // 已有 profile 行会在同步时跳过，保留升级用户的现有默认与自定义设置。
  { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar', config: { openByDefault: true } },
  // VCP 视觉通感协议（dsh-raw-html 0.6.1 EAC 托管版，源自 plolpl789，MIT）：消息 HTML 渲染
  // 为界面（卡片 / KaTeX / Mermaid / 内置 7 款 OFL 书法字体）。EAC 集成通过
  // conversation.chat.node 的 assistant-step slot 接管，不修改上游压缩 bundle。
  // bundle 插件：
  // 必须进 profile bundles（BUNDLED_BUILTIN_PLUGINS / DESKTOP_PROFILE_BUNDLES
  // 播种），overlay 行会被 removeBundledRowDuplicates 去重，不可写 patch 行。
  { id: 'dsh-raw-html', name: 'dsh-raw-html', dir: 'dsh-raw-html' },
  // Trae 风格对话回退：用户消息 hover 出「编辑并回退」，按上一完整回合
  // 分叉新会话（sessions.fork）并以编辑后内容重发（inputActions）。
  // 纯客户端实现，host 半边为 no-op。
  { id: 'message-rewind', name: 'dsh-message-rewind', dir: 'dsh-message-rewind' },
  // 页面桌宠（npm: dsh-pet 0.1.3）：28 个透明动画的悬浮宠物，即装即用。
  // assets/ 15MB 播放资源随包分发；peer 依赖全部由 dsh 宿主提供。
  // V4 关键修复：行必须带 config —— dsh-pet 的 apply 读 config.fullRoot，
  // 无 config 块的行会让 loader 传 undefined 直接拖垮插件树（v3.1.0 全新
  // 安装即「启动失败」的根因之一；老用户因市场装过的行带 config 才幸免）。
  // 值沿用包内 cordis.patch.yml 的出厂默认。
  // 默认禁用 —— 需要页面桌宠时在「设置 → 插件 → 管理」或「桌宠」分区开启。
  { id: 'dsh-pet', name: 'dsh-pet', dir: 'dsh-pet', config: { size: 260, position: 'bottom-right' }, disabled: true },
  // 设置页「Skills 与 MCP」分区：Skills 目录浏览（来源徽标/打开目录）+
  // MCP 服务增删改（读写 profile patch 中的 dsh-mcp-client 行）+ 从
  // Claude Code / Codex 一键导入 MCP 配置。
  { id: 'dock-settings', name: 'dsh-dock-settings', dir: 'dsh-dock-settings' },
  // 外观自定义：字体家族/字号/文字与代码颜色的设置页分区，实时预览，
  // localStorage 持久化（纯客户端，无宿主半边）。
  { id: 'font-custom', name: 'dsh-font-custom', dir: 'dsh-font-custom' },
  // 请求路径自动压缩：在模型请求前按真实 Token 压力调用 DSH 原生压缩
  // 引擎；上下文溢出时最多压缩并重试原请求一次，不再模拟输入 /compact。
  { id: 'compact', name: 'dsh-compact', dir: 'dsh-compact' },
  // 插件保护中心 UI：快照列表/一键回滚/健康检查/事故报告，经桌面壳
  // IPC（guard:action）驱动 plugin-guard.js 引擎。
  { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
  // AI 变更审核（V4，用户建议⑤）：监控官方 fileChanges 投影，手动/自动向
  // 当前对话发送审核请求，让模型复查自己刚做的改动（正确性/安全性/一致
  // 性），结论配合「文件」页一键还原。纯客户端实现，host 半边 no-op。
  { id: 'change-review', name: 'dsh-change-review', dir: 'dsh-change-review' },
  // —— V4 自上游 dsh_desktop（myYangyunfan）移植的配套插件 ——
  // 会话浮窗（多窗口分屏）：会话头部「弹出到独立窗口」按钮；窗口由壳层
  // IPC chrome:float-window / preload 的 __DSH_FLOAT__ 承载。
  { id: 'float-window', name: '@deepseek-ai/dsh-float-window' },
  // 对话节点导航条（vlln/dsh-navbar，MIT）：对话区右缘节点串快速跳转
  // user 消息（悬停预览/点击跳转/滚轮切换）。
  { id: 'dsh-navbar', name: '@vlln/dsh-navbar', dir: 'dsh-navbar' },
  // 对话删除与归档管理：会话行菜单「删除对话」+ 设置内归档管理面板。
  // 前置依赖 scripts/patch-session-manage.js 的官方包运行时补丁
  // （applySessionManageFix，随启动幂等应用、覆盖 agent overlay）。
  { id: 'dsh-session-manager', name: 'dsh-session-manager' },
  // 对话界面微调：隐藏大量工具调用/结果/思考输出（保留每轮最终总结）。
  { id: 'conversation-tweaks', name: '@deepseek-ai/dsh-conversation-tweaks' },
  // 自定义注入提示词：整体替换/追加官方 persona，应用到 standard 预设。
  { id: 'prompt-custom', name: '@deepseek-ai/dsh-prompt-custom' },
  // 侧边临时会话：浮窗追问、不写主会话、多种回答引擎（Ctrl+Shift+S）。
  { id: 'side-session', name: '@dsh-external/dsh-side-session', dir: 'dsh-side-session' },
  // 手机连接（5.2 方案）：LAN 扫码配对 + 完整 Web UI 反向代理（设置页「连接手机」）。
  // 桥本体在 Tauri 壳 sidecar（phone-bridge.js）；手机端体验由内置喵丝滑
  // （meow-smooth）提供，自研 mobile-app.html 续聊客户端已退役。
  { id: 'dsh-phone', name: 'dsh-phone', dir: 'dsh-phone' },
  // 新增强化功能入口分区（5.1.0 批次）：设置页「增强功能」——为默认关闭的
  // 内置插件（余额小鲸鱼 / AgentTeams 等）提供一键启用/停用开关。
  { id: 'dsh-feature-toggles', name: 'dsh-feature-toggles', dir: 'dsh-feature-toggles' },
  // DeepSeek 余额小鲸鱼挂件（MeteorNOX/DeepSeek-Balance-Whale-Widget，MIT）。
  // 默认关闭：用户到「设置 → 插件 → 管理」或「增强功能」分区自行启用（需 DEEPSEEK_API_KEY 凭据）。
  { id: 'dsh-whale-widget', name: 'dsh-whale-widget', dir: 'dsh-whale-widget', disabled: true },
  // 多智能体团队协作（NanmiCoder/dsh-agent-teams，MIT）：队长 + 子代理成员 +
  // 依赖感知任务 DAG + 活动面板。5.3.1 起默认启用（EAC 适配版；对话框
  // composer dock 有可见入口，设置「增强功能」分区保留停用开关）。
  { id: 'agent-teams', name: '@nanmicoder/dsh-agent-teams', dir: 'dsh-agent-teams' },
  // 输入灵动岛（says693/dsh-composer-dynamic-island 2.1.0，MIT）：把输入区
  // 选定按钮收纳为向上展开的紧凑岛，不移动宿主 React 节点；仅在已确认的
  // composer surface 内发现控件，设置只持久化启用状态与控件标识。
  { id: 'composer-dynamic-island', name: 'dsh-composer-dynamic-island', dir: 'dsh-composer-dynamic-island' },
  // 插件启停管理：设置页「插件 → 管理」标签，不重启切换插件启停
  // （IPC dsh:plugin-list / dsh:plugin-set-enabled，见下方接线）。
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
  // 插件选择向导入口（设置页「插件 → 选择向导」分区）：重新打开首次启动的
  // 内置插件选择向导，按需启用/停用内置插件。纯客户端 UI + 壳层 IPC
  // （onboard:*），host 半边 no-op；核心插件组内锁定，永不被向导停用。
  { id: 'plugin-wizard', name: 'dsh-plugin-wizard', dir: 'dsh-plugin-wizard' },
  // 微信 ClawBot / OpenClaw 桥（openclaw-dsh-bridge v0.7.0，MIT）：设置页
  // 「ClawBot」栏（扫码绑定微信官方 ClawBot 小程序）+ OpenAI 兼容端点
  // （/openclaw-bridge/v1/chat/completions）。设置命名空间经 dsh-host-apiproxy
  // 的 settings.describe 全量暴露（rc.7+ 已移除 WEB_SETTINGS_NAMESPACES 白名单）。
  { id: 'openclaw-bridge', name: '@deepseek-ai/dsh-openclaw-bridge', dir: 'dsh-openclaw-bridge' },
  // 崩溃急救/撤销回退（dsh-undo-savepoint，lire1131，MIT）：配置文件 + 插件
  // 代码树快照、undo/redo、一键安全模式、密钥脱敏 vault。与插件保护中心
  // （配置面快照）和「文件」还原（会话内改动）互补，覆盖「配置改坏、dsh
  // 起不来」的急救场景。GitHub 分发锁定拷贝（npm 未发布）。
  { id: 'dsh-undo', name: 'dsh-undo-savepoint', dir: 'dsh-undo-savepoint' },
  // 大肥鱼桌宠（dsh-dafeiyu，QCYTSN；代码 MIT、角色素材按 ASSET_LICENSE.md
  // 随包分发保留署名）：真实会话状态驱动的原生置顶桌宠（空闲/思考/工作/
  // 等待/完成/错误 六态 + 项目状态卡）。默认开启 —— 可在「设置 → 插件 →
  // 管理」或「桌宠」分区关闭（含 49MB PyInstaller helper，按需运行）。
  { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu', dir: 'dsh-dafeiyu' },
  // 桌宠设置分区（V4.2，dsh-pet-settings）：设置页「桌宠」分区，集中管理
  // 页面桌宠（dsh-pet 开关，重启生效）与大肥鱼桌面伴侣（启用/角色大小/
  // 空闲微动作频率/减少动态，走 dsh-dafeiyu config 端点即时生效）。
  { id: 'dsh-pet-settings', name: 'dsh-pet-settings', dir: 'dsh-pet-settings' },
  // 峰谷价格卫士（dsh-offpeak，christophersmith2737-commits，MIT）：DeepSeek
  // 峰谷定价（2026-08-17 起）高峰时段（北京时间 9-12 / 14-18 点）在发送前
  // 拦截提醒，可一键继续或定时到闲时价自动执行（浏览器不在线也会到点
  // 执行）。与余额小部件互补（事前拦截 vs 事后显示）；程序化提交
  // （auto-compact / 变更审核 / 消息回退 / openclaw 桥）不被拦截。
  // 可在「设置 → 插件 → 管理」关闭。
  { id: 'offpeak', name: 'dsh-offpeak', dir: 'dsh-offpeak' },
  // 拖入文件/文件夹到对话（EAC 特化版，取代原 dsh-file-drop）：普通文件
  // 显示可预览、可移除的卡片，并保存临时副本后只注入紧凑路径引用；图片
  // 继续走官方缩略图链路，混合拖放拆分处理。纯客户端实现（host 半边 no-op）。
  // 独立发布：https://github.com/jing-hy/dsh-file-drop-eac（issue #141）。
  { id: 'file-drop-eac', name: 'dsh-file-drop-eac', dir: 'dsh-file-drop-eac' },
  // 设置页「常规」页内高级选项折叠（V4.2，用户建议）：按行标题关键词把
  // 低频选项行（外观/语言/权限预设等）收进底部「高级选项」折叠组，
  // localStorage 持久化展开状态；纯客户端实现（host 半边 no-op）。
  // V4.6.1 起侧边栏 display/order 由 nav-custom 单一写者接管，groups 只保留页内折叠。
  { id: 'settings-groups', name: 'dsh-settings-groups', dir: 'dsh-settings-groups' },
  // 设置面板滚轮修复：不绑定 CSS Modules 哈希类名，按设置页语义与真实
  // overflow 尺寸识别导航/内容滚动区；MutationObserver 跟随动态内容，卸载时
  // 完整清理样式、标记与监听器。纯客户端实现（host 半边 no-op）。
  { id: 'settings-scroll-fix', name: 'dsh-settings-scroll-fix', dir: 'dsh-settings-scroll-fix' },
  // 图片粘贴发送（V4.2，用户建议）：Ctrl/Cmd+V 粘贴剪贴板图片 → 保存到
  // 临时目录 → 注入完整路径提示（配合 inspect_image 视觉工具）；纯客户端
  // 实现（host 半边 no-op，仅用受控 IPC dsh:image-paste-save）。
  // 默认禁用 —— 与内置 picturereader 的「粘贴即用/图片桥自动分析」入口
  // 语义重叠，避免粘贴图片时重复/竞争注入。
  { id: 'image-paste', name: 'dsh-image-paste', dir: 'dsh-image-paste', disabled: true },
  // 提示词优化（dsh-webui-prompt-optimizer 0.1.0，提取自 statem-li/dsh-webui）：
  // 输入区右侧优化图标，用当前会话模型流式改写提示词；单轮写回草稿、
  // 多轮并行出「均衡/精简/详尽」三候选择优迭代，可包装 /goal。
  // 纯客户端 + host 半边（loopback 路由），peer 依赖全部由 dsh 宿主提供。
  { id: 'dsh-webui-prompt-optimizer', name: 'dsh-webui-prompt-optimizer', dir: 'dsh-webui-prompt-optimizer' },
];

export function companionPluginsForPlatform(platform: NodeJS.Platform = 'win32'): CompanionPluginDef[] {
  const capabilities = pluginCapabilityDetails(platform);
  return COMPANION_PLUGINS.filter((plugin) => capabilities[plugin.id]?.status !== 'unavailable');
}

// ---------------------------------------------------------------------------
// 私有维护插件（自动更新黑名单，SOURCES.json 台账驱动）：
//
// 台账 origin=eac-original 的 main 线插件由 EAC 私有维护（外部匹配审计的
// best-match 即 EAC 主仓库本体），没有可钉的外部上游发版——自动更新要么把
// EAC 适配冲掉，要么更新到无从校验的来源。黑名单在此生成，pluginUpdateSources
// 是唯一漏斗：即使将来误把私有插件登记进 PLUGIN_UPDATE_SOURCES 也会被强制
// 过滤（sidecar server.ts 的「检测」与「应用更新」两条路都经过它）。
// ---------------------------------------------------------------------------

let privateMaintainedCache: Set<string> | null = null;

/** 台账 origin=eac-original 的 main 线插件包名集合（自动更新黑名单）。
 *  读取失败从宽返回空集：台账缺失/损坏时不拦截任何既有更新源。 */
export function privateMaintainedPluginNames(): Set<string> {
  if (privateMaintainedCache) return privateMaintainedCache;
  const names = new Set<string>();
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'assets', 'SOURCES.json'), 'utf8')) as {
      components?: { line?: string; type?: string; origin?: string; name?: string }[];
    };
    for (const c of ledger.components || []) {
      if (c.line === 'main' && c.type === 'plugin' && c.origin === 'eac-original' && c.name) names.add(c.name);
    }
  } catch { /* 从宽处理 */ }
  privateMaintainedCache = names;
  return names;
}

// ---------------------------------------------------------------------------
// 内置插件上游更新源（V4.3，plugin-updater.js 消费）：
//
// 只登记「上游仍在 npm / GitHub 发布」的社区插件 —— 内置分发的副本可以
// 跟随上游修复而更新。EAC 独占插件（package.json 标记 private，如
// dsh-balance / dsh-terminal）绝不登记。
// 运行时 npm 404（未上架/改名）优雅降级为「无上游」，绝不阻塞。
// ---------------------------------------------------------------------------
export const PLUGIN_UPDATE_SOURCES: Record<string, { npm?: string; github?: string }> = {
  'picturereader': { npm: 'picturereader' },
  'computer-user': { npm: 'computer-user' },
  'soul-md': { npm: 'dsh-soul-md' },
  'dsh-pet': { npm: 'dsh-pet' },
  'better-sidebar': { npm: 'dsh-better-sidebar' },
  'dsh-navbar': { npm: '@vlln/dsh-navbar' },
  'mobile-fix': { npm: 'dsh-web-mobile-fix' },
  'offpeak': { npm: 'dsh-offpeak' },
  // 统一市场（unified-market）：npm 已发布，正式纳入官方内置插件更新。
  'unified-market': { npm: 'dsh-unified-market' },
  'dsh-session-manager': { npm: 'dsh-session-manager' },
  // GitHub 分发（npm 未发布）：dsh-undo-savepoint。
  'dsh-undo': { github: 'lire1131/dsh-undo-savepoint' },
  // dsh-raw-html 是 EAC 托管适配版，不登记上游更新源，避免被原版 bundle
  // 注入实现覆盖。上游升级必须先移植并通过 EAC slot 集成回归。
};

// ---------------------------------------------------------------------------
// 内置插件「移除」跳过清单（settings.removedPlugins）：被 plugin-ops 与
// syncCompanionPlugins 共用，故置于本模块（打破循环依赖）。
// ---------------------------------------------------------------------------

export function removedPluginIds(): Set<string> {
  try {
    const s = updater.loadSettings(updCtx());
    return new Set(Array.isArray(s.removedPlugins) ? s.removedPlugins as string[] : []);
  } catch { return new Set(); }
}

export function saveRemovedPluginIds(ids: Set<string>): void {
  const c = updCtx();
  const s = updater.loadSettings(c) as Record<string, unknown>;
  s.removedPlugins = Array.from(ids);
  updater.saveSettings(c, s);
}

/** 内置 bundle 插件播种（纯函数，可单测）：确保 profile package.json 的
 *  dsh.profile.bundles 包含 BUNDLED_BUILTIN_PLUGINS。幂等：缺失则追加并写回
 * （保持 JSON 缩进 2 + 尾换行，与 ensureDesktopProfileInit 出厂格式一致），
 * 已有（用户市场安装 / dsh plugin add / 曾经播种过）则不动。返回变化标记与
 * 播种后的 bundles 数组。失败不抛异常：返回 { changed: false, bundles: [] }。 */
export function seedBundledPlugins(profileDir: string): { changed: boolean; bundles: unknown[] } {
  let bundled: unknown[] = [];
  try {
    const pkgDsh = readJsonFile(path.join(profileDir, 'package.json'))?.dsh as Record<string, unknown> | undefined;
    const prof = pkgDsh?.profile as Record<string, unknown> | undefined;
    bundled = Array.isArray(prof?.bundles) ? prof.bundles : [];
  } catch { bundled = []; }
  const orig = bundled.slice();
  let changed = false;
  for (const bundleName of BUNDLED_BUILTIN_PLUGINS) {
    if (!bundled.includes(bundleName)) { bundled.push(bundleName); changed = true; }
  }
  if (changed) {
    try {
      const pkgFile = path.join(profileDir, 'package.json');
      const pkg = readJsonFile(pkgFile);
      if (pkg && typeof pkg === 'object') {
        const pkgRec = pkg as Record<string, unknown>;
        const dsh = (pkgRec.dsh || (pkgRec.dsh = {})) as Record<string, unknown>;
        const prof = (dsh.profile || (dsh.profile = {})) as Record<string, unknown>;
        prof.bundles = bundled;
        fs.writeFileSync(pkgFile, JSON.stringify(pkgRec, null, 2) + '\n');
      } else {
        changed = false;
        bundled = orig;
      }
    } catch {
      changed = false;
      bundled = orig;
    }
  }
  return { changed, bundles: bundled };
}

/** 把内置插件表 + 更新源注册表合并成 plugin-updater 的 sources 输入。
 *  私有维护插件（台账 eac-original）在此强制过滤——这是更新源的唯一漏斗。 */
export function pluginUpdateSources(): { id: string; name: string; assetsDir: string; update: { npm?: string; github?: string } }[] {
  const removed = removedPluginIds();
  const privateNames = privateMaintainedPluginNames();
  const blocked: string[] = [];
  const out: { id: string; name: string; assetsDir: string; update: { npm?: string; github?: string } }[] = [];
  for (const p of COMPANION_PLUGINS) {
    const update = PLUGIN_UPDATE_SOURCES[p.id];
    if (!update) continue;
    if (removed.has(p.id)) continue;
    if (privateNames.has(p.name)) { blocked.push(p.id); continue; }
    const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() as string : p.name);
    const assetsDir = path.join(APP_ROOT, 'assets', 'plugins', dirName);
    if (!fs.existsSync(path.join(assetsDir, 'package.json'))) continue;
    out.push({ id: p.id, name: p.name, assetsDir, update });
  }
  if (blocked.length) {
    console.warn('[plugin-update] 私有维护插件不参与自动更新，已从更新源过滤: ' + blocked.join(', '));
  }
  return out;
}

/** 内置插件当前生效的源目录：覆盖层（已更新版本）优先，资产版本回退。 */
export function builtinPluginSourceDir(dirName: string): string {
  const assets = path.join(APP_ROOT, 'assets', 'plugins', dirName);
  const overlay = path.join(ctx.getUserDataDir(), 'builtin-plugin-updates', dirName);
  if (!fs.existsSync(path.join(overlay, 'package.json'))) return assets;
  if (!fs.existsSync(path.join(assets, 'package.json'))) return overlay;
  // 覆盖层版本 >= 资产版本才优先：应用自身升级后，新资产自动接管覆盖层。
  const vOverlay = pluginUpdater.versionOfDir(overlay);
  const vAssets = pluginUpdater.versionOfDir(assets);
  // 覆盖层版本不可读（半写坏档）时回退资产版本：否则损坏的旧覆盖层永久
  // 遮蔽新资产，该插件停在坏版本且每次启动被压住。
  if (!vOverlay) return assets;
  if (vAssets && updater.compareVersions(vOverlay, vAssets) < 0) return assets;
  return overlay;
}

// 皮肤包目录：assets/skins/<id>/。每个皮肤是一个完整的 dsh client 插件包
// （package.json + lib/ + skin.json + LICENSE/NOTICE），随桌面端分发；
// 默认全部以 disabled: true 注册（不启用任何皮肤），由「设置 → 皮肤」切换。
export const SKINS_DIR = path.join(APP_ROOT, 'assets', 'skins');

import { copyPluginPackage, readJsonFile } from '../plugin-copy.js';

export {
  COPY_STAMP,
  EXTRA_PACKAGE_FILES,
  pluginCopyEntries,
  pluginStampOf,
  pluginCopyIsComplete,
  copyPluginPackage,
  readJsonFile,
} from '../plugin-copy.js';

// pnpm（dsh plugin add / 插件市场）hoist 进 profile node_modules 的
// @deepseek-ai 核心包真实拷贝，会遮蔽 <home>/profiles/node_modules 里指向
// 随应用分发的安装闭包 junction，形成模块双实例：Symbol 身份不一致，
// 作用域注册失效（如 "deployment:persona is already registered"），
// 模型列表刷新、模式切换、工作区添加等全部瘫痪。启动时清掉这些
// 遮蔽拷贝，让解析回落到 junction —— 与宿主同源、全局单实例。
export function healProfileModules(): void {
  try {
    const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
    const removed = healProfileModuleShadowing(home, desktopProfile());
    if (removed.length) ctx.log('boot', '已清理 profile node_modules 中遮蔽安装闭包的包拷贝: ' + removed.join(', '));
  } catch (err) {
    ctx.log('boot', '清理 profile 模块遮蔽失败: ' + (err as Error).message);
  }
}

// 曾内置、现已从内置清单移除的插件。老用户 profile 可能残留其 patch 行、
// node_modules 副本与 package.json 依赖：行在包被清会拖垮插件树，包在行在则
// 退役插件继续加载。旧市场还会与 dsh-unified-market 重复注册 /api/dsh-market，
// 使 dsh web 以 code=1 退出。启动时统一清理这些精确的历史内置条目。
// （契约测试锚定字面量 `const RETIRED_BUILTIN_PLUGINS = [`，勿加内联注解。）
export const RETIRED_BUILTIN_PLUGINS = [
  { id: 'auto-compact', name: 'dsh-auto-compact' },
  { id: 'plugin-marketplace', name: '@deepseek-ai/dsh-plugin-marketplace' },
  { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin' },
  { id: 'zat-market', name: 'zat-dsh-engine' },
  // 5.1.1：按用户要求移除内置「第三方模型思考强度」插件
  //（reasoning_effort 控件）。老 profile 的 patch 行/包副本由退役清理兜底。
  { id: 'third-party-thinking', name: '@deepseek-ai/dsh-third-party-thinking' },
  // dsh-tool-vision 自 4.5.0 起被 picturereader 取代但从未列入退役清单：
  // 老 profile 残留的行+包副本会在设置页注册一张「视觉模型」卡，其
  // settings 命名空间在新内核上失效，点开即空白页。
  { id: 'tool-vision', name: 'dsh-tool-vision' },
  // 按用户要求移除「普通/高级」分栏（nav-custom 是该分栏唯一写入者，
  // 见 test/settings-groups-standdown.test.ts 的单写者契约改判）。
  { id: 'settings-nav-custom', name: 'dsh-settings-nav-custom' },
  // 5.3.0：按用户要求移除内置「语音转文字」插件（本地 sherpa-onnx ASR 模型
  // ~1.1G 占空间，不再随包分发/安装）。老 profile 的 patch 行/包副本由退役
  // 清理兜底；已下载的 ~/.dsh/models/dsh-stt/ 模型缓存属于用户数据，安装器
  // 不再自动删除，只能由用户明确确认后单独清理。
  { id: 'dsh-stt', name: '@deepseek-ai/dsh-stt' },
  // 旧 dsh-file-drop 会同时接管普通文件和图片拖放，与 EAC 特化版并存时
  // 会重复注入内容并让官方图片遮罩停留。由 file-drop-eac 完整取代。
  { id: 'file-drop', name: 'dsh-file-drop' },
];

// 清理退役内置插件在 profile 的所有残留（patch 行 / 包副本 / 依赖项）。
// 内部函数：外部一律走带版本对齐门控的 retireRemovedBuiltinPluginsGated
// （issue #74 —— 5.3.2 及以前 sidecar preBootSync 直调无门控版，门控被架空）。
function retireRemovedBuiltinPlugins(profileDirP: string): void {
  const patchFile = path.join(profileDirP, 'cordis.patch.yml');
  for (const p of RETIRED_BUILTIN_PLUGINS) {
    try {
      if (fs.existsSync(patchFile)) {
        const text = fs.readFileSync(patchFile, 'utf8');
        const patched = removePluginFromPatch(text, p.id);
        if (patched !== text) {
          writeFileAtomic(patchFile, patched);
          ctx.log('boot', `已清理退役内置插件 ${p.id} 的 profile 行`);
        }
      }
    } catch (err) {
      ctx.log('boot', `清理退役内置插件 ${p.id} 行失败: ${String(((err as Error).message) || err)}`);
    }
    const pkgDir = path.join(profileDirP, 'node_modules', ...p.name.split('/'));
    try {
      if (fs.existsSync(pkgDir)) {
        fs.rmSync(pkgDir, { recursive: true, force: true });
        ctx.log('boot', `已清理退役内置插件 ${p.id} 的 profile 包副本`);
      }
    } catch (err) {
      ctx.log('boot', `清理退役内置插件 ${p.id} 包失败: ${String(((err as Error).message) || err)}`);
    }
    try {
      const pkgFile = path.join(profileDirP, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg.dependencies && pkg.dependencies[p.name]) {
        delete pkg.dependencies[p.name];
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
        ctx.log('boot', `已清理退役内置插件 ${p.id} 的 package.json 依赖`);
      }
    } catch { /* package.json 缺失/损坏则跳过 */ }
  }
}

// 安全模式守卫：<home>/guard/safe-mode.json active 时，配套插件的 patch 行
// 追加必须停摆——否则「安全模式重启」后 sync 会把全部插件行写回 patch，
// 下一次服务重启时安全模式被静默击穿（快照恢复前用户始终处于假安全模式）。
// 插件包文件拷贝不受影响（加载由 patch 行驱动，拷贝只是让文件就位）。
function safeModeActive(): boolean {
  try {
    const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
    const st = JSON.parse(fs.readFileSync(path.join(home, 'guard', 'safe-mode.json'), 'utf8')) as { active?: boolean };
    return st?.active === true;
  } catch {
    return false;
  }
}

// 退役清理的「升级对齐门控」（issue #74）：删除性手术只在「应用版本变化」
// 或「退役清单本身变化」（新增退役目标）后的首次启动执行一次 —— 升级时清掉
// 上一版本退役插件残留，同一版本内用户手动恢复/调整的插件树（管理页开关、
// 市场安装的同类包）不再被每次启动强制改写。settings 键 pluginTreeAlignedVersion
// 记录已对齐的应用版本，pluginTreeRetiredListHash 记录已对齐的清单内容：
// 只比对版本会让同版本内新列入的退役条目永远清不到（5.1.0 实测踩坑）。
function retiredListHash(): string {
  return crypto.createHash('sha256').update(JSON.stringify(RETIRED_BUILTIN_PLUGINS)).digest('hex');
}
export function retireRemovedBuiltinPluginsGated(profileDirP: string): void {
  let version = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version?: string };
    version = typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    // 读不到版本时退回无条件清理（旧语义）。
  }
  if (!version) {
    retireRemovedBuiltinPlugins(profileDirP);
    return;
  }
  try {
    const c = updCtx();
    const settings = updater.loadSettings(c) as Record<string, unknown>;
    const hash = retiredListHash();
    if (settings && settings.pluginTreeAlignedVersion === version && settings.pluginTreeRetiredListHash === hash) {
      ctx.log('boot', `已在本版本（${version}）对齐过内置插件树，跳过退役清理（用户调整优先）`);
      return;
    }
    retireRemovedBuiltinPlugins(profileDirP);
    const next = settings && typeof settings === 'object'
      ? { ...settings, pluginTreeAlignedVersion: version, pluginTreeRetiredListHash: hash }
      : { pluginTreeAlignedVersion: version, pluginTreeRetiredListHash: hash };
    updater.saveSettings(c, next);
    ctx.log('boot', `已在本版本（${version}）完成内置插件树对齐`);
  } catch (err) {
    ctx.log('boot', '记录插件树对齐版本失败，按旧语义清理: ' + String(err));
    retireRemovedBuiltinPlugins(profileDirP);
  }
}

export function syncCompanionPlugins(): void {
  const platform = ctx.platform ?? 'win32';
  const inSafeMode = safeModeActive();
  if (inSafeMode) ctx.log('boot', '安全模式激活中：跳过配套插件 patch 行同步（退出安全模式后恢复）');
  // 安装形态（v5.4 单发行版双形态）：精简版只改「新行」默认启停，
  // 已有注册行不重写、用户选择优先（见 lib/desktop/install-profile.ts）。
  const installProfile = readInstallProfile(APP_ROOT);
  if (installProfile === 'lite') ctx.log('boot', '安装形态 = 精简版：外围配套插件默认停用（设置 → 插件 → 管理 可随时启用）');
  try {
    const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
    // 桌面专属 profile 必须先存在（未知 profile 不会被 dsh 自动初始化）。
    ensureDesktopProfileInit();
    // 清理已退役内置插件在 profile 的残留，避免
    // 「行在包被清」拖垮插件树或退役插件继续加载。
    retireRemovedBuiltinPluginsGated(desktopProfileDir());
    // V4 运行时补丁（幂等，随启动 / 服务重启 / agent 更新后重放）：
    //  · 对话删除/归档 —— dsh-session-manager 插件的全链路前置依赖；
    applySessionManageFix();
    const profileDirP = desktopProfileDir();
    // 内置社区 agent preset（anchored-standard：首请求锚定 Minimal 工具对，
    // 首次工具调用/回复后开放完整 Standard 目录）：安装到用户 preset 根。
    // preset 不进插件树，坏 preset 不会拖垮启动；已存在则跳过（用户手装
    // 或改过的版本优先），见 preset-sync.js。
    if (platform === 'win32') {
      const bundledPresetsDir = path.join(APP_ROOT, 'assets', 'agent-presets');
      const installedPresetsDir = path.join(home, '.agent-presets');
      const presetsSynced = syncBundledPresets(
        bundledPresetsDir,
        installedPresetsDir,
        (m) => ctx.log('boot', m)
      );
      if (presetsSynced.installed.length) ctx.log('boot', '已安装内置 agent preset: ' + presetsSynced.installed.join(', '));
      const compactPresetResults = migrateManagedCompactPresets(
        installedPresetsDir,
        (m) => ctx.log('boot', m)
      );
      const compactPresetMigrated = compactPresetResults
        .filter((result) => result.status === 'migrated')
        .map((result) => path.basename(path.dirname(result.file)));
      if (compactPresetMigrated.length) {
        ctx.log('boot', '已将内置 agent preset 迁移到 dsh-compact: ' + compactPresetMigrated.join(', '));
      }
      const routerPersonaResults = migrateManagedRouterPersonaPresets(
        bundledPresetsDir,
        installedPresetsDir,
        (m) => ctx.log('boot', m)
      );
      const routerPersonaMigrated = routerPersonaResults
        .filter((result) => result.status === 'migrated')
        .map((result) => path.basename(path.dirname(result.file)));
      if (routerPersonaMigrated.length) {
        ctx.log('boot', '已修复内置 Router preset 的人设卡组合: ' + routerPersonaMigrated.join(', '));
      }
      // 默认 preset 指到内置的 anchored-standard（用户已在 settings.yaml 写过
      // default 则一律保留）。失败只降级为官方默认 preset，不影响启动。
      const defaultResult = ensureDefaultAgentPreset(home, 'anchored-standard', (m) => ctx.log('boot', m));
      if (defaultResult === 'set') ctx.log('boot', '已设置默认 agent preset: anchored-standard');
      else if (defaultResult === 'kept') ctx.log('boot', '用户已设置默认 agent preset，保持不变');
    } else {
      ctx.log('boot', 'Linux 使用上游默认 agent preset；未同步 Windows PowerShell/Git Bash 调优 preset');
    }
    fs.mkdirSync(path.join(profileDirP, 'node_modules'), { recursive: true });
    const pending: PendingRow[] = [];
    const removedIds = removedPluginIds();
    // 市场残留预检的共享输入（循环外读一次）：34 个配套插件逐个 dupPreCheck
    // 会把 profile package.json 与 cordis.patch.yml 各重读一遍（~68 次读）。
    // 迁移手术本身会改写这两个文件 —— 手术后的插件重读一次（按需失效）。
    let precheckPkg = readJsonFile(path.join(profileDirP, 'package.json'));
    let precheckPatch = '';
    try { precheckPatch = fs.readFileSync(path.join(profileDirP, 'cordis.patch.yml'), 'utf8'); } catch { /* 缺省空 */ }
    // V4.2：用户曾从市场安装过与内置插件同名的包时，写包前先迁移残留
    // （package.json 依赖/bundles + patch 行），让内置版干净接管，避免
    // duplicate loader entry；完成后系统通知告知「插件树变化」。
    const migratedBuiltins: { name: string; dep: boolean; rows: number }[] = [];
    for (const p of companionPluginsForPlatform(platform)) {
      // V4.2：用户移除过的内置插件不再复制/登记（见 pluginManagerSetRemoved）。
      if (removedIds.has(p.id)) {
        ctx.log('boot', `已按用户选择跳过被移除的内置插件: ${p.id}`);
        continue;
      }
      // 非 @deepseek-ai 作用域的配套包用显式 dir 指定 assets/plugins 下的目录名；
      // 回退解析按「最后一个路径段」取（@scope/name → name；无 scope → 原名）。
      // V4 修复：旧回退是 name.slice('@deepseek-ai/'.length) —— 对无 scope 的
      // 长包名会截出错误目录（dsh-session-manager → 'manager'），该插件被
      // 静默跳过（行与包都不落盘）。
      const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() as string : p.name);
      // V4.3：覆盖层优先 —— 用户更新过的内置插件从 <userData>/builtin-plugin-updates
      // 拷贝（不被资产版本还原）；应用升级后资产版本更新则自动接管。
      const src = builtinPluginSourceDir(dirName);
      if (!fs.existsSync(path.join(src, 'package.json'))) {
        ctx.log('boot', `配套插件源目录无效，跳过: ${p.id} → ${src}`);
        continue;
      }
      try {
        const { removeMarketDuplicate, patchHasForeignRows } = require('../../builtin-collision') as {
          removeMarketDuplicate(profileDir: string, name: string, o: { log(m: string): void }): { changed: boolean; ok: boolean; removedDep: unknown[]; removedRows: unknown[] };
          patchHasForeignRows(patchText: string, name: string): boolean;
        };
        // 市场同名包残留预检（v4.2，用户反馈问题 5）：只有「非应用自写」证据
        // （package.json 依赖/bundles 或非自写 patch 行）才算残留。共享输入
        // 来自循环外的单次读取；迁移手术后两个文件都变了，重读一次。
        const dupPreCheck = (() => {
          try {
            const deps = precheckPkg && (precheckPkg.dependencies as Record<string, unknown> | undefined);
            const spec = deps && deps[p.name];
            if (spec && !String(spec).startsWith('link:') && !String(spec).startsWith('file:')) return true;
            const dsh = precheckPkg && (precheckPkg.dsh as Record<string, unknown> | undefined);
            const prof = dsh && (dsh.profile as Record<string, unknown> | undefined);
            if (prof && Array.isArray(prof.bundles) && (prof.bundles as string[]).includes(p.name)) return true;
            // 只认「非应用自写」的登记行：sync 的 insert 内层行、插件管理/向导
            // togglePluginInPatch 写的（带「关闭」标记注释的）顶层行都是应用自己
            // 的启停状态，不是市场残留。否则 v4.4 首次向导的取消勾选会在同一启动
            // 里被剥离后按注册表默认回写（dsh-dafeiyu 等默认启用插件被静默重新
            // 启用），且每次启动产生「剥离-回写」空转与孤儿 `- insert:` 行堆积。
            return patchHasForeignRows(precheckPatch, p.name);
          } catch { return false; }
        })();
        if (dupPreCheck) {
          // 先快照（保护中心）：迁移属于配置面手术，出问题可一键回滚。
          ensureGuard().snapshot('builtin-migrate:' + p.id);
          // 只在确有市场残留证据时才动手术。v4.2 曾无条件执行迁移 —— 它的
          // 「剥离-回写」对无重复用户是空转，且会把应用自写的行（向导/插件
          // 管理的 disabled 行、sync 自己的 insert 行）一并剥掉后按注册表
          // 默认回写：v4.4 首次向导的取消勾选被静默重新启用，孤儿 insert
          // 行每次启动堆积。
          const migrated = removeMarketDuplicate(profileDirP, p.name, { log: (m) => ctx.log('boot', m) });
          if (migrated.changed && migrated.ok) {
            migratedBuiltins.push({ name: p.name, dep: migrated.removedDep.length > 0, rows: migrated.removedRows.length });
            ctx.log('boot', `内置插件 ${p.name} 已接管市场同名包（移除依赖 ${migrated.removedDep.length} 个、patch 行 ${migrated.removedRows.length} 个）`);
            // 迁移改写了两个文件：后续插件的预检必须看到新内容。
            precheckPkg = readJsonFile(path.join(profileDirP, 'package.json'));
            try { precheckPatch = fs.readFileSync(path.join(profileDirP, 'cordis.patch.yml'), 'utf8'); } catch { precheckPatch = ''; }
          }
        }
      } catch (err) {
        ctx.log('boot', `内置插件同名迁移失败(${p.id}): ${String(((err as Error).message) || err)}`);
      }
      copyPluginPackage(profileDirP, src, p.name);
      // p.disabled: true 的配套插件默认以禁用行注册（如 dsh-pet 页面桌宠），
      // 用户可在「设置 → 插件 → 管理」里启用；已有行不重写，用户选择优先。
      // 精简版：LITE_DEFAULT_DISABLED 命中的配套插件同样默认以禁用行注册。
      pending.push({ id: p.id, name: p.name, disabled: p.disabled === true || isLiteDisabled(p.id, installProfile), config: p.config });
    }
    if (migratedBuiltins.length) {
      try {
        const names = migratedBuiltins.map((m) => m.name).join('、');
        ctx.notify({
          title: '内置插件已接管同名市场包',
          body: `检测到市场安装的重复包，已改用内置版本（${names}）。插件树已自动整理，本次启动生效。`,
          icon: path.join(APP_ROOT, 'assets', 'icon.png'),
          onClick: () => ctx.showMainWindow(),
        });
      } catch (err) {
        ctx.log('boot', '内置接管通知发送失败: ' + (err as Error).message);
      }
    }
    // 内置皮肤：行 id 取皮肤包 skin.json 的 wiring.id（ui-skin-*）。
    // 禁用的皮肤黑名单（因兼容性问题或崩溃而禁用）。
    const DISABLED_SKINS = ['maid-atelier'];
    for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // 跳过禁用的皮肤
      if (DISABLED_SKINS.includes(entry.name)) continue;
      const src = path.join(SKINS_DIR, entry.name);
      const pkg = readJsonFile(path.join(src, 'package.json'));
      if (!pkg || typeof pkg.name !== 'string' || !pkg.name.includes('/')) continue;
      const skin = readJsonFile(path.join(src, 'skin.json'));
      const wiring = skin && (skin.wiring as Record<string, unknown> | undefined);
      const rowId = wiring && typeof wiring.id === 'string' ? wiring.id : '';
      if (!/^ui-skin-[\w-]+$/.test(rowId)) continue;
      copyPluginPackage(profileDirP, src, pkg.name);
      pending.push({ id: rowId, name: pkg.name, disabled: true });
    }
    // 内置插件清单标记：插件市场据此把目录里的同名插件标为「已内置」并
    // 拒绝重复安装 —— 内置包每次启动都被重新同步，市场覆盖安装会产生
    // duplicate loader entry / 模块双实例，必须从源头拦截。
    try {
      const builtinNames = pending.map((p) => p.name);
      const marker = path.join(profileDirP, '.dsh-builtin-plugins.json');
      const prev = readJsonFile(marker);
      const next = { names: builtinNames, updatedAt: new Date().toISOString() };
      if (!prev || JSON.stringify(prev.names) !== JSON.stringify(next.names)) {
        writeFileAtomic(marker, JSON.stringify(next, null, 2) + '\n');
      }
    } catch (err) {
      ctx.log('boot', '写入内置插件清单失败: ' + (err as Error).message);
    }
    ensurePluginHostDeps(profileDirP);
    // 配套插件的宿主依赖兜底（真实目录，非链接）。rc.2 起 dsh-app-boot 首启会
// 重建 <home>/profiles/node_modules 共享层：dev 时代指向宿主工程的符号链接
// 与历史手工副本会被清掉，而 web-app 闭包不传递依赖 schemastery ——
// better-sidebar / dsh-side-session 等 require 它会 ERR_MODULE_NOT_FOUND
// 拖垮整个插件树（dsh web 退出码 1，「DSH 服务已停止」）。共享层归内核管
// 理随时可能重建；插件层 <profile>/node_modules 不会被重建，在这里落真实
// 副本（版本戳幂等，升级版本变化才重拷）。
function ensurePluginHostDeps(profileDirP: string): void {
  const copied = new Set<string>();
  const ensureCopy = (rel: string, depth: number): void => {
    if (depth > 4 || copied.has(rel)) return;
    const src = path.join(APP_ROOT, 'node_modules', rel);
    const srcPj = path.join(src, 'package.json');
    const srcPkg = readJsonFile(srcPj);
    const version = srcPkg && typeof srcPkg.version === 'string' ? srcPkg.version : '';
    if (!version) return;
    copied.add(rel);
    const dest = path.join(profileDirP, 'node_modules', rel);
    const stamp = path.join(dest, '.eac-host-dep.json');
    const prev = readJsonFile(stamp);
    const fresh = prev && prev.version === version && fs.existsSync(path.join(dest, 'package.json'));
    if (!fresh) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
        fs.writeFileSync(stamp, JSON.stringify({ version, at: new Date().toISOString() }, null, 2) + '\n');
        ctx.log('boot', `已落位插件宿主依赖 ${rel}@${version}（真实目录，重建免疫）`);
      } catch (err) {
        ctx.log('boot', `宿主依赖落位失败 ${rel}: ` + String(((err as Error).message) || err));
        return;
      }
    }
    // 递归落位该包的 dependencies（应用树已提升的同名包；共享层若另有供应，
    // 插件层的副本同版本族不冲突，以插件树自洽优先）。
    const deps = (srcPkg && srcPkg.dependencies) as Record<string, string> | undefined;
    if (deps && typeof deps === 'object') {
      for (const dep of Object.keys(deps)) {
        if (fs.existsSync(path.join(APP_ROOT, 'node_modules', dep, 'package.json'))) {
          ensureCopy(dep, depth + 1);
        }
      }
    }
  };
  ensureCopy('schemastery', 0);
  // web-push（meow-smooth 通知 host 半边的运行时依赖；动态 import，缺省时
  // 该插件优雅降级为仅页面内提醒 —— 这里落位让系统推送开箱即用）。
  ensureCopy('web-push', 0);
  // cosmokit 只在共享层没有时兜底（避免遮蔽内核闭包内的配套版本）。
  const sharedCosmo = path.join(ctx.getDshHome() || path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai', 'cosmokit');
  if (!fs.existsSync(sharedCosmo)) {
    ensureCopy(path.join('@deepseek-ai', 'cosmokit'), 0);
  }
}

// 注册到 profile 的 patch 层（幂等：已有行不重写，用户选择的皮肤/disabled 状态保留）。
    const patchFile = path.join(profileDirP, 'cordis.patch.yml');
    let patch = '';
    try { patch = fs.readFileSync(patchFile, 'utf8'); } catch { patch = ''; }
    let changed = false;
    // 先修存量坏行：v2.0.0 写入的 soul-md 行缺 config.path（见 patch-row-heal.js
    // 头注释），不修则升级用户仍会 “dsh web 启动失败 (退出码 1)”。
    const healed = healSoulMdPatchRow(patch);
    if (healed.healed.length) {
      patch = healed.patch;
      changed = true;
      ctx.log('boot', '已修复 profile patch 中缺 config.path 的 soul-md 行');
    }
    // V4：修复 v3.1.0 及以前写出的「无 config 的 dsh-pet 行」（loader 传
    // undefined → dsh-pet 读 config.fullRoot 崩 → 插件树整体加载失败）。
    const healedPet = healRowConfig(patch, 'dsh-pet', { size: 260, position: 'bottom-right' });
    if (healedPet.healed.length) {
      patch = healedPet.patch;
      changed = true;
      ctx.log('boot', '已修复 profile patch 中缺 config 的 dsh-pet 行（v3 存量坏行）');
    }
    // 内核 0.1.2 隐私开关：官方 deepseek 适配器随请求上报活动插件包名/版本
    // （plugin-package-inventory-deepseek，默认 enabled: true）。桌面端默认
    // 关闭。该行在 dsh-base bundle 层已存在（overlay 不能再 insert —— 会
    // duplicate loader entry id 拖垮插件树），config 覆盖必须在 bundle 装载
    // 前由 --patch overlay 语义达成：本函数写「编辑型」覆盖行（- id + config，
    // 不在 - insert 列表内 = 对既有行改 config，cordis.patch 的标准编辑语义）。
    // 幂等：已有编辑行则跳过。
    // 幂等按 entry id 判定：可手工编辑的 YAML 用精确正则判「已存在」，
    // 用户重排引号/注释/缩进即失配 → 追加第二条同 id 编辑行（cordis 行为
    // 未定义）。hasEntryId 与本文件其余 patch 行逻辑同一判定。
    if (!hasEntryId(patch, 'plugin-package-inventory-deepseek')) {
      const privacyRow = '- id: plugin-package-inventory-deepseek\n  name: \'@deepseek-ai/dsh-plugin-package-inventory-deepseek\'\n  config:\n    enabled: false\n';
      patch = patch.replace(/\s*$/, '\n') + privacyRow;
      changed = true;
      ctx.log('boot', '已默认关闭内核插件名单上报（0.1.2 隐私开关，编辑型覆盖行）');
    }
    // 市场安装（dsh plugin add）会把插件登记进 package.json 的
    // dsh.profile.bundles，加载时执行其包内 patch 挂载行；若 overlay 里
    // 也有一行（syncCompanionPlugins 写的），整个插件树会以
    // “duplicate loader entry id” 崩溃。清掉 overlay 重复行（包内行保留）。
    let bundled: unknown[] = [];
    // 内置 bundle 插件播种（DESKTOP_PROFILE_BUNDLES 只影响全新 profile，存量
    // profile 的 bundles 在这里幂等补齐）：缺失则追加，已有（用户市场安装 /
    // dsh plugin add / 曾经播种过）则不动；仅在有变化时写回。纯函数
    // seedBundledPlugins 见本文件（可单测）。
    try {
      const seeded = seedBundledPlugins(profileDirP);
      bundled = seeded.bundles;
      if (seeded.changed) {
        ctx.log('boot', '已播种内置 bundle 插件到 profile: ' + BUNDLED_BUILTIN_PLUGINS.join(', '));
      }
    } catch (err) {
      bundled = [];
      ctx.log('boot', '播种内置 bundle 插件失败: ' + String(((err as Error).message) || err));
    }
    // 同一 entry id 被两处声明（bundle 的包内 patch + overlay 的配套行）会以
    // “duplicate loader entry id” 拖垮整个插件树。旧逻辑只按「包名 ∈ bundles」
    // 匹配，git/fork/link 安装的插件包名与配套行包名不符时永远删不掉（issue
    // #16）。这里再解析每个 bundle 包实际声明的 entry id 集合：overlay 中 id
    // 已被任一 bundle 声明（无论包名如何）即视为重复。
    const declaredBundleIds = collectBundleEntryIds(bundled, path.join(profileDirP, 'node_modules'));
    const rowIds: Record<string, string> = {};
    for (const p of COMPANION_PLUGINS) rowIds[p.id] = p.name;
    const deduped = removeBundledRowDuplicates(patch, rowIds, bundled, declaredBundleIds);
    if (deduped.removed.length) {
      patch = deduped.patch;
      changed = true;
      ctx.log('boot', '已移除与 bundle 登记重复的 patch 行: ' + deduped.removed.join(', '));
    }
    // 安全模式下不回写配套行（见 safeModeActive 注释）；退役清理与去重照常。
    for (const p of inSafeMode ? [] : pending) {
      if (hasEntryId(patch, p.id)) continue;
      // 已在 bundle 列表里的插件由其包内 patch 挂载，overlay 不能再写行
      // （会 duplicate loader entry id，拖垮整个插件树）。issue #16：
      // 补充按 entry id 判断 —— git/fork 插件包名不同但 id 相同同样要跳过，
      // 否则每次启动把崩溃行写回，用户删掉也没用。
      if (bundled.includes(p.name) || declaredBundleIds.has(p.id)) continue;
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config);
      if (p.disabled) block += `      disabled: true\n`;
      // 替换锚定与检测一致：裸 /\[\]/m 会命中更早位置的内联 []
      //（如 config 行的 key: []），把块插错位置造成 YAML 损坏。
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/^\s*\[\]\s*$/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      changed = true;
    }
    if (changed) {
      // 顺带清理历史遗留的孤儿 `- insert:` 行（v4.2/4.3 每次启动「剥离-回写」
      // 残留的空块；对 cordis 无效果，仅文件卫生）。强制一次写盘，之后幂等。
      const lines = patch.split(/\r?\n/);
      const cleaned = lines.filter((line, idx) => {
        if (!/^[ \t]*- insert:\s*$/.test(line)) return true;
        let k = idx + 1;
        while (k < lines.length && lines[k]!.trim() === '') k += 1;
        return k < lines.length && /^[ \t]+- /.test(lines[k]!);
      }).join('\n');
      if (cleaned !== patch) {
        patch = cleaned;
        ctx.log('boot', '已清理 profile patch 中的孤儿 - insert: 行');
      }
      // 原子写（对齐上方 retireRemovedBuiltinPlugins 的 writeFileAtomic）：
      // boot 最关键的一次 patch 重写，中断截断 = 插件树校验失败 → 启动死亡循环。
      writeFileAtomic(patchFile, patch);
      ctx.log('boot', '已同步配套插件/皮肤到 web profile: ' + pending.map((p) => p.id).join(', '));
    }
    // 迁移带来的皮肤选择（migrateFromSharedWebProfile 记录）在此落位。
    ctx.applyLegacySkinChoice();
  } catch (err) {
    ctx.log('boot', '同步配套插件失败: ' + (err as Error).message);
  }
}

/**
 * lib/plugin-registry-data.ts — 内置配套插件清单与更新源（Task 5.2 提取）。
 * COMPANION_PLUGINS 表的逐条注释（插件用途/历史修复）见 git 历史（迁移自
 * main.js 1329-1456）；关键行内注释原样保留。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as updater from '../updater.js';
import * as pluginUpdater from '../plugin-updater.js';
import { state } from './state.js';

/** 单个配套插件登记项。 */
export interface CompanionPlugin {
  id: string;
  name: string;
  /** assets/plugins 下的目录名（无 scope 或目录名≠包名尾段时必须显式给）。 */
  dir?: string;
  /** 随 patch 行写入的初始 config（schema required 字段的双保险）。 */
  config?: Record<string, unknown>;
  /** 默认禁用（用户可在插件管理里启用）。 */
  disabled?: boolean;
}

export const COMPANION_PLUGINS: CompanionPlugin[] = [
  // VNext Phase 2 Core Bridge（受信组件）：把隔离 SDK 插件的工具/上下文
  // 桥接进 dsh Agent（回环端点见 lib/extension-host/bridge-server.ts）。
  // 必须先于其余伴生插件同步（它们不依赖它，但保持 bridge 常驻可用）。
  { id: 'eac-core-bridge', name: 'dsh-eac-core-bridge' },
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal' },
  { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin', dir: 'dsh-webui-market' },
  { id: 'skin-switch', name: '@deepseek-ai/dsh-skin-switch' },
  { id: 'easy-setup', name: '@deepseek-ai/dsh-easy-setup' },
  { id: 'tool-vision', name: 'dsh-tool-vision', dir: 'dsh-tool-vision' },
  // config.path 必须随行写入：v2.0.0 只写了 id+name，schema required 无默认值，
  // 全新安装校验失败拖垮整个插件树（详见 patch-row-heal 的存量修复）。
  { id: 'soul-md', name: 'dsh-soul-md', dir: 'dsh-soul-md', config: { path: 'soul.md' } },
  { id: 'tdai-memory', name: 'dsh-tdai-memory', dir: 'dsh-tdai-memory' },
  { id: 'mobile-fix', name: 'dsh-web-mobile-fix', dir: 'dsh-web-mobile-fix' },
  { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar' },
  { id: 'message-rewind', name: 'dsh-message-rewind', dir: 'dsh-message-rewind' },
  // 行必须带 config：dsh-pet 的 apply 读 config.fullRoot，无 config 块的行会让
  // loader 传 undefined 直接拖垮插件树（v3.1.0 全新安装即「启动失败」根因）。
  { id: 'dsh-pet', name: 'dsh-pet', dir: 'dsh-pet', config: { size: 260, position: 'bottom-right' }, disabled: true },
  { id: 'zat-market', name: 'zat-dsh-engine', dir: 'zat-dsh-engine' },
  { id: 'dock-settings', name: 'dsh-dock-settings', dir: 'dsh-dock-settings' },
  { id: 'font-custom', name: 'dsh-font-custom', dir: 'dsh-font-custom' },
  { id: 'auto-compact', name: 'dsh-auto-compact', dir: 'dsh-auto-compact' },
  { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
  { id: 'change-review', name: 'dsh-change-review', dir: 'dsh-change-review' },
  { id: 'float-window', name: '@deepseek-ai/dsh-float-window' },
  { id: 'dsh-navbar', name: '@vlln/dsh-navbar', dir: 'dsh-navbar' },
  { id: 'dsh-session-manager', name: 'dsh-session-manager' },
  { id: 'conversation-tweaks', name: '@deepseek-ai/dsh-conversation-tweaks' },
  { id: 'prompt-custom', name: '@deepseek-ai/dsh-prompt-custom' },
  { id: 'third-party-thinking', name: '@deepseek-ai/dsh-third-party-thinking' },
  { id: 'side-session', name: '@dsh-external/dsh-side-session', dir: 'dsh-side-session' },
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
  { id: 'plugin-wizard', name: 'dsh-plugin-wizard', dir: 'dsh-plugin-wizard' },
  { id: 'openclaw-bridge', name: '@deepseek-ai/dsh-openclaw-bridge', dir: 'dsh-openclaw-bridge' },
  { id: 'dsh-undo', name: 'dsh-undo-savepoint', dir: 'dsh-undo-savepoint' },
  { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu', dir: 'dsh-dafeiyu' },
  { id: 'dsh-pet-settings', name: 'dsh-pet-settings', dir: 'dsh-pet-settings' },
  { id: 'offpeak', name: 'dsh-offpeak', dir: 'dsh-offpeak' },
  { id: 'file-drop', name: 'dsh-file-drop', dir: 'dsh-file-drop' },
  { id: 'settings-nav-custom', name: 'dsh-settings-nav-custom', dir: 'dsh-settings-nav-custom' },
  { id: 'settings-groups', name: 'dsh-settings-groups', dir: 'dsh-settings-groups' },
  { id: 'image-paste', name: 'dsh-image-paste', dir: 'dsh-image-paste' },
];

/** 内置插件上游更新源（V4.3，plugin-updater.js 消费；npm 404 优雅降级）。 */
export const PLUGIN_UPDATE_SOURCES: Record<string, { npm?: string; github?: string }> = {
  'tool-vision': { npm: 'dsh-tool-vision' },
  'soul-md': { npm: 'dsh-soul-md' },
  'tdai-memory': { npm: 'dsh-tdai-memory' },
  'dsh-pet': { npm: 'dsh-pet' },
  'better-sidebar': { npm: 'dsh-better-sidebar' },
  'dsh-navbar': { npm: '@vlln/dsh-navbar' },
  'mobile-fix': { npm: 'dsh-web-mobile-fix' },
  offpeak: { npm: 'dsh-offpeak' },
  'dsh-market-plugin': { npm: '@sanqi-normal/dsh-webui-market-plugin' },
  'dsh-session-manager': { npm: 'dsh-session-manager' },
  // GitHub 分发（npm 未发布）：dsh-undo-savepoint。
  'dsh-undo': { github: 'lire1131/dsh-undo-savepoint' },
};

/** 内置插件更新源条目（plugin-updater 的 sources 输入）。 */
export interface PluginUpdateSourceEntry {
  id: string;
  name: string;
  assetsDir: string;
  update: { npm?: string; github?: string };
}

/** 把内置插件表 + 更新源注册表合并成 plugin-updater 的 sources 输入。 */
export function pluginUpdateSources(
  removedIds: Set<string>,
): PluginUpdateSourceEntry[] {
  const out: PluginUpdateSourceEntry[] = [];
  for (const p of COMPANION_PLUGINS) {
    const update = PLUGIN_UPDATE_SOURCES[p.id];
    if (!update) continue;
    if (removedIds.has(p.id)) continue;
    const dirName = p.dir ?? (p.name.includes('/') ? (p.name.split('/').pop() as string) : p.name);
    const assetsDir = path.join(__dirname, '..', 'assets', 'plugins', dirName);
    if (!fs.existsSync(path.join(assetsDir, 'package.json'))) continue;
    out.push({ id: p.id, name: p.name, assetsDir, update });
  }
  return out;
}

/** 内置插件当前生效的源目录：覆盖层（已更新版本）优先，资产版本回退。 */
export function builtinPluginSourceDir(dirName: string): string {
  const assets = path.join(__dirname, '..', 'assets', 'plugins', dirName);
  const overlay = path.join(state.userDataDir, 'builtin-plugin-updates', dirName);
  if (!fs.existsSync(path.join(overlay, 'package.json'))) return assets;
  if (!fs.existsSync(path.join(assets, 'package.json'))) return overlay;
  // 覆盖层版本 >= 资产版本才优先：应用自身升级后，新资产自动接管覆盖层。
  const vOverlay = pluginUpdater.versionOfDir(overlay);
  const vAssets = pluginUpdater.versionOfDir(assets);
  if (vOverlay && vAssets && updater.compareVersions(vOverlay, vAssets) < 0) return assets;
  return overlay;
}

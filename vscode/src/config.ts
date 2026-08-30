// src/config.ts — dshEac.* 设置项读取与规范化
// 纯函数（normalizeConfig / resolveRepoRoot）不依赖 vscode，可直接单测；
// readConfig 是 vscode 设置的薄封装，供 extension.ts 使用。
import * as vscode from 'vscode';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

/** 用户可配置的原始值（可能缺失/非法） */
export interface RawDshConfig {
  /** 期望端口（0 = 自动选择稳定端口，复用 stable-port.js 逻辑） */
  port?: number;
  autoStart?: boolean;
  stopOnExit?: boolean;
  /** 使用的 dsh profile（web-desktop = 桌面专属隔离 profile；web = 官方共享 profile） */
  profile?: string;
  /** DSH_HOME（空串 = 默认 ~/.dsh-v4lite） */
  dshHome?: string;
  /** 启动前是否同步内置插件/皮肤到 profile（万物皆插件） */
  syncBuiltinPlugins?: boolean;
  extraArgs?: string[];
  /** 额外的 --patch overlay 文件路径（用户自定义插件补丁入口） */
  patchOverlays?: string[];
  openInBrowser?: boolean;
  workspaceRootIndex?: number;
}

/** 规范化后的配置（均有合法默认值） */
export interface DshConfig {
  host: string;
  port: number;
  autoStart: boolean;
  stopOnExit: boolean;
  profile: string;
  dshHome: string;
  syncBuiltinPlugins: boolean;
  extraArgs: string[];
  patchOverlays: string[];
  openInBrowser: boolean;
  workspaceRootIndex: number;
}

/** 默认配置 */
export const DEFAULTS: DshConfig = {
  host: '127.0.0.1',
  port: 0,
  autoStart: true,
  stopOnExit: true,
  profile: 'web-desktop',
  dshHome: '',
  syncBuiltinPlugins: true,
  extraArgs: [],
  patchOverlays: [],
  openInBrowser: false,
  workspaceRootIndex: 0,
};

/** 合法 profile 取值 */
const VALID_PROFILES = new Set(['web-desktop', 'web']);

/**
 * 规范化原始配置：非法值回退默认并记录错误描述
 * （安全规则：host 固定回环地址；端口必须为 0..65535 的整数；profile 必须合法）
 */
export function normalizeConfig(raw: RawDshConfig): { config: DshConfig; errors: string[] } {
  const errors: string[] = [];

  let port = raw.port;
  if (port === undefined) {
    port = DEFAULTS.port;
  } else if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`dshEac.port must be an integer in 0..65535, got ${JSON.stringify(raw.port)}`);
    port = DEFAULTS.port;
  }

  const autoStart = typeof raw.autoStart === 'boolean' ? raw.autoStart : DEFAULTS.autoStart;
  const stopOnExit = typeof raw.stopOnExit === 'boolean' ? raw.stopOnExit : DEFAULTS.stopOnExit;

  let profile: string;
  if (typeof raw.profile !== 'string' || !VALID_PROFILES.has(raw.profile)) {
    if (raw.profile !== undefined) {
      errors.push(`dshEac.profile must be one of [${[...VALID_PROFILES].join(', ')}], got ${JSON.stringify(raw.profile)}`);
    }
    profile = DEFAULTS.profile;
  } else {
    profile = raw.profile;
  }

  // dshHome：非字符串回退默认 ''；空串表示使用默认 ~/.dsh-v4lite
  const dshHome = typeof raw.dshHome === 'string' ? raw.dshHome.trim() : DEFAULTS.dshHome;

  const syncBuiltinPlugins =
    typeof raw.syncBuiltinPlugins === 'boolean' ? raw.syncBuiltinPlugins : DEFAULTS.syncBuiltinPlugins;

  const extraArgs = Array.isArray(raw.extraArgs)
    ? raw.extraArgs.filter((a): a is string => typeof a === 'string')
    : DEFAULTS.extraArgs;

  const patchOverlays = Array.isArray(raw.patchOverlays)
    ? raw.patchOverlays.filter((a): a is string => typeof a === 'string')
    : DEFAULTS.patchOverlays;

  const openInBrowser = typeof raw.openInBrowser === 'boolean' ? raw.openInBrowser : DEFAULTS.openInBrowser;

  let workspaceRootIndex: number;
  if (raw.workspaceRootIndex === undefined) {
    workspaceRootIndex = DEFAULTS.workspaceRootIndex;
  } else if (
    typeof raw.workspaceRootIndex !== 'number' ||
    !Number.isInteger(raw.workspaceRootIndex) ||
    raw.workspaceRootIndex < 0
  ) {
    errors.push(
      `dshEac.workspaceRootIndex must be a non-negative integer, got ${JSON.stringify(raw.workspaceRootIndex)}`,
    );
    workspaceRootIndex = DEFAULTS.workspaceRootIndex;
  } else {
    workspaceRootIndex = raw.workspaceRootIndex;
  }

  return {
    config: {
      host: DEFAULTS.host,
      port,
      autoStart,
      stopOnExit,
      profile,
      dshHome,
      syncBuiltinPlugins,
      extraArgs,
      patchOverlays,
      openInBrowser,
      workspaceRootIndex,
    },
    errors,
  };
}

/** 从 VS Code 设置读取（薄封装，供 extension.ts 使用） */
export function readConfig(): { config: DshConfig; errors: string[] } {
  const ws = vscode.workspace.getConfiguration('dshEac');
  return normalizeConfig({
    port: ws.get<number>('port'),
    autoStart: ws.get<boolean>('autoStart'),
    stopOnExit: ws.get<boolean>('stopOnExit'),
    profile: ws.get<string>('profile'),
    dshHome: ws.get<string>('dshHome'),
    syncBuiltinPlugins: ws.get<boolean>('syncBuiltinPlugins'),
    extraArgs: ws.get<string[]>('extraArgs'),
    patchOverlays: ws.get<string[]>('patchOverlays'),
    openInBrowser: ws.get<boolean>('openInBrowser'),
    workspaceRootIndex: ws.get<number>('workspaceRootIndex'),
  });
}

/**
 * 解析扩展运行所需的「仓库根」目录（desktop-core.js / assets / node_modules / vendor 所在）。
 * 解析顺序（高 → 低）：
 *   1. 环境变量 DSH_EAC_REPO_ROOT —— 测试/便携场景显式指向真实仓库根；
 *   2. <extensionPath>/runtime —— 内置 IDE 模式：扩展作为 VS Code 内置扩展分发时，
 *      运行时资产（desktop-core + dsh 内核 + vendor/node）捆绑在扩展目录内自解析，
 *      无需任何环境变量（以 desktop-core.js 存在为判据）；
 *   3. dirname(extensionPath) —— 开发仓库模式：vscode/ 扩展子目录的上一级即仓库根。
 */
export function resolveRepoRoot(extensionPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_EAC_REPO_ROOT;
  if (fromEnv) return fromEnv;
  const bundled = join(extensionPath, 'runtime');
  if (existsSync(join(bundled, 'desktop-core.js'))) return bundled;
  return dirname(extensionPath);
}

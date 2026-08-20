/**
 * lib/onboarding.ts — 内置插件选择向导（Task 5b 自 main.js 提取）。
 *
 * 首次启动 first 模式 / 设置页二次打开 rerun 模式。启动门控：全新用户展示
 * 向导并等待提交；升级用户静默跳过并记完成标记。关闭向导（取消）= 保持全部
 * 启用，只记完成标记不再打扰。onboardingNeeded 必须在任何写盘之前由
 * computeOnboardingNeed 预计算（settings.json 会在启动早期被迁移流程无条件
 * 创建，事后无法区分新老用户）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrowserWindow } from 'electron';
import * as updater from '../updater.js';
import * as onboardingLogic from '../scripts/onboarding.js';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN, updCtx } from './proc.js';
import { desktopProfileDir } from './paths.js';
import { COMPANION_PLUGINS } from './plugin-registry-data.js';
import {
  pluginManagerReadPatch, pluginManagerPackageDescription,
} from './plugin-manager-core.js';

/** 向导提交/取消的结果。 */
export interface WizardResult {
  ok: boolean;
  cancelled?: boolean;
  applied?: unknown;
  errors?: unknown;
}

/** 关闭向导窗口并触发完成回调（onboard:submit / 用户关闭共用）。 */
export function closeWizard(result: WizardResult): void {
  const cb = state.wizardDone;
  state.wizardDone = null;
  if (state.wizardWindow && !state.wizardWindow.isDestroyed()) state.wizardWindow.destroy();
  state.wizardWindow = null;
  if (cb) cb(result);
}

// 包目录体积（递归字节数，带缓存）。首次同步前 assets 尚未落盘到 profile，
// 以分发目录为准展示体积提示。
const pluginDirSizeCache = new Map<string, number>();
function pluginDirSize(dirName: string): number {
  const cached = pluginDirSizeCache.get(dirName);
  if (cached !== undefined) return cached;
  let total = 0;
  try {
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      }
    };
    walk(path.join(__dirname, '..', 'assets', 'plugins', dirName));
  } catch {
    /* 目录缺失：体积计 0 */
  }
  pluginDirSizeCache.set(dirName, total);
  return total;
}

// 向导目录：核心/推荐标记 + 描述 + 包体积（数据来源与 sync 保持一致）。
export function buildOnboardingCatalog(): onboardingLogic.CatalogEntry[] {
  return onboardingLogic.buildCatalog(COMPANION_PLUGINS, {
    coreIds: onboardingLogic.CORE_PLUGIN_IDS,
    recommendedIds: onboardingLogic.RECOMMENDED_PLUGIN_IDS,
    describe: (name: string) => pluginManagerPackageDescription(name),
    dirSize: (dirName: string) => pluginDirSize(dirName),
  });
}

// patch + 注册表 → 各内置插件当前启用状态（rerun 模式预填勾选用）。
export function pluginCurrentState(): Record<string, boolean> {
  const { entries } = pluginManagerReadPatch();
  return onboardingLogic.pluginCurrentState(entries, COMPANION_PLUGINS);
}

/** openPluginWizard 参数。 */
export interface OpenWizardOpts {
  mode?: 'first' | 'rerun';
}

// 打开向导窗口。返回 Promise：提交（{ok:true, applied, errors}）或关闭
// （{ok:false, cancelled:true}）时 resolve；窗口已存在时聚焦并直接 resolve。
export function openPluginWizard(opts: OpenWizardOpts = {}): Promise<WizardResult> {
  const { mode = 'first' } = opts;
  return new Promise((resolve) => {
    if (state.wizardWindow && !state.wizardWindow.isDestroyed()) {
      state.wizardWindow.focus();
      resolve({ ok: false, cancelled: true });
      return;
    }
    state.wizardMode = mode === 'rerun' ? 'rerun' : 'first';
    // AppState 的向导回调按 unknown 结果声明（Task 1.1 最小形状），此处收窄。
    state.wizardDone = resolve as (r: unknown) => void;
    const win = new BrowserWindow({
      width: 920,
      height: 700,
      minWidth: 640,
      minHeight: 520,
      show: false,
      title: '内置插件选择向导',
      backgroundColor: '#0b1220',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'assets', 'onboarding-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    state.wizardWindow = win;
    void win.loadFile(path.join(__dirname, '..', 'assets', 'onboarding.html'));
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.on('closed', () => {
      const cb = state.wizardDone;
      state.wizardDone = null;
      state.wizardWindow = null;
      if (cb) cb({ ok: false, cancelled: true });
    });
    log('boot', '已打开内置插件选择向导（' + state.wizardMode + ' 模式）');
  });
}

// 启动门控：全新用户展示向导并等待提交；升级用户静默跳过并记完成标记。
export async function runPluginOnboardingIfNeeded(
  onboardingNeeded: boolean,
): Promise<{ ran: boolean; cancelled?: boolean; applied?: unknown; errors?: unknown }> {
  if (!onboardingNeeded) {
    const settings = updater.loadSettings(updCtx());
    if (!settings.pluginOnboardingDone) {
      settings.pluginOnboardingDone = true;
      updater.saveSettings(updCtx(), settings);
      log('boot', '升级用户：跳过插件选择向导，插件保持全量现状');
    }
    return { ran: false };
  }
  log('boot', '全新用户：展示内置插件选择向导');
  const result = await openPluginWizard({ mode: 'first' });
  if (!result.ok) {
    const s = updater.loadSettings(updCtx());
    s.pluginOnboardingDone = true;
    updater.saveSettings(updCtx(), s);
    log('boot', '用户关闭插件选择向导：保持全部插件启用');
  }
  return { ran: true, ...result };
}

// 全新 vs 老用户判定（须在 run-state / migrate 标记 / 稳定端口等任何写盘
// 之前调用）：settings.json 在迁移流程里会被无条件创建，事后无法区分。
export function computeOnboardingNeed(): boolean {
  const settings = updater.loadSettings(updCtx());
  return onboardingLogic.needsPluginOnboarding({
    settings: settings as Record<string, unknown>,
    settingsFileExists: fs.existsSync(updater.settingsPath(updCtx())),
    profileDirExists: fs.existsSync(path.join(desktopProfileDir(), 'node_modules')),
    sharedProfileExists: fs.existsSync(
      path.join(state.dshHome || path.join(os.homedir(), '.dsh'), 'profiles', 'web'),
    ),
  });
}

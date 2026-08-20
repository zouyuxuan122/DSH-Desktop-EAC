/**
 * lib/state.ts — 全局共享可变状态单例（Task 1.1，迁自 main.js 顶层闭包）。
 *
 * 职责：集中承载主进程 main.js 原先散落在模块顶层的全部可变状态，以强类型
 * 单例 `state` 暴露；main.js 统一经 `state.xxx` 读写。本次迁移仅做状态搬家，
 * 不改变任何逻辑、时机与日志：初值与原顶层声明一一对应，且同样在模块加载期
 * 求值（main.js 顶部 require 本模块，与原声明执行时序等价）。
 *
 * 约定：
 *   - 外部 JS 模块（renderer-recovery / session-watcher / plugin-guard /
 *     balance / 市场插件 ESM 等）的实例暂以最小结构类型描述，并标注 TODO，
 *     待后续 Task 将对应模块迁移 TS 后替换为真实类型；
 *   - 编译产物 lib/state.js 由 `npm run build`（tsc 原地）生成，属 gitignore
 *     的编译产物；main.js（仍是 JS）经 `require('./lib/state.js')` 引用。
 */

import type { BrowserWindow, Tray } from 'electron';
import type { ChildProcess } from 'node:child_process';
import type { WriteStream } from 'node:fs';

/** TODO(后续 Task): session-watcher.js 迁 TS 后替换为真实类型。 */
interface SessionWatcherLike {
  start(): void;
  stop(): void;
}

/** 渲染进程自恢复状态机（renderer-recovery.ts；Task 7 起真实类型）。 */
import type { RendererRecovery } from '../renderer-recovery.js';
type RendererRecoveryLike = RendererRecovery;

/** 插件保护中心（plugin-guard.ts；Task 6 起真实类型）。 */
import type { GuardInstance } from '../plugin-guard.js';
type PluginGuardLike = GuardInstance;

/** TODO(后续 Task): balance.js 的查询结果结构迁 TS 后替换为真实类型。 */
interface BalanceResultLike {
  ok: boolean;
  balances: unknown[];
  error?: string;
  prices?: unknown;
  pricing?: unknown;
}

/** TODO(后续 Task): js-yaml 的 dsh entry-list 方言加载器，见 main.js loadDshYamlDialect。 */
interface DshYamlDialectLike {
  load(content: string): unknown;
}

/** TODO(后续 Task): 向导完成回调（Promise resolve），参数为 closeWizard(result) 的结果对象。 */
type WizardDoneCallback = (result: unknown) => void;

/** 主进程全局共享可变状态（字段与初值同原 main.js 顶层声明一一对应）。 */
export interface AppState {
  /** 主窗口。 */
  mainWindow: BrowserWindow | null;
  /** dsh web 服务子进程。 */
  serverProc: ChildProcess | null;
  /** dsh web 服务就绪后的 URL。 */
  webUrl: string | null;
  /** 应用是否正在退出。 */
  quitting: boolean;
  /** 自更新流程是否进行中（防重入）。 */
  updateBusy: boolean;
  /**
   * V4 多窗口（会话浮窗，摘自上游 dsh_desktop）：同一会话只保留一个浮窗，
   * 上限 8 个（FLOAT_MAX，常量仍在 main.js）防资源滥用；主窗关闭/应用退出
   * 时统一回收。
   */
  floatWindows: Set<BrowserWindow>;
  /** 会话 ID → 浮窗 的映射（与会话浮窗集合配套）。 */
  floatBySession: Map<string, BrowserWindow>;
  /** 回合结束是否发系统通知（用户可在托盘菜单切换）。 */
  notifyOnTurnEnd: boolean;
  /** 会话文件监听器（session-watcher.js 实例）。 */
  sessionWatcher: SessionWatcherLike | null;
  /** Electron userData 目录。 */
  userDataDir: string;
  /** 日志目录。 */
  logsDir: string;
  /** DSH_HOME（dsh 主目录）。 */
  dshHome: string;
  /** 桌面日志写入流（desktop.log）。 */
  desktopLog: WriteStream | null;
  /** 系统托盘（仅 Windows）。 */
  tray: Tray | null;
  /** 强制退出标志（跳过托盘驻留等确认流程）。 */
  forceQuit: boolean;
  /** 客户端自更新流程是否进行中（防重入）。 */
  clientUpdateBusy: boolean;
  /** 余额查询结果缓存（balance.js 查询 + 定价加工后的结果）。 */
  balanceCache: BalanceResultLike | null;
  /** 余额轮询定时器。 */
  balanceTimer: NodeJS.Timeout | null;
  /** 服务是否正在重启（重启期间抑制退出弹窗等）。 */
  restartingServer: boolean;
  /** V4 退出清理：before-quit 只允许进入一次异步清理（防止重复触发）。 */
  shutdownInProgress: boolean;
  /** V4 退出清理：当前正在执行的插件市场排队任务子进程（退出时强杀）。 */
  marketOpChild: ChildProcess | null;
  /** 渲染进程崩溃/挂起自恢复状态机（renderer-recovery.js，上游 Issue #9 修复）。 */
  recovery: RendererRecoveryLike | null;
  /** koffi 预检失败时注入的目录选择器降级 overlay 路径（koffi-preflight.js）。 */
  pickerBrowseOverlay: string | null;
  /**
   * 集成测试钩子：DSH_DESKTOP_TEST_FORCE_UNSAFE=1 时把第一次探测到的端口
   * 强制视为受限端口（6000），端到端验证「重启换端口」交接路径。
   */
  testForceUnsafeOnce: boolean;
  /** 插件保护中心实例（plugin-guard.js，延迟创建：依赖 dshHome 与 settings 就绪）。 */
  guardInstance: PluginGuardLike | null;
  /** 启动失败救援（防重入）：一次会话只主动查一次。 */
  clientUpdateRescueArmed: boolean;
  /** 内置插件选择向导窗口。 */
  wizardWindow: BrowserWindow | null;
  /** 向导模式：first（首次启动）/ rerun（设置页二次打开）。 */
  wizardMode: 'first' | 'rerun';
  /** 向导完成回调（openWizard 返回的 Promise 的 resolve）。 */
  wizardDone: WizardDoneCallback | null;
  /** 托盘气泡提示是否已展示过（仅提示一次）。 */
  trayHintShown: boolean;
  /** TODO(后续 Task): 市场插件 ESM（artifact-keep.mjs）的命名空间，惰性 import。 */
  artifactKeepMod: Record<string, unknown> | null;
  /** TODO(后续 Task): 市场插件 ESM（allow-builds.mjs）的命名空间，惰性 import。 */
  allowBuildsMod: Record<string, unknown> | null;
  /** 惰性加载的 js-yaml dsh 方言加载器（缺失时管理页降级为空列表）。 */
  dshYamlDialect: DshYamlDialectLike | null;
  /** dshYamlDialect 是否已尝试加载过（惰性加载只试一次）。 */
  dshYamlTried: boolean;
  /** 预览静态文件服务端口（0 = 未启动）。 */
  previewStaticPort: number;
  /** VNext Phase 2：Core Bridge 回环端点（URL + 一次性 token；null = 未启动）。 */
  eacBridge: { url: string; token: string; close(): void } | null;
}

/** 全局共享可变状态单例：初值与原 main.js 顶层声明一一对应。 */
export const state: AppState = {
  mainWindow: null,
  serverProc: null,
  webUrl: null,
  quitting: false,
  updateBusy: false,
  floatWindows: new Set(),
  floatBySession: new Map(),
  notifyOnTurnEnd: true,
  sessionWatcher: null,
  userDataDir: '',
  logsDir: '',
  dshHome: '',
  desktopLog: null,
  tray: null,
  forceQuit: false,
  clientUpdateBusy: false,
  balanceCache: null,
  balanceTimer: null,
  restartingServer: false,
  shutdownInProgress: false,
  marketOpChild: null,
  recovery: null,
  pickerBrowseOverlay: null,
  testForceUnsafeOnce: process.env.DSH_DESKTOP_TEST_FORCE_UNSAFE === '1',
  guardInstance: null,
  clientUpdateRescueArmed: false,
  wizardWindow: null,
  wizardMode: 'first',
  wizardDone: null,
  trayHintShown: false,
  artifactKeepMod: null,
  allowBuildsMod: null,
  dshYamlDialect: null,
  dshYamlTried: false,
  previewStaticPort: 0,
  eacBridge: null,
};

/**
 * lib/bridge.ts — 跨域函数注入点（Task 2 引入）。
 *
 * 背景：模块提取后，低层模块（run-state/server/watchdog-boot）需要调用
 * 尚未提取或属于其他域的高层函数（窗口/托盘的 showMainWindow、boot 域的
 * handleBootFailure、plugins 域的 syncCompanionPlugins 等）。直接
 * require('../main.js') 会形成循环加载（部分初始化），故采用「注入点」：
 * main.js 在模块顶层装配期覆写字段，运行时全部经 bridge 转发。
 *
 * 约定：默认实现只记警告日志（保证未装配时也不崩溃）；main.js 装配发生在
 * 同步 require 阶段，早于任何事件回调，语义与原 main.js 闭包直调等价。
 */

import { dialog } from 'electron';
import { log } from './log.js';

/** dialog.showMessageBox 的选项与返回（只声明用到字段）。 */
export interface MessageBoxOpts {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  title?: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  noLink?: boolean;
}

export interface MessageBoxResult {
  response: number;
}

/** plugin-guard 实例（plugin-guard.ts 的 GuardInstance；Task 7 起真实类型）。 */
export type GuardLike = import('../plugin-guard.js').GuardInstance;

/** 跨域注入点（main.js 装配期覆写）。 */
export const bridge = {
  /** 显示/聚焦主窗口（托盘域）。 */
  showMainWindow: (): void => {
    log('bridge', 'showMainWindow 未装配（装配期外的调用）');
  },
  /** 消息框（窗口域；默认无父窗实现，main.js 覆写为带主窗版本）。 */
  showBox: (opts: MessageBoxOpts): Promise<MessageBoxResult> => dialog.showMessageBox(opts),
  /** 插件保护中心实例（guard 域，延迟创建）。 */
  ensureGuard: (): GuardLike => {
    throw new Error('bridge.ensureGuard 未装配');
  },
  /** 启动失败处理（boot 域；真实实现返回 void，见 lib/boot.ts）。 */
  handleBootFailure: (_err: unknown): void => {
    log('bridge', 'handleBootFailure 未装配');
  },
  /** 插件市场排队任务执行（plugins 域）。 */
  processPendingMarketOps: (): Promise<unknown> => {
    log('bridge', 'processPendingMarketOps 未装配');
    return Promise.resolve();
  },
  /** 配套插件同步（plugins 域）。 */
  syncCompanionPlugins: (): void => {
    log('bridge', 'syncCompanionPlugins 未装配');
  },
  /** profile 模块阴影修复（plugins 域）。 */
  healProfileModules: (): void => {
    log('bridge', 'healProfileModules 未装配');
  },
  /** 恢复保留的构建产物（plugins 域）。 */
  restoreKeptArtifacts: (_profile: string): Promise<unknown> => {
    log('bridge', 'restoreKeptArtifacts 未装配');
    return Promise.resolve();
  },
  /** 退出行为读取（tray 域，Task 3 起 window 域的 close handler 消费）。 */
  getExitAction: (): string => {
    log('bridge', 'getExitAction 未装配');
    return 'ask';
  },
  /** 退出确认弹窗（tray 域）。 */
  askExitAction: (): Promise<string> => {
    log('bridge', 'askExitAction 未装配');
    return Promise.resolve('quit');
  },
  /** 托盘气泡提示（tray 域）。 */
  trayHintOnce: (): void => {
    log('bridge', 'trayHintOnce 未装配');
  },
  /** agent 更新流（更新域，Task 5 提取；托盘/菜单消费）。 */
  runUpdateFlow: (manual: boolean): Promise<void> => {
    log('bridge', 'runUpdateFlow 未装配');
    return Promise.resolve();
  },
  /** 客户端更新流（更新域，Task 5 提取；托盘/菜单消费）。 */
  runClientUpdateFlow: (manual: boolean): Promise<void> => {
    log('bridge', 'runClientUpdateFlow 未装配');
    return Promise.resolve();
  },
};

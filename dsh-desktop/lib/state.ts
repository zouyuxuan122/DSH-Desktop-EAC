/**
 * lib/state.ts — 隔离体系共享可变状态单例（vnext-absorb 自重构版 state.ts 裁剪）。
 *
 * 重构版整套 supervisor/extension-host 模块以 `../state.js` 的 `state` 单例承载
 * 共享状态；本地 Tauri 三层架构下，这些模块跑在 L2 sidecar（纯 Node、零
 * electron），因此这里只保留隔离体系实际消费的字段，由 sidecar 的 boot 链在
 * 启动时经 initVNextState() 注入真实值（与 lib/desktop 各模块的 ctx 注入同构，
 * 但 supervisor 模块按重构版原样走模块级单例，不做逐模块改造）。
 *
 * 约定：不承载窗口/托盘等 L1 状态（那些在 Rust 壳）；serverProc 仅作只读
 * 探测（回滚前检查服务是否在跑），boot-server 模块状态才是权威。
 */

export interface EacBridgeState {
  url: string;
  token: string;
  close(): void;
}

export interface VNextState {
  /** 有效的 DSH_HOME（dsh 主目录，extensions/ 注册表根）。 */
  dshHome: string;
  /** 桌面端 userData 目录（诊断 zip / 日志定位）。 */
  userDataDir: string;
  /** 日志目录（desktop.log / dsh-web.log）。 */
  logsDir: string;
  /** 应用是否正在退出（恢复中心 / 宿主管理器退出路径）。 */
  quitting: boolean;
  /** 强制退出标志（安全模式 relaunch 路径）。 */
  forceQuit: boolean;
  /** 服务是否正在重启（回滚动作的竞态护栏）。 */
  restartingServer: boolean;
  /** dsh web 服务进程（只读探测；权威状态在 lib/desktop/boot-server）。 */
  serverProc: unknown | null;
  /** Core Bridge 回环端点（URL + 一次性 token；null = 未启动）。 */
  eacBridge: EacBridgeState | null;
}

/** 隔离体系共享状态单例（初值全部为空/关闭态，boot 链注入）。 */
export const state: VNextState = {
  dshHome: '',
  userDataDir: '',
  logsDir: '',
  quitting: false,
  forceQuit: false,
  restartingServer: false,
  serverProc: null,
  eacBridge: null,
};

/** 由 sidecar boot 链注入真实路径（幂等；缺失字段保持原值）。 */
export function initVNextState(d: Partial<Pick<VNextState, 'dshHome' | 'userDataDir' | 'logsDir'>>): void {
  if (d.dshHome) state.dshHome = d.dshHome;
  if (d.userDataDir) state.userDataDir = d.userDataDir;
  if (d.logsDir) state.logsDir = d.logsDir;
}

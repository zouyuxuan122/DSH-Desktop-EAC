/**
 * renderer-recovery.ts — 渲染进程崩溃/挂起自恢复状态机（Issue #9 根治修复
 * 核心模块）门面（Task 14 拆分后保留原模块路径）。
 *
 * 背景：renderer 以 0xC0000005（ACCESS_VIOLATION）等异常退出后，旧实现只在
 * 三处 render-process-gone 处理器里记录日志、没有任何恢复动作，窗口永久
 * 黑屏/白屏，用户只能强制退出。本模块族为「主窗 + 会话浮窗」提供统一自恢复：
 *
 *   · render-process-gone（crashed / killed / oom / …）→ 指数退避重新加载
 *   · 连续失败第 3 次 → 主窗销毁重建 BrowserWindow；浮窗直接关闭
 *   · 失败超过上限 → 主窗切到本地错误页（重载/重启/看日志按钮）+ 系统通知；
 *     绝不允许无限崩溃循环
 *   · unresponsive / 心跳丢失（AppHangB1 挂起）→ 宽限期后强制终结 renderer，
 *     复用同一条恢复路径
 *   · did-fail-load（连接失败等）→ 服务进程健在时退避重试（覆盖插件市场
 *     重启服务的间隙）；服务进程已退出时不动作，交给既有
 *     「DSH 服务已停止」对话框接管，避免双弹窗
 *   · 只有页面加载成功后「稳定存活 30 秒」才清零故障计数 —— 防止
 *     「加载即崩溃」的场景每次加载成功都重置计数造成无限快速循环
 *   · clean-exit / 退出中 / 窗口已销毁 一律不触发恢复
 *
 * 设计约束：本模块族不 require('electron')，全部副作用经注入回调完成，
 * 状态机决策函数纯函数化导出，便于 node:test 单元测试与
 * DSH_DESKTOP_TEST 集成测试直接验证。
 *
 * 实现拆分（Task 14 规模约束，公开面不变）：
 *   · lib/renderer-recovery/policy.ts  类型 + DEFAULT_OPTS + 纯决策函数
 *   · lib/renderer-recovery/load.ts    带超时与在途标记的受控加载
 *   · lib/renderer-recovery/machine.ts RendererRecovery 状态机本体
 */

export {
  RendererRecovery,
} from './lib/renderer-recovery/machine.js';
export {
  DEFAULT_OPTS,
  computeBackoff,
  nextAction,
} from './lib/renderer-recovery/policy.js';
export type {
  RecoveryOpts,
  WindowKind,
  RecoveryAction,
  LoadTarget,
  FailureRecord,
  RecoveryWindow,
  RendererRecoveryDeps,
} from './lib/renderer-recovery/policy.js';

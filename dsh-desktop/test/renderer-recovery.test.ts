// renderer-recovery（Electron 渲染进程崩溃/挂起自恢复状态机，上游 Issue #9）
// 已随 Electron 冻结壳退役（批次 C）。Tauri WebView2 崩溃走 sidecar
// rescue-integration + 恢复中心（recovery-center-preload 的 rc.action/rc.close），
// 由 rescue-smoke 与 recovery-center 测试覆盖。本文件保留为退役留档
// （防误删测试组件）。
import { test } from 'node:test';

test.skip('renderer-recovery 状态机（已随 Electron 壳退役，由救援链替代）', () => {});
// watchdog.js（Electron 主进程崩溃守护，分离进程轮询父 PID 决定重启）已随
// Electron 冻结壳退役（批次 C）。Tauri 侧等价能力：sidecar rescue-integration
// 的崩溃计数 + Rust 壳 died 页 + 恢复中心（rescue-smoke 16/16 覆盖 run-state /
// 重启 / 救援链）。本文件保留为退役留档（防误删测试组件）。
import { test } from 'node:test';

test.skip('watchdog 子进程行为（已随 Electron 壳退役，由 rescue 链替代）', () => {});
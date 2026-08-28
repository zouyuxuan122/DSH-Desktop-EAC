// session-encoding-heal.ts（Electron 守护启动 preRetry 里的会话编码冲突自愈，
// Issue #77）已随 Electron 冻结壳退役（批次 C）：该文件仅被 main.js 引用，
// Tauri 运行时无调用者。本文件保留为退役留档（防误删测试组件）。
import { test } from 'node:test';

test.skip('session-encoding-heal 编码冲突自愈（已随 Electron 壳退役）', () => {});
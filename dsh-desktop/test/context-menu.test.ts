// Electron V4 右键菜单（attachEditContextMenu）接线回归已随 Electron 冻结壳退役
// （批次 C：main.js / electron-builder 整链删除）。Tauri WebView2 使用系统默认
// 上下文菜单，壳层无自定义右键菜单。本文件保留为退役留档（防误删测试组件）。
import { test } from 'node:test';

test.skip('Electron 右键菜单接线（已随壳退役，Tauri 用系统默认菜单）', () => {});
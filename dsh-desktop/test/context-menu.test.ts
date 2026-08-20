// V4 右键菜单（浏览器风格）接线回归：attachEditContextMenu 覆盖四类场景，
// 且主窗与浮窗都挂接。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Task 3：attachEditContextMenu 与 createWindow/createFloatWindow 迁
// lib/window.ts；main.js 经 require 接线。
const windowSrc = readFileSync(join(root, 'lib', 'window.ts'), 'utf8');
const mainSrc = readFileSync(join(root, 'main.js'), 'utf8');

test('attachEditContextMenu 定义完整：编辑/图片/选区/导航四类场景', () => {
  const i = windowSrc.indexOf('export function attachEditContextMenu');
  assert.ok(i > 0, 'attachEditContextMenu 应存在于 lib/window.ts');
  const body = windowSrc.slice(i, windowSrc.indexOf('\n}', i) + 2);
  // 编辑菜单七项 + 分隔（用户反馈截图中的完整列表）
  for (const [label, role] of [
    ['撤销', 'undo'], ['重做', 'redo'], ['剪切', 'cut'], ['复制', 'copy'],
    ['粘贴', 'paste'], ['删除', 'delete'], ['全选', 'selectAll'],
  ]) {
    assert.match(body, new RegExp(`label: '${label}', role: '${role}'`), `缺少菜单项 ${label}`);
  }
  assert.match(body, /flags\.canUndo !== false/, 'enabled 应跟随 editFlags');
  // 图片场景
  assert.match(body, /mediaType === 'image'/);
  assert.match(body, /copyImageAt/);
  assert.match(body, /downloadURL/);
  // 导航场景（Task 3 TS 化：新版 Electron 类型移除 role:'back'/'forward'，
  // 改为等价的显式 goBack/goForward click；语义不变。）
  assert.match(body, /goBack/);
  assert.match(body, /goForward/);
  assert.match(body, /role: 'reload'/);
  // 弹窗定位到事件坐标
  assert.match(body, /popup\(\{ window: win, x: params\.x, y: params\.y \}\)/);
});

test('主窗与浮窗都挂接右键菜单', () => {
  const occurrences = windowSrc.match(/attachEditContextMenu\(/g) || [];
  assert.ok(occurrences.length >= 3, '定义 + 主窗 + 浮窗至少 3 处引用，实际 ' + occurrences.length);
  // Task 1.1：顶层状态迁 lib/state.ts 单例后，主窗引用统一为 state.mainWindow。
  assert.match(windowSrc, /attachEditContextMenu\(state\.mainWindow\.webContents\)/, '主窗挂接');
  assert.match(windowSrc, /attachEditContextMenu\(win\.webContents\)/, '浮窗挂接');
  // Task 3：main.js 经 lib/window.js 接线（打包产物存在性由 bundled-files 守护）。
  // Task 7：main.js 为 tsc 编译产物（双引号 require）；源码 main.ts 为 ESM import。
  assert.ok(/require\(['"]\.\/lib\/window\.js['"]\)/.test(mainSrc), 'main.js must require lib/window.js');
});

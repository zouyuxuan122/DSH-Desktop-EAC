import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 防呆（v3.0.0 升级弹窗 "Failed to uninstall old application files: 2" 的
// Tauri 版）：旧 Electron installer.nsh 的 customInit 用「取 $INSTDIR 尾部 N
// 字符再与字面量比较」判断是否以产品目录名结尾（dshTakeoverWipe）——
// "\Deepseek Harness EAC" 是 21 字符而 StrCpy 用了 -22，比较永不相等 →
// 接管清理从不触发。Tauri 接管（installer-hooks.nsh DSH_TakeoverOldShell）
// 走注册表卸载键，不经 $INSTDIR 尾串比较——本测试锁定 hooks 中不存在该
// 脆弱模式，防回归。

const nsh = fs.readFileSync(join(root, 'tauri-shell', 'installer-hooks.nsh'), 'utf8');
const lines = nsh.split(/\r?\n/);

test('installer-hooks 不使用 $INSTDIR 尾串长度比较（接管走注册表键）', () => {
  const fragile = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/StrCpy\s+\$(\w+)\s+\$INSTDIR\s+""\s+-(\d+)/);
    if (m) fragile.push({ line: i + 1, n: m[2] });
  }
  assert.deepEqual(fragile, [], `发现 $INSTDIR 尾串比较（v3.0.0 事故模式）: ${JSON.stringify(fragile)}`);
});

test('接管存在且走注册表卸载键（DSH_TakeoverOldShell）', () => {
  assert.match(nsh, /!macro DSH_TakeoverOldShell/, '接管宏缺失');
  assert.match(nsh, /ReadRegStr\s+\$0.*UninstallString/, '应读取旧壳卸载键');
});
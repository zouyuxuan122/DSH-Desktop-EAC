// Tauri 安装器旧版本接管（tauri-shell/installer-hooks.nsh；原 Electron
// build/installer.nsh 契约随壳退役，接管为 hooks 等价断言）：
//  1. 接管 = 自静默卸载旧壳（HKCU/HKLM 双 hive × 三个候选卸载键全覆盖），
//     卸载器缺失的脏键仅清理注册表，绝不让安装流程卡死（issue #7/#8 的
//     Tauri 版本）；
//  2. UninstallString 剥引号 + 安装目录尾反斜杠剥除（R6 实测复现）；
//  3. 清理前先按镜像名终结旧进程树，句柄释放缓冲后接管。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const nsh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tauri-shell', 'installer-hooks.nsh'), 'utf8');

test('接管旧壳：HKCU/HKLM 双 hive × 三个候选卸载键全覆盖', () => {
  const takes = nsh.match(/!insertmacro DSH_TakeoverOldShell \w+ "[^"]+"/g) || [];
  assert.equal(takes.length, 6, `应接管 6 次（2 hive × 3 键），实际 ${takes.length}`);
  for (const key of ['Deepseek Harness EAC', 'com.deepseek.dsh.desktop', 'com.deepseek.dsh.desktop.tauri']) {
    assert.ok(takes.some((t) => t.startsWith('!insertmacro DSH_TakeoverOldShell HKCU "' + key + '"')), `HKCU ${key} 缺失`);
    assert.ok(takes.some((t) => t.startsWith('!insertmacro DSH_TakeoverOldShell HKLM "' + key + '"')), `HKLM ${key} 缺失`);
  }
});

test('接管落点：读旧壳卸载信息并清理注册表脏键', () => {
  assert.match(nsh, /ReadRegStr\s+\$0\s+\$\{HIVE\}.*UninstallString/, '应读取 UninstallString');
  assert.match(nsh, /DeleteRegKey\s+\$\{HIVE\}.*Uninstall\\\$\{KEYNAME\}/, '应清理旧壳卸载键');
});

test('卸载器路径剥引号 + 安装目录尾反斜杠防御（R6 实测契约）', () => {
  assert.match(nsh, /StrCpy \$4 \$3 1/, '应取首字符判引号');
  assert.match(nsh, /StrCpy \$3 \$3 "" 1/, '应剥 UninstallString 引号');
  assert.match(nsh, /StrCpy \$2 \$1 1 -1/, '应剥 InstallLocation 尾反斜杠');
  assert.ok(nsh.includes('_?='), '卸载器目录参数必须裸写 _?=（不加引号，实测退出码 2 事故回归）');
});

test('清理旧壳前先终结其进程树（taskkill /F /T）', () => {
  assert.match(nsh, /taskkill \/F \/T \/IM "/);
});
// 防呆（v4.2 用户反馈问题 1 的 Tauri 版）：安装版自更新/升级时不得因
// nsExec 管道读挂死（原 Electron installer.nsh 的 customCheckAppRunning 契约，
// 安装器模板已随壳退役）。Tauri 安装钩子（tauri-shell/installer-hooks.nsh）
// 的等同面：PREINSTALL 用无管道的 taskkill 终结运行中的应用进程树（nsExec
// 直接 CreateProcess，不经 cmd.exe），并保留有界等待（Sleep 2000 后继续）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const nsh = fs.readFileSync(join(root, 'tauri-shell', 'installer-hooks.nsh'), 'utf8');

test('installer-hooks：PREINSTALL 不得使用 cmd 管道 / find / nsProcess', () => {
  assert.ok(!/cmd\s*\/c/i.test(nsh), '不得经 cmd.exe 起管道');
  assert.ok(!/nsProcess::/i.test(nsh), '不得使用 nsProcess 插件');
  assert.ok(!/\|/.test(nsh), '不得出现任何管道符（nsExec ExecToLog 直连 taskkill）');
});

test('installer-hooks：升级前终结运行中的 dsh 进程树（taskkill /F /T 两壳 exe）', () => {
  for (const exe of ['dsh-eac-shell.exe', 'Deepseek Harness EAC.exe']) {
    assert.ok(nsh.includes(`!insertmacro DSH_KillAppExe "${exe}"`), `PREINSTALL 应终结 ${exe}`);
  }
  assert.match(nsh, /nsExec::ExecToLog\s+'taskkill \/F \/T \/IM "\$\{EXENAME\}"'/, 'KillAppExe 应有 taskkill /F /T 模板');
});

test('installer-hooks：等待循环保留有界语义（句柄释放缓冲后继续）', () => {
  assert.ok(/Sleep\s+2000/.test(nsh), '进程终止后应有 Sleep 缓冲，避免立即撞文件锁');
});
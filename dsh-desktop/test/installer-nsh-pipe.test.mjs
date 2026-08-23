import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 防呆（v4.2，用户反馈问题 1）：安装版自更新时 black window 挂死。
// 根因：customCheckAppRunning 用 `nsExec::Exec 'cmd /C tasklist ... | find /I ...'`
// 每轮开 3 个隐藏 cmd 管道查进程。nsExec 在无控制台的 NSIS 上下文中管道
// 读取偶发永不返回，表现为安装界面「卡住、关掉黑窗又弹新窗」。
// 本测试静态断言：customCheckAppRunning 不再出现任何 cmd 管道 / find /
// nsProcess（electron-builder 自带 NSIS 加载不了其函数，编译即报
// "Plugin function not found"），只允许无管道的单进程 tasklist /FI 探测
// （nsExec 直接 CreateProcess，不经 cmd.exe），且保留有界等待
// （最多 ~10s 后放行）。

const nsh = fs.readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
const lines = nsh.split(/\r?\n/);

const APPS = ['Deepseek Harness EAC.exe', 'Deepseek Harness EAC v2.0.exe', 'Deepseek Harness EAC v1.0.exe'];

function macroBlock() {
  const start = lines.findIndex((l) => l.includes('!macro customCheckAppRunning'));
  const end = lines.findIndex((l, i) => i > start && l.trim() === '!macroend');
  assert.ok(start >= 0, 'customCheckAppRunning 宏应存在');
  assert.ok(end > start, 'customCheckAppRunning 宏应有结束');
  return lines.slice(start, end + 1).join('\n');
}

test('installer.nsh：customCheckAppRunning 不得使用 cmd 管道 / find / nsProcess', () => {
  const block = macroBlock();
  assert.ok(!/\|\s*find\b/i.test(block), '不得出现 | find 管道');
  assert.ok(!/cmd\s*\/c/i.test(block), '不得再经 cmd.exe 起管道');
  assert.ok(!/nsProcess::/i.test(block), '不得使用 nsProcess（electron-builder 自带 NSIS 无法加载）');
  assert.ok(!/\|/.test(block), '不得出现任何管道符');
});

test('installer.nsh：用无管道 tasklist /FI 探测三个 exe 名（/FO CSV /NH 输出）', () => {
  const block = macroBlock();
  for (const app of APPS) {
    assert.ok(block.includes(`IMAGENAME eq ${app}`),
      `应存在 tasklist /FI "IMAGENAME eq ${app}" 探测`);
  }
  assert.ok(/\/FO CSV \/NH/.test(block), '应使用 CSV 无表头输出');
  assert.ok(block.split('\n').filter((l) => l.includes('ExecToStack')).length >= 3,
    '每个 exe 名应各探测一次（3 次 ExecToStack）');
});

test('installer.nsh：等待循环保留有界语义（最多约 10s 后放行）', () => {
  const block = macroBlock();
  assert.ok(/\$1\s*>\s*20/.test(block), '应有 $1 > 20 的轮数上限');
  assert.ok(/Sleep\s+500/.test(block), '应有 Sleep 500 节流');
  assert.ok(/did not exit; continuing anyway/.test(block), '超时应放行继续安装（不卡死）');
});

// v4.4（PR79 集成回归）：customUnInstall 的「是否同时删除用户数据」
// MessageBox 必须带 /SD IDNO。NSIS 静默模式（uninstall /S，注册表里
// QuietUninstallString 就长这样）下 MessageBox 自动按第一按钮应答 ——
// MB_YESNO 的第一按钮是 IDYES（MB_DEFBUTTON2 只移动 UI 焦点），静默
// 卸载会径直走进 dshUnWipe 删掉 %APPDATA%\Deepseek Harness EAC 与
// %USERPROFILE%\.dsh（设置、登录态、全部对话记录）。/SD IDNO 让静默
// 卸载与 UI 默认一致：保留用户数据。
function unInstallBlock() {
  const start = lines.findIndex((l) => l.includes('!macro customUnInstall'));
  const end = lines.findIndex((l, i) => i > start && l.trim() === '!macroend');
  assert.ok(start >= 0, 'customUnInstall 宏应存在');
  assert.ok(end > start, 'customUnInstall 宏应有结束');
  return lines.slice(start, end + 1).join('\n');
}

test('installer.nsh：customUnInstall 的删数据确认必须带 /SD IDNO（静默卸载不删用户数据）', () => {
  const block = unInstallBlock();
  const mb = block.match(/MessageBox[^\n]*/);
  assert.ok(mb, 'customUnInstall 应有 MessageBox 确认');
  assert.ok(/MB_YESNO/.test(mb[0]), '应是 YES/NO 二选一');
  assert.ok(/\/SD\s+IDNO/.test(block), 'MessageBox 必须带 /SD IDNO —— 否则静默卸载自动应答 IDYES 删光用户数据');
  assert.ok(/dshUnWipe/.test(block) && /dshUnKeep/.test(block), 'YES/NO 两条分支应保留');
});
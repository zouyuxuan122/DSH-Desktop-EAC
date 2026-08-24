'use strict';
// 4.4.1（Electron）→ 5.1.0（Tauri）升级路径端到端验证 v2：
//   1) 静默装 4.4.1 → 键指向 Programs、树就位
//   2) 启动 4.4.1 模拟「升级时应用还在运行」（用户实测：宠物 webm 被占用）
//   3) 静默装 5.1.0 → PREINSTALL 杀进程树 + 接管旧卸载器（继承原安装目录）
//   4) 断言（期望目录 = 4.4.1 键里的 InstallLocation，动态读取）：
//      键→新 Tauri 卸载器、新布局落地、内核 rc.2、旧 resources\app 清除、快捷方式在
// 全部注册表/目录检查走 PowerShell（reg.exe 经 Git Bash 转义不可靠）。
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');

const OLD_SETUP = process.argv[2];
const NEW_SETUP = process.argv[3];
if (!OLD_SETUP || !NEW_SETUP) { console.error('用法: node upgrade-test-441.js <4.4.1-setup> <5.1.0-setup>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

const ps = (script) => { try { return execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch (e) { return (e.stdout || '').trim(); } };
const keyProp = (prop) => ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Deepseek Harness EAC' -ErrorAction SilentlyContinue).${prop}`);
const unquote = (s) => String(s || '').trim().replace(/^"|"$/g, '');

async function run(setup) {
  return new Promise((resolve) => {
    const p = spawn(setup, ['/S'], { stdio: 'ignore' });
    p.on('exit', (code) => resolve(code));
    p.on('error', () => resolve(-1));
  });
}

async function main() {
  console.log('[upgrade-test] 前置检查');
  const preKey = unquote(keyProp('UninstallString'));
  check('初始无旧安装键', preKey === '', preKey.slice(0, 70));
  if (failures) { console.log('[upgrade-test] 环境不干净，中止'); process.exit(1); }

  console.log('[upgrade-test] 阶段 1：静默安装 4.4.1');
  await run(OLD_SETUP);
  let ok = false;
  for (let i = 0; i < 45 && !ok; i++) {
    const loc = unquote(keyProp('InstallLocation'));
    const un = unquote(keyProp('UninstallString'));
    ok = !!loc && !!un && fs.existsSync(loc) && fs.readdirSync(loc).some((f) => f.endsWith('.exe'));
    await sleep(2000);
  }
  const OLD_LOC = unquote(keyProp('InstallLocation'));
  check('4.4.1 卸载键 + 安装树就位', ok, `loc=${OLD_LOC}`);
  const v441 = keyProp('DisplayVersion');
  check('4.4.1 版本键', /^4\./.test(v441), 'v=' + v441);

  console.log('[upgrade-test] 阶段 2：启动 4.4.1（模拟升级时应用运行中）');
  const oldExe = fs.readdirSync(OLD_LOC).find((f) => /^Deepseek Harness EAC\.exe$/i.test(f));
  if (oldExe) { try { spawn(path.join(OLD_LOC, oldExe), [], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
  await sleep(9000);
  const running = ps(`(Get-Process 'Deepseek Harness EAC' -ErrorAction SilentlyContinue | Measure-Object).Count`);
  console.log('  (旧应用进程数: ' + running + ')');

  console.log('[upgrade-test] 阶段 3：静默安装 5.1.0（杀进程 + 接管）');
  const t0 = Date.now();
  const c3 = await run(NEW_SETUP);
  console.log('  (新安装器退出码 ' + c3 + '，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's)');

  console.log('[upgrade-test] 阶段 4：断言（期望目录 = 继承的 ' + OLD_LOC + '）');
  await sleep(4000);
  const EXP = OLD_LOC;
  const un = unquote(keyProp('UninstallString'));
  const ver = keyProp('DisplayVersion');
  check('卸载键已接管为 5.1.0', ver === '5.1.0', 'v=' + ver);
  check('卸载器指向新目录', un.includes(EXP) && /uninstall/i.test(un), un.slice(0, 90));
  check('新壳 exe 就位', fs.existsSync(path.join(EXP, 'dsh-eac-shell.exe')));
  check('新 sidecar 布局就位', fs.existsSync(path.join(EXP, 'sidecar', 'server.js')));
  const dshPkg = path.join(EXP, 'dsh-desktop', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  let kern = '';
  try { kern = JSON.parse(fs.readFileSync(dshPkg, 'utf8')).version; } catch {}
  check('安装树内核 = 0.1.1-rc.2', kern === '0.1.1-rc.2', 'got=' + kern);
  const oldGone = !fs.existsSync(path.join(EXP, 'resources', 'app', 'package.json'));
  check('旧 Electron resources\\app 已清除', oldGone);
  const sc = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Deepseek Harness EAC.lnk');
  check('开始菜单快捷方式存在', fs.existsSync(sc));
  const procLeft = ps(`(Get-Process 'Deepseek Harness EAC','dsh-eac-shell' -ErrorAction SilentlyContinue | Measure-Object).Count`);
  check('旧/新进程无残留运行冲突', Number(procLeft) === 0, 'procs=' + procLeft);

  console.log(failures === 0 ? '[upgrade-test] ALL PASS' : `[upgrade-test] ${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
}

const path = require('node:path');
void main();

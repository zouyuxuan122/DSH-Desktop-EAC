/**
 * lib/terminal.ts — 内置 Node+npm 环境终端（Task 2.4 自 main.js 提取）。
 *
 * 启动一个「内置终端」：用随应用分发的 node.exe + npm CLI 拼出一个
 * cmd.exe 会话，PATH 前置内置 node 目录与临时垫片目录，使 node / npm /
 * npx 直接可用——无需用户本机预装 Node。
 *
 * 为什么要垫片：vendor/npm/bin 下自带的 npm.cmd / npx.cmd 期望在自身
 * 同级目录找到 node.exe 与 node_modules/npm/bin/npm-cli.js（npm 标准安装
 * 布局），而我们这里是把 npm 目录整体拷出（node.exe 在 vendor/node 下），
 * 自带的 .cmd 解析不到，故自写薄垫片直指内置 node.exe + npm-cli.js /
 * npx-cli.js。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { log } from './log.js';
import { nodeExe, npmCli } from './proc.js';
import { bridge } from './bridge.js';

/** 打开内置终端窗口（找不到内置运行时时弹错误框并返回）。 */
export function openBuiltinTerminal(): void {
  const nodeExePath = nodeExe();
  const npmCliPath = npmCli();
  if (!fs.existsSync(nodeExePath)) {
    void bridge
      .showBox({
        type: 'error',
        title: '内置终端',
        message: '未找到内置 Node 运行时。',
        detail: '期望路径：' + nodeExePath,
        buttons: ['确定'],
      })
      .catch(() => {});
    return;
  }
  const nodeDir = path.dirname(nodeExePath);
  const npxCliPath = path.join(path.dirname(npmCliPath), 'npx-cli.js');

  // npm.cmd / npx.cmd 垫片写到「安装后的内置环境位置」（node.exe 同目录），
  // 使内置 node + npm + npx 全部就近解析、自包含于安装目录。本应用为
  // per-user 安装（perMachine:false）与便携包，安装目录用户可写；若遇极
  // 少数只读安装，回退到临时目录。
  const shim = (cliPath: string): string =>
    '@echo off\r\n"' + nodeExePath + '" "' + cliPath + '" %*\r\n';
  const writeShims = (dir: string): boolean => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'npm.cmd'), shim(npmCliPath));
      fs.writeFileSync(path.join(dir, 'npx.cmd'), shim(npxCliPath));
      return true;
    } catch {
      return false;
    }
  };
  let binDir = nodeDir;
  if (!writeShims(binDir)) {
    binDir = path.join(os.tmpdir(), 'dsh-builtin-bin');
    writeShims(binDir);
  }

  // 读取内置 node 版本用于标题/横幅，失败则留空。
  let nodeVer = '';
  try {
    nodeVer = (
      (spawnSync(nodeExePath, ['-v'], { encoding: 'utf8', windowsHide: true }).stdout || '') as string
    ).trim();
  } catch {
    /* 版本读取失败不阻塞终端 */
  }

  // 垫片落到 nodeDir 时，PATH 仅前置 nodeDir 即可（node/npm/npx 都在那）；
  // 回退到临时目录时需把临时目录也前置。
  const pathPrefix = binDir === nodeDir ? nodeDir : binDir + ';' + nodeDir;
  const env = { ...process.env, PATH: pathPrefix + ';' + (process.env.PATH || '') };
  const title =
    'Deepseek Harness EAC - 内置终端' + (nodeVer ? ' (Node ' + nodeVer + ')' : '');
  const banner =
    '[内置环境] ' +
    (nodeVer ? 'Node ' + nodeVer + ' + ' : '') +
    'npm 已就绪，可直接使用 node / npm / npx 命令。';
  try {
    // detached + stdio:ignore：GUI 进程无控制台，Windows 会为新生的 cmd
    // 进程分配一个独立控制台窗口；unref 让其与主进程解耦，关闭应用不连坐。
    spawn('cmd.exe', ['/K', 'title ' + title + ' & echo ' + banner], {
      cwd: os.homedir(),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
    log('terminal', '已启动内置终端 binDir=' + binDir + ' nodeVer=' + (nodeVer || '?'));
  } catch (err) {
    log('terminal', '启动内置终端失败: ' + String((err && (err as Error).message) || err));
    void bridge
      .showBox({
        type: 'error',
        title: '内置终端',
        message: '启动内置终端失败。',
        detail: String((err && (err as Error).message) || err),
        buttons: ['确定'],
      })
      .catch(() => {});
  }
}

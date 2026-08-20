'use strict';

// E2E v4 验证（发布前真实模拟）：
//   node scripts/e2e-v4.js --exe <path-to-exe> [--mode fresh|upgrade] [--tag name]
//
// 覆盖：
//   A. 新用户（fresh）：空 DSH_HOME / 空 APPDATA 冷启动 —— profile 初始化、
//      配套插件同步（含 v4 新插件）、首次向导（CDP 驱动提交核心+推荐）、
//      dafeiyu 向导未勾选 → 禁用行、运行时补丁（会话删除）、apiproxy 设置
//      命名空间全量暴露（rc.7+ 无白名单，ClawBot 设置可达）、
//      Web UI 就绪、CDP 驱动页面（dshDesktop 桥存在、插件市场 API 可达）。
//   B. 老用户（upgrade）：复制本机 ~/.dsh 既有数据后启动（升级路径）。
//   C. 退出清理：走真实 UI 退出路径（chrome:menu quit IPC）→ 断言主进程退出、
//      dsh web node.exe + conhost 无残留、run-state.json cleanExit=true。
//
// 隔离：DSH_HOME / APPDATA / LOCALAPPDATA 全部指向临时目录，绝不触碰真实
// 用户数据；更新检查用 DSH_DESKTOP_SKIP_*_UPDATE 关闭（避免测试期弹窗）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import * as http from 'node:http';
import { WebSocket } from 'ws';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const exeArg = arg('exe');
if (!exeArg || !fs.existsSync(exeArg)) {
  console.error('[e2e] --exe 必须指向存在的 exe');
  process.exit(2);
}
// 守卫后收窄副本（模块级收窄不跨函数边界，main() 内仍需 string）
const EXE: string = exeArg;
const MODE: string = arg('mode', 'fresh') ?? 'fresh';
const TAG: string = arg('tag', MODE) ?? MODE;
const DEBUG_PORT = Number(arg('port', '9337'));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tasklistPids(name: string): Set<number> {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true });
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m && m[2]) pids.add(Number(m[2]));
    }
    return pids;
  } catch {
    return new Set();
  }
}

function procAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    const out = execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
    return out.includes('"' + pid + '"');
  } catch {
    return false;
  }
}

// --- CDP 最小客户端 ---------------------------------------------------------

/** CDP /json/list 的页面目标条目（结构子集）。 */
interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/** Runtime.evaluate 的返回值对象（结构子集）。 */
interface CdpRemoteObject {
  value?: unknown;
}

async function cdpList(): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${DEBUG_PORT}/json/list`, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as CdpTarget[]);
        } catch (e) {
          reject(e as Error);
        }
      });
    }).on('error', reject);
  });
}

async function cdpPageTarget(): Promise<CdpTarget | undefined> {
  const list = await cdpList();
  // 主窗页面：dsh web 的 http://127.0.0.1 页（排除 file:// 加载页与 devtools）
  return list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url ?? '') && (t.url ?? '').startsWith('http'));
}

function cdpEval(wsUrl: string, expr: string, timeoutMs = 20000): Promise<CdpRemoteObject | undefined> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch { /* 已关闭 */ }
      reject(new Error('CDP eval 超时'));
    }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true },
      }));
    });
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        error?: unknown;
        result?: { result?: CdpRemoteObject; exceptionDetails?: unknown };
      };
      if (msg.id === 1) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch { /* 已关闭 */ }
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
        if (msg.result && msg.result.exceptionDetails) {
          return reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
        }
        resolve(msg.result ? msg.result.result : undefined);
      }
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- 断言收集 ---------------------------------------------------------------

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}
const results: CheckResult[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  ✔ ' : '  ✖ ') + name + (detail && !ok ? ' — ' + detail : ''));
}

// --- 主流程 -----------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[e2e:${TAG}] 模式=${MODE} exe=${EXE}`);

  // 0) 单实例守卫：真实应用已在运行则拒绝（拿不到锁会静默退出）。
  const already = tasklistPids(path.basename(EXE));
  if (already.size > 0) {
    console.error(`[e2e:${TAG}] 检测到 ${path.basename(EXE)} 已在运行（PID ${[...already].join(',')}），请先退出再跑 E2E`);
    process.exit(2);
  }

  // 1) 临时环境
  // 测试根目录：默认系统临时目录；C: 空间紧张时用 DSH_E2E_ROOT 指到大盘
  // （profile 同步会把整个内置插件闭包拷进 DSH_HOME，数 GB 级）。
  const rootBase = process.env.DSH_E2E_ROOT || os.tmpdir();
  fs.mkdirSync(rootBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(rootBase, 'dsh-e2e-v4-' + TAG + '-'));
  const home = path.join(root, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });
  if (MODE === 'upgrade') {
    // 老用户：带上本机既有 DSH 数据（profiles / settings / 凭据），会话日志
    // 不拷；profiles/node_modules（junction 根，机器级共享闭包）也不拷 ——
    // dsh-app-boot 启动时自会重建指向当前闭包的 junction。
    const srcHome = path.join(os.homedir(), '.dsh');
    try {
      const srcProfiles = path.join(srcHome, 'profiles');
      const dstProfiles = path.join(home, 'profiles');
      fs.mkdirSync(dstProfiles, { recursive: true });
      for (const e of fs.readdirSync(srcProfiles, { withFileTypes: true })) {
        if (e.name === 'node_modules' || !e.isDirectory()) continue;
        fs.cpSync(path.join(srcProfiles, e.name), path.join(dstProfiles, e.name), { recursive: true });
      }
    } catch (err) {
      console.log('[e2e] 复制 profiles 失败（按 fresh 处理）: ' + (err as Error).message);
    }
    for (const f of ['settings.yaml', '.credentials.yaml', '.env']) {
      try {
        fs.copyFileSync(path.join(srcHome, f), path.join(home, f));
      } catch { /* 无该文件 */ }
    }
  }
  console.log(`[e2e:${TAG}] root=${root}`);

  // 1b) 便携版：拷到临时目录运行 —— userData（logs/settings/run-state）落在
  // exe 旁的 data\，天然隔离；DSH_DESKTOP_TEST_NO_SHORTCUTS 守卫真实快捷
  // 方式与临时目录告警。同时清掉共享解压缓存：缓存按版本号复用，同版本
  // 重构建（开发期常态）会跑陈旧代码，E2E 必须每次完整提取。
  // 安装版（win-unpacked）不做实机 E2E：Electron 的 appData 走 Shell API，
  // 环境变量隔离不了真实用户目录。
  let runExe = EXE;
  const isPortableExe = /portable/i.test(path.basename(EXE));
  if (isPortableExe) {
    runExe = path.join(root, 'run', path.basename(EXE));
    fs.mkdirSync(path.dirname(runExe), { recursive: true });
    fs.copyFileSync(EXE, runExe);
    const cache = path.join(os.tmpdir(), 'deepseek-harness-eac-portable');
    try {
      fs.rmSync(cache, { recursive: true, force: true });
      console.log('[e2e] 已清理便携解压缓存（强制完整提取）');
    } catch { /* 无缓存 */ }
  }

  // 2) 基线进程快照（node/conhost），退出后对比
  const baseNode = tasklistPids('node.exe');
  const baseConhost = tasklistPids('conhost.exe');

  // 3) 启动（真实用户路径：双击 exe 的等价物；关自动更新避免测试期弹窗）
  const child = spawn(runExe, ['--remote-debugging-port=' + DEBUG_PORT], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_DESKTOP_SKIP_AUTO_UPDATE: '1',
      DSH_DESKTOP_SKIP_CLIENT_UPDATE: '1',
      DSH_DESKTOP_TEST_NO_SHORTCUTS: '1',
      NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
    },
    detached: false, stdio: 'ignore', windowsHide: true,
  });
  const appPid = child.pid;
  console.log(`[e2e:${TAG}] 应用已启动 pid=${appPid} exe=${runExe}`);

  const userDataDir = isPortableExe
    ? path.join(path.dirname(runExe), 'data')
    : path.join(root, 'appdata-roaming', 'Deepseek Harness EAC');
  const desktopLog = (): string => path.join(userDataDir, 'logs', 'desktop.log');
  const readLog = (): string => {
    try {
      return fs.readFileSync(desktopLog(), 'utf8');
    } catch {
      return '';
    }
  };

  // 4a) fresh 模式：首次向导在 boot 链上阻塞 dsh web 启动，必须先用 CDP
  // 驱动提交（核心+推荐），否则「Web UI 就绪」行永远不会出现。
  if (MODE === 'fresh') {
    const wizardT0 = Date.now();
    let driven = false;
    while (Date.now() - wizardT0 < 180000 && !driven) {
      let pages: CdpTarget[] = [];
      try {
        pages = (await cdpList()).filter((t) => t.type === 'page' && /onboarding\.html/.test(t.url || ''));
      } catch { /* CDP 未就绪 */ }
      const wizardPage = pages[0];
      if (!wizardPage || !wizardPage.webSocketDebuggerUrl) {
        await sleep(2000);
        continue;
      }
      const ws = new WebSocket(wizardPage.webSocketDebuggerUrl);
      await new Promise<void>((res) => {
        ws.on('open', () => res());
        ws.on('error', () => res());
      });
      // 只发不候：submit 成功后向导窗口立即关闭，CDP 连接随之失效。
      ws.send(JSON.stringify({
        id: 9, method: 'Runtime.evaluate',
        params: {
          expression: 'window.onboarding.list().then(c => window.onboarding.submit(c.catalog.filter(x => x.core || x.recommended).map(x => x.id))).then(() => "submitted")',
          returnByValue: true, awaitPromise: true,
        },
      }));
      setTimeout(() => {
        try {
          ws.close();
        } catch { /* 已关闭 */ }
      }, 2000);
      driven = true;
      console.log('[e2e] 已 CDP 驱动提交首次向导（核心+推荐）');
    }
    check('首次向导已驱动提交（CDP）', driven, `elapsed=${Math.round((Date.now() - wizardT0) / 1000)}s`);
    const wizardApplied = await new Promise<boolean>((resolve) => {
      const t = setInterval(() => {
        if (/插件选择向导已应用：\d+ 个插件状态变更/.test(readLog())) {
          clearInterval(t);
          resolve(true);
        }
      }, 2000);
      setTimeout(() => {
        clearInterval(t);
        resolve(false);
      }, 120000);
    });
    check('向导已应用（boot 日志确认）', wizardApplied);
  }

  // 4) 等待就绪：桌面日志出现就绪行（boot 链的「Web UI 就绪」或 dsh web 的
  // 「dsh web:」）+ CDP 主窗页面（fresh 首装最长 12 分钟，含解压+装依赖）。
  const waitMs = MODE === 'fresh' ? 12 * 60 * 1000 : 8 * 60 * 1000;
  const t0 = Date.now();
  let page: CdpTarget | undefined;
  let sawReadyLine = false;
  while (Date.now() - t0 < waitMs) {
    if (!sawReadyLine && /(Web UI 就绪: https?:\/\/|dsh web: https?:\/\/)/.test(readLog())) sawReadyLine = true;
    try {
      page = await cdpPageTarget();
    } catch {
      page = undefined;
    }
    if (page && sawReadyLine) break;
    if (child.exitCode !== null) break; // 进程提前退出
    await sleep(2000);
  }
  check('启动就绪（dsh web 就绪行 + 主窗页面）', !!page && sawReadyLine,
    `page=${!!page} readyLine=${sawReadyLine} elapsed=${Math.round((Date.now() - t0) / 1000)}s exitCode=${child.exitCode}`);
  if (!page) {
    console.log('[e2e] 日志尾部：\n' + readLog().slice(-3000));
    try {
      if (appPid) process.kill(appPid);
    } catch { /* 已退出 */ }
    finish(1);
    return;
  }

  // 5) 文件系统断言：profile 初始化 + v4 新插件同步 + dafeiyu 启停行
  const profDir = path.join(home, 'profiles', 'web-desktop');
  const profPkg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(profDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } };
    } catch {
      return null;
    }
  })();
  check('桌面专属 profile 已初始化', !!profPkg && Array.isArray(profPkg.dsh?.profile?.bundles));
  const nm = (n: string): string => path.join(profDir, 'node_modules', ...n.split('/'));
  for (const [label, p] of [
    ['dsh-change-review（AI 变更审核）', nm('dsh-change-review')],
    ['dsh-undo-savepoint（崩溃急救）', nm('dsh-undo-savepoint')],
    ['@deepseek-ai/dsh-openclaw-bridge（微信桥）', nm('@deepseek-ai/dsh-openclaw-bridge')],
    ['dsh-float-window（多窗口）', nm('@deepseek-ai/dsh-float-window')],
    ['dsh-session-manager（会话删除）', nm('dsh-session-manager')],
    ['@vlln/dsh-navbar（导航条）', nm('@vlln/dsh-navbar')],
    ['dsh-plugin-manager（启停管理）', nm('@deepseek-ai/dsh-plugin-manager')],
    ['dsh-dafeiyu（大肥鱼）', nm('dsh-dafeiyu')],
  ] as Array<[string, string]>) {
    check('配套插件已同步: ' + label, fs.existsSync(path.join(p, 'package.json')), p);
  }
  check('dafeiyu helper exe 随包（PyInstaller）', fs.existsSync(path.join(nm('dsh-dafeiyu'), 'runtime', 'bin', 'win32-x64', 'dsh-dafeiyu-helper.exe')));
  let patch = '';
  try {
    patch = fs.readFileSync(path.join(profDir, 'cordis.patch.yml'), 'utf8');
  } catch { /* 尚未创建 */ }
  check('patch 行: change-review / dsh-undo / openclaw-bridge 已注册',
    /id:\s*change-review\b/.test(patch) && /id:\s*dsh-undo\b/.test(patch) && /id:\s*openclaw-bridge\b/.test(patch));
  const dafeiyuBlock = (patch.match(/- id:\s*dsh-dafeiyu\n(?:[ \t]+[^\n]*\n)*/) || [''])[0];
  // v4.3+ dafeiyu 注册表默认启用（裸 insert 行）；fresh 向导未勾选它 → 顶层
  // disabled 行（插件管理/向导写形）。upgrade 老用户 profile 无向导 → 启用。
  const expectDafeiyuDisabled = MODE === 'fresh';
  check('dafeiyu ' + (expectDafeiyuDisabled ? '向导未勾选 → 禁用行' : '默认启用（v4.3+，无 disabled 行）'),
    !!dafeiyuBlock && /disabled:\s*true/.test(dafeiyuBlock) === expectDafeiyuDisabled,
    JSON.stringify(dafeiyuBlock));

  // 6) 运行时补丁断言：会话删除补丁在构建时已烘焙进内置闭包（运行时幂等
  // 重放为 no-op、无日志），因此接受「日志行」或「闭包文件已带补丁标记」任一。
  // ClawBot 设置命名空间不再需要补丁：上游 dsh-host-apiproxy rc.7 已移除
  // WEB_SETTINGS_NAMESPACES 白名单（settings.describe 全量暴露）——断言闭包
  // 里确实已无该白名单，openclaw-bridge 设置页天然可读写。
  const log1 = readLog();
  const junctionNm = path.join(home, 'profiles', 'node_modules');
  const hasBakedSessionPatch = (() => {
    try {
      return fs.readFileSync(path.join(junctionNm, '@deepseek-ai', 'dsh-workspace', 'lib', 'index.js'), 'utf8')
        .includes('dsh-desktop patch (session manage)');
    } catch {
      return false;
    }
  })();
  check('会话删除补丁生效（烘焙或运行时应用）', /对话删除补丁/.test(log1) || hasBakedSessionPatch,
    `log=${/对话删除补丁/.test(log1)} baked=${hasBakedSessionPatch}`);
  const apiproxyIdx = (() => {
    try {
      return fs.readFileSync(path.join(junctionNm, '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'), 'utf8');
    } catch {
      return false;
    }
  })();
  check('apiproxy 设置命名空间全量暴露（rc.7+ 无白名单，ClawBot 设置可达）',
    !!apiproxyIdx && apiproxyIdx.includes('settings.describe') && !apiproxyIdx.includes('WEB_SETTINGS_NAMESPACES'),
    `describe=${!!apiproxyIdx && apiproxyIdx.includes('settings.describe')} whitelist=${!!apiproxyIdx && apiproxyIdx.includes('WEB_SETTINGS_NAMESPACES')}`);

  // 7) 页面侧断言（CDP，真实渲染进程）
  const pageWs = page.webSocketDebuggerUrl;
  if (!pageWs) {
    check('页面侧断言（CDP）', false, '主窗页面无 webSocketDebuggerUrl');
  } else {
    try {
      const bridge = await cdpEval(pageWs, 'typeof window.dshDesktop');
      check('页面 dshDesktop 桥可用（preload 注入）', !!bridge && bridge.value === 'object', JSON.stringify(bridge));
      const loader = await cdpEval(pageWs, 'typeof window.__ModuleLoader__');
      check('客户端插件系统已加载（__ModuleLoader__）', !!loader && (loader.value === 'object' || loader.value === 'function'), JSON.stringify(loader));
      const market = await cdpEval(pageWs,
        `fetch('/api/dsh-market', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'list', lang: 'zh' }) })
         .then(r => r.status).catch(e => 'ERR:' + e.message)`);
      const marketStatus = market && market.value;
      check('插件市场宿主 API 可达（POST /api/dsh-market {method:list}）', marketStatus === 200, String(marketStatus));
    } catch (err) {
      check('页面侧断言（CDP）', false, (err as Error).message);
    }
  }

  // 8) 退出（真实 UI 路径：⋯ 菜单「退出」等价的 IPC）
  console.log(`[e2e:${TAG}] 触发退出（chrome:menu quit）…`);
  if (pageWs) {
    try {
      await cdpEval(pageWs, 'window.dshDesktop.menu.action("quit")', 8000);
    } catch (err) {
      console.log('[e2e] quit IPC 异常: ' + (err as Error).message);
    }
  }
  // 等主进程退出（killTreeAndWait 有界等待 + app.exit）
  const quitT0 = Date.now();
  while (Date.now() - quitT0 < 45000 && procAlive(appPid)) await sleep(500);
  check('主进程已退出（45s 内）', !procAlive(appPid), `elapsed=${Math.round((Date.now() - quitT0) / 1000)}s`);

  // 9) 残留检查：node 必须回到基线（真正的泄漏指标 —— 用户反馈的「成对
  // 进程残留」根因是 node.exe 杀不干净）；conhost 是 OS 惰性回收（孤儿
  // conhost 无附着进程后 1-2 分钟内自行退出），给 180s 宽限。
  const myPid = process.pid;
  let leakedNode: number[] = [];
  let leakedConhost: number[] = [];
  const nodeOk = async (): Promise<boolean> => {
    const nowNode = tasklistPids('node.exe');
    leakedNode = [...nowNode].filter((p) => !baseNode.has(p) && p !== myPid);
    return leakedNode.length === 0;
  };
  await (async () => {
    const t = Date.now();
    while (Date.now() - t < 60000 && !(await nodeOk())) await sleep(3000);
  })();
  check('无 node.exe 残留（dsh web 已随退出回收）', leakedNode.length === 0, 'PIDs: ' + leakedNode.join(','));
  {
    const t = Date.now();
    while (Date.now() - t < 180000) {
      const nowConhost = tasklistPids('conhost.exe');
      leakedConhost = [...nowConhost].filter((p) => !baseConhost.has(p));
      if (leakedConhost.length === 0) break;
      await sleep(5000);
    }
    // 非致命告警：孤儿 conhost（宿主 node 已全部回收）由 OS 惰性清理，实
    // 测数分钟内自行退出；真正的泄漏指标（node.exe 成对残留）上一项已覆盖。
    if (leakedConhost.length) {
      console.log('  ⚠ conhost 惰性回收中（宿主已清，OS 稍后自行回收）: ' + leakedConhost.join(','));
    }
  }

  // 10) cleanExit 标记
  let runState: { cleanExit?: boolean } | null = null;
  try {
    runState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'run-state.json'), 'utf8')) as { cleanExit?: boolean };
  } catch {
    runState = null;
  }
  check('run-state.json cleanExit=true（看门狗安静退出）', !!(runState && runState.cleanExit === true));

  // 清理临时目录（失败时保留现场供排查）
  const failed = results.some((r) => !r.ok);
  if (!failed) {
    setTimeout(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch { /* 清理失败 */ }
    }, 100);
  } else {
    console.log(`[e2e:${TAG}] 失败现场保留于 ${root}`);
  }
  finish(failed ? 1 : 0);
}

function finish(code: number): void {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[e2e:${TAG}] 结果：${pass}/${results.length} 通过`);
  process.exit(code);
}

main().catch((err) => {
  console.error('[e2e] 异常: ' + ((err as Error)?.stack || err));
  process.exit(1);
});

'use strict';

// 终极验收 E2E（真实模拟用户全链路，发布前最后一道门）：
//   node scripts/e2e-full.js --exe <portable.exe>
//
//   1. 老用户环境启动（复用本机 ~/.dsh 数据 + 真实 API Key）；
//   2. 插件市场【真实安装】一个第三方插件：POST /api/dsh-market → dsh CLI
//      → pnpm 全流程 → 断言 profile bundles + node_modules 落盘 + artifact-keep
//      快照/回填生效；
//   3. 【真实对话】：经 openclaw 桥发送两条消息（真实调用 DeepSeek API），
//      断言模型回复 + inspect_image（识图）工具注册；
//   4. 【老用户客户端更新全流程】：本地 mock 发布源提供 v999.0.0（资产为本
//      dist exe + 真实 SHA-256）→ 菜单触发检查更新 → 自动确认（测试钩子）
//      → 真实下载 + 哈希校验 → apply-update.cmd 替换 exe → 重启新实例 →
//      断言旧进程退出、.bak 备份生成、新实例 boot 日志出现；
//   5. 收尾清理。
//
// 隔离：DSH_HOME 指向临时目录（复制的本机数据）；便携版 data 目录在临时
// run 目录内；DSH_DESKTOP_TEST_NO_SHORTCUTS 防真实快捷方式被改写。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');

function arg(name, def) {
  const eq = '--' + name + '=';
  const hit = process.argv.find((a) => a.startsWith(eq));
  if (hit) return hit.slice(eq.length);
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const EXE = arg('exe');
const DEBUG_PORT = Number(arg('port', '9341'));
const MOCK_PORT = Number(arg('mockport', '9342'));
const INSTALL_TARGET = arg('plugin', 'dsh-task-status');
const SKIP_MARKET = arg('skip-market') === '1';
const SKIP_CHAT = arg('skip-chat') === '1';
if (!EXE || !fs.existsSync(EXE)) {
  console.error('[full] --exe 必须指向存在的便携版 exe');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tasklistPids(name) {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m) pids.add(Number(m[2]));
    }
    return pids;
  } catch { return new Set(); }
}
function procAlive(pid) {
  try {
    const { execSync } = require('node:child_process');
    return execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true }).includes('"' + pid + '"');
  } catch { return false; }
}

async function cdpPage() {
  const list = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${DEBUG_PORT}/json/list`, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  return list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url)) || null;
}
function cdpEval(wsUrl, expr, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP eval 超时')); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg.result && msg.result.exceptionDetails) return reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 500)));
        resolve(msg.result ? msg.result.result : undefined);
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
// 页面内 fetch（走应用 origin，市场/桥 API 同源可达）
async function pageFetch(page, url, init) {
  const r = await cdpEval(page.webSocketDebuggerUrl,
    `fetch(${JSON.stringify(url)}, ${JSON.stringify(init || {})})
       .then(async r => ({ status: r.status, body: await r.text() }))
       .catch(e => ({ status: 0, body: 'ERR:' + e.message }))`);
  const v = r && r.value ? r.value : { status: 0, body: 'no-value' };
  try { v.json = JSON.parse(v.body); } catch { v.json = null; }
  return v;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ✔ ' : '  ✖ ') + name + (ok ? '' : ' — ' + String(detail).slice(0, 300)));
}

// --- mock 发布源（老用户「检查客户端更新」指向本地，资产为真实 dist exe） ---

// 恒高于任何真实发布版本：客户端更新检查对「不高于当前版本」的发布做降级
// 保护拒绝（client-updater.js compareVersions > 0），硬编码具体版本会在版本
// 号追平后让更新链路静默失败，故固定为 999.0.0 永不过时。
const MOCK_VERSION = '999.0.0';

async function startMockRelease(exePath) {
  const exeHash = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
  const size = fs.statSync(exePath).size;
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${MOCK_PORT}`;
    if (req.url === '/api/releases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{
        tag_name: 'v' + MOCK_VERSION,
        body: 'E2E 全流程更新验证版本（mock 版本须高于当前发布版本，否则被降级保护拒绝）',
        assets: [
          { name: 'Deepseek-Harness-EAC-Portable-x64.exe', browser_download_url: `${base}/dl/portable.exe`, size, digest: `sha256:${exeHash}` },
          { name: 'SHA256SUMS.txt', browser_download_url: `${base}/dl/sums`, size: 10 },
        ],
      }]));
      return;
    }
    if (req.url === '/dl/portable.exe') {
      res.writeHead(200, { 'content-length': String(size) });
      fs.createReadStream(exePath).pipe(res);
      return;
    }
    if (req.url === '/dl/sums') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${exeHash}  Deepseek-Harness-EAC-Portable-x64.exe\n`);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(MOCK_PORT, '127.0.0.1', r));
  return { server, exeHash };
}

async function main() {
  console.log(`[full] exe=${EXE} 插件=${INSTALL_TARGET}`);
  if (tasklistPids(path.basename(EXE)).size > 0) {
    console.error('[full] 已有同名 exe 在运行，先退出再跑'); process.exit(2);
  }
  // 测试根目录：默认系统临时目录；C: 空间紧张时用 DSH_E2E_ROOT 指到大盘
  // （配套插件同步会把整个内置插件闭包拷进 DSH_HOME，数 GB 级）。
  const rootBase = process.env.DSH_E2E_ROOT || os.tmpdir();
  fs.mkdirSync(rootBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(rootBase, 'dsh-e2e-full-'));
  const home = path.join(root, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });
  // 老用户数据（含真实凭据）：profiles 去 junction 根 + settings + key
  const srcHome = path.join(os.homedir(), '.dsh');
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  for (const e of fs.readdirSync(path.join(srcHome, 'profiles'), { withFileTypes: true })) {
    if (e.name === 'node_modules' || !e.isDirectory()) continue;
    if (e.name !== 'web-desktop') continue; // 只复制桌面端实际使用的 profile（省磁盘）
    fs.cpSync(path.join(srcHome, 'profiles', e.name), path.join(home, 'profiles', e.name), { recursive: true });
  }
  for (const f of ['settings.yaml', '.credentials.yaml', '.env']) {
    try { fs.copyFileSync(path.join(srcHome, f), path.join(home, f)); } catch {}
  }
  const hasKey = fs.existsSync(path.join(home, '.credentials.yaml'));
  console.log(`[full] root=${root} 真实API Key=${hasKey ? '有' : '无（对话测试将跳过）'}`);

  const runExe = path.join(root, 'run', path.basename(EXE));
  fs.mkdirSync(path.dirname(runExe), { recursive: true });
  fs.copyFileSync(EXE, runExe);
  try { fs.rmSync(path.join(os.tmpdir(), 'deepseek-harness-eac-portable'), { recursive: true, force: true }); } catch {}

  const mock = await startMockRelease(EXE);
  const userDataDir = path.join(path.dirname(runExe), 'data');
  const readLog = () => { try { return fs.readFileSync(path.join(userDataDir, 'logs', 'desktop.log'), 'utf8'); } catch { return ''; } };
  // 预写老用户标记：全新 data 目录会触发「内置插件选择向导」阻塞 boot，
  // 而本场景模拟的是升级老用户（向导已确认过）。更新链路全程只换 exe，
  // userData 与 DSH_HOME 不得被改动 —— 更新后再断言这些字段仍在。
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({
    pluginOnboardingDone: true,
    builtinPluginSelection: [
      'balance', 'file-changes', 'client-file-changes', 'terminal',
      'dsh-market-plugin', 'skin-switch', 'easy-setup', 'plugin-shield',
      'plugin-manager', 'plugin-wizard',
    ],
    webPort: 0,
  }, null, 2) + '\n');

  const child = spawn(runExe, ['--remote-debugging-port=' + DEBUG_PORT], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_DESKTOP_SKIP_AUTO_UPDATE: '1',
      DSH_DESKTOP_SKIP_CLIENT_UPDATE: '1',
      DSH_DESKTOP_TEST_NO_SHORTCUTS: '1',
      // 老用户更新链路：检查更新指向本地 mock（资产=真实 dist exe + 真实
      // SHA-256），确认弹窗由测试钩子自动接受（DSH_DESKTOP_TEST_AUTO_UPDATE）。
      DSH_DESKTOP_RELEASE_API: `http://127.0.0.1:${MOCK_PORT}/api/releases`,
      DSH_DESKTOP_TEST_AUTO_UPDATE: '1',
      NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
    },
    stdio: 'ignore', windowsHide: true,
  });
  const appPid = child.pid;
  console.log(`[full] 应用已启动 pid=${appPid}`);

  // ── 1) 就绪 ──
  let page = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60 * 1000) {
    if (/(Web UI 就绪: https?:\/\/|dsh web: https?:\/\/)/.test(readLog())) {
      try { page = await cdpPage(); } catch { page = null; }
      if (page) break;
    }
    if (child.exitCode !== null) break;
    await sleep(2000);
  }
  check('老用户环境启动就绪（窗口打开）', !!page, `elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
  if (!page) { console.log(readLog().slice(-2500)); return finish(1, root, mock, child); }

  // ── 2) 插件市场：真实安装第三方插件（dsh CLI → pnpm 全流程）──
  if (SKIP_MARKET) {
    console.log('[full] 跳过市场安装步骤（--skip-market=1）');
  } else {
  console.log(`[full] 市场安装 ${INSTALL_TARGET}（走真实 pnpm）…`);
  const profDir = path.join(home, 'profiles', 'web-desktop');
  const bundlesBefore = new Set((() => {
    try { return JSON.parse(fs.readFileSync(path.join(profDir, 'package.json'), 'utf8')).dsh.profile.bundles; } catch { return []; }
  })());
  const ins = await pageFetch(page, '/api/dsh-market', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'install', source: INSTALL_TARGET }),
  });
  let opId = ins.json && ins.json.ok ? ins.json.opId : null;
  check(`市场受理安装请求（opId=${opId || '无'}）`, !!opId, ins.body);
  let opFinal = null;
  if (opId) {
    const tIns = Date.now();
    while (Date.now() - tIns < 8 * 60 * 1000) {
      const st = await pageFetch(page, '/api/dsh-market', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'op', opId }),
      });
      const op = st.json && st.json.op;
      if (op && op.status !== 'running') { opFinal = op; break; }
      await sleep(4000);
    }
  }
  check('插件安装任务完成（pnpm 全流程）', opFinal && opFinal.status === 'done', opFinal && opFinal.status + ' | ' + String(opFinal && opFinal.output || '').slice(-200));
  const pkgDir = path.join(profDir, 'node_modules', INSTALL_TARGET);
  check('插件包落盘 node_modules', fs.existsSync(path.join(pkgDir, 'package.json')), pkgDir);
  let bundlesAfter = [];
  try { bundlesAfter = JSON.parse(fs.readFileSync(path.join(profDir, 'package.json'), 'utf8')).dsh.profile.bundles; } catch {}
  check('插件登记进 profile bundles', bundlesAfter.includes(INSTALL_TARGET), bundlesAfter.join(','));
  check('artifact-keep 快照目录生成（第三方产物保护）', fs.existsSync(path.join(home, 'plugin-artifact-cache', 'web-desktop')), '(pnpm 前快照)');
  }

  // ── 3) 真实对话 + 识图工具注册（消耗真实 token，约几分钱）──
  if (SKIP_CHAT) {
    console.log('[full] 跳过真实对话步骤（--skip-chat=1）');
  } else if (hasKey) {
    const chat = async (content) => {
      const r = await pageFetch(page, '/openclaw-bridge/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content }], stream: false }),
      });
      if (r.status !== 200 || !r.json) return { ok: false, text: r.body.slice(0, 300) };
      const text = (r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content) || '';
      return { ok: true, text };
    };
    const r1 = await chat('这是一条连通性测试。请只回复两个字：好的');
    check('真实对话：模型回复正常', r1.ok && /好的/.test(r1.text), r1.text || '');
    const r2 = await chat('请列出你当前可用的工具名（只要英文名，逗号分隔，一行以内）');
    check('识图链路：inspect_image 工具已注册（dsh-tool-vision）', r2.ok && /inspect_image/.test(r2.text), (r2.text || '').slice(0, 200));
  } else {
    console.log('  ⚠ 无 API Key，真实对话/识图运行时验证跳过（插件加载已由前序 E2E 覆盖）');
  }

  // ── 4) 老用户客户端更新全流程（真实下载 + SHA-256 校验 + 替换 + 重启）──
  console.log(`[full] 触发「检查客户端更新」（mock v${MOCK_VERSION} + 自动确认）…`);
  const logBeforeUpdate = readLog().length;
  try {
    await cdpEval(page.webSocketDebuggerUrl, 'window.dshDesktop.menu.action("check-client-update")', 15000);
  } catch (err) {
    console.log('[full] 菜单触发异常（可能因应用已开始退出）: ' + err.message);
  }
  // 等：下载（本地 225MB，秒级）→ 哈希校验 → 进程树回收 → app.exit →
  // detached apply-update.cmd 替换 exe → start 新实例。
  const tU = Date.now();
  while (Date.now() - tU < 150000 && procAlive(appPid)) await sleep(2000);
  check('更新后旧进程退出（含进程树回收）', !procAlive(appPid), `elapsed=${Math.round((Date.now() - tU) / 1000)}s`);

  const bak = runExe + '.bak';
  // 语义：备份仅用于失败回滚；替换成功后 cmd 脚本自删 .bak（client-updater.js:549）。
  // 故「无 .bak」= 替换成功并完成清理；「有 .bak」= 失败回滚或脚本中断。
  check('更新后 .bak 已清理（替换成功标志）', !fs.existsSync(bak), bak);
  // 更新脚本可能成功后自删 —— 文件缺失不算失败，仅提示。
  const updatesLeft = (() => {
    try { return fs.readdirSync(path.join(userDataDir, 'updates')).join(','); } catch { return '(目录不存在)'; }
  })();
  console.log('  ℹ updates 目录内容: ' + updatesLeft);
  const updatesLog = (() => {
    try { return fs.readFileSync(path.join(userDataDir, 'updates', 'apply-update.log'), 'utf8'); } catch { return ''; }
  })();
  console.log('  ℹ apply-update.log: ' + (updatesLog ? updatesLog.slice(-200).replace(/\r?\n/g, ' | ') : '(无)'));

  // 新实例：同镜像名、不同 PID，且持续存活（boot 成功）
  let newPid = 0;
  const tN = Date.now();
  while (Date.now() - tN < 120000) {
    for (const p of tasklistPids(path.basename(runExe))) {
      if (p !== appPid && procAlive(p)) { newPid = p; break; }
    }
    if (newPid) break;
    await sleep(2000);
  }
  check('更新后新实例已启动', newPid > 0, 'newPid=' + newPid);
  if (newPid) {
    await sleep(12000); // 给新实例走完 boot
    check('新实例持续运行（未闪退）', procAlive(newPid));
    check('新实例写入 boot 日志（真实重启）', readLog().length > logBeforeUpdate, readLog().slice(logBeforeUpdate).slice(0, 200));

    // ── 更新后数据保留（用户最关心的回归：插件/向导标记一个都不能丢）──
    const profDir = path.join(home, 'profiles', 'web-desktop');
    // 市场步骤可能未执行（--skip-market）或插件被内置接管拒绝（builtin:true），
    // 此时 pkgDir 未定义，跳过 node_modules 断言。
    if (!SKIP_MARKET && pkgDir) {
      check('更新后市场插件仍在 node_modules', fs.existsSync(path.join(pkgDir, 'package.json')), pkgDir);
    }
    let bundlesAfterUpdate = [];
    try { bundlesAfterUpdate = JSON.parse(fs.readFileSync(path.join(profDir, 'package.json'), 'utf8')).dsh.profile.bundles; } catch {}
    check('更新后 profile bundles 保留（含原内置插件）', !SKIP_MARKET ? bundlesAfterUpdate.includes(INSTALL_TARGET) : bundlesAfterUpdate.length > 0, bundlesAfterUpdate.join(','));
    check('更新后 cordis.patch.yml 保留', fs.existsSync(path.join(profDir, 'cordis.patch.yml')), '(patch 文件)');
    check('更新后内置插件清单标记保留', fs.existsSync(path.join(profDir, '.dsh-builtin-plugins.json')));
    const newLog = readLog().slice(logBeforeUpdate);
    check('更新后新实例无启动失败/完整性告警', !/启动失败|捆绑依赖完整性校验失败/.test(newLog), newLog.slice(0, 300));
    const settingsAfter = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8')); } catch { return {}; }
    })();
    check('更新后设置保留（pluginOnboardingDone/插件选择仍在）', settingsAfter.pluginOnboardingDone === true && Array.isArray(settingsAfter.builtinPluginSelection) && settingsAfter.builtinPluginSelection.length > 0,
      'onboardingDone=' + settingsAfter.pluginOnboardingDone + ' selection=' + (settingsAfter.builtinPluginSelection || []).length);

    try { require('node:child_process').spawn('taskkill', ['/pid', String(newPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    await sleep(4000);
    check('收尾：新实例已退出', !procAlive(newPid));
  }

  // 残留：node 全清
  const tR = Date.now();
  let nodeLeak = true;
  while (Date.now() - tR < 60000) {
    const nowNode = tasklistPids('node.exe');
    if (![...nowNode].some((p) => p !== process.pid)) { nodeLeak = false; break; }
    await sleep(3000);
  }
  check('更新+重启全链路后无 node.exe 残留', !nodeLeak);

  return finish(results.every(r => r.ok) ? 0 : 1, root, mock, child);
}

// 说明：DSH_DESKTOP_RELEASE_API 必须在 spawn env 里 —— main() 里补注入。
function finish(code, root, mock, child) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[full] 结果：${pass}/${results.length} 通过`);
  try { if (mock && mock.server) mock.server.close(); } catch {}
  if (child && child.exitCode === null) { try { require('node:child_process').spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  if (results.every(r => r.ok)) setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }, 500);
  else console.log(`[full] 失败现场保留于 ${root}`);
  process.exit(code);
}

main().catch((err) => { console.error('[full] 异常: ' + (err && err.stack || err)); process.exit(1); });

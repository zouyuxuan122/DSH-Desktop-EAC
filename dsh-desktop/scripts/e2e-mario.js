'use strict';

// 马里奥场景 E2E（复现用户报告：「写一个马里奥游戏 → Deep diving 贼久 →
// 没有任何输出，怀疑写入有问题」+「新旧会话都爆」）：
//   node scripts/e2e-mario.js --exe <portable.exe>
//
//   1. 复制真实 ~/.dsh（profiles 去 node_modules + 凭据）到临时 DSH_HOME；
//   2. 启动便携版，等 dsh web 就绪；
//   3. 桥对话①（真实 API + 真实文件写入工具）：写单文件马里奥小游戏；
//      断言 HTTP 200（旧版 tool-vision 监听器炸流时这里是 502/超时）、
//      回复非空、不含 "yield*"/"not async iterable"；
//   4. 桥对话②（同一映射会话 = 旧会话复用）：改游戏加双段跳；
//      断言 200 + 非空（覆盖「新旧会话都爆」的旧会话侧）；
//   5. 断言 <home>/openclaw-bridge/workspace 下 mario 文件真实落盘且非平凡
//      （覆盖「怀疑写入就有问题」——写入工具链路真实走通）；
//   6. 断言 dsh-web.log 无 llm/stream 崩溃栈。
//
// 隔离：DSH_HOME 临时目录；跳过自动更新与快捷方式改写。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const http = require('node:http');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const EXE = arg('exe');
if (!EXE || !fs.existsSync(EXE)) {
  console.error('[mario] --exe 必须指向存在的便携版 exe');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ✔ ' : '  ✖ ') + name + (ok ? '' : ' — ' + String(detail).slice(0, 400)));
}

function findFileRecursive(dir, pattern, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      findFileRecursive(p, pattern, out);
    } else if (pattern.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

async function main() {
  console.log(`[mario] exe=${EXE}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-mario-'));
  const home = path.join(root, 'dsh-home');
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  const srcHome = path.join(os.homedir(), '.dsh');
  for (const e of fs.readdirSync(path.join(srcHome, 'profiles'), { withFileTypes: true })) {
    if (e.name === 'node_modules' || !e.isDirectory()) continue;
    // 悬空 junction（如指向已删除目录的 profile 链接）跳过，勿中断复制
    try { fs.cpSync(path.join(srcHome, e.name), path.join(home, 'profiles', e.name), { recursive: true }); }
    catch (err) { console.log(`[mario] 跳过 profile ${e.name}: ${err.code || err.message}`); }
  }
  for (const f of ['settings.yaml', '.credentials.yaml', '.env']) {
    try { fs.copyFileSync(path.join(srcHome, f), path.join(home, f)); } catch {}
  }
  if (!fs.existsSync(path.join(home, '.credentials.yaml'))) {
    console.error('[mario] 无 API Key，无法进行真实对话验证');
    process.exit(2);
  }

  const runExe = path.join(root, 'run', path.basename(EXE));
  fs.mkdirSync(path.dirname(runExe), { recursive: true });
  fs.copyFileSync(EXE, runExe);
  try { fs.rmSync(path.join(os.tmpdir(), 'deepseek-harness-eac-portable'), { recursive: true, force: true }); } catch {}

  const child = spawn(runExe, [], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_DESKTOP_SKIP_AUTO_UPDATE: '1',
      DSH_DESKTOP_SKIP_CLIENT_UPDATE: '1',
      DSH_DESKTOP_TEST_NO_SHORTCUTS: '1',
    },
    stdio: 'ignore', windowsHide: true,
  });
  console.log(`[mario] app pid=${child.pid}`);
  const userDataDir = path.join(path.dirname(runExe), 'data');
  const readWebLog = () => { try { return fs.readFileSync(path.join(userDataDir, 'logs', 'dsh-web.log'), 'utf8'); } catch { return ''; } };

  let url = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60 * 1000) {
    const m = /dsh web: (https?:\/\/127\.0\.0\.1:\d+)/.exec(readWebLog());
    if (m) { url = m[1]; break; }
    if (child.exitCode !== null) break;
    await sleep(2000);
  }
  check('应用启动就绪（dsh web 起来）', !!url, `elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
  if (!url) {
    try { console.log(fs.readFileSync(path.join(userDataDir, 'logs', 'desktop.log'), 'utf8').slice(-2000)); } catch {}
    return finish(1, root, child);
  }
  console.log(`[mario] ready: ${url}`);

  const chat = (content, timeoutMs) => new Promise((resolve) => {
    const body = JSON.stringify({ model: 'default', messages: [{ role: 'user', content }], stream: false });
    const req = http.request(url + '/openclaw-bridge/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, ms: Date.now() - started }));
    });
    const started = Date.now();
    req.on('error', (e) => resolve({ status: 0, body: e.message, ms: Date.now() - started }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: 'timeout', ms: Date.now() - started }); });
    req.end(body);
  });
  const contentOf = (r) => {
    try {
      const j = JSON.parse(r.body);
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } catch { return ''; }
  };

  // ── 对话①：写马里奥游戏（真实写入工具链路）──
  console.log('[mario] 对话①：写马里奥游戏…');
  const t1 = Date.now();
  const r1 = await chat(
    '请创建一个精简的单文件马里奥风格横版小游戏 HTML（canvas 实现，150~250 行，'
      + '包含移动、跳跃、至少一个障碍物即可）。用文件写入工具保存为 mario-e2e.html。'
      + '完成后回复「已创建」并附一行文件路径。',
    8 * 60 * 1000,
  );
  const c1 = contentOf(r1);
  console.log(`[mario] ① status=${r1.status} 耗时=${Math.round((Date.now() - t1) / 1000)}s 回复=${JSON.stringify(c1.slice(0, 160))}`);
  check('对话① HTTP 200（非 502/超时 → llm/stream 瀑布未被破坏）', r1.status === 200, `status=${r1.status} body=${r1.body.slice(0, 300)}`);
  check('对话① 有真实回复输出（非空）', c1.trim().length > 0, c1.slice(0, 200) || r1.body.slice(0, 200));
  check('对话① 回复无 yield* 崩溃痕迹', !/yield\*|not async iterable/i.test(c1 + r1.body.slice(0, 2000)), c1.slice(0, 200));

  // ── 写入落盘核验（「怀疑写入就有问题」的直接证据）──
  await sleep(3000);
  const wsRoot = path.join(home, 'openclaw-bridge', 'workspace');
  const marioFiles = findFileRecursive(wsRoot, /^mario.*\.html$/i)
    .concat(findFileRecursive(path.join(home, 'sessions'), /^mario.*\.html$/i));
  check('mario-e2e.html 已写入磁盘（写入工具链路真实走通）', marioFiles.length > 0, `workspace=${wsRoot} 找到=${marioFiles.length}`);
  if (marioFiles.length > 0) {
    const f = marioFiles[0];
    const size = fs.statSync(f).size;
    const text = fs.readFileSync(f, 'utf8');
    check('写入内容非平凡（>1KB 且含 canvas/游戏代码）', size > 1024 && /canvas|keydown|requestAnimationFrame/i.test(text), `${f} (${size}B)`);
    console.log(`[mario] 文件: ${f} (${size}B)`);
  }

  // ── 对话②：旧会话复用 + 编辑工具链路 ──
  console.log('[mario] 对话②：同会话改游戏（旧会话复用）…');
  const t2 = Date.now();
  const r2 = await chat(
    '很好。现在请给 mario-e2e.html 增加双段跳（空中可再跳一次），改完回复「已更新」。',
    8 * 60 * 1000,
  );
  const c2 = contentOf(r2);
  console.log(`[mario] ② status=${r2.status} 耗时=${Math.round((Date.now() - t2) / 1000)}s 回复=${JSON.stringify(c2.slice(0, 160))}`);
  check('对话② HTTP 200（旧会话不爆）', r2.status === 200, `status=${r2.status} body=${r2.body.slice(0, 300)}`);
  check('对话② 有真实回复输出', c2.trim().length > 0, c2.slice(0, 200) || r2.body.slice(0, 200));

  // ── 服务端日志核验 ──
  await sleep(2000);
  const webLog = readWebLog();
  check('dsh-web.log 无 llm/stream 崩溃栈（not async iterable）', !/not async iterable|yield\*/i.test(webLog),
    webLog.split(/\r?\n/).filter((l) => /not async iterable|yield\*/i.test(l)).slice(-3).join(' | '));

  return finish(results.every((r) => r.ok) ? 0 : 1, root, child);
}

function finish(code, root, child) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[mario] 结果：${pass}/${results.length} 通过`);
  if (child && child.exitCode === null) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
  if (results.every((r) => r.ok)) setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }, 500);
  else console.log(`[mario] 失败现场保留于 ${root}`);
  process.exit(code);
}

main().catch((err) => { console.error('[mario] 异常: ' + (err && err.stack || err)); process.exit(1); });

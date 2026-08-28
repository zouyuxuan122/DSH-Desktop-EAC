'use strict';

// demo-rescue-ai.cjs — 模拟真实用户环境的「插件冲突崩溃 → AI 自动修复」演示。
//
// 流程：
//   1) 在隔离 DSH_HOME 里用真实 profile（web-desktop，去 node_modules）启动
//      4.6.0 便携版，确认首次正常启动（AI 可用，走本地路由网关）；
//   2) 退出后把 cordis.patch.yml 里一个「非 bundle」插件行整块复制一份
//      （duplicate loader entry id → dsh web exit 1 崩溃，PATCH_DUP_ID）；
//   3) 重新启动 → 崩溃窗口/救援页弹出 —— 由你（用户）亲自点击
//      「进入救援模式」→「AI 自动修复」，观察逐轮过程；
//   4) 脚本实时输出日志，直到「一键 AI 自动修复结束」且 Web UI 恢复就绪；
//   5) app 保持运行，展示修复结果。
//
// 环境：AI 调用走 settings 里配置的本地路由网关（llm-pi-ai.providers.router
// 的 baseURL + ROUTER_API_KEY），不经官方 api.deepseek.com。
//
// 用法：node scripts/demo-rescue-ai.cjs [--keep] [--exe=dist/...x64.exe]
//   --keep        结束时不清理演示目录（默认清理）
//   --model=xxx   路由模型 id（默认 oc/deepseek-v4-flash-free(max)）

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ARGS = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const EXE = path.resolve(ARGS.exe || 'dist/Deepseek-Harness-EAC-Portable-x64.exe');
// 模型默认取自客户端已配置的路由模型列表；优先选非推理档（更快更稳，
// 推理档如 xxx(max) 会把 token 全花在思考上，max_tokens 需给足）。
const DEFAULT_MODEL = (() => {
  try {
    const doc = require('js-yaml').load(fs.readFileSync(path.join(os.homedir(), '.dsh', 'settings.yaml'), 'utf8'));
    const models = doc && doc['llm-pi-ai'] && doc['llm-pi-ai'].providers && doc['llm-pi-ai'].providers.router && doc['llm-pi-ai'].providers.router.models;
    if (Array.isArray(models) && models.length) {
      const ids = models.map((x) => x && x.id).filter(Boolean);
      return String(ids.find((id) => !/\(max\)|reasoning|^r1|think/i.test(id)) || ids[0]);
    }
  } catch {}
  return 'oc/mimo-v2.5-free';
})();
const MODEL = ARGS.model || DEFAULT_MODEL;
const KEEP = !!ARGS.keep;
const PROFILE = 'web-desktop';
const DEBUG_PORT = 9341;
const ROOT_BASE = process.env.DSH_E2E_ROOT || os.tmpdir();
const TMP_DIR = path.join(ROOT_BASE, 'tmp');

const realHome = path.join(os.homedir(), '.dsh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mask(s) { return s && s.length > 8 ? s.slice(0, 4) + '***' : s; }
function readApiKeyFrom(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    const m = t.match(/^\s*ROUTER_API_KEY\s*:\s*["']?([^"'\s#]+)/m);
    return m ? m[1] : '';
  } catch { return ''; }
}
function killApp() {
  spawnSync('taskkill', ['/IM', 'Deepseek Harness EAC.exe', '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}
function procAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  killApp();
  await sleep(1500);
  const root = fs.mkdtempSync(path.join(ROOT_BASE, 'dsh-rescue-demo-'));
  const home = path.join(root, 'dsh-home');
  const runDir = path.join(root, 'run');
  const userData = path.join(runDir, 'data');
  const logFile = path.join(userData, 'logs', 'desktop.log');
  const profDir = path.join(home, 'profiles', PROFILE);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const routerKey = readApiKeyFrom(path.join(realHome, '.credentials.yaml'));
  console.log(`[demo] 演示目录: ${root}`);
  console.log(`[demo] 路由网关 key=${mask(routerKey)} 模型=${MODEL}`);

  // 0) 前置：路由网关必须在线（用户侧启动）。
  if (!routerKey) { console.error('[demo] 未找到 ROUTER_API_KEY（%USERPROFILE%\\.dsh\\.credentials.yaml）'); process.exit(2); }
  try {
    const r = spawnSync(process.execPath, ['-e', `
      const http = require('node:http');
      const req = http.request('http://localhost:20128/v1/models', { method: 'GET', headers: { Authorization: 'Bearer ' + process.argv[1] }, timeout: 6000 }, (res) => {
        let b = ''; res.on('data', (c) => b += c);
        res.on('end', () => { console.log('HTTP ' + res.statusCode); process.exit(res.statusCode === 200 ? 0 : 3); });
      });
      req.on('error', () => process.exit(1)); req.on('timeout', () => process.exit(4)); req.end();
    `, routerKey], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) {
      console.error(`[demo] 路由网关 http://localhost:20128 未就绪（status=${r.status}）。请先启动你的路由网关，再重跑本脚本。`);
      process.exit(2);
    }
  } catch { console.error('[demo] 路由网关探测失败'); process.exit(2); }

  // 1) 隔离 home：复制真实 profile（去 node_modules）+ 配置 + 凭据。
  fs.mkdirSync(path.dirname(profDir), { recursive: true });
  const srcProf = path.join(realHome, 'profiles', PROFILE);
  if (!fs.existsSync(srcProf)) { console.error(`[demo] 真实 profile 不存在: ${srcProf}`); process.exit(2); }
  // 连同 node_modules 一起复制（真实用户环境：老插件包如 dsh-tool-vision 在
  // 里面；跳过会导致「Cannot find package」启动崩溃，掩盖要演示的冲突场景）。
  fs.cpSync(srcProf, profDir, { recursive: true });
  for (const f of ['settings.yaml', '.credentials.yaml', '.env']) {
    try { fs.copyFileSync(path.join(realHome, f), path.join(home, f)); } catch {}
  }
  // 预写老用户标记：跳过内置插件选择向导（否则阻塞 boot）。
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    pluginOnboardingDone: true,
    builtinPluginSelection: [
      'balance', 'file-changes', 'client-file-changes', 'terminal',
      'dsh-market-plugin', 'skin-switch', 'easy-setup', 'plugin-shield',
      'plugin-manager', 'plugin-wizard',
    ],
    webPort: 0,
  }, null, 2) + '\n');

  const runExe = path.join(runDir, path.basename(EXE));
  fs.copyFileSync(EXE, runExe);

  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_DESKTOP_SKIP_AUTO_UPDATE: '1',
    DSH_DESKTOP_SKIP_CLIENT_UPDATE: '1',
    DSH_DESKTOP_TEST_NO_SHORTCUTS: '1',
    DEEPSEEK_API_BASE: 'http://localhost:20128/v1',
    DEEPSEEK_API_KEY: routerKey,
    DSH_RESCUE_MODEL: MODEL,
    TEMP: TMP_DIR, TMP: TMP_DIR,
    NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
  };
  const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };

  // ── 阶段 1：首次正常启动 ──
  console.log('[demo] 阶段 1：首次正常启动（等待 Web UI 就绪）…');
  let child = spawn(runExe, ['--remote-debugging-port=' + DEBUG_PORT], { env, stdio: 'ignore', windowsHide: true });
  let t0 = Date.now();
  while (Date.now() - t0 < 10 * 60 * 1000) {
    if (/Web UI 就绪/.test(readLog())) break;
    if (child.exitCode !== null) { console.error('[demo] 首次启动失败（exitCode=' + child.exitCode + '）：\n' + readLog().slice(-1500)); process.exit(1); }
    await sleep(2000);
  }
  if (!/Web UI 就绪/.test(readLog())) { console.error('[demo] 首次启动超时'); process.exit(1); }
  console.log('[demo] 首次启动成功，Web UI 就绪。退出并制造冲突…');
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(3000);
  while (procAlive(child.pid)) await sleep(500);

  // ── 阶段 2：复制一个非 bundle 插件行（duplicate loader entry）──
  const patchFile = path.join(profDir, 'cordis.patch.yml');
  let patch = fs.readFileSync(patchFile, 'utf8');
  let bundles = [];
  try { bundles = JSON.parse(fs.readFileSync(path.join(profDir, 'package.json'), 'utf8')).dsh.profile.bundles || []; } catch {}
  const rows = [];
  const re = /^[\t ]*- id:\s*([\w.-]+)\s*$/gm;
  let m, last = 0;
  while ((m = re.exec(patch)) !== null) rows.push({ id: m[1], start: m.index, end: re.lastIndex });
  for (let i = 0; i < rows.length; i++) rows[i].end = i + 1 < rows.length ? rows[i + 1].start : patch.length;
  const victim = rows.find((r) => !bundles.includes(r.id)) || rows[0];
  if (!victim) { console.error('[demo] patch 里没有可复制的行'); process.exit(1); }
  const block = patch.slice(victim.start, victim.end);
  fs.writeFileSync(patchFile + '.demo-bak', patch);
  patch = patch.slice(0, victim.end) + block + patch.slice(victim.end);
  fs.writeFileSync(patchFile, patch);
  console.log(`[demo] 已复制插件行块「${victim.id}」→ 制造 duplicate loader entry 崩溃（原文件备份: cordis.patch.yml.demo-bak）`);

  // ── 阶段 3：崩溃 → 救援页（用户手动操作）──
  console.log('[demo] 阶段 3：重新启动 → 应弹出「启动失败」窗口…');
  child = spawn(runExe, ['--remote-debugging-port=' + DEBUG_PORT], { env, stdio: 'ignore', windowsHide: true });
  t0 = Date.now();
  let onRescue = false;
  let lastLen = 0;
  while (Date.now() - t0 < 10 * 60 * 1000) {
    const log = readLog();
    if (log.length > lastLen) {
      const fresh = log.slice(lastLen).split(/\r?\n/).filter((l) => l.length);
      lastLen = log.length;
      for (const l of fresh) {
        if (/\[rescue\]|\[recovery\]|\[guard\]|\[boot\] 启动失败|Web UI 就绪/.test(l)) console.log('  ' + l);
      }
    }
    if (/recovery\.html/.test(log) || /界面加载成功/.test(log)) onRescue = true;
    if (onRescue && /一键 AI 自动修复结束|Web UI 就绪/.test(log)) break;
    if (child.exitCode !== null) { console.error('[demo] app 异常退出（exitCode=' + child.exitCode + '）'); break; }
    await sleep(1000);
  }
  if (!onRescue) {
    console.error('[demo] 未检测到救援页。日志尾部：\n' + readLog().slice(-2000));
    process.exit(1);
  }
  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log('  救援窗口已出现 —— 现在由你亲自操作：');
  console.log('    1) 若弹出「启动失败」对话框 → 点「进入救援模式」');
  console.log('    2) 在救援页点「AI 自动修复」按钮');
  console.log('    3) 观察自动修复过程（诊断 → 建议 → 执行 → 重启）');
  console.log('════════════════════════════════════════════════════════');
  console.log('');

  // ── 阶段 4：实时观察直到修复结束 ──
  t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < 15 * 60 * 1000) {
    const log = readLog();
    if (log.length > lastLen) {
      const fresh = log.slice(lastLen).split(/\r?\n/).filter((l) => l.length);
      lastLen = log.length;
      for (const l of fresh) {
        if (/\[rescue\]|\[recovery\]|\[guard\]|Web UI 就绪|启动失败/.test(l)) console.log('  ' + l);
      }
    }
    if (/一键 AI 自动修复结束/.test(log) && /Web UI 就绪/.test(log)) { done = true; break; }
    if (/一键 AI 自动修复结束/.test(log) && /安全模式已开启/.test(log)) { done = true; break; }
    await sleep(1000);
  }
  const log = readLog();
  const doneLine = (log.match(/一键 AI 自动修复结束: (.*)/) || [])[1] || '(未记录)';
  const webUp = /Web UI 就绪/.test(log);
  console.log('');
  if (webUp) console.log(`[demo] ✅ 修复完成：Web UI 已恢复（自动修复结果: ${doneLine}）`);
  else console.log(`[demo] ⚠️ 修复流程结束但未确认 Web UI（自动修复结果: ${doneLine}；兜底路径也属正常恢复）`);
  console.log(`[demo] app 保持运行中，可亲自确认。演示数据: ${root}`);
  console.log(`[demo] 清理命令: node scripts/demo-rescue-ai.cjs --clean=${root}`);
  if (!KEEP) console.log(`[demo] 提示：下次运行加 --keep 可保留演示目录用于检查（.ai-bak / 快照 / 日志）。`);
}

main().catch((err) => { console.error('[demo] 异常: ' + ((err && err.stack) || err)); process.exit(1); });
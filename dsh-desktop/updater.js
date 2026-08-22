'use strict';

// Self-update engine for the bundled @deepseek-ai/dsh agent.
//
// Flow:
//   1. checkLatest():  bundled npm runs "npm view @deepseek-ai/dsh version"
//      (respects the user's .npmrc registry / proxy settings).
//   2. User consents in a dialog ("立即更新 / 跳过此版本 / 稍后").
//   3. applyUpdate(): installs the official new version into a STAGING dir
//      (<userData>/agent-staging) with the bundled node + npm runtime, then
//      atomically swaps it in as <userData>/agent. A failed update never
//      touches the working copy.
//   4. dshBin() in main.js prefers the overlay (<userData>/agent/...) over
//      the bundled copy, so the new version takes effect after a restart.
//   5. rollback(): if the overlay fails to boot, the user can fall back to
//      the bundled version with one click.
//
// The overlay lives in the user-writable data dir, so updates work for the
// NSIS install AND the portable build (whose unpacked resources are
// re-created from the exe on every launch).

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PKG = '@deepseek-ai/dsh';
const IS_WIN = process.platform === 'win32';

// 镜像源链：默认源（用户 .npmrc / NPM_CONFIG_REGISTRY）卡住或失败时依次
// 自动切换。切换与结果都会经 onProgress 上报给更新弹窗提示。
const NPM_MIRRORS = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
// 单个 npm 命令「无任何输出」的停滞上限：超过即判死并切换镜像源
//（npm 解析依赖时可能长时间静默，阈值取 150 秒）。
const NPM_STALL_MS = 150 * 1000;

let activeProc = null;

// --- settings -------------------------------------------------------------

function settingsPath(ctx) { return path.join(ctx.userDataDir, 'settings.json'); }

function loadSettings(ctx) {
  try { return JSON.parse(fs.readFileSync(settingsPath(ctx), 'utf8')); }
  catch { return {}; }
}

function saveSettings(ctx, s) {
  try { fs.writeFileSync(settingsPath(ctx), JSON.stringify(s, null, 2) + '\n'); }
  catch (err) { ctx.log('update', '保存 settings 失败: ' + err.message); }
}

// --- overlay paths --------------------------------------------------------

function overlayDir(ctx) { return path.join(ctx.userDataDir, 'agent'); }
function stagingDir(ctx) { return path.join(ctx.userDataDir, 'agent-staging'); }

function overlayBinPath(ctx) {
  return path.join(overlayDir(ctx), 'node_modules', PKG, 'lib', 'bin.js');
}

function overlayVersion(ctx) {
  try { return require(path.join(overlayDir(ctx), 'node_modules', PKG, 'package.json')).version; }
  catch { return null; }
}

function bundledVersion() {
  try { return require(PKG + '/package.json').version; }
  catch { return null; }
}

function activeVersion(ctx) { return overlayVersion(ctx) || bundledVersion(); }

// --- semver-ish compare (handles 0.1.0-rc.N style prereleases) -------------

function compareVersions(a, b) {
  const parse = (v) => {
    const [rawCore, pre = ''] = String(v).trim().replace(/^v/i, '').split('-');
    const coreParts = rawCore.split('.');
    // 补齐缺省段，保证 4.4 与 4.4.0 的比较结果为相等而不是 NaN。
    const nums = Array.from({ length: 3 }, (_, i) => parseInt(coreParts[i], 10) || 0);
    const preNum = parseInt((pre.match(/\d+/) || [''])[0], 10);
    return { nums, pre, preNum: Number.isNaN(preNum) ? -1 : preNum, hasPre: !!pre };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] - B.nums[i];
  }
  if (A.hasPre !== B.hasPre) return A.hasPre ? -1 : 1; // prerelease < release
  if (A.hasPre && A.pre !== B.pre) {
    if (A.preNum >= 0 && B.preNum >= 0 && A.preNum !== B.preNum) return A.preNum - B.preNum;
    return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
  }
  return 0;
}

// --- npm runner -----------------------------------------------------------

function killProc(proc) {
  if (!proc || !proc.pid) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const fallback = setTimeout(done, IS_WIN ? 2000 : 500);
    try {
      proc.once('close', () => { clearTimeout(fallback); done(); });
      if (IS_WIN) {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
        killer.once('close', () => {
          // taskkill may finish just before the child emits close; the bounded
          // fallback keeps cleanup from hanging if the event is lost.
          setTimeout(done, 100);
        });
        killer.once('error', done);
      } else {
        proc.kill('SIGTERM');
      }
    } catch { done(); }
  });
}

function abort() { killProc(activeProc); activeProc = null; }

function runNpm(ctx, args, { timeoutMs = 30 * 60 * 1000, logStream = null, onOutput = null, stallMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const nodeBin = ctx.nodeExe();
    const cli = ctx.npmCli();
    if (!fs.existsSync(nodeBin) || !fs.existsSync(cli)) {
      return reject(new Error('内置 Node/npm 运行时缺失，无法检查或执行更新。'));
    }
    ctx.log('update', 'npm ' + args.join(' '));
    try { fs.mkdirSync(ctx.userDataDir, { recursive: true }); } catch {}
    const proc = spawn(nodeBin, [cli, ...args], {
      cwd: ctx.userDataDir,
      env: {
        ...process.env,
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_AUDIT: 'false',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProc = proc;
    let settled = false;
    let stdoutBuf = '';
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(stallTimer); activeProc = null; fn(value); } };
    const finishAfterKill = async (error) => {
      if (settled) return;
      // Lock the result before taskkill: on Windows the child can emit
      // `exit` while taskkill is still completing, which must not replace a
      // timeout/stall error with a generic npm exit-code error.
      settled = true;
      clearTimeout(timer);
      clearTimeout(stallTimer);
      activeProc = null;
      await killProc(proc);
      reject(error);
    };
    const timer = setTimeout(async () => {
      await finishAfterKill(new Error('npm 执行超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
    }, timeoutMs);
    // 停滞检测：stallMs > 0 时，超过阈值没有产生任何输出即判死（触发
    // 调用方切换镜像源），避免「卡住但没到整体超时」的长时间空转。
    let stallTimer = null;
    const armStall = () => {
      if (!stallMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(async () => {
        await finishAfterKill(new Error('下载停滞（' + Math.round(stallMs / 1000) + ' 秒无进展），将切换镜像源重试'));
      }, stallMs);
    };
    const onChunk = (c) => {
      armStall();
      if (logStream) logStream.write(c);
      if (onOutput) { try { onOutput(c); } catch {} }
    };
    armStall();
    let stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); onChunk(c); });
    proc.stderr.on('data', (c) => { stderrBuf += c.toString(); onChunk(c); });
    proc.on('error', (err) => finish(reject, err));
    proc.on('exit', (code) => {
      if (code === 0) finish(resolve, stdoutBuf);
      else {
        const tail = (stderrBuf + stdoutBuf).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
        finish(reject, new Error('npm 退出码 ' + code + (tail ? '：' + tail.slice(-500) : '')));
      }
    });
  });
}

// 当前生效的 registry（.npmrc / NPM_CONFIG_REGISTRY），供镜像源链去重与提示。
async function currentRegistry(ctx) {
  try {
    const out = await runNpm(ctx, ['config', 'get', 'registry'], { timeoutMs: 30000 });
    const v = String(out || '').trim().replace(/\/+$/, '');
    return v || null;
  } catch { return null; }
}

// 拼接镜像源尝试链：默认源（尊重用户配置）优先，失败/停滞时依次切镜像。
function registryChain(current) {
  const seen = new Set();
  const chain = [];
  const push = (r) => {
    if (!r) return;
    const norm = r.replace(/\/+$/, '');
    const key = norm.toLowerCase();
    if (!seen.has(key)) { seen.add(key); chain.push(norm); }
  };
  push(current);
  for (const m of NPM_MIRRORS) push(m);
  return chain;
}

// --- public API -----------------------------------------------------------

async function checkLatest(ctx) {
  // 主源查不到/超时后自动试镜像源（更新弹窗外静默执行，失败不打扰用户）。
  const chain = registryChain(await currentRegistry(ctx));
  const errors = [];
  for (const registry of chain) {
    const args = ['view', PKG, 'version'];
    if (registry) args.push('--registry=' + registry);
    try {
      const out = await runNpm(ctx, args, { timeoutMs: 90000 });
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const v = lines[lines.length - 1].trim();
      if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('无法解析官方版本号: ' + JSON.stringify(v));
      if (registry) ctx.log('update', '版本检查成功（镜像源 ' + registry + '）');
      return v;
    } catch (err) {
      errors.push((registry || '默认源') + ': ' + err.message);
    }
  }
  throw new Error('无法获取官方版本号（' + errors.join('；') + '）');
}

function previousAgentDir(ctx) { return path.join(ctx.userDataDir, 'agent-previous'); }

// 上一版本备份是否可用（供启动失败对话框选择「回退到上一版本」）。
function previousAgentInfo(ctx) {
  const settings = loadSettings(ctx);
  if (!settings.previousAgent || !settings.previousAgent.version) return null;
  if (!fs.existsSync(previousAgentDir(ctx))) return null;
  return settings.previousAgent;
}

// 安装阶段进度上报回调的载荷：
//   { stage: 'fetch', count, elapsed, registry }   —— 下载依赖中（按 npm 输出
//     统计已获取的包/元数据项数）
//   { stage: 'install', registry }                  —— 进入解包安装阶段
//   { stage: 'done' }                               —— npm 安装成功，即将切换版本
//   { stage: 'mirror', registry }                   —— 源停滞/失败，已切换镜像源
async function applyUpdate(ctx, version, { onProgress = null, stallMs = NPM_STALL_MS } = {}) {
  const staging = stagingDir(ctx);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const logPath = path.join(ctx.userDataDir, 'logs', 'update.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const chain = registryChain(await currentRegistry(ctx));
  const errors = [];
  let installErr = null;
  const started = Date.now();
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  };
  for (let i = 0; i < chain.length; i++) {
    const registry = chain[i];
    if (i > 0 && onProgress) {
      try { onProgress({ stage: 'mirror', registry }); } catch {}
      ctx.log('update', '下载源 ' + registry + ' 不可用，自动切换镜像源 ' + (chain[i] || '默认源'));
    }
    // npm 安装进度解析：--loglevel=info 会输出 "npm http fetch GET 200 …" 行
    //（每个包/元数据一次）与 reify 阶段行；按此上报实时进度与阶段。
    let fetchCount = 0;
    let sawReify = false;
    let sawAdded = false;
    let lastPush = 0;
    const push = (force) => {
      const now = Date.now();
      if (!force && now - lastPush < 500) return;
      lastPush = now;
      if (!onProgress) return;
      try {
        onProgress(sawAdded
          ? { stage: 'done' }
          : { stage: sawReify ? 'install' : 'fetch', count: fetchCount, elapsed: fmt(now - started), registry });
      } catch {}
    };
    const onOutput = (chunk) => {
      const text = String(chunk);
      if (text.includes('http fetch GET 200') || /fetch\s+GET\s+200/i.test(text)) fetchCount++;
      if (/reify:/i.test(text)) sawReify = true;
      if (/added\s+\d+\s+packages\s+in/i.test(text)) sawAdded = true;
      push(false);
    };
    try {
      const args = [
        'install', '--prefix', staging, PKG + '@' + version,
        '--save-exact', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier',
        // dsh is an aggregator whose runtime packages cross-reference each other
        // through a dense peer graph. npm 11's peer solver can spend minutes
        // backtracking here without output; the isolated overlay already gets
        // every runtime package from dsh's explicit dependency list.
        '--legacy-peer-deps',
        '--loglevel=info',
      ];
      if (registry) args.push('--registry=' + registry);
      await runNpm(ctx, args, { timeoutMs: 30 * 60 * 1000, logStream, onOutput, stallMs });
      if (onProgress) { try { onProgress({ stage: 'done' }); } catch {} }
      installErr = null;
      break;
    } catch (err) {
      installErr = err;
      errors.push((registry || '默认源') + ': ' + err.message);
      ctx.log('update', '下载失败（' + (registry || '默认源') + '）: ' + err.message);
      if (i === chain.length - 1 && onProgress) {
        try { onProgress({ stage: 'mirror', registry: null }); } catch {}
      }
    }
  }
  logStream.end();
  if (installErr) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(installErr.message + '（已尝试镜像源：' + errors.join('；') + '；日志: ' + logPath + '）');
  }

  const bin = path.join(staging, 'node_modules', PKG, 'lib', 'bin.js');
  if (!fs.existsSync(bin)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('安装完成但未找到 dsh 入口文件（日志: ' + logPath + '）');
  }

  // Atomic swap: old overlay -> backup, staging -> overlay.
  // M4 修复：两处重命名都纳入 try，失败时回滚并清理 staging 残留。
  // V4.1 更新保障②：备份不再立即删除 —— 换名保留为 agent-previous，
  // 直到下次启动确认新版健康（confirmPreviousAgentHealthy）才清理，
  // 启动失败时用户可一键回退到上一版本。
  const overlay = overlayDir(ctx);
  const backup = path.join(ctx.userDataDir, 'agent-old-' + Date.now());
  // V4.3 PR（独有价值，review 保留项）：配置全量快照 + profile 精简。
  // swap 前把关键配置文件拷到 backup/config/ 目录；backup 随后会被
  // rename 到 agent-previous（固定名），快照也随之保留到健康确认前；
  // 若 swap 失败，backup 目录最终会被 overlay 回滚 + 删除，快照随之丢弃，
  // 不污染 userData。
  try {
    const cfgDir = path.join(backup, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    // 1) userData/settings.json（桌面端配置：端口、皮肤、已跳过版本等）
    const setSrc = settingsPath(ctx);
    if (fs.existsSync(setSrc)) fs.copyFileSync(setSrc, path.join(cfgDir, 'settings.json'));
    // 2) dsh 自身 settings.yaml（CLI 同构：模型、代理、API key、默认 profile 等）
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const dshSet = path.join(dshHome, 'settings.yaml');
    if (fs.existsSync(dshSet)) fs.copyFileSync(dshSet, path.join(cfgDir, 'dsh-settings.yaml'));
    // 3) web-desktop / web 两个 profile 的 cordis.patch.yml（用户 patch 行记录；
    //    插件行写入规则「已有行不重写」：只追加 insert 块，不覆盖用户手工改动）
    //    —— 两个 profile 都快照一份：shareWebProfile=true 用户用 web；
    //    默认情况用 web-desktop。多一份 ≈ 几 KB，可忽略。
    for (const profName of ['web-desktop', 'web']) {
      const patch = path.join(dshHome, 'profiles', profName, 'cordis.patch.yml');
      if (fs.existsSync(patch)) {
        const profDir = path.join(cfgDir, 'profiles', profName);
        fs.mkdirSync(profDir, { recursive: true });
        fs.copyFileSync(patch, path.join(profDir, 'cordis.patch.yml'));
      }
    }
    ctx.log('update', `配置快照写入 ${cfgDir}`);
  } catch (snapErr) {
    ctx.log('update', '配置快照写入失败（不影响更新主体）: ' + String(snapErr && snapErr.message));
    // 快照是「锦上添花」：失败不阻塞 swap 主流程。
  }
  try {
    if (fs.existsSync(overlay)) fs.renameSync(overlay, backup);
    fs.renameSync(staging, overlay);
  } catch (err) {
    try {
      if (!fs.existsSync(overlay) && fs.existsSync(backup)) fs.renameSync(backup, overlay);
    } catch (rollbackErr) {
      ctx.log('update', '回滚 overlay 失败: ' + String(rollbackErr && rollbackErr.message));
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('切换新版本失败: ' + (err && err.message) + '（staging 已清理）');
  }
  // 上一份残留备份（上次更新后既未确认健康也未回退）已过时，直接清除，
  // 新备份以固定名保留。
  const prevDir = previousAgentDir(ctx);
  if (fs.existsSync(prevDir)) fs.rmSync(prevDir, { recursive: true, force: true });
  if (fs.existsSync(backup)) {
    try { fs.renameSync(backup, prevDir); } catch (err) {
      ctx.log('update', '保留上一版本备份失败: ' + (err && err.message));
      fs.rmSync(backup, { recursive: true, force: true });
    }
  }

  const settings = loadSettings(ctx);
  settings.previousAgent = { version, dir: 'agent-previous', at: new Date().toISOString() };
  settings.skipVersion = null;
  saveSettings(ctx, settings);
  ctx.log('update', '更新完成: ' + PKG + '@' + version + '（上一版本备份保留至确认健康）');
  return { version, logPath };
}

// 下次启动确认新版健康后调用：清理 agent-previous 备份。
function confirmPreviousAgentHealthy(ctx) {
  const settings = loadSettings(ctx);
  if (!settings.previousAgent) return false;
  const prevDir = previousAgentDir(ctx);
  try {
    if (fs.existsSync(prevDir)) fs.rmSync(prevDir, { recursive: true, force: true, maxRetries: 3 });
    settings.previousAgent = null;
    saveSettings(ctx, settings);
    ctx.log('update', '新版启动确认健康，已清理上一版本备份');
    return true;
  } catch (err) {
    ctx.log('update', '清理上一版本备份失败: ' + (err && err.message));
    return false;
  }
}

// 启动失败时手动回退到上一版本：当前 overlay 移为 agent-broken-*，
// agent-previous 还原为 overlay。
function rollbackToPrevious(ctx) {
  const settings = loadSettings(ctx);
  const prevDir = previousAgentDir(ctx);
  const overlay = overlayDir(ctx);
  const prev = settings.previousAgent;
  if (!prev || !fs.existsSync(prevDir)) return null;
  try {
    if (fs.existsSync(overlay)) {
      fs.renameSync(overlay, path.join(ctx.userDataDir, 'agent-broken-' + Date.now()));
    }
    fs.renameSync(prevDir, overlay);
    settings.previousAgent = null;
    saveSettings(ctx, settings);
    ctx.log('update', '已回退到上一版本 ' + prev.version + '（坏副本保留在 agent-broken-*）');
    return prev.version;
  } catch (err) {
    ctx.log('update', '回退到上一版本失败: ' + (err && err.message));
    return null;
  }
}

function rollback(ctx) {
  const overlay = overlayDir(ctx);
  if (!fs.existsSync(overlay)) return null;
  const broken = path.join(ctx.userDataDir, 'agent-broken-' + Date.now());
  fs.renameSync(overlay, broken);
  ctx.log('update', '已回退到内置版本（问题副本保留在 ' + broken + '）');
  return broken;
}

module.exports = {
  PKG,
  NPM_MIRRORS,
  settingsPath,
  loadSettings,
  saveSettings,
  overlayBinPath,
  overlayVersion,
  bundledVersion,
  activeVersion,
  compareVersions,
  checkLatest,
  applyUpdate,
  confirmPreviousAgentHealthy,
  previousAgentInfo,
  rollbackToPrevious,
  rollback,
  abort,
  registryChain,
  currentRegistry,
  // 供 plugin-updater.js（内置/市场插件更新）复用同一 npm 运行器与镜像链。
  runNpm,
};

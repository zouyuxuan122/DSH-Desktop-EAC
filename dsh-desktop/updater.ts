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

import cp = require('node:child_process');
import path = require('node:path');
import fs = require('node:fs');
import os = require('node:os');

const PKG = '@deepseek-ai/dsh';
const IS_WIN = process.platform === 'win32';

// 镜像源链：默认源（用户 .npmrc / NPM_CONFIG_REGISTRY）卡住或失败时依次
// 自动切换。切换与结果都会经 onProgress 上报给更新弹窗提示。
const NPM_MIRRORS: string[] = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
// 单个 npm 命令「无任何输出」的停滞上限：超过即判死并切换镜像源
//（npm 解析依赖时可能长时间静默，阈值取 300 秒）。
const NPM_STALL_MS = 300 * 1000;

const { readJsonFile } = require('./lib/plugin-copy') as {
  readJsonFile(file: string): Record<string, unknown> | null;
};
const { writeJsonAtomic } = require('./lib/atomic-json') as {
  writeJsonAtomic(file: string, value: unknown): void;
};

// --- settings -------------------------------------------------------------

interface UpdaterCtx {
  userDataDir: string;
  log(section: string, message: string): void;
  nodeExe(): string;
  npmCli(): string;
}

function settingsPath(ctx: UpdaterCtx): string { return path.join(ctx.userDataDir, 'settings.json'); }

function loadSettings(ctx: UpdaterCtx): Record<string, any> {
  return readJsonFile(settingsPath(ctx)) ?? {};
}

function saveSettings(ctx: UpdaterCtx, s: Record<string, any>): void {
  try { writeJsonAtomic(settingsPath(ctx), s); }
  catch (err) { ctx.log('update', '保存 settings 失败: ' + (err as Error).message); }
}

// --- overlay paths --------------------------------------------------------

function overlayDir(ctx: UpdaterCtx): string { return path.join(ctx.userDataDir, 'agent'); }
function stagingDir(ctx: UpdaterCtx): string { return path.join(ctx.userDataDir, 'agent-staging'); }

function overlayBinPath(ctx: UpdaterCtx): string {
  return path.join(overlayDir(ctx), 'node_modules', PKG, 'lib', 'bin.js');
}

function overlayVersion(ctx: UpdaterCtx): string | null {
  try { return require(path.join(overlayDir(ctx), 'node_modules', PKG, 'package.json')).version; }
  catch { return null; }
}

function bundledVersion(): string | null {
  try { return require(PKG + '/package.json').version; }
  catch { return null; }
}

function activeVersion(ctx: UpdaterCtx): string | null { return overlayVersion(ctx) || bundledVersion(); }

// --- semver-ish compare (handles 0.1.2-alpha.1 style prereleases) ----------

interface ParsedVersion {
  nums: number[];
  pre: string[];
  hasPre: boolean;
}
function parseVersion(v: string): ParsedVersion {
  const [rawCore = '', rawPre = ''] = String(v).trim().replace(/^v/i, '').split('-');
  const coreParts = rawCore.split('.');
  // 补齐缺省段，保证 4.4 与 4.4.0 的比较结果为相等而不是 NaN。
  const nums = Array.from({ length: 3 }, (_, i) => parseInt(coreParts[i]!, 10) || 0);
  const pre = rawPre === '' ? [] : rawPre.split('.');
  return { nums, pre, hasPre: rawPre !== '' };
}
// semver 规范的 prerelease 标识符比较：纯数字段按数值比（rc.1.10 > rc.1.2），
// 数字段恒小于字母段（1.0.0-1 < 1.0.0-alpha），字母段按 ASCII 字典序
//（alpha < beta < rc）。旧实现取"pre 里第一个数字"当序号，beta.2 会 > rc.1。
function comparePreIdentifier(ai: string, bi: string): number {
  const isNum = (x: string): boolean => /^\d+$/.test(x);
  if (isNum(ai) && isNum(bi)) {
    const na = parseInt(ai, 10);
    const nb = parseInt(bi, 10);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (isNum(ai)) return -1;
  if (isNum(bi)) return 1;
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}
function compareVersions(a: string, b: string): number {
  const A = parseVersion(a), B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i]! - B.nums[i]!;
  }
  if (A.hasPre !== B.hasPre) return A.hasPre ? -1 : 1; // prerelease < release
  if (A.hasPre) {
    const n = Math.max(A.pre.length, B.pre.length);
    for (let i = 0; i < n; i++) {
      if (A.pre[i] === undefined) return -1; // 段数少者为低（alpha < alpha.1）
      if (B.pre[i] === undefined) return 1;
      const c = comparePreIdentifier(A.pre[i]!, B.pre[i]!);
      if (c !== 0) return c;
    }
  }
  return 0;
}

// --- npm runner -----------------------------------------------------------

function killProc(proc: cp.ChildProcess | null): Promise<void> {
  if (!proc || !proc.pid) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const fallback = setTimeout(done, IS_WIN ? 2000 : 500);
    try {
      proc.once('close', () => { clearTimeout(fallback); done(); });
      if (IS_WIN) {
        const killer = cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
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

// 活跃 npm 子进程集合：plugin-updater 的 checkPluginUpdates 会并发检测全部
// 更新源（每源先 currentRegistry 再 npm view），旧实现的模块级单例 activeProc
// 被并发进程互相覆盖 —— abort() 只能杀到最后一个，其余变孤儿跑满超时。
// 改为集合跟踪，abort/超时/停滞都遍历全量收割。
const activeProcs = new Set<cp.ChildProcess>();

function abort(): void {
  for (const p of [...activeProcs]) void killProc(p);
  activeProcs.clear();
}

interface RunNpmOpts {
  timeoutMs?: number;
  logStream?: fs.WriteStream | null;
  onOutput?: ((chunk: Buffer) => void) | null;
  stallMs?: number;
}
function runNpm(ctx: UpdaterCtx, args: string[], { timeoutMs = 30 * 60 * 1000, logStream = null, onOutput = null, stallMs = 0 }: RunNpmOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const nodeBin = ctx.nodeExe();
    const cli = ctx.npmCli();
    if (!fs.existsSync(nodeBin) || !fs.existsSync(cli)) {
      return reject(new Error('内置 Node/npm 运行时缺失，无法检查或执行更新。'));
    }
    ctx.log('update', 'npm ' + args.join(' '));
    try { fs.mkdirSync(ctx.userDataDir, { recursive: true }); } catch {}
    const proc = cp.spawn(nodeBin, [cli, ...args], {
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
    activeProcs.add(proc);
    let settled = false;
    let stdoutBuf = '';
    const finish = (fn: (value: any) => void, value: any) => { if (!settled) { settled = true; clearTimeout(timer); if (stallTimer) clearTimeout(stallTimer); activeProcs.delete(proc); fn(value); } };
    const finishAfterKill = async (error: Error) => {
      if (settled) return;
      // Lock the result before taskkill: on Windows the child can emit
      // `exit` while taskkill is still completing, which must not replace a
      // timeout/stall error with a generic npm exit-code error.
      settled = true;
      clearTimeout(timer);
      if (stallTimer) clearTimeout(stallTimer);
      activeProcs.delete(proc);
      await killProc(proc);
      reject(error);
    };
    const timer = setTimeout(async () => {
      await finishAfterKill(new Error('npm 执行超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
    }, timeoutMs);
    // 停滞检测：stallMs > 0 时，超过阈值没有产生任何输出即判死（触发
    // 调用方切换镜像源），避免「卡住但没到整体超时」的长时间空转。
    let stallTimer: NodeJS.Timeout | null = null;
    const armStall = () => {
      if (!stallMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(async () => {
        await finishAfterKill(new Error('下载停滞（' + Math.round(stallMs / 1000) + ' 秒无进展），将切换镜像源重试'));
      }, stallMs);
    };
    const onChunk = (c: Buffer) => {
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

async function validateStagedAgent(ctx: UpdaterCtx, staging: string, expectedVersion: string, logStream: fs.WriteStream): Promise<void> {
  const actualVersion = agentVersionIn(staging);
  const bin = agentBinPath(staging);
  if (actualVersion !== expectedVersion) {
    throw new Error(`实际安装版本 ${actualVersion || '未知'} 与目标版本 ${expectedVersion} 不一致`);
  }
  if (!fs.existsSync(bin)) throw new Error('未找到 dsh 入口文件');

  ctx.log('update', '开始验证生产依赖闭包: ' + PKG + '@' + expectedVersion);
  await runNpm(ctx, ['ls', '--prefix', staging, '--all', '--omit=dev'], {
    timeoutMs: 2 * 60 * 1000,
    logStream,
  });

  const smokeHome = path.join(staging, '.eac-smoke-home');
  fs.mkdirSync(smokeHome, { recursive: true });
  ctx.log('update', '开始加载 staged dsh CLI: ' + bin + ' --version');
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = cp.execFile(ctx.nodeExe(), [bin, '--version'], {
        cwd: staging,
        env: { ...process.env, DSH_HOME: smokeHome },
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        activeProcs.delete(proc);
        const output = String(stdout || '') + String(stderr || '');
        if (output) logStream.write(output.endsWith('\n') ? output : output + '\n');
        if (!err) return resolve();
        const lines = output.split(/\r?\n/).filter(Boolean);
        const diagnostic = lines.find((line) => /Cannot find|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(line));
        const summary = [diagnostic, ...lines.slice(-4)].filter(Boolean).join(' | ');
        reject(new Error('CLI 加载失败' + (summary ? '：' + summary.slice(-1000) : '：' + err.message)));
      });
      activeProcs.add(proc);
      proc.once('error', () => activeProcs.delete(proc));
    });
  } finally {
    try { await fs.promises.rm(smokeHome, { recursive: true, force: true, maxRetries: 3 }); } catch { /* staging 会在失败路径整体清理 */ }
  }
  ctx.log('update', 'staged Agent 依赖闭包与 CLI 加载验证通过');
}

// 当前生效的 registry（.npmrc / NPM_CONFIG_REGISTRY），供镜像源链去重与提示。
async function currentRegistry(ctx: UpdaterCtx): Promise<string | null> {
  try {
    const out = await runNpm(ctx, ['config', 'get', 'registry'], { timeoutMs: 30000 });
    const v = String(out || '').trim().replace(/\/+$/, '');
    return v || null;
  } catch { return null; }
}

// 拼接镜像源尝试链：默认源（尊重用户配置）优先，失败/停滞时依次切镜像。
function registryChain(current: string | null): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  const push = (r: string | null | undefined) => {
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

async function checkLatest(ctx: UpdaterCtx): Promise<string> {
  // 主源查不到/超时后自动试镜像源（更新弹窗外静默执行，失败不打扰用户）。
  const chain = registryChain(await currentRegistry(ctx));
  const errors: string[] = [];
  for (const registry of chain) {
    const args = ['view', PKG, 'version'];
    if (registry) args.push('--registry=' + registry);
    try {
      const out = await runNpm(ctx, args, { timeoutMs: 90000 });
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const v = lines[lines.length - 1]!.trim();
      if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('无法解析官方版本号: ' + JSON.stringify(v));
      if (registry) ctx.log('update', '版本检查成功（镜像源 ' + registry + '）');
      return v;
    } catch (err) {
      errors.push((registry || '默认源') + ': ' + (err as Error).message);
    }
  }
  throw new Error('无法获取官方版本号（' + errors.join('；') + '）');
}

function previousAgentDir(ctx: UpdaterCtx): string { return path.join(ctx.userDataDir, 'agent-previous'); }

function agentPackagePath(dir: string): string { return path.join(dir, 'node_modules', PKG, 'package.json'); }
function agentBinPath(dir: string): string { return path.join(dir, 'node_modules', PKG, 'lib', 'bin.js'); }
function agentVersionIn(dir: string): string | null {
  try {
    const pkg = readJsonFile(agentPackagePath(dir));
    return pkg && typeof pkg.version === 'string' ? pkg.version : null;
  } catch { return null; }
}

function validAgentDir(dir: string, expectedVersion?: string | null): boolean {
  const version = agentVersionIn(dir);
  if (!version || !fs.existsSync(agentBinPath(dir))) return false;
  return !expectedVersion || version === expectedVersion;
}

// 上一版本备份是否可用（供启动失败对话框选择「回退到上一版本」）。
function previousAgentInfo(ctx: UpdaterCtx): Record<string, any> | null {
  const settings = loadSettings(ctx);
  if (!settings.previousAgent || !settings.previousAgent.version) return null;
  if (!validAgentDir(previousAgentDir(ctx), settings.previousAgent.version)) return null;
  return settings.previousAgent;
}

// 安装阶段进度上报回调的载荷：
//   { stage: 'fetch', count, elapsed, registry }   —— 下载依赖中（按 npm 输出
//     统计已获取的包/元数据项数）
//   { stage: 'install', registry }                  —— 进入解包安装阶段
//   { stage: 'verify' }                             —— 审计依赖闭包并加载 CLI
//   { stage: 'done' }                               —— 验证完成并已切换版本
//   { stage: 'mirror', registry }                   —— 源停滞/失败，已切换镜像源
interface UpdateProgress {
  stage: 'fetch' | 'install' | 'verify' | 'done' | 'mirror';
  count?: number;
  elapsed?: string;
  registry?: string | null;
}
async function applyUpdate(ctx: UpdaterCtx, version: string, { onProgress = null, stallMs = NPM_STALL_MS }: { onProgress?: ((p: UpdateProgress) => void) | null; stallMs?: number } = {}): Promise<{ version: string; logPath: string }> {
  const staging = stagingDir(ctx);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const logPath = path.join(ctx.userDataDir, 'logs', 'update.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const chain = registryChain(await currentRegistry(ctx));
  const errors: string[] = [];
  let installErr: Error | null = null;
  const started = Date.now();
  const fmt = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  };
  for (let i = 0; i < chain.length; i++) {
    const registry = chain[i]!;
    if (i > 0 && onProgress) {
      try { onProgress({ stage: 'mirror', registry }); } catch {}
      ctx.log('update', '下载源 ' + registry + ' 不可用，自动切换镜像源 ' + (chain[i]! || '默认源'));
    }
    // npm 安装进度解析：--loglevel=info 会输出 "npm http fetch GET 200 …" 行
    //（每个包/元数据一次）与 reify 阶段行；按此上报实时进度与阶段。
    let fetchCount = 0;
    let sawReify = false;
    let sawAdded = false;
    let lastPush = 0;
    const push = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastPush < 500) return;
      lastPush = now;
      if (!onProgress) return;
      try {
        onProgress({ stage: (sawAdded || sawReify) ? 'install' : 'fetch', count: fetchCount, elapsed: fmt(now - started), registry });
      } catch {}
    };
    const onOutput = (chunk: Buffer) => {
      const text = String(chunk);
      if (text.includes('http fetch GET 200') || /fetch\s+GET\s+200/i.test(text)) fetchCount++;
      if (/reify:/i.test(text)) sawReify = true;
      if (/added\s+\d+\s+packages\s+in/i.test(text)) sawAdded = true;
      push(false);
    };
    try {
      const args: string[] = [
        'install', '--prefix', staging, PKG + '@' + version,
        '--save-exact', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier',
        // 绝不执行第三方构建脚本（与 plugin-updater 的安装语义对齐）：
        // node-pty 等原生依赖的 prebuilds/ 已随包分发，本地 node-gyp 构建
        // 在无 VS Build Tools / 网络受限环境会长时间静默（用户侧表现为
        // 「卡 125/126」，换镜像源也无解），平台错配应走预编译产物而非现场编译。
        '--ignore-scripts',
        '--loglevel=info',
      ];
      if (registry) args.push('--registry=' + registry);
      await runNpm(ctx, args, { timeoutMs: 30 * 60 * 1000, logStream, onOutput, stallMs });
      installErr = null;
      break;
    } catch (err) {
      installErr = err as Error;
      errors.push((registry || '默认源') + ': ' + (err as Error).message);
      ctx.log('update', '下载失败（' + (registry || '默认源') + '）: ' + (err as Error).message);
      if (i === chain.length - 1 && onProgress) {
        try { onProgress({ stage: 'mirror', registry: null }); } catch {}
      }
    }
  }
  if (installErr) {
    logStream.end();
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(installErr.message + '（已尝试镜像源：' + errors.join('；') + '；日志: ' + logPath + '）');
  }

  try {
    if (onProgress) { try { onProgress({ stage: 'verify' }); } catch {} }
    await validateStagedAgent(ctx, staging, version, logStream);
  } catch (err) {
    logStream.end();
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('安装结果验证失败：' + String((err as Error).message || err) + '（旧版本未变；日志: ' + logPath + '）');
  }
  logStream.end();

  // Atomic swap: old overlay -> backup, staging -> overlay.
  // M4 修复：两处重命名都纳入 try，失败时回滚并清理 staging 残留。
  // V4.1 更新保障②：备份不再立即删除 —— 换名保留为 agent-previous，
  // 直到下次启动确认新版健康（confirmPreviousAgentHealthy）才清理，
  // 启动失败时用户可一键回退到上一版本。
  const overlay = overlayDir(ctx);
  const backup = path.join(ctx.userDataDir, 'agent-old-' + Date.now());
  const oldVersion = overlayVersion(ctx);
  const hadValidOldOverlay = validAgentDir(overlay, oldVersion);
  // 配置快照必须与 Agent 目录备份分离。旧实现预先创建 backup/config，随后
  // 又尝试把旧 agent 重命名到已存在的 backup，Windows 上会直接 EPERM；
  // 首次安装还会把只有 config 的目录误记成 agent-previous。
  try {
    const cfgDir = path.join(ctx.userDataDir, 'agent-config-backup');
    fs.rmSync(cfgDir, { recursive: true, force: true });
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
    ctx.log('update', '配置快照写入失败（不影响更新主体）: ' + String(snapErr && (snapErr as Error).message));
    // 快照是「锦上添花」：失败不阻塞 swap 主流程。
  }
  try {
    if (fs.existsSync(overlay)) fs.renameSync(overlay, backup);
    fs.renameSync(staging, overlay);
  } catch (err) {
    try {
      if (!fs.existsSync(overlay) && fs.existsSync(backup)) fs.renameSync(backup, overlay);
    } catch (rollbackErr) {
      ctx.log('update', '回滚 overlay 失败: ' + String(rollbackErr && (rollbackErr as Error).message));
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('切换新版本失败: ' + (err && (err as Error).message) + '（staging 已清理）');
  }
  // 上一份残留备份（上次更新后既未确认健康也未回退）已过时，直接清除，
  // 新备份以固定名保留。
  const prevDir = previousAgentDir(ctx);
  if (fs.existsSync(prevDir)) fs.rmSync(prevDir, { recursive: true, force: true });
  let previousPreserved = false;
  if (hadValidOldOverlay && fs.existsSync(backup)) {
    try { fs.renameSync(backup, prevDir); } catch (err) {
      ctx.log('update', '保留上一版本备份失败: ' + (err as Error).message);
      fs.rmSync(backup, { recursive: true, force: true });
    }
    previousPreserved = fs.existsSync(prevDir);
  } else if (fs.existsSync(backup)) {
    // 原 overlay 结构不完整时不能伪装成可回退版本；保留为 broken 仅供诊断。
    try { fs.renameSync(backup, path.join(ctx.userDataDir, 'agent-broken-' + Date.now())); }
    catch { fs.rmSync(backup, { recursive: true, force: true }); }
  }

  const settings = loadSettings(ctx);
  settings.previousAgent = previousPreserved && oldVersion
    ? { version: oldVersion, dir: 'agent-previous', at: new Date().toISOString() }
    : null;
  settings.skipVersion = null;
  saveSettings(ctx, settings);
  if (onProgress) { try { onProgress({ stage: 'done' }); } catch {} }
  ctx.log('update', '更新完成: ' + PKG + '@' + version + (previousPreserved ? '（上一版本备份保留至确认健康）' : ''));
  return { version, logPath };
}

// 下次启动确认新版健康后调用：清理 agent-previous 备份。
// ⚠️ 严禁同步 rm：agent-previous 是数百 MB 级覆盖层，rmSync 会冻结 sidecar
// 事件循环（调用方在 boot 后延迟 30s 触发，正值用户可操作窗口，同步删
// 会复现「全部 RPC 卡死」的 5.3.5 P0 形态）。本函数必须保持 async。
async function confirmPreviousAgentHealthy(ctx: UpdaterCtx): Promise<boolean> {
  const settings = loadSettings(ctx);
  if (!settings.previousAgent) return false;
  const prevDir = previousAgentDir(ctx);
  try {
    if (fs.existsSync(prevDir)) await fs.promises.rm(prevDir, { recursive: true, force: true, maxRetries: 3 });
    settings.previousAgent = null;
    saveSettings(ctx, settings);
    ctx.log('update', '新版启动确认健康，已清理上一版本备份');
    return true;
  } catch (err) {
    ctx.log('update', '清理上一版本备份失败: ' + (err as Error).message);
    return false;
  }
}

// 启动失败时手动回退到上一版本：当前 overlay 移为 agent-broken-*，
// agent-previous 还原为 overlay。
function rollbackToPrevious(ctx: UpdaterCtx): string | null {
  const settings = loadSettings(ctx);
  const prevDir = previousAgentDir(ctx);
  const overlay = overlayDir(ctx);
  const prev = previousAgentInfo(ctx);
  if (!prev) return null;
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
    ctx.log('update', '回退到上一版本失败: ' + (err as Error).message);
    return null;
  }
}

function rollback(ctx: UpdaterCtx): string | null {
  const overlay = overlayDir(ctx);
  if (!fs.existsSync(overlay)) return null;
  const broken = path.join(ctx.userDataDir, 'agent-broken-' + Date.now());
  fs.renameSync(overlay, broken);
  ctx.log('update', '已回退到内置版本（问题副本保留在 ' + broken + '）');
  return broken;
}

export = {
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

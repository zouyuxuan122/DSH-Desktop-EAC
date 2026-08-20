/**
 * updater.ts — 内置 @deepseek-ai/dsh agent 的自更新引擎（Task 7.1 自
 * updater.js 迁 TS）。
 *
 * 流程：
 *   1. checkLatest():  内置 npm 运行 "npm view @deepseek-ai/dsh version"
 *      （尊重用户 .npmrc 的 registry / 代理设置）。
 *   2. 用户在弹窗确认（"立即更新 / 跳过此版本 / 稍后"）。
 *   3. applyUpdate():  以内置 node + npm 把官方新版本装进 STAGING 目录
 *      （<userData>/agent-staging），随后原子换名为 <userData>/agent。
 *      失败绝不触碰正在工作的副本。
 *   4. dshBin()（lib/proc.ts）优先取 overlay（<userData>/agent/…）而非
 *      内置副本，新版本重启后生效。
 *   5. rollback():  overlay 启动失败时一键回退到内置版本。
 *
 * overlay 位于用户可写数据目录，NSIS 安装版与便携版（解包资源每次启动
 * 重建）都能更新。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const PKG = '@deepseek-ai/dsh';
const IS_WIN = process.platform === 'win32';

// 镜像源链：默认源（用户 .npmrc / NPM_CONFIG_REGISTRY）卡住或失败时依次
// 自动切换。切换与结果都会经 onProgress 上报给更新弹窗提示。
const NPM_MIRRORS = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
// 单个 npm 命令「无任何输出」的停滞上限：超过即判死并切换镜像源
//（npm 解析依赖时可能长时间静默，阈值取 150 秒）。
const NPM_STALL_MS = 150 * 1000;

let activeProc: ChildProcess | null = null;

/** 传给 updater 各 API 的上下文（见 lib/proc.ts 的 updCtx()）。 */
export interface UpdCtx {
  /** Electron userData 目录。 */
  userDataDir: string;
  /** 内置 node.exe 路径解析器。 */
  nodeExe(): string;
  /** 内置 npm-cli.js 路径解析器。 */
  npmCli(): string;
  /** 统一日志通道（lib/log.ts）。 */
  log(tag: string, msg: string): void;
}

/** settings.json 的形状（仅声明桌面壳读写的字段，其余视为未知扩展）。 */
export interface DshSettings {
  shareWebProfile?: boolean;
  closeToTray?: boolean;
  shortcutPolicy?: string;
  previousAgent?: { version: string; dir?: string; at?: string } | null;
  skipVersion?: string | null;
  skipClientVersion?: string | null;
  pendingClientUpdate?: { version?: string; path?: string; source?: string } | null;
  [key: string]: unknown;
}

/** agent 更新的进度事件（npm 阶段流）。 */
export interface AgentProgressEvent {
  stage: 'fetch' | 'install' | 'done' | 'mirror' | string;
  count?: number;
  elapsed?: string;
  registry?: string | null;
}

// --- settings -------------------------------------------------------------

export function settingsPath(ctx: UpdCtx): string {
  return path.join(ctx.userDataDir, 'settings.json');
}

export function loadSettings(ctx: UpdCtx): DshSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(ctx), 'utf8')) as DshSettings;
  } catch {
    return {};
  }
}

export function saveSettings(ctx: UpdCtx, s: DshSettings): void {
  try {
    fs.writeFileSync(settingsPath(ctx), JSON.stringify(s, null, 2) + '\n');
  } catch (err) {
    ctx.log('update', '保存 settings 失败: ' + String((err as Error).message));
  }
}

// --- overlay paths --------------------------------------------------------

function overlayDir(ctx: UpdCtx): string {
  return path.join(ctx.userDataDir, 'agent');
}

function stagingDir(ctx: UpdCtx): string {
  return path.join(ctx.userDataDir, 'agent-staging');
}

export function overlayBinPath(ctx: UpdCtx): string | null {
  return path.join(overlayDir(ctx), 'node_modules', PKG, 'lib', 'bin.js');
}

export function overlayVersion(ctx: UpdCtx): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(path.join(overlayDir(ctx), 'node_modules', PKG, 'package.json')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function bundledVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(PKG + '/package.json') as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function activeVersion(ctx: UpdCtx): string | null {
  return overlayVersion(ctx) || bundledVersion();
}

// --- semver 风格比较（兼容 0.1.0-rc.N 预发布段） ---------------------------

export function compareVersions(a: string, b: string): number {
  interface Parsed {
    nums: number[];
    pre: string;
    preNum: number;
    hasPre: boolean;
  }
  const parse = (v: string): Parsed => {
    const [core = '', pre = ''] = String(v).split('-');
    const nums = core.split('.').map((s) => parseInt(s, 10) || 0);
    const preNum = parseInt((pre.match(/\d+/) || [''])[0] as string, 10);
    return { nums, pre, preNum: Number.isNaN(preNum) ? -1 : preNum, hasPre: !!pre };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const an = A.nums[i] ?? 0;
    const bn = B.nums[i] ?? 0;
    if (an !== bn) return an - bn;
  }
  if (A.hasPre !== B.hasPre) return A.hasPre ? -1 : 1; // 预发布 < 正式版
  if (A.hasPre && A.pre !== B.pre) {
    if (A.preNum >= 0 && B.preNum >= 0 && A.preNum !== B.preNum) return A.preNum - B.preNum;
    return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
  }
  return 0;
}

// --- npm 运行器 ------------------------------------------------------------

function killProc(proc: ChildProcess | null): void {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else proc.kill('SIGTERM');
  } catch {
    /* 已退出 */
  }
}

/** 中止正在进行的 npm 子进程（更新/回退期间应用退出时调用）。 */
export function abort(): void {
  killProc(activeProc);
  activeProc = null;
}

/** runNpm 选项。 */
export interface RunNpmOpts {
  timeoutMs?: number;
  logStream?: fs.WriteStream | null;
  onOutput?: ((chunk: string | Buffer) => void) | null;
  stallMs?: number;
}

/** 用内置 node+npm 运行一次 npm 命令（带整体超时 / 停滞检测 / 输出回灌）。 */
export function runNpm(ctx: UpdCtx, args: string[], opts: RunNpmOpts = {}): Promise<string> {
  const { timeoutMs = 30 * 60 * 1000, logStream = null, onOutput = null, stallMs = 0 } = opts;
  return new Promise<string>((resolve, reject) => {
    const nodeBin = ctx.nodeExe();
    const cli = ctx.npmCli();
    if (!fs.existsSync(nodeBin) || !fs.existsSync(cli)) {
      reject(new Error('内置 Node/npm 运行时缺失，无法检查或执行更新。'));
      return;
    }
    ctx.log('update', 'npm ' + args.join(' '));
    try {
      fs.mkdirSync(ctx.userDataDir, { recursive: true });
    } catch {
      /* 已存在 */
    }
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
    let stderrBuf = '';
    const finishOk = (v: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stallTimer) clearTimeout(stallTimer);
      activeProc = null;
      resolve(v);
    };
    const finishErr = (e: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stallTimer) clearTimeout(stallTimer);
      activeProc = null;
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => {
      killProc(proc);
      finishErr(new Error('npm 执行超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
    }, timeoutMs);
    // 停滞检测：stallMs > 0 时，超过阈值没有产生任何输出即判死（触发
    // 调用方切换镜像源），避免「卡住但没到整体超时」的长时间空转。
    let stallTimer: NodeJS.Timeout | null = null;
    const armStall = (): void => {
      if (!stallMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        killProc(proc);
        finishErr(new Error('下载停滞（' + Math.round(stallMs / 1000) + ' 秒无进展），将切换镜像源重试'));
      }, stallMs);
    };
    const onChunk = (c: string | Buffer): void => {
      armStall();
      if (logStream) logStream.write(c);
      if (onOutput) {
        try {
          onOutput(c);
        } catch {
          /* 回调异常不中断安装 */
        }
      }
    };
    armStall();
    proc.stdout?.on('data', (c: Buffer) => {
      stdoutBuf += c.toString();
      onChunk(c);
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderrBuf += c.toString();
      onChunk(c);
    });
    proc.on('error', (err) => finishErr(err));
    proc.on('exit', (code) => {
      if (code === 0) finishOk(stdoutBuf);
      else {
        const tail = (stderrBuf + stdoutBuf).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
        finishErr(new Error('npm 退出码 ' + code + (tail ? '：' + tail.slice(-500) : '')));
      }
    });
  });
}

/** 当前生效的 registry（.npmrc / NPM_CONFIG_REGISTRY），供镜像源链去重与提示。 */
export async function currentRegistry(ctx: UpdCtx): Promise<string | null> {
  try {
    const out = await runNpm(ctx, ['config', 'get', 'registry'], { timeoutMs: 30_000 });
    const v = String(out || '').trim().replace(/\/+$/, '');
    return v || null;
  } catch {
    return null;
  }
}

/** 拼接镜像源尝试链：默认源（尊重用户配置）优先，失败/停滞时依次切镜像。 */
export function registryChain(current: string | null): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  const push = (r: string | null): void => {
    if (!r) return;
    const norm = r.replace(/\/+$/, '');
    const key = norm.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      chain.push(norm);
    }
  };
  push(current);
  for (const m of NPM_MIRRORS) push(m);
  return chain;
}

// --- public API -----------------------------------------------------------

/** npm 检查最新版本（主源失败自动走镜像链）；失败抛错。 */
export async function checkLatest(ctx: UpdCtx): Promise<string> {
  const chain = registryChain(await currentRegistry(ctx));
  const errors: string[] = [];
  for (const registry of chain) {
    const args = ['view', PKG, 'version'];
    if (registry) args.push('--registry=' + registry);
    try {
      const out = await runNpm(ctx, args, { timeoutMs: 90_000 });
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const v = (lines[lines.length - 1] ?? '').trim();
      if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('无法解析官方版本号: ' + JSON.stringify(v));
      if (registry) ctx.log('update', '版本检查成功（镜像源 ' + registry + '）');
      return v;
    } catch (err) {
      errors.push((registry || '默认源') + ': ' + String((err as Error).message));
    }
  }
  throw new Error('无法获取官方版本号（' + errors.join('；') + '）');
}

function previousAgentDir(ctx: UpdCtx): string {
  return path.join(ctx.userDataDir, 'agent-previous');
}

/** 上一版本备份是否可用（供启动失败对话框选择「回退到上一版本」）。 */
export function previousAgentInfo(ctx: UpdCtx): { version: string; dir?: string; at?: string } | null {
  const settings = loadSettings(ctx);
  if (!settings.previousAgent || !settings.previousAgent.version) return null;
  if (!fs.existsSync(previousAgentDir(ctx))) return null;
  return settings.previousAgent;
}

/**
 * 下载并安装 agent 更新 overlay。
 * 进度上报载荷：
 *   { stage: 'fetch', count, elapsed, registry }   —— 下载依赖中
 *   { stage: 'install', registry }                  —— 进入解包安装阶段
 *   { stage: 'done' }                               —— npm 安装成功，即将切换
 *   { stage: 'mirror', registry }                   —— 源停滞/失败，已切换镜像源
 */
export async function applyUpdate(
  ctx: UpdCtx,
  version: string,
  opts: { onProgress?: ((ev: AgentProgressEvent) => void) | null; stallMs?: number } = {},
): Promise<{ version: string; logPath: string }> {
  const { onProgress = null, stallMs = NPM_STALL_MS } = opts;
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
  const fmt = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  };
  for (let i = 0; i < chain.length; i++) {
    const registry = chain[i] ?? null;
    if (i > 0 && onProgress) {
      try {
        onProgress({ stage: 'mirror', registry });
      } catch {
        /* 回调异常不中断安装 */
      }
      ctx.log('update', '下载源 ' + registry + ' 不可用，自动切换镜像源 ' + (chain[i] || '默认源'));
    }
    // npm 安装进度解析：--loglevel=info 会输出 "npm http fetch GET 200 …" 行
    //（每个包/元数据一次）与 reify 阶段行；按此上报实时进度与阶段。
    let fetchCount = 0;
    let sawReify = false;
    let sawAdded = false;
    let lastPush = 0;
    const push = (force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastPush < 500) return;
      lastPush = now;
      if (!onProgress) return;
      try {
        onProgress(
          sawAdded
            ? { stage: 'done' }
            : { stage: sawReify ? 'install' : 'fetch', count: fetchCount, elapsed: fmt(now - started), registry },
        );
      } catch {
        /* 回调异常不中断安装 */
      }
    };
    const onOutput = (chunk: string | Buffer): void => {
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
        '--loglevel=info',
      ];
      if (registry) args.push('--registry=' + registry);
      await runNpm(ctx, args, { timeoutMs: 30 * 60 * 1000, logStream, onOutput, stallMs });
      if (onProgress) {
        try {
          onProgress({ stage: 'done' });
        } catch {
          /* 回调异常不中断安装 */
        }
      }
      installErr = null;
      break;
    } catch (err) {
      installErr = err instanceof Error ? err : new Error(String(err));
      errors.push((registry || '默认源') + ': ' + installErr.message);
      ctx.log('update', '下载失败（' + (registry || '默认源') + '）: ' + installErr.message);
      if (i === chain.length - 1 && onProgress) {
        try {
          onProgress({ stage: 'mirror', registry: null });
        } catch {
          /* 回调异常不中断安装 */
        }
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

  // 原子切换：旧 overlay → 备份，staging → overlay。
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
    ctx.log('update', '配置快照写入失败（不影响更新主体）: ' + String((snapErr as Error)?.message));
    // 快照是「锦上添花」：失败不阻塞 swap 主流程。
  }
  try {
    if (fs.existsSync(overlay)) fs.renameSync(overlay, backup);
    fs.renameSync(staging, overlay);
  } catch (err) {
    try {
      if (!fs.existsSync(overlay) && fs.existsSync(backup)) fs.renameSync(backup, overlay);
    } catch (rollbackErr) {
      ctx.log('update', '回滚 overlay 失败: ' + String((rollbackErr as Error)?.message));
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('切换新版本失败: ' + String((err as Error)?.message) + '（staging 已清理）');
  }
  // 上一份残留备份（上次更新后既未确认健康也未回退）已过时，直接清除，
  // 新备份以固定名保留。
  const prevDir = previousAgentDir(ctx);
  if (fs.existsSync(prevDir)) fs.rmSync(prevDir, { recursive: true, force: true });
  if (fs.existsSync(backup)) {
    try {
      fs.renameSync(backup, prevDir);
    } catch (err) {
      ctx.log('update', '保留上一版本备份失败: ' + String((err as Error)?.message));
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

/** 下次启动确认新版健康后调用：清理 agent-previous 备份。 */
export function confirmPreviousAgentHealthy(ctx: UpdCtx): boolean {
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
    ctx.log('update', '清理上一版本备份失败: ' + String((err as Error)?.message));
    return false;
  }
}

/** 启动失败时手动回退到上一版本：当前 overlay 移为 agent-broken-*，
 *  agent-previous 还原为 overlay。 */
export function rollbackToPrevious(ctx: UpdCtx): string | null {
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
    ctx.log('update', '回退到上一版本失败: ' + String((err as Error)?.message));
    return null;
  }
}

/** 回退到内置版本（清掉 overlay）。 */
export function rollback(ctx: UpdCtx): string | null {
  const overlay = overlayDir(ctx);
  if (!fs.existsSync(overlay)) return null;
  const broken = path.join(ctx.userDataDir, 'agent-broken-' + Date.now());
  fs.renameSync(overlay, broken);
  ctx.log('update', '已回退到内置版本（问题副本保留在 ' + broken + '）');
  return broken;
}

export { PKG, NPM_MIRRORS };

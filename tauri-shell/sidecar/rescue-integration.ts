'use strict';
// 救援链 sidecar 集成（硬门槛②）—— 自 main.js 的 rescue-*/safe-mode 辅助族移植。
// 追加挂载到 server.ts（保持主文件可读性；编译进同一 server.js 产物）。
// 用法：在 server.ts 尾部（readline 循环之前）require 本文件并传入上下文。

import path = require('node:path');
import fs = require('node:fs');
import os = require('node:os');
import cp = require('node:child_process');

export interface RescueHost {
  dshHome: string;
  userDataDir: string;
  pkgVersion: string;
  desktopProfile(): string;
  desktopProfileDir(): string;
  dshVersion(): string;
  dshVersionSource(): string;
  log(tag: string, msg: string): void;
  notify(method: string, params: unknown): void;
  /** 已挂载模块（server.ts 侧的局部引用集合）。 */
  mods: Record<string, Record<string, unknown>>;
  bootRestart(): Promise<Record<string, unknown>>;
}

type RescueFn = (...a: unknown[]) => unknown;
const ra = (): Record<string, RescueFn> => rescueAgent as Record<string, RescueFn>;

let H!: RescueHost;
const DSH_DESKTOP_ROOT = process.env.DSH_RESOURCE_ROOT
  ? path.join(process.env.DSH_RESOURCE_ROOT, 'dsh-desktop')
  : path.resolve(__dirname, '..', '..', 'dsh-desktop');
const rescueAgent: Record<string, unknown> = require(path.join(DSH_DESKTOP_ROOT, 'rescue-agent.js')) as Record<string, unknown>;
const atomicJson = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'atomic-json.js')) as {
  writeJsonAtomic(file: string, value: unknown): void;
};
// 安全模式唯一实现（vnext 收编）：与 rc.action 共用 lib/recovery-center/register.js。
const recoveryCenter = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'recovery-center', 'register.js')) as {
  safeModeEnable(opts?: { requestRelaunch?: boolean; logTag?: string }): Record<string, unknown>;
  safeModeDisable(logTag?: string): Record<string, unknown>;
  safeModeStatus(): Record<string, unknown> | null;
};
const RA_OPTS = rescueAgent.DEFAULT_OPTS as unknown as { BOOT_FAILURE_THRESHOLD: number; MODEL: string; AI_TIMEOUT_MS: number };

export function initRescue(host: RescueHost): void {
  H = host;
}

function guardDirPath(): string { return path.join(H.dshHome, 'guard'); }
function rescueStateFile(): string { return path.join(guardDirPath(), 'rescue-state.json'); }

function readJsonLocal<T>(file: string, def: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return def; }
}

function writeJsonSafe(file: string, value: unknown): void {
  try {
    atomicJson.writeJsonAtomic(file, value);
  } catch (err) {
    H.log('rescue', '写状态文件失败: ' + String(((err as Error).message) || err));
  }
}

export function recordBootFailureNow(errText: string): void {
  const file = rescueStateFile();
  const prev = readJsonLocal<Record<string, unknown> | null>(file, null);
  const next = (ra().recordBootFailure as (p: unknown) => Record<string, unknown>)(prev);
  next.lastErrText = String(errText || '').slice(0, 8000);
  next.lastErrAt = new Date().toISOString();
  writeJsonSafe(file, next);
}

export function shouldEnterRescueNow(): boolean {
  return !!(ra().shouldEnterRescue as (s: unknown) => boolean)(readJsonLocal(rescueStateFile(), null));
}

export function clearRescueState(): void {
  try { fs.rmSync(rescueStateFile(), { force: true }); } catch { /* 已不存在 */ }
}

function guardInst(): Record<string, (...a: unknown[]) => unknown> {
  return (H.mods.guardBox!.ensureGuard as () => unknown)() as Record<string, (...a: unknown[]) => unknown>;
}

export function safeModeStatus(): Record<string, unknown> | null {
  return recoveryCenter.safeModeStatus();
}

// safe-mode 开关（救援页/壳层安全模式入口；开启不经 rc.action 的 relaunch
// 语义，由调用方决定何时重启，与 register.safeModeEnable({requestRelaunch:false})
// 对齐旧实现行为）。
export function safeModeSet(on: boolean): Record<string, unknown> {
  if (on) return recoveryCenter.safeModeEnable({ requestRelaunch: false, logTag: 'rescue' });
  return recoveryCenter.safeModeDisable('rescue');
}

// 诊断上下文收集（单项失败按空处理，绝不抛）。
function buildRescueDiagnosis(): { sendManifest: unknown; totalBytes: number; payload: unknown } | null {
  try {
    const g = guardInst();
    const state = readJsonLocal<Record<string, unknown> | null>(rescueStateFile(), null);
    return (ra().collectDiagnosis as (o: unknown) => { sendManifest: unknown; totalBytes: number; payload: unknown })({
      dshHome: H.dshHome,
      profileDir: H.desktopProfileDir(),
      logsDir: path.join(H.userDataDir, 'logs'),
      profile: H.desktopProfile(),
      versions: { app: H.pkgVersion, dsh: H.dshVersion(), source: H.dshVersionSource() },
      plugins: () => { try { return (H.mods.pluginOps!.pluginManagerCollect as () => unknown[])(); } catch { return []; } },
      snapshots: () => (g.listSnapshots as () => unknown[])(),
      lastGood: () => (g.lastGoodSnapshot as () => unknown)(),
      incidents: () => (g.listIncidents as () => unknown[])().slice(0, 6),
      readIncident: (id: unknown) => { const r = (g.readIncident as (i: unknown) => { ok?: boolean; content?: unknown })(id); return r && r.ok ? r.content : null; },
      health: () => (g.healthCheck as () => { findings: unknown })().findings,
      attribution: () => {
        const errText = state && state.lastErrText;
        if (!errText) return null;
        try { return (g.attributeBootFailure as (t: string) => unknown)(String(errText)); } catch { return null; }
      },
      lastErrText: () => String((state && state.lastErrText) || ''),
    });
  } catch (err) {
    H.log('rescue', '诊断上下文收集失败: ' + String(((err as Error).message) || err));
    return null;
  }
}

// AI 建议执行器（只接受 rescue-agent 白名单动作）。
async function rescueExecuteSuggestion(s: { action: string; params: Record<string, unknown>; reason?: string; risk?: string }): Promise<Record<string, unknown>> {
  const g = guardInst();
  const serverState = () => (H.mods.boot!.state as () => { running: boolean; webUrl: string })();
  switch (s.action) {
    case 'restore': {
      if (serverState().running) {
        return { ok: false, error: 'service-running', hint: '请先重启服务（回滚需在重启间隙执行）' };
      }
      const r = (g.restore as (id: unknown) => Record<string, unknown>)(s.params.snapshotId);
      return r.ok
        ? { ok: true, result: '已回滚到快照 ' + String(s.params.snapshotId), restartRequired: true }
        : { ok: false, error: String((r && r.error) || '回滚失败') };
    }
    case 'disable': {
      const row = (H.mods.pluginOps!.pluginManagerCollect as () => Array<{ id: string; toggleable?: boolean }>)().find((x) => x.id === s.params.pluginId);
      if (!row) return { ok: false, error: '未知插件: ' + String(s.params.pluginId) };
      if (!row.toggleable) return { ok: false, error: '该插件不可关闭: ' + String(s.params.pluginId) };
      const r = (H.mods.pluginOps!.pluginManagerSetEnabled as (id: string, en: boolean) => Record<string, unknown>)(String(s.params.pluginId), false);
      return r.ok
        ? { ok: true, result: '已停用插件 ' + String(s.params.pluginId), restartRequired: true }
        : { ok: false, error: String((r && r.error) || '停用失败') };
    }
    case 'remove': {
      const r = (H.mods.pluginOps!.pluginManagerSetRemoved as (id: string, rm: boolean) => Record<string, unknown>)(String(s.params.pluginId), true);
      return r.ok
        ? { ok: true, result: '已卸载插件 ' + String(s.params.pluginId), restartRequired: true }
        : { ok: false, error: String((r && r.error) || '卸载失败') };
    }
    case 'repair': {
      const r = (g.repair as () => { applied?: string[] })();
      const applied = (r && r.applied) || [];
      return { ok: true, result: applied.length ? '已应用修复: ' + applied.join('；') : '体检未发现可修复项' };
    }
    case 'edit-file': {
      const snap = (g.snapshot as (r: string) => { id: string } | null)('ai-edit-before');
      const ctx = {
        home: H.dshHome,
        profileDir: H.desktopProfileDir(),
        readFile: (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
        writeFile: (f: string, text: string) => { fs.writeFileSync(f, text, 'utf8'); },
        backup: (f: string) => { try { fs.copyFileSync(f, f + '.ai-bak'); } catch { /* 尽力备份 */ } },
      };
      const r = (ra().applyProfileEdit as (p: unknown, c: unknown) => Record<string, unknown> & { file?: string; opsApplied?: number })(s.params, ctx);
      if (!r.ok) return { ok: false, error: String(r.error) };
      return { ok: true, result: `已编辑 ${r.file}（${r.opsApplied} 处改动）`, restartRequired: true, snapshotId: snap && snap.id };
    }
    case 'resync': {
      if (serverState().running) {
        return { ok: false, error: 'service-running', hint: '请先重启服务（模块树重装需在重启间隙执行）' };
      }
      const notes: string[] = [];
      try { (H.mods.companionSync!.syncCompanionPlugins as () => void)(); notes.push('内置插件树已同步'); } catch (err) {
        return { ok: false, error: '内置插件同步失败: ' + String(((err as Error).message) || err) };
      }
      try { (H.mods.companionSync!.healProfileModules as () => void)(); notes.push('模块遮蔽已清理'); } catch (err) {
        return { ok: false, error: '模块树修复失败: ' + String(((err as Error).message) || err) };
      }
      return { ok: true, result: notes.join('；'), restartRequired: true };
    }
    case 'safe-mode': {
      const r = safeModeSet(s.params.on === true);
      return r.ok
        ? { ok: true, result: s.params.on ? '已开启安全模式（重启服务生效）' : '已退出安全模式（重启服务生效）', restartRequired: true }
        : r;
    }
    case 'retry': {
      if (serverState().running) {
        const r = await H.bootRestart();
        return r.ok ? { ok: true, result: '服务已重启: ' + String(r.webUrl) } : r;
      }
      const r = await (H.mods.boot!.startAndWait as (o: string[]) => Promise<{ webUrl: string }>)([]);
      H.notify('boot.web-ready', r);
      return { ok: true, result: '服务已启动: ' + r.webUrl };
    }
    case 'export':
      return { ok: true, result: '已提示用户导出诊断 zip（导出在「导出日志」按钮）' };
    default:
      return { ok: false, error: 'unknown action: ' + s.action };
  }
}

let rescueBusy = false;

type ArchiverLike = {
  directory(source: string, destination: false): ArchiverLike;
  finalize(): Promise<void> | void;
  on(event: string, listener: (error: Error) => void): ArchiverLike;
  pipe(output: NodeJS.WritableStream): NodeJS.WritableStream;
};

export function resolveLogsExportDir(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  fallbackDir: string,
): string {
  const candidates = [
    env.DSH_LOG_EXPORT_DIR,
    env.OneDriveConsumer && path.join(env.OneDriveConsumer, 'Desktop'),
    env.OneDriveCommercial && path.join(env.OneDriveCommercial, 'Desktop'),
    env.OneDrive && path.join(env.OneDrive, 'Desktop'),
    path.join(homeDir, 'Desktop'),
  ].filter((candidate): candidate is string => !!candidate);
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  }) || fallbackDir;
}

/** macOS 保留系统 ditto；其他平台使用 Node archiver，避免 shell 路径解析。 */
export function buildZipCommand(
  platform: NodeJS.Platform,
  logsDir: string,
  zip: string,
): { program: string; args: string[] } | null {
  return platform === 'darwin'
    ? { program: 'ditto', args: ['-c', '-k', logsDir, zip] }
    : null;
}

async function runArchiveCommand(command: { program: string; args: string[] }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(command.program, command.args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command.program} failed (${signal || `exit ${String(code)}`})`));
    });
  });
}

export async function createLogsArchive(
  logsDir: string,
  zipPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const command = buildZipCommand(platform, logsDir, zipPath);
  if (command) {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    try {
      await runArchiveCommand(command);
      if (!fs.existsSync(zipPath)) throw new Error(`${command.program} did not create archive`);
    } catch (error) {
      try { fs.rmSync(zipPath, { force: true }); } catch {}
      throw error;
    }
    return;
  }
  const archiverPath = require.resolve('archiver', { paths: [DSH_DESKTOP_ROOT] });
  const archiverFactory = require(archiverPath) as (format: 'zip', options: Record<string, unknown>) => ArchiverLike;
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiverFactory('zip', { zlib: { level: 9 } });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        try { output.destroy(); } catch {}
        try { fs.rmSync(zipPath, { force: true }); } catch {}
        reject(error);
      } else {
        resolve();
      }
    };
    output.on('close', () => finish());
    output.on('error', (error) => finish(error));
    archive.on('error', (error) => finish(error));
    archive.pipe(output);
    archive.directory(logsDir, false);
    Promise.resolve(archive.finalize()).catch((error: Error) => finish(error));
  });
}


// 恢复中心「导出日志」（原 assets/recovery.html 语义，旧页已退役）：
// 日志内容由 L2 打包；打开文件或目录仍由 L1 的原生动作负责。
async function exportLogs(): Promise<Record<string, unknown>> {
  try {
    const logsDir = path.join(H.userDataDir, 'logs');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (!fs.existsSync(logsDir)) return { ok: false, error: '日志目录不存在' };
    const fallbackDir = path.join(H.userDataDir, 'diagnostics-exports');
    const outDir = resolveLogsExportDir(process.env, os.homedir(), fallbackDir);
    const zip = path.join(outDir, 'dsh-eac-logs-' + stamp + '.zip');
    await createLogsArchive(logsDir, zip);
    H.log('rescue', '日志已导出: ' + zip);
    return { ok: true, path: zip };
  } catch (err) {
    return { ok: false, error: String(((err as Error).message) || err) };
  }
}

/** 救援方法面（rescue 系列 / safe-mode / recovery 系列）—— server.ts 侧 Object.assign 进 methods。 */
export function rescueMethods(): Record<string, (p: Record<string, unknown> | undefined) => unknown> {
  return {
    'rescue.state': (): Record<string, unknown> => {
      const crash = readJsonLocal<Record<string, unknown> | null>(rescueStateFile(), null);
      let attribution = null;
      try {
        if (crash && crash.lastErrText) attribution = (guardInst().attributeBootFailure as (t: string) => unknown)(String(crash.lastErrText));
      } catch { /* 归因失败按空 */ }
      let snapshots: unknown[] = [];
      let incidents: unknown[] = [];
      let lastGood: unknown = null;
      try {
        const g = guardInst();
        snapshots = (g.listSnapshots as () => unknown[])().slice(0, 20);
        incidents = (g.listIncidents as () => unknown[])().slice(0, 20);
        lastGood = (g.lastGoodSnapshot as () => unknown)();
      } catch { /* guard 不可用按空 */ }
      return {
        appVersion: H.pkgVersion,
        dshVersion: H.dshVersion(),
        agentSource: H.dshVersionSource(),
        profile: H.desktopProfile(),
        logsDir: path.join(H.userDataDir, 'logs'),
        aiReady: !!((H.mods.balance!.readApiKey as (h: string) => string)(H.dshHome)),
        busy: rescueBusy,
        safeMode: safeModeStatus(),
        serverAlive: ((H.mods.boot!.state as () => { running: boolean })()).running,
        crash,
        threshold: RA_OPTS.BOOT_FAILURE_THRESHOLD,
        snapshots,
        incidents,
        lastGood,
        attribution,
      };
    },
    'rescue.confirm': (): Record<string, unknown> => {
      const diag = buildRescueDiagnosis();
      if (!diag) return { ok: false, error: '诊断上下文收集失败' };
      return { ok: true, sendManifest: diag.sendManifest, totalBytes: diag.totalBytes };
    },
    'rescue.diagnose': async (p): Promise<Record<string, unknown>> => {
      if (rescueBusy) return { ok: false, error: 'busy' };
      const diag = buildRescueDiagnosis();
      if (!diag) return { ok: false, error: '诊断上下文收集失败' };
      const selections = Array.isArray(p && p.selections) ? (p!.selections as unknown[]) : [];
      const userNote = String((p && p.userNote) || '').slice(0, 2000);
      const payload = (ra().filterDiagnosisPayload as (pl: unknown, m: unknown, s: unknown[]) => unknown)(diag.payload, diag.sendManifest, selections);
      const apiKey = (H.mods.balance!.readApiKey as (h: string) => string)(H.dshHome);
      if (!apiKey) {
        return { ok: false, error: 'no-key', hint: '未找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）' };
      }
      rescueBusy = true;
      try {
        const messages = [
          { role: 'system', content: (ra().buildDiagnosisPrompt as (pl: unknown) => string)(payload) },
          ...(userNote ? [{ role: 'user', content: '补充信息：' + userNote }] : []),
        ];
        const r = await (ra().chatCompletions as (o: unknown) => Promise<Record<string, unknown> & { ok: boolean }>)({
          apiKey,
          model: RA_OPTS.MODEL,
          messages,
          timeoutMs: RA_OPTS.AI_TIMEOUT_MS,
        });
        if (!r.ok) return r;
        const parsed = (ra().parseAiResponse as (c: unknown) => Record<string, unknown>)((r as { content?: unknown }).content);
        if (!parsed.ok) return parsed;
        H.log('rescue', `AI 诊断完成：${(parsed as { suggestions?: unknown[] }).suggestions?.length} 条建议`);
        return parsed;
      } finally {
        rescueBusy = false;
      }
    },
    'rescue.apply': async (p): Promise<Record<string, unknown>> => {
      if (rescueBusy) return { ok: false, error: 'busy' };
      rescueBusy = true;
      try {
        return await (ra().applySuggestion as (
          s: unknown,
          exec: (x: { action: string; params: Record<string, unknown>; reason?: string; risk?: string }) => Promise<Record<string, unknown>>,
          log: (t: string, m: string) => void,
        ) => Promise<Record<string, unknown>>)(
          p && p.suggestion,
          (x) => rescueExecuteSuggestion(x),
          (t, m) => H.log(t, m),
        );
      } finally {
        rescueBusy = false;
      }
    },
    'rescue.safe-mode': (p): Record<string, unknown> => safeModeSet(p?.on === true),
    'rescue.retry': async (): Promise<Record<string, unknown>> => {
      if (rescueBusy) return { ok: false, error: 'busy' };
      rescueBusy = true;
      try {
        return await rescueExecuteSuggestion({ action: 'retry', params: {}, reason: '用户手动重试', risk: 'low' });
      } finally {
        rescueBusy = false;
      }
    },
    'rescue.auto-repair': async (): Promise<Record<string, unknown>> => {
      if (rescueBusy) return { ok: false, error: 'busy' };
      const apiKey = (H.mods.balance!.readApiKey as (h: string) => string)(H.dshHome);
      if (!apiKey) {
        return { ok: false, error: 'no-key', hint: '未找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）' };
      }
      rescueBusy = true;
      try {
        return await (ra().runAutoRepair as (o: unknown) => Promise<Record<string, unknown>>)({
          diagnose: () => {
            const diag = buildRescueDiagnosis();
            if (!diag) return { ok: false, error: '诊断上下文收集失败' };
            return { ok: true, payload: (ra().filterDiagnosisPayload as (pl: unknown, m: unknown, s: unknown[]) => unknown)(diag.payload, diag.sendManifest, []) };
          },
          analyze: async (payload: unknown) => {
            const r = await (ra().chatCompletions as (o: unknown) => Promise<Record<string, unknown> & { ok: boolean }>)({
              apiKey,
              model: RA_OPTS.MODEL,
              messages: [{ role: 'system', content: (ra().buildDiagnosisPrompt as (pl: unknown) => string)(payload) }],
              timeoutMs: RA_OPTS.AI_TIMEOUT_MS,
            });
            if (!r.ok) return r;
            return (ra().parseAiResponse as (c: unknown) => Record<string, unknown>)((r as { content?: unknown }).content);
          },
          execute: (s: unknown) => (ra().applySuggestion as (
            s2: unknown,
            exec: (x: { action: string; params: Record<string, unknown>; reason?: string; risk?: string }) => Promise<Record<string, unknown>>,
            log: (t: string, m: string) => void,
          ) => Promise<Record<string, unknown>>)(s, (x) => rescueExecuteSuggestion(x), (t, m) => H.log(t, m)),
          retry: () => rescueExecuteSuggestion({ action: 'retry', params: {}, reason: 'AI 修复后自动重试', risk: 'low' }),
          fallback: async () => {
            const notes: string[] = [];
            const g = guardInst();
            try {
              const lastGood = (g.lastGoodSnapshot as () => { id?: string } | null)();
              if (lastGood && lastGood.id) {
                const r = (g.restore as (id: unknown) => Record<string, unknown>)(lastGood.id);
                notes.push(r.ok ? '已回滚最后良好快照' : '回滚失败：' + String(r.error));
              }
            } catch (err) {
              notes.push('回滚异常：' + String(((err as Error).message) || err));
            }
            try {
              const sm = safeModeSet(true);
              notes.push(sm.ok ? '已开启安全模式' : '安全模式失败：' + String(sm.error));
            } catch (err) {
              notes.push('安全模式异常：' + String(((err as Error).message) || err));
            }
            return { ok: false, error: '自动修复未能在阈值内恢复启动', notes };
          },
        });
      } finally {
        rescueBusy = false;
      }
    },
    'recovery.state': (): Record<string, unknown> => ({
      appVersion: H.pkgVersion,
      logsDir: path.join(H.userDataDir, 'logs'),
      crashDumpsDir: '',
      state: null,
    }),
    'recovery.reload': async (): Promise<Record<string, unknown>> => {
      // 服务已退出时先拉起（可能换端口），boot.web-ready 通知驱动壳层重导航。
      const st = (H.mods.boot!.state as () => { running: boolean })();
      if (!st.running) {
        try {
          const r = await (H.mods.boot!.startAndWait as (o: string[]) => Promise<{ webUrl: string }>)([]);
          H.notify('boot.web-ready', r);
        } catch (err) {
          return { ok: false, error: String(((err as Error).message) || err) };
        }
      }
      return { ok: true };
    },
    'recovery.restart': (): Record<string, unknown> => {
      // 整应用重启由 Rust 壳层执行（tauri restart）；这里只回显意图。
      return { ok: true, delegated: 'rust-host' };
    },
    'recovery.export-logs': (): Promise<Record<string, unknown>> => exportLogs(),
  };
}

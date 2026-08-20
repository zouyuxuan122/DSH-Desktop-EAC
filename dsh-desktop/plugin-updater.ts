/**
 * plugin-updater.ts — 内置插件上游更新引擎（Electron 主进程）（Task 7.1 自
 * plugin-updater.js 迁 TS）。
 *
 * 内置插件（assets/plugins）随应用分发、版本固定：不升级应用本身就拿不到
 * 上游修复。本模块让「上游仍在 npm / GitHub 发布」的内置插件可以直接更新：
 *   · checkPluginUpdates(ctx, sources)         —— 静默检测（镜像链 + 内存
 *                                                  TTL + 24h 落盘节流）
 *   · applyBuiltinPluginUpdate(ctx, source, opts)
 *                                              —— 下载新版本到覆盖层并
 *                                                 （尽力）拷入 profile
 *   · autoApplyUpdates(ctx, sources, opts)     —— 自动更新流程（默认关闭）
 *
 * 覆盖层 <userData>/builtin-plugin-updates/<dir>：syncCompanionPlugins 的
 * 「覆盖层优先」规则保证下次启动从覆盖层拷贝、不被资产版本还原；
 * 应用自身升级后资产版本更新，覆盖层自动让位。
 *
 * 安全设计：
 *   · 更新源白名单（PLUGIN_UPDATE_SOURCES）：EAC 独占插件永不更新
 *   · 更新前保护中心快照（一键回滚 + 守护启动兜底）
 *   · engines.dsh 门槛：新包要求的内核版本高于当前 dsh → 拒绝
 *   · npm 下载加 --ignore-scripts，绝不执行第三方安装脚本
 *   · 合并以当前资产副本为底、npm 包覆盖其上：保留 EAC 附加文件（如
 *     dsh-webui-market 的离线目录快照 data/），只增不删
 *   · 单插件失败/未上架/404 → 优雅降级，绝不阻塞
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as updater from './updater.js';
import type { UpdCtx } from './updater.js';

// 内存缓存：同一启动周期内重复查询（更新标签页刷新）不重复打 npm。
const PLUGIN_CHECK_TTL_MS = 10 * 60 * 1000;
// 落盘节流：跨启动的自动检查频率（settings.pluginUpdateCheckedAt）。
const PLUGIN_CHECK_INTERVAL_MS = 24 * 3600 * 1000;
const NPM_VIEW_TIMEOUT_MS = 45 * 1000;
const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** 更新源声明：npm 包名或 GitHub owner/repo。 */
export interface UpdateSource {
  npm?: string;
  github?: string;
}

/** 检测源条目（PLUGIN_UPDATE_SOURCES 项）。 */
export interface PluginSource {
  id: string;
  name: string;
  assetsDir: string;
  update: UpdateSource;
}

/** 检测结果条目。 */
export interface PluginUpdateItem {
  id: string;
  name: string;
  source: 'npm' | 'github' | null;
  sourceName: string;
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  skipped: boolean;
  error: string | null;
}

/** ctx 的可注入扩展（测试替身用）。 */
export interface PluginUpdCtx extends UpdCtx {
  runNpm?: typeof updater.runNpm;
  resolveLatest?: (ctx: PluginUpdCtx, source: UpdateSource) => Promise<string | null>;
}

/** guard 的最小面（createGuard 实例的子集）。 */
export interface GuardLike {
  snapshot(reason: string): { id: string } | null;
}

/** applyBuiltinPluginUpdate 选项。 */
export interface ApplyUpdateOpts {
  latest?: string | null;
  profileDirP?: string | null;
  guard?: GuardLike | null;
  copyIntoProfile?: (overlayDir: string, name: string) => void;
  bundledDshVersion?: string | null;
  log?: (tag: string, msg: string) => void;
  force?: boolean;
}

interface CheckCache {
  at: number;
  list: PluginUpdateItem[] | null;
}

let checkCache: CheckCache = { at: 0, list: null };

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function overlayRoot(ctx: UpdCtx): string {
  return path.join(ctx.userDataDir, 'builtin-plugin-updates');
}

export function overlayDirOf(ctx: UpdCtx, dir: string): string {
  return path.join(overlayRoot(ctx), dir);
}

export function stagingRoot(ctx: UpdCtx): string {
  return path.join(ctx.userDataDir, 'plugin-update-staging');
}

// ---------------------------------------------------------------------------
// 源解析（source = { npm: 包名 } | { github: 'owner/repo' }）
// ---------------------------------------------------------------------------

export function sourceKind(source: UpdateSource | null | undefined): 'npm' | 'github' | null {
  if (source && source.npm) return 'npm';
  if (source && source.github) return 'github';
  return null;
}

export function sourceName(source: UpdateSource | null | undefined): string {
  return source && source.npm ? source.npm : source && source.github ? source.github : '';
}

// ---------------------------------------------------------------------------
// 版本读取 / 判定
// ---------------------------------------------------------------------------

export function versionOfDir(dir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 当前实际加载版本：profile 副本优先，资产副本回退。 */
export function currentVersionOf(ctx: UpdCtx, assetsDir: string, source: UpdateSource, profileDirP: string | null): string | null {
  const name = sourceName(source);
  if (profileDirP && name) {
    const v = versionOfDir(path.join(profileDirP, 'node_modules', ...name.split('/')));
    if (v) return v;
  }
  return versionOfDir(assetsDir);
}

export function hasUpdateOf(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  return updater.compareVersions(latest, current) > 0;
}

// ---------------------------------------------------------------------------
// npm / GitHub latest
// ---------------------------------------------------------------------------

/** npm 包最新版本（复用 updater 的镜像源链，主源失败自动切镜像）。 */
export async function npmLatest(ctx: PluginUpdCtx, name: string): Promise<string> {
  const run = ctx.runNpm || updater.runNpm;
  const chain = updater.registryChain(await updater.currentRegistry(ctx));
  const errors: string[] = [];
  for (const registry of chain) {
    const args = ['view', name, 'version'];
    if (registry) args.push('--registry=' + registry);
    try {
      const out = await run(ctx, args, { timeoutMs: NPM_VIEW_TIMEOUT_MS });
      const lines = String(out || '').trim().split(/\r?\n/).filter(Boolean);
      const v = (lines[lines.length - 1] ?? '').trim();
      if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('无法解析版本号: ' + JSON.stringify(v));
      return v;
    } catch (err) {
      errors.push((registry || '默认源') + ': ' + String((err as Error)?.message || err));
    }
  }
  throw new Error('无法获取 ' + name + ' 的最新版本（' + errors.join('；') + '）');
}

/** GitHub 仓库最新发布（releases/latest 优先，tags 兜底）。 */
export async function githubLatest(ctx: UpdCtx, repo: string): Promise<string | null> {
  const fetchJson = async (url: string): Promise<Record<string, unknown>> => {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop-eac' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return (await res.json()) as Record<string, unknown>;
  };
  try {
    const rel = await fetchJson('https://api.github.com/repos/' + encodeURIComponent(repo) + '/releases/latest');
    const tag = rel.tag_name;
    if (typeof tag === 'string' && tag) return tag.replace(/^v/, '');
  } catch (err) {
    ctx.log('plugin-update', 'GitHub releases/latest 失败（' + repo + '）: ' + String((err as Error)?.message || err));
  }
  try {
    const tags = await fetchJson('https://api.github.com/repos/' + encodeURIComponent(repo) + '/tags');
    if (Array.isArray(tags) && tags.length > 0) {
      const first = tags[0] as { name?: unknown };
      if (first && typeof first.name === 'string') {
        return first.name.replace(/^v/, '');
      }
    }
  } catch (err) {
    ctx.log('plugin-update', 'GitHub tags 失败（' + repo + '）: ' + String((err as Error)?.message || err));
  }
  return null;
}

export async function resolveLatest(ctx: PluginUpdCtx, source: UpdateSource | null | undefined): Promise<string | null> {
  if (typeof ctx.resolveLatest === 'function') return ctx.resolveLatest(ctx, source as UpdateSource);
  if (source && source.npm) return npmLatest(ctx, source.npm);
  if (source && source.github) return githubLatest(ctx, source.github);
  return null;
}

// ---------------------------------------------------------------------------
// 节流 / 跳过版本
// ---------------------------------------------------------------------------

export function dueForCheck(ctx: UpdCtx, now: number): boolean {
  try {
    const s = updater.loadSettings(ctx);
    const at = s.pluginUpdateCheckedAt ? Date.parse(String(s.pluginUpdateCheckedAt)) : 0;
    return !at || now - at >= PLUGIN_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

export function markChecked(ctx: UpdCtx): void {
  try {
    const s = updater.loadSettings(ctx);
    s.pluginUpdateCheckedAt = new Date().toISOString();
    updater.saveSettings(ctx, s);
  } catch {
    /* 写失败不影响 */
  }
}

export function isVersionSkipped(ctx: UpdCtx, id: string, version: string | null): boolean {
  try {
    const s = updater.loadSettings(ctx);
    return ((s.pluginSkipVersions as Record<string, string>) || {})[id] === version;
  } catch {
    return false;
  }
}

export function rememberSkip(ctx: UpdCtx, id: string, version: string): void {
  try {
    const s = updater.loadSettings(ctx);
    s.pluginSkipVersions = (s.pluginSkipVersions as Record<string, string>) || {};
    (s.pluginSkipVersions as Record<string, string>)[id] = version;
    updater.saveSettings(ctx, s);
  } catch {
    /* 写失败不影响 */
  }
}

export function isAutoUpdateEnabled(ctx: UpdCtx): boolean {
  try {
    const s = updater.loadSettings(ctx);
    return s.pluginAutoUpdate === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 兼容性门槛
// ---------------------------------------------------------------------------

/**
 * engines.dsh 门槛：新包声明的最低内核要求高于当前生效 dsh 版本 → 拒绝。
 * 范围只取最低下界（>= / ^ 语义下的起点），保守可比。
 * @returns 拒绝原因（null = 放行）
 */
export function enginesGate(manifest: { engines?: { dsh?: unknown } } | null, activeDshVersion: string | null): string | null {
  try {
    const eng = manifest && manifest.engines;
    if (!eng || !eng.dsh) return null;
    const req = String(eng.dsh).trim();
    if (!req) return null;
    const m = /([<>]=?)?\s*(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/.exec(req);
    if (!m || m[2] === undefined) return null;
    const min = m[2];
    if (!activeDshVersion) return null;
    if (updater.compareVersions(min, activeDshVersion) > 0) {
      return '该插件新版本要求 dsh 内核 >= ' + min + '，当前内核为 ' + activeDshVersion + '，请先更新内核再更新此插件';
    }
  } catch {
    /* 解析失败按放行处理，交给守护启动兜底 */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 全量检测
// ---------------------------------------------------------------------------

/** 检查全部有更新源的内置插件（结果按名称排序，内存 TTL 缓存）。 */
export async function checkPluginUpdates(
  ctx: PluginUpdCtx,
  sources: PluginSource[],
  opts: { force?: boolean; profileDirP?: string | null } = {},
): Promise<PluginUpdateItem[]> {
  const now = Date.now();
  if (!opts.force && checkCache.list && now - checkCache.at < PLUGIN_CHECK_TTL_MS) return checkCache.list;
  const list = await Promise.all(
    sources.map(async (s): Promise<PluginUpdateItem> => {
      const out: PluginUpdateItem = {
        id: s.id,
        name: s.name,
        source: sourceKind(s.update),
        sourceName: sourceName(s.update),
        current: null,
        latest: null,
        hasUpdate: false,
        skipped: false,
        error: null,
      };
      try {
        out.current = currentVersionOf(ctx, s.assetsDir, s.update, opts.profileDirP || null);
        out.latest = await resolveLatest(ctx, s.update);
        out.hasUpdate = hasUpdateOf(out.current, out.latest);
        if (out.hasUpdate && out.latest && isVersionSkipped(ctx, s.id, out.latest)) out.skipped = true;
      } catch (err) {
        out.error = String((err as Error)?.message || err);
      }
      return out;
    }),
  );
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  checkCache = { at: now, list };
  return list;
}

export function invalidateCache(): void {
  checkCache = { at: 0, list: null };
}

// ---------------------------------------------------------------------------
// 应用更新
// ---------------------------------------------------------------------------

function copyTree(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      copyTree(s, d);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

/** GitHub 分发源下载候选：codeload tarball（tag 带不带 v 前缀都试）。 */
export function githubTarballCandidates(repo: string, latest: string): string[] {
  const base = 'https://codeload.github.com/' + encodeURIComponent(repo) + '/tar.gz/refs/tags/';
  return [base + 'v' + latest, base + latest];
}

/** 安装完成后定位包目录：npm 源按包名；GitHub 源扫描直子目录。 */
export function findInstalledDir(staging: string, update: UpdateSource): string | null {
  const nm = path.join(staging, 'node_modules');
  if (update.npm) {
    const dir = path.join(nm, ...update.npm.split('/'));
    return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
  }
  if (!fs.existsSync(nm)) return null;
  const candidates = fs
    .readdirSync(nm, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(nm, e.name))
    .filter((dir) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
        return pkg.name === path.basename(dir);
      } catch {
        return false;
      }
    });
  if (candidates.length === 1) return candidates[0] ?? null;
  // 多个候选（异常结构）时选版本号与目标一致的。
  return candidates.find((dir) => versionOfDir(dir) !== null) ?? null;
}

/** applyBuiltinPluginUpdate 的结果。 */
export interface ApplyResult {
  ok: boolean;
  current: string | null;
  latest: string | null;
  noop?: boolean;
  profileCopied?: boolean;
  restartRequired?: boolean;
}

/**
 * 把某个内置插件更新到 latest。
 * @returns { ok, current, latest, noop?, profileCopied?, restartRequired? }
 */
export async function applyBuiltinPluginUpdate(ctx: PluginUpdCtx, source: PluginSource, opts: ApplyUpdateOpts = {}): Promise<ApplyResult> {
  const log = opts.log || ctx.log;
  const update = source.update;
  const name = sourceName(update);
  const latest = opts.latest || (await resolveLatest(ctx, update));
  if (!latest) throw new Error('无法获取 ' + name + ' 的最新版本');
  const current = currentVersionOf(ctx, source.assetsDir, update, opts.profileDirP || null);
  if (!hasUpdateOf(current, latest)) return { ok: true, current, latest, noop: true };

  // 1) 保护快照（失败即中止，保证可回滚）
  if (opts.guard) {
    const snap = opts.guard.snapshot('pre-update:builtin:' + source.id);
    if (!snap) throw new Error('更新前保护快照失败，已中止更新以保证可回滚');
  }

  // 2) 下载到 staging：npm 源走 registry（镜像链）；GitHub 源走 codeload
  //    tarball URL（npm 直接解包安装）。--ignore-scripts 绝不执行第三方脚本。
  const stagingRootDir = stagingRoot(ctx);
  fs.rmSync(stagingRootDir, { recursive: true, force: true });
  fs.mkdirSync(stagingRootDir, { recursive: true });
  const staging = path.join(stagingRootDir, 'pkg');
  const candidates = update.npm ? [update.npm + '@' + latest] : githubTarballCandidates(update.github as string, latest);
  const chain = updater.registryChain(await updater.currentRegistry(ctx));
  const run = ctx.runNpm || updater.runNpm;
  const errors: string[] = [];
  let installed: string | null = null;
  outer:
  for (const spec of candidates) {
    for (const registry of chain) {
      const args = [
        'install', '--prefix', staging, spec,
        '--save-exact', '--omit=dev', '--ignore-scripts',
        '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error',
      ];
      if (registry) args.push('--registry=' + registry);
      try {
        await run(ctx, args, { timeoutMs: NPM_INSTALL_TIMEOUT_MS });
        const dir = findInstalledDir(staging, update);
        if (!dir) throw new Error('安装完成但未找到包目录');
        installed = dir;
        break outer;
      } catch (err) {
        errors.push((registry || '默认源') + ' × ' + spec + ': ' + String((err as Error)?.message || err));
      }
    }
  }
  if (!installed) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('下载失败（' + errors.join('；') + '）');
  }

  // 3) 校验：engines.dsh 门槛
  let manifest: { engines?: { dsh?: unknown } } | null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')) as { engines?: { dsh?: unknown } };
  } catch {
    manifest = null;
  }
  if (!manifest) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('更新包缺少 package.json，已中止');
  }
  const activeDsh = opts.bundledDshVersion || updater.activeVersion(ctx);
  const gate = enginesGate(manifest, activeDsh);
  if (gate) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error(gate);
  }

  // 4) 合并进覆盖层：以当前资产副本为底（保留 EAC 附加文件），npm 包覆盖
  const merged = path.join(stagingRootDir, 'merged');
  fs.rmSync(merged, { recursive: true, force: true });
  fs.cpSync(source.assetsDir, merged, { recursive: true, force: true });
  copyTree(installed, merged);
  // 上游 bump 依赖时一并带上（仅顶层直依赖，绝不删除旧文件；主包已合并跳过）。
  const stagedNms = path.join(staging, 'node_modules');
  if (fs.existsSync(stagedNms)) {
    for (const e of fs.readdirSync(stagedNms, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === path.basename(installed)) continue;
      copyTree(path.join(stagedNms, e.name), path.join(merged, 'node_modules', e.name));
    }
  }
  const vNew = versionOfDir(merged);
  if (!vNew) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('更新包缺少版本号，已中止');
  }
  const overlay = overlayDirOf(ctx, path.basename(source.assetsDir));
  const bak = overlay + '.bak-' + Date.now();
  try {
    if (fs.existsSync(overlay)) fs.renameSync(overlay, bak);
    fs.mkdirSync(path.dirname(overlay), { recursive: true });
    fs.renameSync(merged, overlay);
  } catch (err) {
    try {
      if (!fs.existsSync(overlay) && fs.existsSync(bak)) fs.renameSync(bak, overlay);
    } catch {
      /* 尽力回滚 */
    }
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('切换覆盖层失败: ' + String((err as Error)?.message || err));
  }
  if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true });

  // 5) 拷入 profile（尽力而为：服务运行中撞文件锁时保留覆盖层，下次启动同步）
  let profileCopied = false;
  if (typeof opts.copyIntoProfile === 'function') {
    try {
      opts.copyIntoProfile(overlay, source.name);
      profileCopied = true;
    } catch (err) {
      log('plugin-update', '更新 ' + source.id + ' 已下载，但写 profile 失败（服务运行中？）: ' + String((err as Error)?.message || err));
    }
  }

  fs.rmSync(stagingRootDir, { recursive: true, force: true });
  invalidateCache();
  log('plugin-update', '内置插件已更新 ' + source.id + '（' + source.name + '）: ' + (current || '?') + ' → ' + vNew + (profileCopied ? '' : '（覆盖层已就绪，重启服务生效）'));
  return { ok: true, current, latest: vNew, profileCopied, restartRequired: !profileCopied };
}

/** 自动更新结果。 */
export interface AutoApplyResult {
  done: Array<{ id: string; name: string; current: string | null; latest: string | null }>;
  failed: Array<{ id: string; name: string; error: string }>;
}

/**
 * 自动更新流程（settings.pluginAutoUpdate 开启时由主进程调用）：
 * 逐个下载有更新的内置插件到覆盖层，失败不阻塞其余插件。
 */
export async function autoApplyUpdates(
  ctx: PluginUpdCtx,
  sources: PluginSource[],
  opts: ApplyUpdateOpts = {},
): Promise<AutoApplyResult> {
  const list = await checkPluginUpdates(ctx, sources, opts);
  const done: AutoApplyResult['done'] = [];
  const failed: AutoApplyResult['failed'] = [];
  for (const item of list) {
    if (!item.hasUpdate || item.skipped) continue;
    const source = sources.find((s) => s.id === item.id);
    if (!source) continue;
    try {
      const r = await applyBuiltinPluginUpdate(ctx, source, { ...opts, latest: item.latest });
      if (r.noop) continue;
      done.push({ id: item.id, name: item.name, current: item.current, latest: r.latest });
    } catch (err) {
      failed.push({ id: item.id, name: item.name, error: String((err as Error)?.message || err) });
    }
  }
  return { done, failed };
}

export { PLUGIN_CHECK_TTL_MS, PLUGIN_CHECK_INTERVAL_MS };

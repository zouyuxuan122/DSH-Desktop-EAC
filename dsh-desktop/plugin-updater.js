'use strict';

// plugin-updater.js — 内置插件上游更新引擎（Electron 主进程）。
//
// 内置插件（assets/plugins）随应用分发、版本固定：不升级应用本身就拿不到
// 上游修复。本模块让「上游仍在 npm / GitHub 发布」的内置插件可以直接更新：
//   · checkPluginUpdates(ctx, sources)         —— 静默检测（镜像链 + 内存
//                                                  TTL + 24h 落盘节流）
//   · applyBuiltinPluginUpdate(ctx, source, opts)
//                                              —— 下载新版本到覆盖层并
//                                                 （尽力）拷入 profile
//   · autoApplyUpdates(ctx, sources, opts)     —— 自动更新流程（默认关闭）
//
// 覆盖层 <userData>/builtin-plugin-updates/<dir>：syncCompanionPlugins 的
// 「覆盖层优先」规则（main.js）保证下次启动从覆盖层拷贝、不被资产版本还原；
// 应用自身升级后资产版本更新，覆盖层自动让位。
//
// 安全设计：
//   · 更新源白名单（main.js PLUGIN_UPDATE_SOURCES）：EAC 独占插件永不更新
//   · 更新前保护中心快照（一键回滚 + 守护启动兜底）
//   · engines.dsh 门槛：新包要求的内核版本高于当前 dsh → 拒绝
//   · npm 下载加 --ignore-scripts，绝不执行第三方安装脚本
//   · 合并以当前资产副本为底、npm 包覆盖其上：保留 EAC 附加文件（如
//     dsh-webui-market 的离线目录快照 data/），只增不删
//   · 单插件失败/未上架/404 → 优雅降级，绝不阻塞

const path = require('node:path');
const fs = require('node:fs');

const updater = require('./updater');

// 内存缓存：同一启动周期内重复查询（更新标签页刷新）不重复打 npm。
const PLUGIN_CHECK_TTL_MS = 10 * 60 * 1000;
// 落盘节流：跨启动的自动检查频率（settings.pluginUpdateCheckedAt）。
const PLUGIN_CHECK_INTERVAL_MS = 24 * 3600 * 1000;
const NPM_VIEW_TIMEOUT_MS = 45 * 1000;
const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

let checkCache = { at: 0, list: null };

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function overlayRoot(ctx) { return path.join(ctx.userDataDir, 'builtin-plugin-updates'); }

function overlayDirOf(ctx, dir) { return path.join(overlayRoot(ctx), dir); }

function stagingRoot(ctx) { return path.join(ctx.userDataDir, 'plugin-update-staging'); }

// ---------------------------------------------------------------------------
// 源解析（source = { npm: 包名 } | { github: 'owner/repo' }）
// ---------------------------------------------------------------------------

function sourceKind(source) {
  if (source && source.npm) return 'npm';
  if (source && source.github) return 'github';
  return null;
}

function sourceName(source) {
  return source && source.npm ? source.npm : (source && source.github ? source.github : '');
}

// ---------------------------------------------------------------------------
// 版本读取 / 判定
// ---------------------------------------------------------------------------

function versionOfDir(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch { return null; }
}

/** 当前实际加载版本：profile 副本优先，资产副本回退。 */
function currentVersionOf(ctx, assetsDir, source, profileDirP) {
  const name = sourceName(source);
  if (profileDirP && name) {
    const v = versionOfDir(path.join(profileDirP, 'node_modules', ...name.split('/')));
    if (v) return v;
  }
  return versionOfDir(assetsDir);
}

function hasUpdateOf(current, latest) {
  if (!current || !latest) return false;
  return updater.compareVersions(latest, current) > 0;
}

// ---------------------------------------------------------------------------
// npm / GitHub latest
// ---------------------------------------------------------------------------

/** npm 包最新版本（复用 updater.js 的镜像源链，主源失败自动切镜像）。 */
async function npmLatest(ctx, name) {
  const run = ctx.runNpm || updater.runNpm;
  const chain = updater.registryChain(await updater.currentRegistry(ctx));
  const errors = [];
  for (const registry of chain) {
    const args = ['view', name, 'version'];
    if (registry) args.push('--registry=' + registry);
    try {
      const out = await run(ctx, args, { timeoutMs: NPM_VIEW_TIMEOUT_MS });
      const lines = String(out || '').trim().split(/\r?\n/).filter(Boolean);
      const v = lines[lines.length - 1].trim();
      if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('无法解析版本号: ' + JSON.stringify(v));
      return v;
    } catch (err) {
      errors.push((registry || '默认源') + ': ' + String((err && err.message) || err));
    }
  }
  throw new Error('无法获取 ' + name + ' 的最新版本（' + errors.join('；') + '）');
}

/** GitHub 仓库最新发布（releases/latest 优先，tags 兜底）。 */
async function githubLatest(ctx, repo) {
  const fetchJson = async (url) => {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop-eac' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  };
  try {
    const rel = await fetchJson('https://api.github.com/repos/' + encodeURIComponent(repo) + '/releases/latest');
    if (rel && typeof rel.tag_name === 'string' && rel.tag_name) return rel.tag_name.replace(/^v/, '');
  } catch (err) {
    ctx.log('plugin-update', 'GitHub releases/latest 失败（' + repo + '）: ' + String((err && err.message) || err));
  }
  try {
    const tags = await fetchJson('https://api.github.com/repos/' + encodeURIComponent(repo) + '/tags');
    if (Array.isArray(tags) && tags.length > 0 && tags[0] && typeof tags[0].name === 'string') {
      return tags[0].name.replace(/^v/, '');
    }
  } catch (err) {
    ctx.log('plugin-update', 'GitHub tags 失败（' + repo + '）: ' + String((err && err.message) || err));
  }
  return null;
}

async function resolveLatest(ctx, source) {
  if (typeof ctx.resolveLatest === 'function') return ctx.resolveLatest(ctx, source);
  if (source && source.npm) return npmLatest(ctx, source.npm);
  if (source && source.github) return githubLatest(ctx, source.github);
  return null;
}

// ---------------------------------------------------------------------------
// 节流 / 跳过版本
// ---------------------------------------------------------------------------

function dueForCheck(ctx, now) {
  try {
    const s = updater.loadSettings(ctx);
    const at = s.pluginUpdateCheckedAt ? Date.parse(s.pluginUpdateCheckedAt) : 0;
    return !at || now - at >= PLUGIN_CHECK_INTERVAL_MS;
  } catch { return true; }
}

function markChecked(ctx) {
  try {
    const s = updater.loadSettings(ctx);
    s.pluginUpdateCheckedAt = new Date().toISOString();
    updater.saveSettings(ctx, s);
  } catch { /* 写失败不影响 */ }
}

function isVersionSkipped(ctx, id, version) {
  try {
    const s = updater.loadSettings(ctx);
    return (s.pluginSkipVersions || {})[id] === version;
  } catch { return false; }
}

function rememberSkip(ctx, id, version) {
  try {
    const s = updater.loadSettings(ctx);
    s.pluginSkipVersions = s.pluginSkipVersions || {};
    s.pluginSkipVersions[id] = version;
    updater.saveSettings(ctx, s);
  } catch { /* 写失败不影响 */ }
}

function isAutoUpdateEnabled(ctx) {
  try {
    const s = updater.loadSettings(ctx);
    return s.pluginAutoUpdate === true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// 兼容性门槛
// ---------------------------------------------------------------------------

/**
 * engines.dsh 门槛：新包声明的最低内核要求高于当前生效 dsh 版本 → 拒绝。
 * 范围只取最低下界（>= / ^ 语义下的起点），保守可比。
 * @returns {string|null} 拒绝原因（null = 放行）
 */
function enginesGate(manifest, activeDshVersion) {
  try {
    const eng = manifest && manifest.engines;
    if (!eng || !eng.dsh) return null;
    const req = String(eng.dsh).trim();
    if (!req) return null;
    const m = /([<>]=?)?\s*(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/.exec(req);
    if (!m) return null;
    const min = m[2];
    if (!activeDshVersion) return null;
    if (updater.compareVersions(min, activeDshVersion) > 0) {
      return '该插件新版本要求 dsh 内核 >= ' + min + '，当前内核为 ' + activeDshVersion + '，请先更新内核再更新此插件';
    }
  } catch { /* 解析失败按放行处理，交给守护启动兜底 */ }
  return null;
}

// ---------------------------------------------------------------------------
// 全量检测
// ---------------------------------------------------------------------------

/**
 * 检查全部有更新源的内置插件。
 * @param ctx     updCtx()
 * @param sources [{ id, name, assetsDir, update }]
 * @param opts    { force, profileDirP }
 * @returns [{ id, name, source, sourceName, current, latest, hasUpdate, skipped, error }]
 */
async function checkPluginUpdates(ctx, sources, opts = {}) {
  const now = Date.now();
  if (!opts.force && checkCache.list && now - checkCache.at < PLUGIN_CHECK_TTL_MS) return checkCache.list;
  const list = await Promise.all(sources.map(async (s) => {
    const out = {
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
      if (out.hasUpdate && isVersionSkipped(ctx, s.id, out.latest)) out.skipped = true;
    } catch (err) {
      out.error = String((err && err.message) || err);
    }
    return out;
  }));
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  checkCache = { at: now, list };
  return list;
}

function invalidateCache() { checkCache = { at: 0, list: null }; }

// ---------------------------------------------------------------------------
// 应用更新
// ---------------------------------------------------------------------------

function copyTree(src, dest) {
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
function githubTarballCandidates(repo, latest) {
  const base = 'https://codeload.github.com/' + encodeURIComponent(repo) + '/tar.gz/refs/tags/';
  return [base + 'v' + latest, base + latest];
}

/** 安装完成后定位包目录：npm 源按包名；GitHub 源扫描直子目录。 */
function findInstalledDir(staging, update) {
  const nm = path.join(staging, 'node_modules');
  if (update.npm) {
    const dir = path.join(nm, ...update.npm.split('/'));
    return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
  }
  if (!fs.existsSync(nm)) return null;
  const candidates = fs.readdirSync(nm, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(nm, e.name))
    .filter((dir) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return pkg.name === path.basename(dir);
      } catch { return false; }
    });
  if (candidates.length === 1) return candidates[0];
  // 多个候选（异常结构）时选版本号与目标一致的。
  return candidates.find((dir) => versionOfDir(dir) !== null) || null;
}

/**
 * 把某个内置插件更新到 latest。
 * @param ctx    updCtx()
 * @param source { id, name, assetsDir, update }
 * @param opts   { latest, profileDirP, guard, copyIntoProfile(overlayDir, name),
 *                 bundledDshVersion, log }
 * @returns { ok, current, latest, noop?, profileCopied?, restartRequired? }
 */
async function applyBuiltinPluginUpdate(ctx, source, opts = {}) {
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
  const candidates = update.npm
    ? [update.npm + '@' + latest]
    : githubTarballCandidates(update.github, latest);
  const chain = updater.registryChain(await updater.currentRegistry(ctx));
  const run = ctx.runNpm || updater.runNpm;
  const errors = [];
  let installed = null;
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
        errors.push((registry || '默认源') + ' × ' + spec + ': ' + String((err && err.message) || err));
      }
    }
  }
  if (!installed) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('下载失败（' + errors.join('；') + '）');
  }

  // 3) 校验：engines.dsh 门槛
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')); }
  catch { manifest = null; }
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
    try { if (!fs.existsSync(overlay) && fs.existsSync(bak)) fs.renameSync(bak, overlay); } catch { /* 尽力回滚 */ }
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('切换覆盖层失败: ' + String((err && err.message) || err));
  }
  if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true });

  // 5) 拷入 profile（尽力而为：服务运行中撞文件锁时保留覆盖层，下次启动同步）
  let profileCopied = false;
  if (typeof opts.copyIntoProfile === 'function') {
    try {
      opts.copyIntoProfile(overlay, source.name);
      profileCopied = true;
    } catch (err) {
      log('plugin-update', '更新 ' + source.id + ' 已下载，但写 profile 失败（服务运行中？）: ' + String((err && err.message) || err));
    }
  }

  fs.rmSync(stagingRootDir, { recursive: true, force: true });
  invalidateCache();
  log('plugin-update', '内置插件已更新 ' + source.id + '（' + source.name + '）: ' + (current || '?') + ' → ' + vNew + (profileCopied ? '' : '（覆盖层已就绪，重启服务生效）'));
  return { ok: true, current, latest: vNew, profileCopied, restartRequired: !profileCopied };
}

/**
 * 自动更新流程（settings.pluginAutoUpdate 开启时由主进程调用）：
 * 逐个下载有更新的内置插件到覆盖层，失败不阻塞其余插件。
 */
async function autoApplyUpdates(ctx, sources, opts = {}) {
  const list = await checkPluginUpdates(ctx, sources, opts);
  const done = [];
  const failed = [];
  for (const item of list) {
    if (!item.hasUpdate || item.skipped) continue;
    const source = sources.find((s) => s.id === item.id);
    if (!source) continue;
    try {
      const r = await applyBuiltinPluginUpdate(ctx, source, { ...opts, latest: item.latest });
      if (r.noop) continue;
      done.push({ id: item.id, name: item.name, current: item.current, latest: r.latest });
    } catch (err) {
      failed.push({ id: item.id, name: item.name, error: String((err && err.message) || err) });
    }
  }
  return { done, failed };
}

module.exports = {
  PLUGIN_CHECK_TTL_MS,
  PLUGIN_CHECK_INTERVAL_MS,
  overlayRoot,
  overlayDirOf,
  stagingRoot,
  sourceKind,
  sourceName,
  versionOfDir,
  currentVersionOf,
  hasUpdateOf,
  npmLatest,
  githubLatest,
  resolveLatest,
  githubTarballCandidates,
  findInstalledDir,
  dueForCheck,
  markChecked,
  isVersionSkipped,
  rememberSkip,
  isAutoUpdateEnabled,
  enginesGate,
  checkPluginUpdates,
  invalidateCache,
  applyBuiltinPluginUpdate,
  autoApplyUpdates,
};
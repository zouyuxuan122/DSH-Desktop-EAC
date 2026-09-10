// desktop-core.ts — Tauri 壳的 sidecar 业务编排层。
// 忠实移植自仓库根 desktop-core.js（Electron main.js「插件生态 + 配套资产」
// 编排逻辑的整体迁出，行为与 main.js 逐一对齐；副作用经 ctx 注入）。
//
// 设计约束：
//   · 不依赖 electron，全部副作用经 ctx（log/notify）注入；
//   · 复用既有 lib 模块（updater / plugin-guard / plugin-updater / balance /
//     preset-sync / builtin-collision / patch-row-heal / profile-module-heal /
//     plugin-manager-state / plugin-manager-patch），零行为漂移。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import * as updater from './lib/updater';
import * as pluginUpdater from './lib/plugin-updater';
import * as balance from './lib/balance';
import { healProfileModuleShadowing } from './lib/profile-module-heal';
import { createGuard } from './lib/plugin-guard';
import { configLinesFor, removeBundledRowDuplicates, collectBundleEntryIds } from './lib/patch-row-heal';
import { syncBundledPresets, ensureDefaultAgentPreset } from './lib/preset-sync';
import { togglePluginInPatch, removePluginFromPatch, hasEntryId } from './lib/plugin-manager-patch';
import { collectPluginRows } from './lib/plugin-manager-state';
import { removeMarketDuplicate } from './lib/builtin-collision';
import { assertProfileStartup, UPGRADE_TARGET } from './lib/profile-upgrade';

// AIO 核心内置插件（壳运行必需）：保护中心与启停管理。
// 其他内置插件可被「插件 → 管理」移除，核心组拒绝移除。
const CORE_PLUGIN_IDS = new Set(['plugin-manager', 'plugin-shield']);

// 与官方 web profile 出厂模板一致（@deepseek-ai/dsh-base + dsh-web-app）。
export const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
export const DESKTOP_PROFILE = 'web-desktop';

// 随插件包一起拷贝到 profile 的许可与出处文件（存在才拷贝）。
const EXTRA_PACKAGE_FILES = ['LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md', 'README.md', 'README.zh.md', 'README.zh-CN.md', 'THIRD-PARTY-NOTICES.md', 'EAC-VENDOR.json'];
const COPY_STAMP = '.eac-copy-stamp.json';

// 内置插件上游更新源（V4.3）：只登记「上游仍在 npm / GitHub 发布」的社区插件。
const PLUGIN_UPDATE_SOURCES: Record<string, { npm?: string; github?: string }> = {
  'better-sidebar': { npm: 'dsh-better-sidebar' },
  'composer-dynamic-island': { github: 'says693/dsh-composer-dynamic-island' },
  'dsh-undo': { github: 'lire1131/dsh-undo-savepoint' },
};

export interface CompanionEntry {
  id: string;
  name: string;
  dir?: string;
  disabled?: boolean;
  config?: unknown;
}

export interface DesktopCoreCtx {
  appRoot: string;
  userDataDir: string;
  logsDir: string;
  dshHome: string;
  nodeExe: () => string;
  npmCli: () => string;
  log?: (tag: string, msg: string) => void;
  notify?: (title: string, body: string) => void;
}

// 原始 JSON 动态形态（readJsonFile 结果），保持与 JS 版相同的宽容读写。
/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export function createDesktopCore(ctx: DesktopCoreCtx) {
  const {
    appRoot, // 应用 JS 根（assets/node_modules 所在）
    userDataDir, // %APPDATA%/<identifier>
    logsDir, // userData/logs
    dshHome, // AIO 独立 DSH_HOME（默认 Tauri app data；可显式覆盖）
    nodeExe, // () => 内置 node.exe 路径
    npmCli, // () => 内置 npm-cli.js 路径
    log = (() => {}) as (tag: string, msg: string) => void,
    notify = (() => {}) as (title: string, body: string) => void,
  } = ctx;

  // ---------------------------------------------------------------- 基础 --

  const settingsCtx = { userDataDir, nodeExe, npmCli, log: (m: string) => log('update', m) };
  const loadSettings = (): Record<string, any> => updater.loadSettings(settingsCtx);
  const saveSettings = (s: Record<string, any>): void => updater.saveSettings(settingsCtx, s);

  let overlayRejected = false;

  function overlayHealthPath(): string {
    return path.join(userDataDir, 'agent', '.aio-agent-health.json');
  }

  function hasHealthyOverlayMarker(version: string | null): boolean {
    if (!version) return false;
    const marker = readJsonFile(overlayHealthPath());
    return marker?.version === version && typeof marker.validatedAt === 'string';
  }

  function effectiveOverlayBin(): string | null {
    const bin = updater.overlayBinPath(settingsCtx);
    const version = updater.overlayVersion(settingsCtx);
    const bundled = updater.bundledVersion();
    if (overlayRejected || !bin || !fs.existsSync(bin) || !version) return null;
    if (bundled && updater.compareVersions(version, bundled) < 0) return null;
    return hasHealthyOverlayMarker(version) ? bin : null;
  }

  function dshBin(): string {
    const overlay = effectiveOverlayBin();
    if (overlay) return overlay;
    return path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }

  function nextBrokenOverlayDir(): string {
    const base = path.join(userDataDir, 'agent-broken-' + Date.now());
    let candidate = base;
    let suffix = 0;
    while (fs.existsSync(candidate)) candidate = base + '-' + (++suffix);
    return candidate;
  }

  // Run the overlay's real CLI entry before allowing a user-writable update to
  // shadow the bundled kernel. An npm success and an existing bin.js do not
  // prove that peer dependencies survived the update transaction.
  async function ensureHealthyOverlay(timeoutMs = 20_000): Promise<{ source: 'overlay' | 'bundled'; reason?: string }> {
    const bin = updater.overlayBinPath(settingsCtx);
    const version = updater.overlayVersion(settingsCtx);
    const bundled = updater.bundledVersion();
    if (!bin || !fs.existsSync(bin) || !version) return { source: 'bundled', reason: 'missing' };
    if (bundled && updater.compareVersions(version, bundled) < 0) return { source: 'bundled', reason: 'older-than-bundled' };
    if (hasHealthyOverlayMarker(version)) return { source: 'overlay' };
    const node = nodeExe();
    if (!fs.existsSync(node)) return { source: 'bundled', reason: 'node-missing' };

    const smokeHome = path.join(userDataDir, '.agent-health-check-' + process.pid);
    try {
      fs.mkdirSync(smokeHome, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(node, [bin, '--version'], {
          cwd: path.join(userDataDir, 'agent'),
          env: { ...process.env, DSH_HOME: smokeHome },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* best effort */ }
          reject(new Error('overlay CLI health check timed out'));
        }, timeoutMs);
        const collect = (chunk: Buffer): void => { output += chunk.toString('utf8'); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) return resolve();
          const lines = output.split(/\r?\n/).filter(Boolean);
          const diagnostic = lines.find((line) => /Cannot find|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(line));
          reject(new Error([diagnostic, ...lines.slice(-4)].filter(Boolean).join(' | ') || `overlay CLI exited ${code}`));
        });
      });
      fs.writeFileSync(overlayHealthPath(), JSON.stringify({ version, validatedAt: new Date().toISOString() }, null, 2) + '\n');
      log('update', `Agent overlay ${version} 启动探测通过`);
      return { source: 'overlay' };
    } catch (error) {
      overlayRejected = true;
      const reason = String((error instanceof Error && error.message) || error);
      try {
        const broken = nextBrokenOverlayDir();
        fs.renameSync(path.join(userDataDir, 'agent'), broken);
        log('update', `Agent overlay ${version} 启动探测失败，已隔离并改用内置版本: ${reason}`);
      } catch (moveError) {
        log('update', `Agent overlay ${version} 启动探测失败，本次改用内置版本；隔离失败: ${String((moveError instanceof Error && moveError.message) || moveError)}`);
      }
      return { source: 'bundled', reason };
    } finally {
      try { fs.rmSync(smokeHome, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  function confirmHealthyOverlay(): boolean {
    if (!effectiveOverlayBin()) return false;
    return updater.confirmPreviousAgentHealthy(settingsCtx);
  }

  function desktopProfile(): string {
    return DESKTOP_PROFILE;
  }

  const desktopProfileDir = (): string => path.join(dshHome, 'profiles', desktopProfile());
  const profileDirFor = (profile: string): string => path.join(dshHome, 'profiles', profile);

  function readJsonFile(file: string): Json {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  // ------------------------------------------------- 配套插件清单（main.js）--

  const COMPANION_PLUGINS: CompanionEntry[] = [
    { id: 'balance', name: '@deepseek-ai/dsh-balance' },
    { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar' },
    { id: 'composer-dynamic-island', name: 'dsh-composer-dynamic-island', dir: 'dsh-composer-dynamic-island' },
    { id: 'auto-compact', name: 'dsh-auto-compact', dir: 'dsh-auto-compact' },
    { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
    { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
    { id: 'skin-switch', name: '@deepseek-ai/dsh-skin-switch', dir: 'dsh-skin-switch' },
    { id: 'dsh-undo', name: 'dsh-undo-savepoint', dir: 'dsh-undo-savepoint' },
  ];

  // Main 的皮肤系统：皮肤包是独立插件，默认禁用，由 skin-switch 负责互斥切换。
  // maid-atelier 依赖外部主题运行时，主线当前也不在首启注册，保留资产供后续
  // 兼容性验证后重新启用。
  const SKINS_DIR = path.join(appRoot, 'assets', 'skins');
  const DISABLED_SKINS = new Set(['maid-atelier']);

  // ------------------------------------------------------ 保护中心（guard）--

  let guardInstance: ReturnType<typeof createGuard> | null = null;
  function ensureGuard() {
    if (!guardInstance) {
      guardInstance = createGuard({
        getHome: () => dshHome,
        getProfile: () => desktopProfile(),
        dshBin: () => dshBin(),
        log: (m) => log('guard', m),
      });
    }
    return guardInstance;
  }

  // ------------------------------------------------- 桌面 profile 初始化 --

  // 未知 profile 不会自动初始化（dsh 直接报错退出），桌面端自己按官方模板
  // 创建：package.json（bundles）+ pnpm-workspace.yaml + 空 patch 层。
  function ensureDesktopProfileInit(): void {
    try {
      const dir = desktopProfileDir();
      fs.mkdirSync(dir, { recursive: true });
      const manifest = path.join(dir, 'package.json');
      if (!fs.existsSync(manifest)) {
        fs.writeFileSync(
          manifest,
          JSON.stringify(
            {
              name: 'dsh-profile-' + desktopProfile(),
              private: true,
              dependencies: {},
              dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
            },
            null,
            2,
          ) + '\n',
        );
        log('boot', '已初始化桌面专属 profile: ' + dir);
      }
      if (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
        fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
      }
      if (!fs.existsSync(path.join(dir, 'cordis.patch.yml'))) {
        fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n');
      }
    } catch (err) {
      log('boot', '初始化桌面 profile 失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ---------------------------------------------------- 插件包复制（V4 戳记）--

  function pluginCopyEntries(src: string): string[] {
    const out: string[] = [];
    const copyFile = (rel: string): void => {
      const sf = path.join(src, rel);
      if (!fs.existsSync(sf) || fs.statSync(sf).isDirectory()) return;
      out.push(rel);
    };
    const copyDir = (rel: string): void => {
      const sd = path.join(src, rel);
      if (!fs.existsSync(sd) || !fs.statSync(sd).isDirectory()) return;
      for (const entry of fs.readdirSync(sd, { withFileTypes: true })) {
        const sub = rel + '/' + entry.name;
        if (entry.isDirectory()) copyDir(sub);
        else copyFile(sub);
      }
    };
    for (const f of ['package.json', 'skin.json', 'dsh-plugin.json', 'dsh.plugin.json', ...EXTRA_PACKAGE_FILES]) copyFile(f);
    for (const f of ['index.js', 'client.js', 'recall-inject.js', 'cordis.patch.yml']) copyFile(f);
    for (const d of ['lib', 'docs', 'preview', 'vendor', 'node_modules', 'data', 'assets', 'runtime', 'src', 'client']) copyDir(d);
    return out;
  }

  function pluginStampOf(src: string): string | null {
    try {
      const pkg = readJsonFile(path.join(src, 'package.json')) || {};
      let files = 0;
      let bytes = 0;
      for (const rel of pluginCopyEntries(src)) {
        files += 1;
        try {
          bytes += fs.statSync(path.join(src, rel)).size;
        } catch { /* 忽略单文件统计失败 */ }
      }
      return JSON.stringify({ v: String(pkg.version || ''), f: files, b: bytes });
    } catch {
      return null;
    }
  }

  function copyPluginPackage(profileDirP: string, src: string, name: string): void {
    const destRoot = path.join(profileDirP, 'node_modules', ...name.split('/'));
    const stampFile = path.join(destRoot, COPY_STAMP);
    const want = pluginStampOf(src);
    try {
      if (want && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === want) {
        return; // 内容未变：跳过全量重拷
      }
    } catch { /* 比对失败按需重拷 */ }
    fs.mkdirSync(path.dirname(destRoot), { recursive: true });
    const copyFile = (rel: string): void => {
      const sf = path.join(src, rel);
      if (!fs.existsSync(sf) || fs.statSync(sf).isDirectory()) return;
      const df = path.join(destRoot, rel);
      fs.mkdirSync(path.dirname(df), { recursive: true });
      fs.copyFileSync(sf, df);
    };
    const copyDir = (rel: string): void => {
      const sd = path.join(src, rel);
      if (!fs.existsSync(sd) || !fs.statSync(sd).isDirectory()) return;
      for (const entry of fs.readdirSync(sd, { withFileTypes: true })) {
        const sub = rel + '/' + entry.name;
        if (entry.isDirectory()) copyDir(sub);
        else copyFile(sub);
      }
    };
    // lib 整目录随包（配套插件可能有 logic.js 等额外模块，按清单拷会漏文件
    // 导致 dsh web 启动时 ERR_MODULE_NOT_FOUND）。
    for (const f of ['package.json', 'skin.json', 'dsh-plugin.json', 'dsh.plugin.json', ...EXTRA_PACKAGE_FILES]) copyFile(f);
    for (const f of ['index.js', 'client.js', 'recall-inject.js', 'cordis.patch.yml']) copyFile(f);
    copyDir('lib');
    copyDir('docs');
    copyDir('preview');
    copyDir('vendor');
    // 内置插件自带的嵌套 node_modules（vendored 运行时依赖）：pnpm 重写
    // profile node_modules 顶层时不会波及，插件保持自包含。
    copyDir('node_modules');
    copyDir('data');
    // 带运行时静态资源的插件（动画帧、PyInstaller helper 等）。
    copyDir('assets');
    copyDir('runtime');
    // 入口不在 lib/ 的插件（src/ 或 client/ 半边 + 包 exports 映射）。
    copyDir('src');
    copyDir('client');
    if (want) {
      try {
        fs.mkdirSync(destRoot, { recursive: true });
        fs.writeFileSync(stampFile, want);
      } catch { /* 戳记写失败不影响功能 */ }
    }
  }

  // ------------------------------------------------- 移除清单 / 更新源目录 --

  function removedPluginIds(): Set<string> {
    try {
      const s = loadSettings();
      return new Set(Array.isArray(s.removedPlugins) ? s.removedPlugins : []);
    } catch {
      return new Set();
    }
  }

  function saveRemovedPluginIds(ids: Set<string>): void {
    const s = loadSettings();
    s.removedPlugins = Array.from(ids);
    saveSettings(s);
  }

  // Safe mode is enabled by dsh-undo-savepoint before the service restarts.
  // This marker lives in the profile, not in the plugin's configurable
  // snapshot store, so the synchronizer can honor it without loading a plugin
  // or guessing the user's custom snapshot path.
  function safeModeActive(): boolean {
    try {
      const marker = readJsonFile(path.join(desktopProfileDir(), '.dsh-safe-mode.json'));
      return marker?.active === true;
    } catch {
      return false;
    }
  }

  /// 内置插件当前生效的源目录：覆盖层（已更新版本）优先，资产版本回退。
  function builtinPluginSourceDir(dirName: string): string {
    const assets = path.join(appRoot, 'assets', 'plugins', dirName);
    const overlay = path.join(userDataDir, 'builtin-plugin-updates', dirName);
    if (!fs.existsSync(path.join(overlay, 'package.json'))) return assets;
    if (!fs.existsSync(path.join(assets, 'package.json'))) return overlay;
    // 覆盖层版本 >= 资产版本才优先：应用自身升级后，新资产自动接管覆盖层。
    const vOverlay = pluginUpdater.versionOfDir(overlay);
    const vAssets = pluginUpdater.versionOfDir(assets);
    if (vOverlay && vAssets && updater.compareVersions(vOverlay, vAssets) < 0) return assets;
    return overlay;
  }

  /// 把内置插件表 + 更新源注册表合并成 plugin-updater 的 sources 输入。
  function pluginUpdateSources(): pluginUpdater.PluginSource[] {
    const removed = removedPluginIds();
    const out: pluginUpdater.PluginSource[] = [];
    for (const p of COMPANION_PLUGINS) {
      const update = PLUGIN_UPDATE_SOURCES[p.id];
      if (!update) continue;
      if (removed.has(p.id)) continue;
      const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
      const assetsDir = path.join(appRoot, 'assets', 'plugins', dirName as string);
      if (!fs.existsSync(path.join(assetsDir, 'package.json'))) continue;
      out.push({ id: p.id, name: p.name, assetsDir, update });
    }
    return out;
  }

  // ------------------------------------------------------ 配套插件同步 --

  function healProfileModules(): void {
    try {
      const removed = healProfileModuleShadowing(dshHome, desktopProfile());
      if (removed.length) log('boot', '已清理 profile node_modules 中遮蔽安装闭包的包拷贝: ' + removed.join(', '));
    } catch (err) {
      log('boot', '清理 profile 模块遮蔽失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // 整个同步体幂等（戳记跳过 + 行不重写），对 Windows 上 AV/索引器造成的
  // 瞬态 EPERM/ENOENT 自动重试一次；仍失败才放弃并记日志。
  function syncCompanionPlugins(): void {
    try {
      syncCompanionPluginsOnce();
    } catch (first) {
      log('boot', '同步配套插件遇到瞬态错误，重试一次: ' + ((first instanceof Error && first.message) || first));
      try {
        syncCompanionPluginsOnce();
      } catch (err) {
        log('boot', '同步配套插件失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
  }

  function syncCompanionPluginsOnce(): void {
    // 桌面专属 profile 必须先存在（未知 profile 不会被 dsh 自动初始化）。
    ensureDesktopProfileInit();
    const profileDirP = desktopProfileDir();
    const inSafeMode = safeModeActive();
    if (inSafeMode) log('boot', '安全模式激活中：跳过配套插件 patch 行同步（退出安全模式后恢复）');
    // 内置社区 agent preset：安装到用户 preset 根（已存在则跳过，用户优先）。
    const presetsSynced = syncBundledPresets(
      path.join(appRoot, 'assets', 'agent-presets'),
      path.join(dshHome, '.agent-presets'),
      (m) => log('boot', m),
    );
    if (presetsSynced.installed.length) log('boot', '已安装内置 agent preset: ' + presetsSynced.installed.join(', '));
    const defaultResult = ensureDefaultAgentPreset(dshHome, 'anchored-standard', (m) => log('boot', m));
    if (defaultResult === 'set') log('boot', '已设置默认 agent preset: anchored-standard');
    else if (defaultResult === 'kept') log('boot', '用户已设置默认 agent preset，保持不变');
    fs.mkdirSync(path.join(profileDirP, 'node_modules'), { recursive: true });
    const pending: CompanionEntry[] = [];
    const removedIds = removedPluginIds();
    const migratedBuiltins: { name: string; dep: boolean; rows: string[] }[] = [];
    for (const p of COMPANION_PLUGINS) {
      if (removedIds.has(p.id)) {
        log('boot', `已按用户选择跳过被移除的内置插件: ${p.id}`);
        continue;
      }
      const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
      const src = builtinPluginSourceDir(dirName as string);
      if (!fs.existsSync(path.join(src, 'package.json'))) {
        log('boot', `配套插件源目录无效，跳过: ${p.id} → ${src}`);
        continue;
      }
      try {
        // 先快照（保护中心）：迁移属于配置面手术，出问题可一键回滚。
        const dupPreCheck = ((): boolean => {
          try {
            const pkg = readJsonFile(path.join(profileDirP, 'package.json'));
            const spec = pkg && pkg.dependencies && pkg.dependencies[p.name];
            if (spec && !String(spec).startsWith('link:') && !String(spec).startsWith('file:')) return true;
            if (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) && pkg.dsh.profile.bundles.includes(p.name)) return true;
            const patchText = fs.readFileSync(path.join(profileDirP, 'cordis.patch.yml'), 'utf8');
            const esc = String(p.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp("name:\\s*['\"]?" + esc + "['\"]?\\s*$", 'm').test(patchText);
          } catch {
            return false;
          }
        })();
        if (dupPreCheck) ensureGuard().snapshot('builtin-migrate:' + p.id);
        const migrated = removeMarketDuplicate(profileDirP, p.name, { log: (m) => log('boot', m) });
        if (migrated.changed && migrated.ok) {
          migratedBuiltins.push({ name: p.name, dep: migrated.removedDep.length > 0, rows: migrated.removedRows });
          log('boot', `内置插件 ${p.name} 已接管市场同名包（移除依赖 ${migrated.removedDep.length} 个、patch 行 ${migrated.removedRows.length} 个）`);
        }
      } catch (err) {
        log('boot', `内置插件同名迁移失败(${p.id}): ${String((err instanceof Error && err.message) || err)}`);
      }
      copyPluginPackage(profileDirP, src, p.name);
      // p.disabled: true 的配套插件默认以禁用行注册；已有行不重写，用户选择优先。
      pending.push({ id: p.id, name: p.name, disabled: p.disabled === true, config: p.config });
    }
    // 皮肤包不进入 companion 更新源；它们随应用资产同步，且以 disabled 行
    // 注册，确保启动时最多只有用户明确选择的一套 skin 生效。
    const skinPending: CompanionEntry[] = [];
    if (fs.existsSync(SKINS_DIR)) {
      for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (DISABLED_SKINS.has(entry.name)) {
          log('boot', `皮肤暂未启用，跳过首启注册: ${entry.name}`);
          continue;
        }
        const src = path.join(SKINS_DIR, entry.name);
        const pkg = readJsonFile(path.join(src, 'package.json'));
        const skin = readJsonFile(path.join(src, 'skin.json'));
        const rowId = skin?.wiring?.id;
        if (!pkg?.name || typeof pkg.name !== 'string' || !/^ui-skin-[a-z0-9-]+$/.test(String(rowId))) {
          log('boot', `皮肤资产清单无效，跳过: ${entry.name}`);
          continue;
        }
        if (removedIds.has(rowId)) {
          log('boot', `已按用户选择跳过被移除的皮肤: ${rowId}`);
          continue;
        }
        copyPluginPackage(profileDirP, src, pkg.name);
        skinPending.push({ id: rowId, name: pkg.name, disabled: true });
      }
    }
    pending.push(...skinPending);
    if (migratedBuiltins.length) {
      try {
        const names = migratedBuiltins.map((m) => m.name).join('、');
        notify('内置插件已接管同名市场包', `检测到市场安装的重复包，已改用内置版本（${names}）。插件树已自动整理，本次启动生效。`);
      } catch (err) {
        log('boot', '内置接管通知发送失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
    // 内置插件清单标记供同步与碰撞防护使用。
    try {
      const builtinNames = pending.map((p) => p.name);
      const marker = path.join(profileDirP, '.dsh-builtin-plugins.json');
      const prev = readJsonFile(marker);
      const next = { names: builtinNames, updatedAt: new Date().toISOString() };
      if (!prev || JSON.stringify(prev.names) !== JSON.stringify(next.names)) {
        fs.writeFileSync(marker, JSON.stringify(next, null, 2) + '\n');
      }
    } catch (err) {
      log('boot', '写入内置插件清单失败: ' + (err instanceof Error ? err.message : String(err)));
    }
    // 注册到 profile 的 patch 层（幂等：已有行不重写）。
    const patchFile = path.join(profileDirP, 'cordis.patch.yml');
    let patch = '';
    try {
      patch = fs.readFileSync(patchFile, 'utf8');
    } catch {
      patch = '';
    }
    let changed = false;
    let bundled: string[] = [];
    try {
      bundled = readJsonFile(path.join(profileDirP, 'package.json'))?.dsh?.profile?.bundles || [];
    } catch {
      bundled = [];
    }
    // 同一 entry id 被两处声明（bundle 包内 patch + overlay 配套行）会以
    // "duplicate loader entry id" 拖垮整个插件树（issue #16：还要按
    // bundle 实际声明的 entry id 集合去重，git/fork 安装同样命中）。
    const declaredBundleIds = collectBundleEntryIds(bundled, path.join(profileDirP, 'node_modules'));
    const rowIds: Record<string, string> = {};
    for (const p of [...COMPANION_PLUGINS, ...skinPending]) rowIds[p.id] = p.name;
    const deduped = removeBundledRowDuplicates(patch, rowIds, bundled, declaredBundleIds);
    if (deduped.removed.length) {
      patch = deduped.patch;
      changed = true;
      log('boot', '已移除与 bundle 登记重复的 patch 行: ' + deduped.removed.map(String).join(', '));
    }
    // Package copies remain available for recovery, but their loader rows must
    // not be written while safe mode is active. Otherwise the next restart
    // silently turns a one-plugin profile back into the full plugin set.
    for (const p of inSafeMode ? [] : pending) {
      if (hasEntryId(patch, p.id)) continue;
      if (bundled.includes(p.name) || declaredBundleIds.has(p.id)) continue;
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config as Record<string, unknown>);
      if (p.disabled) block += `      disabled: true\n`;
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(patchFile, patch);
      log('boot', '已同步配套插件到 web profile: ' + pending.map((p) => p.id).join(', '));
    }
  }

  // ------------------------------------------------- 第三方构建产物保留 --

  const ALLOW_BUILDS_MODULE = path.join(appRoot, 'assets', 'runtime', 'plugin-install', 'allow-builds.mjs');
  let allowBuildsMod: any = null;

  async function allowBuilds(): Promise<any> {
    if (allowBuildsMod) return allowBuildsMod;
    try {
      allowBuildsMod = await import(pathToFileURL(ALLOW_BUILDS_MODULE).href);
    } catch (err) {
      log('allow-builds', '模块加载失败: ' + (err instanceof Error ? err.message : String(err)));
      allowBuildsMod = {};
    }
    return allowBuildsMod;
  }

  function managedPackageNames(): string[] {
    return COMPANION_PLUGINS.map((p) => p.name);
  }

  // ------------------------------------------------------ 插件启停管理 --

  let dshYamlDialect: { load: (content: string) => unknown } | null = null;
  let dshYamlTried = false;
  function loadDshYamlDialect(): { load: (content: string) => unknown } | null {
    if (dshYamlTried) return dshYamlDialect;
    dshYamlTried = true;
    try {
      const yaml = require('js-yaml') as any;
      // 与 dsh 相同的 entry-list 方言：`!!js` 表达式是合法标量。
      const jsType = new yaml.Type('tag:yaml.org,2002:js', {
        kind: 'scalar',
        resolve: (data: unknown) => typeof data === 'string',
        construct: (data: unknown) => ({ __jsExpr: data }),
      });
      dshYamlDialect = { load: (content: string) => yaml.load(content, { schema: yaml.JSON_SCHEMA.extend(jsType) }) };
    } catch {
      dshYamlDialect = null;
    }
    return dshYamlDialect;
  }

  function pluginManagerReadPatch(): { file: string; text: string; entries: any[] } {
    const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch { /* 无 patch 文件 */ }
    const yaml = loadDshYamlDialect();
    if (!yaml) return { file, text, entries: [] };
    try {
      const parsed = yaml.load(text);
      return { file, text, entries: Array.isArray(parsed) ? parsed : [] };
    } catch {
      return { file, text, entries: [] };
    }
  }

  function pluginManagerPackageDescription(name: string): string {
    if (!name) return '';
    const candidates = [
      path.join(desktopProfileDir(), 'node_modules', ...name.split('/')),
      path.join(appRoot, 'assets', 'plugins', name.includes('/') ? name.slice(name.indexOf('/') + 1) : name),
    ];
    for (const dir of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg && typeof pkg.description === 'string' && pkg.description) return pkg.description;
      } catch { /* 尝试下一个候选 */ }
    }
    return '';
  }

  function pluginManagerCollect(): ReturnType<typeof collectPluginRows> {
    const { entries } = pluginManagerReadPatch();
    let bundles: string[] = [];
    try {
      const m = JSON.parse(fs.readFileSync(path.join(desktopProfileDir(), 'package.json'), 'utf8'));
      bundles = m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles) ? m.dsh.profile.bundles : [];
    } catch { /* 无 manifest */ }
    return collectPluginRows(entries, {
      companion: COMPANION_PLUGINS.map((p) => ({ id: p.id, name: p.name })),
      coreIds: CORE_PLUGIN_IDS,
      removedIds: removedPluginIds(),
      describe: (name) => pluginManagerPackageDescription(name),
      bundles,
    });
  }

  function pluginManagerResolveName(id: string): string {
    const c = COMPANION_PLUGINS.find((p) => p.id === id);
    if (c) return c.name;
    const { entries } = pluginManagerReadPatch();
    for (const entry of entries) {
      if (entry && Array.isArray(entry.insert)) {
        const it = entry.insert.find((x: any) => x && x.id === id);
        if (it && it.name) return it.name;
      }
    }
    return '';
  }

  // 写入/移除用户层 disabled 条目（「启用」保留顶层裸条目，防 sync 重插回）。
  function pluginManagerSetEnabled(id: unknown, enabled: unknown): { ok: boolean; error?: string } {
    const file = path.join(desktopProfileDir(), 'cordis.patch.yml');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch { /* 新文件 */ }
    if (!text.trim()) text = '# dsh web profile patch（由 Deepseek Harness EAC 维护）\n';
    const name = pluginManagerResolveName(String(id));
    if (!enabled && !name) return { ok: false, error: '无法解析插件包名: ' + String(id) };
    let patched: string;
    try {
      patched = togglePluginInPatch(text, String(id), !!enabled, name);
    } catch (err) {
      return { ok: false, error: String((err instanceof Error && err.message) || err) };
    }
    if (patched !== text) {
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, patched, 'utf8');
        fs.renameSync(tmp, file);
      } catch (err) {
        return { ok: false, error: String((err instanceof Error && err.message) || err) };
      }
    }
    return { ok: true };
  }

  // 恢复单个配套插件：立即复制包 + 补写 patch 行（覆盖层版本优先）。
  function restoreCompanionPlugin(p: CompanionEntry): { ok: boolean; error?: string } {
    const profileDirP = desktopProfileDir();
    const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name);
    const src = builtinPluginSourceDir(dirName as string);
    if (!fs.existsSync(path.join(src, 'package.json'))) {
      return { ok: false, error: '配套插件源目录无效: ' + src };
    }
    copyPluginPackage(profileDirP, src, p.name);
    const patchFile = path.join(profileDirP, 'cordis.patch.yml');
    let patch = '';
    try {
      patch = fs.readFileSync(patchFile, 'utf8');
    } catch { /* 新文件 */ }
    if (!hasEntryId(patch, p.id)) {
      let bundled: string[] = [];
      try {
        bundled = readJsonFile(path.join(profileDirP, 'package.json'))?.dsh?.profile?.bundles || [];
      } catch {
        bundled = [];
      }
      if (!bundled.includes(p.name)) {
        let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
        if (p.config) block += configLinesFor(p.config as Record<string, unknown>);
        if (p.disabled) block += `      disabled: true\n`;
        if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
        else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
        else patch = patch.replace(/\s*$/, '\n') + block;
        try {
          fs.writeFileSync(patchFile, patch);
        } catch (err) {
          return { ok: false, error: String((err instanceof Error && err.message) || err) };
        }
      }
    }
    return { ok: true };
  }

  // removed=true 移除（卸载语义）；removed=false 恢复。核心插件拒绝移除。
  function pluginManagerSetRemoved(id: string, removed: boolean): { ok: boolean; restartRequired?: boolean; error?: string } {
    const p = COMPANION_PLUGINS.find((x) => x.id === id);
    if (!p) return { ok: false, error: '未知内置插件: ' + String(id) };
    if (CORE_PLUGIN_IDS.has(id)) {
      return { ok: false, error: '核心插件不可移除: ' + String(id) };
    }
    const removedSet = removedPluginIds();
    const patchFile = path.join(desktopProfileDir(), 'cordis.patch.yml');
    try {
      if (removed) {
        // 1) 清 patch 行（顶层 + insert 内层）
        let text = '';
        try {
          text = fs.readFileSync(patchFile, 'utf8');
        } catch { /* 新文件 */ }
        const patched = removePluginFromPatch(text, id);
        if (patched !== text) fs.writeFileSync(patchFile, patched, 'utf8');
        // 2) 删 profile node_modules 里的包副本
        const pkgDir = path.join(desktopProfileDir(), 'node_modules', p.name);
        fs.rmSync(pkgDir, { recursive: true, force: true });
        // 3) 记入跳过清单（下次 sync 不再写回）
        removedSet.add(id);
        saveRemovedPluginIds(removedSet);
        log('plugin-manager', '已移除内置插件 ' + id);
        return { ok: true, restartRequired: true };
      }
      // 恢复：清出跳过清单 + 立即复制包与行
      removedSet.delete(id);
      saveRemovedPluginIds(removedSet);
      const res = restoreCompanionPlugin(p);
      if (!res.ok) return res;
      log('plugin-manager', '已恢复内置插件 ' + id);
      return { ok: true, restartRequired: true };
    } catch (err) {
      log('plugin-manager', '移除/恢复插件 ' + id + ' 失败: ' + String((err instanceof Error && err.message) || err));
      return { ok: false, error: String((err instanceof Error && err.message) || err) };
    }
  }

  // ------------------------------------------------------ 余额（dsh-balance）--

  async function refreshBalance(): Promise<Record<string, unknown>> {
    let result: any;
    try {
      result = await balance.queryBalance(dshHome);
    } catch (err) {
      result = { ok: false, error: String((err instanceof Error && err.message) || err), balances: [] };
    }
    // 按当前默认模型选择价格档（settings.json 可覆盖 balancePrices.<model>）。
    const model = balance.readActiveModel(dshHome) || 'deepseek-v4-pro';
    const table = result.prices || balance.DEFAULT_PRICES;
    const s = loadSettings();
    const pricing = balance.computePricingState(s.pricing && s.pricing.peakWindows);
    const base = (table as Record<string, balance.TierMap>)[model] || balance.FALLBACK_PRICES;
    const ov = (s.balancePrices && s.balancePrices[model]) || {};
    const tier = (src: string): balance.TierPrice => balance.tierPrices(base as any, ov as any, src);
    result.prices = tier(pricing.period);
    result.pricing = { ...pricing, prices: { peak: tier('peak'), offpeak: tier('offpeak') } };
    return result;
  }

  function balancePricesGet(model: unknown): Record<string, unknown> {
    const s = loadSettings();
    const m = String(model || '');
    const defaults = (balance.DEFAULT_PRICES as Record<string, balance.TierMap>)[m] || balance.FALLBACK_PRICES;
    const current = (s.balancePrices && s.balancePrices[m]) || null;
    return { ok: true, model: m, defaults, current };
  }

  function balancePricesSet(model: unknown, prices: unknown): { ok: boolean; error?: string } {
    const m = String(model || '');
    if (!(balance.DEFAULT_PRICES as Record<string, unknown>)[m]) return { ok: false, error: '未知模型: ' + m };
    try {
      const cleaned = balance.sanitizePrices(prices);
      const s = loadSettings();
      if (!s.balancePrices || typeof s.balancePrices !== 'object') s.balancePrices = {};
      s.balancePrices[m] = cleaned;
      saveSettings(s);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err instanceof Error && err.message) || err) };
    }
  }

  function balancePricesReset(model: unknown): { ok: boolean; error?: string } {
    const m = String(model || '');
    try {
      const s = loadSettings();
      if (s.balancePrices && s.balancePrices[m]) {
        delete s.balancePrices[m];
        saveSettings(s);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err instanceof Error && err.message) || err) };
    }
  }

  // ------------------------------------------------- 内置插件更新（V4.3）--

  function updatesListSources(): pluginUpdater.PluginSource[] {
    return pluginUpdateSources();
  }

  async function updatesCheck({ manual = false } = {} as any): Promise<Record<string, unknown>> {
    const sources = updatesListSources();
    if (sources.length === 0) return {};
    if (!manual && !pluginUpdater.dueForCheck(settingsCtx, Date.now())) return {};
    const list = await pluginUpdater.checkPluginUpdates(settingsCtx, sources, {
      force: !!manual,
      profileDirP: desktopProfileDir(),
    });
    if (!manual) pluginUpdater.markChecked(settingsCtx);
    const updatable = list.filter((x) => x.hasUpdate && !x.skipped);
    if (updatable.length === 0) return {};
    if (!pluginUpdater.isAutoUpdateEnabled(settingsCtx)) {
      // 默认行为：只检测并提示，下载交给用户在「更新」标签页手动完成。
      return { notifyUpdatable: updatable.map((x) => ({ id: x.id, name: x.name, latest: x.latest })) };
    }
    const { done, failed } = await pluginUpdater.autoApplyUpdates(settingsCtx, sources, {
      profileDirP: desktopProfileDir(),
      guard: ensureGuard(),
      copyIntoProfile: (overlayDir: string, name: string) => copyPluginPackage(desktopProfileDir(), overlayDir, name),
    });
    log('plugin-update', '自动更新完成: ' + (done.map((d) => d.name).join('、') || '无') + (failed.length ? '；失败 ' + failed.length + ' 个' : ''));
    return {
      done: done.map((d) => ({ id: d.id, name: d.name, version: d.latest })),
      failed: failed.map((f) => ({ id: f.id, name: f.name, error: f.error })),
    };
  }

  async function updatesList({ force = false } = {} as any): Promise<Record<string, unknown>> {
    const ctx = settingsCtx;
    const list = await pluginUpdater.checkPluginUpdates(ctx, updatesListSources(), {
      force: !!force,
      profileDirP: desktopProfileDir(),
    });
    return {
      list,
      autoUpdate: pluginUpdater.isAutoUpdateEnabled(ctx),
      checkedAt: loadSettings().pluginUpdateCheckedAt || null,
    };
  }

  async function updatesUpdateOne({ id } = {} as any): Promise<any> {
    const source = updatesListSources().find((s) => s.id === String(id));
    if (!source) return { ok: false, error: '未知或不可更新的内置插件: ' + String(id) };
    const res = await pluginUpdater.applyBuiltinPluginUpdate(settingsCtx, source, {
      profileDirP: desktopProfileDir(),
      guard: ensureGuard(),
      copyIntoProfile: (overlayDir: string, name: string) => copyPluginPackage(desktopProfileDir(), overlayDir, name),
    });
    if (!res.ok) return res;
    if (res.noop) return { ok: true, noop: true, current: res.current, latest: res.latest };
    log('plugin-update', '手动更新内置插件 ' + id + ' → ' + res.latest + (res.restartRequired ? '（重启服务生效）' : ''));
    return { ok: true, version: res.latest, restartRequired: res.restartRequired };
  }

  function updatesSetAutoUpdate({ enabled } = {} as any): { ok: boolean; error?: string } {
    try {
      const s = loadSettings();
      s.pluginAutoUpdate = !!enabled;
      saveSettings(s);
      log('plugin-update', '内置插件自动更新已' + (enabled ? '开启' : '关闭'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err instanceof Error && err.message) || err) };
    }
  }

  // ------------------------------------------------------ koffi 预检 --

  async function koffiPreflight(): Promise<Record<string, unknown>> {
    const { runKoffiPreflightAsync, enablePickerBrowseOverlay, clearAutoPickerBrowseOverlay } = require('./lib/koffi-preflight') as typeof import('./lib/koffi-preflight');
    const file = path.join(userDataDir, 'picker-browse.overlay.yml');
    try {
      const ok = await runKoffiPreflightAsync({
        spawn: spawn as unknown as (exe: string, args: string[], opts: { windowsHide: boolean; stdio: string[] }) => import('./lib/koffi-preflight').AsyncChild,
        nodeExe: nodeExe(),
        script: path.join(appRoot, 'scripts', 'koffi-preflight.cjs'),
        log: (m) => log('preflight', m),
      });
      if (ok) {
        clearAutoPickerBrowseOverlay({ file, log: (m) => log('preflight', m) });
        return { ok: true };
      }
      enablePickerBrowseOverlay({ file, log: (m) => log('preflight', m) });
      return { ok: false, overlayPath: file };
    } catch (err) {
      log('preflight', '预检异常: ' + (err instanceof Error ? err.message : String(err)));
      return { ok: false, overlayPath: file };
    }
  }

  // ------------------------------------------------- junction 巡检（原生 dsh 共存）--

  // 检测本机是否有其它 dsh 进程在跑。Windows 下用 CIM 查 node 进程命令行；
  // 超时或失败按「无外部进程」处理（宁可漏报）。
  function detectExternalDsh(): { running: boolean; pids: number[] } {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    try {
      const out = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\'\'node.exe\'\'\' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
        { encoding: 'utf8', windowsHide: true, timeout: 12000 },
      );
      const arr = out.trim() === '' ? [] : JSON.parse(out);
      const list = Array.isArray(arr) ? arr : [arr];
      const pids: number[] = [];
      for (const it of list) {
        const pid = Number(it && it.ProcessId);
        const cmd = String((it && it.CommandLine) || '');
        if (!Number.isFinite(pid) || pid === process.pid) continue;
        if (!/dsh|deepseek-ai/i.test(cmd)) continue;
        if (!/(\s|\/|\\)(web|plugin|run|tui)(\s|$)|bin\.(js|ts)/i.test(cmd)) continue;
        pids.push(pid);
      }
      return { running: pids.length > 0, pids };
    } catch {
      return { running: false, pids: [] };
    }
  }

  async function junctionTick(): Promise<Record<string, unknown>> {
    try {
      const g = ensureGuard();
      const findings = g.junctionFindings();
      if (findings.length === 0) return { repaired: [], externalRunning: false };
      const ext = detectExternalDsh();
      if (ext.running) {
        log('guard', '共享模块被外部 dsh 接管（PID ' + ext.pids.join(', ') + '），待其退出后自动修复');
        return { repaired: [], externalRunning: true };
      }
      const res = g.repairJunctions();
      return { repaired: res.repaired, unknown: res.unknown, externalRunning: false };
    } catch {
      return { repaired: [], externalRunning: false };
    }
  }

  // ------------------------------------------------- guard.action 分发 --

  function guardAction(
    { action, value, serviceRunning = false, restartingServer = false } = {} as {
      action?: string;
      value?: unknown;
      serviceRunning?: boolean;
      restartingServer?: boolean;
    },
  ): any {
    const g = ensureGuard();
    switch (action) {
      case 'status': {
        const st = (() => {
          try {
            return loadSettings();
          } catch {
            return {} as Record<string, any>;
          }
        })();
        return {
          ok: true,
          profile: desktopProfile(),
          shareWebProfile: st.shareWebProfile === true,
          snapshots: g.listSnapshots().slice(0, 20),
          incidents: g.listIncidents().slice(0, 20),
          lastGood: g.lastGoodSnapshot(),
        };
      }
      case 'snapshot': {
        const s = g.snapshot(String(value || 'manual'));
        return { ok: !!s, snapshot: s };
      }
      case 'restore': {
        if (serviceRunning && !restartingServer) {
          // 服务运行中不能换配置文件（文件锁 + 进程内存态）：走标准重启窗口。
          return { ok: false, error: 'service-running', hint: '请先重启 Web 服务（或让回滚在重启间隙执行）' };
        }
        return g.restore(value);
      }
      case 'check':
        return { ok: true, report: g.healthCheck() };
      case 'repair': {
        const r = g.repair();
        return { ok: true, applied: r.applied };
      }
      case 'incident':
        return g.readIncident(value);
      case 'resolve-incident':
        return g.resolveIncident(value);
      default:
        return { ok: false, error: 'unknown action' };
    }
  }

  // allowBuilds 配置级修复钩子（守护启动 preRetry）。
  async function guardAllowBuildsPreRetry({ errText } = {} as any): Promise<{ applied: string[] }> {
    try {
      const ab = await allowBuilds();
      if (typeof ab.parseBlockedBuildKeys !== 'function') return { applied: [] };
      const keys = ab.parseBlockedBuildKeys(String(errText || '')) as string[];
      // 报错详情可能只落在 dsh-web.log 里，补充解析尾部。
      try {
        const tail = fs.readFileSync(path.join(logsDir, 'dsh-web.log'), 'utf8').slice(-40000);
        for (const k of ab.parseBlockedBuildKeys(tail)) {
          if (!keys.includes(k)) keys.push(k);
        }
      } catch { /* 无日志文件 */ }
      if (keys.length === 0) return { applied: [] };
      const r = await ab.ensureAllowBuilds(path.join(desktopProfileDir(), 'pnpm-workspace.yaml'), keys);
      if (!r || !r.wrote) return { applied: [] };
      log('guard', '[allowBuilds] 启动失败疑似 pnpm 封锁构建脚本，已自动放行: ' + r.added.join(', '));
      return { applied: ['pnpm allowBuilds 自动放行: ' + r.added.join(', ')] };
    } catch (err) {
      log('guard', '[allowBuilds] 预检失败: ' + String((err instanceof Error && err.message) || err));
      return { applied: [] };
    }
  }

  // ------------------------------------------------- 启动链编排（boot 调用）--

  async function migrateAndSync(): Promise<{ ok: true }> {
    await upgradePreflight();
    syncCompanionPlugins();
    healProfileModules();
    return { ok: true };
  }

  async function syncAll(): Promise<{ ok: true }> {
    await upgradePreflight();
    syncCompanionPlugins();
    healProfileModules();
    return { ok: true };
  }

  async function upgradePreflight(): Promise<{ ok: true }> {
    await ensureHealthyOverlay();
    const activeKernel = readJsonFile(path.join(path.dirname(path.dirname(dshBin())), 'package.json'));
    if (activeKernel?.version !== UPGRADE_TARGET.kernel) {
      throw new Error('PROFILE_UPGRADE_REQUIRED: active kernel needs offline migration');
    }
    assertProfileStartup(appRoot, desktopProfileDir());
    return { ok: true };
  }

  return {
    // profile
    upgradePreflight, migrateAndSync, syncAll, ensureDesktopProfileInit, syncCompanionPlugins, healProfileModules,
    managedPackageNames,
    // guard
    ensureGuard, guardAction, guardAllowBuildsPreRetry, junctionTick,
    // plugins
    pluginManagerCollect, pluginManagerSetEnabled, pluginManagerSetRemoved,
    pluginUpdateSources, builtinPluginSourceDir, copyPluginPackage, pluginCopyEntries, pluginStampOf,
    // balance
    refreshBalance, balancePricesGet, balancePricesSet, balancePricesReset,
    // updates
    updatesCheck, updatesList, updatesUpdateOne, updatesSetAutoUpdate,
    // misc
    koffiPreflight, desktopProfile, desktopProfileDir, dshBin, loadSettings, saveSettings, ensureHealthyOverlay, confirmHealthyOverlay,
    detectExternalDsh,
    // 常量（测试用）
    COMPANION_PLUGINS, CORE_PLUGIN_IDS, PLUGIN_UPDATE_SOURCES, EXTRA_PACKAGE_FILES, COPY_STAMP,
  };
}

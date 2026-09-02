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

// v4Lite 核心内置插件（壳运行必需）：插件市场/保护中心/启停管理。
// 其他内置插件可被「插件 → 管理」移除，核心组拒绝移除。
const CORE_PLUGIN_IDS = new Set(['plugin-manager', 'plugin-shield']);

// 与官方 web profile 出厂模板一致（@deepseek-ai/dsh-base + dsh-web-app）。
export const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
export const DESKTOP_PROFILE = 'web-desktop';

// 随插件/皮肤包一起拷贝到 profile 的许可与出处文件（存在才拷贝）。
const EXTRA_PACKAGE_FILES = ['LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md', 'README.md', 'README.zh.md', 'README.zh-CN.md', 'THIRD-PARTY-NOTICES.md', 'EAC-VENDOR.json'];
const COPY_STAMP = '.eac-copy-stamp.json';

// 内置插件上游更新源（V4.3）：只登记「上游仍在 npm / GitHub 发布」的社区插件。
const PLUGIN_UPDATE_SOURCES: Record<string, { npm?: string; github?: string }> = {
  'better-sidebar': { npm: 'dsh-better-sidebar' },
  'composer-dynamic-island': { github: 'says693/dsh-composer-dynamic-island' },
  'dsh-market-plugin': { npm: '@sanqi-normal/dsh-webui-market-plugin' },
  'dsh-undo': { github: 'lire1131/dsh-undo-savepoint' },
};

// 插件市场排队任务标记。
const MARKER_NAME = '.dsh-market-pending.json';
const MARKER_MAX_ATTEMPTS = 3;

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

  function dshBin(): string {
    const ov = updater.overlayBinPath(settingsCtx);
    if (ov && fs.existsSync(ov)) return ov;
    return path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }

  function desktopProfile(): string {
    try {
      return loadSettings().shareWebProfile === true ? 'web' : DESKTOP_PROFILE;
    } catch {
      return DESKTOP_PROFILE;
    }
  }

  const desktopProfileDir = (): string => path.join(dshHome, 'profiles', desktopProfile());
  const profileDirFor = (profile: string): string => path.join(dshHome, 'profiles', profile);
  const artifactCacheDirFor = (profile: string): string => path.join(dshHome, 'plugin-artifact-cache', profile);
  const SKINS_DIR = path.join(appRoot, 'assets', 'skins');

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
    { id: 'skin-switch', name: '@deepseek-ai/dsh-skin-switch' },
    { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin', dir: 'dsh-webui-market' },
    { id: 'plugin-marketplace', name: '@deepseek-ai/dsh-plugin-marketplace', dir: 'dsh-plugin-marketplace' },
    { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar' },
    { id: 'composer-dynamic-island', name: 'dsh-composer-dynamic-island', dir: 'dsh-composer-dynamic-island' },
    { id: 'auto-compact', name: 'dsh-auto-compact', dir: 'dsh-auto-compact' },
    { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
    { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
    { id: 'offpeak', name: 'dsh-offpeak', dir: 'dsh-offpeak' },
    { id: 'dsh-undo', name: 'dsh-undo-savepoint', dir: 'dsh-undo-savepoint' },
  ];

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
      if (desktopProfile() === 'web') return; // 共享模式走官方模板
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
    // dsh-webui-market 的离线目录快照（官网不可达时的兜底数据）。
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

  // ------------------------------------------------------ 一次性 profile 迁移 --

  function extractPatchRowIds(patch: unknown): string[] {
    const ids: string[] = [];
    const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(patch || ''))) !== null) ids.push(m[1] as string);
    return ids;
  }

  function removePatchRowsById(patch: string, ids: Set<string>): { patch: string; removed: string[] } {
    const removed: string[] = [];
    if (typeof patch !== 'string' || patch === '' || !ids || ids.size === 0) return { patch, removed };
    const lines = patch.split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (/^-\s*insert:/.test(line)) {
        const mid = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec((lines[i + 1] as string) || '');
        if (mid && ids.has(mid[1] as string)) {
          removed.push(mid[1] as string);
          let j = i + 1;
          while (j < lines.length && !/^-\s*insert:/.test(lines[j] as string) && /^#/.test(lines[j] as string) === false && /^\s+\S/.test(lines[j] as string)) j++;
          i = j - 1;
          continue;
        }
      }
      out.push(line);
    }
    let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
    if (!text.endsWith('\n')) text += '\n';
    return { patch: text, removed };
  }

  // 一次性迁移：桌面端从共享 web profile 切到专属 web-desktop profile（幂等）。
  function migrateFromSharedWebProfile(): void {
    try {
      const s = loadSettings();
      if (s.desktopProfileMigrated) return;
      s.desktopProfileMigrated = new Date().toISOString();
      saveSettings(s); // 先落标记：即使下面失败也不反复折腾
      if (s.shareWebProfile === true) return; // 用户显式选择共享模式

      const oldDir = path.join(dshHome, 'profiles', 'web');
      const marker = path.join(oldDir, '.dsh-builtin-plugins.json');
      if (!fs.existsSync(marker)) return; // 旧版本从没在共享 profile 跑过桌面端
      const builtinNames: string[] = readJsonFile(marker)?.names || [];

      // 1) 提取用户启用的皮肤行 id。
      let enabledSkin: string | null = null;
      const patchFile = path.join(oldDir, 'cordis.patch.yml');
      let oldPatch = '';
      try {
        oldPatch = fs.readFileSync(patchFile, 'utf8');
      } catch {
        oldPatch = '';
      }
      {
        const lines = oldPatch.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const m = /^- id: (ui-skin-[\w-]+)\s*$/.exec(lines[i] as string);
          if (!m) continue;
          let disabled = false;
          for (let j = i + 1; j < lines.length; j++) {
            if (/^- /.test(lines[j] as string)) break;
            if (/^\s+disabled:\s*true/.test(lines[j] as string)) disabled = true;
          }
          if (!disabled) enabledSkin = m[1] as string;
        }
      }

      // 2) 清理旧 profile 的桌面端痕迹。
      const rowIdSet = new Set<string>();
      for (const p of COMPANION_PLUGINS) rowIdSet.add(p.id);
      for (const id of extractPatchRowIds(oldPatch)) {
        if (/^ui-skin-[\w-]+$/.test(id)) rowIdSet.add(id);
      }
      const cleaned = removePatchRowsById(oldPatch, rowIdSet);
      if (cleaned.removed.length) fs.writeFileSync(patchFile, cleaned.patch);
      for (const name of builtinNames) {
        try {
          fs.rmSync(path.join(oldDir, 'node_modules', ...String(name).split('/')), { recursive: true, force: true, maxRetries: 2 });
        } catch { /* 尽力清理 */ }
      }
      try {
        fs.rmSync(marker, { force: true });
      } catch { /* 尽力清理 */ }
      log('boot', '已迁移到桌面专属 profile（' + DESKTOP_PROFILE + '）：旧 web profile 清理了 ' + cleaned.removed.length + ' 条桌面配套行 / ' + builtinNames.length + ' 个配套包');

      // 3) 在专属 profile 里复活用户选择的皮肤（applyLegacySkinChoice 落位）。
      if (enabledSkin) {
        const s2 = loadSettings();
        s2.legacySkinChoice = enabledSkin;
        saveSettings(s2);
        log('boot', '将迁移用户皮肤选择: ' + enabledSkin);
      }
    } catch (err) {
      log('boot', '共享 profile 迁移失败（不影响启动）: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // syncCompanionPlugins 之后调用一次：把迁移带来的皮肤选择落到新 profile。
  function applyLegacySkinChoice(): void {
    try {
      const s = loadSettings();
      const skin = s.legacySkinChoice;
      if (!skin || !/^ui-skin-[\w-]+$/.test(skin)) return;
      const patchFile = path.join(desktopProfileDir(), 'cordis.patch.yml');
      if (!fs.existsSync(patchFile)) return;
      const text = fs.readFileSync(patchFile, 'utf8');
      const re = new RegExp('(- id: ' + skin + '\\b[^\\n]*\\n(?:      [^\\n]*\\n)*?)      disabled: true\\n');
      const next = text.replace(re, '$1');
      if (next !== text) {
        fs.writeFileSync(patchFile, next);
        log('boot', '已在专属 profile 启用迁移的皮肤: ' + skin);
      }
      delete s.legacySkinChoice;
      saveSettings(s);
    } catch (err) {
      log('boot', '应用迁移皮肤选择失败: ' + (err instanceof Error ? err.message : String(err)));
    }
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
    if (migratedBuiltins.length) {
      try {
        const names = migratedBuiltins.map((m) => m.name).join('、');
        notify('内置插件已接管同名市场包', `检测到市场安装的重复包，已改用内置版本（${names}）。插件树已自动整理，本次启动生效。`);
      } catch (err) {
        log('boot', '内置接管通知发送失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
    // 内置皮肤：行 id 取皮肤包 skin.json 的 wiring.id（ui-skin-*），默认禁用。
    for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(SKINS_DIR, entry.name);
      const pkg = readJsonFile(path.join(src, 'package.json'));
      if (!pkg || typeof pkg.name !== 'string' || !pkg.name.includes('/')) continue;
      const skin = readJsonFile(path.join(src, 'skin.json'));
      const rowId = skin && skin.wiring && typeof skin.wiring.id === 'string' ? skin.wiring.id : '';
      if (!/^ui-skin-[\w-]+$/.test(rowId)) continue;
      copyPluginPackage(profileDirP, src, pkg.name);
      pending.push({ id: rowId, name: pkg.name, disabled: true });
    }
    // 内置插件清单标记：插件市场据此拒绝重复安装同名内置包。
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
    for (const p of COMPANION_PLUGINS) rowIds[p.id] = p.name;
    const deduped = removeBundledRowDuplicates(patch, rowIds, bundled, declaredBundleIds);
    if (deduped.removed.length) {
      patch = deduped.patch;
      changed = true;
      log('boot', '已移除与 bundle 登记重复的 patch 行: ' + deduped.removed.map(String).join(', '));
    }
    for (const p of pending) {
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
      log('boot', '已同步配套插件/皮肤到 web profile: ' + pending.map((p) => p.id).join(', '));
    }
    // 迁移带来的皮肤选择在此落位。
    applyLegacySkinChoice();
  }

  // ------------------------------------------------- 第三方构建产物保留 --

  const ARTIFACT_KEEP_MODULE = path.join(appRoot, 'assets', 'plugins', 'dsh-webui-market', 'lib', 'artifact-keep.mjs');
  const ALLOW_BUILDS_MODULE = path.join(appRoot, 'assets', 'plugins', 'dsh-webui-market', 'lib', 'allow-builds.mjs');
  let artifactKeepMod: any = null;
  let allowBuildsMod: any = null;

  async function artifactKeep(): Promise<any> {
    if (artifactKeepMod) return artifactKeepMod;
    try {
      artifactKeepMod = await import(pathToFileURL(ARTIFACT_KEEP_MODULE).href);
    } catch (err) {
      log('artifact-keep', '模块加载失败: ' + (err instanceof Error ? err.message : String(err)));
      artifactKeepMod = {};
    }
    return artifactKeepMod;
  }

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
    const names = COMPANION_PLUGINS.map((p) => p.name);
    try {
      for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkg = readJsonFile(path.join(SKINS_DIR, entry.name, 'package.json'));
        if (pkg && typeof pkg.name === 'string') names.push(pkg.name);
      }
    } catch { /* 无皮肤目录 */ }
    return names;
  }

  async function restoreKeptArtifacts(profile: string): Promise<void> {
    const ak = await artifactKeep();
    if (typeof ak.restoreArtifacts !== 'function') return;
    try {
      ak.restoreArtifacts(profileDirFor(profile), artifactCacheDirFor(profile), {
        log: (m: string) => log('artifact-keep', m),
      });
    } catch (err) {
      log('artifact-keep', '回填失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ------------------------------------------------- 插件市场排队任务 --

  function removeMarkerFile(file: string): boolean {
    try {
      fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* 落到改名兜底 */ }
    if (!fs.existsSync(file)) return true;
    try {
      fs.renameSync(file, file + '.stale-' + Date.now());
    } catch { /* 锁着也无可奈何，交给 attempts 上限 */ }
    return !fs.existsSync(file);
  }

  interface MarketMarker {
    marker: string;
    job: { target: string; profile: string; kind: 'install' | 'uninstall'; label?: string; attempts?: number };
  }

  function pendingMarketMarkers(): MarketMarker[] {
    const out: MarketMarker[] = [];
    try {
      const profilesRoot = path.join(dshHome, 'profiles');
      if (!fs.existsSync(profilesRoot)) return out;
      for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const marker = path.join(profilesRoot, entry.name, MARKER_NAME);
        if (!fs.existsSync(marker)) continue;
        try {
          // 去掉可能的 UTF-8 BOM（外部编辑器写入的标记）再解析。
          const job = JSON.parse(fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, ''));
          if (
            job &&
            typeof job.target === 'string' &&
            job.target &&
            typeof job.profile === 'string' &&
            /^[A-Za-z0-9_-]+$/.test(job.profile) &&
            (job.kind === 'install' || job.kind === 'uninstall')
          ) {
            // 旧版 host 可能把目录默认 profile 'web' 写进标记——归一化后执行。
            job.profile = job.profile === 'web' ? desktopProfile() : job.profile;
            out.push({ marker, job });
          } else {
            log('market-pending', '标记字段不完整，已删除: ' + marker);
            removeMarkerFile(marker);
          }
        } catch (err) {
          log('market-pending', `标记损坏，已删除: ${marker} (${err instanceof Error ? err.message : String(err)})`);
          removeMarkerFile(marker);
        }
      }
    } catch (err) {
      log('market-pending', '扫描排队任务失败: ' + (err instanceof Error ? err.message : String(err)));
    }
    return out;
  }

  function finishMarketMarker(marker: string, job: MarketMarker['job'], attempts: number, ok: boolean, tail: unknown): void {
    if (ok) {
      log('market-pending', '排队任务完成: ' + (job.label || job.target));
      if (!removeMarkerFile(marker)) {
        log('market-pending', '警告: 排队标记删除失败（文件被占用？），已尝试改名兜底');
      }
      return;
    }
    if (attempts >= MARKER_MAX_ATTEMPTS) {
      const last = String(tail || '').split(/\r?\n/).filter(Boolean).pop() || '';
      log('market-pending', `排队任务连续 ${attempts} 次失败，放弃并清除: ${job.label || job.target}${last ? ' — ' + last.slice(0, 200) : ''}`);
      removeMarkerFile(marker);
      return;
    }
    try {
      fs.writeFileSync(marker, JSON.stringify({ ...job, attempts }, null, 2));
    } catch { /* 尽力重写 */ }
    log('market-pending', '排队任务失败（下次启动重试）: ' + (job.label || job.target));
  }

  // 必须在"没有任何 dsh web 进程持锁"时调用（调用方保证时序）。
  async function processPendingMarketOps(): Promise<{ executed: number }> {
    const items = pendingMarketMarkers();
    if (items.length === 0) return { executed: 0 };
    const nodeBin = nodeExe();
    const bin = dshBin();
    if (!fs.existsSync(nodeBin) || !fs.existsSync(bin)) {
      log('market-pending', '找不到 node/dsh CLI，跳过排队任务');
      return { executed: 0 };
    }
    log('market-pending', `发现 ${items.length} 个排队任务，开始执行（无文件锁窗口期）`);
    const profiles = [...new Set(items.map((it) => it.job.profile))];
    const ak = await artifactKeep();
    if (typeof ak.snapshotArtifacts === 'function') {
      for (const profile of profiles) {
        try {
          ak.snapshotArtifacts(profileDirFor(profile), artifactCacheDirFor(profile), {
            managedNames: managedPackageNames(),
            log: (m: string) => log('artifact-keep', m),
          });
        } catch (err) {
          log('artifact-keep', `snapshot ${profile} 失败: ` + (err instanceof Error ? err.message : String(err)));
        }
      }
    }
    await new Promise<void>((resolve) => {
      let idx = 0;
      // allowBuilds 自动放行后的重试只允许一次（同一 marker）。
      const retriedMarkers = new Set<string>();
      const next = async (): Promise<void> => {
        if (idx >= items.length) {
          // pnpm 可能重新 hoist 出 @deepseek-ai 遮蔽拷贝，装完立刻清理。
          healProfileModules();
          return resolve();
        }
        const { marker, job } = items[idx] as MarketMarker;
        const retried = retriedMarkers.has(marker);
        const attempts = Number(job.attempts || 0) + 1;
        const action = job.kind === 'uninstall' ? 'remove' : 'add';
        ensureGuard().snapshot('market:' + job.target);
        log('market-pending', `执行(${attempts}/${MARKER_MAX_ATTEMPTS}): dsh plugin --profile ${job.profile} ${action} ${job.target}`);
        const child = spawn(nodeBin, [bin, 'plugin', '--profile', job.profile, action, job.target], {
          cwd: userDataDir,
          // CI=true：pnpm v10 无 TTY 时对被忽略的构建脚本静默放行而不是硬失败。
          env: { ...marketEnv(), CI: 'true' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        const onData = (c: unknown): void => {
          const text = String(c);
          tail = (tail + text).slice(-8000);
          for (const line of text.split(/\r?\n/)) {
            const s = line.trim();
            if (s && !/^Progress:/.test(s)) log('market-pending', s.slice(0, 300));
          }
        };
        child.stdout!.on('data', onData);
        child.stderr!.on('data', onData);
        const timer = setTimeout(() => {
          log('market-pending', '排队任务超时（5 分钟），强制终止');
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch { /* 尽力终止 */ }
        }, 5 * 60 * 1000);
        child.on('error', (err) => {
          clearTimeout(timer);
          finishMarketMarker(marker, job, attempts, false, String(err instanceof Error ? err.message : err));
          idx += 1;
          next();
        });
        child.on('close', async (code) => {
          clearTimeout(timer);
          // pnpm 封锁构建脚本硬失败：解析包名 → 写 allowBuilds → 重试一次。
          if (code !== 0 && !retried) {
            try {
              const ab = await allowBuilds();
              const keys = (ab.parseBlockedBuildKeys || (() => []))(tail) as string[];
              if (keys.length > 0) {
                const r = await ab.ensureAllowBuilds(path.join(profileDirFor(job.profile), 'pnpm-workspace.yaml'), keys);
                if (r && r.wrote) {
                  log('market-pending', `[allowBuilds] 已自动放行 ${r.added.join(', ')}，自动重试`);
                  retriedMarkers.add(marker);
                  next();
                  return;
                }
              }
            } catch (err) {
              log('market-pending', '[allowBuilds] 自动放行失败: ' + String((err instanceof Error && err.message) || err));
            }
          }
          finishMarketMarker(marker, job, attempts, code === 0, tail);
          idx += 1;
          next();
        });
      };
      next();
    });
    // pnpm 重写完成：回填被清掉的第三方构建产物（lib/ 等）。
    if (typeof ak.restoreArtifacts === 'function') {
      for (const profile of profiles) {
        try {
          ak.restoreArtifacts(profileDirFor(profile), artifactCacheDirFor(profile), {
            log: (m: string) => log('artifact-keep', m),
          });
        } catch (err) {
          log('artifact-keep', `restore ${profile} 失败: ` + (err instanceof Error ? err.message : String(err)));
        }
      }
    }
    return { executed: items.length };
  }

  // dsh 子进程环境（与 Rust 壳 childEnv 一致的清理语义）。
  function marketEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const k of ['DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_SHELL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
      delete env[k];
    }
    env.DSH_HOME = dshHome;
    env.DSH_DESKTOP = '1';
    env.DSH_DESKTOP_PROFILE = desktopProfile();
    env.NO_COLOR = '1';
    return env;
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

  function migrateAndSync(): { ok: true } {
    migrateFromSharedWebProfile();
    syncCompanionPlugins();
    healProfileModules();
    return { ok: true };
  }

  function syncAll(): { ok: true } {
    syncCompanionPlugins();
    healProfileModules();
    return { ok: true };
  }

  return {
    // profile
    migrateAndSync, syncAll, ensureDesktopProfileInit, syncCompanionPlugins, healProfileModules,
    migrateFromSharedWebProfile, applyLegacySkinChoice, removePatchRowsById, extractPatchRowIds,
    // market
    processPendingMarketOps, pendingMarketMarkers, removeMarkerFile, finishMarketMarker,
    restoreKeptArtifacts, managedPackageNames,
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
    koffiPreflight, desktopProfile, desktopProfileDir, dshBin, loadSettings, saveSettings,
    detectExternalDsh,
    // 常量（测试用）
    COMPANION_PLUGINS, CORE_PLUGIN_IDS, PLUGIN_UPDATE_SOURCES, EXTRA_PACKAGE_FILES, COPY_STAMP,
  };
}

export { MARKER_NAME };

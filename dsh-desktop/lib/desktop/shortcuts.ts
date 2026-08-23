'use strict';

// 快捷方式维护 + 共享 profile 一次性迁移（ADR 0002 L2 业务服务层；
// Wave 2 自 shortcuts.js 类型化迁出，行为零变更）：修复「没有桌面快捷
// 方式 / 快捷方式指向的文件消失」，让快捷方式图标跟随图标设计更新
// （.lnk 单独指定 icon.ico）；含 web → web-desktop profile 迁移。

import path = require('node:path');
import fs = require('node:fs');
import os = require('node:os');
import { APP_ROOT, updCtx } from './runtime-paths';
import { DESKTOP_PROFILE, desktopProfileDir } from './profile';
// companion-sync / updater / shortcut-maintenance 尚未类型化（Wave 2/3 收编）。
const updater = require('../../updater') as {
  loadSettings(c: ReturnType<typeof updCtx>): ShortcutSettings;
  saveSettings(c: ReturnType<typeof updCtx>, s: ShortcutSettings): void;
};
const {
  STANDARD_SHORTCUT_NAME,
  RUNTIME_SHORTCUT_DESCRIPTION,
  shortcutTargetsApp,
  desktopShortcutDirs,
  classifyManagedShortcut,
  planDesktopShortcutMaintenance,
} = require('../../shortcut-maintenance') as {
  STANDARD_SHORTCUT_NAME: string;
  RUNTIME_SHORTCUT_DESCRIPTION: string;
  shortcutTargetsApp(link: LnkLink | null, target: string, previousTarget?: string | null): boolean;
  desktopShortcutDirs(userDesktop: string, pub: string | undefined): { scope: string; dir: string }[];
  classifyManagedShortcut(entry: DesktopEntry, o: Record<string, unknown>): string;
  planDesktopShortcutMaintenance(o: Record<string, unknown>): { removals: string[]; create: boolean };
};
const { COMPANION_PLUGINS, readJsonFile } = require('./companion-sync') as {
  COMPANION_PLUGINS: { id: string; name: string; disabled?: boolean; config?: unknown }[];
  readJsonFile(file: string): Record<string, unknown> | null;
};

const IS_WIN = process.platform === 'win32';

interface LnkLink { target?: string; icon?: string; [k: string]: unknown }
interface DesktopEntry { scope: string; dir: string; filePath: string; link: LnkLink | null }
interface ShortcutSettings extends Record<string, unknown> {
  shortcutPolicy?: 'auto' | 'never' | string;
  shortcutTarget?: string;
  shortcutIcon?: string;
  desktopProfileMigrated?: string;
  shareWebProfile?: boolean;
  legacySkinChoice?: string;
}

/** 注入接口：由宿主提供。links 是 .lnk 读写驱动（Electron=shell 快捷方式 API；
 * Tauri=Rust LinkDriver），read 返回链接描述对象或抛错，write(path, op, opts)
 * 失败时抛错。 */
export interface ShortcutsCtx {
  log(tag: string, msg: string): void;
  showBox(opts: Record<string, unknown>): Promise<{ response: number }>;
  getUserDataDir(): string;
  getDshHome(): string | null;
  isPackaged?(): boolean;
  systemPath?(kind: 'appData' | 'desktop'): string;
  links: {
    read(p: string): LnkLink;
    write(p: string, op: 'create' | 'replace' | 'update', opts: Record<string, unknown>): void;
  };
}

let ctx!: ShortcutsCtx;
export function init(d: ShortcutsCtx): void { ctx = d; }
function isPackaged(): boolean {
  return typeof ctx.isPackaged === 'function' ? !!ctx.isPackaged() : false;
}
function systemPath(kind: 'appData' | 'desktop'): string {
  return typeof ctx.systemPath === 'function' ? ctx.systemPath(kind) : '';
}

// 图标设计版本：更换图标时 +1，触发所有快捷方式图标刷新。
export const SHORTCUT_ICON_VERSION = 'whale-2';

export function shortcutIconPath(): string {
  // 复制到 userData 保证路径稳定（便携版 exe 解压目录每次启动都会变）。
  const ico = path.join(ctx.getUserDataDir(), 'icon.ico');
  try {
    const src = path.join(APP_ROOT, 'assets', 'icon.ico');
    if (!fs.existsSync(src)) return '';
    if (!fs.existsSync(ico) || fs.statSync(src).size !== fs.statSync(ico).size) {
      fs.copyFileSync(src, ico);
    }
    return ico;
  } catch (err) {
    ctx.log('boot', '复制快捷方式图标失败: ' + (err as Error).message);
    return path.join(APP_ROOT, 'assets', 'icon.ico');
  }
}

// V4 修复「更换快捷方式图标后重启又多出一个快捷方式」：
//   1. 按「.lnk 的 target 是否指向本应用 exe」识别既有快捷方式（任意
//      文件名都算）—— 只要桌面上存在一个指向我们的 .lnk 就不再新建；
//   2. 图标刷新只在 .lnk 的 icon 仍指向我们自管的 icon.ico（即用户没有
//      自定义图标）时进行，用户自定义图标绝不覆盖；
//   3. settings.shortcutPolicy = 'never' 时完全不碰桌面快捷方式（⋯ 菜
//      单可切换），开始菜单快捷方式仍维护（系统通知的前置条件）。
function listLnkFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.lnk'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function readLnkSafe(p: string): LnkLink | null {
  try { return ctx.links.read(p); } catch { return null; }
}

function lnkTargetsApp(lnkPath: string, target: string): boolean {
  return shortcutTargetsApp(readLnkSafe(lnkPath), target);
}

function lnkUsesManagedIcon(lnkPath: string, ico: string): boolean {
  if (!ico) return false;
  const link = readLnkSafe(lnkPath);
  if (!link) return false;
  // 无自定义图标（icon 为空，用 target 自带）视为可接管。
  if (!link.icon) return true;
  return path.resolve(String(link.icon)).toLowerCase() === path.resolve(ico).toLowerCase();
}

function collectDesktopShortcutEntries(dirs: { scope: string; dir: string }[]): DesktopEntry[] {
  const rows: DesktopEntry[] = [];
  for (const { scope, dir } of dirs) {
    for (const filePath of listLnkFiles(dir)) {
      rows.push({ scope, dir, filePath, link: readLnkSafe(filePath) });
    }
  }
  return rows;
}

export function maintainShortcuts(): void {
  if (!isPackaged() || !IS_WIN) return;
  // E2E / 自动化：跳过快捷方式维护（临时 exe 不得改写真实开始菜单/桌面
  // 快捷方式的指向）。与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同一约定。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const settings = updater.loadSettings(updCtx());
    const policy = settings.shortcutPolicy === 'never' ? 'never' : 'auto';
    const linksDir = path.join(systemPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const APP_TITLE = 'Deepseek Harness EAC';
    const userDesktopDir = systemPath('desktop');
    const desktopDirs = desktopShortcutDirs(userDesktopDir, process.env.PUBLIC);
    const startMenu = path.join(linksDir, APP_TITLE + '.lnk');
    const desktop = path.join(userDesktopDir, STANDARD_SHORTCUT_NAME);
    const ico = shortcutIconPath();
    const opts: Record<string, unknown> = {
      target,
      description: RUNTIME_SHORTCUT_DESCRIPTION,
      ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      appUserModelId: 'com.deepseek.dsh.desktop',
    };
    const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
    let changed = false;
    // 清理旧名称（DSH Desktop）快捷方式：改名后它们指向的 exe 已不存在。
    const legacyShortcuts = [path.join(linksDir, 'DSH Desktop.lnk')];
    for (const { dir } of desktopDirs) legacyShortcuts.push(path.join(dir, 'DSH Desktop.lnk'));
    for (const legacy of legacyShortcuts) {
      try { if (fs.existsSync(legacy)) { fs.rmSync(legacy); changed = true; } } catch { /* 尽力清理 */ }
    }
    let desktopEntries = collectDesktopShortcutEntries(desktopDirs);
    // exe 被移动过或图标设计更新：开始菜单照常维护；桌面仅刷新便携版
    // 运行时原样生成的快捷方式。安装版桌面快捷方式统一交给 NSIS，用户
    // 改名/换图标/加参数后的快捷方式也不再覆盖。
    const targetMoved = settings.shortcutTarget && settings.shortcutTarget !== target;
    const iconOutdated = settings.shortcutIcon !== SHORTCUT_ICON_VERSION;
    if (targetMoved || iconOutdated) {
      const startMenuOwn = fs.existsSync(startMenu)
        && shortcutTargetsApp(readLnkSafe(startMenu), target, targetMoved ? settings.shortcutTarget : null);
      if (startMenuOwn && (targetMoved || lnkUsesManagedIcon(startMenu, ico))) {
        try { ctx.links.write(startMenu, 'replace', opts); changed = true; } catch { /* 尽力维护 */ }
      }
      if (portable && policy !== 'never') {
        let desktopRefreshed = false;
        for (const entry of desktopEntries) {
          const kind = classifyManagedShortcut(entry, {
            target,
            previousTarget: targetMoved ? settings.shortcutTarget : null,
            managedIcon: ico,
          });
          if (kind !== 'runtime') continue;
          try {
            ctx.links.write(entry.filePath, 'replace', opts);
            changed = true;
            desktopRefreshed = true;
          } catch { /* 尽力维护 */ }
        }
        if (desktopRefreshed) desktopEntries = collectDesktopShortcutEntries(desktopDirs);
      }
    }
    // 开始菜单快捷方式：系统通知（Toast）的前置条件，按 target 匹配维护。
    const startMenuOk = fs.existsSync(startMenu) && lnkTargetsApp(startMenu, target);
    if (!startMenuOk) {
      try { ctx.links.write(startMenu, 'create', opts); changed = true; } catch { /* 尽力维护 */ }
    }
    // 桌面快捷方式采用单一创建者：安装版只由 NSIS 创建，便携版才由
    // 运行时创建。扫描个人桌面 + 公共桌面，旧版留下的重复项只删除可
    // 明确识别为软件原样生成的 .lnk；用户改名/换图标/加参数的一律保留。
    const desktopPlan = planDesktopShortcutMaintenance({
      entries: desktopEntries,
      target,
      previousTarget: targetMoved ? settings.shortcutTarget : null,
      managedIcon: ico,
      portable,
      policy,
    });
    for (const duplicate of desktopPlan.removals) {
      try {
        fs.rmSync(duplicate);
        changed = true;
        ctx.log('boot', '已清理软件生成的重复桌面快捷方式: ' + duplicate);
      } catch (err) {
        ctx.log('boot', '清理重复桌面快捷方式失败（已保留）: ' + duplicate + ': ' + (err as Error).message);
      }
    }
    if (desktopPlan.create) {
      try { ctx.links.write(desktop, 'create', opts); changed = true; } catch { /* 尽力维护 */ }
    }
    if (changed) {
      settings.shortcutTarget = target;
      settings.shortcutIcon = SHORTCUT_ICON_VERSION;
      updater.saveSettings(updCtx(), settings);
      ctx.log('boot', '快捷方式已维护（开始菜单/桌面 → ' + target + '，图标 ' + SHORTCUT_ICON_VERSION + '）');
    }
  } catch (err) {
    ctx.log('boot', '快捷方式维护失败: ' + (err as Error).message);
  }
}

export function warnTempRun(): void {
  if (!isPackaged() || !IS_WIN || !process.env.PORTABLE_EXECUTABLE_DIR) return;
  // E2E（scripts/e2e-v4.js）从临时目录跑便携版：告警弹窗会卡住无头验证。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  const dir = process.env.PORTABLE_EXECUTABLE_DIR.toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  if (dir === tmp || dir.startsWith(tmp + path.sep)) {
    ctx.showBox({
      type: 'warning',
      title: '正在从临时目录运行',
      message: '当前便携版位于系统临时目录。',
      detail: '临时目录中的文件可能被系统自动清理，导致快捷方式失效或程序“消失”。\n建议把 Deepseek Harness EAC exe 移动到固定位置（如桌面或 D 盘）后再运行。',
      buttons: ['知道了'],
    });
  }
}

// ---------------------------------------------------------------------------
// 一次性迁移：桌面端从共享 web profile 切到专属 web-desktop profile。
//
// 只做三件事，全部幂等：
//   1. 记住用户在旧 profile 里启用的皮肤（迁移后在专属 profile 里复活）；
//   2. 清掉旧 web profile 里桌面端写入的配套插件行 + 拷贝的配套包 + 内置
//      清单标记 —— 原生 CLI 从此加载干净的 web profile（冲突面消除）；
//   3. 标记 settings.desktopProfileMigrated，永不重复执行。
// 用户用市场装进旧 profile 的插件（package.json bundles）是原生端资产，
// 一律不动；桌面端如需继续使用，重新从市场安装即可（有保护中心兜底）。
export function migrateFromSharedWebProfile(): void {
  try {
    const s = updater.loadSettings(updCtx());
    if (s.desktopProfileMigrated) return;
    s.desktopProfileMigrated = new Date().toISOString();
    updater.saveSettings(updCtx(), s); // 先落标记：即使下面失败也不反复折腾
    if (s.shareWebProfile === true) return; // 用户显式选择共享模式

    const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
    const oldDir = path.join(home, 'profiles', 'web');
    const marker = path.join(oldDir, '.dsh-builtin-plugins.json');
    if (!fs.existsSync(marker)) return; // 旧版本从没在共享 profile 跑过桌面端
    const builtinNames = ((readJsonFile(marker)?.names as unknown[]) || []) as string[];

    // 1) 提取用户启用的皮肤行 id。
    let enabledSkin: string | null = null;
    const patchFile = path.join(oldDir, 'cordis.patch.yml');
    let oldPatch = '';
    try { oldPatch = fs.readFileSync(patchFile, 'utf8'); } catch { oldPatch = ''; }
    {
      const lines = oldPatch.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^- id: (ui-skin-[\w-]+)\s*$/.exec(lines[i]);
        if (!m) continue;
        let disabled = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^- /.test(lines[j])) break;
          if (/^\s+disabled:\s*true/.test(lines[j])) disabled = true;
        }
        if (!disabled) enabledSkin = m[1];
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
      try { fs.rmSync(path.join(oldDir, 'node_modules', ...String(name).split('/')), { recursive: true, force: true, maxRetries: 2 }); } catch { /* 尽力清理 */ }
    }
    try { fs.rmSync(marker, { force: true }); } catch { /* 尽力清理 */ }
    ctx.log('boot', '已迁移到桌面专属 profile（' + DESKTOP_PROFILE + '）：旧 web profile 清理了 ' + cleaned.removed.length + ' 条桌面配套行 / ' + builtinNames.length + ' 个配套包');

    // 3) 在专属 profile 里复活用户选择的皮肤（等 syncCompanionPlugins 写完
    //    全部皮肤行之后执行，见 applyLegacySkinChoice）。
    if (enabledSkin) {
      const s2 = updater.loadSettings(updCtx());
      s2.legacySkinChoice = enabledSkin;
      updater.saveSettings(updCtx(), s2);
      ctx.log('boot', '将迁移用户皮肤选择: ' + enabledSkin);
    }
  } catch (err) {
    ctx.log('boot', '共享 profile 迁移失败（不影响启动）: ' + (err as Error).message);
  }
}

export function extractPatchRowIds(patch: unknown): string[] {
  const ids: string[] = [];
  const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(patch || ''))) !== null) ids.push(m[1]);
  return ids;
}

// 按 id 集合删除 patch 里的 insert 行块（与 removeBundledRowDuplicates 同
// 语法约定：id 紧跟 `- insert:` 之后）。
export function removePatchRowsById(patch: unknown, ids: Set<string>): { patch: string; removed: string[] } {
  const removed: string[] = [];
  if (typeof patch !== 'string' || patch === '' || !ids || ids.size === 0) return { patch: String(patch ?? ''), removed };
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s*insert:/.test(line)) {
      const mid = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(lines[i + 1] || '');
      if (mid && ids.has(mid[1])) {
        removed.push(mid[1]);
        let j = i + 1;
        while (j < lines.length && !/^-\s*insert:/.test(lines[j]) && /^#/.test(lines[j]) === false && /^\s+\S/.test(lines[j])) j++;
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

// syncCompanionPlugins 之后调用一次：把迁移带来的皮肤选择落到新 profile。
export function applyLegacySkinChoice(): void {
  try {
    const s = updater.loadSettings(updCtx());
    const skin = s.legacySkinChoice;
    if (!skin || !/^ui-skin-[\w-]+$/.test(skin)) return;
    const patchFile = path.join(desktopProfileDir(), 'cordis.patch.yml');
    if (!fs.existsSync(patchFile)) return;
    const text = fs.readFileSync(patchFile, 'utf8');
    const re = new RegExp('(- id: ' + skin + '\\b[^\\n]*\\n(?:      [^\\n]*\\n)*?)      disabled: true\\n');
    const next = text.replace(re, '$1');
    if (next !== text) {
      fs.writeFileSync(patchFile, next);
      ctx.log('boot', '已在专属 profile 启用迁移的皮肤: ' + skin);
    }
    delete s.legacySkinChoice;
    updater.saveSettings(updCtx(), s);
  } catch (err) {
    ctx.log('boot', '应用迁移皮肤选择失败: ' + (err as Error).message);
  }
}

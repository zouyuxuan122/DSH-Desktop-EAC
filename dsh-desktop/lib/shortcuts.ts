/**
 * lib/shortcuts.ts — 快捷方式维护（Task 5b 自 main.js 提取）。
 *
 * 修复「没有桌面快捷方式 / 快捷方式指向的文件消失」，并让图标跟随设计
 * 更新（.lnk 单独指定 icon.ico）。V4 修复「换图标后重启又多出一个快捷
 * 方式」：按 target 归属识别既有 .lnk（任意文件名），只在确属本应用且
 * 用户未自定义图标时刷新；settings.shortcutPolicy='never' 完全不碰桌面。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, shell } from 'electron';
import * as updater from '../updater.js';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN, updCtx } from './proc.js';

/** 图标设计版本：更换图标时 +1，触发所有快捷方式图标刷新。 */
export const SHORTCUT_ICON_VERSION = 'whale-2';

/** 快捷方式目标/图标选项（shell.writeShortcutLink 入参）。 */
interface ShortcutOpts {
  target: string;
  description: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId: string;
}

function shortcutIconPath(): string {
  // 复制到 userData 保证路径稳定（便携版 exe 解压目录每次启动都会变）。
  const ico = path.join(state.userDataDir, 'icon.ico');
  try {
    const src = path.join(__dirname, '..', 'assets', 'icon.ico');
    if (!fs.existsSync(src)) return '';
    if (!fs.existsSync(ico) || fs.statSync(src).size !== fs.statSync(ico).size) {
      fs.copyFileSync(src, ico);
    }
    return ico;
  } catch (err) {
    log('boot', '复制快捷方式图标失败: ' + String((err as Error).message));
    return path.join(__dirname, '..', 'assets', 'icon.ico');
  }
}

/** 列目录下全部 .lnk 文件路径。 */
function listLnkFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.lnk'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** 安全读 .lnk（损坏返回 null）。 */
function readLnkSafe(p: string): { target?: string; icon?: string } | null {
  try {
    return shell.readShortcutLink(p) as { target?: string; icon?: string };
  } catch {
    return null;
  }
}

/** .lnk 的 target 是否指向本应用 exe（大小写不敏感）。 */
function lnkTargetsApp(lnkPath: string, target: string): boolean {
  const link = readLnkSafe(lnkPath);
  if (!link || !link.target) return false;
  return path.resolve(String(link.target)).toLowerCase() === path.resolve(target).toLowerCase();
}

/** .lnk 是否使用我们自管的图标（无自定义图标也视为可接管）。 */
function lnkUsesManagedIcon(lnkPath: string, ico: string): boolean {
  if (!ico) return false;
  const link = readLnkSafe(lnkPath);
  if (!link) return false;
  // 无自定义图标（icon 为空，用 target 自带）视为可接管。
  if (!link.icon) return true;
  return path.resolve(String(link.icon)).toLowerCase() === path.resolve(ico).toLowerCase();
}

/**
 * 开始菜单/桌面快捷方式维护（仅打包版 Windows；幂等）：清理旧名称残留、
 * 按设置策略（auto/never）创建缺失链接、把指向旧 exe 的链接改指当前安装
 * 位置。E2E 环境用 DSH_DESKTOP_TEST_NO_SHORTCUTS=1 跳过。
 */
export function maintainShortcuts(): void {
  if (!app.isPackaged || !IS_WIN) return;
  // E2E / 自动化：跳过快捷方式维护（临时 exe 不得改写真实开始菜单/桌面
  // 快捷方式的指向）。与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同一约定。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const settings = updater.loadSettings(updCtx());
    const policy = settings.shortcutPolicy === 'never' ? 'never' : 'auto';
    const linksDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const APP_TITLE = 'Deepseek Harness EAC';
    const desktopDir = app.getPath('desktop');
    const startMenu = path.join(linksDir, APP_TITLE + '.lnk');
    const desktop = path.join(desktopDir, APP_TITLE + '.lnk');
    const ico = shortcutIconPath();
    const opts: ShortcutOpts = {
      target,
      description: 'DeepSeek Harness 桌面客户端',
      ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      appUserModelId: 'com.deepseek.dsh.desktop',
    };
    let changed = false;
    // 清理旧名称（DSH Desktop）快捷方式：改名后它们指向的 exe 已不存在。
    for (const legacy of [
      path.join(linksDir, 'DSH Desktop.lnk'),
      path.join(desktopDir, 'DSH Desktop.lnk'),
    ]) {
      try {
        if (fs.existsSync(legacy)) {
          fs.rmSync(legacy);
          changed = true;
        }
      } catch {
        /* 单文件删除失败继续 */
      }
    }
    // exe 被移动过或图标设计更新：只刷新「确认属于本应用」的快捷方式。
    // 归属判定：target 指向当前 exe，或指向上次记录的 exe 位置（搬家后
    // 的旧快捷方式）；指向其它程序的 .lnk 绝不动。
    const targetMoved =
      typeof settings.shortcutTarget === 'string' && settings.shortcutTarget !== target;
    const iconOutdated = settings.shortcutIcon !== SHORTCUT_ICON_VERSION;
    if (targetMoved || iconOutdated) {
      const prevTarget = typeof settings.shortcutTarget === 'string' ? settings.shortcutTarget : '';
      const isOurs = (p: string): boolean =>
        fs.existsSync(p) && (lnkTargetsApp(p, target) || (targetMoved && lnkTargetsApp(p, prevTarget)));
      const candidates = [startMenu].concat(policy === 'never' ? [] : listLnkFiles(desktopDir));
      for (const p of candidates) {
        if (!isOurs(p)) continue;
        // 仅图标过时且用户自定义了图标：尊重用户选择，跳过；target 移动
        // 时即使图标被自定义也要修指向（否则快捷方式失效）。
        if (!targetMoved && !lnkUsesManagedIcon(p, ico)) continue;
        try {
          shell.writeShortcutLink(p, 'replace', opts);
          changed = true;
        } catch {
          /* 单链接写失败继续 */
        }
      }
    }
    // 开始菜单快捷方式：系统通知（Toast）的前置条件，按 target 匹配维护。
    const startMenuOk = fs.existsSync(startMenu) && lnkTargetsApp(startMenu, target);
    if (!startMenuOk) {
      try {
        shell.writeShortcutLink(startMenu, 'create', opts);
        changed = true;
      } catch {
        /* 创建失败不阻塞启动 */
      }
    }
    // 桌面快捷方式：policy=never 不创建；已有任意名称指向本应用的 .lnk
    // （用户自定义/改名/换图标后的产物）即视为存在，绝不重复新建。
    if (policy !== 'never' && !fs.existsSync(desktop)) {
      const hasOursOnDesktop = listLnkFiles(desktopDir).some((p) => lnkTargetsApp(p, target));
      if (!hasOursOnDesktop) {
        try {
          shell.writeShortcutLink(desktop, 'create', opts);
          changed = true;
        } catch {
          /* 创建失败不阻塞启动 */
        }
      } else {
        log('boot', '检测到用户自定义的桌面快捷方式（指向本应用），不再重复创建');
      }
    }
    if (changed) {
      settings.shortcutTarget = target;
      settings.shortcutIcon = SHORTCUT_ICON_VERSION;
      updater.saveSettings(updCtx(), settings);
      log('boot', '快捷方式已维护（开始菜单/桌面 → ' + target + '，图标 ' + SHORTCUT_ICON_VERSION + '）');
    }
  } catch (err) {
    log('boot', '快捷方式维护失败: ' + String((err as Error).message));
  }
}

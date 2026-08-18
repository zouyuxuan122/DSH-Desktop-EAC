'use strict';

// Windows 快捷方式维护（architecture-refactor-plan.md Phase 1：platform/ 领域）。
//
// 从 main.js 原样迁出：
//   1. maintainShortcuts —— 修复「没有桌面快捷方式 / 快捷方式指向的文件消失」，
//      并让快捷方式图标跟随图标设计版本刷新（.lnk 单独指定 icon.ico）；
//      按 target 归属识别既有 .lnk（任意文件名），用户自定义图标绝不覆盖；
//      settings.shortcutPolicy = 'never' 时不碰桌面快捷方式；
//   2. shortcutIconPath —— 图标复制到 userData（便携版 exe 解压目录每次启动
//      都会变，必须用稳定路径）；
//   3. warnTempRun —— 便携版从系统临时目录运行时的告警。
// 平台差异：仅 Windows（isWin）；shell / app 为 Electron 能力，依赖注入。
// __dirname 位于 platform/ 子目录，应用根目录资源需上溯一层（../assets）。

/**
 * .lnk 解析结果（shell.readShortcutLink 返回形状）。
 * @typedef {{ target?: string, icon?: string }} ShortcutLink
 */

/**
 * @typedef {object} ShortcutManagerDeps
 * @property {{ isPackaged: boolean, getPath(name: string): string }} app
 * @property {{
 *   readShortcutLink(p: string): { target?: string, icon?: string } | null,
 *   writeShortcutLink(p: string, mode: string, opts: object): void,
 * }} shell
 * @property {typeof import('node:path')} path
 * @property {typeof import('node:fs')} fs
 * @property {typeof import('node:os')} os
 * @property {boolean} isWin
 * @property {() => string} getUserDataDir
 * @property {(ctx: object) => { shortcutPolicy?: string, shortcutTarget?: string, shortcutIcon?: string }} loadSettings
 * @property {(ctx: object, s: object) => boolean} saveSettings
 * @property {() => object} updCtx
 * @property {(opts: object) => Promise<{ response: number }>} showBox
 * @property {(tag: string, msg: string) => void} log
 */

/**
 * @param {ShortcutManagerDeps} deps
 */
function createShortcutManager(deps) {
  const {
    app, shell, path, fs, os,
    isWin,
    getUserDataDir,
    loadSettings, saveSettings, updCtx,
    showBox, log,
  } = deps;

const SHORTCUT_ICON_VERSION = 'whale-2';

/** @returns {string} */
function shortcutIconPath() {
  // 复制到 userData 保证路径稳定（便携版 exe 解压目录每次启动都会变）。
  const ico = path.join(getUserDataDir(), 'icon.ico');
  try {
    const src = path.join(__dirname, '..', 'assets', 'icon.ico');
    if (!fs.existsSync(src)) return '';
    if (!fs.existsSync(ico) || fs.statSync(src).size !== fs.statSync(ico).size) {
      fs.copyFileSync(src, ico);
    }
    return ico;
  } catch (err) {
    log('boot', '复制快捷方式图标失败: ' + (/** @type {Error} */ (err)).message);
    return path.join(__dirname, '..', 'assets', 'icon.ico');
  }
}

// V4 修复「更换快捷方式图标后重启又多出一个快捷方式」：
//   旧逻辑只认「桌面\Deepseek Harness EAC.lnk」这个精确文件名。用户换
//   图标时通常删掉旧 .lnk 自建一个新的（名字几乎必然不同），下次启动
//   existsSync 判定缺失 → 再造一个标准名快捷方式 → 桌面上出现两个。
//   且图标版本分支会无条件 replace，把用户自定义图标静默还原成默认。
// 新逻辑：
//   1. 按「.lnk 的 target 是否指向本应用 exe」识别既有快捷方式（任意
//      文件名都算）—— 只要桌面上存在一个指向我们的 .lnk 就不再新建；
//   2. 图标刷新只在 .lnk 的 icon 仍指向我们自管的 icon.ico（即用户没有
//      自定义图标）时进行，用户自定义图标绝不覆盖；
//   3. settings.shortcutPolicy = 'never' 时完全不碰桌面快捷方式（⋯ 菜
//      单可切换），开始菜单快捷方式仍维护（系统通知的前置条件）。
/** @param {string} dir @returns {string[]} */
function listLnkFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.lnk'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

/** @param {string} p @returns {ShortcutLink | null} */
function readLnkSafe(p) {
  try { return shell.readShortcutLink(p); } catch { return null; }
}

/** @param {string} lnkPath @param {string} target @returns {boolean} */
function lnkTargetsApp(lnkPath, target) {
  const link = readLnkSafe(lnkPath);
  if (!link || !link.target) return false;
  return path.resolve(String(link.target)).toLowerCase() === path.resolve(target).toLowerCase();
}

/** @param {string} lnkPath @param {string} ico @returns {boolean} */
function lnkUsesManagedIcon(lnkPath, ico) {
  if (!ico) return false;
  const link = readLnkSafe(lnkPath);
  if (!link) return false;
  // 无自定义图标（icon 为空，用 target 自带）视为可接管。
  if (!link.icon) return true;
  return path.resolve(String(link.icon)).toLowerCase() === path.resolve(ico).toLowerCase();
}

/** @returns {void} */
function maintainShortcuts() {
  if (!app.isPackaged || !isWin) return;
  // E2E / 自动化：跳过快捷方式维护（临时 exe 不得改写真实开始菜单/桌面
  // 快捷方式的指向）。与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同一约定。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const settings = loadSettings(updCtx());
    const policy = settings.shortcutPolicy === 'never' ? 'never' : 'auto';
    const linksDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const APP_TITLE = 'Deepseek Harness EAC';
    const desktopDir = app.getPath('desktop');
    const startMenu = path.join(linksDir, APP_TITLE + '.lnk');
    const desktop = path.join(desktopDir, APP_TITLE + '.lnk');
    const ico = shortcutIconPath();
    const opts = {
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
      try { if (fs.existsSync(legacy)) { fs.rmSync(legacy); changed = true; } }
      catch (err) { log('shortcut', '清理旧快捷方式失败 ' + legacy + ': ' + (/** @type {Error} */ (err)).message); }
    }
    // exe 被移动过或图标设计更新：只刷新「确认属于本应用」的快捷方式。
    // 归属判定：target 指向当前 exe，或指向上次记录的 exe 位置（搬家后
    // 的旧快捷方式）；指向其它程序的 .lnk 绝不动。
    const targetMoved = settings.shortcutTarget && settings.shortcutTarget !== target;
    const iconOutdated = settings.shortcutIcon !== SHORTCUT_ICON_VERSION;
    if (targetMoved || iconOutdated) {
      const isOurs = (/** @type {string} */ p) => fs.existsSync(p)
        && (lnkTargetsApp(p, target) || (targetMoved && lnkTargetsApp(p, settings.shortcutTarget ?? '')));
      const candidates = [startMenu].concat(policy === 'never' ? [] : listLnkFiles(desktopDir));
      for (const p of candidates) {
        if (!isOurs(p)) continue;
        // 仅图标过时且用户自定义了图标：尊重用户选择，跳过；target 移动
        // 时即使图标被自定义也要修指向（否则快捷方式失效）。
        if (!targetMoved && !lnkUsesManagedIcon(p, ico)) continue;
        try { shell.writeShortcutLink(p, 'replace', opts); changed = true; } catch {}
      }
    }
    // 开始菜单快捷方式：系统通知（Toast）的前置条件，按 target 匹配维护。
    const startMenuOk = fs.existsSync(startMenu) && lnkTargetsApp(startMenu, target);
    if (!startMenuOk) {
      try { shell.writeShortcutLink(startMenu, 'create', opts); changed = true; } catch {}
    }
    // 桌面快捷方式：policy=never 不创建；已有任意名称指向本应用的 .lnk
    // （用户自定义/改名/换图标后的产物）即视为存在，绝不重复新建。
    if (policy !== 'never' && !fs.existsSync(desktop)) {
      const hasOursOnDesktop = listLnkFiles(desktopDir).some((p) => lnkTargetsApp(p, target));
      if (!hasOursOnDesktop) {
        try { shell.writeShortcutLink(desktop, 'create', opts); changed = true; } catch {}
      } else {
        log('boot', '检测到用户自定义的桌面快捷方式（指向本应用），不再重复创建');
      }
    }
    if (changed) {
      settings.shortcutTarget = target;
      settings.shortcutIcon = SHORTCUT_ICON_VERSION;
      saveSettings(updCtx(), settings);
      log('boot', '快捷方式已维护（开始菜单/桌面 → ' + target + '，图标 ' + SHORTCUT_ICON_VERSION + '）');
    }
  } catch (err) {
    log('boot', '快捷方式维护失败: ' + (/** @type {Error} */ (err)).message);
  }
}

/** @returns {void} */
function warnTempRun() {
  if (!app.isPackaged || !isWin || !process.env.PORTABLE_EXECUTABLE_DIR) return;
  // E2E（scripts/e2e-v4.js）从临时目录跑便携版：告警弹窗会卡住无头验证。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  const dir = process.env.PORTABLE_EXECUTABLE_DIR.toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  if (dir === tmp || dir.startsWith(tmp + path.sep)) {
    showBox({
      type: 'warning',
      title: '正在从临时目录运行',
      message: '当前便携版位于系统临时目录。',
      detail: '临时目录中的文件可能被系统自动清理，导致快捷方式失效或程序“消失”。\n建议把 Deepseek Harness EAC exe 移动到固定位置（如桌面或 D 盘）后再运行。',
      buttons: ['知道了'],
    });
  }
}
  return {
    shortcutIconPath,
    maintainShortcuts,
    warnTempRun,
    listLnkFiles,
    lnkTargetsApp,
    lnkUsesManagedIcon,
  };
}

module.exports = { createShortcutManager };

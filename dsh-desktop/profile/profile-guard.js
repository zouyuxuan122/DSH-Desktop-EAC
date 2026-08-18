'use strict';

// profile 守卫域（architecture-refactor-plan.md Phase 1：profile/ 领域）。
//
//   1. migrateFromSharedWebProfile —— 一次性迁移：桌面端从共享 web profile
//      切到专属 web-desktop（全部幂等，settings.desktopProfileMigrated 标记，
//      永不重复执行）；旧 profile 里的桌面配套行/包/内置清单被清理，原生 CLI
//      从此加载干净的 web profile；
//   2. applyLegacySkinChoice —— 迁移记录的皮肤选择在 syncCompanionPlugins
//      写完皮肤行之后落位（去掉 disabled）；
//   3. startJunctionWatchdog —— junction 归属周期巡检（仅 Windows）：原生
//      dsh 改写的共享模块指向在外部 dsh 进程退出后自动修复回客户端闭包；
//   4. detectExternalDsh —— 检测本机其它 dsh 进程（Windows CIM 查询，失败
//      按「无外部进程」处理，宁可漏报）。
//
// 依赖注入：可变状态（dshHome / quitting / restartingServer / serverProc）
// 经 getter 调用期取值；isWin 为稳定布尔；execSync 可注入（默认真实）；
// __dirname 位于 profile/ 子目录，应用根目录资源需上溯一层（../assets）。

/**
 * @typedef {object} ProfileGuardDeps
 * @property {boolean} isWin
 * @property {() => string} getDshHome
 * @property {() => boolean} getQuitting
 * @property {() => boolean} getRestartingServer
 * @property {() => import('node:child_process').ChildProcess | null} getServerProc
 * @property {() => { junctionFindings(): unknown[], repairJunctions(): { repaired: unknown[] } }} ensureGuard
 * @property {() => void} showMainWindow
 * @property {{ new (opts: object): { on(event: string, cb: () => void): object, show(): void } }} Notification
 * @property {{ loadSettings(ctx: object): { desktopProfileMigrated?: string, shareWebProfile?: boolean, legacySkinChoice?: string }, saveSettings(ctx: object, s: object): boolean }} updater
 * @property {() => object} updCtx
 * @property {() => string} desktopProfileDir
 * @property {(file: string) => any} readJsonFile
 * @property {(dir: string) => { plugins: Record<string, { state?: string } | undefined> }} loadBuiltinPluginState
 * @property {(dir: string, id: string, state: string) => void} setBuiltinPluginState
 * @property {string} DESKTOP_PROFILE
 * @property {Array<{ id: string }>} COMPANION_PLUGINS
 * @property {typeof import('node:fs')} fs
 * @property {typeof import('node:path')} path
 * @property {typeof import('node:os')} os
 * @property {(tag: string, msg: string) => void} log
 * @property {(cmd: string, opts: object) => string} [execSyncImpl]
 */

/**
 * @param {ProfileGuardDeps} deps
 */
function createProfileGuard(deps) {
  const {
    isWin,
    getDshHome, getQuitting, getRestartingServer, getServerProc,
    ensureGuard, showMainWindow, Notification,
    updater, updCtx, desktopProfileDir,
    readJsonFile, loadBuiltinPluginState, setBuiltinPluginState,
    DESKTOP_PROFILE, COMPANION_PLUGINS,
    fs, path, os, log,
    execSyncImpl = require('node:child_process').execSync,
  } = deps;


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
function migrateFromSharedWebProfile() {
  try {
    const s = updater.loadSettings(updCtx());
    if (s.desktopProfileMigrated) return;
    s.desktopProfileMigrated = new Date().toISOString();
    updater.saveSettings(updCtx(), s); // 先落标记：即使下面失败也不反复折腾
    if (s.shareWebProfile === true) return; // 用户显式选择共享模式

    const home = getDshHome() || path.join(os.homedir(), '.dsh');
    const oldDir = path.join(home, 'profiles', 'web');
    const marker = path.join(oldDir, '.dsh-builtin-plugins.json');
    if (!fs.existsSync(marker)) return; // 旧版本从没在共享 profile 跑过桌面端
    const builtinNames = readJsonFile(marker)?.names || [];
    const oldBuiltinState = loadBuiltinPluginState(oldDir);
    const newDir = path.join(home, 'profiles', DESKTOP_PROFILE);
    for (const [id, info] of Object.entries(oldBuiltinState.plugins || {})) {
      if (info && info.state === 'uninstalled') {
        try { setBuiltinPluginState(newDir, id, 'uninstalled'); } catch {}
      }
    }

    // 1) 提取用户启用的皮肤行 id。
    let enabledSkin = null;
    const patchFile = path.join(oldDir, 'cordis.patch.yml');
    let oldPatch = '';
    try { oldPatch = fs.readFileSync(patchFile, 'utf8'); } catch { oldPatch = ''; }
    {
      const lines = oldPatch.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^- id: (ui-skin-[\w-]+)\s*$/.exec(lines[i] ?? '');
        if (!m) continue;
        let disabled = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^- /.test(lines[j] ?? '')) break;
          if (/^\s+disabled:\s*true/.test(lines[j] ?? '')) disabled = true;
        }
        if (!disabled) enabledSkin = m[1] ?? null;
      }
    }

    // 2) 清理旧 profile 的桌面端痕迹。
    const rowIdSet = new Set();
    for (const p of COMPANION_PLUGINS) rowIdSet.add(p.id);
    for (const id of extractPatchRowIds(oldPatch)) {
      if (/^ui-skin-[\w-]+$/.test(id)) rowIdSet.add(id);
    }
    const cleaned = removePatchRowsById(oldPatch, rowIdSet);
    if (cleaned.removed.length) fs.writeFileSync(patchFile, cleaned.patch);
    for (const name of builtinNames) {
      try { fs.rmSync(path.join(oldDir, 'node_modules', ...String(name).split('/')), { recursive: true, force: true, maxRetries: 2 }); } catch {}
    }
    try { fs.rmSync(marker, { force: true }); } catch {}
    log('boot', '已迁移到桌面专属 profile（' + DESKTOP_PROFILE + '）：旧 web profile 清理了 ' + cleaned.removed.length + ' 条桌面配套行 / ' + builtinNames.length + ' 个配套包');

    // 3) 在专属 profile 里复活用户选择的皮肤（等 syncCompanionPlugins 写完
    //    全部皮肤行之后执行，见 applyLegacySkinChoice）。
    if (enabledSkin) {
      const s2 = updater.loadSettings(updCtx());
      s2.legacySkinChoice = enabledSkin;
      updater.saveSettings(updCtx(), s2);
      log('boot', '将迁移用户皮肤选择: ' + enabledSkin);
    }
  } catch (err) {
    log('boot', '共享 profile 迁移失败（不影响启动）: ' + (/** @type {Error} */ (err)).message);
  }
}

/** @param {string} patch @returns {string[]} */
function extractPatchRowIds(patch) {
  /** @type {string[]} */
  const ids = [];
  const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
  let m;
  while ((m = re.exec(String(patch || ''))) !== null) ids.push(m[1] ?? '');
  return ids;
}

// 按 id 集合删除 patch 里的 insert 行块（与 removeBundledRowDuplicates 同
// 语法约定：id 紧跟 `- insert:` 之后）。
/**
 * @param {string} patch
 * @param {Set<string>} ids
 * @returns {{ patch: string, removed: string[] }}
 */
function removePatchRowsById(patch, ids) {
  /** @type {string[]} */
  const removed = [];
  if (typeof patch !== 'string' || patch === '' || !ids || ids.size === 0) return { patch, removed };
  const lines = patch.split(/\r?\n/);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^-\s*insert:/.test(line)) {
      const mid = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(lines[i + 1] ?? '');
      if (mid && ids.has(mid[1] ?? '')) {
        removed.push(mid[1] ?? '');
        let j = i + 1;
        while (j < lines.length && !/^-\s*insert:/.test(lines[j] ?? '') && /^#/.test(lines[j] ?? '') === false && /^\s+\S/.test(lines[j] ?? '')) j++;
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
function applyLegacySkinChoice() {
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
      log('boot', '已在专属 profile 启用迁移的皮肤: ' + skin);
    }
    delete s.legacySkinChoice;
    updater.saveSettings(updCtx(), s);
  } catch (err) {
    log('boot', '应用迁移皮肤选择失败: ' + (/** @type {Error} */ (err)).message);
  }
}

// ---------------------------------------------------------------------------
// junction 归属巡检：原生 dsh（npx / 全局安装）启动时会把 <home>/profiles/
// node_modules 的共享 junction 重新指向它自己的闭包 —— 桌面端正在运行的
// 服务随后解析到错误版本（「设置命名空间不可用」的一大根因），npx 缓存
// 被清理后更是直接悬空。这里周期性检查：发现异动且外部 dsh 进程已退出，
// 就把指向修复回客户端闭包（原生 CLI 重启时会再次指回它自己，互不纠缠：
// 各自启动时各自纠正，运行中互不打扰）。
// ---------------------------------------------------------------------------
function startJunctionWatchdog() {
  if (!isWin) return;
  let notified = false;
  const tick = async () => {
    if (getQuitting() || getRestartingServer()) return;
    try {
      const g = ensureGuard();
      const findings = g.junctionFindings();
      if (findings.length === 0) return;
      const ext = await detectExternalDsh();
      if (ext.running) {
        log('guard', '共享模块被外部 dsh 接管（PID ' + ext.pids.join(', ') + '），待其退出后自动修复');
        return;
      }
      const res = g.repairJunctions();
      if (res.repaired.length && !notified) {
        notified = true;
        try {
          const n = new Notification({
            title: '已自动修复共享模块指向',
            body: '检测到原生 dsh 改写了共享模块目录，桌面端已恢复指向自身版本。原生 CLI 如有异常，重启它即可。',
            icon: path.join(__dirname, '..', 'assets', 'icon.png'),
          });
          n.on('click', () => showMainWindow());
          n.show();
        } catch {}
      }
    } catch { /* 巡检失败静默 */ }
  };
  setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000).unref();
}

// 检测本机是否有其它 dsh 进程在跑（原生 CLI / 另一份安装）。Windows 下用
// CIM 查 node 进程命令行；超时或失败按「无外部进程」处理（宁可漏报）。
function detectExternalDsh() {
  return new Promise((resolve) => {
    if (!isWin) return resolve({ running: false, pids: [] });
    const own = new Set([process.pid]);
    const sp = getServerProc();
    if (sp && sp.pid) own.add(sp.pid);
    let out = '';
    try {
      out = String(execSyncImpl(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\'\'node.exe\'\'\' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
        { encoding: 'utf8', windowsHide: true, timeout: 12000 }));
    } catch {
      return resolve({ running: false, pids: [] });
    }
    try {
      const arr = out.trim() === '' ? [] : JSON.parse(out);
      const list = Array.isArray(arr) ? arr : [arr];
      const pids = [];
      for (const it of list) {
        const pid = Number(it && it.ProcessId);
        const cmd = String((it && it.CommandLine) || '');
        if (!Number.isFinite(pid) || own.has(pid)) continue;
        if (!/dsh|deepseek-ai/i.test(cmd)) continue;
        if (!/(\s|\/|\\)(web|plugin|run|tui)(\s|$)|bin\.(js|ts)/i.test(cmd)) continue;
        pids.push(pid);
      }
      resolve({ running: pids.length > 0, pids });
    } catch {
      resolve({ running: false, pids: [] });
    }
  });
}
  return {
    migrateFromSharedWebProfile,
    applyLegacySkinChoice,
    startJunctionWatchdog,
    detectExternalDsh,
  };
}

module.exports = { createProfileGuard };

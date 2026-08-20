/**
 * lib/migration.ts — 历史迁移与一次性告警（Task 5.3 自 main.js 提取）。
 *
 * migrateFromSharedWebProfile：桌面端从共享 web profile 切到专属
 * web-desktop profile 的一次性迁移（三件事，全部幂等）；applyLegacySkinChoice
 * 在 syncCompanionPlugins 之后落位迁移带来的皮肤选择；warnTempRun：便携版
 * 跑在系统临时目录时的告警。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { app } from 'electron';
import * as updater from '../updater.js';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN, updCtx } from './proc.js';
import { DESKTOP_PROFILE, desktopProfileDir } from './paths.js';
import { COMPANION_PLUGINS } from './plugin-registry-data.js';
import { readJsonFile } from './plugin-copy.js';
import { bridge } from './bridge.js';

/** 便携版跑在系统临时目录时告警（文件可能被系统清理，快捷方式失效）。 */
export function warnTempRun(): void {
  if (!app.isPackaged || !IS_WIN || !process.env.PORTABLE_EXECUTABLE_DIR) return;
  // E2E（scripts/e2e-v4.js）从临时目录跑便携版：告警弹窗会卡住无头验证。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  const dir = process.env.PORTABLE_EXECUTABLE_DIR.toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  if (dir === tmp || dir.startsWith(tmp + path.sep)) {
    void bridge.showBox({
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
// ---------------------------------------------------------------------------
export function migrateFromSharedWebProfile(): void {
  try {
    const s = updater.loadSettings(updCtx());
    if (s.desktopProfileMigrated) return;
    s.desktopProfileMigrated = new Date().toISOString();
    updater.saveSettings(updCtx(), s); // 先落标记：即使下面失败也不反复折腾
    if (s.shareWebProfile === true) return; // 用户显式选择共享模式

    const home = state.dshHome || path.join(os.homedir(), '.dsh');
    const oldDir = path.join(home, 'profiles', 'web');
    const marker = path.join(oldDir, '.dsh-builtin-plugins.json');
    if (!fs.existsSync(marker)) return; // 旧版本从没在共享 profile 跑过桌面端
    const builtinNames =
      ((readJsonFile(marker)?.names as string[] | undefined) ?? []);

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
        const m = /^- id: (ui-skin-[\w-]+)\s*$/.exec(lines[i] ?? '');
        if (!m || !m[1]) continue;
        let disabled = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^- /.test(lines[j] as string)) break;
          if (/^\s+disabled:\s*true/.test(lines[j] as string)) disabled = true;
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
      try {
        fs.rmSync(path.join(oldDir, 'node_modules', ...String(name).split('/')), {
          recursive: true, force: true, maxRetries: 2,
        });
      } catch {
        /* 单包删除失败不阻塞 */
      }
    }
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      /* 标记删除失败：迁移标记已置位，不会重复执行 */
    }
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
    log('boot', '共享 profile 迁移失败（不影响启动）: ' + String((err as Error).message));
  }
}

/** 提取 patch 文本中的全部行 id（`- id: <id>` 形态）。 */
export function extractPatchRowIds(patch: string): string[] {
  const ids: string[] = [];
  const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(patch ?? ''))) !== null) ids.push(m[1] as string);
  return ids;
}

// 按 id 集合删除 patch 里的 insert 行块（与 removeBundledRowDuplicates 同
// 语法约定：id 紧跟 `- insert:` 之后）。
export function removePatchRowsById(
  patch: string, ids: Set<string>,
): { patch: string; removed: string[] } {
  const removed: string[] = [];
  if (typeof patch !== 'string' || patch === '' || !ids || ids.size === 0)
    return { patch, removed };
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^-\s*insert:/.test(line)) {
      const mid = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(lines[i + 1] ?? '');
      if (mid && mid[1] && ids.has(mid[1])) {
        removed.push(mid[1]);
        let j = i + 1;
        while (
          j < lines.length && !/^-\s*insert:/.test(lines[j] as string)
          && !/^#/.test(lines[j] as string) && /^\s+\S/.test(lines[j] as string)
        ) j++;
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
    if (typeof skin !== 'string' || !/^ui-skin-[\w-]+$/.test(skin)) return;
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
    log('boot', '应用迁移皮肤选择失败: ' + String((err as Error).message));
  }
}

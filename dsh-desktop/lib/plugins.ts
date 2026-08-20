/**
 * lib/plugins.ts — 配套插件/皮肤/技能同步（Task 5.2 自 main.js 提取）。
 *
 * syncCompanionPlugins：把内置配套插件 + 皮肤复制进桌面 profile 并登记
 * cordis.patch 行（幂等：已有行不重写，用户选择优先），含市场同名包迁移
 * 预检、内置清单标记、孤儿行清理与历史坏行修复。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Notification } from 'electron';
import { syncBundledPresets, ensureDefaultAgentPreset } from '../preset-sync.js';
import { removeMarketDuplicate, patchHasForeignRows } from '../builtin-collision.js';
import {
  configLinesFor, healSoulMdPatchRow, healRowConfig,
  removeBundledRowDuplicates, collectBundleEntryIds,
} from '../patch-row-heal.js';
import { hasEntryId, togglePluginInPatch } from '../scripts/plugin-manager-patch.js';
import { CORE_PLUGIN_IDS } from '../scripts/onboarding.js';
import { healProfileModuleShadowing } from '../profile-module-heal.js';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN } from './proc.js';
import { desktopProfile, desktopProfileDir, ensureDesktopProfileInit } from './paths.js';
import { COMPANION_PLUGINS, builtinPluginSourceDir } from './plugin-registry-data.js';
import { readJsonFile, copyPluginPackage } from './plugin-copy.js';
import { removedPluginIds } from './plugin-manager-core.js';
import { applySessionManageFix } from './session-heal.js';
import { applyLegacySkinChoice } from './migration.js';
import { artifactKeep } from './market-modules.js';
import { profileDirFor, artifactCacheDirFor } from './paths.js';
import { bridge } from './bridge.js';

/** 皮肤包目录：assets/skins/<id>/（完整 client 插件包，默认 disabled 注册）。 */
export const SKINS_DIR = path.join(__dirname, '..', 'assets', 'skins');

// pnpm hoist 进 profile node_modules 的 @deepseek-ai 核心包真实拷贝会遮蔽
// 指向应用闭包的共享 junction，形成模块双实例（Symbol 身份不一致、注册失效）。
// 启动时清掉这些遮蔽拷贝，让解析回落到 junction —— 与宿主同源、全局单实例。
export function healProfileModules(): void {
  try {
    const home = state.dshHome || path.join(os.homedir(), '.dsh');
    const removed = healProfileModuleShadowing(home, desktopProfile());
    if (removed.length)
      log('boot', '已清理 profile node_modules 中遮蔽安装闭包的包拷贝: ' + removed.join(', '));
  } catch (err) {
    log('boot', '清理 profile 模块遮蔽失败: ' + String((err as Error).message));
  }
}

// 由桌面壳重建的包（配套插件 + 皮肤）不进快照：丢了也会被 syncCompanion
// Plugins / 皮肤同步立刻补回，缓存它们只浪费空间。
export function managedPackageNames(): string[] {
  const names = COMPANION_PLUGINS.map((p) => p.name);
  try {
    for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = readJsonFile(path.join(SKINS_DIR, entry.name, 'package.json'));
      if (pkg && typeof pkg.name === 'string') names.push(pkg.name);
    }
  } catch {
    /* skins 目录缺失 */
  }
  return names;
}

/** 启动兜底回填（幂等）：补回 pnpm 重写后被清掉且未及回填的构建产物。 */
export async function restoreKeptArtifacts(profile: string): Promise<void> {
  const ak = await artifactKeep();
  if (typeof ak.restoreArtifacts !== 'function') return;
  try {
    (ak.restoreArtifacts as (a: string, b: string, o: Record<string, unknown>) => void)(
      profileDirFor(profile),
      artifactCacheDirFor(profile),
      { log: (m: string) => log('artifact-keep', m) },
    );
  } catch (err) {
    log('artifact-keep', '回填失败: ' + String((err as Error).message));
  }
}

/** 内置 skills 分发目录。 */
const BUNDLED_SKILLS_DIR = path.join(__dirname, '..', 'assets', 'skills');

// 内置 skills：assets/skills/<kebab-name>/SKILL.md → ~/.dsh/skills（dsh-
// skill-filesystem 默认扫描根，内核零配置）。带 .eac-skill.json 标记的目录
// 由 EAC 管理（版本变化时覆盖）；用户自建同名目录（无标记）永不覆盖。
export function syncBundledSkills(): void {
  try {
    const src = BUNDLED_SKILLS_DIR;
    if (!fs.existsSync(src)) return;
    const destRoot = path.join(state.dshHome || path.join(os.homedir(), '.dsh'), 'skills');
    fs.mkdirSync(destRoot, { recursive: true });
    const installed: string[] = [];
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillSrc = path.join(src, entry.name);
      if (!fs.existsSync(path.join(skillSrc, 'SKILL.md'))) continue;
      const skillDst = path.join(destRoot, entry.name);
      const markerSrc = readJsonFile(path.join(skillSrc, '.eac-skill.json')) ?? { version: 1, managed: true };
      const markerDst = readJsonFile(path.join(skillDst, '.eac-skill.json'));
      if (markerDst && (markerDst.version as number) === (markerSrc.version as number)) continue;
      if (!markerDst && fs.existsSync(skillDst)) continue; // 用户自建同名技能：不动
      fs.cpSync(skillSrc, skillDst, { recursive: true });
      installed.push(entry.name);
    }
    if (installed.length) log('boot', '已同步内置 skills 到 ' + destRoot + ': ' + installed.join(', '));
  } catch (err) {
    log('boot', '同步内置 skills 失败: ' + String((err as Error).message));
  }
}

/** 配套插件/皮肤同步主流程（Windows；启动/服务重启/agent 更新后重放）。 */
export function syncCompanionPlugins(): void {
  if (!IS_WIN) return;
  // VNext Phase 0 安全模式（DSH_DESKTOP_SAFE_MODE=1，由恢复中心注入）：
  // 全部非核心配套插件按 disabled 写行 —— 核心 Agent/会话/基础 Web UI
  // 保持可用，坏插件被整体隔离出本轮启动（架构文档 §3.4）。
  const safeMode = process.env.DSH_DESKTOP_SAFE_MODE === '1';
  if (safeMode) log('boot', '安全模式：非核心外置插件将以禁用行登记');
  try {
    const home = state.dshHome || path.join(os.homedir(), '.dsh');
    // 桌面专属 profile 必须先存在（未知 profile 不会被 dsh 自动初始化）。
    ensureDesktopProfileInit();
    // V4 运行时补丁（幂等）：对话删除/归档 —— dsh-session-manager 的前置依赖。
    applySessionManageFix();
    const profileDirP = desktopProfileDir();
    // 内置社区 agent preset：安装到用户 preset 根；preset 不进插件树，
    // 坏 preset 不会拖垮启动；已存在则跳过（用户手装/改过的版本优先）。
    const presetsSynced = syncBundledPresets(
      path.join(__dirname, '..', 'assets', 'agent-presets'),
      path.join(home, '.agent-presets'),
      (m) => log('boot', m),
    );
    if (presetsSynced.installed.length)
      log('boot', '已安装内置 agent preset: ' + presetsSynced.installed.join(', '));
    // 默认 preset 指到内置 anchored-standard（用户已写 default 则保留）。
    const defaultResult = ensureDefaultAgentPreset(home, 'anchored-standard', (m) => log('boot', m));
    if (defaultResult === 'set') log('boot', '已设置默认 agent preset: anchored-standard');
    else if (defaultResult === 'kept') log('boot', '用户已设置默认 agent preset，保持不变');
    fs.mkdirSync(path.join(profileDirP, 'node_modules'), { recursive: true });
    const pending: { id: string; name: string; disabled: boolean; config: Record<string, unknown> | undefined }[] = [];
    const removedIds = removedPluginIds();
    // V4.2：市场同名包残留先迁移（package.json 依赖/bundles + patch 行），
    // 让内置版干净接管，避免 duplicate loader entry；完成后系统通知告知。
    const migratedBuiltins: { name: string; dep: boolean; rows: string[] }[] = [];
    for (const p of COMPANION_PLUGINS) {
      if (removedIds.has(p.id)) {
        log('boot', `已按用户选择跳过被移除的内置插件: ${p.id}`);
        continue;
      }
      // dir 显式指定 assets/plugins 目录名；回退按「最后一个路径段」取。
      const dirName = p.dir ?? (p.name.includes('/') ? (p.name.split('/').pop() as string) : p.name);
      // V4.3：覆盖层优先 —— 用户更新过的内置插件从 <userData>/builtin-plugin-updates 拷贝。
      const src = builtinPluginSourceDir(dirName);
      if (!fs.existsSync(path.join(src, 'package.json'))) {
        log('boot', `配套插件源目录无效，跳过: ${p.id} → ${src}`);
        continue;
      }
      try {
        // 市场同名包残留预检（v4.2）：只有「非应用自写」证据才算残留。
        const dupPreCheck = ((): boolean => {
          try {
            const pkg = readJsonFile(path.join(profileDirP, 'package.json'));
            const spec = pkg && (pkg.dependencies as Record<string, string> | undefined)?.[p.name];
            if (spec && !String(spec).startsWith('link:') && !String(spec).startsWith('file:')) return true;
            const bundles =
              pkg && ((pkg.dsh as { profile?: { bundles?: string[] } })?.profile?.bundles);
            if (Array.isArray(bundles) && bundles.includes(p.name)) return true;
            const patchText = fs.readFileSync(path.join(profileDirP, 'cordis.patch.yml'), 'utf8');
            // 只认「非应用自写」的登记行（应用自己的启停状态不算残留）。
            return patchHasForeignRows(patchText, p.name);
          } catch {
            return false;
          }
        })();
        if (dupPreCheck) {
          // 先快照（保护中心）：迁移属于配置面手术，出问题可一键回滚。
          bridge.ensureGuard().snapshot('builtin-migrate:' + p.id);
          const migrated = removeMarketDuplicate(profileDirP, p.name, { log: (m) => log('boot', m) });
          if (migrated.changed && migrated.ok) {
            migratedBuiltins.push({
              name: p.name, dep: migrated.removedDep.length > 0, rows: migrated.removedRows,
            });
            log('boot', `内置插件 ${p.name} 已接管市场同名包（移除依赖 ${migrated.removedDep.length} 个、patch 行 ${migrated.removedRows.length} 个）`);
          }
        }
      } catch (err) {
        log('boot', `内置插件同名迁移失败(${p.id}): ${String((err as Error).message)}`);
      }
      copyPluginPackage(profileDirP, src, p.name);
      // p.disabled: true 的配套插件默认以禁用行注册；已有行不重写，用户选择
      // 优先。安全模式例外：非核心插件一律按禁用登记（本轮启动整体隔离）。
      const disabledBySafeMode = safeMode && !CORE_PLUGIN_IDS.has(p.id);
      pending.push({
        id: p.id, name: p.name,
        disabled: p.disabled === true || disabledBySafeMode,
        config: p.config,
      });
    }
    if (migratedBuiltins.length) {
      try {
        const names = migratedBuiltins.map((m) => m.name).join('、');
        const n = new Notification({
          title: '内置插件已接管同名市场包',
          body: `检测到市场安装的重复包，已改用内置版本（${names}）。插件树已自动整理，本次启动生效。`,
          icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        });
        n.on('click', () => bridge.showMainWindow());
        n.show();
      } catch (err) {
        log('boot', '内置接管通知发送失败: ' + String((err as Error).message));
      }
    }
    // 内置皮肤：行 id 取皮肤包 skin.json 的 wiring.id（ui-skin-*）。
    for (const entry of fs.readdirSync(SKINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(SKINS_DIR, entry.name);
      const pkg = readJsonFile(path.join(src, 'package.json'));
      if (!pkg || typeof pkg.name !== 'string' || !pkg.name.includes('/')) continue;
      const skin = readJsonFile(path.join(src, 'skin.json')) as { wiring?: { id?: unknown } } | null;
      const rowId = skin && skin.wiring && typeof skin.wiring.id === 'string' ? skin.wiring.id : '';
      if (!/^ui-skin-[\w-]+$/.test(rowId)) continue;
      copyPluginPackage(profileDirP, src, pkg.name);
      pending.push({ id: rowId, name: pkg.name, disabled: true, config: undefined });
    }
    // 内置插件清单标记：插件市场据此拒绝重复安装（duplicate loader entry
    // / 模块双实例必须从源头拦截）。
    try {
      const builtinNames = pending.map((p) => p.name);
      const marker = path.join(profileDirP, '.dsh-builtin-plugins.json');
      const prev = readJsonFile(marker);
      const next = { names: builtinNames, updatedAt: new Date().toISOString() };
      if (!prev || JSON.stringify(prev.names) !== JSON.stringify(next.names)) {
        fs.writeFileSync(marker, JSON.stringify(next, null, 2) + '\n');
      }
    } catch (err) {
      log('boot', '写入内置插件清单失败: ' + String((err as Error).message));
    }
    // 注册到 profile 的 patch 层（幂等：已有行不重写，用户选择保留）。
    const patchFile = path.join(profileDirP, 'cordis.patch.yml');
    let patch = '';
    try {
      patch = fs.readFileSync(patchFile, 'utf8');
    } catch {
      patch = '';
    }
    let changed = false;
    // 先修存量坏行：v2.0.0 的 soul-md 行缺 config.path（不修则升级用户
    // “dsh web 启动失败 (退出码 1)”）。
    const healed = healSoulMdPatchRow(patch);
    if (healed.healed.length) {
      patch = healed.patch;
      changed = true;
      log('boot', '已修复 profile patch 中缺 config.path 的 soul-md 行');
    }
    // V4：修复 v3.1.0 及以前写出的「无 config 的 dsh-pet 行」。
    const healedPet = healRowConfig(patch, 'dsh-pet', { size: 260, position: 'bottom-right' });
    if (healedPet.healed.length) {
      patch = healedPet.patch;
      changed = true;
      log('boot', '已修复 profile patch 中缺 config 的 dsh-pet 行（v3 存量坏行）');
    }
    // 清掉与 bundle 登记重复的 overlay 行（duplicate loader entry id 会拖垮
    // 整个插件树；issue #16：按 entry id 判断，git/fork 插件包名不同但 id
    // 相同同样要跳过）。
    let bundled: string[] = [];
    try {
      bundled =
        ((readJsonFile(path.join(profileDirP, 'package.json'))?.dsh as
          | { profile?: { bundles?: string[] } }
          | undefined)?.profile?.bundles) ?? [];
    } catch {
      bundled = [];
    }
    const declaredBundleIds = collectBundleEntryIds(bundled, path.join(profileDirP, 'node_modules'));
    const rowIds: Record<string, string> = {};
    for (const p of COMPANION_PLUGINS) rowIds[p.id] = p.name;
    const deduped = removeBundledRowDuplicates(patch, rowIds, bundled, declaredBundleIds);
    if (deduped.removed.length) {
      patch = deduped.patch;
      changed = true;
      log('boot', '已移除与 bundle 登记重复的 patch 行: ' + deduped.removed.join(', '));
    }
    for (const p of pending) {
      if (hasEntryId(patch, p.id)) {
        // 安全模式：既有启用行也强制压成禁用（否则用户上次启用的坏插件
        // 仍在加载路径上，安全模式名存实亡）。
        if (safeMode && p.disabled && !CORE_PLUGIN_IDS.has(p.id)) {
          const rewritten = togglePluginInPatch(patch, p.id, false, p.name);
          if (rewritten !== patch) {
            patch = rewritten;
            changed = true;
            log('boot', `安全模式：已禁用插件 ${p.id} 的既有启用行`);
          }
        }
        continue;
      }
      // 已在 bundle 列表里的插件由其包内 patch 挂载，overlay 不能再写行。
      if (bundled.includes(p.name) || declaredBundleIds.has(p.id)) continue;
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config);
      if (p.disabled) block += '      disabled: true\n';
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      changed = true;
    }
    if (changed) {
      // 顺带清理历史遗留的孤儿 `- insert:` 行（v4.2/4.3「剥离-回写」残留）。
      const lines = patch.split(/\r?\n/);
      const cleaned = lines
        .filter((line, idx) => {
          if (!/^[ \t]*- insert:\s*$/.test(line)) return true;
          let k = idx + 1;
          while (k < lines.length && (lines[k] ?? '').trim() === '') k += 1;
          return k < lines.length && /^[ \t]+- /.test(lines[k] ?? '');
        })
        .join('\n');
      if (cleaned !== patch) {
        patch = cleaned;
        log('boot', '已清理 profile patch 中的孤儿 - insert: 行');
      }
      fs.writeFileSync(patchFile, patch);
      log('boot', '已同步配套插件/皮肤到 web profile: ' + pending.map((p) => p.id).join(', '));
    }
    // 迁移带来的皮肤选择（migrateFromSharedWebProfile 记录）在此落位。
    applyLegacySkinChoice();
  } catch (err) {
    log('boot', '同步配套插件失败: ' + String((err as Error).message));
  }
}

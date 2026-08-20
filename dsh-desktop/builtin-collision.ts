/**
 * builtin-collision.ts — 内置插件 vs 市场同名包迁移（v4.2）（Task 7.1 自
 * builtin-collision.js 迁 TS）。
 *
 * 场景（用户反馈问题 5 的前半）：用户曾从插件市场安装过与内置插件同名的包
 * （如 dsh-tool-vision，内置版本随客户端分发），内置插件树更新后：
 *   · profile node_modules 里市场版被内置拷贝覆盖（copyPluginPackage）——
 *     这是预期接管；
 *   · 但 package.json 仍挂着市场 spec、cordis.patch.yml 仍留着市场行
 *     （与内置行同 id/name）→ duplicate loader entry / 模块双实例，
 *     「更新后插件树变化」的乱象之一。
 * 本模块在 syncCompanionPlugins 写包前把市场残留（依赖项 + bundles +
 * patch 行）移除，让内置版干净接管；保留用户自建的 link:/file: 本地链接
 * （那是用户 fork/开发目录，删了等于砸开发环境）。
 * 只动插件层/配置层（package.json / cordis.patch.yml），与保护中心一致。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 解析一行块内的 name（跟随 id 行的缩进行里找 name:）。 */
function rowNameOf(lines: string[], startIdx: number): string | null {
  for (let j = startIdx + 1; j < lines.length; j++) {
    const l = lines[j] as string;
    if (/^\s*-/.test(l)) break; // 下一个行项
    if (l.trim() === '') break; // 空行
    if (!/^\s+/.test(l)) break; // 顶层非缩进行（注释等）
    const m = /name:\s*['"]?([^'"\s]+)['"]?\s*/.exec(l);
    if (m && m[1] !== undefined) return m[1];
  }
  return null;
}

/** 跳过一行块（id 行 + 其后的缩进配置行）；返回下一个要处理的下标。 */
function blockEnd(lines: string[], startIdx: number): number {
  let j = startIdx + 1;
  while (j < lines.length) {
    const l = lines[j] as string;
    if (/^\s*-/.test(l)) break;
    if (l.trim() === '') break;
    if (!/^\s+/.test(l)) break;
    j += 1;
  }
  return j;
}

/**
 * 应用自写的登记行判定（v4.4）：
 *   · insert 内层条目 —— syncCompanionPlugins 的固定写形；
 *   · 顶层条目但正上方带「关闭 <id>」标记注释 —— 插件管理 / 选择向导
 *     togglePluginInPatch 的写形。
 * 这类行是应用自己的启停状态，不是市场安装残留：removeMarketDuplicate 与
 * 调用侧的 dupPreCheck 不得把它们当市场重复清理 —— 否则 v4.4 首次向导的
 * 取消勾选会在同一启动里被剥离后按注册表默认回写（dsh-dafeiyu 等默认启用
 * 插件被静默重新启用），且每次启动产生「剥离-回写」空转与孤儿 `- insert:`
 * 行堆积。
 */
export function isSelfWrittenRow(lines: string[], i: number): boolean {
  const cur = lines[i] as string;
  if (!/^[ \t]*- id:/.test(cur)) return false;
  // 缩进的 `- id:` = sync 写的 insert 内层条目。
  if (/^[ \t]+- id:/.test(cur)) return true;
  let k = i - 1;
  while (k >= 0 && (lines[k] as string).trim() === '') k -= 1;
  if (k < 0) return false;
  const idM = /^[ \t]*- id:\s*([\w.-]+)/.exec(cur);
  if (!idM || idM[1] === undefined) return false;
  const esc = String(idM[1]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^#\\s[^\\n]*关闭\\s+' + esc + '(?![A-Za-z0-9_.-])').test(lines[k] as string);
}

/**
 * patch 中是否存在「非应用自写」的登记行（id 或 name 命中内置包名）。
 * 供 syncCompanionPlugins 的 dupPreCheck 使用：只对真正的市场残留触发
 * 迁移（配合 package.json 的依赖/bundles 证据）。
 */
export function patchHasForeignRows(patch: string | null | undefined, builtinName: string): boolean {
  const targetId = String(builtinName || '').split('/').pop();
  const lines = String(patch || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*- id:\s*([\w.-]+)\s*$/.exec(lines[i] as string);
    if (m === null) continue;
    if (m[1] !== targetId && !(builtinName && rowNameOf(lines, i) === builtinName)) continue;
    if (isSelfWrittenRow(lines, i)) continue;
    return true;
  }
  return false;
}

/** stripPatchRows 的结果。 */
export interface StripPatchResult {
  patch: string;
  removed: string[];
}

/** 从 patch 文本里移除 name/id 匹配 target 的 patch 行（顶层 + insert 内层）。 */
export function stripPatchRows(patch: string | null | undefined, targetName: string, targetId: string): StripPatchResult {
  const lines = String(patch || '').split(/\r?\n/);
  const out: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s*id:\s*([\w.-]+)\s*$/.exec(lines[i] as string);
    if (m === null) {
      out.push(lines[i] as string);
      continue;
    }
    const id = m[2] as string;
    const name = rowNameOf(lines, i);
    if (id === targetId || (targetName && name === targetName)) {
      removed.push(id);
      i = blockEnd(lines, i) - 1;
      continue;
    }
    out.push(lines[i] as string);
  }
  let text = out.join('\n');
  if (!/^[\s\S]*\n$/.test(text)) text += '\n';
  text = text.replace(/\n{3,}/g, '\n\n');
  return { patch: text, removed };
}

/** removeMarketDuplicate 的选项。 */
export interface RemoveMarketOpts {
  log?: (m: string) => void;
}

/** removeMarketDuplicate 的结果。 */
export interface RemoveMarketResult {
  ok: boolean;
  changed: boolean;
  removedDep: string[];
  removedBundles: string[];
  removedRows: string[];
}

/** profile package.json 的 dsh.profile 段形状。 */
interface ProfilePkg {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

/**
 * 移除 profile 里与内置插件同名的市场安装残留。
 * @param profileDir profile 目录（…/profiles/<name>）
 * @param builtinName 内置插件包名（@scope/name 或 name）
 */
export function removeMarketDuplicate(profileDir: string, builtinName: string, opts: RemoveMarketOpts = {}): RemoveMarketResult {
  const log = opts.log || ((): void => {});
  const removedDep: string[] = [];
  const removedBundles: string[] = [];
  let removedRows: string[] = [];
  let changed = false;
  try {
    const pkgFile = path.join(profileDir, 'package.json');
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as ProfilePkg;
      let dirty = false;
      if (pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, builtinName)) {
        const spec = String(pkg.dependencies[builtinName] || '');
        // 用户自建 link:/file: 本地链接保留（fork/开发目录），只清市场版。
        if (!spec.startsWith('link:') && !spec.startsWith('file:')) {
          delete pkg.dependencies[builtinName];
          removedDep.push(builtinName);
          dirty = true;
        }
      }
      if (
        pkg.dsh &&
        pkg.dsh.profile &&
        Array.isArray(pkg.dsh.profile.bundles) &&
        pkg.dsh.profile.bundles.includes(builtinName)
      ) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== builtinName);
        removedBundles.push(builtinName);
        dirty = true;
      }
      if (dirty) {
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        changed = true;
        log(`移除市场版依赖残留 ${builtinName}（package.json）`);
      }
    }
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    if (fs.existsSync(patchFile)) {
      const patch = fs.readFileSync(patchFile, 'utf8');
      const { patch: patched, removed } = stripPatchRows(patch, builtinName, builtinName.split('/').pop() as string);
      if (removed.length) {
        fs.writeFileSync(patchFile, patched, 'utf8');
        removedRows = removed;
        changed = true;
        log(`移除市场版 patch 残留行: ${removed.join(', ')}`);
      }
    }
    return { ok: true, changed, removedDep, removedBundles, removedRows };
  } catch (err) {
    log('内置插件同名迁移失败: ' + String((err as Error).message || err));
    return { ok: false, changed, removedDep, removedBundles, removedRows };
  }
}

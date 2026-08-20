/**
 * patch-row-heal.ts — cordis.patch.yml 行修复器（Task 7.1 自 patch-row-heal.js
 * 迁 TS）。
 *
 * v2.0.0 的 dsh-soul-md 历史事故：插件 config schema 声明 `path` 为必填且无
 * 默认值，而 syncCompanionPlugins 写的 patch 行只有 id + name（无 config）。
 * 全新安装时该行校验失败拖垮整棵插件树：`dsh web` 退出码 1、应用「启动失败」
 * 持续崩溃循环（exe 每次启动都重同步该行，用户删不掉）。
 *
 * 现在插件 schema 已默认 `path = "soul.md"`（文件缺失 → 空回退 → 无
 * prompt section → 官方系统提示词原样生效），无 config 的行也能启动。新行
 * 由 sync 显式带 config 块（见 configLinesFor），本修复器负责修好存量用户
 * profile 里的坏行 —— 升级到修复版即自愈，无需手工编辑。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 修复结果：修复后的 patch 文本 + 被修改的行 id 列表。 */
export interface HealResult {
  patch: string;
  healed: string[];
}

/** 去重结果。 */
export interface DedupeResult {
  patch: string;
  removed: string[];
}

/**
 * 把 config 对象序列化为 patch 行的 YAML 缩进块。`baseIndent` 是行
 * `- id:` 的缩进：insert 内层行在 4 空格（config 在 6、键在 8 —— 旧默认），
 * 插件管理器/向导写的顶层行在 0（config 在 2、键在 4）。缩进层级错配是
 * YAML 解析错误，会拖垮整棵插件树（`dsh web` 退出 1），层级必须始终跟随
 * 所属行。
 */
export function configLinesFor(config: Record<string, unknown> | null | undefined, baseIndent = 4): string {
  const step = ' '.repeat(baseIndent + 2);
  const step2 = ' '.repeat(baseIndent + 4);
  let out = `${step}config:\n`;
  for (const [k, v] of Object.entries(config || {})) {
    out += `${step2}${k}: ${JSON.stringify(v)}\n`;
  }
  return out;
}

/**
 * 把行的 config 块重写为与其自身 `- id:` 行匹配的缩进（config 在
 * id 缩进 + 2，键在 + 4 —— 与 `name:` 同层）。修复 pre-wizard 构建把
 * 6 空格 config 块追加到顶层行（`- id: x` 顶格）留下的坏档：那是 YAML
 * mapping-entry 缩进错误，且该行已带 config 键，「缺 config」类修复器
 * 永远不会再碰它。幂等；无需修复时原样返回。
 */
export function normalizeRowConfigIndent(patch: string, id: string): string {
  if (typeof patch !== 'string' || patch === '' || !id) return patch;
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRe = new RegExp(`^([\\t ]*)- id: ${esc}(?![A-Za-z0-9_.-])`);
  const lines = patch.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = rowRe.exec(lines[i] as string);
    if (!m || m[1] === undefined) continue;
    const idIndent = m[1].replace(/\t/g, '  ').length;
    const wantConfig = ' '.repeat(idIndent + 2) + 'config:';
    for (let j = i + 1; j < lines.length; j++) {
      const cur = lines[j] as string;
      const t = cur.trim();
      if (t === '' || /^#/.test(t)) continue;
      if (/^[\t ]*- id:/.test(cur) || t === 'insert:') break;
      const curIndent = ((cur.match(/^[\t ]*/) || [''])[0] as string).replace(/\t/g, '  ').length;
      if (curIndent <= idIndent) break;
      if (!/^[\t ]*config:/.test(cur) || t !== 'config:') continue;
      if (cur !== wantConfig) {
        const diff = curIndent - (idIndent + 2);
        lines[j] = wantConfig;
        for (let k = j + 1; k < lines.length; k++) {
          const kl = lines[k] as string;
          if (kl.trim() === '' || /^#/.test(kl)) continue;
          const ki = ((kl.match(/^[\t ]*/) || [''])[0] as string).replace(/\t/g, '  ').length;
          if (ki <= idIndent + 2) break;
          lines[k] = ' '.repeat(ki - diff) + kl.trimStart();
        }
        changed = true;
      }
      break;
    }
  }
  return changed ? lines.join('\n') : patch;
}

/**
 * 确保 patch 里的每个 soul-md 行都带 config.path。幂等：已有 config 块的
 * 行不动。healed 列出被修改的行 id。
 */
export function healSoulMdPatchRow(patch: string, config: Record<string, unknown> = { path: 'soul.md' }): HealResult {
  const healed: string[] = [];
  if (typeof patch !== 'string' || patch === '') return { patch, healed };
  const normalized = normalizeRowConfigIndent(patch, 'soul-md');
  if (normalized !== patch) healed.push('soul-md');
  const p = normalized;
  // 行形态：
  //   - insert:
  //       - id: soul-md
  //         name: 'dsh-soul-md'
  //         (config: ... 可选)
  // 或顶层行（插件管理器 / 向导，id 顶格）。匹配 id: + name: 两行；仅当
  // 下一非空行不是 config: 键时才重写（负向先行断言保证已修行稳定）。
  // config 块缩进镜像行自身缩进（id 缩进 + 2 / + 4）。
  const rowRe = /(^[\t ]*- id: soul-md\b[^\n]*\n[\t ]*name: ['"]?[^'"\n]+['"]?\n)(?![\t ]*config:)/gm;
  const out = p.replace(rowRe, (m) => m + configLinesFor(config, ((m.match(/^[\t ]*/) || [''])[0] as string).replace(/\t/g, '  ').length));
  if (out !== p) healed.push('soul-md');
  return { patch: out, healed };
}

/**
 * V4 修复：给已存在但缺 config 块的行补 config。dsh-pet 的 apply 读
 * config.fullRoot（无守卫），无 config 的行会让 loader 传 undefined 直接
 * 拖垮整棵插件树（v3.1.0 全新安装即「启动失败」的根因；老用户因市场装
 * 过的行自带 config 才幸免）。与 healSoulMdPatchRow 同一手法：id+name 行
 * 后跟负向先行断言，已带 config 的行不动（幂等，用户改过的值优先）。
 */
export function healRowConfig(patch: string, id: string, config: Record<string, unknown>): HealResult {
  const healed: string[] = [];
  if (typeof patch !== 'string' || patch === '' || !id || !config) return { patch, healed };
  const normalized = normalizeRowConfigIndent(patch, id);
  if (normalized !== patch) healed.push(id);
  const p = normalized;
  const rowRe = new RegExp(
    `(^[\\t ]*- id: ${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.-])[^\\n]*\\n[\\t ]*name: ['"]?[^'"\\n]+['"]?\\n)(?![\\t ]*config:)`,
    'gm',
  );
  const out = p.replace(rowRe, (m) => m + configLinesFor(config, ((m.match(/^[\t ]*/) || [''])[0] as string).replace(/\t/g, '  ').length));
  if (out !== p) healed.push(id);
  return { patch: out, healed };
}

/**
 * 收集一个 bundle 包经自己的 cordis.patch.yml（或 package.json 的
 * `dsh.bundle.patch` 指向的文件）声明的 loader entry id。这些是 bundle
 * 被加载时自己挂载的 id —— overlay 行带其中任一 id 即为重复，与该行的
 * 包名无关。包缺失/不可解析时不贡献任何 id。
 */
export function bundlePatchEntryIds(bundleDir: string | null): Set<string> {
  const ids = new Set<string>();
  if (!bundleDir) return ids;
  try {
    const pkgPath = path.join(bundleDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return ids;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dsh?: { bundle?: unknown };
    };
    const b = pkg && pkg.dsh && pkg.dsh.bundle;
    let patchRel = 'cordis.patch.yml';
    if (typeof b === 'string') patchRel = b;
    else if (b && typeof (b as { patch?: unknown }).patch === 'string') patchRel = (b as { patch: string }).patch;
    const patch = fs.readFileSync(path.join(bundleDir, patchRel), 'utf8');
    const idRe = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(patch)) !== null) {
      if (m[1] !== undefined) ids.add(m[1]);
    }
  } catch {
    /* 包/补丁缺失或损坏 → 不贡献任何 id */
  }
  return ids;
}

/**
 * profile 全部 bundle 包声明的 entry id 并集。同步流程用它
 * (a) 丢弃与 bundle 自挂载重复的 overlay 行 (b) 拒绝把这些行写回 ——
 * 覆盖包名与内置配套插件不同的 git/fork 安装。
 * @param bundleNames profile 的 `dsh.profile.bundles` 列表
 * @param profileNodeModules `<profile>/node_modules`
 */
export function collectBundleEntryIds(bundleNames: string[] | null | undefined, profileNodeModules: string): Set<string> {
  const ids = new Set<string>();
  for (const name of bundleNames || []) {
    const dir = name ? path.join(profileNodeModules, ...String(name).split('/')) : '';
    for (const id of bundlePatchEntryIds(dir)) ids.add(id);
  }
  return ids;
}

/**
 * 移除 profile 已通过 package.json bundle 列表（`dsh.profile.bundles`，
 * `dsh plugin add` 写入 —— 即用户从插件市场装的任何东西）挂载的行的
 * insert 块。
 *
 * 列在其中的 bundle 连同自带 cordis.patch.yml 一起加载，patch 会挂载该行。
 * 当 syncCompanionPlugins 又为同一插件写了 overlay 行时，loader 以
 * `duplicate loader entry id: <id>` 中止整棵树（dsh web 退出 1 →「启动
 * 失败」崩溃循环）。丢弃 overlay 副本是安全的：bundle 仍会挂载它。
 *
 * 两种重复信号都被处理：
 *  - 按包名（旧路径）：rowIds 里包名出现在 bundle 列表 —— 匹配 npm/市场
 *    安装（名字对得上）；
 *  - 按 entry id：行的 entry id 被任一 bundle patch 声明（bundleEntryIds）
 *    —— 匹配 git/fork/link 安装（包名与 overlay 行不同，issue #16）。
 */
export function removeBundledRowDuplicates(
  patch: string,
  rowIds: Record<string, string> | null | undefined,
  bundleNames: string[] | null | undefined,
  bundleEntryIds: Set<string> | null | undefined,
): DedupeResult {
  const removed: string[] = [];
  if (
    typeof patch !== 'string' ||
    patch === '' ||
    ((!bundleNames || !bundleNames.length) && (!bundleEntryIds || !bundleEntryIds.size))
  ) {
    return { patch, removed };
  }
  const declaredIds = bundleEntryIds && bundleEntryIds.size ? bundleEntryIds : new Set<string>();
  const nameTargets = new Set<string>(
    Object.entries(rowIds || {})
      .filter(([, pkg]) => (bundleNames || []).includes(pkg))
      .map(([id]) => id),
  );
  const isDup = (id: string | null): boolean => (id !== null && declaredIds.has(id)) || (id !== null && nameTargets.has(id));
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^-\s*insert:/.test(line)) {
      // 从块体解析 id + name（id 必须是紧邻的下一行，保持无歧义）。
      let id: string | null = null;
      const mid = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(lines[i + 1] || '');
      if (mid && mid[1] !== undefined) id = mid[1];
      if (isDup(id)) {
        if (id !== null) removed.push(id);
        // 跳过块体：缩进的非注释行，直到下一个顶层键 / 块 / 注释 / 空行。
        let j = i + 1;
        while (j < lines.length && !/^-\s*insert:/.test(lines[j] as string) && /^#/.test(lines[j] as string) === false && /^\s+\S/.test(lines[j] as string)) {
          j++;
        }
        i = j - 1;
        continue;
      }
    }
    out.push(line);
  }
  // 收敛内层被删块可能留下的空行。
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!text.endsWith('\n')) text += '\n';
  return { patch: text, removed };
}

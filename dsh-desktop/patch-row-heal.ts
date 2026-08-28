'use strict';

const fs = require('fs');
const path = require('path');

// cordis.patch.yml row heal for dsh-soul-md.
//
// v2.0.0 shipped the bundled dsh-soul-md plugin whose config schema declared
// `path` as REQUIRED with no default, while the profile patch row written by
// syncCompanionPlugins carried only id + name (no config). On a fresh install
// config validation then failed for that row, which took down the ENTIRE
// plugin tree: `dsh web` exited with code 1 and the app showed "启动失败"
// (persistent crash loop — the exe re-syncs the row on every boot, so users
// could not delete their way out of it).
//
// The plugin schema now defaults `path` to "soul.md" (missing file → empty
// fallback → NO prompt section → the stock official system prompt is used
// untouched), so a config-less row boots fine again. New rows are also
// written WITH an explicit config block (see configLinesFor below), and this
// heal pass fixes ALREADY-BROKEN rows living in existing user profiles, so
// upgrading to the fixed build repairs them without any manual edit.

/**
 * Serialize a config object as patch-row YAML lines. `baseIndent` is the
 * indentation of the row's `- id:` line: insert-block rows sit at 4 spaces
 * (config at 6, keys at 8 — the legacy default), while top-level rows
 * written by the plugin manager / onboarding wizard sit at 0 (config at 2,
 * keys at 4). A config block at the wrong step is a YAML parse error that
 * takes down the whole plugin tree (`dsh web` exits 1), so the step must
 * always mirror the row it belongs to.
 */
function configLinesFor(config: Record<string, unknown>, baseIndent = 4): string {
  const step = ' '.repeat(baseIndent + 2);
  const step2 = ' '.repeat(baseIndent + 4);
  let out = `${step}config:\n`;
  for (const [k, v] of Object.entries(config || {})) {
    out += `${step2}${k}: ${JSON.stringify(v)}\n`;
  }
  return out;
}

/**
 * Rewrite a row's config block to the indentation matching its own `- id:`
 * line (config must sit at id-indent + 2, keys at + 4 — the same level as
 * `name:`). Heals rows that a pre-wizard build broke by appending a 6-space
 * config block to a TOP-LEVEL row (`- id: x` at column 0): that mix is a
 * YAML mapping-entry indentation error, and since the row already carries a
 * config key the "missing config" healers leave it untouched forever.
 * Idempotent; returns the patch unchanged when nothing needs fixing.
 */
function normalizeRowConfigIndent(patch: string, id: string): string {
  if (typeof patch !== 'string' || patch === '' || !id) return patch;
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRe = new RegExp(`^([\\t ]*)- id: ${esc}(?![A-Za-z0-9_.-])`);
  const lines = patch.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = rowRe.exec(lines[i]!);
    if (!m) continue;
    const idIndent = m[1]!.replace(/\t/g, '  ').length;
    const wantConfig = ' '.repeat(idIndent + 2) + 'config:';
    for (let j = i + 1; j < lines.length; j++) {
      const cur = lines[j]!;
      const t = cur.trim();
      if (t === '' || /^#/.test(t)) continue;
      if (/^[\t ]*- id:/.test(cur) || t === 'insert:') break;
      const curIndent = (cur.match(/^[\t ]*/) || [''])[0].replace(/\t/g, '  ').length;
      if (curIndent <= idIndent) break;
      if (!/^[\t ]*config:/.test(cur) || t !== 'config:') continue;
      if (cur !== wantConfig) {
        const diff = curIndent - (idIndent + 2);
        lines[j] = wantConfig;
        for (let k = j + 1; k < lines.length; k++) {
          const kl = lines[k]!;
          if (kl.trim() === '' || /^#/.test(kl)) continue;
          const ki = (kl.match(/^[\t ]*/) || [''])[0].replace(/\t/g, '  ').length;
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
 * Ensure every soul-md row in `patch` carries config.path.
 * Idempotent: rows that already have a config block are left untouched.
 * Returns { patch, healed } — healed lists row ids that were modified.
 */
function healSoulMdPatchRow(patch: string, config: Record<string, unknown> = { path: 'soul.md' }): { patch: string; healed: string[] } {
  const healed: string[] = [];
  if (typeof patch !== 'string' || patch === '') return { patch, healed };
  const normalized = normalizeRowConfigIndent(patch, 'soul-md');
  if (normalized !== patch) healed.push('soul-md');
  patch = normalized;
  // A row looks like:
  //   - insert:
  //       - id: soul-md
  //         name: 'dsh-soul-md'
  //         (config: ... optional)
  // or a top-level row (plugin manager / onboarding wizard, id at column 0).
  // Match the `id:` + `name:` lines; only rewrite when the NEXT non-blank
  // line is not a `config:` key (negative lookahead keeps healed rows stable).
  // The config block mirrors the row's own indent (id indent + 2 / + 4).
  const rowRe = /(^[\t ]*- id: soul-md\b[^\n]*\n[\t ]*name: ['"]?[^'"\n]+['"]?\n)(?![\t ]*config:)/gm;
  let out = patch.replace(rowRe, (m) => m + configLinesFor(config, (m.match(/^[\t ]*/) || [''])[0].replace(/\t/g, '  ').length));
  if (out !== patch) healed.push('soul-md');
  return { patch: out, healed };
}

/**
 * V4 修复：给已存在但缺 config 块的行补 config。dsh-pet 的 apply 读
 * config.fullRoot（无守卫），无 config 的行会让 loader 传 undefined 直接
 * 拖垮整棵插件树（v3.1.0 全新安装即「启动失败」的根因；老用户因市场装
 * 过的行自带 config 才幸免）。
 *
 * V4.4 修复（重复 config 事故）：原实现只看 name 行后**紧跟**的一行——
 * 条目呈 `name → disabled → config` 形态（首次安装的向导/写入组合会产生）
 * 时，name 后紧跟 disabled 被误判为「缺 config」而补第二份 config，YAML
 * 报 duplicated mapping key 拖垮启动。现改为**扫描整个条目块**：id 行之后
 * 所有缩进更深的行里任意位置已有 config 键即不补（幂等，用户改过的值优先）。
 */
function healRowConfig(patch: string, id: string, config: Record<string, unknown>): { patch: string; healed: string[] } {
  const healed: string[] = [];
  if (typeof patch !== 'string' || patch === '' || !id || !config) return { patch, healed };
  const normalized = normalizeRowConfigIndent(patch, id);
  if (normalized !== patch) healed.push(id);
  patch = normalized;
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idLineRe = new RegExp(`^([\\t ]*)- id: ${esc}(?![A-Za-z0-9_.-])`);
  const lines = patch.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = idLineRe.exec(lines[i]!);
    if (!m) continue;
    const idIndent = (m[1] || '').replace(/\t/g, '  ').length;
    // 条目块范围：id 行之后缩进更深的所有行（空行/注释/兄弟条目视为块结束）。
    let blockEnd = i + 1;
    let nameLine = -1;
    let hasConfig = false;
    while (blockEnd < lines.length) {
      const cur = lines[blockEnd]!;
      const t = cur.trim();
      if (t === '' || /^#/.test(t)) break;
      const curIndent = (cur.match(/^[\t ]*/) || [''])[0].replace(/\t/g, '  ').length;
      if (curIndent <= idIndent) break;
      if (/^[\t ]*config:/.test(cur)) { hasConfig = true; break; }
      if (nameLine === -1 && /^[\t ]*name:/.test(cur)) nameLine = blockEnd;
      blockEnd += 1;
    }
    // 块内已有 config（任意位置）或找不到 name 行：不补。
    if (hasConfig || nameLine === -1) continue;
    const configLines = configLinesFor(config, idIndent).split('\n');
    while (configLines.length && configLines[configLines.length - 1] === '') configLines.pop();
    lines.splice(nameLine + 1, 0, ...configLines);
    changed = true;
    i = blockEnd;
  }
  if (changed) healed.push(id);
  return { patch: lines.join('\n'), healed };
}

/**
 * Collect the loader entry ids a bundle package declares through its own
 * cordis.patch.yml (or the `dsh.bundle.patch` file its package.json points
 * at). These are the ids the bundle itself mounts when loaded — an overlay
 * row carrying any of them is a duplicate regardless of that row's package
 * name. Returns a Set<string>; a missing/unparseable package contributes
 * nothing.
 */
function bundlePatchEntryIds(bundleDir: string): Set<string> {
  const ids = new Set<string>();
  if (!bundleDir) return ids;
  try {
    const pkgPath = path.join(bundleDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return ids;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const b = pkg && pkg.dsh && pkg.dsh.bundle;
    let patchRel = 'cordis.patch.yml';
    if (typeof b === 'string') patchRel = b;
    else if (b && typeof b.patch === 'string') patchRel = b.patch;
    const patch = fs.readFileSync(path.join(bundleDir, patchRel), 'utf8');
    const idRe = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
    let m;
    while ((m = idRe.exec(patch)) !== null) ids.add(m[1]!);
  } catch { /* 包/补丁缺失或损坏 → 不贡献任何 id */ }
  return ids;
}

/**
 * Union of the declared entry ids across every profile bundle package. The
 * sync pass uses this to (a) drop overlay rows that duplicate a bundle's own
 * mount and (b) refuse to write those rows back — covering git/fork installs
 * whose package name differs from the built-in companion's.
 * @param {string[]} bundleNames - profile `dsh.profile.bundles` list.
 * @param {string} profileNodeModules - `<profile>/node_modules`.
 */
function collectBundleEntryIds(bundleNames: string[], profileNodeModules: string): Set<string> {
  const ids = new Set<string>();
  for (const name of bundleNames || []) {
    const dir = name
      ? path.join(profileNodeModules, ...String(name).split('/'))
      : '';
    for (const id of bundlePatchEntryIds(dir)) ids.add(id);
  }
  return ids;
}

/**
 * Remove insert-blocks for rows the profile already mounts through its
 * package.json bundle list (`dsh.profile.bundles`, written by `dsh plugin
 * add` — i.e. anything the user installed from the plugin market).
 *
 * A bundle listed there is loaded WITH its own packaged cordis.patch.yml,
 * which mounts the row itself. When syncCompanionPlugins has also written an
 * overlay row for the same plugin, the loader aborts the whole tree with
 * `duplicate loader entry id: <id>` (dsh web exits 1 → "启动失败" crash
 * loop). Dropping the overlay copy is safe: the bundle still mounts it.
 *
 * Two duplicate signals are honoured:
 *  - name-based (legacy): a `rowIds` row whose package name appears in the
 *    bundle list — matches npm/market installs where names line up;
 *  - id-based: the row's entry id is declared by ANY bundle patch
 *    (`bundleEntryIds`) — matches git/fork/link installs whose package name
 *    differs from the overlay row's (issue #16).
 *
 * Returns { patch, removed }.
 */
function removeBundledRowDuplicates(patch: string, rowIds: string[], bundleNames: string[], bundleEntryIds: Set<string>): { patch: string; removed: string[] } {
  const removed: string[] = [];
  if (typeof patch !== 'string' || patch === ''
    || (!bundleNames || !bundleNames.length) && (!bundleEntryIds || !bundleEntryIds.size)) {
    return { patch, removed };
  }
  const declaredIds = bundleEntryIds && bundleEntryIds.size ? bundleEntryIds : new Set();
  const nameTargets = new Set(Object.entries(rowIds || {})
    .filter(([, pkg]) => (bundleNames || []).includes(pkg))
    .map(([id]) => id));
  const isDup = (id: string) => (id !== null && declaredIds.has(id)) || (id !== null && nameTargets.has(id));
  const lines = patch.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^-\s*insert:/.test(line)) {
      // Parse id + name from the block body (id must be the immediate next
      // line to stay unambiguous).
      let id: string | null = null;
      const mid = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(lines[i + 1] || '');
      if (mid) id = mid[1]!;
      if (id !== null && isDup(id)) {
        removed.push(id);
        // Skip the block body: indented non-comment lines up to the next
        // top-level key / block / comment / blank line.
        let j = i + 1;
        while (j < lines.length && !/^-\s*insert:/.test(lines[j]!) && /^#/.test(lines[j]!) === false && /^\s+\S/.test(lines[j]!)) j++;
        i = j - 1;
        continue;
      }
    }
    out.push(line);
  }
  // Collapse the blank line an inner removed block may leave behind.
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!text.endsWith('\n')) text += '\n';
  return { patch: text, removed };
}

module.exports = { configLinesFor, normalizeRowConfigIndent, healSoulMdPatchRow, healRowConfig, removeBundledRowDuplicates, bundlePatchEntryIds, collectBundleEntryIds };

// dsh-unified-market — profile 配置的「双边同步」写层（v0.4.0 新增）。
//
// 为什么需要这一层（根因，非猜测）：
//   市场原先只通过 `spawn(dsh plugin add/remove)` 间接改配置，由 dsh 内核的
//   reconcilePlugins 按 dependencies 整文件重写 package.json。整文件重写 =
//   「以内存状态为准覆盖磁盘」，任何外部改动（用户手编、其他插件写、
//   壳侧 heal、另一会话操作）都可能被丢掉。用户观感就是「页面状态单向复写
//   到文件，文件反被覆盖」。
//
//   本层把配置写盘收敛为唯一入口，语义改为双边同步：
//     1. 每次操作**重新读盘**（无模块级缓存），不做「用旧快照覆盖」；
//     2. 以 id 为键做**并集合并**，只增删本层管理的 id，
//        外部行、未知行、注释、空行**原样保留**；
//     3. 写前做 CAS（SHA256+size+mtime）比对，不一致则重读重合并（最多 3 次），
//        并发写不会互相覆盖；
//     4. 同目录临时文件 + rename **原子写**（cordis.patch.yml 被截断 = 启动死循环）；
//     5. 写后**校验可解析**，失败自动回滚到操作前快照；
//     6. 快照同时覆盖 package.json **与** cordis.patch.yml，并提供 restore
//        （原实现只有 package.json 快照且没有任何还原代码）。
//
// 关键约束（踩过的坑）：
//   · cordis.patch.yml **禁止** js-yaml load→dump 回写：会丢注释、改引号风格、
//     破坏 `[]` 空块。本层全程逐行文本手术，parse 只用于校验。
//   · 禁用插件必须写**顶层编辑型**行：
//         - id: <id>
//           name: '<pkg>'
//           disabled: true
//     而**不能**写成 `- insert:` 块 —— 桌面壳 boot 期
//     `removeBundledRowDuplicates`（dsh-desktop/patch-row-heal.js）会把与
//     bundle 包内 patch 同 id 的 insert 块整块删除，**即使带 disabled: true**。
//     顶层编辑型行不受该去重影响。本层还负责把 insert 块内的同 id 内层条目
//     一并移除，避免 duplicate loader entry。
//
// 本文件只做文件层读写与合并，不依赖 host.js，便于单独测试。
'use strict';

import fs from 'node:fs';
import crypto from 'node:crypto';
import { join } from 'node:path';

const PATCH_FILE = 'cordis.patch.yml';
const PKG_FILE = 'package.json';
const CAS_RETRIES = 3;
/** 本层所写顶层编辑行的注释前缀 —— 写与识别必须用同一常量，否则幂等性失效。 */
const OWN_COMMENT_PREFIX = '# 插件市场';
const OWN_COMMENT_RE = /^#\s*插件市场/;

/** 解析出「块」：- id: 行 + 其后的紧邻可见行（name/disabled/config…）。 */
function blocksOf(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  // split 会把结尾换行变成一个空串元素，它不是内容行 —— 剥掉，
  // 由调用方用「原文是否以换行结尾」自行补回，否则每轮操作都会多出一个空行。
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const blocks = [];
  // 同时匹配顶层（`- id:`）与 insert 内层（`  - id:`）；靠前导空白判定层级。
  const ID_LINE = /^(\s*)-\s*id:\s*([\w.-]+)\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = ID_LINE.exec(lines[i]);
    if (m === null) continue;
    const indent = m[1];
    let end = i + 1;
    if (indent === '') {
      // 顶层编辑型行：块体是紧邻的、不以 '-' 开头的缩进行。
      while (end < lines.length && /^\s+\S/.test(lines[end]) && !/^\s*-\s/.test(lines[end])) end += 1;
    } else {
      // insert 内层条目：块体只包含后续缩进更深的行。
      while (end < lines.length) {
        const nxt = lines[end];
        if (!/^\s+\S/.test(nxt)) break;
        const lead = /^(\s*)/.exec(nxt)[1];
        if (lead.length <= indent.length) break;
        end += 1;
      }
    }
    blocks.push({ id: m[2], start: i, end: end - 1, indent, lines: lines.slice(i, end) });
    i = end - 1;
  }
  return { lines, blocks };
}

/** 块是否为 insert 内层条目（靠缩进判定：内层 id 行有前导空白）。 */
function isInnerBlock(block) {
  return block.indent !== '';
}

/** 块是否带 disabled: true。 */
function isDisabledBlock(block) {
  return block.lines.some((l) => /^\s*disabled:\s*true\s*$/.test(l));
}

/** 从块中读 name（用于顶层编辑行）。 */
function blockName(block) {
  for (const l of block.lines) {
    const m = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(l);
    if (m !== null) return m[1];
  }
  return null;
}

/** 读盘（无缓存）——双边同步的第 1 条：永远以磁盘为准。 */
export function readProfileConfig(profileDir) {
  const patchPath = join(profileDir, PATCH_FILE);
  const pkgPath = join(profileDir, PKG_FILE);
  let patchText = '';
  let pkgText = '';
  try { patchText = fs.readFileSync(patchPath, 'utf8'); } catch { patchText = ''; }
  try { pkgText = fs.readFileSync(pkgPath, 'utf8'); } catch { pkgText = ''; }
  let pkg = null;
  try { pkg = JSON.parse(pkgText); } catch { pkg = null; }
  const bundlesRaw = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : [];
  const { lines, blocks } = blocksOf(patchText);
  return {
    profileDir,
    patchPath,
    pkgPath,
    patchText,
    pkgText,
    pkg,
    bundles: bundlesRaw.filter((b) => typeof b === 'string'),
    dependencies: (pkg && pkg.dependencies) || {},
    patchLines: lines,
    patchBlocks: blocks,
    revision: {
      patch: hashOf(patchText),
      pkg: hashOf(pkgText),
    },
  };
}

/** SHA256 内容哈希（CAS 用）。 */
export function hashOf(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 临时文件 + rename 原子写（同目录，保证同卷）。 */
export function writeAtomic(file, text) {
  const tmp = file + '.mktstmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 快照 package.json + cordis.patch.yml（操作前调用，失败可整组回滚）。
 * @returns {{stamp: string, files: {src: string, snap: string}[]}|null}
 */
export function snapshotProfileConfig(profileDir, stamp) {
  const at = String(stamp ?? Date.now());
  const files = [];
  for (const name of [PKG_FILE, PATCH_FILE]) {
    const src = join(profileDir, name);
    if (!fs.existsSync(src)) continue;
    const snap = src + '.mkts-snapshot-' + at;
    try {
      fs.writeFileSync(snap, fs.readFileSync(src, 'utf8'));
      files.push({ src, snap });
    } catch { /* 快照失败不阻断，但记录缺失 */ }
  }
  return files.length ? { stamp: at, files } : null;
}

/** 从操作前快照还原（写后校验失败时自动调用）。 */
export function restoreSnapshot(snap) {
  if (!snap || !Array.isArray(snap.files)) return false;
  let ok = true;
  for (const f of snap.files) {
    try { fs.writeFileSync(f.src, fs.readFileSync(f.snap, 'utf8')); } catch { ok = false; }
  }
  return ok;
}

/**
 * 以 id 为键合并 patch：把 <id> 变成**顶层编辑型**行（disabled 或复位），
 * 同时移除 insert 块内的同 id 内层条目。其余行（含外部/未知条目、注释、空行）
 * 原样保留 —— 这是「双边同步」的核心：不整文件覆盖。
 *
 * @param {string} patchText - 读盘得到的当前内容
 * @param {string} id - loader 条目 id
 * @param {string|null} name - 包名（写成顶层行的 name）
 * @param {boolean} disabled - true 写 disabled: true，false 表示复位为启用
 * @param {string} comment - 顶层行上方注释（标识这是本工具所写）
 * @returns {{text: string, changed: boolean, removedInner: string[], action: string}}
 */
export function applyPatchToggle(patchText, id, name, disabled, comment) {
  const text = String(patchText ?? '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailing = /\r?\n$/.test(text);
  const { lines, blocks } = blocksOf(text);
  const label = comment || `# 插件市场（dsh-unified-market）：${disabled ? '关闭' : '启用'} ${id}`;

  const drop = new Set();
  const removedInner = [];
  let managedStart = -1;
  let managedEnd = -1;

  for (const b of blocks) {
    if (b.id !== id) continue;
    const inner = isInnerBlock(b);
    if (inner) {
      // insert 内层条目：必须删掉，否则与顶层行构成 duplicate loader entry。
      for (let i = b.start; i <= b.end; i += 1) drop.add(i);
      removedInner.push(b.id);
      continue;
    }
    // 顶层编辑型行：本层管理，连同**紧邻上方由本层写的注释**一起整体替换
    // （否则每次操作都会在旧注释下再叠一条，幂等性被破坏）。
    let top = b.start;
    while (top - 1 >= 0 && OWN_COMMENT_RE.test(lines[top - 1])) {
      top -= 1;
    }
    if (managedStart === -1) { managedStart = top; managedEnd = b.end; }
    for (let i = top; i <= b.end; i += 1) drop.add(i);
  }

  const built = [];
  built.push(label);
  built.push(`- id: ${id}`);
  if (name) built.push(`  name: '${name}'`);
  if (disabled) built.push('  disabled: true');

  // 关键：删掉内层条目后，承载它的 `- insert:` 可能变成孤立的空块。
  // 空 insert 块 = duplicate loader entry / 启动失败，必须整块移除。
  const insertIdx = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s*insert:\s*$/.test(lines[i])) insertIdx.push(i);
  }
  for (let k = insertIdx.length - 1; k >= 0; k -= 1) {
    const idx = insertIdx[k];
    if (drop.has(idx)) continue;
    let end = idx + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
    let alive = false;
    for (let j = idx + 1; j < end; j += 1) {
      if (!drop.has(j)) { alive = true; break; }
    }
    if (!alive) {
      for (let j = idx; j < end; j += 1) drop.add(j);
    }
  }

  const out = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (managedStart !== -1 && i === managedStart) {
      if (!inserted) { out.push(...built); inserted = true; }
      continue;
    }
    if (drop.has(i)) continue;
    out.push(lines[i]);
  }
  if (!inserted) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('', ...built);
  }
  let result = out.join(eol);
  if (hadTrailing || !result.endsWith(eol)) result += eol;

  const changed = result !== text;
  const action = disabled ? (managedStart === -1 ? 'appended' : 'replaced') : 'reset';
  return { text: result, changed, removedInner, action };
}

/**
 * 以「保持既有相对顺序」的方式合并 bundles：缺失则末尾追加，失效则移除。
 * 绝不按新数组整体覆盖（那会丢掉外部顺序调整）。
 */
export function mergeBundles(existing, desiredEnable, desiredDisable) {
  const list = Array.isArray(existing) ? existing.filter((x) => typeof x === 'string') : [];
  const off = new Set(Array.isArray(desiredDisable) ? desiredDisable : []);
  const out = list.filter((x) => !off.has(x));
  for (const name of (Array.isArray(desiredEnable) ? desiredEnable : [])) {
    if (typeof name === 'string' && name && !out.includes(name) && !off.has(name)) out.push(name);
  }
  const changed = out.length !== list.length || out.some((x, i) => x !== list[i]);
  return { bundles: out, changed };
}

/** 把 bundles 写回 package.json 文本（保留其余字段与既有顺序，整体回写 JSON）。 */
export function applyBundles(pkgText, bundles) {
  let pkg = null;
  try { pkg = JSON.parse(pkgText); } catch { return { text: pkgText, changed: false, error: 'package.json 不可解析' }; }
  if (!pkg || typeof pkg !== 'object') return { text: pkgText, changed: false, error: 'package.json 非对象' };
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
  const before = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.join('\u0000') : '';
  pkg.dsh.profile.bundles = bundles;
  const text = JSON.stringify(pkg, null, 2) + '\n';
  return { text, changed: before !== bundles.join('\u0000') };
}

/** 写前校验：patch 必须能被块解析且不含空 insert 块；JSON 必须可解析。 */
export function validatePatchText(text) {
  const problems = [];
  const { lines, blocks } = blocksOf(text);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-\s*insert:\s*$/.test(lines[i])) continue;
    const next = lines[i + 1];
    if (next === undefined || !/^\s+\S/.test(next)) problems.push(`第 ${i + 1} 行：- insert: 是空块（= duplicate loader entry 风险）`);
  }
  const innerIds = blocks.filter(isInnerBlock).map((b) => b.id);
  const topIds = blocks.filter((b) => !isInnerBlock(b)).map((b) => b.id);
  for (const id of innerIds) {
    if (topIds.includes(id)) problems.push(`id "${id}" 同时存在于 insert 内层与顶层（= duplicate loader entry）`);
  }
  const dup = innerIds.filter((id, i) => innerIds.indexOf(id) !== i);
  for (const id of new Set(dup)) problems.push(`insert 内层 id "${id}" 重复`);
  return { ok: problems.length === 0, problems };
}

/**
 * 双边同步的写事务：读 → 合并 → CAS → 原子写 → 校验 → (失败) 回滚。
 *
 * @param {string} profileDir
 * @param {(cfg: object) => {patch?: string, pkgText?: string, summary: string}} mutator
 *        基于「刚读到的」配置产出新文本；只改自己管理的部分。
 * @returns {{ok: boolean, changed: boolean, summary?: string, error?: string,
 *            snapshot?: string, attempts: number, problems?: string[]}}
 */
export function commitProfileConfig(profileDir, mutator) {
  for (let attempt = 1; attempt <= CAS_RETRIES; attempt += 1) {
    const before = readProfileConfig(profileDir);
    let produced;
    try {
      produced = mutator(before);
    } catch (err) {
      return { ok: false, changed: false, error: '合并阶段异常：' + String(err && err.message ? err.message : err), attempts: attempt };
    }
    if (!produced) return { ok: false, changed: false, error: '合并阶段未产出结果', attempts: attempt };

    const nextPatch = produced.patch === undefined ? before.patchText : produced.patch;
    const nextPkg = produced.pkgText === undefined ? before.pkgText : produced.pkgText;
    const patchChanged = nextPatch !== before.patchText;
    const pkgChanged = nextPkg !== before.pkgText;
    if (!patchChanged && !pkgChanged) {
      return { ok: true, changed: false, summary: produced.summary || '无变化', attempts: attempt };
    }

    // 写前校验：坏内容绝不落盘。
    if (patchChanged) {
      const v = validatePatchText(nextPatch);
      if (!v.ok) return { ok: false, changed: false, error: '校验失败，已放弃写入：' + v.problems.join('；'), attempts: attempt, problems: v.problems };
    }
    if (pkgChanged) {
      try { JSON.parse(nextPkg); } catch (err) {
        return { ok: false, changed: false, error: 'package.json 产出不可解析，已放弃写入', attempts: attempt };
      }
    }

    // CAS：确认磁盘仍是刚才读到的版本（双边同步 —— 外部改动不会被覆盖）。
    const now = readProfileConfig(profileDir);
    if (now.revision.patch !== before.revision.patch || now.revision.pkg !== before.revision.pkg) {
      if (attempt < CAS_RETRIES) continue; // 有外部写入 → 重读重合并
      return { ok: false, changed: false, error: '磁盘配置在写入前被外部修改，已重试 ' + CAS_RETRIES + ' 次仍冲突，本次放弃（未覆盖任何外部改动）', attempts: attempt };
    }

    const snap = snapshotProfileConfig(profileDir, Date.now());
    try {
      if (patchChanged) writeAtomic(before.patchPath, nextPatch);
      if (pkgChanged) writeAtomic(before.pkgPath, nextPkg);
    } catch (err) {
      restoreSnapshot(snap);
      return { ok: false, changed: false, error: '写入失败：' + String(err && err.message ? err.message : err), attempts: attempt };
    }

    // 写后复核：落盘内容必须与产出一致且可解析。
    const after = readProfileConfig(profileDir);
    const okPatch = !patchChanged || after.patchText === nextPatch;
    const okPkg = !pkgChanged || after.pkgText === nextPkg;
    if (okPatch && okPkg && (!patchChanged || validatePatchText(after.patchText).ok)) {
      return {
        ok: true,
        changed: true,
        summary: produced.summary || '已写入',
        snapshot: snap ? snap.files.map((f) => f.snap).join(', ') : null,
        attempts: attempt,
      };
    }
    restoreSnapshot(snap);
    return { ok: false, changed: false, error: '写后复核不通过，已回滚到操作前快照', attempts: attempt };
  }
  return { ok: false, changed: false, error: 'CAS 重试耗尽', attempts: CAS_RETRIES };
}

/** 列出 profile 根目录下本层产生的配置快照（供还原接口使用）。 */
export function listConfigSnapshots(profileDir) {
  const out = [];
  for (const name of [PKG_FILE, PATCH_FILE]) {
    const prefix = join(profileDir, name) + '.mkts-snapshot-';
    try {
      for (const entry of fs.readdirSync(profileDir)) {
        if (!entry.startsWith(name + '.mkts-snapshot-')) continue;
        const full = join(profileDir, entry);
        const st = fs.statSync(full);
        out.push({
          file: name,
          path: full,
          stamp: entry.slice((name + '.mkts-snapshot-').length),
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
    } catch { /* 目录不可读 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 从指定快照还原一个文件（显式调用；本层不自动删快照）。 */
export function restoreConfigSnapshot(profileDir, stamp, file) {
  const src = join(profileDir, file === PATCH_FILE ? PATCH_FILE : PKG_FILE);
  const snap = src + '.mkts-snapshot-' + String(stamp);
  if (!fs.existsSync(snap)) return { ok: false, error: '快照不存在：' + snap };
  try {
    const text = fs.readFileSync(snap, 'utf8');
    if (src.endsWith(PKG_FILE)) JSON.parse(text); // 还原前校验
    else {
      const v = validatePatchText(text);
      if (!v.ok) return { ok: false, error: '快照内容不合法：' + v.problems.join('；') };
    }
    writeAtomic(src, text);
    return { ok: true, restored: src, from: snap };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

'use strict';
// ---------------------------------------------------------------------------
// 纯文本手术：web profile 的 cordis.patch.yml 中某个插件的用户层 disabled 条目
// 开关。不改写文件其它内容/注释（保留格式与用户手写条目）。
//
//   关闭 —— 先从任何 `- insert:` 块内移除该 id 的内层条目（避免 loader 双登记
//           崩溃），再保证存在一个顶层 `- id: <id>` 条目且带 `disabled: true`；
//           顶层条目已存在（如 llm-deepseek）则就地补 disabled 行。
//   启用 —— insert 内层条目与顶层条目都移除 `disabled` 行；无 config 的顶层
//           条目保留为裸条目 {id, name}（EAC 修改：默认禁用的配套插件被用户
//           启用后，不被下次 sync 重新插回 disabled 行）。
//
// EAC 重写说明（相对上游 dsh_desktop 版本）：上游用「贪婪正则整块匹配」定位
// 条目块，续行模式 (?:[ \t]+[^\n]*\n)* 会连后续兄弟条目一起吞掉（禁用中位/
// 首位条目时，其后的条目被整块误删，实测复现且可用回溯绕过先行断言）。
// 这里改为逐行扫描：条目块 = `- id:` 行 + 其后所有缩进更深的属性行，天然
// 不会越过下一个兄弟条目。
// ---------------------------------------------------------------------------

// loader 条目 id 的白名单：普通标识符（连字符/下划线/点）。防注入：
// id 会被拼进匹配与 YAML 文本，禁止空白、引号、冒号等特殊字符。
const ID_RE = /^[A-Za-z0-9_.-]+$/;

/** YAML 单引号串转义：单引号加倍（''）。 */
function yamlQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// split('\n') 会在 Windows 文本中保留行尾 \r；显式接纳它，避免逐行
// 解析返回 null。首行 BOM 也可能出现在用户/PowerShell 写入的 patch 中。
const LEADING = /^([ \t]*)(.*)\r?$/;

/** 行是否是指定 id 的条目起始行；返回缩进宽度，否则 null。indentLo/Hi 限定层级。 */
function entryIndentOf(line, id, indentLo, indentHi) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('^- id:\\s*' + escapedId + '(?![A-Za-z0-9_.-])').exec(line.replace(/^\uFEFF/, '').replace(/^[ \t]+/, ''));
  if (!m) return null;
  const ind = LEADING.exec(line)[1].length;
  if (ind < indentLo || ind > indentHi) return null;
  return ind;
}

/**
 * 行是否是指定 id 的「空块项 + 独立 id」条目起始行（dsh 官方 patch 常用写法）：
 *     -
 *         id: <id>
 *         name: '…'
 * 即一行只有 `-`（无内联内容），其后的非空行若以 `id: <id>` 开头即命中。
 * 返回空块项 `-` 行的缩进（作为条目块语义缩进；id/name 行都更深），
 * 否则 null；indentLo/Hi 限定该空块项层级。
 */
function dashEntryIndentOf(lines, i, id, indentLo, indentHi) {
  const line = lines[i];
  const [, dashWs, dashRest] = LEADING.exec(line);
  if (!/^-\s*$/.test(dashRest.replace(/^\uFEFF/, ''))) return null; // 不是纯 `-` 空块项
  const next = lines[i + 1];
  if (next === undefined) return null;
  const [, nextWs, nextRest] = LEADING.exec(next);
  const trimmed = nextRest.replace(/^[ \t]+/, '');
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('^id:\\s*' + escapedId + '(?![A-Za-z0-9_.-])').exec(trimmed);
  if (!m) return null;
  const dashIndent = dashWs.length;
  const idIndent = nextWs.length;
  // 空块项必须浅于 id 行（id/name 都是它的内容）
  if (idIndent <= dashIndent) return null;
  if (dashIndent < indentLo || dashIndent > indentHi) return null;
  return dashIndent;
}

/**
 * 在行数组中定位第一个满足层级的 `<id>` 条目块。支持两种书写等价格式：
 *   ① `- id: <id>`        —— EAC sync 单行写形；
 *   ② `-` 空块项 + 独立 `id:` 行 —— dsh 官方 profile 的多行写形。
 * 返回 { start, end, indent }（end 为独占下界）：块 = 起始行 + 其后所有
 * 缩进足够深的属性行（空行视为块结束，保守不吞）。
 */
function findEntryBlock(lines, id, indentLo, indentHi) {
  for (let i = 0; i < lines.length; i++) {
    let ind = entryIndentOf(lines[i], id, indentLo, indentHi);
    let blockStart = i;
    if (ind === null) {
      const d = dashEntryIndentOf(lines, i, id, indentLo, indentHi);
      if (d === null) continue;
      ind = d;
      blockStart = i; // `-` 空块项行
      i += 1; // 下一行（id 行）纳入块
    }
    let j = i + 1;
    while (j < lines.length) {
      const [, ws, rest] = LEADING.exec(lines[j]);
      if (!rest) break; // 空行：块结束
      if (ws.length <= ind) break; // 兄弟条目或外层结构：块结束
      j += 1;
    }
    return { start: blockStart, end: j, indent: ind };
  }
  return null;
}

/** 块内属性行（缩进 > 条目缩进）里第一个匹配 /^[ \t]*key\s*:/ 的行下标。 */
function findPropLine(lines, block, keyRe) {
  for (let i = block.start + 1; i < block.end; i++) {
    if (keyRe.test(lines[i])) return i;
  }
  return -1;
}

/**
 * @param {string} text    patch 文件全文
 * @param {string} id      条目 id（白名单字符集）
 * @param {boolean} enabled true=启用（移除 disabled 覆盖），false=关闭
 * @param {string} [name]  包名（关闭时顶层条目需要）
 * @returns {string} 手术后的全文
 */
function togglePluginInPatch(text, id, enabled, name) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (typeof id !== 'string' || !id) throw new TypeError('id must be a non-empty string');
  if (!ID_RE.test(id)) throw new TypeError('id 含非法字符（仅允许字母/数字/下划线/点/连字符）: ' + id);
  const pkgName = typeof name === 'string' && name ? name : id;
  const disabledPropRe = /^[ \t]*disabled\s*:\s*(?:true|false)\s*(?:#.*)?$/;
  const namePropRe = /^[ \t]*name\s*:/;

  let lines = text.split('\n');

  if (!enabled) {
    // 1) 从 insert 块内移除内层条目（缩进 >= 1 视为内层；同一 id 只留一个登记点）
    let inner = findEntryBlock(lines, id, 1, Infinity);
    if (inner) lines.splice(inner.start, inner.end - inner.start);
    // 1.5) 清理被掏空的孤立 `- insert:` 空块
    lines = lines.filter((line, idx) => {
      if (!/^[ \t]*- insert:\s*$/.test(line)) return true;
      let k = idx + 1;
      while (k < lines.length && lines[k].trim() === '') k += 1;
      return k < lines.length && /^[ \t]+- /.test(lines[k]);
    });
    // 2) 顶层条目（缩进 0-2）：存在则确保 disabled: true；不存在则追加
    const top = findEntryBlock(lines, id, 0, 2);
    if (top) {
      if (findPropLine(lines, top, disabledPropRe) === -1) {
        const nameIdx = findPropLine(lines, top, namePropRe);
        const insertAt = nameIdx >= 0 ? nameIdx + 1 : top.start + 1;
        lines.splice(insertAt, 0, '  disabled: true');
      }
    } else {
      // 追加前先清掉历史遗留的标记注释（避免反复开关时注释堆积）
      lines = lines.filter((l) => !new RegExp('# [^\\n]*关闭 ' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_.-])').test(l));
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', '# 插件管理（设置页「插件」栏）：关闭 ' + id, '- id: ' + id, '  name: ' + yamlQuote(pkgName), '  disabled: true');
    }
    return lines.join('\n');
  }

  // 启用：insert 内层条目与顶层条目都移除 disabled 属性行；顶层无 config
  // 时保留裸条目 {id, name}（见文件头说明）；标记注释仍清理。
  for (const range of [[1, Infinity], [0, 2]]) {
    for (;;) {
      const block = findEntryBlock(lines, id, range[0], range[1]);
      if (!block) break;
      const idx = findPropLine(lines, block, disabledPropRe);
      if (idx === -1) break;
      lines.splice(idx, 1);
    }
  }
  lines = lines.filter((l) => !new RegExp('# [^\\n]*关闭 ' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_.-])').test(l));
  return lines.join('\n');
}

/**
 * 从 patch 中彻底移除某插件的全部登记点：顶层条目（缩进 0-2）+ insert 内层
 * 条目（缩进 >=1）+ 关闭标记注释；顺带清理被掏空的孤立 `- insert:` 空块。
 * 用于「移除内置插件」（区别于 toggle 的禁用——移除后 sync 不再写回该行）。
 */
function removePluginFromPatch(text, id) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (typeof id !== 'string' || !id) throw new TypeError('id must be a non-empty string');
  if (!ID_RE.test(id)) throw new TypeError('id 含非法字符（仅允许字母/数字/下划线/点/连字符）: ' + id);
  let lines = text.split('\n');
  // 先删内层（insert 块内），再删顶层；同一 id 的所有登记点都移除
  for (const range of [[1, Infinity], [0, 2]]) {
    for (;;) {
      const block = findEntryBlock(lines, id, range[0], range[1]);
      if (!block) break;
      lines.splice(block.start, block.end - block.start);
    }
  }
  lines = lines.filter((line, idx) => {
    if (!/^[ \t]*- insert:\s*$/.test(line)) return true;
    let k = idx + 1;
    while (k < lines.length && lines[k].trim() === '') k += 1;
    return k < lines.length && /^[ \t]+- /.test(lines[k]);
  });
  lines = lines.filter((l) => !new RegExp('# [^\\n]*关闭 ' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_.-])').test(l));
  return lines.join('\n');
}

/**
 * patch 文本里是否已登记 `id: <id>`（顶层条目或 insert 内层条目）。
 * 用于 syncCompanionPlugins / restoreCompanionPlugin 的「已有行不重写」判定。
 * 负向断言 (?![A-Za-z0-9_.-]) 防止前缀误匹配：dsh-pet 不得命中
 * `- id: dsh-pet-settings` 这类兄弟条目（旧 `\b` 词边界会命中）。
 */
function hasEntryId(text, id) {
  if (typeof text !== 'string' || !text || typeof id !== 'string' || !id) return false;
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('id:\\s*' + escapedId + '(?![A-Za-z0-9_.-])').test(text);
}

module.exports = { togglePluginInPatch, removePluginFromPatch, hasEntryId };

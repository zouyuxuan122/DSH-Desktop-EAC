'use strict';

import fs from 'node:fs';

// 插件安装前的轻量冲突预检（v4.2，用户反馈问题 3）。
// 目的：两个插件互相影响时在安装前就拦住 / 提醒，而不是装完才发现
// 「插件装了但没用 / 另一个插件挂了」。
// 只读 profile 配置面（package.json / cordis.patch.yml /
// .dsh-builtin-plugins.json / node_modules 里已装包的 manifest），
// 绝不执行插件代码，绝不写盘。
//
// 分级（与用户确认的语义一致）：
//   refuse —— 直接拒绝安装（skipCheck 勾选后可强制，风险自负）；
//   warn   —— 可安装，但弹窗红字列出，用户自行决定。
// 与试装验证互补：试装验证的是「能不能启动」，这里查的是「会不会互相踩」。

// 需要版本一致的「核心共享依赖」前缀/名单 —— 这些都是 dsh 内核级包，
// 两个插件各带一份不同版本会让 Symbol 身份/单例失效。
const CORE_SHARED_PREFIX = '@deepseek-ai/';
const CORE_SHARED_NAMES = new Set(['koffi', 'schemastery', 'js-yaml', 'zod', 'nanoid']);

function isCoreShared(name) {
  const n = String(name || '');
  return n.startsWith(CORE_SHARED_PREFIX) || CORE_SHARED_NAMES.has(n);
}

function rowNameOf(line) {
  const m = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(String(line || ''));
  return m ? m[1] : null;
}

/** 解析 cordis.patch.yml 的顶层与 insert 内层行 → [{ id, name|null }]。 */
export function parsePatchRows(patchText) {
  const rows = [];
  let pendingId = null;
  for (const line of String(patchText || '').split(/\r?\n/)) {
    const idm = /^\s*-\s*id:\s*([\w.-]+)\s*$/.exec(line);
    if (idm !== null) {
      if (pendingId !== null) rows.push({ id: pendingId, name: null });
      pendingId = idm[1];
      continue;
    }
    if (pendingId !== null) {
      const name = rowNameOf(line);
      if (name !== null) {
        rows.push({ id: pendingId, name });
        pendingId = null;
        continue;
      }
      if (/^\s*-\s*insert:/.test(line)) {
        rows.push({ id: pendingId, name: null });
        pendingId = null;
      }
    }
  }
  if (pendingId !== null) rows.push({ id: pendingId, name: null });
  return rows;
}

/**
 * 收集 profile 的安装态（只读）。
 * @param {string} profileDir - profile 目录（…/profiles/<name>）
 * @returns {{ builtinNames: string[], bundles: string[], dependencies: object,
 *             patchRows: {id,name|null}[], installed: {name, manifest}[] }}
 */
export function collectProfileState(profileDir) {
  const state = { builtinNames: [], bundles: [], dependencies: {}, patchRows: [], installed: [] };
  try {
    const pkg = JSON.parse(fs.readFileSync(profileDir + '/package.json', 'utf8'));
    state.dependencies = (pkg && pkg.dependencies) || {};
    state.bundles = (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles : [];
  } catch {}
  try {
    const marker = JSON.parse(fs.readFileSync(profileDir + '/.dsh-builtin-plugins.json', 'utf8'));
    if (Array.isArray(marker.names)) state.builtinNames = marker.names.filter((n) => typeof n === 'string');
  } catch {}
  try {
    state.patchRows = parsePatchRows(fs.readFileSync(profileDir + '/cordis.patch.yml', 'utf8'));
  } catch {}
  for (const name of Object.keys(state.dependencies)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(profileDir + '/node_modules/' + name + '/package.json', 'utf8'));
      state.installed.push({ name, manifest });
    } catch { /* 包未落地（锁文件状态），跳过 */ }
  }
  return state;
}

/**
 * 候选插件 vs profile 安装态的冲突预检。
 * @param {object} candidate - { name, spec, manifest, patchText }
 * @param {object} profile - collectProfileState 的输出
 * @returns {{ level: 'ok'|'warn'|'refuse', issues: {code, severity, message}[] }}
 */
export function scanCandidate(candidate, profile) {
  const issues = [];
  const push = (code, severity, message) => issues.push({ code, severity, message });
  const candName = String((candidate && candidate.name) || '');
  const candSpec = String((candidate && candidate.spec) || '');
  const manifest = (candidate && candidate.manifest && typeof candidate.manifest === 'object') ? candidate.manifest : {};
  const deps = (manifest.dependencies && typeof manifest.dependencies === 'object') ? manifest.dependencies : {};
  const candRows = parsePatchRows((candidate && candidate.patchText) || '');
  const prof = profile || { builtinNames: [], bundles: [], dependencies: {}, patchRows: [], installed: [] };
  const profBundles = Array.isArray(prof.bundles) ? prof.bundles : [];
  const profDeps = prof.dependencies || {};
  const profRows = Array.isArray(prof.patchRows) ? prof.patchRows : [];
  const installed = Array.isArray(prof.installed) ? prof.installed : [];
  const builtins = Array.isArray(prof.builtinNames) ? prof.builtinNames : [];

  // ── refuse 级 ──
  for (const row of candRows) {
    const hit = profRows.find((r) => r.id === row.id);
    if (hit) {
      push('PATCH_DUP_ID', 'refuse',
        `patch 行 id "${row.id}" 与已装插件重复（会以 duplicate loader entry 拖垮整棵插件树）`);
    }
    const nameHit = row.name && profRows.find((r) => r.name === row.name && r.id !== row.id);
    if (nameHit) {
      push('PATCH_DUP_NAME', 'refuse',
        `patch 行 name "${row.name}" 与已装插件（行 ${nameHit.id}）重复，两个插件会互相影响`);
    }
  }
  if (candName && builtins.includes(candName)) {
    push('BUILTIN_COLLISION', 'refuse', `该插件（${candName}）已内置于客户端，无需重复安装`);
  }
  if (candName && profBundles.includes(candName)) {
    push('BUNDLE_COLLISION', 'refuse', `包名 ${candName} 与已装 bundle 重复，会导致模块双实例`);
  }

  // ── warn 级 ──
  if (candName && Object.prototype.hasOwnProperty.call(profDeps, candName)) {
    const old = profDeps[candName];
    if (old !== candSpec) {
      push('DEP_REINSTALL', 'warn',
        `已安装同名包 ${candName}（原 spec: ${old}），重复安装可能互相覆盖，建议先卸载再装`);
    }
  }
  const candSettings = (manifest.dsh && manifest.dsh.settings && typeof manifest.dsh.settings === 'object' && manifest.dsh.settings.key)
    ? manifest.dsh.settings.key
    : null;
  if (candSettings) {
    for (const other of installed) {
      const ok = other.manifest && other.manifest.dsh && other.manifest.dsh.settings && other.manifest.dsh.settings.key;
      if (ok === candSettings && other.name !== candName) {
        push('SETTINGS_NS_CLASH', 'warn',
          `settings 命名空间 "${candSettings}" 与已装插件 ${other.name} 冲突，设置页可能互相覆盖`);
        break;
      }
    }
  }
  for (const [depName, range] of Object.entries(deps)) {
    if (!isCoreShared(depName)) continue;
    for (const other of installed) {
      const otherDeps = other.manifest && other.manifest.dependencies ? other.manifest.dependencies : {};
      const otherRange = otherDeps[depName];
      if (otherRange !== undefined && otherRange !== range && other.name !== candName) {
        push('CORE_DEP_CLASH', 'warn',
          `核心共享依赖 ${depName}@${range} 与已装插件 ${other.name} 的 ${depName}@${otherRange} 版本不一致（模块双实例风险）`);
      }
    }
  }

  const level = issues.some((i) => i.severity === 'refuse') ? 'refuse' : (issues.length ? 'warn' : 'ok');
  return { level, issues };
}
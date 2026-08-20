'use strict';
// ---------------------------------------------------------------------------
// 首次启动「内置插件选择向导」—— 纯逻辑层（无 fs / electron 依赖，可直接
// 被 node --test 单元测试）。
//
// 背景：38 个内置插件（COMPANION_PLUGINS，另有 10 个内置皮肤）每次启动被
// syncCompanionPlugins 无条件全量复制 + 注册到 web profile，对只需要其中
// 一部分的用户显得臃肿。本模块只负责「判定 / 目录 / 状态 / 操作清单」四件
// 纯函数事，写盘与 IPC 由 main.js 完成。
// ---------------------------------------------------------------------------

// 核心必装插件（向导中锁定，不可取消勾选）：主界面 / 设置页的底座，卸载会
// 破坏界面。其中 plugin-wizard 是设置页「重新打开向导」的入口，永远在场。
const CORE_PLUGIN_IDS = new Set([
  'balance',
  'file-changes',
  'client-file-changes',
  'terminal',
  'dsh-market-plugin',
  'plugin-manager',
  'plugin-shield',
  'plugin-wizard',
]);

// 向导默认勾选（推荐）：核心之外保留常用增强；重/冷门项（桌宠、第二市场、
// 外观微调、自动压缩、ClawBot 桥、会话浮窗等）默认不勾，用户按需勾选。
const RECOMMENDED_PLUGIN_IDS = new Set([
  'skin-switch',
  'easy-setup',
  'picturereader',
  'soul-md',
  'tdai-memory',
  'mobile-fix',
  'better-sidebar',
  'message-rewind',
  'dock-settings',
  'change-review',
  'dsh-navbar',
  'dsh-session-manager',
  'conversation-tweaks',
  'prompt-custom',
  'third-party-thinking',
  'offpeak',
]);

/**
 * 新老用户判定（纯函数）：
 *   - 已确认过向导（settings.pluginOnboardingDone === true）→ 不再展示
 *   - settings.json 已存在（任意老版本用户）→ 跳过，保持现状全量插件
 *   - web-desktop 专属 profile 已存在（v3.1.0+ 老用户）→ 跳过
 *   - 共享 web profile 已存在（v3.1.0 之前的老用户）→ 跳过
 *   - 其余 → 全新安装用户，需要向导
 *
 * 注意：调用方必须在任何写盘（run-state / migrate 标记 / 稳定端口）之前调用
 * —— settings.json 会在启动早期被迁移流程无条件创建，之后再判断文件存在性
 * 会把全新用户误判成老用户。
 * @param {{ settings: object, settingsFileExists: boolean, profileDirExists: boolean, sharedProfileExists: boolean }} env
 */
function needsPluginOnboarding({ settings, settingsFileExists, profileDirExists, sharedProfileExists }) {
  if (settings && settings.pluginOnboardingDone === true) return false;
  if (settingsFileExists) return false;
  if (profileDirExists) return false;
  if (sharedProfileExists) return false;
  return true;
}

/**
 * 从 patch 条目（顶层裸条目 + `- insert:` 内层条目）+ 注册表默认构建
 * id → 当前是否启用 的映射。
 *   - patch 有该 id 的条目：以条目的 disabled 标志为准；
 *   - 无条目：以注册表默认（p.disabled === true）为准。
 * @param {Array} entries  pluginManagerReadPatch() 的 parsed entries
 * @param {Array} registry COMPANION_PLUGINS（{id, disabled}）
 * @returns {Record<string, boolean>}
 */
function pluginCurrentState(entries, registry) {
  const user = new Map();
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue;
    if (Array.isArray(e.insert)) {
      for (const it of e.insert) {
        if (it && typeof it.id === 'string') user.set(it.id, it.disabled === true);
      }
    } else if (typeof e.id === 'string') {
      user.set(e.id, e.disabled === true);
    }
  }
  const out = {};
  for (const p of registry || []) {
    const u = user.get(p.id);
    out[p.id] = u !== undefined ? !u : !(p.disabled === true);
  }
  return out;
}

/**
 * 计算启停切换操作清单（纯函数，写盘由调用方执行）：
 *   - 核心插件永不产生操作；
 *   - current 为 null（首次向导，patch 行尚未写全）→ 所有非核心插件都写入
 *     显式状态（normalize），这样 sync 的「已有行不重写」规则接住结果，注册
 *     表默认 disabled 的插件（如 dsh-dafeiyu）也不会被 sync 回写 disabled 行；
 *   - current 非 null（二次向导）→ 只切换状态与用户选择不同的插件。
 * @param {Array} registry COMPANION_PLUGINS
 * @param {Set} coreIds    核心锁定 id
 * @param {Set} want       用户最终选择（已 sanitize，含核心）
 * @param {Record<string, boolean>|null} current 当前状态
 * @returns {Array<{id: string, enable: boolean}>}
 */
function buildSelectionOps(registry, coreIds, want, current) {
  const ops = [];
  for (const p of registry || []) {
    if (coreIds.has(p.id)) continue;
    const enable = want.has(p.id);
    if (current && current[p.id] === enable) continue;
    ops.push({ id: p.id, enable });
  }
  return ops;
}

/**
 * 清洗用户提交的选择：只保留注册表内存在的 id；核心 id 恒在集合内。
 * @param {Array} ids      用户提交的勾选列表
 * @param {Array} registry COMPANION_PLUGINS
 * @param {Set} coreIds    核心锁定 id
 * @returns {Set<string>}
 */
function sanitizeSelection(ids, registry, coreIds) {
  const valid = new Set((registry || []).map((p) => p.id));
  const want = new Set();
  for (const x of Array.isArray(ids) ? ids : []) {
    if (typeof x !== 'string' || !valid.has(x)) continue;
    want.add(x);
  }
  for (const c of coreIds || []) want.add(c);
  return want;
}

/**
 * 构建向导目录（纯函数）。describe / dirSize 由调用方注入（读取包描述 /
 * 包目录体积），便于测试。
 * @param {Array} plugins COMPANION_PLUGINS
 * @param {{ coreIds: Set, recommendedIds: Set, describe?: Function, dirSize?: Function }} opts
 * @returns {Array<{id,name,description,core,recommended,registryDisabled,size}>}
 */
function buildCatalog(plugins, { coreIds, recommendedIds, describe, dirSize } = {}) {
  const core = coreIds || CORE_PLUGIN_IDS;
  const rec = recommendedIds || RECOMMENDED_PLUGIN_IDS;
  return (plugins || []).map((p) => ({
    id: p.id,
    name: p.name,
    description: describe ? describe(p.name) : '',
    core: core.has(p.id),
    // 注册表默认禁用的插件（p.disabled: true，如 dsh-pet）不进「推荐」勾选。
    recommended: rec.has(p.id) && p.disabled !== true,
    registryDisabled: p.disabled === true,
    size: dirSize ? dirSize(p.dir || (p.name.includes('/') ? p.name.split('/').pop() : p.name)) : 0,
  }));
}

module.exports = {
  CORE_PLUGIN_IDS,
  RECOMMENDED_PLUGIN_IDS,
  needsPluginOnboarding,
  pluginCurrentState,
  buildSelectionOps,
  sanitizeSelection,
  buildCatalog,
};
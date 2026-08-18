'use strict';

// 插件管理状态合并（v4.2）：把 profile cordis.patch.yml 解析出的 entries
// 合并成管理页 / 桌宠设置可消费的行列表。纯函数，不碰磁盘 —— 磁盘读取在
// main.js 侧完成（pluginManagerReadPatch / profile package.json bundles），
// 便于单元测试直连。
//
// 语义要点（与 main.js 原实现的差异/修复）：
//  · 顶层 `- id: x` 条目与 `- insert:` 内层条目都算登记点；
//  · **任一登记点带 disabled: true 即视为禁用** —— syncCompanionPlugins
//    写默认禁用插件（如 dsh-dafeiyu）用的是 insert 内层形态，v4.2 曾只认
//    顶层条目，导致管理页把 dsh-dafeiyu 错报为「已启用」、host 端 config
//    端点不存在（桌宠加载不出 + 「未连接 DSH Host」）；
//  · hasConfig 仍只读顶层条目：insert 内层的 config 是 sync 的固定形态
//    （如 dsh-pet 行带 config），计入会把管理页开关误锁成不可切换，破坏
//    dsh-pet-settings 桌宠卡片的启停（它走同一个 setEnabled IPC）。

/**
 * @param {Array} entries   cordis.patch.yml 解析出的条目数组
 * @param {object} ctx
 * @param {Array<{id:string,name:string}>} ctx.companion  内置配套插件清单
 * @param {Iterable<string>} [ctx.coreIds]                核心插件 id（不可移除）
 * @param {Iterable<string>} [ctx.removedIds]             用户移除的内置插件 id
 * @param {Record<string,{state?:string}>} [ctx.builtinStates]  内置插件持久化状态
 * @param {(name:string)=>string} [ctx.describe]          包名 → 描述
 * @param {Array<string>} [ctx.bundles]                   profile 的 dsh.profile.bundles
 * @returns {Array<object>} 排序后的插件行
 */
function collectPluginRows(entries, ctx = {}) {
  const companion = Array.isArray(ctx.companion) ? ctx.companion : [];
  const companionById = new Map(companion.map((p) => [p.id, p.name]));
  const companionNames = new Set(companion.map((p) => p.name));
  const coreIds = new Set(ctx.coreIds || []);
  const removedIds = new Set(ctx.removedIds || []);
  const builtinStates = ctx.builtinStates && typeof ctx.builtinStates === 'object'
    ? ctx.builtinStates : {};
  const describe = typeof ctx.describe === 'function' ? ctx.describe : () => '';
  const bundles = Array.isArray(ctx.bundles) ? ctx.bundles : [];

  const insertById = new Map();
  const userById = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.insert)) {
      for (const it of entry.insert) {
        if (it && typeof it.id === 'string') {
          insertById.set(it.id, { name: it.name || '', disabled: it.disabled === true });
        }
      }
    } else if (typeof entry.id === 'string') {
      userById.set(entry.id, {
        name: entry.name || '',
        disabled: entry.disabled === true,
        hasConfig: entry.config !== undefined && entry.config !== null,
      });
    }
  }

  const seen = new Set();
  const rows = [];
  const addRow = (id, name, group, extra) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const user = userById.get(id);
    const insert = insertById.get(id);
    const companionEntry = companion.find((p) => p.id === id) || null;
    // 顶层或 insert 内层任一登记点带 disabled 即禁用（v4.2 修复点）。
    const disabled = !!(user && user.disabled) || !!(insert && insert.disabled);
    const hasConfig = !!(user && user.hasConfig);
    const isUninstalled = !!(companionEntry && builtinStates[id]?.state === 'uninstalled');
    const isRemoved = !!(extra && extra.removed) || isUninstalled;
    const isCore = group === 'core' || !!(extra && extra.core);
    const required = isCore || !!(companionEntry && companionEntry.required);
    const toggleable = !required && !isRemoved && !(hasConfig && !disabled);
    const uninstallable = !!companionEntry && companionEntry.uninstallable !== false && !required;
    rows.push({
      id,
      name: name || id,
      description: describe(name || id),
      enabled: !disabled && !isRemoved,
      state: isRemoved ? 'uninstalled' : (disabled ? 'disabled' : 'installed'),
      source: companionEntry ? 'builtin' : (isCore ? 'core' : 'user'),
      required,
      uninstallable,
      restorable: isRemoved,
      toggleable,
      removable: group === 'companion' && !required && !isCore && !isRemoved,
      removed: isRemoved,
      core: isCore,
      group,
    });
  };
  for (const p of companion) {
    addRow(p.id, p.name, 'companion', { removed: removedIds.has(p.id), core: coreIds.has(p.id) });
  }
  for (const [id, info] of insertById) if (!companionById.has(id)) addRow(id, info.name, 'other');
  for (const [id, u] of userById) if (!companionById.has(id)) addRow(id, u.name, 'other');
  for (const name of bundles) {
    if (companionNames.has(name)) continue;
    const id = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    if (!seen.has(id)) addRow(id, name, 'core');
  }
  const order = { companion: 0, other: 1, core: 2 };
  return rows.sort((a, b) => order[a.group] - order[b.group] || a.id.localeCompare(b.id));
}

module.exports = { collectPluginRows };

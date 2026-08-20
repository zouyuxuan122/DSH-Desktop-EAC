/**
 * plugin-manager-state.ts — 插件管理状态合并（v4.2）（Task 7.1 自
 * plugin-manager-state.js 迁 TS）。
 *
 * 把 profile cordis.patch.yml 解析出的 entries 合并成管理页 / 桌宠设置可
 * 消费的行列表。纯函数，不碰磁盘 —— 磁盘读取在 lib/plugins.ts 侧完成
 * （pluginManagerReadPatch / profile package.json bundles），便于单元测试直连。
 *
 * 语义要点（与 main.js 原实现的差异/修复）：
 *  · 顶层 `- id: x` 条目与 `- insert:` 内层条目都算登记点；
 *  · **任一登记点带 disabled: true 即视为禁用** —— syncCompanionPlugins
 *    写默认禁用插件（如 dsh-dafeiyu）用的是 insert 内层形态，v4.2 曾只认
 *    顶层条目，导致管理页把 dsh-dafeiyu 错报为「已启用」、host 端 config
 *    端点不存在（桌宠加载不出 + 「未连接 DSH Host」）；
 *  · hasConfig 仍只读顶层条目：insert 内层的 config 是 sync 的固定形态
 *    （如 dsh-pet 行带 config），计入会把管理页开关误锁成不可切换，破坏
 *    dsh-pet-settings 桌宠卡片的启停（它走同一个 setEnabled IPC）。
 */

/** patch 条目的最小形状（顶层或 insert 内层）。 */
interface PatchEntryLike {
  id?: unknown;
  name?: unknown;
  disabled?: unknown;
  config?: unknown;
  insert?: unknown;
}

/** 管理页插件行。 */
export interface PluginRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  toggleable: boolean;
  removable: boolean;
  removed: boolean;
  core: boolean;
  group: 'companion' | 'other' | 'core';
}

/** collectPluginRows 的上下文。 */
export interface CollectRowsCtx {
  /** 内置配套插件清单（COMPANION_PLUGINS）。 */
  companion?: Array<{ id: string; name: string }>;
  /** 核心插件 id（不可移除）。 */
  coreIds?: Iterable<string>;
  /** 用户移除的内置插件 id。 */
  removedIds?: Iterable<string>;
  /** 包名 → 描述。 */
  describe?: (name: string) => string;
  /** profile 的 dsh.profile.bundles。 */
  bundles?: string[];
}

/** 把 entries 合并为排序后的插件行列表（companion → other → core）。 */
export function collectPluginRows(entries: unknown[], ctx: CollectRowsCtx = {}): PluginRow[] {
  const companion = Array.isArray(ctx.companion) ? ctx.companion : [];
  const companionById = new Map(companion.map((p) => [p.id, p.name]));
  const companionNames = new Set(companion.map((p) => p.name));
  const coreIds = new Set(ctx.coreIds || []);
  const removedIds = new Set(ctx.removedIds || []);
  const describe = typeof ctx.describe === 'function' ? ctx.describe : (): string => '';
  const bundles = Array.isArray(ctx.bundles) ? ctx.bundles : [];

  const insertById = new Map<string, { name: string; disabled: boolean }>();
  const userById = new Map<string, { name: string; disabled: boolean; hasConfig: boolean }>();
  for (const raw of entries) {
    const entry = raw as PatchEntryLike | null;
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.insert)) {
      for (const it of entry.insert as PatchEntryLike[]) {
        if (it && typeof it.id === 'string') {
          insertById.set(it.id, { name: String(it.name || ''), disabled: it.disabled === true });
        }
      }
    } else if (typeof entry.id === 'string') {
      userById.set(entry.id, {
        name: String(entry.name || ''),
        disabled: entry.disabled === true,
        hasConfig: entry.config !== undefined && entry.config !== null,
      });
    }
  }

  const seen = new Set<string>();
  const rows: PluginRow[] = [];
  const addRow = (id: string, name: string, group: PluginRow['group'], extra?: { removed?: boolean; core?: boolean }): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const user = userById.get(id);
    const insert = insertById.get(id);
    // 顶层或 insert 内层任一登记点带 disabled 即禁用（v4.2 修复点）。
    const disabled = !!(user && user.disabled) || !!(insert && insert.disabled);
    const hasConfig = !!(user && user.hasConfig);
    const isRemoved = !!(extra && extra.removed);
    const isCore = !!(extra && extra.core);
    const toggleable = group !== 'core' && !(hasConfig && !disabled);
    rows.push({
      id,
      name: name || id,
      description: describe(name || id),
      enabled: !disabled && !isRemoved,
      toggleable: toggleable && !isRemoved,
      removable: group === 'companion' && !isCore && !isRemoved,
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
  const order: Record<PluginRow['group'], number> = { companion: 0, other: 1, core: 2 };
  return rows.sort((a, b) => order[a.group] - order[b.group] || a.id.localeCompare(b.id));
}

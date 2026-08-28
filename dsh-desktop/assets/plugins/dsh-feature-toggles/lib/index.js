/**
 * dsh-feature-toggles — host half (no-op).
 *
 * 新增强化功能的启用入口完全由浏览器半边完成（设置页「增强功能」分区：
 * 各卡片开关走 window.dshDesktop.pluginManager 桥，写 profile
 * cordis.patch.yml，与「插件 → 管理」同一语义），本半边仅为让包成为合法
 * bundle。
 */
export const name = 'dsh-feature-toggles';
export const inject = [];
export function apply() {
  // no-op.
}
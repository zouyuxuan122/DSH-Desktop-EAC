/**
 * dsh-settings-groups — host half (no-op).
 *
 * 常规页高级选项折叠完全由浏览器半边完成（设置面板 DOM 与 localStorage 都在
 * 页面里），本半边仅为让包成为合法 bundle。
 */
export const name = 'settings-groups';
export const inject = [];
export function apply() {
  // no-op.
}
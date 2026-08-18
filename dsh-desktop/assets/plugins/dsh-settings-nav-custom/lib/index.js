/**
 * dsh-settings-nav-custom — host half (no-op).
 *
 * 边栏自定义完全由浏览器半边完成（设置面板 DOM 与 localStorage 都在页面
 * 里），本半边仅为让包成为合法 bundle。
 */
export const name = 'settings-nav-custom';
export const inject = [];
export function apply() {
  // no-op.
}
/**
 * dsh-file-drop — host half (no-op).
 *
 * 拖入文件完全由浏览器半边完成（拖放事件在 Web UI 页面里发生），本半边
 * 仅为让包成为合法 bundle。
 */
export const name = 'file-drop';
export const inject = [];
export function apply() {
  // no-op.
}
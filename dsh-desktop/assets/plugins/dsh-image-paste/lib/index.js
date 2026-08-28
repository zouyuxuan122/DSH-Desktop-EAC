/**
 * dsh-image-paste — host half (no-op).
 *
 * 图片粘贴完全由浏览器半边完成（剪贴板读取 + 经 preload 的受控 IPC 把图片
 * 存到临时目录 + 路径提示注入输入框），本半边仅为让包成为合法 bundle。
 */
export const name = 'image-paste';
export const inject = [];
export function apply() {
  // no-op.
}
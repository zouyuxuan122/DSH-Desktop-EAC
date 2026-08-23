/**
 * dsh-file-drop-eac — host half (no-op).
 *
 * 「拖入文件/文件夹到对话」的 EAC 特化版（替代已弃用的 dsh-file-drop）：
 *   · 去掉对图片的接管 —— 拖入图片时本插件什么都不做，交给视觉桥/原生
 *     缩略图处理，避免重复/竞争注入（这是原插件被弃用的起因）；
 *   · 新增对文件夹的接管 —— 识别拖入的是文件夹并给出可操作提示
 *     （浏览器/Electron 出于安全无法把文件夹的磁盘绝对路径交给页面，
 *     故降级为说明 + 替代方案）；
 *   · 保留文本/代码内容注入与二进制/超大文件路径提示。
 *
 * 拖放完全由浏览器半边完成（drop 事件发生在 Web UI 页面里），本半边仅
 * 让包成为合法 bundle。
 */
export const name = 'file-drop-eac';
export const inject = [];
export function apply() {
  // no-op.
}

/**
 * dsh-change-review — host half (no-op).
 *
 * 审核本身由会话里的模型完成（客户端把审核请求作为一条用户消息发进
 * 当前对话），文件清单来自官方 dsh-file-changes 插件的 fileChanges 会话
 * 投影（零写入、零格式变更）。本半边仅为让包成为合法 bundle。
 */
export const name = 'change-review';
export const inject = [];
export function apply() {
  // no-op.
}

/**
 * error-detail.ts — 错误弹窗详情构造器（Task 7.1 自 error-detail.js 迁 TS）。
 *
 * 详情串是用户在弹窗里看到的全部内容，也是「复制日志」按钮放进剪贴板的
 * 内容 —— 必须始终包含完整错误文本与 shell 已知的每个日志位置。
 */

/** 迁移说明：导出面不变（buildErrorDetail）。 */
export function buildErrorDetail(err: unknown, logsDir: string, logFiles: string[] = []): string {
  const e = err as { message?: string; stack?: string } | null | undefined;
  const message = e && e.message ? String(e.message) : String(err || '未知错误');
  const stack = e && e.stack ? String(e.stack) : '';
  const lines = ['错误：' + message];
  if (stack) lines.push('', '堆栈：' + stack);
  lines.push('', '日志目录：' + logsDir);
  for (const f of logFiles) lines.push('日志文件：' + f);
  return lines.join('\n');
}

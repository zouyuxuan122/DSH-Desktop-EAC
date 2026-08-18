'use strict';

// Error dialog detail builder (shared by every desktop error dialog).
// The detail string is what users see in the dialog AND what the
// 「复制日志」 button puts on the clipboard, so it must always contain the
// full error text plus every log location the shell knows about.

function buildErrorDetail(err, logsDir, logFiles = []) {
  const message = (err && err.message) ? String(err.message) : String(err || '未知错误');
  const stack = err && err.stack ? String(err.stack) : '';
  const lines = ['错误：' + message];
  if (stack) lines.push('', '堆栈：' + stack);
  lines.push('', '日志目录：' + logsDir);
  for (const f of logFiles) lines.push('日志文件：' + f);
  return lines.join('\n');
}

module.exports = { buildErrorDetail };
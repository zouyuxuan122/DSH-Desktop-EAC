// dsh-stt — 深度审批响应（迁移自原 client.js L368-382）。
// 识别到审批意图时，DOM 点审批面板的 allow/reject 按钮。

export function respondToApproval(intent) {
  const panel = document.querySelector('[data-approval-key]');
  if (!panel) return false;
  const buttons = panel.querySelectorAll('button');
  let target = null;
  for (let i = 0; i < buttons.length; i++) {
    const txt = (buttons[i].textContent || '').trim();
    if (intent === 'allow' && /允许|同意|Allow|Approve|Allow once|Yes/.test(txt)) { target = buttons[i]; break; }
    if (intent === 'reject' && /拒绝|取消|Reject|Deny|No/.test(txt)) { target = buttons[i]; break; }
  }
  if (!target) return false;
  target.click();
  return true;
}

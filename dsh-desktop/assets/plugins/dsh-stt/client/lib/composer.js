// dsh-stt — composer 草稿读写 + 宿主 inputActions 句柄容器
// （迁移自原 client.js L663-697 与 MicButton 内的 moduleInputActions 赋值）。

// 宿主通过 slot props 注入的输入框操作句柄（setDraft/submit），
// MicButton 渲染时记录，commitPending / handleTranscribed 消费。
let inputActions = null;

export function setInputActions(actions) {
  inputActions = actions || null;
}

export function getInputActions() {
  return inputActions;
}

// 读取当前输入框草稿（DOM value）。避免在组件里条件调用 useInput hook
// 破坏 hook 顺序导致 MicButton 崩溃；这里直接读可见 textarea 的 value。
export function findComposerTextarea() {
  const list = document.querySelectorAll('textarea');
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

export function readComposerDraft() {
  const el = findComposerTextarea();
  return el ? (el.value || '').trim() : '';
}

// 写草稿：优先走 dsh 官方 setDraft（machine state，正确更新 draft/undo/发送态），
// 找不到 actions 时用 React 兼容的原生 value setter 兜底。
export function setComposerDraft(text) {
  const actions = inputActions;
  if (actions && actions.setDraft) {
    try { actions.setDraft(text); return; } catch (e) {}
  }
  const el = findComposerTextarea();
  if (el) {
    try {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      try { el.value = text; } catch (e2) {}
    }
  }
}

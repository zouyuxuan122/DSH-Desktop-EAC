// dsh-stt — 样式注入（迁移自原 client.js L123-164）。
// 原 bundle 在模块加载时立即注入；拆分后由 apply 首屏调用 ensureStyles()。

const CSS =
  ".__stt_root{display:flex;flex-direction:column;gap:10px}" +
  ".__stt_field{display:flex;flex-direction:column;gap:4px}" +
  ".__stt_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
  ".__stt_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
  ".__stt_row{display:flex;align-items:center;gap:8px}" +
  ".__stt_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
  ".__stt_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}" +
  ".__stt_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
  ".__stt_btn:disabled{opacity:.5;cursor:default}" +
  ".__stt_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
  ".__stt_micBtn{width:28px;height:28px;flex:none;cursor:pointer;border:none;border-radius:999px;display:grid;place-items:center;color:var(--dsw-alias-label-secondary);background:transparent;transition:background-color .12s ease;position:relative}" +
  ".__stt_micBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".__stt_micBtnStandby{background:var(--dsw-alias-state-business-primary);color:#fff;animation:__stt_pulse 1.6s ease-in-out infinite}" +
  ".__stt_micBtnRecognizing{background:var(--dsw-alias-state-warn-primary,#e0a800);color:#fff;animation:__stt_pulse 1s ease-in-out infinite}" +
  ".__stt_micBtnArmed{box-shadow:0 0 0 2px var(--dsw-alias-state-success-primary,#2ea043)}" +
  ".__stt_micBtnMissing{color:var(--dsw-alias-label-quaternary,#9aa0a6);opacity:.55}" +
  ".__stt_micBtnMissing:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".__stt_guide{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-warn-primary,#e0a800);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:var(--dsw-alias-label-primary)}" +
  ".__stt_guideBar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;flex:1}" +
  ".__stt_guideBar > div{height:100%;background:var(--dsw-alias-state-business-primary);transition:width .3s linear}" +
  ".__stt_guideBarFail > div{background:var(--dsw-alias-state-error-primary)}" +
  ".__stt_spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:__stt_spin .8s linear infinite}" +
  "@keyframes __stt_pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}" +
  "@keyframes __stt_spin{to{transform:rotate(360deg)}}" +
  ".__stt_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
  ".__stt_statusPulse{font-size:12px;color:var(--dsw-alias-state-business-primary)}" +
  ".__stt_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
  ".__stt_ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#2ea043)}" +
  ".__stt_modelRow{display:flex;align-items:center;gap:8px;font-size:12px}" +
  ".__stt_modelName{flex:1;color:var(--dsw-alias-label-primary)}" +
  ".__stt_modelState{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
  ".__stt_toggle{display:flex;align-items:center;gap:8px}";

const TAG_ID = "dsh-stt/main.css";

export function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector('style[data-plugin-css="' + TAG_ID + '"]') !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-stt";
  tag.dataset.pluginCss = TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

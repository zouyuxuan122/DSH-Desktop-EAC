/**
 * dsh-stt — 语音识别（仅 STT）client 半区。⚠️ 构建产物，勿手改。
 *
 * 源码：client/entry.js（UI 注入入口）+ client/components/*（UI 组件）
 *       + client/lib/*（状态/采集/会话编排）+ src/voice-logic.mjs（纯逻辑，
 *       与 node --test 单测共享同一实现，无双同步）。
 * 修改源码后运行 npm run build 重新生成本文件。
 */
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-stt",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    (function (module, exports, require) {
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/entry.js
var entry_exports = {};
__export(entry_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(entry_exports);
var React5 = __toESM(require("react"), 1);

// client/lib/i18n.js
var NS = "dsh-stt";
var zh = {
  nav: "\u8BED\u97F3\u8BC6\u522B",
  intro: "\u8BED\u97F3\u8BC6\u522B\uFF1A\u70B9\u9EA6\u514B\u98CE\u6253\u5F00\u76D1\u542C\uFF0C\u8BF4\u5524\u9192\u8BCD\u540E\u8BF4\u8BDD\uFF0C\u8BC6\u522B\u6587\u672C\u586B\u8F93\u5165\u6846\uFF1B\u8BF4\u300C\u53D1\u9001\u300D\u76F4\u63A5\u53D1\u9001\u3002",
  micOff: "\u8BED\u97F3\u5173\u95ED",
  micStandby: "\u5F85\u673A \xB7 \u8BF4\u5524\u9192\u8BCD",
  micInput: "\u8F93\u5165\u4E2D",
  micRecognizing: "\u8BC6\u522B\u4E2D",
  micSent: "\u5DF2\u53D1\u9001",
  wakeWords: "\u5524\u9192\u8BCD",
  wakeWordsHint: "\u9017\u53F7\u5206\u9694\u3002\u5F85\u673A\u65F6\u8BF4\u4EFB\u4E00\u5524\u9192\u8BCD\u6FC0\u6D3B",
  device: "\u8F93\u5165\u8BBE\u5907",
  deviceHint: "\u9009\u62E9\u91C7\u96C6\u7528\u7684\u9EA6\u514B\u98CE\uFF1B\u9ED8\u8BA4\u53EF\u80FD\u9009\u9519\u4E3A\u7EBF\u8DEF\u8F93\u5165",
  deviceDefault: "\u7CFB\u7EDF\u9ED8\u8BA4",
  deviceRefresh: "\u5237\u65B0\u8BBE\u5907\u5217\u8868",
  diagTitle: "\u9EA6\u514B\u98CE\u81EA\u6D4B",
  diagHint: "\u70B9\u300C\u5F00\u59CB\u81EA\u6D4B\u300D\u540E\u5BF9\u7740\u9EA6\u514B\u98CE\u8BF4\u8BDD\uFF0C\u6BCF\u53E5\u8BF4\u5B8C\u81EA\u52A8\u8BC6\u522B\uFF0C\u5B9E\u65F6\u663E\u793A\u7ED3\u679C",
  diagStart: "\u5F00\u59CB\u6D4B\u8BD5",
  diagStop: "\u7ED3\u675F\u6D4B\u8BD5",
  diagRecHint: "\u5F55\u97F3\u4E2D\u2026\u5BF9\u7740\u9EA6\u514B\u98CE\u8BF4\u8BDD\uFF0C\u8BC6\u522B\u7ED3\u679C\u5B9E\u65F6\u663E\u793A",
  diagLayer1: "\u8BBE\u5907",
  diagLayer2: "\u7535\u5E73",
  diagLayer3: "\u8BC6\u522B\u7ED3\u679C",
  model: "\u8BC6\u522B\u6A21\u578B",
  modelReady: "\u5DF2\u5C31\u7EEA",
  modelMissing: "\u672A\u4E0B\u8F7D",
  modelDownloading: "\u4E0B\u8F7D\u4E2D",
  modelError: "\u4E0B\u8F7D\u5931\u8D25",
  downloadModels: "\u4E0B\u8F7D\u6A21\u578B",
  modelNeeded: "\u6A21\u578B\u672A\u5C31\u7EEA\uFF0C\u8BF7\u5148\u5728\u8BBE\u7F6E\u4E2D\u4E0B\u8F7D",
  modelGuide: "\u8BED\u97F3\u8BC6\u522B\u6A21\u578B\uFF08\u7EA6 230MB\uFF09\u5C1A\u672A\u4E0B\u8F7D\uFF0C\u70B9\u51FB\u300C\u7ACB\u5373\u4E0B\u8F7D\u300D\u5F00\u59CB\uFF08\u652F\u6301\u65AD\u70B9\u7EED\u4F20\uFF0C\u56FD\u5185\u81EA\u52A8\u5207\u6362\u955C\u50CF\u6E90\uFF09",
  modelGuideDownload: "\u7ACB\u5373\u4E0B\u8F7D",
  modelGuideHide: "\u6682\u4E0D",
  modelDownloadingBar: "\u4E0B\u8F7D\u4E2D {pct}%\uFF08\u53EF\u79BB\u5F00\u6B64\u9875\uFF0C\u540E\u53F0\u7EE7\u7EED\uFF09",
  modelDownloadFailed: "\u4E0B\u8F7D\u5931\u8D25\uFF1A{err}\u3002\u53EF\u70B9\u51FB\u91CD\u8BD5\u6216\u6362\u7F51\u7EDC\u73AF\u5883",
  micModelNeeded: "\u8BC6\u522B\u6A21\u578B\u672A\u4E0B\u8F7D \u2014 \u70B9\u51FB\u67E5\u770B\u4E0B\u8F7D\u5F15\u5BFC",
  engineMissing: "\u8BC6\u522B\u5F15\u64CE\u672A\u5B89\u88C5 \u2014 \u5F53\u524D\u5206\u53D1\u672A\u5305\u542B sherpa-onnx \u5F15\u64CE\uFF0C\u8BF7\u901A\u8FC7\u5B8C\u6574\u5B89\u88C5\u83B7\u53D6",
  micDenied: "\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u8BBE\u7F6E\u4E2D\u5141\u8BB8",
  micTimeout: "\u9EA6\u514B\u98CE\u65E0\u54CD\u5E94\uFF0C\u8BF7\u91CD\u8BD5",
  noSpeak: "\u6CA1\u542C\u6E05\uFF0C\u8BF7\u91CD\u8BF4",
  noDraft: "\u6CA1\u6709\u53EF\u53D1\u9001\u7684\u5185\u5BB9\uFF0C\u8BF7\u5148\u8BF4\u8BDD",
  saveFailed: "\u4FDD\u5B58\u5931\u8D25",
  enabled: "\u5F00\u542F",
  disabled: "\u5173\u95ED",
  approved: "\u5DF2\u5141\u8BB8",
  rejected: "\u5DF2\u62D2\u7EDD",
  placeholder: "\u5F53\u524D\u5524\u9192\u8BCD\uFF1A{w}\u3002\u5BF9\u7740\u9EA6\u514B\u98CE\u8BF4\u53D1\u9001\u5373\u53EF\u53D1\u9001"
};
var en = {
  nav: "Speech to Text",
  intro: "Click mic to listen. Say a wake word, then speak. Text is inserted; say 'send' to send.",
  micOff: "Voice off",
  micStandby: "Standby \xB7 say wake word",
  micInput: "Listening",
  micRecognizing: "Recognizing",
  micSent: "Sent",
  wakeWords: "Wake words",
  wakeWordsHint: "Comma-separated. Any match arms listening.",
  device: "Input device",
  deviceHint: "Pick the microphone to capture from; default may be a line-in",
  deviceDefault: "System default",
  deviceRefresh: "Refresh devices",
  diagTitle: "Microphone test",
  diagHint: "Click Start and speak \u2014 each sentence auto-recognizes, results show live",
  diagStart: "Start test",
  diagStop: "Stop test",
  diagRecHint: "Recording\u2026 speak now, results appear live",
  diagLayer1: "Device",
  diagLayer2: "Level",
  diagLayer3: "Result",
  model: "Model",
  modelReady: "Ready",
  modelMissing: "Not downloaded",
  modelDownloading: "Downloading",
  modelError: "Download failed",
  downloadModels: "Download model",
  modelNeeded: "Model not ready \u2014 download it in settings first",
  modelGuide: "The speech model (~230MB) is not downloaded yet. Click 'Download now' to start (resumable; mirrors used automatically in CN networks)",
  modelGuideDownload: "Download now",
  modelGuideHide: "Later",
  modelDownloadingBar: "Downloading {pct}% (continues in background)",
  modelDownloadFailed: "Download failed: {err}. Retry or switch network",
  micModelNeeded: "Model not downloaded \u2014 click for download guide",
  engineMissing: "ASR engine not installed \u2014 this distribution lacks the sherpa-onnx engine; use a full build",
  micDenied: "Microphone access denied",
  micTimeout: "Microphone timed out, retry",
  noSpeak: "Could not hear clearly, please repeat",
  noDraft: "Nothing to send \u2014 speak some content first",
  saveFailed: "Failed to save",
  enabled: "On",
  disabled: "Off",
  approved: "Approved",
  rejected: "Rejected",
  placeholder: "Wake word: {w}. Say 'send' to submit"
};

// client/lib/styles.js
var CSS = ".__stt_root{display:flex;flex-direction:column;gap:10px}.__stt_field{display:flex;flex-direction:column;gap:4px}.__stt_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}.__stt_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}.__stt_row{display:flex;align-items:center;gap:8px}.__stt_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}.__stt_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}.__stt_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}.__stt_btn:disabled{opacity:.5;cursor:default}.__stt_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}.__stt_micBtn{width:28px;height:28px;flex:none;cursor:pointer;border:none;border-radius:999px;display:grid;place-items:center;color:var(--dsw-alias-label-secondary);background:transparent;transition:background-color .12s ease;position:relative}.__stt_micBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}.__stt_micBtnStandby{background:var(--dsw-alias-state-business-primary);color:#fff;animation:__stt_pulse 1.6s ease-in-out infinite}.__stt_micBtnRecognizing{background:var(--dsw-alias-state-warn-primary,#e0a800);color:#fff;animation:__stt_pulse 1s ease-in-out infinite}.__stt_micBtnArmed{box-shadow:0 0 0 2px var(--dsw-alias-state-success-primary,#2ea043)}.__stt_micBtnMissing{color:var(--dsw-alias-label-quaternary,#9aa0a6);opacity:.55}.__stt_micBtnMissing:hover{background:var(--dsw-alias-interactive-bg-hover)}.__stt_guide{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-warn-primary,#e0a800);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:var(--dsw-alias-label-primary)}.__stt_guideBar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;flex:1}.__stt_guideBar > div{height:100%;background:var(--dsw-alias-state-business-primary);transition:width .3s linear}.__stt_guideBarFail > div{background:var(--dsw-alias-state-error-primary)}.__stt_spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:__stt_spin .8s linear infinite}@keyframes __stt_pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}@keyframes __stt_spin{to{transform:rotate(360deg)}}.__stt_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}.__stt_statusPulse{font-size:12px;color:var(--dsw-alias-state-business-primary)}.__stt_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}.__stt_ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#2ea043)}.__stt_modelRow{display:flex;align-items:center;gap:8px;font-size:12px}.__stt_modelName{flex:1;color:var(--dsw-alias-label-primary)}.__stt_modelState{font-size:11px;color:var(--dsw-alias-label-tertiary)}.__stt_toggle{display:flex;align-items:center;gap:8px}";
var TAG_ID = "dsh-stt/main.css";
function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector('style[data-plugin-css="' + TAG_ID + '"]') !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-stt";
  tag.dataset.pluginCss = TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

// client/lib/state.js
var React = __toESM(require("react"), 1);
var state = {
  micOn: false,
  // 待机开关
  gate: { state: "standby", awakeUntil: 0 },
  // standby=待机 / armed=激活
  phase: "idle",
  // idle | recording | recognizing
  wakeWords: (function() {
    const D = "\u4F60\u597D";
    try {
      let v = localStorage.getItem("dsh-stt-wakewords");
      if (v === "\u4F60\u597D\u5C0F\u52A9\u624B") v = null;
      return v || D;
    } catch (e) {
      return D;
    }
  })(),
  deviceId: (function() {
    try {
      return localStorage.getItem("dsh-stt-device") || "";
    } catch (e) {
      return "";
    }
  })(),
  devices: [],
  diagPhase: "idle",
  // idle | recording（自测独立状态）
  diagLayers: [
    // 3 层实时铺开：设备/电平/识别结果
    { status: "wait", text: "" },
    { status: "wait", text: "" },
    { status: "wait", text: "" }
  ],
  models: {},
  download: {},
  engine: null,
  binary: null,
  error: null,
  recognized: "",
  sent: false,
  lastError: null,
  showGuide: false,
  downloadError: null
};
var listeners = [];
function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach(function(l) {
    try {
      l();
    } catch (e) {
    }
  });
}
function useSttState() {
  const reactState = React.useState(0);
  React.useEffect(function() {
    const i = listeners.push(function() {
      reactState[1](function(c) {
        return c + 1;
      });
    });
    return function() {
      listeners.splice(i - 1, 1);
    };
  }, []);
  return state;
}
function refreshStatus() {
  fetch("/api/dsh-stt/status").then(function(res) {
    return res.json().then(function(s) {
      setState({ models: s.models, download: s.download, engine: s.engine, binary: s.binary, error: null });
    }).catch(function() {
      setState({ status: "init" });
    });
  }).catch(function() {
    setState({ status: "init" });
  });
}
function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  navigator.mediaDevices.enumerateDevices().then(function(list) {
    const inputs = list.filter(function(d) {
      return d.kind === "audioinput" && d.deviceId;
    }).map(function(d) {
      return { id: d.deviceId, label: d.label || "\u8BBE\u5907 " + d.deviceId.slice(0, 8) };
    });
    setState({ devices: inputs });
  }).catch(function() {
  });
}
function requestDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(tmp) {
    if (tmp) {
      tmp.getTracks().forEach(function(t) {
        t.stop();
      });
    }
    refreshDevices();
  }).catch(function() {
  });
}

// client/lib/composer.js
var inputActions = null;
function setInputActions(actions) {
  inputActions = actions || null;
}
function getInputActions() {
  return inputActions;
}
function findComposerTextarea() {
  const list = document.querySelectorAll("textarea");
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}
function readComposerDraft() {
  const el = findComposerTextarea();
  return el ? (el.value || "").trim() : "";
}
function setComposerDraft(text) {
  const actions = inputActions;
  if (actions && actions.setDraft) {
    try {
      actions.setDraft(text);
      return;
    } catch (e) {
    }
  }
  const el = findComposerTextarea();
  if (el) {
    try {
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (e) {
      try {
        el.value = text;
      } catch (e2) {
      }
    }
  }
}

// client/components/MicButton.js
var React2 = __toESM(require("react"), 1);

// src/voice-logic.mjs
var VAD_PARAMS = {
  silenceThreshold: 0.08,
  // 绝对音量下限，防零底噪时阈值过低
  baselineWindowMs: 1e3,
  // 学习底噪的时间窗
  baselineMultiplier: 2,
  // 底噪之上的裕度；越大越不易误触发
  silenceTimeoutMs: 900,
  // 静音判定句末的时长
  minRecordingMs: 350,
  // 短于它的片段丢弃（咳嗽/点击）
  maxRecordingMs: 8e3
  // 超长语音强制截断
};
function voiceThreshold(baseline, params = VAD_PARAMS) {
  return Math.max(params.silenceThreshold, baseline * params.baselineMultiplier);
}
var GATE_PARAMS = {
  followupWakeMs: 1e4
  // 唤醒后免唤醒词窗口
};
var COALESCE_MS = 800;
var HALLUCINATION_RE = /(感谢观看|谢谢观看|谢谢收看|thanks for watching|subscribe to|点赞关注|喜欢本视频)/gi;
var FILLER_RE = /^(嗯|啊|哦|呃|诶|唉|那个|这个|就是|然后|那么|其实|对吧|对吧嘛)\s*/;
function filterText(text) {
  if (!text) return "";
  let t = String(text);
  t = t.replace(HALLUCINATION_RE, " ").replace(/\s+/g, " ").trim();
  t = t.replace(FILLER_RE, "").trim();
  return t;
}
var SEND_PHRASES = ["\u53D1\u9001", "\u53D1\u51FA\u53BB", "\u53D1\u4E00\u4E0B", "send", "sent", "submit"];
function stripSendPhrase(text) {
  const t = String(text || "").trim();
  if (!t) return { text: t, send: false };
  if (/(不要|别|不用|不想|能.{0,3}吗|是否|应该).{0,2}(发送|发出|send)/.test(t)) return { text: t, send: false };
  const base = stripTrailingPunctuation(t);
  const lower = base.toLowerCase();
  for (const phrase of SEND_PHRASES) {
    if (lower.startsWith(phrase)) {
      const rest = base.slice(phrase.length).replace(/^\s+/, "");
      return rest ? { text: rest, send: true } : { text: "", send: true };
    }
    if (lower.endsWith(phrase)) {
      const head = base.slice(0, base.length - phrase.length).replace(/\s+$/, "");
      return head ? { text: head, send: true } : { text: "", send: true };
    }
  }
  return { text: t, send: false };
}
function stripTrailingPunctuation(text) {
  return String(text || "").replace(/[。！？!?.,，、；;：:]+$/g, "").trim();
}
function mergeSegments(parts) {
  const sorted = parts.slice().sort((a, b) => a.seq - b.seq);
  const text = sorted.map((p) => stripTrailingPunctuation(p.text)).join("").replace(/\s+/g, " ").trim();
  return stripTrailingPunctuation(text);
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i * (n + 1) + j] = Math.min(
        dp[(i - 1) * (n + 1) + j] + 1,
        dp[i * (n + 1) + j - 1] + 1,
        dp[(i - 1) * (n + 1) + j - 1] + cost
      );
    }
  }
  return dp[m * (n + 1) + n];
}
function editDistanceIn(text, word, maxDist) {
  const n = text.length, m = word.length;
  if (n < Math.max(1, m - maxDist)) return false;
  for (let i = 0; i < n; i++) {
    for (let len = Math.max(1, m - maxDist); len <= Math.min(n - i, m + maxDist); len++) {
      if (levenshtein(text.slice(i, i + len), word) <= maxDist) return true;
    }
  }
  return false;
}
function shapePatternOf(word) {
  if (/[一-鿿]/.test(word)) return null;
  const CONSONANT = "bcdfghjklmnpqrstvwxyz";
  const VOWEL = "aeiouy";
  let pat = "";
  for (const ch of word.toLowerCase()) {
    if (CONSONANT.includes(ch)) pat += `[${CONSONANT}]`;
    else if (VOWEL.includes(ch)) pat += `[${VOWEL}]`;
    else pat += `\\${ch}`;
  }
  try {
    return new RegExp(pat);
  } catch {
    return null;
  }
}
function isWakeWord(text, wakeWords) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  for (const raw of wakeWords || []) {
    const w = String(raw).trim().toLowerCase();
    if (!w) continue;
    if (/[一-鿿]/.test(w)) {
      if (t.includes(w)) return true;
      continue;
    }
    if (t.includes(w)) return true;
    const shape = shapePatternOf(w);
    if (shape && shape.test(t)) return true;
    if (editDistanceIn(t, w, 2)) return true;
  }
  return false;
}
function stripWakeWord(text, wakeWords) {
  let t = String(text || "").trim();
  for (const raw of wakeWords || []) {
    const w = String(raw).trim();
    if (!w) continue;
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    t = t.replace(re, "");
  }
  return t.replace(/^[，。！？、；：,.\s]+/, "").trim();
}
var ALLOW_RE = /(允许|同意|确认|可以|好的|第一个|选1|approve|allow|yes|ok)/i;
var REJECT_RE = /(拒绝|取消|不要|不用|算了|stop|cancel|no)/i;
function approvalIntent(text) {
  const t = String(text || "").trim();
  if (!t) return { action: null };
  if (REJECT_RE.test(t) && !/(不是|不行|不能|不会)/.test(t)) return { action: "reject" };
  if (ALLOW_RE.test(t)) return { action: "allow" };
  return { action: null };
}
var GATE_EVENTS = { WAKE: "wakeword", UTTER: "utterance", END: "end", MODEL_IDLE: "modelIdle" };
function nextGate(gate, event, now, params = GATE_PARAMS) {
  const g = gate || { state: "standby", awakeUntil: 0 };
  switch (event) {
    case GATE_EVENTS.WAKE:
      return { state: "armed", awakeUntil: now + params.followupWakeMs };
    case GATE_EVENTS.UTTER:
      return g.state === "armed" ? { state: "armed", awakeUntil: Math.max(g.awakeUntil, now + params.followupWakeMs) } : g;
    case GATE_EVENTS.END:
      return { state: "standby", awakeUntil: 0 };
    case GATE_EVENTS.MODEL_IDLE:
      return g.state === "armed" ? { state: "armed", awakeUntil: now + params.followupWakeMs } : g;
    default:
      return g;
  }
}
function gateArmed(gate, now) {
  return gate && gate.state === "armed" && now < gate.awakeUntil;
}

// client/lib/audio.js
var MIC_TIMEOUT_MS = 3e3;
function decodeToPcm16(arrayBuffer, sampleRate) {
  return new Promise(function(resolve, reject) {
    const audioCtx = new AudioContext({ sampleRate: 16e3 });
    audioCtx.decodeAudioData(arrayBuffer, function(audioBuffer) {
      const src = audioBuffer.getChannelData(0);
      const targetRate = 16e3;
      const out = new Float32Array(Math.ceil(src.length * targetRate / (audioBuffer.sampleRate || sampleRate)));
      const ratio = src.length / out.length;
      for (let i = 0; i < out.length; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, src.length - 1);
        const frac = pos - i0;
        out[i] = src[i0] * (1 - frac) + src[i1] * frac;
      }
      audioCtx.close();
      resolve(out);
    }, function(err) {
      audioCtx.close();
      reject(err);
    });
  });
}
function f32ToWav(samples) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  function writeStr(offset2, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset2 + i, str.charCodeAt(i));
  }
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16e3, true);
  view.setUint32(28, 16e3 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
function postWavForTranscribe(wav) {
  const fd = new FormData();
  fd.append("audio", wav, "speech.wav");
  return fetch("/api/dsh-stt/transcribe", { method: "POST", body: fd }).then(function(res) {
    return res.json().catch(function() {
      return {};
    });
  });
}
function getUserMediaWithTimeout(constraints) {
  const gum = navigator.mediaDevices.getUserMedia({ audio: constraints });
  const timer = new Promise(function(_, reject) {
    setTimeout(function() {
      reject(new Error("mic-timeout"));
    }, MIC_TIMEOUT_MS);
  });
  return Promise.race([gum, timer]);
}

// client/lib/capture.js
var BASELINE_FRAMES = Math.max(1, Math.round(VAD_PARAMS.baselineWindowMs / 30));
function createCaptureCore(opts) {
  let stream = null, audioCtx = null, analyser = null, data = null, source = null;
  let recorder = null, chunks = [];
  let baseline = 0, baseFrames = 0;
  let recording = false, recStart = 0, lastVoiceAt = 0;
  let timerId = 0, active = false;
  let generation = 0;
  let segSeq = 0;
  function start() {
    if (active) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error("getUserMedia unavailable"));
    }
    const audioCfg = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (opts.deviceId) {
      audioCfg.deviceId = { exact: opts.deviceId };
    }
    return getUserMediaWithTimeout(audioCfg).then(function(s) {
      stream = s;
      const tk = s.getAudioTracks()[0];
      if (opts.onDeviceReady) opts.onDeviceReady(tk && tk.label);
      audioCtx = new AudioContext();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(function() {
        });
      }
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      data = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      active = true;
      timerId = setInterval(frame, 30);
    });
  }
  function stop() {
    active = false;
    generation++;
    if (timerId) {
      clearInterval(timerId);
      timerId = 0;
    }
    if (recorder && recording) {
      try {
        recorder.stop();
      } catch (e) {
      }
    }
    if (stream) {
      stream.getTracks().forEach(function(t) {
        t.stop();
      });
      stream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(function() {
      });
      audioCtx = null;
    }
  }
  function frame() {
    if (!active) return;
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const lvl = sum / data.length / 255;
    const now = performance.now();
    if (opts.onLevel) opts.onLevel(lvl, now, recording, recStart);
    const thr = voiceThreshold(baseline);
    if (!recording) {
      if (baseFrames < BASELINE_FRAMES) {
        baseline = baseline === 0 ? lvl : baseline * 0.9 + lvl * 0.1;
        baseFrames++;
      }
      if (lvl > thr) startRecording(now);
    } else {
      if (lvl > thr) lastVoiceAt = now;
      else if (now - lastVoiceAt > VAD_PARAMS.silenceTimeoutMs) {
        stopRecording();
      } else if (now - recStart > VAD_PARAMS.maxRecordingMs) {
        stopRecording();
      }
    }
  }
  function startRecording(now) {
    recording = true;
    recStart = now;
    lastVoiceAt = now;
    chunks = [];
    if (opts.onRecordingStart) opts.onRecordingStart();
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : void 0);
    recorder.ondataavailable = function(e) {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = onRecordingStopped;
    recorder.start(100);
  }
  function stopRecording() {
    recording = false;
    if (recorder) {
      try {
        recorder.stop();
      } catch (e) {
      }
    }
  }
  function onRecordingStopped() {
    const duration = performance.now() - recStart;
    recorder = null;
    const tooShort = duration < VAD_PARAMS.minRecordingMs;
    if (opts.onRecordingStop) opts.onRecordingStop(tooShort);
    if (tooShort) return;
    const myGen = generation;
    const mySeq = segSeq++;
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const blob = new Blob(chunks, { type: mime || "audio/webm" });
    blob.arrayBuffer().then(function(ab) {
      return decodeToPcm16(ab, 48e3).then(f32ToWav);
    }).then(function(wav) {
      return postWavForTranscribe(wav);
    }).then(function(r) {
      if (myGen !== generation) return;
      if (opts.onTranscript) opts.onTranscript(filterText(r.text || ""), mySeq);
    }).catch(function(e) {
      if (myGen !== generation) return;
      if (opts.onError) opts.onError(e && e.message || String(e));
    });
  }
  return { start, stop };
}

// client/lib/approval.js
function respondToApproval(intent) {
  const panel = document.querySelector("[data-approval-key]");
  if (!panel) return false;
  const buttons = panel.querySelectorAll("button");
  let target = null;
  for (let i = 0; i < buttons.length; i++) {
    const txt = (buttons[i].textContent || "").trim();
    if (intent === "allow" && /允许|同意|Allow|Approve|Allow once|Yes/.test(txt)) {
      target = buttons[i];
      break;
    }
    if (intent === "reject" && /拒绝|取消|Reject|Deny|No/.test(txt)) {
      target = buttons[i];
      break;
    }
  }
  if (!target) return false;
  target.click();
  return true;
}

// client/lib/diag.js
var diagController = null;
function setLayer(i, status, text) {
  const layers = state.diagLayers.slice();
  layers[i] = { status, text };
  setState({ diagLayers: layers });
}
function diagStart() {
  if (state.diagPhase !== "idle") return;
  if (getController()) stopMic();
  setState({
    diagPhase: "recording",
    diagLayers: [
      { status: "live", text: "\u6253\u5F00\u4E2D\u2026" },
      { status: "live", text: "0%" },
      { status: "wait", text: "" }
    ]
  });
  diagController = createCaptureCore({
    deviceId: state.deviceId,
    onDeviceReady: function(label) {
      setLayer(0, "ok", label || "\u5DF2\u6253\u5F00");
    },
    onLevel: function(lvl) {
      const bar = document.getElementById("dsh-stt-diag-bar");
      const pct = document.getElementById("dsh-stt-diag-pct");
      if (bar) bar.style.width = Math.min(100, lvl * 200) + "%";
      if (pct) pct.textContent = Math.round(lvl * 100) + "%";
    },
    onRecordingStop: function(tooShort) {
      if (tooShort) setLayer(2, "fail", "\u8BF4\u8BDD\u592A\u77ED\uFF0C\u8BF7\u518D\u8BF4\u4E00\u904D");
      else setLayer(2, "live", "\u8BC6\u522B\u4E2D\u2026");
    },
    onTranscript: function(text) {
      setLayer(2, text ? "ok" : "fail", text || "\u6CA1\u542C\u6E05");
    },
    onError: function(msg) {
      setLayer(2, "fail", "\u8BC6\u522B\u5931\u8D25: " + msg);
    }
  });
  diagController.start().catch(function(err) {
    diagController = null;
    setLayer(0, "fail", "\u6253\u5F00\u5931\u8D25: " + (err && err.message || err));
    setState({ diagPhase: "idle" });
  });
}
function diagStop() {
  if (state.diagPhase === "idle") return;
  setState({ diagPhase: "idle" });
  if (diagController) {
    diagController.stop();
    diagController = null;
  }
}

// client/lib/session.js
var controller = null;
var diagController2 = null;
var pending = { parts: [], timer: null };
function getController() {
  return controller;
}
function getWakeWords() {
  return (state.wakeWords || "").split(",").map(function(w) {
    return w.trim();
  }).filter(Boolean);
}
function clearPendingTimer() {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
}
function commitPending(extraText) {
  clearPendingTimer();
  const parts = pending.parts.slice();
  pending.parts = [];
  if (extraText) parts.push({ seq: 1e9, text: extraText });
  if (!parts.length) return;
  const combined = mergeSegments(parts);
  if (!combined) return;
  const existing = readComposerDraft();
  const finalText = existing ? existing + "\uFF0C" + combined : combined;
  setComposerDraft(finalText);
  setState({ recognized: finalText, sent: false, lastError: null, gate: nextGate(state.gate, GATE_EVENTS.UTTER, Date.now()) });
}
function bufferUtterance(text, seq) {
  pending.parts.push({ seq, text });
  clearPendingTimer();
  pending.timer = setTimeout(function() {
    commitPending();
  }, COALESCE_MS);
}
function handleTranscribed(text, seq) {
  if (!text) {
    setState({ lastError: "noSpeak" });
    return;
  }
  const hasApproval = !!document.querySelector("[data-approval-key]");
  if (hasApproval) {
    const intent = approvalIntent(text);
    if (intent.action) {
      const done = respondToApproval(intent.action);
      if (done) {
        setState({ recognized: intent.action === "allow" ? "approved" : "rejected", sent: false, lastError: null, gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()) });
        clearPendingTimer();
        pending.parts = [];
        return;
      }
    }
    setState({ gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()), lastError: null });
    return;
  }
  const stripped = stripSendPhrase(text);
  if (stripped.send) {
    const actions0 = getInputActions();
    if (actions0 && actions0.submit) {
      const allParts = pending.parts.slice();
      clearPendingTimer();
      pending.parts = [];
      const combined = mergeSegments(stripped.text ? allParts.concat([{ seq: 1e9, text: stripped.text }]) : allParts);
      if (combined) setComposerDraft(combined);
      const effective = combined || readComposerDraft() || "";
      if (!effective) {
        setState({ recognized: "", sent: false, lastError: "noDraft", gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()) });
        return;
      }
      setState({ recognized: effective, sent: true, lastError: null, gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()) });
      setTimeout(function() {
        try {
          actions0.submit();
        } catch (e) {
        }
      }, 50);
    }
    return;
  }
  const words = getWakeWords();
  const now = Date.now();
  let gate = state.gate;
  if (gate.state === "armed" && !gateArmed(gate, now)) {
    gate = nextGate(gate, GATE_EVENTS.END, now);
    setState({ gate });
  }
  if (gate.state !== "armed") {
    if (words.length && isWakeWord(text, words)) {
      gate = nextGate(gate, GATE_EVENTS.WAKE, now);
      const rest = stripWakeWord(text, words);
      if (rest) {
        setState({ gate, recognized: stripTrailingPunctuation(rest), sent: false, lastError: null });
        bufferUtterance(stripTrailingPunctuation(rest), seq);
      } else {
        setState({ gate, recognized: "", sent: false, lastError: null });
      }
    }
    return;
  }
  bufferUtterance(stripTrailingPunctuation(text), seq);
  setState({ recognized: stripTrailingPunctuation(text), sent: false, lastError: null });
}
function startMic() {
  if (controller) return;
  if (diagController2) diagStop();
  setState({ micOn: true, lastError: null, phase: "idle", gate: { state: "standby", awakeUntil: 0 } });
  controller = createCaptureCore({
    deviceId: state.deviceId,
    onLevel: function() {
      if (state.gate.state === "armed" && !gateArmed(state.gate, Date.now())) {
        setState({ gate: nextGate(state.gate, GATE_EVENTS.END, Date.now()) });
      }
    },
    onRecordingStart: function() {
      setState({ phase: "recording" });
    },
    onRecordingStop: function(tooShort) {
      setState({ phase: tooShort ? "idle" : "recognizing" });
    },
    onTranscript: function(text, seq) {
      handleTranscribed(text, seq);
      setState({ phase: "idle" });
    },
    onError: function() {
      setState({ phase: "idle", lastError: "noSpeak" });
    }
  });
  controller.start().catch(function(err) {
    controller = null;
    setState({ micOn: false, lastError: err && err.message === "mic-timeout" ? "micTimeout" : "micDenied" });
  });
}
function stopMic() {
  if (controller) {
    controller.stop();
    controller = null;
  }
  clearPendingTimer();
  pending.parts = [];
  setState({ micOn: false, phase: "idle", gate: { state: "standby", awakeUntil: 0 } });
}

// client/components/MicButton.js
var h = React2.createElement;
var MicButton = function(props) {
  const stt = useSttState();
  if (props.inputActions) setInputActions(props.inputActions);
  const tt = function(k) {
    return props.t ? props.t(k) : zh[k];
  };
  const engineMissing = stt.binary === "missing";
  const modelState = stt.models && stt.models.asr || "missing";
  const modelNotReady = !engineMissing && modelState !== "ready";
  function onToggle() {
    if (engineMissing) {
      setState({ lastError: "engineMissing", recognized: "", sent: false });
      return;
    }
    if (modelNotReady) {
      setState({ showGuide: true, lastError: "modelNeeded", recognized: "", sent: false });
      return;
    }
    if (stt.micOn) stopMic();
    else startMic();
  }
  let cls = "__stt_micBtn ";
  let title = tt("micOff");
  if (engineMissing || modelNotReady) {
    cls += "__stt_micBtnMissing";
    title = engineMissing ? tt("engineMissing") : tt("micModelNeeded");
  } else if (stt.micOn) {
    if (stt.phase === "recognizing") {
      cls += "__stt_micBtnRecognizing";
      title = tt("micRecognizing");
      if (stt.gate.state === "armed") cls += " __stt_micBtnArmed";
    } else if (stt.gate.state === "armed") {
      cls += "__stt_micBtnStandby __stt_micBtnArmed";
      title = tt("micInput");
    } else {
      cls += "__stt_micBtnStandby";
      title = tt("micStandby");
    }
  }
  let icon;
  if (engineMissing || modelNotReady) {
    icon = h(
      "svg",
      { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" }),
      h("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
      h("line", { x1: 12, y1: 19, x2: 12, y2: 22 }),
      h("line", { x1: 3, y1: 3, x2: 21, y2: 21 })
    );
  } else if (stt.phase === "recognizing") {
    icon = h("span", { className: "__stt_spinner" });
  } else {
    icon = h(
      "svg",
      { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
      h("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" }),
      h("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
      h("line", { x1: 12, y1: 19, x2: 12, y2: 22 })
    );
  }
  return h("button", {
    type: "button",
    className: cls,
    title,
    "aria-label": title,
    onClick: onToggle
  }, icon);
};

// client/components/ModelGuideBar.js
var React3 = __toESM(require("react"), 1);
var h2 = React3.createElement;
var ModelGuideBar = function(props) {
  const stt = useSttState();
  const tt = function(k) {
    return props.t ? props.t(k) : zh[k];
  };
  const modelState = stt.models && stt.models.asr || "missing";
  const dl = stt.download && stt.download.asr;
  if (modelState === "ready") return null;
  if (!stt.showGuide && !props.always) return null;
  function startDownload() {
    setState({ downloadError: null });
    fetch("/api/dsh-stt/download", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }).then(function(res) {
      return res.json();
    }).then(function(r) {
      if (r && !r.ok) {
        const first = r.results && r.results[0] || {};
        if (first.error !== "downloading") setState({ downloadError: first.error || "unknown" });
      }
      refreshStatus();
    }).catch(function(err) {
      setState({ downloadError: err && err.message || String(err) });
    });
  }
  let body;
  if (modelState === "downloading") {
    const pct = dl && dl.pct != null ? dl.pct : 0;
    body = h2(
      "div",
      { className: "__stt_row", style: { flex: 1 } },
      h2("span", null, tt("modelDownloadingBar").replace("{pct}", pct)),
      h2(
        "div",
        { className: "__stt_guideBar", style: { maxWidth: 220 } },
        h2("div", { style: { width: Math.max(2, pct) + "%" } })
      )
    );
  } else if (modelState === "error") {
    body = h2(
      "div",
      { className: "__stt_row", style: { flex: 1, flexWrap: "wrap" } },
      h2(
        "span",
        { className: "__stt_error", style: { flex: 1, minWidth: 0 } },
        tt("modelDownloadFailed").replace("{err}", (stt.downloadError || dl && dl.error || "").slice(0, 80))
      ),
      h2("button", { className: "__stt_btn __stt_btnPrimary", onClick: startDownload }, tt("modelGuideDownload"))
    );
  } else {
    body = h2(
      "div",
      { className: "__stt_row", style: { flex: 1, flexWrap: "wrap" } },
      h2("span", { style: { flex: 1, minWidth: 0 } }, tt("modelGuide")),
      h2("button", { className: "__stt_btn __stt_btnPrimary", onClick: startDownload }, tt("modelGuideDownload"))
    );
  }
  return h2(
    "div",
    { className: "__stt_guide", role: "status" },
    body,
    h2("button", { className: "__stt_btn", onClick: function() {
      setState({ showGuide: false });
    } }, tt("modelGuideHide"))
  );
};

// client/components/SettingsCard.js
var React4 = __toESM(require("react"), 1);
var h3 = React4.createElement;
var SettingRow = function(props) {
  return h3(
    "div",
    { className: "__stt_field" },
    h3("label", { className: "__stt_label" }, props.label, props.hint && h3("span", { className: "__stt_hint" }, props.hint)),
    props.children
  );
};
var SettingsCard = function(props) {
  const t = props.t;
  useSttState();
  const wakeState = React4.useState(state.wakeWords);
  const wake = wakeState[0];
  const setWake = wakeState[1];
  React4.useEffect(function() {
    refreshDevices();
  }, []);
  function save() {
    const v = (wake || "").trim();
    try {
      localStorage.setItem("dsh-stt-wakewords", v);
    } catch (e) {
    }
    setState({ wakeWords: v, error: null });
  }
  function saveDevice(id) {
    try {
      localStorage.setItem("dsh-stt-device", id || "");
    } catch (e) {
    }
    setState({ deviceId: id || "" });
  }
  function downloadModel() {
    setState({ error: null });
    fetch("/api/dsh-stt/download", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }).then(function(res) {
      return res.json();
    }).then(function() {
      refreshStatus();
    }).catch(function() {
      setState({ error: "saveFailed" });
    });
  }
  const models = state.models || {};
  const modelState = models.asr || "missing";
  const dl = state.download && state.download.asr;
  const modelLabel = modelState === "ready" ? t("modelReady") : modelState === "downloading" ? (dl && dl.pct != null ? dl.pct + "% " : "") + t("modelDownloading") : modelState === "error" ? t("modelError") : t("modelMissing");
  return h3(
    "div",
    { className: "__stt_root" },
    h3("p", { className: "__stt_hint" }, t("intro")),
    h3(
      SettingRow,
      { label: t("wakeWords"), hint: t("wakeWordsHint") },
      h3("input", {
        className: "__stt_input",
        value: wake,
        placeholder: state.wakeWords,
        onChange: function(e) {
          setWake(e.target.value);
        }
      })
    ),
    h3(
      SettingRow,
      { label: t("device"), hint: t("deviceHint") },
      h3(
        "div",
        { className: "__stt_row" },
        h3(
          "select",
          {
            className: "__stt_input",
            value: state.deviceId,
            onChange: function(e) {
              saveDevice(e.target.value);
            }
          },
          h3("option", { value: "" }, t("deviceDefault")),
          (state.devices || []).map(function(d) {
            return h3("option", { key: d.id, value: d.id }, d.label);
          })
        ),
        h3("button", { className: "__stt_btn", onClick: requestDevices }, t("deviceRefresh"))
      )
    ),
    h3(
      SettingRow,
      { label: t("diagTitle"), hint: t("diagHint") },
      h3(
        "div",
        { className: "__stt_root" },
        h3(
          "div",
          { className: "__stt_row" },
          state.diagPhase === "idle" ? h3("button", { className: "__stt_btn __stt_btnPrimary", onClick: diagStart }, t("diagStart")) : h3("button", { className: "__stt_btn __stt_btnPrimary", onClick: diagStop }, t("diagStop")),
          state.diagPhase === "recording" && h3("span", { className: "__stt_statusPulse" }, t("diagRecHint"))
        ),
        (function() {
          const layerNames = [t("diagLayer1"), t("diagLayer2"), t("diagLayer3")];
          function statusChar(st) {
            if (st === "ok") return { ch: "\u2713", cls: "__stt_ok" };
            if (st === "fail") return { ch: "\u2717", cls: "__stt_error" };
            if (st === "live") return { ch: "\u2026", cls: "__stt_statusPulse" };
            return { ch: "\xB7", cls: "__stt_status" };
          }
          return (state.diagLayers || []).map(function(layer, i) {
            const sc = statusChar(layer.status);
            if (i === 1) {
              return h3(
                "div",
                { key: i, className: "__stt_row", style: { alignItems: "center" } },
                h3("span", { className: sc.cls }, sc.ch),
                h3("span", { className: "__stt_label", style: { minWidth: 52 } }, layerNames[i]),
                h3(
                  "div",
                  { style: { flex: 1, height: 6, background: "var(--dsw-alias-bg-layer-3)", borderRadius: 3, overflow: "hidden" } },
                  h3("div", { id: "dsh-stt-diag-bar", style: { width: "0%", height: "100%", background: "var(--dsw-alias-state-business-primary)", transition: "width .1s linear" } })
                ),
                h3("span", { id: "dsh-stt-diag-pct", className: "__stt_status", style: { minWidth: 40, textAlign: "right" } }, layer.text)
              );
            }
            return h3(
              "div",
              { key: i, className: "__stt_row", style: { alignItems: "flex-start" } },
              h3("span", { className: sc.cls }, sc.ch),
              h3("span", { className: "__stt_label", style: { minWidth: 52 } }, layerNames[i]),
              h3("span", { className: "__stt_status" }, layer.text)
            );
          });
        })()
      )
    ),
    h3(
      "div",
      { className: "__stt_row" },
      h3("button", { className: "__stt_btn __stt_btnPrimary", onClick: save }, "\u4FDD\u5B58"),
      state.error && h3("span", { className: "__stt_error" }, t(state.error) || state.error),
      state.lastError && h3("span", { className: "__stt_error" }, t(state.lastError) || state.lastError),
      state.recognized && h3("span", { className: "__stt_ok" }, (state.sent ? t("micSent") : "") + ": " + state.recognized.slice(0, 30))
    ),
    h3(
      SettingRow,
      { label: t("model") },
      h3(
        "div",
        null,
        h3(
          "div",
          { className: "__stt_modelRow" },
          h3("span", { className: "__stt_modelName" }, "ASR"),
          h3("span", { className: "__stt_modelState" }, modelLabel),
          h3("button", { className: "__stt_btn", onClick: downloadModel, disabled: modelState === "ready" }, t("downloadModels"))
        ),
        // 模型未就绪：设置卡内常显引导条（进度/失败原因/重试）
        modelState !== "ready" && h3(ModelGuideBar, { t, always: true })
      )
    )
  );
};

// client/entry.js
var h4 = React5.createElement;
var inject = ["slots", "locale", "settingsScope"];
function apply(ctx) {
  ensureStyles();
  const t = ctx.locale.bind(NS);
  ctx.effect(function() {
    return ctx.locale.register(NS, { zh, en });
  }, "dsh-stt: dictionaries");
  const scope = ctx.settingsScope.bind({ namespace: NS });
  ctx.slots.inject("conversation.input.right", function() {
    return ctx.slots.register({ name: "conversation.input.right", id: "dsh-stt", order: 100 }, MicButton);
  });
  ctx.slots.inject("conversation.composer.dock", function() {
    return ctx.slots.register({ name: "conversation.composer.dock", id: "dsh-stt-guide", order: 60 }, ModelGuideBar);
  });
  ctx.slots.inject("settings.section", function() {
    return ctx.slots.register({
      name: "settings.section",
      id: "dsh-stt",
      order: 40,
      label: function() {
        return t("nav");
      },
      locale: NS
    }, function(props) {
      return h4(SettingsCard, Object.assign({}, props, { scope, t }));
    });
  });
  refreshStatus();
  const timer = setInterval(refreshStatus, 5e3);
  ctx.effect(function() {
    return function() {
      clearInterval(timer);
    };
  }, "dsh-stt: poll");
  function composerPlaceholderText() {
    const w = (state.wakeWords || "").split(",").map(function(x) {
      return x.trim();
    }).filter(Boolean).join("\u3001") || "\u4F60\u597D";
    return t("placeholder").replace("{w}", w);
  }
  let sttPlaceholderOrig = null;
  function syncComposerPlaceholder() {
    const ta = findComposerTextarea();
    if (!ta) return;
    if (sttPlaceholderOrig === null) sttPlaceholderOrig = ta.getAttribute("placeholder") || "";
    const want = state.micOn ? composerPlaceholderText() : sttPlaceholderOrig;
    if (ta.getAttribute("placeholder") !== want) ta.setAttribute("placeholder", want);
  }
  const placeholderPoll = setInterval(syncComposerPlaceholder, 1e3);
  ctx.effect(function() {
    return function() {
      clearInterval(placeholderPoll);
    };
  }, "dsh-stt: placeholder");
}

    })(module, exports, require);
    return module.exports;
  },
});

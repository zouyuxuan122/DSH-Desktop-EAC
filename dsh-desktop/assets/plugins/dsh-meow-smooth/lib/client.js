window.__ModuleLoader__.load({
  id: "meow-smooth",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  FoldDock: () => FoldDock,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/notify-client.ts
var NOTIFIED_LS_KEY = "meow-smooth:notified-completions";
var NOTIFIED_LS_CAP = 50;
var ICON_URL = "/plugins/meow-smooth/icon-180.png";
function loadNotified() {
  try {
    const raw = localStorage.getItem(NOTIFIED_LS_KEY);
    const list = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((item) => typeof item === "string") : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function saveNotified(ids) {
  try {
    const list = [...ids].slice(-NOTIFIED_LS_CAP);
    localStorage.setItem(NOTIFIED_LS_KEY, JSON.stringify(list));
  } catch {
  }
}
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  const base64url = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64url);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
function displayName(title) {
  return title === "" ? "\u672A\u547D\u540D\u4F1A\u8BDD" : title;
}
function installNotifyClient(deps) {
  const openSession2 = deps.openSession;
  let lastPendingIds = /* @__PURE__ */ new Set();
  const notify = (title, body, tag, sessionId) => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (!document.hidden) return;
    try {
      const n = new Notification(title, { body, tag, icon: ICON_URL });
      n.onclick = () => {
        window.focus();
        if (sessionId !== void 0) openSession2?.(sessionId);
        n.close();
      };
    } catch {
    }
  };
  let lastDiagAt = 0;
  const reportDiag = (msg) => {
    const now = Date.now();
    if (now - lastDiagAt < 3e3) return;
    lastDiagAt = now;
    try {
      void fetch("/plugins/meow-smooth/diag-log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msg })
      }).catch(() => {
      });
    } catch {
    }
  };
  const pushSupported = "serviceWorker" in navigator && window.isSecureContext && typeof navigator.serviceWorker.register === "function" && typeof Notification !== "undefined";
  let subscribeRetries = 0;
  const MAX_SUBSCRIBE_RETRIES = 5;
  const ensureSubscription = async () => {
    if (!pushSupported || Notification.permission !== "granted") {
      reportDiag(`sub-skip perm=${typeof Notification === "undefined" ? "no-Notification" : Notification.permission}`);
      return;
    }
    if (subscribeRetries >= MAX_SUBSCRIBE_RETRIES) return;
    subscribeRetries += 1;
    try {
      const registration = await navigator.serviceWorker.register("/plugins/meow-smooth/sw.js", { scope: "/" });
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await (async () => {
        const res = await fetch("/plugins/meow-smooth/push-config", { cache: "no-store" });
        if (!res.ok) {
          reportDiag("sub-config-http-err");
          return null;
        }
        const data = await res.json();
        if (data.enabled !== true || typeof data.publicKey !== "string") {
          reportDiag(`sub-config-bad enabled=${data.enabled} key=${typeof data.publicKey}`);
          return null;
        }
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.publicKey)
        });
      })();
      if (subscription !== null) {
        await fetch("/plugins/meow-smooth/push-subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(subscription.toJSON())
        });
        reportDiag(existing !== null ? "sub-existed-report-ok" : "sub-subscribed-report-ok");
        subscribeRetries = MAX_SUBSCRIBE_RETRIES;
      } else {
        reportDiag("sub-null (no subscription produced)");
      }
    } catch (error) {
      reportDiag(`sub-error ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`);
    }
  };
  const requestPermissionOnGesture = () => {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    document.removeEventListener("pointerdown", requestPermissionOnGesture, { capture: true });
    document.removeEventListener("keydown", requestPermissionOnGesture, { capture: true });
    reportDiag("request-permission-called");
    void Notification.requestPermission().then((permission) => {
      reportDiag(`perm-result ${permission}`);
      if (permission === "granted") void ensureSubscription();
    }).catch(() => {
    });
  };
  document.addEventListener("pointerdown", requestPermissionOnGesture, { capture: true });
  document.addEventListener("keydown", requestPermissionOnGesture, { capture: true });
  let onVisibleResubscribe = null;
  let onSwMessage = null;
  if (pushSupported) {
    reportDiag(`boot perm=${Notification.permission} secure=${window.isSecureContext} sw=yes`);
    void ensureSubscription();
    onVisibleResubscribe = () => {
      if (document.visibilityState === "visible") {
        reportDiag(`visible perm=${Notification.permission}`);
        void ensureSubscription();
      }
    };
    document.addEventListener("visibilitychange", onVisibleResubscribe);
    onSwMessage = (event) => {
      const data = event.data;
      if (data?.type === "meow-smooth:jump" && typeof data.sessionId === "string") {
        openSession2?.(data.sessionId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onSwMessage);
  }
  return {
    onPending(items) {
      const next = new Set(items.map((item) => item.id));
      for (const id of lastPendingIds) {
        if (!next.has(id)) lastPendingIds.delete(id);
      }
      for (const item of items) {
        if (lastPendingIds.has(item.id)) continue;
        lastPendingIds.add(item.id);
        const name = displayName(item.title);
        if (item.kind === "approval") {
          notify(
            "dsh\uFF1A\u6709\u6743\u9650\u7533\u8BF7\u5F85\u5904\u7406",
            item.toolName === void 0 || item.toolName === "" ? `\u300C${name}\u300D\u6709\u6743\u9650\u7533\u8BF7\u5F85\u5904\u7406` : `\u300C${name}\u300D\u5DE5\u5177 ${item.toolName} \u8BF7\u6C42\u6743\u9650`,
            `a:${item.id}`,
            item.sessionId
          );
        } else if (item.kind === "plan-review") {
          notify("dsh\uFF1A\u6709\u8BA1\u5212\u5F85\u5BA1", `\u300C${name}\u300D\u6709\u8BA1\u5212\u7B49\u5F85\u5BA1\u6279`, `p:${item.id}`, item.sessionId);
        } else {
          notify("dsh\uFF1A\u6709\u63D0\u95EE\u5F85\u56DE\u7B54", `\u300C${name}\u300DAI \u6B63\u5728\u7B49\u4F60\u56DE\u7B54\u95EE\u9898`, `q:${item.id}`, item.sessionId);
        }
      }
    },
    onPollResult(data) {
      const events = Array.isArray(data.events) ? data.events : [];
      if (events.length === 0) return;
      const notified = loadNotified();
      let changed = false;
      for (const event of events) {
        if (notified.has(event.id)) continue;
        notified.add(event.id);
        changed = true;
        if (event.kind === "failed") {
          notify(
            "dsh\uFF1A\u672C\u8F6E\u8FD0\u884C\u5931\u8D25",
            event.message !== void 0 && event.message !== "" ? `\u8FD0\u884C\u5931\u8D25\uFF1A${event.message}` : "AI \u56DE\u5408\u56E0\u9519\u8BEF\u4E2D\u65AD\uFF0C\u70B9\u51FB\u67E5\u770B\u2026",
            `f:${event.id}`,
            event.sessionId
          );
          continue;
        }
        notify(
          "dsh\uFF1A\u4EFB\u52A1\u5B8C\u6210",
          `\u957F\u4EFB\u52A1\u5B8C\u6210\uFF08${event.toolCalls} \u6B21\u5DE5\u5177\u8C03\u7528\uFF09`,
          `c:${event.id}`,
          event.sessionId
        );
      }
      if (changed) saveNotified(notified);
    },
    dispose() {
      document.removeEventListener("pointerdown", requestPermissionOnGesture, { capture: true });
      document.removeEventListener("keydown", requestPermissionOnGesture, { capture: true });
      if (onVisibleResubscribe !== null) {
        document.removeEventListener("visibilitychange", onVisibleResubscribe);
      }
      if (onSwMessage !== null) {
        navigator.serviceWorker?.removeEventListener("message", onSwMessage);
      }
    }
  };
}

// src/settings-mobile.ts
var SETTINGS_ATTR = "data-meow-smooth-settings";
var NOANIM_ATTR = "data-meow-smooth-settings-noanim";
var BREAKPOINT = "(max-width: 1023px)";
var SETTINGS_CSS = `
/* \u9700\u6C42 16\uFF1A\u624B\u673A\u7AEF\u8BBE\u7F6E\u9875\u6539\u9020\u3002\u5C5E\u6027\u7531 settings-mobile.ts \u7BA1\u7406\uFF1B\u684C\u9762\uFF08\u5BBD\u5C4F\uFF09
   \u65E0\u5C5E\u6027\uFF0C\u4EE5\u4E0B\u5168\u90E8\u4E0D\u751F\u6548\u3002 */
@media (max-width: 1023px) {
  /* 1. \u6D6E\u5C42\u5168\u7A97\u53E3\uFF1A\u9762\u677F\u94FA\u6EE1 overlay\uFF08fixed inset:0 \u7684 flex \u5BB9\u5668\uFF09\uFF0C
     \u65E0\u4E0A\u4E0B\u5DE6\u53F3\u7A7A\u9699\uFF1B\u5706\u89D2/\u9634\u5F71\u4E0D\u518D\u9700\u8981\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}] {
    width: 100% !important;
    height: 100% !important;
    max-width: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  /* 2/4. \u8FB9\u680F\u5BBD\u5EA6\u52A8\u753B\uFF08\u6536\u8D77/\u5C55\u5F00\u5171\u7528\u4E00\u6761 transition\uFF0C\u53CC\u5411\u5E73\u6ED1\uFF09\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}] > nav {
    transition: width 220ms cubic-bezier(0.2, 0.8, 0.3, 1),
                padding 220ms cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  /* \u6807\u7B7E\u7684\u663E\u793A/\u9690\u85CF\u52A8\u753B\uFF1A\u5BBD\u5EA6\u4E0E\u900F\u660E\u5EA6\u8054\u52A8\uFF08\u6536\u8D77\u5F52\u96F6\u3001\u5C55\u5F00\u6ED1\u51FA\uFF09\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}] > nav > div > button > span {
    transition: max-width 220ms cubic-bezier(0.2, 0.8, 0.3, 1),
                opacity 150ms ease;
  }
  /* \u521D\u59CB\u843D\u4F4D\u4E0D\u64AD\u52A8\u753B\uFF1A\u9762\u677F\u521A\u63D2\u5165\u65F6\u5C5E\u6027\u540E\u7F6E\uFF08MutationObserver \u5FAE\u4EFB\u52A1\u665A\u4E8E
     \u5143\u7D20\u9996\u5E27\u6837\u5F0F\uFF09\u4F1A\u8BA9\u6D4F\u89C8\u5668\u628A"188px \u539F\u751F\u6001 \u2192 \u6536\u8D77\u6001"\u4E5F\u5F53\u8FC7\u6E21\u6765\u64AD\uFF0C
     \u6253\u5F00\u77AC\u95F4\u95EA\u4E00\u4E0B\u3002noanim \u6807\u8BB0\u5728\u9996\u5E27\u538B\u5236 transition\uFF0C\u4E0B\u4E00\u5E27\u7531 JS \u6458\u9664\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}][${NOANIM_ATTR}] > nav,
  div[role="dialog"][${SETTINGS_ATTR}][${NOANIM_ATTR}] > nav > div > button > span {
    transition: none;
  }
  /* \u8FB9\u680F\u53F3\u4FA7 1px \u8FB9\u7EBF\uFF1A\u5F15\u5BFC\u7528\u6237\u8BC6\u522B"\u8FB9\u680F / \u5185\u5BB9"\u4E24\u4E2A\u533A\u57DF\u3002\u4F2A\u5143\u7D20\u4E0D\u5360
     \u5E03\u5C40\u5BBD\u5EA6\uFF08border \u4F1A\u5403\u6389\u5185\u5BB9\u5BBD\u5BFC\u81F4\u6309\u94AE 36px \u6EA2\u51FA\u88AB\u538B\u7F29\uFF09\uFF0C\u968F\u5BBD\u5EA6
     \u52A8\u753B\u8D34\u53F3\u7F18\u79FB\u52A8\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}] > nav {
    position: relative;
  }
  div[role="dialog"][${SETTINGS_ATTR}] > nav::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 1px;
    background: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  }
  /* \u6536\u8D77\u6001\uFF08\u9ED8\u8BA4\uFF09\uFF1A56px \u56FE\u6807\u7AD6\u5217\u2014\u2014\u4E0E dsh \u4E3B\u754C\u9762\u8FB9\u680F\u6536\u8D77\u5BBD\u5EA6\u4E00\u81F4
     \uFF08ui-sidebar rail\uFF1A36x36 \u63A7\u4EF6\u5C45\u4E2D + 10px \u4FA7\u8FB9\u8DDD\uFF09\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}="collapsed"] > nav {
    width: 56px;
    padding: 22px 10px 0;
  }
  /* \u6536\u8D77\u6001\u6807\u9898\uFF1A\u89C6\u89C9\u9690\u85CF\u4F46\u4FDD\u7559\u5728\u65E0\u969C\u788D\u6811\uFF08dialog aria-labelledby \u6307\u5411
     \u5B83\uFF0Cdisplay:none \u4F1A\u4E22\u65E0\u969C\u788D\u540D\uFF09\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}="collapsed"] > nav > div:first-child {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  /* \u6536\u8D77\u6001\u6309\u94AE\uFF1A36x36 \u5706\u94AE\uFF08\u4E0E\u4E3B\u754C\u9762 rail \u63A7\u4EF6\u540C\u5F62\uFF09\uFF0C\u53EA\u7559\u56FE\u6807\u5C45\u4E2D\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}="collapsed"] > nav > div > button {
    width: 36px;
    height: 36px;
    padding: 0;
    gap: 0;
    justify-content: center;
    border-radius: 50%;
  }
  /* \u6536\u8D77\u6001\u6807\u7B7E\uFF1A\u5BBD\u5EA6\u4E0E\u900F\u660E\u5EA6\u540C\u65F6\u5F52\u96F6\uFF08\u5C55\u5F00\u65F6\u6309 transition \u53CD\u5411\u52A8\u753B\uFF09\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}="collapsed"] > nav > div > button > span {
    flex: 0;
    max-width: 0;
    opacity: 0;
  }
  /* \u5C55\u5F00\u6001\uFF1A\u6062\u590D\u5B98\u65B9 188px \u5B8C\u6574\u8FB9\u680F + \u56FE\u6807\u6587\u5B57\u3002 */
  div[role="dialog"][${SETTINGS_ATTR}="expanded"] > nav {
    width: 188px;
    padding: 22px 12px 0;
  }
  div[role="dialog"][${SETTINGS_ATTR}="expanded"] > nav > div > button > span {
    flex: 1;
    max-width: 200px;
    opacity: 1;
  }
}
`;
var narrowQuery = null;
var panel = null;
function findSettingsPanel() {
  const nav = document.querySelector('div[role="dialog"] > nav');
  return nav !== null ? nav.parentElement ?? null : null;
}
function applyMode() {
  if (panel === null) return;
  if (narrowQuery?.matches === true) {
    panel.setAttribute(SETTINGS_ATTR, "collapsed");
  } else {
    panel.removeAttribute(SETTINGS_ATTR);
  }
}
function isInteractive(target) {
  return target.closest(
    'button, a, input, select, textarea, label, [contenteditable="true"], [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="link"], [role="slider"]'
  ) !== null;
}
function onSettingsClickCapture(event) {
  const el = panel;
  if (el === null || narrowQuery?.matches !== true) return;
  const state = el.getAttribute(SETTINGS_ATTR);
  if (state !== "collapsed" && state !== "expanded") return;
  const target = event.target;
  if (!(target instanceof Element) || !el.contains(target)) return;
  const nav = el.querySelector(":scope > nav");
  const inNav = nav !== null && nav.contains(target);
  if (state === "collapsed") {
    if (inNav) {
      event.preventDefault();
      event.stopPropagation();
      el.setAttribute(SETTINGS_ATTR, "expanded");
    }
    return;
  }
  if (!inNav && !isInteractive(target)) {
    event.preventDefault();
    event.stopPropagation();
    el.setAttribute(SETTINGS_ATTR, "collapsed");
  }
}
var panelObserver = new MutationObserver(() => {
  const next = findSettingsPanel();
  if (next === panel) return;
  const fresh = panel === null && next !== null;
  panel = next;
  if (fresh && narrowQuery?.matches === true) {
    next.setAttribute(SETTINGS_ATTR, "collapsed");
    next.setAttribute(NOANIM_ATTR, "true");
    requestAnimationFrame(() => {
      next.removeAttribute(NOANIM_ATTR);
    });
  } else {
    applyMode();
  }
});
function installSettingsMobile() {
  document.querySelector("style[data-meow-smooth-settings-css]")?.remove();
  const style = document.createElement("style");
  style.dataset.meowSettingsCss = "true";
  style.textContent = SETTINGS_CSS;
  document.head.appendChild(style);
  const mq = window.matchMedia(BREAKPOINT);
  narrowQuery = mq;
  const onNarrowChange = () => {
    applyMode();
  };
  mq.addEventListener("change", onNarrowChange);
  panelObserver.observe(document.body, { subtree: true, childList: true });
  document.addEventListener("click", onSettingsClickCapture, { capture: true });
  panel = findSettingsPanel();
  applyMode();
  return () => {
    style.remove();
    mq.removeEventListener("change", onNarrowChange);
    panelObserver.disconnect();
    document.removeEventListener("click", onSettingsClickCapture, { capture: true });
  };
}

// src/sidebar-gesture.ts
var NARROW_W = 56;
var EDGE_HOTSPOT = 26;
var SWIPE_MIN = 24;
var LONG_SWIPE = 110;
var AXIS_RATIO = 1.2;
var GESTURE_CSS = `
@media (pointer: coarse) {
  [data-slot="sidebar"],
  [data-slot="sidebar"] * {
    touch-action: pan-y;
  }
}
`;
function installSidebarGesture(deps) {
  document.documentElement.dataset.meowSmoothGestureLoaded = "v5.6-foldtrace";
  const w = window;
  w.__meowSmoothGestureDispose?.();
  const prevStyle = document.querySelector("style[data-meow-smooth-gesture-css]");
  if (prevStyle !== null) prevStyle.remove();
  const style = document.createElement("style");
  style.setAttribute("data-meow-smooth-gesture-css", "true");
  style.textContent = GESTURE_CSS;
  document.head.appendChild(style);
  let phase = "idle";
  let sx = 0;
  let sy = 0;
  let startZone = "window";
  let hold = false;
  const syncHoldFlag = () => {
    w.__meowSmoothGestureHold = hold;
  };
  const html = document.documentElement;
  const frameOf = () => deps.frameElement();
  const collapsedNow = () => frameOf()?.hasAttribute("data-sidebar-collapsed") ?? true;
  const ensureOfficial = (wantExpanded) => {
    if (!collapsedNow() !== wantExpanded) deps.layout.toggleSidebar();
  };
  const openNarrow = () => {
    if (!collapsedNow()) return;
    deps.setFurled(false);
    hold = true;
    syncHoldFlag();
  };
  const openWide = () => {
    deps.setFurled(false);
    ensureOfficial(true);
    hold = false;
    syncHoldFlag();
  };
  const collapseToZero = () => {
    const frame = frameOf();
    if (frame === null || frame.getBoundingClientRect().width >= 1024) return false;
    if (collapsedNow()) {
      if (deps.isFurled()) return false;
      deps.setFurled(true);
      hold = false;
      syncHoldFlag();
      return true;
    }
    deps.layout.toggleSidebar();
    deps.setFurled(true);
    hold = false;
    syncHoldFlag();
    return true;
  };
  const onTouchStart = (event) => {
    if (phase !== "idle" || event.touches.length !== 1) return;
    if (!deps.isCoarsePointer()) return;
    const frame = frameOf();
    if (frame === null || frame.getBoundingClientRect().width >= 1024) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const touch = event.touches[0];
    sx = touch.clientX;
    sy = touch.clientY;
    const onInput = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
    if (onInput && sx > EDGE_HOTSPOT) return;
    if (target.closest("[data-composer-card]") !== null) return;
    const overlayHit = target.closest('[role="dialog"], [data-meow-smooth-pending], [data-meow-smooth-fab]');
    if (overlayHit !== null) return;
    if (!collapsedNow()) {
      const inSidebar = target.closest('[data-slot="sidebar"]') !== null;
      const onBlank = inSidebar && target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [contenteditable="true"]') === null;
      if ((onBlank || !inSidebar) && !onInput) {
        startZone = inSidebar ? "sidebar" : "window";
        phase = "pending";
        note(`ts pending zone=${startZone} x=${sx}`);
      } else {
        note(`ts skip wide inSidebar=${inSidebar} onBlank=${onBlank}`);
      }
      return;
    }
    if (deps.isFurled()) {
      if (sx <= EDGE_HOTSPOT) {
        startZone = "edge";
        phase = "pending";
      }
      return;
    }
    if (sx <= NARROW_W + 30) {
      startZone = "rail";
      phase = "pending";
    } else if (!onInput) {
      startZone = "window";
      phase = "pending";
    }
  };
  const onTouchMove = (event) => {
    if (phase !== "pending" || event.touches.length !== 1) return;
    const sel = document.getSelection();
    if (sel !== null && sel.type === "Range") {
      phase = "idle";
      return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - sx;
    const dy = touch.clientY - sy;
    if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) {
      phase = "committed";
      note(`committed dx=${Math.round(dx)} zone=${startZone}`);
      if (event.cancelable) event.preventDefault();
    } else if (Math.abs(dy) > SWIPE_MIN && Math.abs(dy) > Math.abs(dx)) {
      phase = "idle";
    }
  };
  const onTouchEnd = (event) => {
    if (phase !== "committed") {
      phase = "idle";
      return;
    }
    phase = "idle";
    const touch = event.changedTouches[0];
    const dx = (touch?.clientX ?? sx) - sx;
    if (Math.abs(dx) < SWIPE_MIN) return;
    note(`swipe dx=${Math.round(dx)} zone=${startZone} furled=${deps.isFurled()} collapsed=${collapsedNow()}`);
    if (dx > 0) {
      if (startZone === "edge" && deps.isFurled()) {
        if (dx >= LONG_SWIPE) openWide();
        else openNarrow();
      } else if (startZone === "rail") {
        openWide();
      }
      return;
    }
    collapseToZero();
  };
  document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
  const dispose = () => {
    document.removeEventListener("touchstart", onTouchStart, { capture: true });
    document.removeEventListener("touchmove", onTouchMove, { capture: true });
    document.removeEventListener("touchend", onTouchEnd, { capture: true });
    document.removeEventListener("touchcancel", onTouchEnd, { capture: true });
  };
  w.__meowSmoothGestureDispose = dispose;
  const trace = [];
  const INSTANCE_ID = Math.random().toString(36).slice(2, 7);
  w.__meowGestureInstanceId = INSTANCE_ID;
  w.__meowGestureTrace = trace;
  function note(msg) {
    trace.push(`${Date.now() % 1e5} [${INSTANCE_ID}] ${msg}`);
    if (trace.length > 16) trace.shift();
  }
  return {
    narrowHold: () => hold,
    clearHold: () => {
      hold = false;
      syncHoldFlag();
    },
    collapseToZero,
    busy: () => phase !== "idle"
  };
}

// src/client.ts
var FOLD_ATTR = "data-meow-smooth";
var FOLD_COLLAPSED = "collapsed";
var IME_ROOT_ATTR = "data-meow-smooth-ime";
var BAR_ATTR = "data-meow-smooth-bar";
var HEADER_MENU_ATTR = "data-meow-smooth-menu-open";
var FOLDED_MAX_HEIGHT = "30px";
var PENDING_BAR_ATTR = "data-meow-smooth-pending";
var IS_DESKTOP = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches === true;
var FURL_ROOT_ATTR = "data-meow-smooth-furled";
var FAB_ATTR = "data-meow-smooth-fab";
var HEADER_HIDDEN_ATTR = "data-meow-smooth-header-hidden";
var FOLD_CSS = `
/* \u8FC7\u6E21\u653E\u57FA\u7840\u6001\uFF1A\u6298\u53E0/\u5C55\u5F00\u53CC\u5411\u90FD\u6709\u52A8\u753B\u3002 */
[data-composer-card] [data-input-scroll] { transition: max-height 150ms ease; }
/* \u6298\u53E0\u6001\uFF1A\u6EDA\u52A8\u7A97\u538B\u5230 1 \u884C\uFF0Cmirror/backdrop/textarea \u7ED3\u6784\u4E0D\u52A8\u3002\u9AD8\u5EA6\u53D6
   JS \u5B9E\u6D4B\u7684 1 \u884C\u9AD8\uFF08--meow-smooth-one-line\uFF09\uFF0C\u672A\u6D4B\u91CF\u65F6\u56DE\u9000 30px \u5951\u7EA6\u503C\u3002 */
[data-composer-card][${FOLD_ATTR}="${FOLD_COLLAPSED}"] [data-input-scroll] {
  max-height: var(--meow-smooth-one-line, ${FOLDED_MAX_HEIGHT}) !important;
}
/* \u8F93\u5165\u6CD5\u6FC0\u6D3B\uFF1A\u9690\u85CF\u539F\u751F header\uFF08\u60AC\u6D6E\u6761\u72EC\u5360\u9876\u90E8\uFF0C\u907F\u514D\u91CD\u590D\u4E0E\u906E\u6321\uFF09\u3002
   imeActive \u5728\u684C\u9762\u6052\u4E3A false\uFF0C\u5C5E\u6027\u6C38\u4E0D\u8BBE\u7F6E\uFF0C\u6B64\u89C4\u5219\u4E0D\u751F\u6548\u3002 */
html[${IME_ROOT_ATTR}] [data-slot="conversation.session.header"] > header {
  display: none !important;
}
/* \u60AC\u6D6E Session name \u6761\uFF1Abody \u76F4\u63A5\u5B50\u7EA7\u3001fixed \u9489\u5C4F\u5E55\u9876\u90E8\u3001\u6700\u9AD8\u5C42\u7EA7\uFF0C
   \u4E0D\u4E0E\u4EFB\u4F55\u9875\u9762\u5143\u7D20\u53D1\u751F\u5173\u7CFB\uFF08\u4E0D\u53C2\u4E0E\u5E03\u5C40\u3001\u4E0D\u6321\u70B9\u51FB\uFF09\u3002top \u7531 JS \u6309
   visualViewport.offsetTop \u8865\u507F\uFF08iOS \u952E\u76D8\u5F39\u8D77\u5E73\u79FB layout viewport\uFF09\u3002 */
[${BAR_ATTR}] {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  padding: calc(8px + env(safe-area-inset-top, 0px)) 16px 8px;
  text-align: center;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major);
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  pointer-events: none;
}
/* \u624B\u673A\u7AEF\uFF08< 1024px\uFF0Cdsh \u5E03\u5C40\u65AD\u70B9 SIDEBAR_AUTO_COLLAPSE\uFF09\uFF1A\u6A21\u578B\u9009\u62E9\u5668
   \u6298\u53E0\u5BBD\u5EA6\u2014\u2014trigger \u538B\u5230 96px\u3001\u9690\u85CF effort \u6587\u5B57\uFF1B\u6A21\u578B\u540D label \u81EA\u5E26
   ellipsis\uFF0C\u8D85\u51FA\u81EA\u52A8\u7701\u7565\u3002trailing \u53D8\u7A84\u540E\u4E0D\u518D\u6324\u6389\u5DE6\u4FA7\u6309\u94AE\u3002 */
@media (max-width: 1023px) {
  [data-composer-card] [data-slot="conversation.input.model"] button[aria-haspopup="menu"] {
    max-width: 96px;
  }
  [data-composer-card] [data-slot="conversation.input.model"] button[aria-haspopup="menu"] > span:not(:first-child) {
    display: none;
  }
  /* Session log \u6309\u94AE\u7F29\u7A84\uFF1A\u53EA\u7559\u4E0B\u8F7D\u56FE\u6807\uFF0C\u9690\u85CF\u6587\u5B57\uFF1B\u53BB\u6389 min-width:111px
     \u4E0E\u5BBD padding\uFF08HeaderAction.module.css \u5951\u7EA6\uFF09\u3002 */
  [data-slot="conversation.session.header.utilities"] button span {
    display: none;
  }
  [data-slot="conversation.session.header.utilities"] button {
    min-width: 0;
    padding: 6px 8px;
  }
  /* \u6A21\u5F0F\u9009\u62E9\uFF08agent preset label\uFF09\u6298\u53E0\uFF1A\u53EA\u7559 icon\uFF08font-size:0 \u9690\u53BB
     \u6587\u672C\u8282\u70B9\uFF0Cflex \u5E03\u5C40\u4E0B icon \u5C3A\u5BF8\u4E0D\u53D7\u5F71\u54CD\uFF09\u3002\u70B9\u51FB\u5C55\u5F00\u65F6\u7531\u5185\u8054\u6837\u5F0F
     \u6062\u590D\uFF08data-meow-smooth-mode-expanded\uFF0C\u89C1 onModeLabelToggle\uFF09\u3002 */
  [data-slot="conversation.session.header.actions"] span[title] {
    font-size: 0;
    max-width: 20px;
  }
  /* \u540E\u53F0\u4EFB\u52A1\u6570\u6309\u94AE\uFF08job-list\uFF09\u7F29\u7A84\uFF1A\u53EA\u7559 StateDot \u5C0F\u56FE\u6807\uFF0C\u9690\u85CF\u8BA1\u6570\u6587\u5B57
     \u4E0E\u53F3\u4FA7\u4E0B\u62C9\u7BAD\u5934\uFF1B\u70B9\u5C0F\u56FE\u6807 = \u70B9\u6309\u94AE\u672C\u4F53 \u2192 \u6253\u5F00\u4E0B\u62C9\u5217\u8868\u3002\u65E0\u8FD0\u884C\u4E2D
     \u4EFB\u52A1\uFF08\u65E0 dot\uFF09\u65F6\u7528\u4E2D\u6027\u7070\u70B9\u515C\u5E95\uFF0C\u6309\u94AE\u4E0D\u6D88\u5931\u3001\u4ECD\u53EF\u70B9\u5F00\u5217\u8868\u3002 */
  [data-slot="conversation.session.header.actions"] button[aria-expanded]:not([aria-haspopup]) {
    min-width: 0;
    padding: 4px 6px;
    gap: 0;
  }
  [data-slot="conversation.session.header.actions"] button[aria-expanded]:not([aria-haspopup]) > span {
    display: none;
  }
  [data-slot="conversation.session.header.actions"] button[aria-expanded]:not([aria-haspopup]) > svg:not([data-state]) {
    display: none;
  }
  [data-slot="conversation.session.header.actions"] button[aria-expanded]:not([aria-haspopup]):not(:has(svg[data-state]))::before {
    content: '';
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  /* \u5B50\u4EE3\u7406\u76EE\u5F55\u6309\u94AE\uFF08subagent-catalog\uFF09\u540C\u6837\u7F29\u7A84\uFF1A\u53EA\u7559 activitySlot \u91CC\u7684
     \u72B6\u6001\u5C0F\u56FE\u6807\uFF1B\u7A7A\u95F2\uFF08\u65E0\u8FD0\u884C\u4E2D\u5B50\u4EE3\u7406\uFF09\u65F6 activitySlot \u7A7A\u7F6E \u2192 \u4E2D\u6027\u7070\u70B9
     \u515C\u5E95\u3002\u83DC\u5355\u5F00\u5408\u903B\u8F91\u5728\u6309\u94AE\u672C\u4F53 onClick\uFF0C\u70B9\u56FE\u6807\u5373\u5C55\u5F00\u3002 */
  [data-slot="conversation.session.header.actions"] button[aria-haspopup="tree"] {
    min-width: 0;
    padding: 4px 6px;
    gap: 0;
  }
  [data-slot="conversation.session.header.actions"] button[aria-haspopup="tree"] > span:not(:first-child) {
    display: none;
  }
  [data-slot="conversation.session.header.actions"] button[aria-haspopup="tree"] > svg:not([data-state]) {
    display: none;
  }
  [data-slot="conversation.session.header.actions"] button[aria-haspopup="tree"]:not(:has(svg[data-state])) > span:first-child::before {
    content: '';
    display: block;
    width: 6px;
    height: 6px;
    margin: auto;
    border-radius: 50%;
    background: currentColor;
  }
  /* header \u6A2A\u5411\u6ED1\u52A8\uFF1ASession name \u5B8C\u6574\u663E\u793A\u3001\u7EDD\u4E0D\u622A\u65AD\uFF0C\u5176\u4F59\u52A8\u4F5C\u6309\u4F18\u5316\u540E
     \u7684\u7A84\u5F62\u6001\u4F9D\u6B21\u6392\u5728 name \u540E\u9762\uFF1B\u5185\u5BB9\u8D85\u5BBD\u65F6 titleRow \u53EF\u5DE6\u53F3\u6ED1\u52A8\uFF08\u6EDA\u52A8\u6761
     \u9690\u85CF\uFF0C\u89E6\u5C4F\u539F\u751F\u6ED1\u52A8\uFF1B\u684C\u9762 <1024px \u7A84\u7A97\u53E3\u540C\u7406\u53EF\u7528 shift+\u6EDA\u8F6E\uFF09\u3002 */
  [data-slot="conversation.session.header"] > header > div:first-child {
    overflow-x: auto;
    overflow-y: hidden;
    flex-wrap: nowrap;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  /* \u4E0B\u62C9\u83DC\u5355\u6253\u5F00\u65F6\u653E\u5F00 titleRow \u7684 overflow\uFF1A\u6EDA\u52A8\u5BB9\u5668\u4F1A\u88C1\u526A\u7EDD\u5BF9\u5B9A\u4F4D\u7684
     \u83DC\u5355\uFF08overflow-x:auto \u4E0B overflow-y \u4E0D\u80FD\u4FDD\u6301 visible\uFF0C\u83DC\u5355\u88AB\u622A\u65AD/
     \u9690\u85CF\uFF09\u3002\u5F00\u5173\u72B6\u6001\u7531 JS \u6253 data-meow-smooth-menu-open \u5C5E\u6027
     \uFF08syncHeaderMenu\uFF09\uFF1A\u6253\u5F00\u77AC\u95F4\u8BB0\u5F55 scrollLeft \u5E76\u7528 transform \u5E73\u79FB\u8865\u507F\uFF0C
     header \u505C\u5728\u539F\u5904\u4E0D\u56DE\u8DF3\uFF1B\u5173\u95ED\u65F6\u6062\u590D overflow \u540E\u5199\u56DE scrollLeft\uFF0C
     \u4F4D\u7F6E\u5168\u7A0B\u4E0D\u53D8\u3002z-index \u62AC\u9AD8\u907F\u514D transform \u5C42\u53E0\u4E0A\u4E0B\u6587\u88AB\u540E\u7EED\u5185\u5BB9\u76D6\u4F4F\u3002 */
  [data-slot="conversation.session.header"] > header > div:first-child[${HEADER_MENU_ATTR}] {
    overflow-x: visible;
    overflow-y: visible;
    position: relative;
    z-index: 200;
  }

  [data-slot="conversation.session.header"] > header > div:first-child::-webkit-scrollbar {
    display: none;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:first-child {
    flex: none;
    min-width: max-content;
    overflow: visible;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:first-child > nav {
    flex: none;
    min-width: max-content;
    overflow: visible;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:first-child > nav > span {
    flex: none;
    white-space: nowrap;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:first-child > nav button {
    max-width: none;
    overflow: visible;
    text-overflow: clip;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:nth-child(2) {
    margin-left: 10px;
  }
  /* \u6D88\u606F\u64CD\u4F5C\u884C\u6A2A\u5411\u6ED1\u52A8\uFF08\u9700\u6C42 17\uFF09\uFF1A\u590D\u5236/\u70B9\u8D5E/\u5907\u6CE8/\u5206\u652F\u6309\u94AE + \u65F6\u95F4\xB7\u7528\u65F6\xB7
     \u9996token\xB7\u5410\u5B57\u901F\u5EA6\u7EDF\u8BA1\u5728\u624B\u673A\u4E0A\u4E00\u884C\u653E\u4E0D\u4E0B\uFF0C\u539F\u751F\u88AB\u7956\u5148\u88C1\u526A\u3002\u628A\u884C\u81EA\u8EAB
     \u53D8\u6210\u6A2A\u5411\u6EDA\u52A8\u5BB9\u5668\uFF1Amax-width \u94B3\u56DE\u5BB9\u5668\u5BBD\uFF08\u7528\u6237\u884C align-items:flex-end
     \u4E0B\u884C\u5BBD\u968F\u5185\u5BB9\u3001\u8D85\u5BBD\u65F6\u5411\u5DE6\u6EA2\u51FA\uFF09\uFF0C\u5185\u5BB9\u539F\u6837\u6392\u5F00\u3001\u8D85\u5BBD\u90E8\u5206\u5DE6\u53F3\u6ED1\u3002
     \u951A\u70B9=\u5BB9\u5668 data-time-hover-root\uFF08\u5B98\u65B9\u53EA\u5728\u7528\u6237\u884C/turn-tail \u6839\u4E24\u5904\u4F7F\u7528\uFF09
     \u7684\u76F4\u63A5\u5B50\u7EA7 [class*='_actions']\uFF08MessageIconActions \u7684 [hash]_actions\uFF0C
     \u54C8\u5E0C\u524D\u7F00\u968F\u7248\u672C\u53D8\u3001_actions \u5C3E\u7F00\u4E0D\u53D8\uFF1B\u76F4\u63A5\u5B50\u7EA7\u9650\u5B9A\u907F\u514D\u8BEF\u4F24\u9875\u9762\u5176\u4ED6
     \u6A21\u5757\u7684 *_actions\uFF09\u3002\u6EDA\u52A8\u6761\u9690\u85CF + \u89E6\u5C4F\u60EF\u6027\u6EDA\u52A8\uFF1B\u6A61\u76AE\u7B4B\u6291\u5236 JS \u6309\u8BA1\u7B97
     \u6837\u5F0F\u81EA\u52A8\u628A\u8BE5\u884C\u8BC6\u522B\u4E3A\u53EF\u6EDA\u52A8\u7956\u5148\uFF08\u5230\u8FB9\u754C\u624D\u62E6\uFF09\uFF0C\u65E0\u9700\u989D\u5916\u914D\u5408\u3002 */
  [data-time-hover-root] > [class*='_actions'] {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  [data-time-hover-root] > [class*='_actions']::-webkit-scrollbar {
    display: none;
  }
  /* \u624B\u673A\u7AEF\u7981\u7528\u6A61\u76AE\u7B4B\u56DE\u5F39\uFF08app \u5316\u89C2\u611F\uFF09\uFF1Aoverscroll-behavior \u62E6\u6587\u6863\u7EA7
     \u4E0E\u94FE\u5F0F\u56DE\u5F39\uFF08\u73B0\u4EE3 Chrome/Safari 16+\uFF0C\u542B\u5B89\u5353\u4E0B\u62C9\u5237\u65B0\uFF09\uFF1B\u65E7 iOS \u7531
     JS touchmove \u515C\u5E95\uFF08onTouchStartOverscroll/onTouchMoveOverscroll\uFF09\u3002 */
  html, body {
    overscroll-behavior: none;
  }
  [data-slot="root"], [data-slot="root"] * {
    overscroll-behavior: none;
  }
}
/* \u9632\u53CC\u51FB\u7F29\u653E\uFF08\u89E6\u5C4F\u53CC\u51FB\u653E\u5927\u9875\u9762\uFF09\uFF1B\u634F\u5408\u53E6\u7531 viewport meta + gesture
   \u4E8B\u4EF6\u62E6\u622A\uFF08Chrome \u5B89\u5353\u4F1A\u5FFD\u7565 user-scalable\uFF0C\u6B64\u4E3A\u5C3D\u529B\u800C\u4E3A\uFF09\u3002 */
html, body { touch-action: manipulation; }
/* \u89E6\u5C4F\u8BBE\u5907\u5BBD\u8868\u5E38\u5F00\u6A2A\u5411\u6EDA\u52A8\uFF082026-08-22 \u8868\u683C\u7AD6\u6ED1\u4FEE\u590D\u7684\u53E6\u4E00\u534A\uFF09\uFF1A\u672C\u4F53\u7684
   \u5BBD\u8868\uFF08md-table-wide\uFF0C\u22654 \u5217\uFF09\u9759\u6B62\u6001 overflow-x:hidden\u3001\u60AC\u505C\u624D\u53D8 auto\u2014\u2014
   \u684C\u9762"\u60AC\u505C\u624D\u663E\u6EDA\u52A8\u6761"\u7684\u7F8E\u5B66\uFF0C\u89E6\u5C4F\u6CA1\u6709 hover\uFF0C\u7ED3\u679C\u662F\u5BBD\u8868\u5728\u624B\u673A\u4E0A\u5B8C\u5168
   \u65E0\u6CD5\u6A2A\u5411\u6ED1\u52A8\u770B\u53F3\u8FB9\u7684\u5217\u3002\u8FD9\u91CC\u7528\u672C\u4F53\u6587\u6863\u627F\u8BFA\u7684\u7A33\u5B9A\u5168\u5C40\u94A9\u5B50\u5F3A\u5236\u5E38\u5F00
   \uFF08\u89E6\u5C4F\u662F\u8986\u76D6\u5F0F\u6EDA\u52A8\u6761\uFF0C\u5E38\u5F00\u6CA1\u6709\u89C6\u89C9\u4EE3\u4EF7\uFF09\uFF1B\u684C\u9762\uFF08\u6709 hover\uFF09\u4E0D\u52A8\u3002
   !important \u538B\u8FC7\u5B98\u65B9 (0,2,0) \u7684 module \u7C7B+\u5168\u5C40\u7C7B\u7EC4\u5408\u89C4\u5219\u3002 */
@media (hover: none) {
  .md-table-wide {
    overflow-x: auto !important;
    padding-bottom: 0 !important;
  }
}
/* \u5BA1\u6279/\u63D0\u95EE\u63D0\u9192\u5361\u7247\uFF08\u9700\u6C42 12/13\uFF0Cv2\uFF1A\u7CFB\u7EDF\u901A\u77E5\u6837\u5F0F\u7684\u5706\u89D2\u5361\u7247\uFF0C\u66FF\u4EE3\u5168\u5BBD
   \u6A2A\u6761\uFF09\uFF1Afixed \u9876\u90E8\u5C45\u4E2D\u3001\u5706\u89D2\u3001\u4E0B\u6ED1\u5F39\u51FA\u52A8\u753B\uFF1B\u6574\u5361\u53EF\u70B9\uFF08\u70B9\u51FB\u8FDB\u5165\u76EE\u6807
   \u4F1A\u8BDD\uFF09\u3001\u4E0A\u6ED1\u624B\u52BF\u9690\u85CF\u3002\u7EAF\u901A\u77E5\u2014\u2014\u56DE\u7B54\u6C38\u8FDC\u5728\u5B98\u65B9\u9762\u677F\uFF0C\u5361\u7247\u4E0D\u505A\u8F93\u5165\u3002
   z-index 9998 \u8BA9\u4F4D\u4E8E IME \u60AC\u6D6E\u6761\uFF089999\uFF09\uFF0C\u4E8C\u8005\u51E0\u4E4E\u4E0D\u4F1A\u540C\u73B0\u3002 */
[${PENDING_BAR_ATTR}] {
  position: fixed;
  top: calc(12px + env(safe-area-inset-top, 0px));
  left: 12px;
  right: 12px;
  z-index: 9998;
  display: none;
  border-radius: 14px;
  background: var(--dsw-specific-input-major, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2);
  overflow: hidden;
  transform: translateY(calc(-100% - 24px));
  transition: transform 260ms cubic-bezier(0.2, 0.8, 0.3, 1);
  pointer-events: none;
  -webkit-tap-highlight-color: transparent;
}
[${PENDING_BAR_ATTR}][data-visible="true"] {
  display: block;
  transform: translateY(0);
  pointer-events: auto;
}
[${PENDING_BAR_ATTR}] .toast-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  padding: 12px 14px 2px;
  color: var(--dsw-alias-label-primary, #222);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[${PENDING_BAR_ATTR}] .toast-sub {
  font-size: 12px;
  line-height: 18px;
  padding: 0 14px 12px;
  color: var(--dsw-alias-label-secondary, #666);
}
[${PENDING_BAR_ATTR}] .toast-fail {
  display: none;
  font-size: 12px;
  line-height: 18px;
  padding: 0 14px 12px;
  color: #b45309;
}
[${PENDING_BAR_ATTR}][data-mode="fail"] .toast-sub { display: none; }
[${PENDING_BAR_ATTR}][data-mode="fail"] .toast-fail { display: block; }
/* ---- \u529F\u80FD\u2471 \u624B\u673A\u7AEF\u7AD6\u6761\u6298\u53E0\u4E3A\u5C0F\u65B9\u5757\uFF08furl\uFF0C\u4E24\u6001/\u4E09\u6001\u81EA\u9002\u5E94\uFF09---- */
/* \u8F68\u9053\u5F52\u96F6\uFF1Agrid-template-columns \u662F AppFrame \u7684 inline style\uFF08React \u6BCF\u6B21
   \u6E32\u67D3\u90FD\u4F1A\u91CD\u5199\uFF09\uFF0C\u5FC5\u987B !important \u624D\u80FD\u538B\u8FC7\u3002\u7A84\u5C4F\u4E0B\u7B2C\u4E09\u8F68\uFF08details\uFF09\u6052\u4E3A
   0\u2014\u2014computeColumns \u5728\u89C6\u53E3 <996px \u65F6 details \u5FC5\u7136\u89E3\u51FA 0\uFF0C\u5199\u6B7B\u5B89\u5168\u3002
   \u6ED1\u52A8\u52A8\u753B\u590D\u7528\u672C\u4F53 .frame \u81EA\u5E26\u7684 grid-template-columns \u8FC7\u6E21\uFF08slow\uFF09\u3002 */
@media (max-width: 1023px) {
  html[${FURL_ROOT_ATTR}] [data-slot="root"] > [data-sidebar-collapsed] {
    grid-template-columns: 0px minmax(0, 1fr) 0px !important;
  }
}
/* \u7AD6\u6761\u5217\u5185\u5BB9\uFF1A\u8F68\u9053 0 + overflow:hidden \u5DF2\u88C1\u6389\u753B\u9762\uFF0C\u4F46 visibility:hidden
   \u624D\u4E0D\u6321\u89E6\u63A7\uFF1B\u4E0D\u80FD\u7528 display:none\u2014\u2014\u5B83\u4F1A\u8BA9\u540E\u7EED auto-placement \u7684
   center/details \u5217\u524D\u79FB\u8FDB\u7B2C\u4E00\u8F68\u3002border \u540C\u6B65\u900F\u660E\u9632\u6B8B\u7559 1px \u7AD6\u7EBF\uFF1B
   visibility \u6302\u5EF6\u8FDF transition\uFF08\u79BB\u6563\u8FC7\u6E21\uFF1A\u5230\u5EF6\u65F6\u7EC8\u70B9\u624D\u7FFB\u8F6C\uFF09\uFF0C\u6536\u62E2\u7684
   \u6ED1\u52A8\u753B\u64AD\u5B8C\u518D\u9690\uFF0C\u89C2\u611F\u662F\u6574\u6761\u5411\u5DE6\u6ED1\u51FA\u5C4F\u5E55\u3002 */
html[${FURL_ROOT_ATTR}] [data-slot="root"] > [data-sidebar-collapsed] > :first-child {
  visibility: hidden;
  border-right-color: transparent;
  transition: visibility 0s var(--ds-transition-duration-slow, 300ms);
}
/* furl \u6001\u4F1A\u8BDD header \u8BA9\u4F4D\uFF1A\u6574\u4E2A header \u6253 margin-left = \u7AD6\u6761\u5BBD\u5EA6 56px
 * \uFF08\u6807\u9898\u884C\u3001\u5BF9\u8BDD/\u8F68\u8FF9\u6807\u7B7E\u884C\u3001\u52A8\u4F5C\u6309\u94AE\u968F\u76D2\u6A21\u578B\u6574\u4F53\u53F3\u79FB\uFF09\u2014\u2014\u4E0E\u539F\u751F\u6536\u8D77
 * \u6001\uFF08\u4E2D\u5FC3\u5217\u4ECE x=56 \u8D77\uFF09\u9010\u50CF\u7D20\u4E00\u81F4\uFF0C\u4E14\u5B8C\u5168\u65E0\u9700\u6D4B\u91CF header \u539F\u751F padding
 * \uFF08\u5DE6\u53F3\u4E0D\u5BF9\u79F0\u3001furl \u540E\u8BA1\u7B97\u503C\u88AB\u6C61\u67D3\uFF0C\u5B9E\u6D4B 20/28 \u4E0D\u53EF\u9760\uFF09\u3002margin \u6302
 * \u8FC7\u6E21\uFF0C\u5C55\u5F00/\u6298\u53E0\u65F6\u6807\u9898\u5E73\u6ED1\u8BA9\u4F4D/\u56DE\u5F52\u3002 */
@media (max-width: 1023px) {
  html[${FURL_ROOT_ATTR}] [data-slot="conversation.session.header"] > header {
    margin-left: 56px;
    transition: margin-left 200ms var(--ds-ease-in-out, ease);
  }
}
/* \u5C0F\u65B9\u5757 = \u539F\u751F\u4FA7\u8FB9\u680F\u7684"\u9876\u90E8\u5207\u7247"\u91CD\u7ED8\uFF08v3\uFF0C\u732B\u732B\u62CD\u677F\uFF09\uFF1A\u539F\u7AD6\u6761\u5BBD\u5EA6
   56px\u3001\u7AD6\u6761\u540C\u6B3E\u5E95\u8272\uFF08sidebar-fill\uFF09\u3001\u53F3\u7F18\u540C\u6B3E\u7070\u8272\u7AD6\u7EBF\uFF08border-l1\uFF0C
   \u5373\u539F\u751F sidebarCol \u7684\u5206\u9694\u7EBF\uFF09\u2014\u2014\u50CF\u7AD6\u6761\u53EA\u5728 Header \u533A\u5B58\u5728\u3001\u4E0D\u5F80\u4E0B
   \u5EF6\u4F38\u3002\u76F4\u89D2\u3001\u65E0\u9634\u5F71\u65E0\u5706\u89D2\uFF08\u539F\u751F\u5C31\u662F\u8FD9\u6837\u7684\uFF09\uFF0C\u9C7C logo \u5F85\u5728\u539F\u751F\u51E0\u4F55
   \u4F4D\u7F6E\uFF1A\u7AD6\u6761 padding 18px \u4E0A/10px \u5DE6 + logoRow 36px \u5185\u7684 28px \u6309\u94AE
   \u2192 svg \u5DE6\u4E0A\u89D2 (12, 27)\uFF08\u9CB8\u9C7C\u6807 24\xD717.66 \u5728\u6309\u94AE\u5185\u5782\u76F4\u5C45\u4E2D\u7684\u7ED3\u679C\uFF09\u3002
   44px+ \u89E6\u63A7\u9762\u79EF\u7531 56\xD756 \u7684\u6574\u5757\u9762\u79EF\u4FDD\u8BC1\u3002z-index 9997\uFF1A\u8BA9\u4F4D IME \u60AC\u6D6E
   \u6761(9999)\u4E0E\u63D0\u9192\u5361\u7247(9998)\u3002 */
[${FAB_ATTR}] {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 9997;
  width: 56px;
  height: 56px; /* \u515C\u5E95\u503C\uFF1AJS \u6309 header \u5B9E\u9AD8\u52A8\u6001\u8986\u76D6\uFF08\u4E0E header \u7B49\u9AD8\u624D\u89C4\u6574\uFF09 */
  box-sizing: border-box;
  padding: 0;
  margin: 0;
  border-radius: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: var(--dsw-specific-sidebar-fill, #ffffff);
  border: none;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  color: var(--dsw-alias-label-primary, #222222);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  transition: height 200ms var(--ds-ease-in-out, ease);
}
[${FAB_ATTR}] svg {
  position: absolute;
  left: 12px;
  top: 27px;
}
[${FAB_ATTR}]:active svg { transform: scale(0.9); transition: transform 120ms ease; }
@media (max-width: 1023px) {
  html[${FURL_ROOT_ATTR}] [${FAB_ATTR}] { display: flex; }
}
/* \u5F39\u5C42\u907F\u8BA9\uFF1A\u8BBE\u7F6E\u9875/\u547D\u4EE4\u9762\u677F\u7B49 dialog\u3001\u63D0\u9192\u5361\u7247\u3001IME \u60AC\u6D6E\u6761\u51FA\u73B0\u65F6\u5C0F\u65B9\u5757
   \u6682\u65F6\u9000\u573A\u2014\u2014\u5B83\u4EEC\u90FD\u76D6\u4F4F\u5DE6\u4E0A\u89D2\uFF0C\u7559\u7740\u53EA\u4F1A\u8BEF\u89E6\uFF08\u70B9"\u5C0F\u65B9\u5757"\u5B9E\u9645\u70B9\u5230\u7684\u662F
   \u4E0A\u5C42\u5F39\u5C42\uFF09\u3002\u5F39\u5C42\u5173\u6389\u81EA\u52A8\u56DE\u6765\u3002 */
body:has(div[role="dialog"]) [${FAB_ATTR}],
body:has([${PENDING_BAR_ATTR}][data-visible="true"]) [${FAB_ATTR}],
html[${IME_ROOT_ATTR}] [${FAB_ATTR}] {
  display: none !important;
}
/* \u4E0E header \u540C\u8FDB\u9000\uFF08\u7ED3\u6784\u6027\u515C\u5E95\uFF0C\u732B\u732B\u8981\u6C42"\u59CB\u7EC8\u8DDF Header \u5728\u4E00\u8D77"\uFF09\uFF1A
   header \u88AB display:none \u9690\u85CF\uFF08\u6253\u5B57 IME \u6001\u7531 html[ime] \u89C4\u5219\u5373\u65F6\u540C\u6B65\uFF0C
   \u6B64\u5904\u515C\u4F4F\u4EFB\u4F55\u5176\u4ED6\u9690\u85CF\u6765\u6E90\uFF0C\u2264500ms \u8F6E\u8BE2\u5EF6\u8FDF\uFF09\u2192 \u8272\u5757\u540C\u65F6\u9000\u573A\uFF1Bheader
   \u663E\u793A \u2192 \u8272\u5757\u56DE\u5F52\u3002\u6807\u8BB0\u7531 JS \u6309 header \u8BA1\u7B97\u6837\u5F0F\u5728 tick \u91CC\u6253\u3002 */
[${FAB_ATTR}][data-meow-smooth-header-hidden] {
  display: none !important;
}
/* \u5C55\u5F00\u8F85\u52A9\u52A8\u753B\uFF08"\u5411\u4E0B\u5C55\u5F00"\u7684\u547C\u5E94\uFF09\uFF1A\u7A84\u5C4F\u5C55\u5F00\u77AC\u95F4\u4FA7\u8FB9\u680F\u5185\u5BB9\u4ECE\u4E0A\u5411\u4E0B
   \u63ED\u5F00\uFF08\u4E0B\u79FB+\u6DE1\u5165\uFF09\u3002\u9009\u62E9\u5668\u5728 frame \u5931\u53BB data-sidebar-collapsed \u7684\u4E00
   \u77AC\u95F4\u5F00\u59CB\u547D\u4E2D \u2192 \u52A8\u753B\u6070\u597D\u64AD\u4E00\u6B21\uFF1B\u6536\u8D77\u540E\u505C\u6B62\u547D\u4E2D\uFF0C\u4E0B\u6B21\u5C55\u5F00\u91CD\u64AD\u3002\u5217
   \u672C\u4F53\u7684\u6ED1\u51FA\u4ECD\u7531\u672C\u4F53 grid \u8FC7\u6E21\u8D1F\u8D23\uFF0C\u8FD9\u91CC\u53EA\u7ED9\u5185\u5BB9\u52A0\u7EB5\u5411\u7684"\u5C55\u5F00\u611F"\u3002
   transform \u53EA\u5B58\u5728\u4E8E 260ms \u52A8\u753B\u671F\u95F4\uFF0C\u4E0D\u5F71\u54CD\u5E38\u9A7B\u5E03\u5C40\u4E0E portal \u5F39\u5C42\u3002 */
@media (max-width: 1023px) {
  [data-slot="root"] > *:not([data-sidebar-collapsed]) [data-slot="sidebar"] > * {
    animation: meow-smooth-unfold 260ms var(--ds-ease-in-out, ease);
  }
}
@keyframes meow-smooth-unfold {
  from {
    opacity: 0;
    transform: translateY(-16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`;
var scrollTops = /* @__PURE__ */ new WeakMap();
var foldTrace = [];
var foldSelLast = "";
var foldVisLastPost = 0;
if (typeof window !== "undefined") window.__meowFoldTrace = foldTrace;
function noteFold(msg, post = false) {
  try {
    const ae = document.activeElement;
    const tag = ae instanceof HTMLTextAreaElement ? "ta" : ae instanceof HTMLElement ? ae.tagName : "null";
    const extra = ae instanceof HTMLTextAreaElement ? ` len=${ae.value.length}` : "";
    foldTrace.push(`${Date.now() % 1e5} ${msg} ae=${tag}${extra}`);
    if (foldTrace.length > 60) foldTrace.shift();
  } catch {
  }
  if (post) {
    try {
      void fetch("/plugins/meow-smooth/diag-log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msg: `fold ${msg}` }),
        keepalive: true
      }).catch(() => {
      });
    } catch {
    }
  }
}
function installFoldDiagListeners() {
  const onInput = (event) => {
    if (!(event.target instanceof HTMLTextAreaElement) || composerCardOf(event.target) === null) return;
    noteFold(`ipt len=${event.target.value.length}`);
  };
  const onBeforeInput = (event) => {
    if (!(event.target instanceof HTMLTextAreaElement) || composerCardOf(event.target) === null) return;
    noteFold(`bei ${event.inputType ?? "?"}`);
  };
  const onSelectionChange = () => {
    const ae = document.activeElement;
    if (!(ae instanceof HTMLTextAreaElement) || composerCardOf(ae) === null) return;
    const sel = document.getSelection();
    const type = sel?.type ?? "?";
    if (type === foldSelLast) return;
    foldSelLast = type;
    noteFold(`sel ${type}`);
  };
  document.addEventListener("input", onInput, true);
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("selectionchange", onSelectionChange);
  return () => {
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("beforeinput", onBeforeInput, true);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
}
function composerCardOf(target) {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-composer-card]");
}
function expandCard(card, instant = false) {
  if (card.getAttribute(FOLD_ATTR) !== FOLD_COLLAPSED) return;
  noteFold(`exp${instant ? "!" : ""}`);
  card.removeAttribute(FOLD_ATTR);
  card.style.removeProperty("--meow-smooth-one-line");
  const scroll = card.querySelector("[data-input-scroll]");
  if (instant && scroll !== null) {
    scroll.style.transition = "none";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scroll.style.transition = "";
      });
    });
  }
  if (scroll !== null) {
    const saved = scrollTops.get(scroll);
    if (saved !== void 0) {
      scroll.scrollTop = saved;
      scrollTops.delete(scroll);
    }
  }
}
function oneLineHeight(scroll) {
  const style = getComputedStyle(scroll);
  const pt = parseFloat(style.paddingTop);
  const pb = parseFloat(style.paddingBottom);
  const pad = (Number.isFinite(pt) ? pt : 0) + (Number.isFinite(pb) ? pb : 0);
  let line = parseFloat(style.lineHeight);
  if (!(Number.isFinite(line) && line > 0)) {
    const fs = parseFloat(style.fontSize);
    line = Number.isFinite(fs) && fs > 0 ? Math.round(fs * 1.2) : 20;
  }
  const total = line + pad;
  return total > 0 ? total : 30;
}
function collapseCard(card) {
  if (card.getAttribute(FOLD_ATTR) === FOLD_COLLAPSED) return;
  noteFold("cld");
  const scroll = card.querySelector("[data-input-scroll]");
  if (scroll === null) return;
  const one = oneLineHeight(scroll);
  if (scroll.scrollHeight <= one + 1) return;
  scrollTops.set(scroll, scroll.scrollTop);
  scroll.scrollTop = 0;
  card.style.setProperty("--meow-smooth-one-line", `${one}px`);
  card.setAttribute(FOLD_ATTR, FOLD_COLLAPSED);
}
function imeActive() {
  if (!isCoarsePointer()) return false;
  const vv = window.visualViewport;
  if (vv === null || vv.height === 0) return false;
  return window.screen.height - vv.height > window.screen.height * 0.2;
}
function sessionName() {
  const nameEl = document.querySelector('[data-slot="conversation.session.header"] nav button:disabled');
  return nameEl?.textContent?.trim() ?? "";
}
function titleRow() {
  const header = document.querySelector('[data-slot="conversation.session.header"] > header');
  if (header === null || !(header.firstElementChild instanceof HTMLElement)) return null;
  return header.firstElementChild;
}
var headerMenuScroll = 0;
var menuGuard = null;
function syncHeaderMenu() {
  const row = titleRow();
  if (row === null) return;
  const anyOpen = row.querySelector('button[aria-expanded="true"]') !== null;
  if (anyOpen) {
    if (row.getAttribute(HEADER_MENU_ATTR) !== "true") {
      headerMenuScroll = row.scrollLeft;
      row.setAttribute(HEADER_MENU_ATTR, "true");
      row.style.transform = headerMenuScroll > 0 ? `translateX(${-headerMenuScroll}px)` : "";
    }
  } else if (row.getAttribute(HEADER_MENU_ATTR) === "true") {
    row.removeAttribute(HEADER_MENU_ATTR);
    row.style.transform = "";
    void row.offsetWidth;
    row.scrollLeft = headerMenuScroll;
  }
}
var lastTouchX = 0;
var lastTouchY = 0;
var overscrollExempt = false;
var overscrollChain = [];
function onTouchStartOverscroll(event) {
  if (gestureApi?.busy() === true) return;
  overscrollChain = [];
  overscrollExempt = false;
  if (event.touches.length !== 1) return;
  const t0 = event.touches[0];
  lastTouchX = t0.clientX;
  lastTouchY = t0.clientY;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    overscrollExempt = true;
    return;
  }
  if (target.closest("[data-composer-card]") !== null) {
    overscrollExempt = true;
    return;
  }
  let node = target;
  while (node !== null && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      const oy = style.overflowY;
      const ox = style.overflowX;
      const sy = (oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1;
      const sx = (ox === "auto" || ox === "scroll") && node.scrollWidth > node.clientWidth + 1;
      if (sy || sx) overscrollChain.push(node);
    }
    node = node.parentElement;
  }
  const scroller = document.scrollingElement;
  if (scroller instanceof HTMLElement && scroller.scrollHeight > scroller.clientHeight + 1) {
    overscrollChain.push(scroller);
  }
}
function onTouchMoveOverscroll(event) {
  if (gestureApi?.busy() === true) return;
  const sel = document.getSelection();
  if (sel !== null && sel.type === "Range") return;
  if (overscrollExempt) return;
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  const dy = touch.clientY - lastTouchY;
  const dx = touch.clientX - lastTouchX;
  lastTouchY = touch.clientY;
  lastTouchX = touch.clientX;
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
  for (const node of overscrollChain) {
    const canY = dy !== 0 && (dy < 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1 || dy > 0 && node.scrollTop > 0);
    const canX = dx !== 0 && (dx < 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1 || dx > 0 && node.scrollLeft > 0);
    if (canY || canX) return;
  }
  if (event.cancelable) event.preventDefault();
}
function barElement() {
  const existing = document.querySelector(`[${BAR_ATTR}]`);
  if (existing !== null) return existing;
  const bar = document.createElement("div");
  bar.setAttribute(BAR_ATTR, "true");
  document.body.appendChild(bar);
  return bar;
}
function pinBar() {
  const bar = document.querySelector(`[${BAR_ATTR}]`);
  if (bar === null) return;
  const vv = window.visualViewport;
  bar.style.top = vv === null || vv.offsetTop <= 0 ? "0px" : `${vv.offsetTop}px`;
  const name = sessionName();
  if (bar.textContent !== name) bar.textContent = name;
}
function setImeState(on) {
  const root = document.documentElement;
  if (on) {
    if (root.getAttribute(IME_ROOT_ATTR) !== "true") {
      root.setAttribute(IME_ROOT_ATTR, "true");
      pinBar();
      if (barElement().textContent === "") {
        const name = sessionName();
        if (name !== "") barElement().textContent = name;
      }
    }
    pinBar();
  } else if (root.getAttribute(IME_ROOT_ATTR) === "true") {
    root.removeAttribute(IME_ROOT_ATTR);
    document.querySelector(`[${BAR_ATTR}]`)?.remove();
  }
}
var lastComposerPointer = 0;
var suppressing = false;
var supTrace = (msg) => {
  const w = window;
  const arr = w.__meowSuppressTrace ?? [];
  arr.push(`${Date.now() % 1e5} ${msg}`);
  if (arr.length > 20) arr.shift();
  w.__meowSuppressTrace = arr;
};
var suppressFocusIn = (event) => {
  document.documentElement.dataset.supCalled = "yes";
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || !isCoarsePointer()) {
    supTrace("skip not-ta-or-fine");
    return;
  }
  if (composerCardOf(target) === null) {
    supTrace("skip outside card");
    return;
  }
  if (Date.now() - lastComposerPointer < 600) {
    supTrace("skip recent user pointer");
    return;
  }
  suppressing = true;
  target.blur();
  suppressing = false;
  noteFold("SUPPRESS blur", true);
  supTrace("suppressed programmatic focus");
};
var lastIme = false;
function syncIme() {
  const now = imeActive();
  if (now === lastIme) {
    if (now) pinBar();
    return;
  }
  lastIme = now;
  if (now) {
    if (Date.now() - lastComposerPointer > 1e3) {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && composerCardOf(active) !== null) {
        noteFold("ime+ autofocused -> blur", true);
        active.blur();
        return;
      }
    }
    noteFold("ime+", true);
    setImeState(true);
  } else {
    noteFold("ime-", true);
    setImeState(false);
  }
}
function ensureComposerVisible() {
  const active = document.activeElement;
  if (!(active instanceof HTMLTextAreaElement)) return;
  if (composerCardOf(active) === null) return;
  const vv = window.visualViewport;
  if (vv === null || vv.height === 0) return;
  const rect = active.getBoundingClientRect();
  let needed = Math.ceil(rect.bottom - (vv.offsetTop + vv.height)) + 8;
  if (needed <= 0) return;
  noteFold(`vis need=${needed}`);
  const chain = [];
  let node = active.parentElement;
  while (node !== null && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1) chain.push(node);
    }
    node = node.parentElement;
  }
  const se = document.scrollingElement;
  if (se instanceof HTMLElement && se.scrollHeight > se.clientHeight + 1) chain.push(se);
  for (const box of chain) {
    if (needed <= 0) break;
    const room = box.scrollHeight - box.clientHeight - box.scrollTop;
    if (room <= 0) continue;
    const take = Math.min(needed, room);
    box.scrollTop += take;
    needed -= take;
  }
  if (Date.now() - foldVisLastPost > 800) {
    foldVisLastPost = Date.now();
    noteFold(`vis scrolled remain=${needed}`, true);
  }
}
function revealSoon() {
  window.setTimeout(ensureComposerVisible, 180);
  window.setTimeout(ensureComposerVisible, 380);
}
function onFocusIn(event) {
  const card = composerCardOf(event.target);
  if (card === null) return;
  if (event.target !== document.activeElement) return;
  noteFold("fi", true);
  expandCard(card);
  revealSoon();
  card.querySelector("textarea")?.setAttribute("enterkeyhint", "enter");
}
function onFocusOut(event) {
  const card = composerCardOf(event.target);
  if (card === null) return;
  if (composerCardOf(event.relatedTarget) === card) return;
  noteFold("fo", true);
  collapseCard(card);
}
function onDocumentClickCapture(event) {
  if (!isCoarsePointer()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (composerCardOf(target) !== null) return;
  const card = document.querySelector("[data-composer-card]");
  if (card !== null) collapseCard(card);
}
function onModeLabelToggle(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const label = target.closest('[data-slot="conversation.session.header.actions"] span[title]');
  if (label === null) return;
  if (label.dataset.meowFoldModeExpanded === "true") {
    delete label.dataset.meowFoldModeExpanded;
    label.style.fontSize = "";
    label.style.maxWidth = "";
  } else {
    label.dataset.meowFoldModeExpanded = "true";
    label.style.fontSize = "12px";
    label.style.maxWidth = "180px";
  }
}
function onModeLabelDismiss(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('[data-slot="conversation.session.header.actions"] span[title]') !== null) return;
  for (const label of document.querySelectorAll(
    '[data-slot="conversation.session.header.actions"] span[title][data-meow-smooth-mode-expanded="true"]'
  )) {
    delete label.dataset.meowFoldModeExpanded;
    label.style.fontSize = "";
    label.style.maxWidth = "";
  }
}
function onPointerDownCapture(event) {
  const card = composerCardOf(event.target);
  if (card === null) return;
  const tgt = event.target instanceof Element ? event.target : null;
  noteFold(`pd ${tgt?.closest("textarea") !== null ? "ta" : "card"}`, true);
  lastComposerPointer = Date.now();
  expandCard(card, true);
  revealSoon();
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('button, select, input, textarea, a, [role="menuitem"], [role="menu"]')) return;
  const ta = card.querySelector("textarea");
  if (ta !== null && !ta.disabled && !ta.readOnly) ta.focus();
}
var coarseCache;
function isCoarsePointer() {
  if (coarseCache === void 0) {
    coarseCache = typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)").matches : false;
  }
  return coarseCache;
}
function onKeyDownCapture(event) {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.isComposing || event.keyCode === 229) return;
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || target.readOnly || target.disabled) return;
  if (composerCardOf(target) === null) return;
  if (!isCoarsePointer()) return;
  noteFold("keyEnter", true);
  event.stopPropagation();
}
function lockViewport() {
  const meta = document.querySelector('meta[name="viewport"]');
  const want = "maximum-scale=1, user-scalable=no";
  if (meta !== null) {
    const content = meta.getAttribute("content") ?? "";
    if (!content.includes("user-scalable")) {
      meta.setAttribute("content", `${content.replace(/,\s*$/, "")}, ${want}`);
    } else if (!content.includes("maximum-scale=1")) {
      meta.setAttribute("content", `${content.replace(/user-scalable=[^,]+/g, "user-scalable=no")}, maximum-scale=1`);
    }
  } else {
    const created = document.createElement("meta");
    created.name = "viewport";
    created.content = `width=device-width, initial-scale=1, ${want}`;
    document.head.appendChild(created);
  }
}
function lockDesktopZoom() {
  const onWheel = (event) => {
    if (event.ctrlKey) event.preventDefault();
  };
  const onKeyDown = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const code = event.code;
    if (code === "Equal" || code === "Minus" || code === "Digit0" || code === "NumpadAdd" || code === "NumpadSubtract" || code === "Numpad0") {
      event.preventDefault();
    }
  };
  document.addEventListener("wheel", onWheel, { capture: true, passive: false });
  document.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    document.removeEventListener("wheel", onWheel, { capture: true });
    document.removeEventListener("keydown", onKeyDown, { capture: true });
  };
}
var SIDEBAR_AUTO_COLLAPSE = 1024;
function frameElement() {
  const root = document.querySelector('[data-slot="root"]');
  if (root !== null && root.firstElementChild instanceof HTMLElement) return root.firstElementChild;
  return null;
}
function maybeCollapseSidebar(layout) {
  const frame = frameElement();
  if (frame === null) return;
  if (frame.getBoundingClientRect().width >= SIDEBAR_AUTO_COLLAPSE) return;
  if (frame.hasAttribute("data-sidebar-collapsed") && furlRoot()) return;
  if (gestureApi?.collapseToZero() === true) return;
  layout.toggleSidebar();
  syncSidebarFurl();
}
var OFFICIAL_FOOT_BUTTONS = 1;
var layoutReady = false;
function furlRoot() {
  return document.documentElement.getAttribute(FURL_ROOT_ATTR) === "true";
}
function setFurled(on) {
  if (on) document.documentElement.setAttribute(FURL_ROOT_ATTR, "true");
  else document.documentElement.removeAttribute(FURL_ROOT_ATTR);
}
function railToggleButton() {
  const column = document.querySelector('[data-slot="sidebar"] > *');
  const logoRow = column?.firstElementChild ?? null;
  if (logoRow === null) return null;
  const buttons = logoRow.querySelectorAll("button");
  return buttons.length > 0 ? buttons[buttons.length - 1] : null;
}
function railHasExtraButtons() {
  const column = document.querySelector('[data-slot="sidebar"] > *');
  const foot = column?.lastElementChild ?? null;
  if (foot === null) return false;
  return foot.querySelectorAll("button").length > OFFICIAL_FOOT_BUTTONS;
}
var railRevealed = false;
var lastRailCollapsed = null;
function sidebarFab() {
  const existing = document.querySelector(`[${FAB_ATTR}]`);
  if (existing !== null) return existing;
  const fab = document.createElement("button");
  fab.type = "button";
  fab.setAttribute(FAB_ATTR, "true");
  fab.setAttribute("aria-label", "\u6253\u5F00\u4FA7\u8FB9\u680F");
  document.body.appendChild(fab);
  return fab;
}
function populateFabIcon() {
  const fab = sidebarFab();
  if (fab.childElementCount > 0 || fab.dataset.meowFabIconFail === "1") return;
  const toggle = railToggleButton();
  if (toggle === null) return;
  const mark = toggle.querySelector("span svg");
  if (mark === null) {
    fab.dataset.meowFabIconFail = "1";
    return;
  }
  fab.appendChild(mark.cloneNode(true));
}
function syncFabHeight() {
  const header = document.querySelector('[data-slot="conversation.session.header"] > header');
  const fab = sidebarFab();
  if (header === null) {
    fab.removeAttribute(HEADER_HIDDEN_ATTR);
    return;
  }
  const isEmptyShell = header.firstElementChild === null;
  let hidden = !isEmptyShell && getComputedStyle(header).display === "none";
  if (!hidden && !isEmptyShell) {
    const r = header.getBoundingClientRect();
    if (r.height > 1 && r.width > 1) {
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top !== null && !header.contains(top)) hidden = true;
    }
  }
  if (hidden) fab.setAttribute(HEADER_HIDDEN_ATTR, "1");
  else fab.removeAttribute(HEADER_HIDDEN_ATTR);
  const h = Math.round(header.getBoundingClientRect().height);
  if (!(h > 1)) return;
  if (fab.dataset.meowH === String(h)) return;
  fab.dataset.meowH = String(h);
  fab.style.height = `${h}px`;
}
function syncSidebarFurl() {
  if (gestureApi?.busy() === true) return;
  if (!layoutReady) return;
  if (!isCoarsePointer()) {
    if (furlRoot()) setFurled(false);
    return;
  }
  syncFabHeight();
  const frame = frameElement();
  if (frame === null) return;
  const narrow = frame.getBoundingClientRect().width < SIDEBAR_AUTO_COLLAPSE;
  const collapsed = frame.hasAttribute("data-sidebar-collapsed");
  if (lastRailCollapsed !== null && collapsed !== lastRailCollapsed) railRevealed = false;
  lastRailCollapsed = collapsed;
  if (!narrow) gestureApi?.clearHold();
  if (!narrow || !collapsed || railRevealed || gestureApi?.narrowHold() === true) {
    if (furlRoot()) setFurled(false);
    return;
  }
  setFurled(true);
  gestureApi?.clearHold();
  populateFabIcon();
}
function onClickDismissSidebar(event, layout) {
  const dbg = (msg) => {
    if (window.location.search.includes("meow-debug")) console.log(`[meow-smooth] dismiss: ${msg}`);
  };
  const frame = frameElement();
  if (frame === null) {
    dbg("no frame");
    return;
  }
  if (frame.getBoundingClientRect().width >= SIDEBAR_AUTO_COLLAPSE) {
    dbg("wide viewport");
    return;
  }
  const collapsed = frame.hasAttribute("data-sidebar-collapsed");
  const furled = furlRoot();
  if (collapsed && furled) {
    dbg("zero-tier, nothing to do");
    return;
  }
  if (gestureApi?.busy() === true) {
    dbg("gesture busy");
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    dbg("target not element");
    return;
  }
  const overlayHit = target.closest(
    '[data-slot="sidebar"], [data-side="sidebar"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="dialog"], [data-shell-overlay]'
  );
  if (overlayHit !== null) {
    dbg(`inside overlay ${overlayHit.tagName}`);
    return;
  }
  const column = document.querySelector('[data-slot="sidebar"] > *');
  if (column instanceof HTMLElement && event.clientX < column.getBoundingClientRect().right) {
    dbg(`inside column x=${event.clientX} right=${Math.round(column.getBoundingClientRect().right)}`);
    return;
  }
  const taken = gestureApi?.collapseToZero() === true;
  dbg(`collapseToZero \u2192 ${taken}`);
  if (taken) return;
  layout.toggleSidebar();
  syncSidebarFurl();
}
var localPending = [];
var currentSessionId;
var hostApprovals = [];
var hostQuestions = [];
var hostFailures = [];
var SEEN_FAILURES_KEY = "meow-smooth:seen-failures";
var SEEN_FAILURES_CAP = 60;
function loadSeenFailures() {
  try {
    const raw = localStorage.getItem(SEEN_FAILURES_KEY);
    const list = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((item) => typeof item === "string") : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function markFailureSeen(id) {
  seenFailures.add(id);
  try {
    const list = [...seenFailures].slice(-SEEN_FAILURES_CAP);
    localStorage.setItem(SEEN_FAILURES_KEY, JSON.stringify(list));
  } catch {
  }
}
var seenFailures = loadSeenFailures();
var openSession;
var refreshSessions;
var bannerItem;
var bannerMode = "idle";
var suppressedUntil = 0;
var suppressedKey = "";
function officialPanelVisible() {
  return document.querySelector(
    "[data-approval-key], [data-question-key], [data-plan-review-key]"
  ) !== null;
}
function pendingBarElement() {
  const existing = document.querySelector(`[${PENDING_BAR_ATTR}]`);
  if (existing !== null) return existing;
  const bar = document.createElement("div");
  bar.setAttribute(PENDING_BAR_ATTR, "true");
  document.body.appendChild(bar);
  return bar;
}
function ensurePendingBarSkeleton(bar) {
  if (bar.firstElementChild !== null) return;
  const title = document.createElement("div");
  title.className = "toast-title";
  const sub = document.createElement("div");
  sub.className = "toast-sub";
  const fail = document.createElement("div");
  fail.className = "toast-fail";
  bar.append(title, sub, fail);
  bar.addEventListener("click", onPendingBarClick);
  let touchStartY = 0;
  let touchDy = 0;
  bar.addEventListener("touchstart", (event) => {
    touchStartY = event.touches[0]?.clientY ?? 0;
    touchDy = 0;
  }, { passive: true });
  bar.addEventListener("touchmove", (event) => {
    const y = event.touches[0]?.clientY ?? touchStartY;
    touchDy = y - touchStartY;
  }, { passive: true });
  bar.addEventListener("touchend", () => {
    if (touchDy < -40) hideToast(true);
  });
}
function hideToast(suppress = false) {
  const bar = pendingBarElement();
  if (bar.getAttribute("data-visible") === "true") {
    bar.style.transform = "translateY(calc(-100% - 24px))";
    window.setTimeout(() => {
      bar.removeAttribute("data-visible");
      bar.style.transform = "";
    }, 240);
  } else {
    bar.removeAttribute("data-visible");
  }
  bar.removeAttribute("data-mode");
  bannerMode = "idle";
  if (suppress && bannerItem !== void 0) {
    suppressedUntil = Date.now() + 3e4;
    suppressedKey = `${bannerItem.sessionId}:${bannerItem.kind}${bannerItem.failureId !== void 0 ? `:${bannerItem.failureId}` : ""}`;
  }
}
function showFailHint(text) {
  const bar = pendingBarElement();
  ensurePendingBarSkeleton(bar);
  const fail = bar.querySelector(".toast-fail");
  if (fail !== null) fail.textContent = text;
  bar.setAttribute("data-mode", "fail");
  bar.setAttribute("data-visible", "true");
  bannerMode = "fail";
  window.setTimeout(() => {
    if (bannerMode === "fail") {
      bannerMode = "idle";
      document.querySelector(`[${PENDING_BAR_ATTR}]`)?.removeAttribute("data-mode");
    }
  }, 6e3);
}
function mergedPendingItems() {
  const out = [];
  const localBySession = /* @__PURE__ */ new Map();
  for (const item of localPending) localBySession.set(item.sessionId, item);
  const panelShown = officialPanelVisible();
  for (const approval of hostApprovals) {
    if (approval.sessionId === currentSessionId && (panelShown || IS_DESKTOP)) continue;
    const local = localBySession.get(approval.sessionId);
    out.push({
      sessionId: approval.sessionId,
      title: local?.title ?? "",
      kind: "approval",
      approvalId: approval.approvalId,
      toolName: approval.toolName,
      ...approval.reason !== void 0 ? { reason: approval.reason } : {},
      ...approval.command !== void 0 ? { command: approval.command } : {},
      askedAt: approval.askedAt,
      orphan: approval.orphan
    });
  }
  const hostQuestionSessions = /* @__PURE__ */ new Set();
  for (const question of hostQuestions) {
    if (question.sessionId === currentSessionId && (panelShown || IS_DESKTOP)) continue;
    hostQuestionSessions.add(question.sessionId);
    const local = localBySession.get(question.sessionId);
    out.push({
      sessionId: question.sessionId,
      title: question.title ?? local?.title ?? "",
      kind: question.planReview === true ? "plan-review" : "question",
      askedAt: question.askedAt,
      orphan: question.orphan
    });
  }
  for (const item of localPending) {
    if (item.status === "approval") continue;
    if (hostQuestionSessions.has(item.sessionId)) continue;
    if (item.sessionId === currentSessionId && (panelShown || IS_DESKTOP)) continue;
    out.push({
      sessionId: item.sessionId,
      title: item.title,
      kind: item.status,
      askedAt: Date.now()
    });
  }
  for (const failure of hostFailures) {
    if (seenFailures.has(failure.id)) continue;
    if (failure.sessionId === currentSessionId) continue;
    out.push({
      sessionId: failure.sessionId,
      title: failure.title ?? "",
      kind: "failed",
      failureId: failure.id,
      ...failure.message !== void 0 ? { message: failure.message } : {},
      askedAt: failure.at
    });
  }
  const rank = (kind) => kind === "approval" ? 0 : kind === "question" ? 1 : kind === "failed" ? 2 : 3;
  out.sort((a, b) => rank(a.kind) - rank(b.kind) || b.askedAt - a.askedAt);
  return out;
}
function jumpToSession(item, attempt = 0) {
  if (openSession === void 0) {
    showFailHint("\u65E0\u6CD5\u81EA\u52A8\u5207\u6362\uFF08\u8DF3\u8F6C\u80FD\u529B\u4E0D\u53EF\u7528\uFF09\uFF0C\u8BF7\u5728\u4FA7\u8FB9\u680F\u9009\u62E9\u8BE5\u4F1A\u8BDD\u3002");
    return;
  }
  let thrown = null;
  try {
    openSession(item.sessionId);
  } catch (error) {
    thrown = error;
  }
  if (thrown !== null) {
    if (attempt < 3) {
      const retry = () => window.setTimeout(() => {
        jumpToSession(item, attempt + 1);
      }, 800);
      if (attempt === 0 && refreshSessions !== void 0) {
        void refreshSessions().then(retry).catch(retry);
      } else {
        retry();
      }
      return;
    }
    showFailHint("\u65E0\u6CD5\u81EA\u52A8\u5207\u6362\uFF08\u4F1A\u8BDD\u5217\u8868\u672A\u540C\u6B65\uFF09\uFF0C\u8BF7\u5728\u4FA7\u8FB9\u680F\u9009\u62E9\u8BE5\u4F1A\u8BDD\u3002");
    return;
  }
  window.setTimeout(() => {
    if (officialPanelVisible()) {
      updatePendingBanner();
    } else {
      showFailHint("\u5DF2\u8FDB\u5165\u4F1A\u8BDD\uFF0C\u4F46\u95EE\u9898\u7A97\u672A\u663E\u793A\uFF08iOS \u5DF2\u77E5\u9650\u5236\uFF09\uFF0C\u91CD\u5F00\u9875\u9762\u53EF\u6062\u590D\u56DE\u7B54\u3002");
    }
  }, 1500);
}
function onPendingBarClick() {
  const item = bannerItem;
  if (item === void 0) return;
  if (item.sessionId !== currentSessionId) {
    jumpToSession(item);
    return;
  }
  if (officialPanelVisible()) {
    hideToast(false);
    return;
  }
  window.location.reload();
}
var notifyHandle;
var gestureApi;
function notifyItemsOf(merged) {
  return merged.filter((item) => item.kind !== "failed").map((item) => ({
    sessionId: item.sessionId,
    kind: item.kind,
    id: item.kind === "approval" && item.approvalId !== void 0 ? item.approvalId : `${item.sessionId}:${item.kind}`,
    title: item.title,
    ...item.toolName !== void 0 && item.toolName !== "" ? { toolName: item.toolName } : {}
  }));
}
function updatePendingBanner() {
  const items = mergedPendingItems();
  notifyHandle?.onPending(notifyItemsOf(items));
  const bar = pendingBarElement();
  if (items.length === 0) {
    bannerItem = void 0;
    hideToast(false);
    return;
  }
  const item = items[0];
  if (bannerItem === void 0 || bannerItem.sessionId !== item.sessionId || bannerItem.kind !== item.kind || bannerItem.failureId !== item.failureId) {
    bannerMode = "idle";
    suppressedUntil = 0;
  }
  bannerItem = item;
  const key = `${item.sessionId}:${item.kind}${item.failureId !== void 0 ? `:${item.failureId}` : ""}`;
  if (suppressedUntil > Date.now() && suppressedKey === key) return;
  ensurePendingBarSkeleton(bar);
  if (bannerMode !== "fail") bar.removeAttribute("data-mode");
  const titleEl = bar.querySelector(".toast-title");
  const subEl = bar.querySelector(".toast-sub");
  if (titleEl === null || subEl === null) return;
  const name = item.title === "" ? "\u672A\u547D\u540D\u4F1A\u8BDD" : item.title;
  let what;
  if (item.kind === "failed") {
    if (item.failureId !== void 0) markFailureSeen(item.failureId);
    what = item.message !== void 0 && item.message !== "" ? `\u8FD0\u884C\u5931\u8D25\uFF1A${item.message.slice(0, 90)}${item.message.length > 90 ? "\u2026" : ""}\uFF0C\u70B9\u51FB\u67E5\u770B\u2026` : "AI \u56DE\u5408\u56E0\u9519\u8BEF\u4E2D\u65AD\uFF0C\u70B9\u51FB\u67E5\u770B\u2026";
  } else {
    what = item.kind === "approval" ? "\u6709\u6743\u9650\u7533\u8BF7\u5F85\u5904\u7406\uFF0C\u70B9\u51FB\u67E5\u770B\u2026" : item.kind === "plan-review" ? "\u6709\u8BA1\u5212\u5F85\u5BA1\uFF0C\u70B9\u51FB\u67E5\u770B\u2026" : "\u6709\u63D0\u95EE\u5F85\u56DE\u7B54\uFF0C\u70B9\u51FB\u67E5\u770B\u2026";
  }
  titleEl.textContent = name;
  subEl.textContent = what;
  bar.style.transform = "";
  bar.setAttribute("data-visible", "true");
}
function reportLocalPending(items, current) {
  localPending = items;
  currentSessionId = current;
  updatePendingBanner();
}
async function pollHostApprovals() {
  try {
    const res = await fetch("/plugins/meow-smooth/pending", {
      cache: "no-store",
      headers: { "x-meow-focus": document.hasFocus() ? "1" : "0" }
    });
    if (!res.ok) {
      hostApprovals = [];
      hostQuestions = [];
      hostFailures = [];
      updatePendingBanner();
      return;
    }
    const data = await res.json();
    hostApprovals = Array.isArray(data.approvals) ? data.approvals : [];
    hostQuestions = Array.isArray(data.questions) ? data.questions : [];
    const events = Array.isArray(data.events) ? data.events : [];
    hostFailures = events.filter((event) => event.kind === "failed").map((event) => ({
      id: event.id,
      sessionId: event.sessionId,
      ...event.title !== void 0 ? { title: event.title } : {},
      ...event.message !== void 0 ? { message: event.message } : {},
      at: typeof event.at === "number" ? event.at : Date.now()
    }));
    notifyHandle?.onPollResult({ events });
  } catch {
    hostApprovals = [];
    hostQuestions = [];
    hostFailures = [];
  }
  updatePendingBanner();
}
function installPendingBanner(open, refresh) {
  openSession = open;
  refreshSessions = refresh;
  void pollHostApprovals();
  const pollTick = window.setInterval(() => {
    void pollHostApprovals();
  }, 3e3);
  const onVisibility = () => {
    if (document.visibilityState === "visible") void pollHostApprovals();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.clearInterval(pollTick);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
function FoldDock({ session, onSessionSwitch, reportPending, useSessions }) {
  (0, import_react.useEffect)(() => {
    if (!isCoarsePointer()) return;
    const timer = window.setTimeout(() => {
      const ta = document.querySelector("[data-composer-card] textarea");
      if (ta instanceof HTMLTextAreaElement && document.activeElement === ta) {
        ta.blur();
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, [session.sessionId]);
  (0, import_react.useEffect)(() => {
    onSessionSwitch();
  }, [session.sessionId, onSessionSwitch]);
  const pendingItems = useSessions((snapshot) => {
    const raw = snapshot;
    const items = raw?.items ?? [];
    return items.filter((item) => item.pendingInteraction !== void 0).map((item) => ({
      sessionId: item.sessionId,
      title: item.title ?? "",
      status: item.pendingInteraction
    }));
  });
  (0, import_react.useEffect)(() => {
    reportPending(pendingItems, session.sessionId);
  }, [pendingItems, session.sessionId, reportPending]);
  return null;
}
var inject = ["slots", "layout", "sessions"];
function apply(ctx) {
  document.documentElement.dataset.meowApplyStage = "enter";
  const w = window;
  w.__meowSmoothClientDispose?.();
  const disposers = [];
  if (new URLSearchParams(window.location.search).get("meow-smooth-ui") === "off") {
    console.log("[meow-smooth] UI injection OFF (meow-smooth-ui=off) \u2014 native UI only");
    return;
  }
  const slots = ctx?.slots;
  if (slots === void 0 || typeof slots.inject !== "function") {
    console.warn("[meow-smooth] slots service unavailable; sidebar auto-collapse disabled");
    return;
  }
  const layout = ctx?.layout;
  if (layout === void 0 || typeof layout.toggleSidebar !== "function") {
    console.warn("[meow-smooth] layout service unavailable; sidebar auto-collapse disabled");
    return;
  }
  document.querySelector("style[data-meow-fold-css]")?.remove();
  const style = document.createElement("style");
  style.dataset.meowFoldCss = "true";
  style.textContent = FOLD_CSS;
  document.head.appendChild(style);
  disposers.push(() => {
    style.remove();
  });
  lockViewport();
  const onGestureStart = (e) => {
    e.preventDefault();
  };
  const onGestureChange = (e) => {
    e.preventDefault();
  };
  document.addEventListener("gesturestart", onGestureStart);
  document.addEventListener("gesturechange", onGestureChange);
  disposers.push(() => {
    document.removeEventListener("gesturestart", onGestureStart);
    document.removeEventListener("gesturechange", onGestureChange);
  });
  disposers.push(lockDesktopZoom());
  disposers.push(installSettingsMobile());
  document.addEventListener("focusin", onFocusIn);
  supTrace("registered");
  document.addEventListener("focusin", suppressFocusIn, { capture: true });
  document.documentElement.dataset.meowApplyStage = "suppressor-registered";
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("pointerdown", onPointerDownCapture, { capture: true });
  document.addEventListener("keydown", onKeyDownCapture, { capture: true });
  document.addEventListener("click", onDocumentClickCapture, { capture: true });
  disposers.push(installFoldDiagListeners());
  document.addEventListener("click", onModeLabelDismiss, { capture: true });
  document.addEventListener("click", onModeLabelToggle);
  disposers.push(() => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusin", suppressFocusIn, { capture: true });
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("pointerdown", onPointerDownCapture, { capture: true });
    document.removeEventListener("keydown", onKeyDownCapture, { capture: true });
    document.removeEventListener("click", onDocumentClickCapture, { capture: true });
    document.removeEventListener("click", onModeLabelDismiss, { capture: true });
    document.removeEventListener("click", onModeLabelToggle);
  });
  menuGuard = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (target instanceof Element && target.closest('[data-slot="conversation.session.header"] > header') !== null) {
          syncHeaderMenu();
          return;
        }
      } else {
        const row = titleRow();
        if (row !== null && row.getAttribute(HEADER_MENU_ATTR) === "true") {
          syncHeaderMenu();
          return;
        }
      }
    }
  });
  menuGuard.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-expanded"],
    childList: true
  });
  disposers.push(() => {
    menuGuard?.disconnect();
  });
  document.addEventListener("touchstart", onTouchStartOverscroll, { passive: true });
  document.addEventListener("touchmove", onTouchMoveOverscroll, { passive: false });
  disposers.push(() => {
    document.removeEventListener("touchstart", onTouchStartOverscroll);
    document.removeEventListener("touchmove", onTouchMoveOverscroll);
  });
  const onVisualViewportResize = () => {
    syncIme();
    ensureComposerVisible();
  };
  window.visualViewport?.addEventListener("resize", onVisualViewportResize);
  window.visualViewport?.addEventListener("scroll", pinBar);
  let furlTick = 0;
  if (isCoarsePointer()) {
    furlTick = window.setInterval(() => {
      syncIme();
      syncSidebarFurl();
    }, 500);
  }
  disposers.push(() => {
    window.visualViewport?.removeEventListener("resize", onVisualViewportResize);
    window.visualViewport?.removeEventListener("scroll", pinBar);
    if (furlTick !== 0) window.clearInterval(furlTick);
  });
  layoutReady = true;
  gestureApi = installSidebarGesture({
    layout,
    frameElement,
    setFurled,
    isFurled: furlRoot,
    isCoarsePointer
  });
  disposers.push(() => {
    w.__meowSmoothGestureDispose?.();
  });
  const onFabClick = () => {
    if (railHasExtraButtons()) {
      railRevealed = true;
      setFurled(false);
      return;
    }
    setFurled(false);
    layout.toggleSidebar();
  };
  sidebarFab().addEventListener("click", onFabClick);
  disposers.push(() => {
    sidebarFab().removeEventListener("click", onFabClick);
  });
  syncSidebarFurl();
  const sessions = ctx?.sessions;
  const onDismissClick = (event) => {
    onClickDismissSidebar(event, layout);
  };
  document.addEventListener("click", onDismissClick, { capture: true });
  disposers.push(() => {
    document.removeEventListener("click", onDismissClick, { capture: true });
  });
  let openSessionFn;
  let refreshSessionsFn;
  if (sessions === void 0 || typeof sessions.open !== "function") {
    console.warn("[meow-smooth] sessions service unavailable; banner jump disabled");
  } else {
    openSessionFn = (sessionId) => {
      sessions.open(sessionId);
    };
    if (typeof sessions.refresh === "function") {
      refreshSessionsFn = () => sessions.refresh();
    }
  }
  disposers.push(installPendingBanner(openSessionFn, refreshSessionsFn));
  notifyHandle = installNotifyClient({ openSession: openSessionFn });
  disposers.push(() => {
    notifyHandle?.dispose();
  });
  slots.inject("conversation.composer.dock", () => slots.register({
    name: "conversation.composer.dock",
    id: "meow-smooth",
    order: 90,
    inject: () => ({
      onSessionSwitch: () => maybeCollapseSidebar(layout),
      reportPending: reportLocalPending
    })
  }, FoldDock));
  w.__meowSmoothClientDispose = () => {
    for (const fn of disposers.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
    delete w.__meowSmoothClientDispose;
  };
}
    return module.exports;
  }
});
//# sourceMappingURL=client.js.map

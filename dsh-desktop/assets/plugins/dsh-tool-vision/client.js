/**
 * dsh-tool-vision — browser half.
 *
 * A "视觉模型" section inside the Web UI settings page: edits the
 * `tool-vision` settings namespace (API endpoint, key, model, bridge
 * options) through the settings scope transport. Changes hot-apply via the
 * host settings provider — no restart needed.
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-tool-vision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS = ".__tv_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__tv_field{display:flex;flex-direction:column;gap:4px}" +
      ".__tv_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__tv_override{font-size:10px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__tv_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tv_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__tv_row{display:flex;align-items:center;gap:8px}" +
      ".__tv_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__tv_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__tv_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__tv_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__tv_btn:disabled{opacity:.5;cursor:default}" +
      ".__tv_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__tv_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tv_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__tv_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tv_advanced{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}" +
      ".__tv_advancedSummary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);user-select:none;display:flex;align-items:center;gap:5px}" +
      ".__tv_advancedArrow{display:inline-block;transition:transform .18s ease;font-size:18px;line-height:1;color:var(--dsw-alias-label-secondary);margin-top:-1px}" +
      ".__tv_advanced[open] .__tv_advancedArrow{transform:rotate(90deg)}";
    var tagId = "dsh-tool-vision/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-tool-vision";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "toolVision";
    var inject = ["slots", "locale", "settingsScope"];
    var zh = {
      nav: "视觉模型",
      intro: "外置视觉模型配置：Agent 通过 inspect_image 工具把图片发给该端点分析。修改后即时生效（settings.yaml 热重载）。",
      apiKeyHint: "留空保持当前密钥。密钥只写不读，不会回显。",
      maxTokens: "最大输出 Tokens",
      timeoutMs: "请求超时（毫秒）",
      maxImageBytes: "本地图片大小上限（字节）",
      bridgeTextOnly: "图片桥接（文本模型贴图自动转 inspect_image 指引）",
      bridgeExportDir: "桥接图片导出目录（空 = 系统临时目录）",
      multimodalModels: "多模态白名单（逗号分隔，这些模型直收图片块）",
      requestGuard: "请求兜底（发往文本模型的图片块在请求发出前自动降级为 inspect_image 指引，避免整轮失败）",
      advanced: "高级设置",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 tool-vision 命名空间？）",
      overridden: "已覆盖",
      loading: "加载中…"
    };
    var en = {
      nav: "Vision Model",
      intro: "External vision model config: the agent sends images to this endpoint via the inspect_image tool. Changes apply immediately (settings.yaml hot-reload).",
      apiKeyHint: "Leave blank to keep the current key. The key is write-only and never echoed.",
      maxTokens: "Max output tokens",
      timeoutMs: "Request timeout (ms)",
      maxImageBytes: "Max local image size (bytes)",
      bridgeTextOnly: "Image bridge (pasted images on text-only models become inspect_image hints)",
      bridgeExportDir: "Bridge export dir (empty = system temp)",
      multimodalModels: "Multimodal whitelist (comma-separated; these models receive image blocks directly)",
      requestGuard: "Request guard (image blocks headed to a text-only model are downgraded to inspect_image hints before dispatch, so the turn never hard-fails)",
      advanced: "Advanced settings",
      save: "Save",
      reset: "Reset",
      saved: "Saved",
      saving: "Saving…",
      error: "Save failed",
      unavailable: "Settings namespace unavailable (tool-vision namespace not registered server-side?)",
      overridden: "overridden",
      loading: "Loading…"
    };

    // ── field spec ────────────────────────────────────────────────────────
    var FIELDS = [
      { key: "baseURL", label: "API Base URL", type: "text", placeholder: "https://api.openai.com/v1" },
      { key: "apiKey", label: "API Key", type: "password", secret: true },
      { key: "apiKeyEnv", label: "API Key 环境变量（apiKey 为空时读取）", type: "text" },
      { key: "model", label: "视觉模型", type: "text", placeholder: "gpt-4o-mini" },
      { key: "maxTokens", label: "最大输出 Tokens", type: "number" },
      { key: "timeoutMs", label: "请求超时（毫秒）", type: "number" },
      { key: "maxImageBytes", label: "图片大小上限（字节）", type: "number" },
      { key: "bridgeTextOnly", label: "图片桥接开关", type: "checkbox" },
      { key: "bridgeExportDir", label: "桥接导出目录", type: "text" },
      { key: "multimodalModels", label: "多模态白名单（逗号分隔）", type: "csv" },
      { key: "requestGuard", label: "请求兜底开关", type: "checkbox" }
    ];
    var ZH_HINTS = {
      apiKey: "apiKeyHint",
      maxTokens: "maxTokens",
      timeoutMs: "timeoutMs",
      maxImageBytes: "maxImageBytes",
      bridgeTextOnly: "bridgeTextOnly",
      bridgeExportDir: "bridgeExportDir",
      multimodalModels: "multimodalModels",
      requestGuard: "requestGuard"
    };

    function labelOf(f) {
      return f.label;
    }

    // ── component ─────────────────────────────────────────────────────────
    function VisionSection(props) {
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [draft, setDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);

      react.useEffect(function () {
        scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); if (scope.dispose) scope.dispose(); };
      }, [scope]);
      // Seed the draft ONLY when the snapshot becomes ready — never on value
      // churn. settingsScope.getSnapshot() returns a fresh object per call,
      // so depending on snapshot.value would reset user input on every render
      // (typing appears dead).
      react.useEffect(function () {
        if (ready) setDraft(function (prev) { return Object.assign({}, prev, valueToDraft(snapshot.value)); });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__tv_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__tv_status" }, t("loading"));

      var value = snapshot.value;
      var user = snapshot.user || {};

      function fieldDraft(f) {
        if (f.type === "csv") return draft[f.key] !== void 0 ? draft[f.key] : draftToCsv(value[f.key]);
        if (f.type === "checkbox") return draft[f.key] !== void 0 ? draft[f.key] : Boolean(value[f.key]);
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[f.key] ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) {
          var next = Object.assign({}, prev);
          next[f.key] = v;
          return next;
        });
        setNotice(null);
        setError(null);
      }

      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        var writes = FIELDS.map(function (f) {
          var d = fieldDraft(f);
          if (f.type === "csv") {
            var arr = String(d).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
            var cur = value[f.key] || [];
            if (arr.length === cur.length && arr.every(function (x, i) { return x === cur[i]; })) return Promise.resolve();
            return scope.set(f.key, arr);
          }
          if (f.type === "checkbox") {
            if (Boolean(d) === Boolean(value[f.key])) return Promise.resolve();
            return Boolean(d) ? scope.set(f.key, true) : scope.unset(f.key);
          }
          if (f.type === "password") {
            if (!d) return Promise.resolve(); // blank keeps the current key
            if (d === String(value[f.key] ?? "")) return Promise.resolve();
            return scope.set(f.key, d);
          }
          if (String(d) === String(value[f.key] ?? "")) return Promise.resolve();
          if (String(d).trim() === "" && !(f.key in user)) return Promise.resolve();
          return String(d).trim() === "" ? scope.unset(f.key) : scope.set(f.key, f.type === "number" ? Number(d) : d);
        });
        Promise.all(writes).then(function () {
          setBusy(false); setNotice(t("saved"));
          if (scope.load) scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function reseedDraft() {
        if (typeof scope.load === "function") {
          var p = scope.load();
          if (p && typeof p.then === "function") {
            p.then(function () {
              var fresh = scope.getSnapshot();
              if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
            }).catch(function () {});
            return;
          }
        }
        setTimeout(function () {
          var fresh = scope.getSnapshot();
          if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
        }, 120);
      }

      function onReset() {
        setBusy(true); setNotice(null); setError(null);
        Promise.all(FIELDS.map(function (f) { return scope.unset(f.key); })).then(function () {
          setBusy(false); setNotice(t("saved"));
          reseedDraft();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      var renderField = function (f) {
        var overridden = f.key in user;
        if (f.type === "checkbox") {
          return h("label", { key: f.key, className: "__tv_field" },
            h("span", { className: "__tv_row" },
              h("input", { className: "__tv_check", type: "checkbox", checked: Boolean(fieldDraft(f)), onChange: function (e) { setField(f, e.target.checked); } }),
              h("span", { className: "__tv_label" }, labelOf(f)),
              overridden ? h("span", { className: "__tv_override" }, t("overridden")) : null
            ),
            f.key in ZH_HINTS ? h("span", { className: "__tv_hint" }, t(ZH_HINTS[f.key])) : null
          );
        }
        return h("label", { key: f.key, className: "__tv_field" },
          h("span", { className: "__tv_label" },
            labelOf(f),
            overridden ? h("span", { className: "__tv_override" }, t("overridden")) : null
          ),
          h("input", {
            className: "__tv_input",
            type: f.type === "password" ? "password" : f.type === "number" ? "number" : "text",
            value: fieldDraft(f),
            placeholder: f.type === "password" ? (overridden ? "••••••••" : t("apiKeyHint")) : (f.placeholder || ""),
            onChange: function (e) { setField(f, e.target.value); }
          }),
          f.key in ZH_HINTS ? h("span", { className: "__tv_hint" }, t(ZH_HINTS[f.key])) : null
        );
      };
      // 基础字段（URL/模型/密钥）常显；其余归入默认折叠的"高级设置"。
      var primaryKeys = ["baseURL", "model", "apiKey"];
      var primary = FIELDS.filter(function (f) { return primaryKeys.indexOf(f.key) >= 0; });
      var advanced = FIELDS.filter(function (f) { return primaryKeys.indexOf(f.key) < 0; });

      return h("div", { className: "__tv_root" },
        h("p", { className: "__tv_hint", style: { margin: "0 0 4px" } }, t("intro")),
        primary.map(renderField),
        advanced.length ? h("details", { className: "__tv_advanced" },
          h("summary", { className: "__tv_advancedSummary" },
            h("span", null, t("advanced")),
            h("span", { className: "__tv_advancedArrow" }, "\u25b8")
          ),
          advanced.map(renderField)
        ) : null,
        h("div", { className: "__tv_actions" },
          h("button", { type: "button", className: "__tv_btn __tv_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__tv_btn", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__tv_status" }, notice) : null,
          busy ? h("span", { className: "__tv_status" }, t("saving")) : null,
          error ? h("span", { className: "__tv_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i += 1) {
        var f = FIELDS[i];
        out[f.key] = f.type === "csv" ? draftToCsv(value[f.key]) : f.type === "checkbox" ? Boolean(value[f.key]) : String(value[f.key] ?? "");
      }
      return out;
    }
    function draftToCsv(arr) {
      return Array.isArray(arr) ? arr.join(", ") : String(arr ?? "");
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-tool-vision: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: "tool-vision" });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "tool-vision",
          order: 25,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(VisionSection, Object.assign({}, props, { scope: scope }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

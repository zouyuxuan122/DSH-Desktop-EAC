/**
 * dsh-soul-md — browser half.
 *
 * A "人设卡" section inside the Web UI settings page: edits the `soul-md`
 * settings namespace (soul.md path, fallback text, order, watch) through the
 * settings scope transport. Changes hot-apply via the host settings provider.
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-soul-md",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS = ".__sm_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__sm_field{display:flex;flex-direction:column;gap:4px}" +
      ".__sm_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__sm_override{font-size:10px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__sm_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__sm_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__sm_textarea{min-height:80px;resize:vertical}" +
      ".__sm_row{display:flex;align-items:center;gap:8px}" +
      ".__sm_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__sm_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__sm_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__sm_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__sm_btn:disabled{opacity:.5;cursor:default}" +
      ".__sm_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__sm_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__sm_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__sm_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}";
    var tagId = "dsh-soul-md/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-soul-md";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "soulMd";
    var inject = ["slots", "locale", "settingsScope"];
    var zh = {
      nav: "人设卡",
      intro: "soul.md 风格人设卡：把一份 Markdown 人设文件渲染为系统提示词段落（soul:persona），文件变更热重载。修改配置后即时生效。",
      fallbackHint: "文件缺失/不可读时使用的文本；留空则不注册段落。",
      orderHint: "段落顺序；0 渲染在部署 persona 之后。",
      completeHint: "把渲染结果作为完整系统提示词（高级）。",
      watchHint: "监听文件变更自动重载。",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 soul-md 命名空间？）",
      overridden: "已覆盖",
      loading: "加载中…"
    };
    var en = {
      nav: "Persona Card",
      intro: "soul.md-style persona card: renders a Markdown file as the soul:persona system-prompt section, hot-reloaded on change. Edits apply immediately.",
      fallbackHint: "Text used when the file is missing/unreadable; empty means no section.",
      orderHint: "Prompt section order; 0 renders after the deployment persona slot.",
      completeHint: "Treat the rendered card as the complete system prompt (advanced).",
      watchHint: "Hot-reload the section on file change.",
      save: "Save",
      reset: "Reset",
      saved: "Saved",
      saving: "Saving…",
      error: "Save failed",
      unavailable: "Settings namespace unavailable (soul-md namespace not registered server-side?)",
      overridden: "overridden",
      loading: "Loading…"
    };

    var FIELDS = [
      { key: "path", label: "soul.md 路径（绝对，或相对 dsh home）", type: "text" },
      { key: "fallback", label: "缺失时回退文本", type: "textarea" },
      { key: "order", label: "段落顺序", type: "number" },
      { key: "complete", label: "作为完整系统提示词", type: "checkbox" },
      { key: "watch", label: "文件变更热重载", type: "checkbox" },
      { key: "debounceMs", label: "重载防抖（毫秒）", type: "number" }
    ];
    var HINTS = { fallback: "fallbackHint", order: "orderHint", complete: "completeHint", watch: "watchHint" };

    function SoulSection(props) {
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [draft, setDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);

      react.useEffect(function () {
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
        if (ready) setDraft(Object.assign({}, valueToDraft(snapshot.value)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__sm_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__sm_status" }, t("loading"));

      var value = snapshot.value;
      var user = snapshot.user || {};

      function fieldDraft(f) {
        if (f.type === "checkbox") return draft[f.key] !== void 0 ? draft[f.key] : Boolean(value[f.key]);
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[f.key] ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) { var next = Object.assign({}, prev); next[f.key] = v; return next; });
        setNotice(null);
        setError(null);
      }

      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        Promise.all(FIELDS.map(function (f) {
          var d = fieldDraft(f);
          if (f.type === "checkbox") {
            if (Boolean(d) === Boolean(value[f.key])) return Promise.resolve();
            return Boolean(d) ? scope.set(f.key, true) : scope.unset(f.key);
          }
          if (String(d) === String(value[f.key] ?? "")) return Promise.resolve();
          return String(d).trim() === "" ? scope.unset(f.key) : scope.set(f.key, f.type === "number" ? Number(d) : d);
        })).then(function () {
          setBusy(false); setNotice(t("saved"));
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function reseedDraft() {
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

      return h("div", { className: "__sm_root" },
        h("p", { className: "__sm_hint", style: { margin: "0 0 4px" } }, t("intro")),
        FIELDS.map(function (f) {
          var overridden = f.key in user;
          if (f.type === "checkbox") {
            return h("label", { key: f.key, className: "__sm_field" },
              h("span", { className: "__sm_row" },
                h("input", { className: "__sm_check", type: "checkbox", checked: Boolean(fieldDraft(f)), onChange: function (e) { setField(f, e.target.checked); } }),
                h("span", { className: "__sm_label" }, f.label),
                overridden ? h("span", { className: "__sm_override" }, t("overridden")) : null
              ),
              f.key in HINTS ? h("span", { className: "__sm_hint" }, t(HINTS[f.key])) : null
            );
          }
          return h("label", { key: f.key, className: "__sm_field" },
            h("span", { className: "__sm_label" },
              f.label,
              overridden ? h("span", { className: "__sm_override" }, t("overridden")) : null
            ),
            f.type === "textarea"
              ? h("textarea", { className: "__sm_input __sm_textarea", value: fieldDraft(f), onChange: function (e) { setField(f, e.target.value); } })
              : h("input", { className: "__sm_input", type: f.type === "number" ? "number" : "text", value: fieldDraft(f), onChange: function (e) { setField(f, e.target.value); } }),
            f.key in HINTS ? h("span", { className: "__sm_hint" }, t(HINTS[f.key])) : null
          );
        }),
        h("div", { className: "__sm_actions" },
          h("button", { type: "button", className: "__sm_btn __sm_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__sm_btn", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__sm_status" }, notice) : null,
          busy ? h("span", { className: "__sm_status" }, t("saving")) : null,
          error ? h("span", { className: "__sm_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i += 1) {
        var f = FIELDS[i];
        out[f.key] = f.type === "checkbox" ? Boolean(value[f.key]) : String(value[f.key] ?? "");
      }
      return out;
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-soul-md: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: "soul-md" });
      // 原生"人设卡"（仅路径/顺序/热重载等底层参数）与 easy-setup 官方"人设卡"（预设+卡片库+编辑）重复 → 写死关闭这张。
      if (false) {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "soul-md",
            order: 24,
            label: function () { return t("nav"); },
            locale: NS
          }, function (props) {
            return h(SoulSection, Object.assign({}, props, { scope: scope }));
          });
        });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

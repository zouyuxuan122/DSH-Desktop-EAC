/**
 * computer-user — Web settings card (client half).
 *
 * Registers a 「电脑操作 / Computer Use」 section in the DSH Web settings page,
 * restyled to the settings-panel design language (the same vocabulary the
 * General-section rows and the models page use: 720px section, bordered 12px
 * card groups, capsule buttons h36 r18, 32px inputs, custom-chevron selects,
 * details disclosure with rotating marker). Business logic is unchanged.
 *
 *   - Top (visible the moment the card opens): mode dropdown (禁用/只读/手动批准/自动).
 *   - Advanced (wrapped in a <details> so it is collapsed by default):
 *     screenshot_dir, default_scale, typing_interval_ms, scroll_units, debug.
 *
 * Hand-written ModuleLoader bundle — no build step (same shape as picturereader).
 * scope.load() usage is guarded (`typeof scope.load === "function"`) so the
 * card runs on DSH hosts without a scope load surface (EAC desktop shells) as
 * well as those that have one.
 */
window.__ModuleLoader__.load({
  id: "computer-user",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (settings-panel design language; own prefix) ──────────────────
    // Token vocabulary mirrored from dsh-client-ui-settings-models / ui-theme:
    // bordered rowCards (r12, pad 14/16), capsule buttons (h36 r18), inputs
    // h32 r8 on bg-layer-1, disclosure markers as rotating chevrons.
    var CSS =
      ".__cu_section{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}" +
      ".__cu_intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}" +
      ".__cu_card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}" +
      ".__cu_cardTitle{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}" +
      ".__cu_subHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__cu_field{display:flex;flex-direction:column;gap:6px}" +
      ".__cu_label{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}" +
      ".__cu_hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__cu_input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}" +
      ".__cu_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}" +
      ".__cu_input::placeholder{color:var(--dsw-alias-label-dimmed)}" +
      "select.__cu_input{width:auto;min-width:240px;max-width:100%;cursor:pointer;appearance:none;padding-right:32px;background-image:url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 12 12%27 fill=%27none%27%3E%3Cpath d=%27M3 4.5L6 7.5L9 4.5%27 stroke=%27%2381858C%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E');background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px}" +
      ".__cu_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__cu_actions{display:flex;align-items:center;gap:8px;margin-top:4px}" +
      ".__cu_btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:18px;font:inherit;font-size:14px;line-height:22px;cursor:pointer}" +
      ".__cu_btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}" +
      ".__cu_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}" +
      ".__cu_btnSecondary{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}" +
      ".__cu_btnSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".__cu_btn:disabled{opacity:.4;cursor:default}" +
      ".__cu_btn:focus-visible,.__cu_input:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}" +
      ".__cu_status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__cu_saved{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}" +
      ".__cu_error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}" +
      ".__cu_advanced{border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px;display:flex;flex-direction:column;gap:12px}" +
      ".__cu_advancedSummary{display:flex;align-items:center;gap:6px;width:fit-content;padding:2px 4px;margin-left:-4px;border-radius:6px;cursor:pointer;list-style:none;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}" +
      ".__cu_advancedSummary::-webkit-details-marker{display:none}" +
      ".__cu_advancedSummary::before{content:'';width:5px;height:5px;border-right:1.5px solid currentcolor;border-bottom:1.5px solid currentcolor;transform:rotate(-45deg) translate(-1px,-1px);transition:transform 120ms ease}" +
      "details.__cu_advanced[open] > .__cu_advancedSummary::before{transform:rotate(45deg) translate(-1px,-1px)}" +
      ".__cu_advancedSummary:hover{color:var(--dsw-alias-label-primary)}" +
      ".__cu_advancedBody{display:flex;flex-direction:column;gap:12px;padding-top:12px}" +
      ".__cu_unavailable{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}";
    var tagId = "computer-user/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "computer-user";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    var NS = "computer-user";
    var inject = ["slots", "locale", "settingsScope"];

    var MODE_OPTS = [
      { value: "disabled", labelKey: "modeDisabled" },
      { value: "readonly", labelKey: "modeReadonly" },
      { value: "manual", labelKey: "modeManual" },
      { value: "auto", labelKey: "modeAuto" },
    ];

    var zh = {
      nav: "电脑操作",
      intro: "computer-user：让 DSH 读屏幕并操作鼠标键盘（Codex computer-use 风格）。选择运行模式后，截图结果配合 picturereader 的 image_scan/image_ocr 使用。",
      mode: "运行模式",
      modeDisabled: "禁用",
      modeReadonly: "只读",
      modeManual: "手动批准",
      modeAuto: "自动",
      modeHint: "禁用=全部拒绝 | 只读=仅截图/读光标/等待 | 手动批准=需 /computer 命令批准后可用 | 自动=LLM自由调用所有工具",
      aiCanChangeMode: "AI 可自行修改运行模式",
      aiCanChangeModeHint: "开启后 AI 可通过 computer_set_mode 工具自行切换模式（默认关闭）。AI 修改会同步更新本下拉框。",
      advanced: "高级设置",
      screenshotDir: "截图输出目录（空 = 系统临时目录）",
      defaultScale: "截图默认缩放 0.1..1",
      typingIntervalMs: "逐字输入间隔（毫秒）",
      scrollUnits: "滚动刻度（每格 120）",
      outputGuard: "代码输出打回",
      outputGuardHint: "把工具调用/伪 XML 写成对话文本时打回并提示；同内容第二次放行。关闭则不拦截。",
      debug: "调试日志",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 computer-user 命名空间？）",
      loading: "加载中…",
    };
    var en = {
      nav: "Computer Use",
      intro: "computer-user: let DSH read the screen and drive mouse & keyboard (Codex computer-use style). Pick a mode; screenshots pair with picturereader's image_scan/image_ocr.",
      mode: "Mode",
      modeDisabled: "Disabled",
      modeReadonly: "Read-only",
      modeManual: "Manual approval",
      modeAuto: "Automatic",
      modeHint: "Disabled=refuse all | Read-only=screenshot/cursor/wait only | Manual approval=need /computer command to unlock | Automatic=LLM freely calls all tools",
      aiCanChangeMode: "AI may change mode itself",
      aiCanChangeModeHint: "When on, the AI can switch modes via the computer_set_mode tool (default off). AI changes are reflected in this dropdown.",
      advanced: "Advanced",
      screenshotDir: "Screenshot output dir (empty = OS temp)",
      defaultScale: "Screenshot default scale 0.1..1",
      typingIntervalMs: "Typing interval (ms)",
      scrollUnits: "Scroll units (120 per tick)",
      outputGuard: "Reject code-as-text output",
      outputGuardHint: "Rejects tool-call/XML written as conversation text; the same text passes on second output. Off disables.",
      debug: "Debug logging",
      save: "Save",
      reset: "Reset",
      saved: "Saved",
      saving: "Saving…",
      error: "Save failed",
      unavailable: "Settings namespace unavailable (computer-user not registered server-side?)",
      loading: "Loading…",
    };

    // Top (always visible) vs advanced (collapsed by default).
    var FIELDS = [
      { key: "mode", type: "mode", labelKey: "mode", hintKey: "modeHint" },
      { key: "ai_can_change_mode", type: "checkbox", labelKey: "aiCanChangeMode", hintKey: "aiCanChangeModeHint" },
      { key: "screenshot_dir", type: "text", labelKey: "screenshotDir", advanced: true },
      { key: "default_scale", type: "number", labelKey: "defaultScale", advanced: true },
      { key: "typing_interval_ms", type: "number", labelKey: "typingIntervalMs", advanced: true },
      { key: "scroll_units", type: "number", labelKey: "scrollUnits", advanced: true },
      { key: "output_guard", type: "checkbox", labelKey: "outputGuard", hintKey: "outputGuardHint", advanced: true },
      { key: "debug", type: "checkbox", labelKey: "debug", advanced: true },
    ];
    var CFG_KEYS = {
      mode: "mode", ai_can_change_mode: "ai_can_change_mode",
      screenshot_dir: "screenshot_dir", default_scale: "default_scale",
      typing_interval_ms: "typing_interval_ms", scroll_units: "scroll_units",
      output_guard: "output_guard", debug: "debug",
    };

    function Section(props) {
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [draft, setDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);

      react.useEffect(function () {
        // 有 load 的宿主先拉一次；无 load 的 EAC 宿主直接走 getSnapshot。
        if (typeof scope.load === "function") scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); if (scope.dispose) scope.dispose(); };
      }, [scope]);
      react.useEffect(function () {
        if (ready) setDraft(function (prev) {
          var merged = Object.assign({}, valueToDraft(snapshot.value));
          for (var k in prev) merged[k] = prev[k];
          return merged;
        });
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__cu_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__cu_status" }, t("loading"));

      var value = snapshot.value;

      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        var ops = [];
        FIELDS.forEach(function (f) {
          if (f.type === "checkbox") {
            ops.push({ op: "set", key: CFG_KEYS[f.key], value: draft[f.key] !== void 0 ? !!draft[f.key] : Boolean(value[CFG_KEYS[f.key]]) });
            return;
          }
          if (f.type === "mode") {
            ops.push({ op: "set", key: CFG_KEYS[f.key], value: draft[f.key] || value[CFG_KEYS[f.key]] || "manual" });
            return;
          }
          var dv = draft[f.key] !== void 0 ? String(draft[f.key]) : String(value[CFG_KEYS[f.key]] ?? "");
          if (f.type === "number") {
            var num = Number(dv);
            if (Number.isFinite(num)) { ops.push({ op: "set", key: CFG_KEYS[f.key], value: num }); }
            return;
          }
          if (String(dv).trim() === "") { ops.push({ op: "unset", key: CFG_KEYS[f.key] }); return; }
          ops.push({ op: "set", key: CFG_KEYS[f.key], value: String(dv).trim() });
        });
        Promise.all(ops.map(function (o) {
          return o.op === "set" ? scope.set(o.key, o.value) : scope.unset(o.key);
        })).then(function () {
          setBusy(false); setNotice(t("saved"));
          // 保存后刷新本机 snapshot：优先走宿主 load（若提供），否则直接读。
          if (typeof scope.load === "function") {
            scope.load();
          } else {
            try { setSnapshot(scope.getSnapshot()); } catch (_e) {}
          }
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }
      function onReset() {
        setBusy(true);
        Promise.all(FIELDS.map(function (f) { return scope.unset(CFG_KEYS[f.key]); })).then(function () {
          setBusy(false); setNotice(t("saved"));
          setTimeout(function () {
            if (typeof scope.load === "function") {
              scope.load().then(function () {
                var fresh = scope.getSnapshot();
                if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
              }).catch(function () {});
            } else {
              var fresh = scope.getSnapshot();
              if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
            }
          }, 120);
        }).catch(function (e) { setBusy(false); setError(t("error") + ": " + String(e && e.message || e)); });
      }

      function fieldDraft(f) {
        if (f.type === "checkbox") return draft[f.key] !== void 0 ? !!draft[f.key] : Boolean(value[CFG_KEYS[f.key]]);
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[CFG_KEYS[f.key]] ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) { var n = Object.assign({}, prev); n[f.key] = v; return n; });
        setNotice(null); setError(null);
      }
      function renderField(f) {
        if (f.type === "mode") {
          return h("label", { key: f.key, className: "__cu_field" },
            h("span", { className: "__cu_label" }, t("mode")),
            h("select", {
              className: "__cu_input",
              value: fieldDraft(f) || "manual",
              onChange: function (e) { setField(f, e.target.value); },
            }, MODE_OPTS.map(function (o) {
              return h("option", { key: o.value, value: o.value }, t(o.labelKey));
            })),
            h("p", { className: "__cu_hint" }, t("modeHint"))
          );
        }
        if (f.type === "checkbox") {
          var checked = draft[f.key] !== void 0 ? !!draft[f.key] : Boolean(value[CFG_KEYS[f.key]]);
          return h("label", { key: f.key, className: "__cu_field" },
            h("span", { className: "__cu_label" },
              h("input", { className: "__cu_check", type: "checkbox", checked: checked, onChange: function (e) { setField(f, e.target.checked); } }),
              h("span", null, t(f.labelKey))
            ),
            f.hintKey ? h("p", { className: "__cu_hint" }, t(f.hintKey)) : null
          );
        }
        return h("label", { key: f.key, className: "__cu_field" },
          h("span", { className: "__cu_label" }, t(f.labelKey)),
          h("input", {
            className: "__cu_input",
            type: f.type === "number" ? "number" : "text",
            value: fieldDraft(f),
            onChange: function (e) { setField(f, e.target.value); },
          })
        );
      }

      // Top fields are always rendered first, then the collapsed Advanced <details>.
      var top = FIELDS.filter(function (f) { return !f.advanced; });
      var advanced = FIELDS.filter(function (f) { return f.advanced; });
      return h("div", { className: "__cu_section" },
        h("p", { className: "__cu_intro" }, t("intro")),
        // 运行模式（自带 label 的 select）
        h("div", { className: "__cu_card" }, renderField(top[0])),
        // AI 可自行修改运行模式
        h("div", { className: "__cu_card" }, renderField(top[1])),
        advanced.length ? h("details", { className: "__cu_advanced" },
          h("summary", { className: "__cu_advancedSummary" }, t("advanced")),
          h("div", { className: "__cu_advancedBody" },
            advanced.map(renderField)
          )
        ) : null,
        h("div", { className: "__cu_actions" },
          h("button", { type: "button", className: "__cu_btn __cu_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__cu_btn __cu_btnSecondary", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__cu_saved" }, notice) : null,
          busy ? h("span", { className: "__cu_status" }, t("saving")) : null,
          error ? h("span", { className: "__cu_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      FIELDS.forEach(function (f) {
        if (f.type === "checkbox") {
          out[f.key] = Boolean(value[CFG_KEYS[f.key]]);
        } else if (f.type === "mode") {
          out[f.key] = value[CFG_KEYS[f.key]] || "manual";
        } else {
          out[f.key] = String(value[CFG_KEYS[f.key]] ?? "");
        }
      });
      return out;
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "computer-user: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: NS });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "computer-user",
          order: 50,
          label: function () { return t("nav"); },
          locale: NS,
        }, function (props) {
          return h(Section, Object.assign({}, props, { scope: scope }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
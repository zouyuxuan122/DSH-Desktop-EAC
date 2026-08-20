/**
 * dsh-tdai-memory — browser half.
 *
 * A "记忆" section inside the Web UI settings page: edits the `tdai-memory`
 * settings namespace (data dir, extraction LLM, embeddings, capture/extract/
 * recall switches, tools) through the settings scope transport plus nested
 * `settings.mutate` ops. TdaiCore is built at startup, so changes apply
 * after a restart (noted in the UI).
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-tdai-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS = ".__tm_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__tm_group{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:4px;margin:6px 0 2px}" +
      ".__tm_field{display:flex;flex-direction:column;gap:4px}" +
      ".__tm_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__tm_override{font-size:10px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__tm_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tm_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__tm_row{display:flex;align-items:center;gap:8px}" +
      ".__tm_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__tm_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__tm_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__tm_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__tm_btn:disabled{opacity:.5;cursor:default}" +
      ".__tm_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__tm_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tm_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__tm_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}";
    var tagId = "dsh-tdai-memory/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-tdai-memory";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "tdaiMemory";
    var inject = ["slots", "locale", "settingsScope", "connection"];
    var zh = {
      nav: "记忆",
      intro: "TDAI 记忆配置：L0 捕获 → L1 结构化提取 → 召回注入。密钥只写不读。TdaiCore 在启动时构建，修改后需重启生效。",
      groupData: "数据",
      groupLlm: "提取 LLM（L1/L2/L3）",
      groupEmbedding: "向量 Embedding",
      groupCapture: "捕获",
      groupExtraction: "提取",
      groupRecall: "召回",
      groupTools: "工具",
      secretHint: "留空保持当前密钥。",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存（重启后生效）",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 tdai-memory 命名空间？）",
      overridden: "已覆盖",
      loading: "加载中…"
    };
    var en = {
      nav: "Memory",
      intro: "TDAI memory config: L0 capture → L1 extraction → recall injection. Keys are write-only. TdaiCore is built at startup; changes apply after a restart.",
      groupData: "Data",
      groupLlm: "Extraction LLM (L1/L2/L3)",
      groupEmbedding: "Embeddings",
      groupCapture: "Capture",
      groupExtraction: "Extraction",
      groupRecall: "Recall",
      groupTools: "Tools",
      secretHint: "Leave blank to keep the current key.",
      save: "Save",
      reset: "Reset",
      saved: "Saved (applies after restart)",
      saving: "Saving…",
      error: "Save failed",
      unavailable: "Settings namespace unavailable (tdai-memory namespace not registered server-side?)",
      overridden: "overridden",
      loading: "Loading…"
    };

    // ── field spec: dotted path + type + group ─────────────────────────────
    var FIELDS = [
      { path: ["dataDir"], label: "数据目录（空 = ~/.memory-tencentdb/memory-tdai）", type: "text", group: "groupData" },
      { path: ["llm", "baseUrl"], label: "Base URL", type: "text", group: "groupLlm" },
      { path: ["llm", "apiKey"], label: "API Key", type: "password", secret: true, group: "groupLlm" },
      { path: ["llm", "model"], label: "模型", type: "text", group: "groupLlm" },
      { path: ["llm", "maxTokens"], label: "最大输出 Tokens", type: "number", group: "groupLlm" },
      { path: ["llm", "timeoutMs"], label: "超时（毫秒）", type: "number", group: "groupLlm" },
      { path: ["embedding", "baseUrl"], label: "Base URL", type: "text", group: "groupEmbedding" },
      { path: ["embedding", "apiKey"], label: "API Key", type: "password", secret: true, group: "groupEmbedding" },
      { path: ["embedding", "model"], label: "模型", type: "text", group: "groupEmbedding" },
      { path: ["embedding", "dimensions"], label: "向量维度", type: "number", group: "groupEmbedding" },
      { path: ["embedding", "sendDimensions"], label: "请求带 dimensions 参数", type: "checkbox", group: "groupEmbedding" },
      { path: ["captureEnabled"], label: "捕获对话（L0）", type: "checkbox", group: "groupCapture" },
      { path: ["extraction", "enabled"], label: "结构化提取（L1）", type: "checkbox", group: "groupExtraction" },
      { path: ["extraction", "enableDedup"], label: "冲突检测（额外 LLM 调用）", type: "checkbox", group: "groupExtraction" },
      { path: ["recall", "enabled"], label: "召回注入", type: "checkbox", group: "groupRecall" },
      { path: ["recall", "maxResults"], label: "最大召回条数", type: "number", group: "groupRecall" },
      { path: ["recall", "scoreThreshold"], label: "相似度阈值", type: "number", group: "groupRecall" },
      { path: ["recall", "timeoutMs"], label: "召回超时（毫秒）", type: "number", group: "groupRecall" },
      { path: ["toolsEnabled"], label: "注册搜索工具（tdai_memory_search / tdai_conversation_search）", type: "checkbox", group: "groupTools" }
    ];
    FIELDS.forEach(function (f) { f.key = f.path.join("."); });

    function getPath(obj, path) {
      var cur = obj;
      for (var i = 0; i < path.length; i += 1) {
        if (cur === null || cur === void 0 || typeof cur !== "object") return void 0;
        cur = cur[path[i]];
      }
      return cur;
    }

    function MemorySection(props) {
      var t = props.t;
      var scope = props.scope;
      var api = props.api;
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
      // Initialize the draft ONLY when the snapshot becomes ready — never on
      // value churn. settingsScope.getSnapshot() returns a fresh object per
      // call, so depending on snapshot.value would reset user input on every
      // render (typing appears dead).
      react.useEffect(function () {
        if (ready) setDraft(Object.assign({}, valueToDraft(snapshot.value)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__tm_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__tm_status" }, t("loading"));

      var value = snapshot.value;
      var user = snapshot.user || {};

      function fieldDraft(f) {
        if (f.type === "checkbox") return draft[f.key] !== void 0 ? draft[f.key] : Boolean(getPath(value, f.path));
        return draft[f.key] !== void 0 ? draft[f.key] : String(getPath(value, f.path) ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) { var next = Object.assign({}, prev); next[f.key] = v; return next; });
        setNotice(null);
        setError(null);
      }

      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        var ops = [];
        for (var i = 0; i < FIELDS.length; i += 1) {
          var f = FIELDS[i];
          var d = fieldDraft(f);
          var current = getPath(value, f.path);
          if (f.type === "password") {
            if (!d) continue; // blank keeps the current key
            if (d === String(current ?? "")) continue;
            ops.push({ op: "set", path: f.path, value: d });
            continue;
          }
          if (f.type === "checkbox") {
            if (Boolean(d) === Boolean(current)) continue;
            ops.push(Boolean(d) ? { op: "set", path: f.path, value: true } : { op: "unset", path: f.path });
            continue;
          }
          if (String(d) === String(current ?? "")) continue;
          if (String(d).trim() === "" && getPath(user, f.path) === void 0) continue;
          ops.push(String(d).trim() === "" ? { op: "unset", path: f.path } : { op: "set", path: f.path, value: f.type === "number" ? Number(d) : d });
        }
        if (ops.length === 0) { setBusy(false); setNotice(t("saved")); return; }
        api.settings.mutate({
          ns: "tdai-memory",
          ops: ops,
          ...snapshot.revision === void 0 ? {} : { expectedRevision: snapshot.revision }
        }).then(function (response) {
          setBusy(false);
          if (!response.result.ok) {
            var detail = response.result.error || {};
            setError(t("error") + ": " + String(detail.message || detail.code || "unknown"));
            return;
          }
          setNotice(t("saved"));
          if (response.result.value) setDraft(Object.assign({}, valueToDraft(response.result.value)));
          scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function onReset() {
        setBusy(true); setNotice(null); setError(null);
        api.settings.mutate({
          ns: "tdai-memory",
          ops: FIELDS.map(function (f) { return { op: "unset", path: f.path }; }),
          ...snapshot.revision === void 0 ? {} : { expectedRevision: snapshot.revision }
        }).then(function (response) {
          setBusy(false);
          if (!response.result.ok) { setError(t("error")); return; }
          setNotice(t("saved"));
          if (response.result.value) setDraft(Object.assign({}, valueToDraft(response.result.value)));
          scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      var nodes = [];
      var lastGroup = null;
      // forEach callback gives each handler its own `f` — a `for (var i)`
      // loop would share one `f` across every onChange closure, so typing
      // updated the LAST field's draft and the input appeared dead.
      FIELDS.forEach(function (f) {
        if (f.group !== lastGroup) {
          lastGroup = f.group;
          nodes.push(h("div", { key: "g" + f.group, className: "__tm_group" }, t(f.group)));
        }
        var overridden = getPath(user, f.path) !== void 0;
        if (f.type === "checkbox") {
          nodes.push(h("label", { key: f.path.join("."), className: "__tm_field" },
            h("span", { className: "__tm_row" },
              h("input", { className: "__tm_check", type: "checkbox", checked: Boolean(fieldDraft(f)), onChange: function (e) { setField(f, e.target.checked); } }),
              h("span", { className: "__tm_label" }, f.label),
              overridden ? h("span", { className: "__tm_override" }, t("overridden")) : null
            )
          ));
          return;
        }
        nodes.push(h("label", { key: f.path.join("."), className: "__tm_field" },
          h("span", { className: "__tm_label" },
            f.label,
            overridden ? h("span", { className: "__tm_override" }, t("overridden")) : null
          ),
          h("input", {
            className: "__tm_input",
            type: f.type === "password" ? "password" : f.type === "number" ? "number" : "text",
            value: fieldDraft(f),
            placeholder: f.type === "password" ? (overridden ? "••••••••" : t("secretHint")) : "",
            onChange: function (e) { setField(f, e.target.value); }
          }),
          f.type === "password" ? h("span", { className: "__tm_hint" }, t("secretHint")) : null
        ));
      });

      return h("div", { className: "__tm_root" },
        h("p", { className: "__tm_hint", style: { margin: "0 0 4px" } }, t("intro")),
        nodes,
        h("div", { className: "__tm_actions" },
          h("button", { type: "button", className: "__tm_btn __tm_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__tm_btn", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__tm_status" }, notice) : null,
          busy ? h("span", { className: "__tm_status" }, t("saving")) : null,
          error ? h("span", { className: "__tm_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i += 1) {
        var f = FIELDS[i];
        out[f.key] = f.type === "checkbox" ? Boolean(getPath(value, f.path)) : String(getPath(value, f.path) ?? "");
      }
      return out;
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-tdai-memory: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: "tdai-memory" });
      var api = ctx.connection.api;
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "tdai-memory",
          order: 26,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(MemorySection, Object.assign({}, props, { scope: scope, api: api }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

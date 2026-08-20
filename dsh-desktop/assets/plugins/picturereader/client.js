/**
 * picturereader — Web settings card (client half).
 *
 * registers a "图片阅读" section inside the DSH Web settings page:
 *   - Top: usage mode dropdown (privacy / smart / strict)
 *   - Vision bridge model picker (checkbox list of all text-only models,
 *     each with an optional note field; checked models get a "(视觉)" variant)
 *   - External vision API fields (base URL / model / key) — gated by "启用外部视觉 API" checkbox
 *   - OCR engine selector
 *   - Advanced settings (timeout / max tokens / export dir / debug)
 *
 * Hand-written ModuleLoader bundle — no build step.
 */
window.__ModuleLoader__.load({
  id: "picturereader",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS =
      ".__pr_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__pr_field{display:flex;flex-direction:column;gap:4px}" +
      ".__pr_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__pr_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__pr_row{display:flex;align-items:center;gap:8px}" +
      ".__pr_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__pr_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__pr_inputSmall{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 6px;font-size:11px;width:100px;box-sizing:border-box}" +
      ".__pr_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 8px;font-size:13px}" +
      ".__pr_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__pr_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__pr_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__pr_btn:disabled{opacity:.5;cursor:default}" +
      ".__pr_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__pr_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__pr_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__pr_advanced{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}" +
      ".__pr_advancedSummary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);user-select:none;display:flex;align-items:center;gap:5px}" +
      ".__pr_advancedArrow{display:inline-block;transition:transform .18s ease;font-size:13px;line-height:1;color:var(--dsw-alias-label-secondary);transform:rotate(0)}" +
      ".__pr_advanced[open] .__pr_advancedArrow{transform:rotate(90deg)}" +
      ".__pr_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}" +
      ".__pr_modelList{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__pr_modelRow{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px}" +
      ".__pr_modelName{flex:1;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".__pr_modelProvider{font-size:10px;color:var(--dsw-alias-label-tertiary);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".__pr_empty{font-size:12px;color:var(--dsw-alias-label-tertiary);font-style:italic;padding:8px 0}";
    var tagId = "picturereader/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "picturereader";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "picturereader";
    var inject = ["slots", "locale", "settingsScope"];
    var zh = {
      nav: "图片阅读",
      intro: "picturereader：让纯文本模型用本地工具看懂图片。选择使用模式；在下方勾选需要视觉桥的模型；配置外部视觉端点（选配）。修改后即时生效（设置项），视觉桥需重启 DSH。",
      mode: "使用模式",
      modePrivacy: "隐私模式",
      modeSmart: "智能模式",
      modeStrict: "严谨模式",
      modeHint: "隐私=绝不调用外部 API，全走本地；智能=先简单看图再决定是否外呼（省轮数/时间）；严谨=自行选择+必要时交叉验证细节。",
      visionBridgeModels: "视觉桥：为以下模型注入视觉孪生",
      visionBridgeModelsHint: "勾选的文本模型会在模型选择器里多一个（视觉）变体，选它即可粘贴图片显示缩略图并自动分析。（需重启 DSH 生效）",
      visionBridgeNote: "备注",
      visionBridgeNotePH: "视觉（可改）",
      vlmEnabled: "启用外部视觉 API（选配）",
      vlmEnabledHint: "勾选后才配置并允许调用外部视觉端点；不勾选一律走本地工具，图片绝不外发。",
      vlmBase: "视觉 API Base URL",
      vlmBasePlaceholder: "https://api.openai.com/v1（留空=禁用外部 VLM）",
      vlmModel: "视觉模型",
      vlmKey: "视觉 API Key",
      vlmKeyHint: "密钥只写不读：留空保持当前值，填写并保存即覆盖，之后不再展示。",
      vlmKeyEnv: "Key 环境变量（apiKey 为空时读取）",
      ocr: "默认 OCR 引擎",
      ocrWindows: "windows（系统内置，无需安装）",
      ocrPaddle: "paddle（PaddleOCR，对发光/弯曲/游戏文字更好）",
      ocrRapid: "rapid（RapidOCR，轻量快速，选装）",
      advanced: "高级设置",
      vlmTimeoutMs: "视觉请求超时（毫秒）",
      vlmMaxTokens: "视觉最大输出 Tokens",
      bridgeExportDir: "图片桥导出目录（空 = 系统临时目录）",
      maxImageBytes: "单张图片大小上限（字节）",
      scanDefaultSize: "扫描默认格子大小（8..64）",
      scanPalette: "默认色板（auto/full/basic/gray）",
      scanMode: "默认扫描模式（auto/ascii/color）",
      ocrLanguage: "OCR 默认语言（BCP-47，如 zh-Hans / en-US）",
      multimodalModels: "多模态白名单（逗号分隔，这些模型直收图片不降级）",
      requestGuard: "请求保护（图片块降级兜底）",
      batchProbeFirst: "批量探测前几张（判断是否文字密集）",
      batchOcrLimitChars: "批量 OCR 截断字符数",
      docDpi: "文档转换 DPI（72..300）",
      docMaxPages: "文档转换最大页数（1..500）",
      debug: "调试日志（输出诊断信息）",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 picturereader 命名空间？）",
      loading: "加载中…",
      noModels: "暂无可用模型（重启 DSH 后自动扫描）",
    };
    var en = {
      nav: "Picture Reader",
      intro: "picturereader: local image understanding for text-only models. Pick a usage mode; check models to give them a vision variant; configure external vision endpoint (optional). Settings hot-apply, vision bridge requires DSH restart.",
      mode: "Usage Mode",
      modePrivacy: "Privacy",
      modeSmart: "Smart",
      modeStrict: "Strict",
      modeHint: "Privacy = never call any external API, local-only; Smart = glance first then decide whether to call out (fewer rounds/faster); Strict = self-choice + cross-validate details when needed.",
      visionBridgeModels: "Vision bridge: inject vision twin for these models",
      visionBridgeModelsHint: "Checked text models get a (Vision) variant in the model selector. Pick it to paste images with native thumbnails and auto-analysis. (Requires DSH restart)",
      visionBridgeNote: "Note",
      visionBridgeNotePH: "Vision (editable)",
      vlmEnabled: "Enable external vision API (optional)",
      vlmEnabledHint: "Check to configure & allow external vision calls; unchecked stays fully local (images never leave).",
      vlmBase: "Vision API Base URL",
      vlmBasePlaceholder: "https://api.openai.com/v1 (empty = external VLM disabled)",
      vlmModel: "Vision Model",
      vlmKey: "Vision API Key",
      vlmKeyHint: "Write-only key: leave blank to keep current, fill & save to overwrite, never echoed again.",
      vlmKeyEnv: "Key env var (used when apiKey empty)",
      ocr: "Default OCR Engine",
      ocrWindows: "windows (built-in, no install)",
      ocrPaddle: "paddle (PaddleOCR, best for glowing/curved/game text)",
      ocrRapid: "rapid (RapidOCR, lightweight, optional)",
      advanced: "Advanced",
      vlmTimeoutMs: "Vision request timeout (ms)",
      vlmMaxTokens: "Vision max output tokens",
      bridgeExportDir: "Image bridge export dir (empty = system temp)",
      maxImageBytes: "Max image size (bytes)",
      scanDefaultSize: "Scan default grid size (8..64)",
      scanPalette: "Default palette (auto/full/basic/gray)",
      scanMode: "Default scan mode (auto/ascii/color)",
      ocrLanguage: "OCR default language (BCP-47, e.g. zh-Hans / en-US)",
      multimodalModels: "Multimodal whitelist (comma-separated, receive images directly)",
      requestGuard: "Request guard (image block downgrade fallback)",
      batchProbeFirst: "Batch probe first N images",
      batchOcrLimitChars: "Batch OCR truncation chars",
      docDpi: "Document conversion DPI (72..300)",
      docMaxPages: "Document conversion max pages (1..500)",
      debug: "Debug logging",
      save: "Save",
      reset: "Reset",
      saved: "Saved",
      saving: "Saving…",
      error: "Save failed",
      unavailable: "Settings namespace unavailable (picturereader not registered server-side?)",
      loading: "Loading…",
      noModels: "No models available yet (will appear after DSH restart / model scan)",
    };

    // ── field spec ────────────────────────────────────────────────────────
    var MODE_OPTS = [
      { value: "privacy", labelKey: "modePrivacy" },
      { value: "smart", labelKey: "modeSmart" },
      { value: "strict", labelKey: "modeStrict" },
    ];
    var OCR_OPTS = [
      { value: "windows", labelKey: "ocrWindows" },
      { value: "paddle", labelKey: "ocrPaddle" },
      { value: "rapid", labelKey: "ocrRapid" },
    ];
    // FIELDS: mode, vision_models (custom), vlm_enabled (checkbox), vlm_*, ocr_engine, advanced
    var FIELDS = [
      { key: "mode", type: "mode" },
      { key: "vision_models", type: "models" },
      { key: "vlm_enabled", type: "checkbox", labelKey: "vlmEnabled", hintKey: "vlmEnabledHint" },
      { key: "vlm_base", type: "text", labelKey: "vlmBase", placeholderKey: "vlmBasePlaceholder" },
      { key: "vlm_model", type: "text", labelKey: "vlmModel" },
      { key: "vlm_key", type: "password", secret: true, labelKey: "vlmKey", hintKey: "vlmKeyHint" },
      { key: "vlm_key_env", type: "text", labelKey: "vlmKeyEnv" },
      { key: "ocr_engine", type: "ocr" },
      { key: "vlm_timeout_ms", type: "number", advanced: true, labelKey: "vlmTimeoutMs" },
      { key: "vlm_max_tokens", type: "number", advanced: true, labelKey: "vlmMaxTokens" },
      { key: "bridge_export_dir", type: "text", advanced: true, labelKey: "bridgeExportDir" },
      { key: "max_image_bytes", type: "number", advanced: true, labelKey: "maxImageBytes" },
      { key: "scan_default_size", type: "number", advanced: true, labelKey: "scanDefaultSize" },
      { key: "scan_palette", type: "text", advanced: true, labelKey: "scanPalette" },
      { key: "scan_mode", type: "text", advanced: true, labelKey: "scanMode" },
      { key: "ocr_language", type: "text", advanced: true, labelKey: "ocrLanguage" },
      { key: "multimodal_models", type: "text", advanced: true, labelKey: "multimodalModels" },
      { key: "request_guard", type: "checkbox", advanced: true, labelKey: "requestGuard" },
      { key: "batch_probe_first", type: "number", advanced: true, labelKey: "batchProbeFirst" },
      { key: "batch_ocr_limit_chars", type: "number", advanced: true, labelKey: "batchOcrLimitChars" },
      { key: "doc_dpi", type: "number", advanced: true, labelKey: "docDpi" },
      { key: "doc_max_pages", type: "number", advanced: true, labelKey: "docMaxPages" },
      { key: "debug", type: "checkbox", advanced: true, labelKey: "debug" },
    ];
    var FIELD_LABELS = {
      mode: "mode", vlm_enabled: "vlmEnabled", vlm_base: "vlmBase", vlm_model: "vlmModel", vlm_key: "vlmKey",
      vlm_key_env: "vlmKeyEnv", ocr_engine: "ocr",
      vlm_timeout_ms: "vlmTimeoutMs", vlm_max_tokens: "vlmMaxTokens", bridge_export_dir: "bridgeExportDir",
      max_image_bytes: "maxImageBytes", scan_default_size: "scanDefaultSize", scan_palette: "scanPalette",
      scan_mode: "scanMode", ocr_language: "ocrLanguage", multimodal_models: "multimodalModels",
      request_guard: "requestGuard", batch_probe_first: "batchProbeFirst", batch_ocr_limit_chars: "batchOcrLimitChars",
      doc_dpi: "docDpi", doc_max_pages: "docMaxPages", debug: "debug",
    };

    // ── Vision Bridge Model Picker Component ──────────────────────────────
    function VisionBridgePicker(props) {
      var t = props.t;
      var scope = props.scope;
      // available_text_models (read-only, from host scan)
      var [available, setAvailable] = react.useState([]);
      // vision_models (user-selected, saved to settings)
      var [selected, setSelected] = react.useState([]);
      // Flag to prevent scope sync from overwriting local edits
      var editingRef = react.useRef(false);
      var editTimerRef = react.useRef(null);

      // Sync selected from scope: subscribe + load on mount
      react.useEffect(function () {
        var alive = true;
        var lastSavedRef = null; // Track last saved value to prevent overwrite
        function syncFromScope() {
          if (!alive) return;
          var snap = scope.getSnapshot();
          if (snap.status === "ready" && snap.value) {
            var sel = snap.value.vision_models;
            if (Array.isArray(sel)) {
              // If we just saved and the value matches what we saved, skip
              if (lastSavedRef && JSON.stringify(sel) === JSON.stringify(lastSavedRef)) {
                lastSavedRef = null;
                return;
              }
              setSelected(sel);
            }
          }
        }
        // Initial load from server (some DSH versions don't have load())
        if (typeof scope.load === "function") {
          scope.load().then(function () {
            if (alive) syncFromScope();
          }).catch(function () {});
        } else {
          syncFromScope();
        }
        // Subscribe to scope changes (triggers after save)
        var unsubscribe = typeof scope.subscribe === "function" ? scope.subscribe(function () {
          if (alive) syncFromScope();
        }) : null;
        // Expose lastSavedRef for saveSelection
        VisionBridgePicker._lastSavedRef = function(val) { lastSavedRef = val; };
        return function () {
          alive = false;
          if (unsubscribe) unsubscribe();
          VisionBridgePicker._lastSavedRef = null;
        };
      }, [scope]);

      // Load available models from host API
      react.useEffect(function () {
        var alive = true;
        function fetchModels() {
          fetch('/picturereader/models')
            .then(function (res) { return res.ok ? res.json() : []; })
            .then(function (data) {
              if (alive && Array.isArray(data)) setAvailable(data);
            })
            .catch(function () {});
        }
        fetchModels();
        // Poll every 5s for model list updates (host scans async)
        var timer = setInterval(function () { fetchModels(); }, 5000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      // Mark editing to prevent scope sync from overwriting
      function markEditing() {
        editingRef.current = true;
        if (editTimerRef.current) clearTimeout(editTimerRef.current);
        editTimerRef.current = setTimeout(function () { editingRef.current = false; }, 2000);
      }

      // Toggle a model on/off
      function toggleModel(model) {
        markEditing();
        var idx = selected.findIndex(function (m) { return m.id === model.id && m.provider === model.provider; });
        var next;
        if (idx >= 0) {
          next = selected.slice(0, idx).concat(selected.slice(idx + 1));
        } else {
          next = selected.concat([{ id: model.id, provider: model.provider, note: "" }]);
        }
        setSelected(next);
        saveSelection(next);
      }

      // Update note for a selected model
      function setNote(model, note) {
        markEditing();
        var next = selected.map(function (m) {
          if (m.id === model.id && m.provider === model.provider) return Object.assign({}, m, { note: note });
          return m;
        });
        setSelected(next);
        saveSelection(next);
      }

      function saveSelection(list) {
        console.log('[picturereader] saveSelection called with', list.length, 'models:', JSON.stringify(list.map(function(m) { return m.id; })));
        // Track last saved value to prevent scope sync from overwriting
        if (VisionBridgePicker._lastSavedRef) VisionBridgePicker._lastSavedRef(list);
        scope.set("vision_models", list).then(function () {
          console.log('[picturereader] vision_models saved successfully');
        }).catch(function (err) {
          console.error('[picturereader] vision_models save failed:', err);
        });
      }

      var isSelected = function (m) {
        return selected.some(function (s) { return s.id === m.id && s.provider === m.provider; });
      };
      var noteOf = function (m) {
        var entry = selected.find(function (s) { return s.id === m.id && s.provider === m.provider; });
        return entry ? (entry.note || "") : "";
      };

      return h("div", { className: "__pr_field" },
        h("span", { className: "__pr_label" }, t("visionBridgeModels")),
        h("span", { className: "__pr_hint" }, t("visionBridgeModelsHint")),
        available.length === 0
          ? h("p", { className: "__pr_empty" }, t("noModels"))
          : h("div", { className: "__pr_modelList" },
              available.map(function (m) {
                var key = m.provider + "/" + m.id;
                var checked = isSelected(m);
                return h("div", { key: key, className: "__pr_modelRow" },
                  h("input", {
                    className: "__pr_check",
                    type: "checkbox",
                    checked: checked,
                    onChange: function () { toggleModel(m); },
                  }),
                  h("span", { className: "__pr_modelName" }, m.name || m.id),
                  h("span", { className: "__pr_modelProvider" }, m.provider),
                  checked ? h("input", {
                    className: "__pr_inputSmall",
                    type: "text",
                    value: noteOf(m),
                    placeholder: t("visionBridgeNotePH"),
                    onChange: function (e) { setNote(m, e.target.value); },
                  }) : null
                );
              })
            )
      );
    }

    function tOf(props) { return props.t; }

    // ── Section component ─────────────────────────────────────────────────
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
        if (typeof scope.load === "function") scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); if (scope.dispose) scope.dispose(); };
      }, [scope]);
      react.useEffect(function () {
        // Fill the draft from the resolved value once, but never overwrite keys
        // the user has already edited: the previous merge put `prev` under the
        // fresh defaults, which could wipe in-progress edits if this effect ever
        // re-ran after the user started changing fields.
        if (ready) setDraft(function (prev) {
          var base = valueToDraft(snapshot.value);
          var merged = Object.assign({}, base);
          for (var k in prev) merged[k] = prev[k];
          return merged;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__pr_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__pr_status" }, t("loading"));

      var value = snapshot.value;

      function fieldDraft(f) {
        if (f.type === "checkbox") return draft[f.key] !== void 0 ? !!draft[f.key] : Boolean(value[f.key]);
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[f.key] ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) { var n = Object.assign({}, prev); n[f.key] = v; return n; });
        setNotice(null); setError(null);
      }
      function fieldValue(f) {
        // The value the form currently shows: the user's draft if touched,
        // otherwise the current resolved value (what is on screen).
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[f.key] ?? "");
      }
      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        // Persist exactly what the form shows RIGHT NOW. We deliberately do not
        // "skip a write when the draft equals the resolved snapshot": that
        // skip-by-equality silently dropped every field whenever the form state
        // matched the loaded defaults (the UI still reported 已保存 while writing
        // nothing), so all main settings reverted to defaults on reopen. Instead
        // every non-model field is written unconditionally from its current form
        // value; writes go through the same shared scope as vision_models, so the
        // host applies them in order with no stale-revision drop. Secrets stay
        // write-only (blank = keep the stored value) and an empty string is
        // recorded as an unset so it falls back to the default.
        var ops = [];
        FIELDS.forEach(function (f) {
          if (f.type === "models") return; // vision_models handled by VisionBridgePicker
          // Resolve each field's typed form value: the draft if the user has
          // touched it, otherwise the current resolved value. Checkboxes keep
          // their boolean so an untouched "false" is not coerced to true.
          if (f.type === "checkbox") {
            ops.push({ op: "set", key: f.key, value: draft[f.key] !== void 0 ? !!draft[f.key] : Boolean(value[f.key]) });
            return;
          }
          // For select fields (mode, ocr_engine), use draft value if touched, otherwise use current value
          if (f.type === "mode" || f.type === "ocr") {
            var selectVal = draft[f.key] !== void 0 ? draft[f.key] : (value[f.key] || (f.type === "mode" ? "smart" : "windows"));
            if (selectVal) ops.push({ op: "set", key: f.key, value: selectVal });
            return;
          }
          var dv = fieldValue(f);
          if (f.type === "password") {
            if (String(dv).trim() !== "") ops.push({ op: "set", key: f.key, value: String(dv).trim() });
            return;
          }
          if (f.type === "number") {
            var num = Number(dv);
            if (Number.isFinite(num)) ops.push({ op: "set", key: f.key, value: num });
            return;
          }
          var str = String(dv);
          if (str.trim() === "") { ops.push({ op: "unset", key: f.key }); return; }
          ops.push({ op: "set", key: f.key, value: str });
        });
        var writes = ops.map(function (o) {
          return o.op === "set" ? scope.set(o.key, o.value) : scope.unset(o.key);
        });
        Promise.all(writes).then(function () {
          setBusy(false); setNotice(t("saved"));
          if (scope.load) scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }
      function onReset() {
        setBusy(true);
        Promise.all(FIELDS.filter(function (f) { return f.type !== "models"; }).map(function (f) { return scope.unset(f.key); })).then(function () {
          setBusy(false); setNotice(t("saved"));
          setTimeout(function () {
            var fresh = scope.getSnapshot();
            if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
          }, 120);
        }).catch(function (e) { setBusy(false); setError(t("error") + ": " + String(e && e.message || e)); });
      }

      function renderField(f) {
        // Vision models picker (custom component, not a standard field)
        if (f.type === "models") {
          return h(VisionBridgePicker, { key: f.key, t: t, scope: scope });
        }
        // VLM fields hidden unless vlm_enabled checked
        if (f.key.indexOf("vlm_") === 0 && f.key !== "vlm_enabled") {
          var vlmOn = draft["vlm_enabled"] !== void 0 ? !!draft["vlm_enabled"] : Boolean(value["vlm_enabled"]);
          if (!vlmOn) return null;
        }
        if (f.type === "checkbox") {
          var checked = !!fieldDraft(f);
          return h("label", { key: f.key, className: "__pr_field" },
            h("span", { className: "__pr_row" },
              h("input", { className: "__pr_check", type: "checkbox", checked: checked, onChange: function (e) { setField(f, e.target.checked); } }),
              h("span", { className: "__pr_label" }, t(FIELD_LABELS[f.key]))
            ),
            f.hintKey ? h("span", { className: "__pr_hint" }, t(f.hintKey)) : null
          );
        }
        if (f.type === "mode") {
          return h("label", { key: f.key, className: "__pr_field" },
            h("span", { className: "__pr_label" }, t("mode")),
            h("select", {
              className: "__pr_select",
              value: fieldDraft(f) || "smart",
              onChange: function (e) { setField(f, e.target.value); },
            }, MODE_OPTS.map(function (o) {
              return h("option", { key: o.value, value: o.value }, t(o.labelKey));
            })),
            h("span", { className: "__pr_hint" }, t("modeHint"))
          );
        }
        if (f.type === "ocr") {
          return h("label", { key: f.key, className: "__pr_field" },
            h("span", { className: "__pr_label" }, t("ocr")),
            h("select", {
              className: "__pr_select",
              value: fieldDraft(f) || "windows",
              onChange: function (e) { setField(f, e.target.value); },
            }, OCR_OPTS.map(function (o) {
              return h("option", { key: o.value, value: o.value }, t(o.labelKey));
            })),
            h("span", { className: "__pr_hint" }, null)
          );
        }
        return h("label", { key: f.key, className: "__pr_field" },
          h("span", { className: "__pr_label" }, t(FIELD_LABELS[f.key])),
          h("input", {
            className: "__pr_input",
            type: f.type === "password" ? "password" : f.type === "number" ? "number" : "text",
            value: fieldDraft(f),
            placeholder: f.placeholderKey ? t(f.placeholderKey) : (f.type === "password" ? (value[f.key] ? "••••••••" : t("vlmKeyHint")) : ""),
            onChange: function (e) { setField(f, e.target.value); },
          }),
          f.hintKey ? h("span", { className: "__pr_hint" }, t(f.hintKey)) : null
        );
      }

      var primary = FIELDS.filter(function (f) { return !f.advanced; });
      var advanced = FIELDS.filter(function (f) { return f.advanced; });
      return h("div", { className: "__pr_root" },
        h("p", { className: "__pr_hint", style: { margin: "0 0 4px" } }, t("intro")),
        primary.map(renderField),
        advanced.length ? h("details", { className: "__pr_advanced" },
          h("summary", { className: "__pr_advancedSummary" },
            h("span", null, t("advanced")),
            h("span", { className: "__pr_advancedArrow" }, "\u25b8")
          ),
          advanced.map(renderField)
        ) : null,
        h("div", { className: "__pr_actions" },
          h("button", { type: "button", className: "__pr_btn __pr_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__pr_btn", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__pr_status" }, notice) : null,
          busy ? h("span", { className: "__pr_status" }, t("saving")) : null,
          error ? h("span", { className: "__pr_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i += 1) {
        var ft = FIELDS[i];
        if (ft.type === "models") continue; // handled separately
        out[ft.key] = ft.type === "checkbox" ? Boolean(value[ft.key]) : String(value[ft.key] ?? "");
      }
      return out;
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "picturereader: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: NS });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "picturereader",
          order: 30,
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

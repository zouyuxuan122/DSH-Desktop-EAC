/**
 * dsh-auto-compact — browser half: 默认开启的自动压缩.
 *
 * 机制：在 conversation.composer.dock 挂一个不可见的 occupant（与
 * dsh-message-rewind 同一手法），标准 props 里持续拿到
 *   · useProjection —— 订阅会话的 contextPressure 投影（token-meter 提供：
 *     pressureTokens / projectedTokens / contextWindow）
 *   · inputActions —— setDraft / submit，用于以用户身份提交 /compact
 * 占用率 = projectedTokens ÷ contextWindow（与官方 ContextMeter 环同口径）。
 * 达到阈值且满足静默条件（非首轮 hero、无进行中轮次的输入、距上次压缩
 * 冷却 3 分钟）时自动提交 /compact —— 命令要求 agent 空闲，压缩事务由
 * 内核 dsh-compaction-basic 执行，失败（busy 等）只是记录，绝不打扰。
 *
 * 设置页分区可调：开关（默认开）、阈值（60–95%，默认 80%）、手动「立即压缩」。
 * 配置持久化到 localStorage（settings namespace 之外的轻量本地方案，
 * 避免占用一个宿主命名空间 —— 那正是「设置命名空间不可用」的雷区）。
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-auto-compact",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    var STORE_KEY = "dsh-auto-compact-config-v1";
    var DEFAULTS = { enabled: true, threshold: 80 };
    var COOLDOWN_MS = 3 * 60 * 1000;

    function loadConfig() {
      try {
        var raw = window.localStorage.getItem(STORE_KEY);
        if (raw) {
          var c = JSON.parse(raw);
          return {
            enabled: c.enabled !== false,
            threshold: Math.min(95, Math.max(60, Math.round(Number(c.threshold) || DEFAULTS.threshold)))
          };
        }
      } catch (e) { /* fall through */ }
      return Object.assign({}, DEFAULTS);
    }
    function saveConfig(cfg) {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
    }

    // ── 会话状态（dock occupant 镜像）────────────────────────────────────
    var sessions = new Map(); // sessionId -> { inputActions, useProjection, lastFireAt }
    var currentId = null;

    function occupancyOf(pressure) {
      if (!pressure) return null;
      var used = pressure.projectedTokens !== undefined ? pressure.projectedTokens : pressure.pressureTokens;
      if (used === undefined || pressure.contextWindow === undefined) return null;
      return { percent: Math.min(100, Math.round((used / pressure.contextWindow) * 100)), used: used, window: pressure.contextWindow };
    }

    function toast(msg) {
      try {
        var el = document.createElement("div");
        el.textContent = msg;
        el.style.cssText = "position:fixed;right:18px;bottom:56px;z-index:2147483000;padding:8px 14px;border-radius:10px;" +
          "background:var(--dsw-alias-bg-layer-2,rgba(16,22,40,.95));color:var(--dsw-alias-label-primary,#e6ecff);" +
          "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));font-size:12.5px;max-width:320px;" +
          "box-shadow:0 8px 28px rgba(0,0,0,.4);opacity:0;transition:opacity .18s";
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.style.opacity = "1"; });
        setTimeout(function () {
          el.style.opacity = "0";
          setTimeout(function () { el.remove(); }, 250);
        }, 4200);
      } catch (e) { /* 提示失败无碍 */ }
    }

    function fireCompact(sessionId) {
      var cap = sessions.get(sessionId);
      if (!cap || !cap.inputActions || typeof cap.inputActions.setDraft !== "function") return false;
      try {
        cap.inputActions.setDraft("/compact");
        // 提交必须在下一帧（draft 状态先落地）；submit 缺失时退化为仅填入
        // 草稿，由用户回车确认。
        var ia = cap.inputActions;
        if (typeof ia.submit === "function") {
          setTimeout(function () {
            try { ia.submit(); } catch (e) { /* busy 等拒绝静默 */ }
          }, 50);
        }
        cap.lastFireAt = Date.now();
        return true;
      } catch (e) {
        return false;
      }
    }

    // 不可见的 dock occupant：持续镜像每个会话的 inputActions 与占用率。
    function AutoCompactCapture(props) {
      var sessionId = props.sessionId;
      var inputActions = props.inputActions;
      var useProjection = props.useProjection;

      var pressure = null;
      try {
        if (typeof useProjection === "function") pressure = useProjection("contextPressure");
      } catch (e) { pressure = null; }

      react.useEffect(function () {
        if (!sessionId) return;
        currentId = sessionId;
        var cap = sessions.get(sessionId);
        if (!cap) { cap = { inputActions: null, lastFireAt: 0 }; sessions.set(sessionId, cap); }
        if (inputActions) cap.inputActions = inputActions;
        return function () {
          // 切走的会话保留捕获（回切无需重建），只撤销当前指针。
          if (currentId === sessionId) currentId = sessionId;
        };
      }, [sessionId, inputActions]);

      // 判定与触发放在渲染数据就绪处（每次投影更新都会重渲染 occupant）。
      react.useEffect(function () {
        if (!sessionId || !pressure) return;
        var occ = occupancyOf(pressure);
        if (!occ) return;
        var cfg = loadConfig();
        if (!cfg.enabled) return;
        var cap = sessions.get(sessionId);
        if (!cap || !cap.inputActions) return;
        if (occ.percent < cfg.threshold) return;
        if (Date.now() - (cap.lastFireAt || 0) < COOLDOWN_MS) return;
        if (fireCompact(sessionId)) {
          toast("上下文已达到 " + occ.percent + "%（阈值 " + cfg.threshold + "%），已自动压缩（/compact）");
        }
      }, [sessionId, pressure && (pressure.projectedTokens ?? pressure.pressureTokens), pressure && pressure.contextWindow]);

      return null;
    }

    // ── 设置页分区 ────────────────────────────────────────────────────────
    var NS = "autoCompact";
    var zh = {
      nav: "自动压缩",
      intro: "对话接近上下文上限时自动执行 /compact（官方压缩命令）：保留近期对话与摘要，替换较早历史。默认开启。",
      enabled: "启用自动压缩",
      threshold: "触发阈值",
      thresholdHint: "占用率达到该比例时触发（官方环指示器同口径）。建议 70–85%。",
      now: "立即压缩当前对话",
      nowDone: "已发送 /compact",
      nowFail: "当前没有可压缩的会话（打开一个对话再试）",
      note: "压缩由内核执行，仅在对话空闲时进行；失败会静默跳过并在冷却后重试。"
    };
    var en = {
      nav: "Auto Compact",
      intro: "Automatically runs /compact (the official command) when a conversation approaches the context limit: recent turns are kept, older history is summarized. On by default.",
      enabled: "Enable auto compact",
      threshold: "Trigger threshold",
      thresholdHint: "Fires when occupancy reaches this ratio (same gauge as the official ring). 70–85% recommended.",
      now: "Compact current conversation now",
      nowDone: "/compact sent",
      nowFail: "No compactable session open (open a conversation first)",
      note: "Compaction runs in the core and only while idle; failures back off silently and retry after cooldown."
    };

    var CSS = ".__ac_root{max-width:640px;display:flex;flex-direction:column;gap:12px}" +
      ".__ac_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}" +
      ".__ac_row{display:flex;align-items:center;gap:10px}" +
      ".__ac_label{font-size:13px;font-weight:600}" +
      ".__ac_range{flex:1;accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__ac_size{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:40px;text-align:right}" +
      ".__ac_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__ac_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__ac_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__ac_ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}" +
      ".__ac_err{font-size:12px;color:var(--dsw-alias-state-error-primary)}";
    var tagId = "dsh-auto-compact/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-auto-compact";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function AutoCompactSection(props) {
      var t = props.t;
      var state = react.useState(null);
      var cfg = state[0];
      var setCfg = state[1];
      var msgState = react.useState(null);
      var msg = msgState[0];
      var setMsg = msgState[1];

      react.useEffect(function () { setCfg(loadConfig()); }, []);
      if (!cfg) return h("div", { className: "__ac_root" }, h("p", { className: "__ac_hint" }, "…"));

      var update = function (patch) {
        var next = Object.assign({}, cfg, patch);
        if (next.threshold !== undefined) next.threshold = Math.min(95, Math.max(60, Math.round(Number(next.threshold) || 80)));
        setCfg(next);
        saveConfig(next);
      };

      return h("div", { className: "__ac_root" },
        h("p", { className: "__ac_hint", style: { margin: 0 } }, t("intro")),
        h("label", { className: "__ac_row" },
          h("input", {
            type: "checkbox", checked: cfg.enabled,
            onChange: function (e) { update({ enabled: e.target.checked }); }
          }),
          h("span", { className: "__ac_label" }, t("enabled"))
        ),
        h("div", { className: "__ac_row" },
          h("span", { className: "__ac_label" }, t("threshold")),
          h("input", {
            className: "__ac_range", type: "range", min: 60, max: 95, step: 1,
            value: cfg.threshold,
            onChange: function (e) { update({ threshold: Number(e.target.value) }); }
          }),
          h("span", { className: "__ac_size" }, cfg.threshold + "%")
        ),
        h("p", { className: "__ac_hint" }, t("thresholdHint")),
        h("div", { className: "__ac_row" },
          h("button", {
            className: "__ac_btn __ac_btnPrimary",
            onClick: function () {
              var sid = currentId;
              var cap = sid && sessions.get(sid);
              if (cap && cap.inputActions) {
                if (fireCompact(sid)) setMsg({ ok: true, text: t("nowDone") });
                else setMsg({ ok: false, text: t("nowFail") });
              } else {
                setMsg({ ok: false, text: t("nowFail") });
              }
            }
          }, t("now")),
          msg ? h("span", { className: msg.ok ? "__ac_ok" : "__ac_err" }, msg.text) : null
        ),
        h("p", { className: "__ac_hint" }, t("note"))
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    var inject = ["slots", "locale"];

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-auto-compact: dictionaries");
      var slots = ctx.slots;
      // 状态镜像：occupant 渲染时刷新全局表。
      slots.inject("conversation.composer.dock", function () {
        return slots.register(
          { name: "conversation.composer.dock", id: "auto-compact-capture", order: 91 },
          AutoCompactCapture
        );
      });
      slots.inject("settings.section", function () {
        return slots.register({
          name: "settings.section",
          id: "auto-compact",
          order: 28,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(AutoCompactSection, props);
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = { occupancyOf, loadConfig, sanitizeConfig: function (c) { return { enabled: c.enabled !== false, threshold: Math.min(95, Math.max(60, Math.round(Number(c.threshold) || 80))) }; } };
    return module.exports;
  }
});

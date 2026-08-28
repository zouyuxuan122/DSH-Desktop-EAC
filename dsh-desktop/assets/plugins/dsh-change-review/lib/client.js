/**
 * dsh-change-review — browser half: AI 变更审核（V4，用户建议⑤）.
 *
 * 机制（与 dsh-auto-compact 同一手法）：在 conversation.composer.dock 挂
 * 一个不可见的 occupant，标准 props 里持续拿到
 *   · useProjection("fileChanges") —— 官方 dsh-file-changes 投影，含本会话
 *     agent 修改过的全部文件（path/op/写前写后全文，见「文件」标签页）
 *   · inputActions —— setDraft / submit，以用户身份提交审核请求
 *
 * 触发模式（设置页可调，默认手动）：
 *   · manual —— 设置页「立即审核当前会话变更」按钮触发；
 *   · auto   —— 投影新增变更且 20 秒无后续变更（一轮任务大概率已结束）时
 *               自动发送审核请求；轮次仍在进行导致提交被拒时退避重试；
 *               两次自动审核之间强制 10 分钟冷却，防「审核引发修改→再审」
 *               循环。
 *
 * 审核请求只带文件清单与行数统计（不带全文 diff —— 模型有会话上下文，
 * 必要时可自行读文件），请求模型从正确性 / 安全性 / 目标一致性三个角度
 * 复查自己的改动；结论配合「文件」页的一键还原即可落地处理。
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-change-review",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    var STORE_KEY = "dsh-change-review-config-v1";
    var DEFAULTS = { mode: "manual" }; // off | manual | auto
    var AUTO_DEBOUNCE_MS = 20 * 1000;
    var AUTO_COOLDOWN_MS = 10 * 60 * 1000;
    var RETRY_MS = 45 * 1000;
    var MAX_RETRY = 8;
    var MAX_FILES_IN_PROMPT = 40;

    function loadConfig() {
      try {
        var raw = window.localStorage.getItem(STORE_KEY);
        if (raw) {
          var c = JSON.parse(raw);
          return { mode: c.mode === "off" || c.mode === "auto" ? c.mode : "manual" };
        }
      } catch (e) { /* fall through */ }
      return { mode: DEFAULTS.mode };
    }
    function saveConfig(cfg) {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
    }

    // ── 会话状态（dock occupant 镜像）────────────────────────────────────
    var sessions = new Map(); // sessionId -> { inputActions, lastSeq, reviewedSeq, lastAutoAt, timer, retry }
    var currentId = null;

    function lineCount(text) {
      if (!text) return 0;
      var n = text.split("\n").length;
      return text.endsWith("\n") ? n - 1 : n;
    }

    function toast(msg, ok) {
      try {
        var el = document.createElement("div");
        el.textContent = msg;
        el.style.cssText = "position:fixed;right:18px;bottom:56px;z-index:2147483000;padding:8px 14px;border-radius:10px;" +
          "background:var(--dsw-alias-bg-layer-2,rgba(16,22,40,.95));color:" + (ok === false ? "var(--dsw-alias-state-error-primary,#ff7a85)" : "var(--dsw-alias-label-primary,#e6ecff)") + ";" +
          "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));font-size:12.5px;max-width:360px;" +
          "box-shadow:0 8px 28px rgba(0,0,0,.4);opacity:0;transition:opacity .18s";
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.style.opacity = "1"; });
        setTimeout(function () {
          el.style.opacity = "0";
          setTimeout(function () { el.remove(); }, 250);
        }, 4200);
      } catch (e) { /* 提示失败无碍 */ }
    }

    /** 由投影变更构造审核请求文本（清单 + 行数统计，不带全文）。 */
    function buildReviewPrompt(changes) {
      var perFile = new Map(); // path -> { op, add, del }
      for (var i = 0; i < changes.length; i++) {
        var c = changes[i];
        var f = perFile.get(c.path) || { op: c.op, add: 0, del: 0 };
        if (c.op === "create") f.op = "create";
        else if (c.op === "delete") f.op = "delete";
        else if (f.op !== "create" && f.op !== "delete") f.op = "edit";
        f.add += Math.max(0, lineCount(c.newText) - lineCount(c.oldText));
        f.del += Math.max(0, lineCount(c.oldText) - lineCount(c.newText));
        perFile.set(c.path, f);
      }
      var lines = [];
      var it = perFile.entries();
      var n = 0;
      for (var entry = it.next(); !entry.done && n < MAX_FILES_IN_PROMPT; entry = it.next(), n++) {
        var p = entry.value[0], f2 = entry.value[1];
        lines.push("- " + p + "（" + f2.op + "，+" + f2.add + "/-" + f2.del + " 行）");
      }
      var more = perFile.size - Math.min(perFile.size, MAX_FILES_IN_PROMPT);
      if (more > 0) lines.push("- …另有 " + more + " 个文件，见「文件」标签页");
      return "请审核你在本会话中做出的文件变更（共 " + perFile.size + " 个文件）：\n" +
        lines.join("\n") +
        "\n\n请从以下角度逐项复查这些改动，发现问题具体指出文件与位置：\n" +
        "1. 正确性风险：逻辑错误、边界条件、明显回归；\n" +
        "2. 安全性：危险命令、路径穿越、敏感信息写入、不该动的系统配置；\n" +
        "3. 目标一致性：是否夹带了任务未要求的改动。\n" +
        "最后单独一行给出结论：✅ 可以接受 / ⚠️ 需要注意（说明原因）/ ❌ 建议回滚（可用「文件」页一键还原）。";
    }

    function fireReview(sessionId) {
      var cap = sessions.get(sessionId);
      if (!cap || !cap.inputActions || typeof cap.inputActions.setDraft !== "function") return false;
      if (!cap.pendingChanges || cap.pendingChanges.length === 0) return false;
      var prompt = buildReviewPrompt(cap.pendingChanges);
      try {
        cap.inputActions.setDraft(prompt);
        var ia = cap.inputActions;
        if (typeof ia.submit === "function") {
          setTimeout(function () {
            try { ia.submit(); } catch (e) { /* busy：由外层退避重试 */ }
          }, 50);
        }
        cap.reviewedAt = Date.now();
        cap.pendingChanges = [];
        return true;
      } catch (e) {
        return false;
      }
    }

    // 不可见的 dock occupant：持续镜像每个会话的 inputActions 与文件变更。
    function ChangeReviewCapture(props) {
      var sessionId = props.sessionId;
      var inputActions = props.inputActions;
      var useProjection = props.useProjection;

      var changes = null;
      try {
        if (typeof useProjection === "function") changes = useProjection("fileChanges");
      } catch (e) { changes = null; }

      react.useEffect(function () {
        if (!sessionId) return;
        currentId = sessionId;
        var cap = sessions.get(sessionId);
        if (!cap) {
          cap = { inputActions: null, pendingChanges: [], reviewedAt: 0, timer: null, retry: 0 };
          sessions.set(sessionId, cap);
        }
        if (inputActions) cap.inputActions = inputActions;
      }, [sessionId, inputActions]);

      react.useEffect(function () {
        if (!sessionId || !changes || !Array.isArray(changes.changes)) return;
        var cfg = loadConfig();
        if (cfg.mode === "off") return;
        var cap = sessions.get(sessionId);
        if (!cap) return;
        var list = changes.changes;
        // 增量：只累计上次已审核之后的新变更。
        var lastSeq = cap.lastSeq || 0;
        var maxSeq = lastSeq;
        var fresh = [];
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if ((c.seq || 0) > lastSeq) {
            fresh.push(c);
            if ((c.seq || 0) > maxSeq) maxSeq = c.seq || 0;
          }
        }
        if (fresh.length === 0) return;
        cap.lastSeq = maxSeq;
        cap.pendingChanges = cap.pendingChanges.concat(fresh);
        if (cfg.mode !== "auto") return;
        // 自动模式：变更停止 20 秒后发送；冷却期内只累计不触发。
        if (Date.now() - (cap.reviewedAt || 0) < AUTO_COOLDOWN_MS) return;
        if (cap.timer) clearTimeout(cap.timer);
        cap.retry = 0;
        cap.timer = setTimeout(function attempt() {
          cap.timer = null;
          // 重新校验当前模式：用户可能已在此期间切换到手动/关闭
          var nowCfg = loadConfig();
          if (nowCfg.mode !== "auto") return;
          var ok = fireReview(sessionId);
          if (!ok && cap.pendingChanges.length > 0 && cap.retry < MAX_RETRY) {
            cap.retry += 1;
            cap.timer = setTimeout(attempt, RETRY_MS);
          }
        }, AUTO_DEBOUNCE_MS);
      }, [sessionId, changes && changes.changes]);

      return null;
    }

    // ── 设置页分区 ────────────────────────────────────────────────────────
    var NS = "changeReview";
    var zh = {
      nav: "AI 变更审核",
      intro: "让 AI 在每轮改动后复查自己刚做过的文件变更：审核请求以一条消息发进当前对话，从正确性、安全性、目标一致性三个角度给出结论，配合「文件」页的一键还原处理问题改动。",
      mode: "审核模式",
      modeOff: "关闭",
      modeManual: "手动（推荐）",
      modeAuto: "自动（每轮改动后）",
      now: "立即审核当前会话变更",
      nowDone: "审核请求已发送",
      nowFail: "当前会话没有新变更或没有打开的对话",
      note: "自动模式在变更停止 20 秒后触发，两次审核间隔至少 10 分钟；审核本身消耗一轮对话（计入 token 用量）。"
    };
    var en = {
      nav: "AI Change Review",
      intro: "Ask the AI to re-check its own recent file changes: the review request is posted into the current conversation and covers correctness, safety and scope, pairing with the revert actions on the Files tab.",
      mode: "Review mode",
      modeOff: "Off",
      modeManual: "Manual (recommended)",
      modeAuto: "Auto (after each turn)",
      now: "Review current conversation now",
      nowDone: "Review request sent",
      nowFail: "No fresh changes or no conversation open",
      note: "Auto mode fires 20s after changes settle, at most once every 10 minutes; each review costs one model turn."
    };

    var CSS = ".__cr_root{max-width:640px;display:flex;flex-direction:column;gap:12px}" +
      ".__cr_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}" +
      ".__cr_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}" +
      ".__cr_label{font-size:13px;font-weight:600}" +
      ".__cr_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__cr_btn:hover{border-color:var(--dsw-alias-state-business-primary)}" +
      ".__cr_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__cr_ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}" +
      ".__cr_err{font-size:12px;color:var(--dsw-alias-state-error-primary)}";
    var tagId = "dsh-change-review/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-change-review";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function ChangeReviewSection(props) {
      var t = props.t;
      var state = react.useState(null);
      var cfg = state[0];
      var setCfg = state[1];
      var msgState = react.useState(null);
      var msg = msgState[0];
      var setMsg = msgState[1];

      react.useEffect(function () { setCfg(loadConfig()); }, []);
      if (!cfg) return h("div", { className: "__cr_root" }, h("p", { className: "__cr_hint" }, "…"));

      var MODES = [
        { value: "off", label: t("modeOff") },
        { value: "manual", label: t("modeManual") },
        { value: "auto", label: t("modeAuto") }
      ];

      return h("div", { className: "__cr_root" },
        h("p", { className: "__cr_hint", style: { margin: 0 } }, t("intro")),
        h("div", { className: "__cr_row" },
          h("span", { className: "__cr_label" }, t("mode")),
          MODES.map(function (m) {
            return h("button", {
              key: m.value,
              className: "__cr_btn" + (cfg.mode === m.value ? " __cr_btnPrimary" : ""),
              onClick: function () {
                var next = { mode: m.value };
                setCfg(next);
                saveConfig(next);
                // 切换模式时清理当前会话的自动审核定时器
                var sid = currentId;
                var cap = sid && sessions.get(sid);
                if (cap && cap.timer) {
                  clearTimeout(cap.timer);
                  cap.timer = null;
                  cap.retry = 0;
                }
              }
            }, m.label);
          })
        ),
        h("div", { className: "__cr_row" },
          h("button", {
            className: "__cr_btn __cr_btnPrimary",
            onClick: function () {
              var sid = currentId;
              var cap = sid && sessions.get(sid);
              if (cap && cap.inputActions && cap.pendingChanges && cap.pendingChanges.length > 0) {
                if (fireReview(sid)) setMsg({ ok: true, text: t("nowDone") });
                else setMsg({ ok: false, text: t("nowFail") });
              } else {
                setMsg({ ok: false, text: t("nowFail") });
              }
            }
          }, t("now")),
          msg ? h("span", { className: msg.ok ? "__cr_ok" : "__cr_err" }, msg.text) : null
        ),
        h("p", { className: "__cr_hint" }, t("note"))
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    var inject = ["slots", "locale"];

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-change-review: dictionaries");
      var slots = ctx.slots;
      slots.inject("conversation.composer.dock", function () {
        return slots.register(
          { name: "conversation.composer.dock", id: "change-review-capture", order: 92 },
          ChangeReviewCapture
        );
      });
      slots.inject("settings.section", function () {
        return slots.register({
          name: "settings.section",
          id: "change-review",
          order: 29,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(ChangeReviewSection, props);
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      loadConfig: loadConfig,
      sanitizeConfig: function (c) { return { mode: c.mode === "off" || c.mode === "auto" ? c.mode : "manual" }; },
      buildReviewPrompt: buildReviewPrompt,
      lineCount: lineCount
    };
    return module.exports;
  }
});

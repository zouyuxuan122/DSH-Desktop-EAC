/**
 * dsh-offpeak — browser half (lazy-CJS 客户端 bundle，零依赖原生 DOM)。
 *
 * 拦截式提醒（v2）：
 * - 高峰时段（北京时间 9:00–12:00、14:00–18:00）用户在 composer 按 Enter
 *   或点发送按钮时，**在消息发出前拦截**：消息保留在输入框内，弹出提醒
 *   （当前模型 V4 Flash/Pro 高峰/闲时价目表 + 本条命令文本）；
 *   「继续执行」→ 重新派发原始提交事件，消息按正常路径发出；
 *   「定时执行」→ 登记到服务端（记录命令文本与时间），清空输入框，
 *   到点由服务端自动把命令提交给原会话执行；
 *   「今日不再提醒」→ 当天（北京时间）不再拦截/弹窗；
 *   关闭 × → 不发送，消息留在输入框。
 * - 中文输入法组合态（isComposing）与 Cmd/Ctrl/Shift 修饰键不拦截。
 * - 服务端 reminder 作为兜底：未拦截路径（如旧页面）发出消息后仍会弹非阻塞提醒。
 * - 分钟轮 00–59；小时栏仅 0–8、18–23 点，已过去的时间移除，23 之后滚动到次日 0–8。
 */
window.__ModuleLoader__.load({
  id: "dsh-offpeak",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    //#region styles
    const CSS_ID = "dsh-offpeak/styles.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-offpeak";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = [
        ".dspg_backdrop{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);font-family:var(--dsw-alias-font-family,system-ui,sans-serif)}",
        ".dspg_modal{width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 64px);overflow:auto;background:var(--dsw-alias-bg-primary,#202127);color:var(--dsw-alias-label-primary,#e8e8ea);border:1px solid var(--dsw-alias-border-primary,rgba(255,255,255,.12));border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.5);padding:18px 20px;box-sizing:border-box}",
        ".dspg_head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}",
        ".dspg_title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}",
        ".dspg_close{background:none;border:none;color:var(--dsw-alias-label-tertiary,#9a9aa2);font-size:18px;cursor:pointer;padding:2px 6px;border-radius:6px;line-height:1}",
        ".dspg_close:hover{background:rgba(255,255,255,.08);color:var(--dsw-alias-label-primary,#e8e8ea)}",
        ".dspg_sub{font-size:12px;color:var(--dsw-alias-label-secondary,#b6b6bd);margin-bottom:12px}",
        ".dspg_blocked{font-size:12px;color:var(--dsw-alias-state-warning-primary,#f2b24c);background:rgba(242,178,76,.12);border:1px solid rgba(242,178,76,.3);border-radius:8px;padding:6px 10px;margin-bottom:10px}",
        ".dspg_model{font-size:13px;font-weight:600;margin:10px 0 6px}",
        ".dspg_table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px}",
        ".dspg_table th,.dspg_table td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-primary,rgba(255,255,255,.08))}",
        ".dspg_table th{color:var(--dsw-alias-label-tertiary,#9a9aa2);font-weight:500}",
        ".dspg_peak{color:var(--dsw-alias-state-warning-primary,#f2b24c);font-weight:600}",
        ".dspg_off{color:var(--dsw-alias-label-tertiary,#9a9aa2)}",
        ".dspg_cmd{background:rgba(255,255,255,.05);border:1px solid var(--dsw-alias-border-primary,rgba(255,255,255,.1));border-radius:8px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#b6b6bd);margin-bottom:10px;max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-all}",
        ".dspg_hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9aa2);margin-bottom:12px}",
        ".dspg_actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}",
        ".dspg_btn{flex:1;min-width:120px;padding:8px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-primary,rgba(255,255,255,.14));background:rgba(255,255,255,.06);color:var(--dsw-alias-label-primary,#e8e8ea);font-size:13px;cursor:pointer;font-family:inherit}",
        ".dspg_btn:hover{background:rgba(255,255,255,.12)}",
        ".dspg_btn_primary{background:var(--dsw-alias-accent-primary,#4c8dff);border-color:transparent;color:#fff}",
        ".dspg_btn_primary:hover{background:var(--dsw-alias-accent-hover,#3d7bef)}",
        ".dspg_btn[disabled]{opacity:.5;cursor:not-allowed}",
        ".dspg_check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#b6b6bd);cursor:pointer;margin-top:12px;user-select:none}",
        ".dspg_check input{accent-color:var(--dsw-alias-accent-primary,#4c8dff)}",
        ".dspg_picker{display:flex;gap:12px;justify-content:center;margin:6px 0 12px}",
        ".dspg_wheel{display:flex;flex-direction:column;align-items:center;gap:2px}",
        ".dspg_wheel_label{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa2);margin-bottom:2px}",
        ".dspg_wheel_btn{width:44px;height:26px;border:none;background:rgba(255,255,255,.06);color:var(--dsw-alias-label-primary,#e8e8ea);border-radius:7px;cursor:pointer;font-size:13px}",
        ".dspg_wheel_btn:hover{background:rgba(255,255,255,.14)}",
        ".dspg_wheel_list{height:150px;overflow-y:auto;scrollbar-width:none;border:1px solid var(--dsw-alias-border-primary,rgba(255,255,255,.1));border-radius:9px;background:rgba(0,0,0,.18);padding:4px 0;width:96px;text-align:center}",
        ".dspg_wheel_list::-webkit-scrollbar{display:none}",
        ".dspg_wheel_item{padding:6px 4px;font-size:12px;color:var(--dsw-alias-label-secondary,#b6b6bd);cursor:pointer;border-radius:6px;white-space:nowrap}",
        ".dspg_wheel_item:hover{background:rgba(255,255,255,.07)}",
        ".dspg_wheel_item_sel{background:var(--dsw-alias-accent-primary,#4c8dff);color:#fff;font-weight:600}",
        ".dspg_picker_sum{font-size:12px;color:var(--dsw-alias-label-secondary,#b6b6bd);text-align:center;margin-bottom:10px}",
        ".dspg_toast{font-size:12px;text-align:center;color:var(--dsw-alias-state-success-primary,#5ec98f);padding:8px 0}"
      ].join("\n");
      document.head.appendChild(tag);
    }
    //#endregion

    //#region state
    const POLL_MS = 4000;
    let lastState = null; // 最近一次 /state 响应
    let shownNonce = null; // 已弹过兜底提醒的 nonce
    let modalEl = null; // 当前弹窗根节点（null = 未显示）
    let pollTimer = null;
    let disposeModal = null;
    let intercepting = false; // 正在派发原始提交事件（防重入）
    let suppressUntil = 0; // 继续执行/定时执行后的提醒抑制窗口
    let localRemindedToday = false; // 本页勾选「今日不再提醒」后的本地标记
    let currentCtx = null; // apply(ctx) 传入的客户端 ctx
    //#endregion

    const fmt = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return "—";
      return v >= 10 ? String(Math.round(v)) : String(v);
    };
    const fmtTime = (iso) => {
      const d = new Date(iso);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    };
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const pad = (n) => String(n).padStart(2, "0");

    /** 客户端自行计算的北京时间（分钟 + 日期），用于提交瞬间的高峰判断（轮询状态最多滞后 4s）。 */
    function beijingParts(now) {
      let parts = {};
      try {
        parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Shanghai",
          hour12: false,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).formatToParts(now).map((p) => [p.type, p.value]));
      } catch {
        return { minutes: now.getHours() * 60 + now.getMinutes(), date: "unknown" };
      }
      return {
        minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
        date: parts.year + "-" + parts.month + "-" + parts.day,
      };
    }
    function isPeak(minutes, windows) {
      return Array.isArray(windows) && windows.some((w) => minutes >= Number(w.start) && minutes < Number(w.end));
    }

    //#region fetch helpers
    async function fetchState() {
      try {
        const res = await fetch("/ds-offpeak/state", { cache: "no-store", headers: { accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        lastState = await res.json();
      } catch {
        lastState = null;
      }
    }
    async function postJson(path, payload) {
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
      } catch (error) {
        return { ok: false, status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
    //#endregion

    //#region interception decision
    function shouldIntercept(text) {
      const s = lastState;
      if (s === null || typeof s !== "object") return false;
      if (s.enabled !== true) return false;
      if (s.remindedToday === true || localRemindedToday) return false;
      const kind = s.modelKind;
      if (kind !== "flash" && kind !== "pro" && kind !== "deepseek-other") return false;
      if (text === undefined || typeof text !== "string" || text.trim() === "") return false;
      if (Date.now() < suppressUntil) return false;
      if (intercepting) return false;
      if (modalEl !== null) return false; // 已有弹窗时不重复拦截
      const bj = beijingParts(new Date());
      if (!isPeak(bj.minutes, s.peakWindows)) return false;
      return true;
    }
    //#endregion

    //#region modal
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className !== undefined && className !== "") node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function buildPriceBody(state, frag) {
      const modelName = state.model && state.model.model ? state.model.model : "";
      const kind = state.modelKind;
      const price = state.prices !== null && typeof state.prices === "object" ? state.prices : null;
      const entry = kind === "flash" || kind === "pro" ? price[kind] : null;
      const isDeepSeek = kind === "flash" || kind === "pro" || kind === "deepseek-other";
      if (isDeepSeek) {
        if (entry !== null) {
          frag.append(el("div", "dspg_model", entry.label + "（" + esc(modelName) + "）"));
          const table = el("table", "dspg_table");
          const thead = el("thead");
          const hr = el("tr");
          for (const t of ["计费项", "高峰价", "闲时价"]) hr.append(el("th", "", t));
          thead.append(hr);
          table.append(thead);
          const tbody = el("tbody");
          const rows = [
            ["输入（缓存未命中）", entry.peak.input, entry.off.input],
            ["输出", entry.peak.output, entry.off.output],
            ["输入（缓存命中）", entry.peak.cacheRead, entry.off.cacheRead],
          ];
          for (const [label, peak, off] of rows) {
            const tr = el("tr");
            tr.append(el("td", "", label));
            tr.append(el("td", "dspg_peak", "¥" + fmt(peak) + "/百万"));
            tr.append(el("td", "dspg_off", "¥" + fmt(off) + "/百万"));
            tbody.append(tr);
          }
          table.append(tbody);
          frag.append(table);
        } else {
          frag.append(el("div", "dspg_model", "当前模型：" + esc(modelName || "未知")));
          frag.append(el("div", "dspg_sub", "该模型不在 V4 Flash/Pro 调价表内，高峰时段价格仍可能偏高。"));
        }
      } else {
        frag.append(el("div", "dspg_sub", "当前模型非 DeepSeek 平台，价格不受峰谷定价影响。"));
      }
    }

    function buildMainView(state, opts) {
      const frag = document.createDocumentFragment();
      const bj = state.beijing;
      const peakLabel = Array.isArray(state.peakWindows) && state.peakWindows.length > 0
        ? state.peakWindows.map((w) => w.label).join(" / ")
        : "9:00–12:00 / 14:00–18:00";

      const head = el("div", "dspg_head");
      const title = el("div", "dspg_title", opts.intercept ? "⚡ 高峰时段 · 已拦截发送" : "⚡ 高峰时段 · 价格提醒");
      const close = el("button", "dspg_close", "✕");
      close.title = "关闭（不发送，消息保留在输入框）";
      close.addEventListener("click", () => void closePopup(true));
      head.append(title, close);
      frag.append(head);

      frag.append(el("div", "dspg_sub",
        "现在为北京时间 " + fmtTime(bj.iso) + "，处于高峰时段（" + peakLabel + "），价格较高。"));
      if (opts.intercept) {
        frag.append(el("div", "dspg_blocked", "本条命令已被拦截，尚未发送。"));
      }

      buildPriceBody(state, frag);

      const cmd = el("div", "dspg_cmd");
      cmd.textContent = "本条命令：" + (opts.text !== "" ? opts.text : "（空）");
      cmd.title = opts.text;
      frag.append(cmd);

      frag.append(el("div", "dspg_hint", "建议定时到 18:00 后或 0:00–8:00 执行，价格减半。"));

      const actions = el("div", "dspg_actions");
      const continueBtn = el("button", "dspg_btn dspg_btn_primary", "继续执行");
      continueBtn.addEventListener("click", () => void opts.onContinue());
      const scheduleBtn = el("button", "dspg_btn", "定时执行");
      scheduleBtn.disabled = opts.text === "";
      scheduleBtn.addEventListener("click", () => void showPicker(state, opts));
      actions.append(continueBtn, scheduleBtn);
      frag.append(actions);

      const check = el("label", "dspg_check");
      const box = document.createElement("input");
      box.type = "checkbox";
      check.append(box, document.createTextNode("今日不再提醒"));
      frag.append(check);

      return { root: frag, checkBox: box };
    }

    function buildPickerView(state, opts, onBack) {
      const frag = document.createDocumentFragment();
      const options = Array.isArray(state.hourOptions) && state.hourOptions.length > 0
        ? state.hourOptions
        : [];
      // 服务端每组 = 一个 (天, 小时)，携带该小时可选的分钟档（00–59）与分钟 0 档的 atMs。
      const groups = options.map((o) => ({
        dayOffset: o.dayOffset,
        hour: o.hour,
        label: o.label.split(" ")[0] + " " + String(o.hour).padStart(2, "0") + " 时",
        minutes: Array.isArray(o.minutes) && o.minutes.length > 0 ? o.minutes : [0],
        base: o,
      }));
      let groupIdx = 0;
      let minuteIdx = 0;
      const selected = () => {
        const g = groups[groupIdx];
        if (g === undefined) return null;
        const minute = g.minutes[minuteIdx];
        if (minute === undefined) return null;
        return {
          ...g.base,
          minute,
          atMs: g.base.atMs + minute * 60000,
          label: g.base.label.replace(/:00$/, ":" + pad(minute)),
        };
      };

      const head = el("div", "dspg_head");
      head.append(el("div", "dspg_title", "⏰ 定时执行"));
      frag.append(head);

      const picker = el("div", "dspg_picker");
      const buildWheel = (label, items, getSel, onSel) => {
        const wrap = el("div", "dspg_wheel");
        wrap.append(el("div", "dspg_wheel_label", label));
        const up = el("button", "dspg_wheel_btn", "▲");
        const list = el("div", "dspg_wheel_list");
        const down = el("button", "dspg_wheel_btn", "▼");
        const render = () => {
          list.textContent = "";
          items.forEach((item, idx) => {
            const row = el("div", "dspg_wheel_item" + (idx === getSel() ? " dspg_wheel_item_sel" : ""), item);
            row.addEventListener("click", () => {
              onSel(idx);
              render();
            });
            list.append(row);
          });
          const sel = list.children[getSel()];
          if (sel !== undefined && sel.scrollIntoView !== undefined) sel.scrollIntoView({ block: "center" });
        };
        up.addEventListener("click", () => {
          onSel((getSel() - 1 + items.length) % items.length);
          render();
        });
        down.addEventListener("click", () => {
          onSel((getSel() + 1) % items.length);
          render();
        });
        wrap.append(up, list, down);
        return { wrap, render };
      };

      const hourItems = groups.map((g) => g.label);
      const hourWheel = buildWheel("小时", hourItems, () => groupIdx, (i) => {
        groupIdx = i;
        minuteIdx = 0;
        minuteWheel.render();
        renderSum();
      });
      const minuteItems = () => groups[groupIdx] !== undefined ? groups[groupIdx].minutes.map((m) => pad(m)) : [];
      let minuteWheel = null;
      minuteWheel = buildWheel("分钟", minuteItems(), () => minuteIdx, (i) => {
        minuteIdx = i;
        renderSum();
      });
      const origMinuteRender = minuteWheel.render;
      minuteWheel.render = () => {
        const items = minuteItems();
        const list = minuteWheel.wrap.querySelector(".dspg_wheel_list");
        list.textContent = "";
        items.forEach((item, idx) => {
          const row = el("div", "dspg_wheel_item" + (idx === minuteIdx ? " dspg_wheel_item_sel" : ""), item);
          row.addEventListener("click", () => {
            minuteIdx = idx;
            minuteWheel.render();
            renderSum();
          });
          list.append(row);
        });
        const sel = list.children[minuteIdx];
        if (sel !== undefined && sel.scrollIntoView !== undefined) sel.scrollIntoView({ block: "center" });
      };
      void origMinuteRender;
      picker.append(hourWheel.wrap, minuteWheel.wrap);
      frag.append(picker);

      const sum = el("div", "dspg_picker_sum", "");
      const renderSum = () => {
        const sel = selected();
        sum.textContent = sel !== null
          ? "将于 " + sel.label + " 执行（闲时半价）"
          : "无可选时间";
      };
      frag.append(sum);

      const actions = el("div", "dspg_actions");
      const back = el("button", "dspg_btn", "返回");
      back.addEventListener("click", () => onBack());
      const confirm = el("button", "dspg_btn dspg_btn_primary", "确认定时");
      confirm.addEventListener("click", () => void opts.onSchedule(selected()));
      actions.append(back, confirm);
      frag.append(actions);

      const check = el("label", "dspg_check");
      const box = document.createElement("input");
      box.type = "checkbox";
      check.append(box, document.createTextNode("今日不再提醒"));
      frag.append(check);

      return { root: frag, checkBox: box, renderSum };
    }

    function openModal(content) {
      hideModal();
      const backdrop = el("div", "dspg_backdrop");
      const modal = el("div", "dspg_modal");
      modal.append(content);
      backdrop.append(modal);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) void closePopup(true);
      });
      document.body.append(backdrop);
      modalEl = backdrop;
    }
    function hideModal() {
      if (modalEl !== null && modalEl.parentNode !== null) modalEl.parentNode.removeChild(modalEl);
      modalEl = null;
      if (disposeModal !== null) {
        try {
          disposeModal();
        } catch { /* noop */ }
        disposeModal = null;
      }
    }
    function currentCheckBox() {
      return modalEl !== null ? modalEl.querySelector(".dspg_check input") : null;
    }
    function shouldDismissToday() {
      const box = currentCheckBox();
      return box !== null && box.checked === true;
    }
    async function maybeDismissToday() {
      if (shouldDismissToday()) {
        const r = await postJson("/ds-offpeak/dismiss", { forToday: true });
        if (r.ok) {
          localRemindedToday = true;
          if (lastState !== null && typeof lastState === "object") lastState.remindedToday = true;
        }
      }
    }
    async function closePopup(allowDismiss) {
      if (allowDismiss) await maybeDismissToday();
      hideModal();
    }

    /** 继续执行：重新派发被拦截的提交事件，走 composer 原生提交路径。 */
    async function continueSend(opts) {
      suppressUntil = Date.now() + 8000;
      // 顺手 ack 掉可能存在的服务端兜底提醒，避免轮询重复弹窗。
      const s = lastState;
      if (s !== null && s.reminder !== null && s.reminder.nonce !== undefined) {
        await postJson("/ds-offpeak/ack", { nonce: s.reminder.nonce });
        if (s.reminder.nonce === shownNonce) shownNonce = null;
      }
      await maybeDismissToday();
      hideModal();
      intercepting = true;
      try {
        if (opts.gesture === "enter" && opts.target instanceof HTMLTextAreaElement) {
          opts.target.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", bubbles: true, cancelable: true,
          }));
        } else {
          const btn = document.querySelector('button[aria-label="发送消息"], button[aria-label="Send message"]');
          if (btn !== null) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
      } finally {
        intercepting = false;
      }
    }

    /** 定时执行：登记到服务端并清空输入框草稿。 */
    async function scheduleSend(opts, sel) {
      if (sel === null) return;
      let sessionId = "";
      try {
        const sessions = currentCtx !== null ? currentCtx.get("sessions") : undefined;
        if (sessions !== undefined && sessions.list !== undefined) {
          const snap = sessions.list.getSnapshot();
          if (snap !== null && typeof snap === "object" && typeof snap.current === "string") sessionId = snap.current;
        }
      } catch { /* 取不到会话则报错 */ }
      if (sessionId === "") {
        const modal = modalEl !== null ? modalEl.querySelector(".dspg_modal") : null;
        if (modal !== null) {
          const msg = el("div", "dspg_toast", "无法确定当前会话，定时失败");
          msg.style.color = "var(--dsw-alias-state-error-primary,#f26d6d)";
          modal.append(msg);
        }
        return;
      }
      const result = await postJson("/ds-offpeak/schedule", {
        text: opts.text,
        atMs: sel.atMs,
        sessionId,
      });
      if (result.ok && result.body !== null && result.body.ok === true) {
        suppressUntil = Date.now() + 8000;
        await maybeDismissToday();
        // 清空输入框草稿（React 受控组件需用原生 setter + input 事件）。
        const ta = opts.target instanceof HTMLTextAreaElement ? opts.target : null;
        if (ta !== null && !ta.readOnly && !ta.disabled) {
          try {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
            setter.call(ta, "");
            ta.dispatchEvent(new Event("input", { bubbles: true }));
          } catch { /* 清空失败则保留原文 */ }
        }
        const modal = modalEl !== null ? modalEl.querySelector(".dspg_modal") : null;
        if (modal !== null) {
          const toast = el("div", "dspg_toast", "✓ 已定时：" + sel.label + " 自动执行");
          modal.textContent = "";
          modal.append(toast);
          setTimeout(() => hideModal(), 1600);
        } else {
          hideModal();
        }
      } else {
        const modal = modalEl !== null ? modalEl.querySelector(".dspg_modal") : null;
        if (modal !== null) {
          const msg = el("div", "dspg_toast", "定时失败：" + (result.body !== null && result.body.error !== undefined ? result.body.error : "未知错误"));
          msg.style.color = "var(--dsw-alias-state-error-primary,#f26d6d)";
          modal.append(msg);
        }
      }
    }

    function showMainPopup(state, opts) {
      const view = buildMainView(state, opts);
      openModal(view.root);
      disposeModal = () => { /* noop */ };
      void view.checkBox;
    }

    function showPicker(state, opts) {
      const view = buildPickerView(state, opts, () => {
        if (lastState !== null) showMainPopup(lastState, opts);
        else hideModal();
      });
      openModal(view.root);
      view.renderSum();
      disposeModal = () => { /* noop */ };
    }

    /** 拦截式弹窗：消息尚未发送。 */
    function showInterceptPopup(ta, text, gesture) {
      const state = lastState;
      if (state === null) return;
      const opts = {
        intercept: true,
        text,
        target: ta,
        gesture,
        onContinue: () => void continueSend(opts),
        onSchedule: (sel) => void scheduleSend(opts, sel),
      };
      showMainPopup(state, opts);
    }

    /** 兜底提醒弹窗：消息已发出（非拦截路径），服务端 reminder 触发。 */
    function showReminderPopup(state) {
      const opts = {
        intercept: false,
        text: state.reminder.text !== undefined ? state.reminder.text : "",
        target: null,
        gesture: "click",
        onContinue: () => void continueSend(opts),
        onSchedule: (sel) => void scheduleSend(opts, sel),
      };
      showMainPopup(state, opts);
    }

    function maybeShowReminder() {
      const s = lastState;
      if (s === null || typeof s !== "object") return;
      if (s.enabled !== true || s.inPeak !== true) return;
      if (Date.now() < suppressUntil) return;
      if (modalEl !== null) return;
      if (s.reminder === null || typeof s.reminder !== "object" || s.reminder.nonce === undefined) return;
      if (s.reminder.nonce === shownNonce) return;
      shownNonce = s.reminder.nonce;
      showReminderPopup(s);
    }
    //#endregion

    //#region interception listeners
    function attachInterception(ctx) {
      const onKeydown = (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing === true) return; // 中文输入法选字回车不拦截
        const ta = e.target;
        if (!(ta instanceof HTMLTextAreaElement)) return;
        if (ta.closest("[data-composer-card]") === null) return;
        if (ta.readOnly || ta.disabled) return;
        if (!shouldIntercept(ta.value)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        showInterceptPopup(ta, ta.value, "enter");
      };
      const onClick = (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const btn = t.closest('button[aria-label="发送消息"], button[aria-label="Send message"]');
        if (btn === null || btn.disabled) return;
        const card = btn.closest("[data-composer-card]");
        if (card === null) return;
        const ta = card.querySelector("textarea");
        if (ta === null || ta.readOnly || ta.disabled) return;
        if (!shouldIntercept(ta.value)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        showInterceptPopup(ta, ta.value, "click");
      };
      document.addEventListener("keydown", onKeydown, { capture: true });
      document.addEventListener("click", onClick, { capture: true });
      return () => {
        document.removeEventListener("keydown", onKeydown, { capture: true });
        document.removeEventListener("click", onClick, { capture: true });
      };
    }
    //#endregion

    //#region plugin
    function apply(ctx) {
      currentCtx = ctx;
      let disposed = false;
      const refresh = () => {
        if (disposed) return;
        fetchState().then(() => {
          if (disposed) return;
          maybeShowReminder();
        });
      };
      // 即时触发：连接事件流里出现新的 user/message 就立刻拉一次状态（兜底提醒更快）。
      let unsubscribe = null;
      try {
        const connection = ctx.get("connection");
        if (connection !== null && connection !== undefined && typeof connection.subscribeEnvelopes === "function") {
          unsubscribe = connection.subscribeEnvelopes((env) => {
            if (disposed) return;
            if (env !== null && typeof env === "object" && env.type === "session/event"
              && env.event !== null && typeof env.event === "object" && env.event.type === "user/message") {
              refresh();
            }
          });
        }
      } catch { /* 无连接服务时退化为轮询 */ }

      const detachInterception = attachInterception(ctx);

      ctx.effect(() => {
        pollTimer = setInterval(refresh, POLL_MS);
        refresh();
        return () => {
          disposed = true;
          if (pollTimer !== null) clearInterval(pollTimer);
          if (unsubscribe !== null) {
            try {
              unsubscribe();
            } catch { /* noop */ }
          }
          detachInterception();
          hideModal();
        };
      }, "dsh-offpeak: poll");
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  }
});

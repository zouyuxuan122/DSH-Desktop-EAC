window.__ModuleLoader__.load({
  id: "dsh-whale-meter",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const name = "whale-meter";
    const inject = ["slots"];
    const URL = "/plugins/dsh-whale-meter/state.json";

    const access = (ctx, key) => {
      try { const value = typeof ctx.get === "function" ? ctx.get(key) : null; if (value) return value; } catch {}
      try { return ctx[key] || null; } catch { return null; }
    };
    const usageOf = (value) => {
      if (!value || typeof value !== "object") return null;
      const keys = ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
      const out = {};
      for (const key of keys) out[key] = Math.max(0, Number(value[key]) || 0);
      return out;
    };
    const collectSessions = (ctx) => {
      const sessions = access(ctx, "sessions");
      if (!sessions?.list?.getSnapshot) return [];
      const snapshot = sessions.list.getSnapshot();
      const rows = [];
      for (const id of snapshot?.ids || []) {
        const summary = snapshot.byId?.[id];
        let usage = usageOf(summary?.projectionValues?.tokenUsage);
        try {
          const binding = sessions.binding?.(id);
          usage ||= usageOf(binding?.session?.projections?.get?.("tokenUsage"));
        } catch {}
        if (usage) rows.push({ id: String(id), title: summary?.displayTitle || summary?.title || String(id), usage });
      }
      return rows;
    };
    const postSnapshots = async (ctx) => {
      const rows = collectSessions(ctx);
      if (!rows.length) return null;
      const response = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessions: rows }) });
      return response.ok ? response.json() : null;
    };
    const money = (value) => Number(value || 0).toFixed(4);
    const tokens = (usage) => Object.values(usage || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const compactTokens = (value) => {
      const amount = Math.max(0, Number(value) || 0);
      if (amount >= 1e9) return (amount / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
      if (amount >= 1e6) return (amount / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (amount >= 1e3) return (amount / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
      return String(Math.round(amount));
    };
    const usageCost = (usage, config) => ((Number(usage?.uncachedInputTokens || 0) * Number(config.cacheMiss || 0) + Number(usage?.cacheReadTokens || 0) * Number(config.cacheHit || 0) + Number(usage?.cacheWriteTokens || 0) * Number(config.cacheMiss || 0) + Number(usage?.outputTokens || 0) * Number(config.output || 0)) / 1e6) * Number(config.usdToCurrency || 0);
    const formatUsage = (template, usage, config) => {
      const total = tokens(usage), cost = usageCost(usage, config);
      return String(template || "").replaceAll("{tokens}", Math.round(total).toLocaleString()).replaceAll("{cost}", money(cost)).replaceAll("{currency}", config.currency || "¥").replaceAll("{input}", Math.round(Number(usage?.uncachedInputTokens || 0) + Number(usage?.cacheReadTokens || 0) + Number(usage?.cacheWriteTokens || 0)).toLocaleString()).replaceAll("{output}", Math.round(Number(usage?.outputTokens || 0)).toLocaleString());
    };

    // The stock workspace row does not expose a session-row slot.  Keep this
    // tiny, DOM-only decoration isolated: token data still comes from the
    // official sessions store above, and a MutationObserver reapplies it when
    // React rerenders the sidebar.
    function SidebarTokenLabels() {
      const ctx = SidebarTokenLabels.ctx;
      const [, refresh] = React.useState(0);
      React.useEffect(() => {
        const sessions = access(ctx, "sessions");
        const sync = () => refresh((value) => value + 1);
        let unsubscribe = null;
        try { unsubscribe = sessions?.list?.subscribe?.(sync) || null; } catch {}
        const observer = new MutationObserver(sync);
        try { observer.observe(document.body, { childList: true, subtree: true }); } catch {}
        const timer = setInterval(sync, 3000);
        return () => { try { unsubscribe?.(); } catch {} observer.disconnect(); clearInterval(timer); };
      }, [ctx]);
      React.useEffect(() => {
        const byTitle = new Map();
        for (const row of collectSessions(ctx)) byTitle.set(String(row.title || "").trim(), tokens(row.usage));
        for (const item of document.querySelectorAll("[role='treeitem']")) {
          const title = item.querySelector("span[class*='_title']");
          if (!title) continue;
          const value = byTitle.get(String(title.textContent || "").trim());
          let badge = item.querySelector("[data-whale-session-token]");
          if (value === undefined) { badge?.remove(); continue; }
          if (!badge) {
            badge = document.createElement("span");
            badge.dataset.whaleSessionToken = "";
            badge.style.cssText = "flex:none;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;margin-right:6px;pointer-events:none;";
            title.insertAdjacentElement("afterend", badge);
          }
          badge.textContent = compactTokens(value);
          badge.title = `${Math.round(value).toLocaleString()} token`;
        }
      });
      return null;
    }

    // The composer has no public session-usage slot. Decorate it from the
    // official session store and persisted meter config, then reapply after
    // React updates. This never changes message contents or the send action.
    function ComposerUsageLabel() {
      const ctx = ComposerUsageLabel.ctx;
      React.useEffect(() => {
        let stopped = false;
        const sync = async () => {
          try {
            const saved = await postSnapshots(ctx);
            const state = saved || await fetch(URL, { cache: "no-store" }).then((r) => r.json());
            if (stopped || !state?.config) return;
            const selected = [...document.querySelectorAll("[role='treeitem']")].find((item) => item.getAttribute("aria-selected") === "true" || /(?:^|[ _-])(selected|active)(?:$|[ _-])/i.test(String(item.className || "")));
            const selectedTitle = selected?.querySelector("span[class*='_title']")?.textContent?.trim();
            const pageTitle = document.querySelector("main h1, [role='main'] h1")?.textContent?.trim();
            const row = collectSessions(ctx).find((entry) => String(entry.title || "").trim() === selectedTitle) || collectSessions(ctx).find((entry) => String(entry.title || "").trim() === pageTitle);
            const old = document.querySelector("[data-whale-composer-usage]");
            if (!row || state.config.composerPosition === "hidden") { old?.remove(); return; }
            const editor = document.querySelector("[contenteditable='true'][role='textbox'], [contenteditable='true'][data-lexical-editor], textarea[role='textbox'], textarea");
            const host = editor?.closest("form, [class*='composer'], [class*='Composer'], [role='toolbar']") || editor?.parentElement;
            if (!host) return;
            if (getComputedStyle(host).position === "static") host.style.position = "relative";
            const badge = old || document.createElement("span");
            badge.dataset.whaleComposerUsage = "";
            badge.textContent = formatUsage(state.config.composerText, row.usage, state.config);
            const position = state.config.composerPosition || "above-right";
            const css = ["position:absolute", "z-index:3", "pointer-events:none", "font-size:12px", "line-height:20px", "padding:1px 7px", "border-radius:8px", "background:rgba(13,23,37,.92)", "color:#dcecff", "border:1px solid rgba(115,186,255,.45)", "white-space:nowrap"];
            css.push(position.includes("left") ? "left:8px" : "right:8px");
            css.push(position.startsWith("above") ? "bottom:calc(100% + 6px)" : "bottom:8px");
            badge.style.cssText = css.join(";");
            if (!old) host.appendChild(badge);
          } catch {}
        };
        const observer = new MutationObserver(sync);
        try { observer.observe(document.body, { childList: true, subtree: true }); } catch {}
        const timer = setInterval(sync, 3500); sync();
        return () => { stopped = true; observer.disconnect(); clearInterval(timer); document.querySelector("[data-whale-composer-usage]")?.remove(); };
      }, [ctx]);
      return null;
    }

    function MeterPanel() {
      const ctx = MeterPanel.ctx;
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [message, setMessage] = React.useState("正在读取本地记录…");
      const load = React.useCallback(async () => {
        try {
          await postSnapshots(ctx);
          const response = await fetch(URL, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const next = await response.json();
          setState(next); setDraft({ ...next.config }); setMessage("");
        } catch (error) { setMessage("费用服务暂不可用：" + String(error?.message || error)); }
      }, [ctx]);
      React.useEffect(() => {
        load();
        const sessions = access(ctx, "sessions");
        const sync = () => postSnapshots(ctx).then((next) => next && setState(next)).catch(() => {});
        let unsubscribe = null;
        try { unsubscribe = sessions?.list?.subscribe?.(sync) || null; } catch {}
        const timer = setInterval(sync, 5000);
        return () => { try { unsubscribe?.(); } catch {} clearInterval(timer); };
      }, [ctx, load]);
      const save = async (refreshPrice = false) => {
        try {
          setMessage(refreshPrice ? "正在读取 DeepSeek 官方价格…" : "正在保存…");
          const response = await fetch(URL, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: draft, refreshPrice }) });
          const next = await response.json();
          if (!response.ok) throw new Error(next.error || `HTTP ${response.status}`);
          setState(next); setDraft({ ...next.config }); setMessage("已保存到本地文件");
        } catch (error) { setMessage("保存失败：" + String(error?.message || error)); }
      };
      if (!state || !draft) return React.createElement("div", { className: "wm-page" }, message);
      const total = state.totalTokens || 0;
      const preview = formatUsage(draft.text, state.totals, draft);
      const field = (label, key, type = "text", step) => React.createElement("label", { className: "wm-field", key },
        React.createElement("span", null, label),
        React.createElement("input", { type, step, value: draft[key], onChange: (event) => setDraft({ ...draft, [key]: type === "number" ? Number(event.target.value) : event.target.value }) })
      );
      const rows = Object.values(state.sessions || {}).sort((a, b) => b.updatedAt - a.updatedAt);
      return React.createElement("div", { className: "wm-page" },
        React.createElement("style", null, `.wm-page{max-width:920px;padding:8px 4px 40px;color:#edf3ff}.wm-page h2,.wm-page h3,.wm-card b{color:#fff}.wm-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.wm-card,.wm-group{border:1px solid #536983;border-radius:14px;padding:16px;background:#151e2a}.wm-card b{display:block;font-size:24px;margin-top:8px}.wm-group{margin-top:14px}.wm-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.wm-field{display:flex;flex-direction:column;gap:5px;font-size:13px;color:#f2f6ff}.wm-field input,.wm-field select{padding:8px;border:1px solid #627996;border-radius:8px;background:#101722;color:#f7f9ff;color-scheme:dark}.wm-field select option{background:#101722;color:#f7f9ff}.wm-field input::placeholder{color:#afbed3;opacity:1}.wm-actions{display:flex;gap:8px;margin-top:12px}.wm-actions button{padding:8px 12px;border-radius:8px;border:1px solid #6f89a8;background:#1b2a3b;color:#fff;cursor:pointer}.wm-actions button:hover{background:#27415c}.wm-table{width:100%;border-collapse:collapse;color:#f1f6ff}.wm-table td,.wm-table th{text-align:left;padding:8px;border-bottom:1px solid #3f526a}.wm-muted{color:#c3d0e3;opacity:1;font-size:12px}@media(max-width:700px){.wm-cards,.wm-grid{grid-template-columns:1fr}}`),
        React.createElement("h2", null, "费用 / 用量"),
        React.createElement("p", { className: "wm-muted" }, "优先使用 DSH 服务端 tokenUsage；价格为估算值，实际账单以提供商为准。"),
        React.createElement("div", { className: "wm-cards" },
          React.createElement("div", { className: "wm-card" }, "累计 Token", React.createElement("b", null, total.toLocaleString())),
          React.createElement("div", { className: "wm-card" }, "估算费用", React.createElement("b", null, draft.currency + money(state.cost))),
          React.createElement("div", { className: "wm-card" }, "已记录会话", React.createElement("b", null, rows.length))
        ),
        React.createElement("section", { className: "wm-group" }, React.createElement("h3", null, "显示文案"), field("侧边栏/提示模板（支持 {tokens} {currency} {cost} {input} {output}）", "text"), React.createElement("p", null, preview), field("对话框当前会话模板", "composerText"), React.createElement("label", { className: "wm-field" }, React.createElement("span", null, "对话框提示位置"), React.createElement("select", { value: draft.composerPosition, onChange: (event) => setDraft({ ...draft, composerPosition: event.target.value }) }, React.createElement("option", { value: "above-right" }, "输入框上方右侧"), React.createElement("option", { value: "above-left" }, "输入框上方左侧"), React.createElement("option", { value: "inside-right" }, "输入框内右侧"), React.createElement("option", { value: "inside-left" }, "输入框内左侧"), React.createElement("option", { value: "hidden" }, "隐藏"))), React.createElement("p", { className: "wm-muted" }, "模板变量：{tokens} 总 Token；{cost} 估算金额；{currency} 货币；{input}/{output} 输入、输出 Token。")),
        React.createElement("section", { className: "wm-group" }, React.createElement("h3", null, "计费规则（USD / 1M token）"),
          React.createElement("div", { className: "wm-grid" }, field("缓存命中输入", "cacheHit", "number", "0.000001"), field("缓存未命中输入", "cacheMiss", "number", "0.000001"), field("输出", "output", "number", "0.000001"), field("美元换算系数", "usdToCurrency", "number", "0.01"), field("显示货币", "currency"), field("模型", "model")),
          React.createElement("label", { className: "wm-field" }, React.createElement("span", null, "每日自动跟随官方价格"), React.createElement("input", { type: "checkbox", checked: draft.autoUpdatePrice, onChange: (event) => setDraft({ ...draft, autoUpdatePrice: event.target.checked }) })),
          React.createElement("div", { className: "wm-actions" }, React.createElement("button", { onClick: () => save(false) }, "保存"), React.createElement("button", { onClick: () => save(true) }, "立即更新官方价格")),
          React.createElement("p", { className: "wm-muted" }, message || `价格来源：${state.pricing?.source || "内置"} · ${state.pricing?.error ? "上次更新失败：" + state.pricing.error : "正常"}`),
          React.createElement("p", { className: "wm-muted" }, "本地文件：" + state.dataPath)
        ),
        React.createElement("section", { className: "wm-group" }, React.createElement("h3", null, "按会话"),
          React.createElement("table", { className: "wm-table" }, React.createElement("thead", null, React.createElement("tr", null, React.createElement("th", null, "会话"), React.createElement("th", null, "Token"), React.createElement("th", null, "估算费用"))),
            React.createElement("tbody", null, rows.map((row) => React.createElement("tr", { key: row.id }, React.createElement("td", null, row.title), React.createElement("td", null, tokens(row.usage).toLocaleString()), React.createElement("td", null, draft.currency + money((row.usage.uncachedInputTokens * draft.cacheMiss + row.usage.cacheReadTokens * draft.cacheHit + row.usage.cacheWriteTokens * draft.cacheMiss + row.usage.outputTokens * draft.output) / 1e6 * draft.usdToCurrency))))))
        )
      );
    }

    function apply(ctx) {
      MeterPanel.ctx = ctx;
      SidebarTokenLabels.ctx = ctx;
      ComposerUsageLabel.ctx = ctx;
      try {
        ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "whale-meter", order: 60, label: "费用 / 用量" }, MeterPanel));
      } catch (error) {
        console.warn("[whale-meter] settings section unavailable", error);
      }
      try {
        ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "whale-session-tokens", order: 60 }, SidebarTokenLabels));
      } catch (error) {
        console.warn("[whale-meter] sidebar token labels unavailable", error);
      }
      try {
        ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "whale-composer-usage", order: 61 }, ComposerUsageLabel));
      } catch (error) {
        console.warn("[whale-meter] composer usage label unavailable", error);
      }
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    exports.default = { apply, inject, name };
    return module.exports;
  }
});

/**
 * dsh-soul-md — browser half.
 *
 * Settings section (人设卡): a simple persona-card manager — type a card
 * name and content, save, and the plugin handles the rest. Plus a per-session
 * persona switcher in the conversation header
 * (`conversation.session.header.actions`).
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
      ".__sm_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__sm_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__sm_textarea{min-height:160px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6}" +
      ".__sm_row{display:flex;align-items:center;gap:8px}" +
      ".__sm_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__sm_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__sm_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__sm_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__sm_btn:disabled{opacity:.5;cursor:default}" +
      ".__sm_btnPrimary{border-color:var(--dsw-alias-state-business-primary, #3964fe);background:var(--dsw-alias-state-business-primary, #3964fe);color:#fff}" +
      ".__sm_btnDanger{border-color:var(--dsw-alias-state-error-primary, #f85149);color:var(--dsw-alias-state-error-primary, #f85149)}" +
      ".__sm_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__sm_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__sm_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}" +
      ".__sm_group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
      ".__sm_cardList{display:flex;flex-direction:column;gap:6px}" +
      ".__sm_cardRow{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px}" +
      ".__sm_cardName{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".__sm_cardPreview{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".__sm_badge{border:1px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);border-radius:999px;padding:0 8px;font-size:10px;white-space:nowrap}" +
      ".__sm_switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;margin-right:8px}" +
      ".__sm_switchLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap}" +
      ".__sm_switchSelect{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:3px 6px;font:inherit;font-size:12px;max-width:180px}";
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
      intro: "输入人设卡名称和内容，保存后插件自动管理——文件路径、记忆存放都不用管。人设按 会话选择 → 默认卡 解析，聊天框标题栏可随时切换。",
      cardListTitle: "人设卡",
      cardListHint: "卡片内容会注入系统提示词；聊天框标题栏可给每个会话单独选卡。",
      cardName: "人设卡名称",
      cardNameHint: "给这张人设卡起个名字（如：希希芙、工作狂助手）。",
      cardContent: "人设卡内容（Markdown）",
      cardContentHint: "角色设定、说话风格、工作准则……AI 会用 soul_read / soul_update 自己读和演化这张卡。",
      saveCard: "保存人设卡",
      save: "保存",
      editCard: "编辑",
      deleteCard: "删除",
      setDefault: "设为默认",
      defaultBadge: "默认",
      emptyCards: "还没有人设卡——先在上面保存一张吧。",
      noActive: "（未设置默认卡，人设未启用）",
      activeHint: "没有会话级选择时使用的人设卡；选「不启用」则默认关闭人设。",
      noneOption: "不启用",
      autoOption: "自动（跟随默认卡）",
      saved: "已保存",
      saving: "保存中…",
      error: "操作失败",
      unavailable: "设置命名空间不可用（服务端未注册 soul-md 命名空间？）",
      loading: "加载中…",
      memoryTitle: "长期记忆（插件托管）",
      memoryIntro: "AI 用 memory_append / memory_read / memory_rewrite 读写记忆：当前人设卡有自己的记忆，没选卡时用全局记忆。记忆文件由插件自动管理。",
      memoryInjectHint: "把记忆渲染为 soul:memory 提示词段落（AI 可随时读到记忆）。",
      memoryMaxCharsHint: "注入段落的字符上限（超出的部分用 memory_read 读取全文）。",
      memoryMaxBytesHint: "单份记忆文件大小上限。",
      switchLabel: "人设",
      switchTitle: "切换当前会话的人设（会话级，优先于工作区/默认卡）",
      wsTitle: "工作区人设",
      wsHint: "给每个工作区指定人设卡：该工作区的会话默认使用这张卡（会话级切换仍然优先）。",
      wsFollow: "跟随默认卡",
      wsEmpty: "还没有工作区记录——在会话页新建/选择一个工作区后，这里会出现它的设置。",
      wsName: "工作区",
      fieldMemoryInject: "注入为 soul:memory 提示词段落",
      fieldMemoryInjectMaxChars: "注入字符上限",
      fieldMemoryMaxBytes: "记忆文件大小上限",
      cardNamePlaceholder: "希希芙"
    };
    var en = {
      nav: "Persona Card",
      intro: "Type a persona card name and content, hit save — the plugin manages everything else (files, memory locations). Persona resolves as session choice > default card; switch per chat from the conversation header.",
      cardListTitle: "Persona cards",
      cardListHint: "Card content is injected into the system prompt; pick one per chat from the conversation header.",
      cardName: "Card name",
      cardNameHint: "A name for this card (e.g. 希希芙, workaholic-assistant).",
      cardContent: "Card content (Markdown)",
      cardContentHint: "Role, speaking style, work rules… the AI reads and evolves this card itself via soul_read / soul_update.",
      saveCard: "Save card",
      save: "Save",
      editCard: "Edit",
      deleteCard: "Delete",
      setDefault: "Set default",
      defaultBadge: "default",
      emptyCards: "No persona cards yet — save one above first.",
      noActive: "(no default card; persona disabled)",
      activeHint: "The card used when a session has no explicit choice; pick \"disabled\" to turn the persona off by default.",
      noneOption: "Disabled",
      autoOption: "Auto (follow default)",
      saved: "Saved",
      saving: "Saving…",
      error: "Operation failed",
      unavailable: "Settings namespace unavailable (soul-md namespace not registered server-side?)",
      loading: "Loading…",
      memoryTitle: "Long-term memory (plugin-managed)",
      memoryIntro: "The AI reads/writes memory with memory_append / memory_read / memory_rewrite: the active persona card has its own memory, otherwise the global memory is used. Files are managed by the plugin.",
      memoryInjectHint: "Also render the memory as the soul:memory prompt section (the agent always sees its memory).",
      memoryMaxCharsHint: "Cap for the injected section (chars); use memory_read for the full text.",
      memoryMaxBytesHint: "Max size of one memory file.",
      switchLabel: "Persona",
      switchTitle: "Switch this session's persona (session-level, overrides workspace/default)",
      wsTitle: "Workspace personas",
      wsHint: "Assign a persona card per workspace: sessions of that workspace use it by default (session-level switching still wins).",
      wsFollow: "Follow default",
      wsEmpty: "No workspace records yet — create/select a workspace in the session page and its setting appears here.",
      wsName: "Workspace",
      fieldMemoryInject: "Inject as soul:memory prompt section",
      fieldMemoryInjectMaxChars: "Inject char cap",
      fieldMemoryMaxBytes: "Memory file size cap",
      cardNamePlaceholder: "Xixifu"
    };

    var MEMORY_FIELDS = [
      { key: "inject", label: "fieldMemoryInject", type: "checkbox", hint: "memoryInjectHint" },
      { key: "injectMaxChars", label: "fieldMemoryInjectMaxChars", type: "number", hint: "memoryMaxCharsHint" },
      { key: "maxBytes", label: "fieldMemoryMaxBytes", type: "number", hint: "memoryMaxBytesHint" }
    ];
    var MEMORY_DEFAULTS = { inject: true, injectMaxChars: 8000, maxBytes: 1048576 };

    function SoulSection(props) {
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [cardDraft, setCardDraft] = react.useState({ name: "", content: "" });
      var [memDraft, setMemDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);

      react.useEffect(function () {
        if (typeof scope.load === "function") scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        // The settings scope is bound once for this plugin and shared across
        // every mount of the section. Unmounting must only unsubscribe — never
        // dispose the scope, or a later remount finds a `disposed` scope whose
        // write queue no-ops, silently dropping saves.
        return function () { alive = false; if (un) un(); };
      }, [scope]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__sm_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__sm_status" }, t("loading"));

      var value = snapshot.value;
      var cards = value.cards && typeof value.cards === "object" ? value.cards : {};
      var cardNames = Object.keys(cards).sort();
      var active = typeof value.active === "string" ? value.active : "";
      var wsList = Array.isArray(value.workspaceList) ? value.workspaceList : [];
      var wsMap = value.workspaces && typeof value.workspaces === "object" ? value.workspaces : {};

      function onWsChange(path, v) {
        var next = Object.assign({}, wsMap);
        if (v === "") delete next[path];
        else next[path] = v;
        setBusy(true); setNotice0();
        scope.set("workspaces", next).then(function () {
          setBusy(false); setNotice(t("saved"));
          if (typeof scope.load === "function") scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function setNotice0() { setNotice(null); setError(null); }

      function onSaveCard() {
        var name = String(cardDraft.name || "").trim();
        var content = String(cardDraft.content || "");
        if (!name) { setError(t("error") + ": name"); return; }
        if (!content.trim()) { setError(t("error") + ": content"); return; }
        setBusy(true); setNotice0();
        var next = Object.assign({}, cards);
        next[name] = content;
        scope.set("cards", next).then(function () {
          setBusy(false); setNotice(t("saved"));
          setCardDraft({ name: "", content: "" });
          if (typeof scope.load === "function") scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function onEditCard(name) {
        setCardDraft({ name: name, content: cards[name] || "" });
        setNotice0();
      }

      function onDeleteCard(name) {
        if (!window.confirm("Delete persona card \"" + name + "\"?")) return;
        setBusy(true); setNotice0();
        var next = Object.assign({}, cards);
        delete next[name];
        var p1 = scope.set("cards", next);
        var p2 = name === active ? scope.unset("active") : Promise.resolve();
        Promise.all([p1, p2]).then(function () {
          setBusy(false); setNotice(t("saved"));
          if (typeof scope.load === "function") scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function onSetActive(name) {
        setBusy(true); setNotice0();
        scope.set("active", name).then(function () {
          setBusy(false); setNotice(t("saved"));
          if (typeof scope.load === "function") scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function memDraftValue(f) {
        var m = memDraft[f.key];
        if (f.type === "checkbox") return m !== void 0 ? m : Boolean(value.memory?.[f.key] ?? MEMORY_DEFAULTS[f.key]);
        return m !== void 0 ? m : String(value.memory?.[f.key] ?? MEMORY_DEFAULTS[f.key]);
      }
      function setMemField(f, v) {
        setMemDraft(function (prev) { var next = Object.assign({}, prev); next[f.key] = v; return next; });
        setNotice0();
      }
      function memNext() {
        var out = {};
        MEMORY_FIELDS.forEach(function (f) {
          var cur = memDraftValue(f);
          out[f.key] = f.type === "checkbox" ? Boolean(cur) : Number(cur);
        });
        return out;
      }
      function memBase() {
        var out = {};
        MEMORY_FIELDS.forEach(function (f) {
          var cur = value.memory?.[f.key] ?? MEMORY_DEFAULTS[f.key];
          out[f.key] = f.type === "checkbox" ? Boolean(cur) : Number(cur);
        });
        return out;
      }
      function onSaveMemory() {
        setBusy(true); setNotice0();
        var next = memNext();
        var base = memBase();
        var p = JSON.stringify(next) === JSON.stringify(base)
          ? Promise.resolve()
          : scope.set("memory", next);
        p.then(function () {
          setBusy(false); setNotice(t("saved"));
          if (typeof scope.load === "function") scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      return h("div", { className: "__sm_root" },
        h("p", { className: "__sm_hint", style: { margin: "0 0 4px" } }, t("intro")),

        // ── card form ────────────────────────────────────────────────────
        h("div", { className: "__sm_group" },
          h("label", { className: "__sm_field" },
            h("span", { className: "__sm_label" }, t("cardName")),
            h("span", { className: "__sm_hint" }, t("cardNameHint")),
            h("input", { className: "__sm_input", type: "text", value: cardDraft.name, placeholder: t("cardNamePlaceholder"), onChange: function (e) { setCardDraft(function (p) { return Object.assign({}, p, { name: e.target.value }); }); setNotice0(); } })
          ),
          h("label", { className: "__sm_field" },
            h("span", { className: "__sm_label" }, t("cardContent")),
            h("span", { className: "__sm_hint" }, t("cardContentHint")),
            h("textarea", { className: "__sm_input __sm_textarea", value: cardDraft.content, onChange: function (e) { setCardDraft(function (p) { return Object.assign({}, p, { content: e.target.value }); }); setNotice0(); } })
          ),
          h("div", { className: "__sm_actions" },
            h("button", { type: "button", className: "__sm_btn __sm_btnPrimary", onClick: onSaveCard, disabled: busy }, t("saveCard")),
            notice ? h("span", { className: "__sm_status" }, notice) : null,
            busy ? h("span", { className: "__sm_status" }, t("saving")) : null,
            error ? h("span", { className: "__sm_error" }, error) : null
          )
        ),

        // ── card list + default picker ───────────────────────────────────
        h("div", { className: "__sm_group" },
          h("p", { className: "__sm_label", style: { margin: 0 } }, t("cardListTitle")),
          h("p", { className: "__sm_hint", style: { margin: "0 0 2px" } }, t("cardListHint")),
          h("label", { className: "__sm_field" },
            h("span", { className: "__sm_label" }, t("defaultBadge")),
            h("span", { className: "__sm_hint" }, t("activeHint")),
            h("select", { className: "__sm_input", value: active || "", onChange: function (e) { var v = e.target.value; if (!v) scope.unset("active"); else onSetActive(v); } },
              h("option", { value: "" }, t("noneOption")),
              cardNames.map(function (n) { return h("option", { key: n, value: n }, n); })
            )
          ),
          cardNames.length === 0
            ? h("p", { className: "__sm_hint" }, t("emptyCards"))
            : h("div", { className: "__sm_cardList" },
                cardNames.map(function (n) {
                  var preview = String(cards[n] || "").split("\n").filter(Boolean)[0] || "";
                  return h("div", { key: n, className: "__sm_cardRow" },
                    h("span", { className: "__sm_cardName", title: n }, n),
                    n === active ? h("span", { className: "__sm_badge" }, t("defaultBadge")) : null,
                    h("span", { className: "__sm_cardPreview" }, preview),
                    h("button", { type: "button", className: "__sm_btn", onClick: function () { onEditCard(n); }, disabled: busy }, t("editCard")),
                    n === active ? null : h("button", { type: "button", className: "__sm_btn", onClick: function () { onSetActive(n); }, disabled: busy }, t("setDefault")),
                    h("button", { type: "button", className: "__sm_btn __sm_btnDanger", onClick: function () { onDeleteCard(n); }, disabled: busy }, t("deleteCard"))
                  );
                })
              )
        ),

        // ── per-workspace persona mapping ────────────────────────────────
        h("div", { className: "__sm_group" },
          h("p", { className: "__sm_label", style: { margin: 0 } }, t("wsTitle")),
          h("p", { className: "__sm_hint", style: { margin: "0 0 2px" } }, t("wsHint")),
          wsList.length === 0
            ? h("p", { className: "__sm_hint" }, t("wsEmpty"))
            : h("div", { className: "__sm_cardList" },
                wsList.map(function (ws) {
                  var current = wsMap[ws.path] || "";
                  if (current && current !== "none" && !(current in cards)) current = "";
                  return h("label", { key: ws.path, className: "__sm_field" },
                    h("span", { className: "__sm_label", title: ws.path }, (ws.title || ws.path)),
                    h("select", { className: "__sm_input", value: current, onChange: function (e) { onWsChange(ws.path, e.target.value); } },
                      h("option", { value: "" }, t("wsFollow")),
                      h("option", { value: "none" }, t("noneOption")),
                      cardNames.map(function (n) { return h("option", { key: n, value: n }, n); })
                    )
                  );
                })
              )
        ),

        // ── memory (plugin-managed) ──────────────────────────────────────
        h("div", { className: "__sm_group" },
          h("p", { className: "__sm_label", style: { margin: 0 } }, t("memoryTitle")),
          h("p", { className: "__sm_hint", style: { margin: "0 0 2px" } }, t("memoryIntro")),
          MEMORY_FIELDS.map(function (f) {
            if (f.type === "checkbox") {
              return h("label", { key: f.key, className: "__sm_field" },
                h("span", { className: "__sm_row" },
                  h("input", { className: "__sm_check", type: "checkbox", checked: Boolean(memDraftValue(f)), onChange: function (e) { setMemField(f, e.target.checked); } }),
                  h("span", { className: "__sm_label" }, t(f.label))
                ),
                f.hint ? h("span", { className: "__sm_hint" }, t(f.hint)) : null
              );
            }
            return h("label", { key: f.key, className: "__sm_field" },
              h("span", { className: "__sm_label" }, t(f.label)),
              h("input", { className: "__sm_input", type: "number", value: memDraftValue(f), onChange: function (e) { setMemField(f, e.target.value); } }),
              f.hint ? h("span", { className: "__sm_hint" }, t(f.hint)) : null
            );
          }),
          h("div", { className: "__sm_actions" },
            h("button", { type: "button", className: "__sm_btn __sm_btnPrimary", onClick: onSaveMemory, disabled: busy }, t("save")),
            notice ? h("span", { className: "__sm_status" }, notice) : null,
            busy ? h("span", { className: "__sm_status" }, t("saving")) : null,
            error ? h("span", { className: "__sm_error" }, error) : null
          )
        )
      );
    }

    // ── per-session persona switcher (conversation header) ──────────────────
    function PersonaSwitcher(props) {
      var t = props.t;
      var scope = props.scope;
      var sessionId = props.sessionId;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      react.useEffect(function () {
        if (typeof scope.load === "function") scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        // The settings scope is bound once for this plugin and shared across
        // every mount of the section. Unmounting must only unsubscribe — never
        // dispose the scope, or a later remount finds a `disposed` scope whose
        // write queue no-ops, silently dropping saves.
        return function () { alive = false; if (un) un(); };
      }, [scope]);
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      if (!ready || !sessionId) return null;
      var value = snapshot.value;
      var cards = value.cards && typeof value.cards === "object" ? value.cards : {};
      var sessions = value.sessions && typeof value.sessions === "object" ? value.sessions : {};
      var choice = sessions[sessionId] || "";
      if (choice && choice !== "none" && !(choice in cards)) choice = "";
      var cardNames = Object.keys(cards).sort();
      function onChange(e) {
        var v = e.target.value;
        var next = Object.assign({}, sessions);
        if (v === "") delete next[sessionId];
        else next[sessionId] = v;
        scope.set("sessions", next).then(function () {
          if (typeof scope.load === "function") scope.load();
        }).catch(function () {});
      }
      return h("label", { className: "__sm_switch", title: t("switchTitle") },
        h("span", { className: "__sm_switchLabel" }, t("switchLabel")),
        h("select", { className: "__sm_switchSelect", value: choice, onChange: onChange },
          h("option", { value: "" }, t("autoOption")),
          h("option", { value: "none" }, t("noneOption")),
          cardNames.map(function (n) {
            return h("option", { key: n, value: n }, n);
          })
        )
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-soul-md: dictionaries");
      var sectionScope = ctx.settingsScope.bind({ namespace: "soul-md" });
      var switchScope = ctx.settingsScope.bind({ namespace: "soul-md" });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "soul-md",
          order: 24,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(SoulSection, Object.assign({}, props, { scope: sectionScope }));
        });
      });
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "soul-md-persona",
          order: 40
        }, function (props) {
          return h(PersonaSwitcher, Object.assign({}, props, { scope: switchScope, t: t }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});


/**
 * dsh-feature-toggles — Web settings card (client half).
 *
 * Registers a 「增强功能 / Features」 section in the DSH Web settings page
 * (order 7 — 普通组、开设置即见，不藏进「高级」折叠). 卡片为默认关闭的
 * 内置插件提供一键启用/停用开关，走 window.dshDesktop.pluginManager 桥
 * （写 profile cordis.patch.yml，与「设置 → 插件 → 管理」同一语义，
 * 重启应用后生效）。
 *
 * 当前卡片：
 *   - 余额小鲸鱼（dsh-whale-widget）：右下角常驻 DeepSeek 余额挂件
 *   - AgentTeams（dsh-agent-teams）：多智能体团队协作
 *
 * Hand-written ModuleLoader bundle — no build step (same shape as dsh-phone).
 */
window.__ModuleLoader__.load({
  id: "dsh-feature-toggles",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    var CARD = {
      listStyle: "none",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 12,
      padding: 14,
      background: "var(--dsw-alias-bg-layer-2, transparent)",
      display: "grid",
      gap: 10,
    };
    var ROW = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 };
    var TOGGLE = { width: 16, height: 16, accentColor: "var(--dsw-alias-state-business-primary)" };
    var BTN = {
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
      borderRadius: 8,
      padding: "4px 10px",
      font: "inherit",
      fontSize: 12,
      cursor: "pointer",
    };

    function Field(props) {
      return h("label", { style: ROW },
        h("span", null,
          h("span", { style: { display: "block", fontWeight: 600, fontSize: 13 } }, props.label),
          props.hint ? h("small", { style: { display: "block", opacity: 0.65, marginTop: 3, lineHeight: 1.5 } }, props.hint) : null,
        ),
        props.children,
      );
    }

    function Status(props) {
      if (!props.text) return null;
      var color = props.kind === "ok" ? "#7fd6a0" : props.kind === "err" ? "#e5484d" : "var(--dsw-alias-label-tertiary)";
      return h("div", { role: "status", style: { fontSize: 12, color: color, opacity: 0.9 } }, props.text);
    }

    function pluginRowsFrom(result) {
      if (Array.isArray(result)) return result;
      if (Array.isArray(result && result.rows)) return result.rows;
      if (Array.isArray(result && result.entries)) return result.entries;
      return [];
    }

    function pluginRow(rows, id) {
      return rows.find((item) => item && (item.id === id || item.entryId === id)) || null;
    }

    /**
     * 通用开关卡片：标题 + 描述 + 启用/停用 + 重启提示。
     * @param {{id:string, title:string, desc:string, restart?:boolean}} spec
     */
    function ToggleCard(spec) {
      var [state, setState] = useState({ loaded: false, enabled: false, busy: false, pending: null, notice: null, err: null, restarting: false });

      useEffect(function () {
        var active = true;
        var b = window.dshDesktop && window.dshDesktop.pluginManager;
        if (!b) {
          if (active) setState(function (s) { return Object.assign({}, s, { loaded: true, err: "插件管理桥不可用（请在 Tauri 桌面壳中使用）" }); });
          return;
        }
        b.list().then(function (res) {
          if (!active) return;
          var row = pluginRow(pluginRowsFrom(res), spec.id);
          setState(function (s) { return Object.assign({}, s, { loaded: true, enabled: !!(row && row.enabled), err: null }); });
        }).catch(function (err) {
          if (active) setState(function (s) { return Object.assign({}, s, { loaded: true, err: "读取状态失败: " + String((err && err.message) || err) }); });
        });
        return function () { active = false; };
      }, []);

      function toggle(enabled) {
        var b = window.dshDesktop && window.dshDesktop.pluginManager;
        if (!b || state.busy) return;
        setState(function (s) { return Object.assign({}, s, { busy: true, pending: enabled, notice: null, err: null }); });
        b.setEnabled(spec.id, enabled).then(function (res) {
          setState(function (s) {
            return Object.assign({}, s, {
              busy: false,
              pending: null,
              enabled: res && res.ok ? enabled : s.enabled,
              notice: res && res.ok ? (enabled ? "已启用：重启应用后生效" : "已停用：重启应用后生效") : null,
              err: res && !res.ok ? String(res.error || "操作失败") : null,
            });
          });
        }).catch(function (err) {
          setState(function (s) { return Object.assign({}, s, { busy: false, pending: null, err: String((err && err.message) || err) }); });
        });
      }

      function restart() {
        var b = window.dshDesktop;
        if (!b || !b.restartService || state.restarting) return;
        setState(function (s) { return Object.assign({}, s, { restarting: true }); });
        b.restartService().catch(function () {}).finally(function () {
          setState(function (s) { return Object.assign({}, s, { restarting: false }); });
        });
      }

      var shown = state.pending !== null ? state.pending : state.enabled;
      return h("li", { style: CARD, "data-testid": "dsh-feature-toggle-" + spec.id },
        h("div", null,
          h("strong", { style: { fontSize: 15 } }, spec.title),
          h("p", { style: { margin: "5px 0 0", opacity: 0.72, lineHeight: 1.6, fontSize: 12 } }, spec.desc),
        ),
        !state.loaded && !state.err
          ? h("span", { style: { fontSize: 12 }, role: "status" }, "正在读取状态…")
          : h(Field, { label: "启用" + spec.title, hint: "默认关闭；开启后写入插件配置，重启应用生效。可随时在此或「插件 → 管理」停用。" },
              h("input", {
                type: "checkbox",
                style: TOGGLE,
                checked: shown,
                disabled: state.busy,
                onChange: function (e) { toggle(e.target.checked); },
              }),
            ),
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h(Status, { kind: state.err ? "err" : "ok", text: state.err || state.notice }),
          spec.restart !== false && state.notice
            ? h("button", { type: "button", style: BTN, disabled: state.restarting, onClick: restart },
                state.restarting ? "重启中…" : "重启 Web 服务立即生效")
            : null,
        ),
      );
    }

    function FeaturesSection() {
      return h("ul", { style: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 } },
        h(ToggleCard, {
          id: "dsh-whale-widget",
          title: "余额小鲸鱼",
          desc: "DSH 界面右下角的 DeepSeek 余额挂件：余额 / 今日已用 / 每轮对话消耗统计（依赖 DEEPSEEK_API_KEY 凭据）。",
        }),
        h(ToggleCard, {
          id: "agent-teams",
          title: "AgentTeams 多智能体团队",
          desc: "把一个会话变成「队长 + 子代理成员 + 依赖感知任务 DAG + 成员直发消息」的协作团队；启用后在对话里使用 /agent-teams。",
        }),
      );
    }

/**
 * 设置侧边栏独立分区：「余额」——余额小鲸鱼挂件开关 + 用法说明。
 * 与「增强功能」分区复用同一张 ToggleCard（同一写入语义）。
 */
function BleSection() {
  return h("div", { style: { display: "grid", gap: 12, alignItems: "start" } },
    h("ul", { style: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 } },
      h(ToggleCard, {
        id: "dsh-whale-widget",
        title: "余额小鲸鱼",
        desc: "DSH 界面右下角的 DeepSeek 余额挂件：余额 / 今日已用 / 每轮对话消耗统计（依赖 DEEPSEEK_API_KEY 凭据）。",
      }),
    ),
    h("p", { style: { margin: 0, opacity: 0.72, lineHeight: 1.6, fontSize: 12 } },
      "开启并重启后，小鲸鱼余额挂件固定显示在会话页面右下角（图标+余额/今日已用）；随时可回本分区或「插件 → 管理」停用。"),
  );
}

/**
 * 设置侧边栏独立分区：「多智能体协作团队」——AgentTeams 开关 + 用法说明。
 */
function TeamsSection() {
  return h("div", { style: { display: "grid", gap: 12, alignItems: "start" } },
    h("ul", { style: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 } },
      h(ToggleCard, {
        id: "agent-teams",
        title: "AgentTeams 多智能体团队",
        desc: "把一个会话变成「队长 + 子代理成员 + 依赖感知任务 DAG + 成员直发消息」的协作团队；启用后在对话里使用 /agent-teams。",
      }),
    ),
    h("p", { style: { margin: 0, opacity: 0.72, lineHeight: 1.6, fontSize: 12 } },
      "启用并重启后，在对话输入框输入 /agent-teams 打开团队面板：安排子代理成员、分配依赖感知的任务 DAG、成员之间直发消息；不需要时同样可以在此停用。"),
  );
}

function apply(ctx) {
  ctx.slots.inject("settings.section", function () {
    return ctx.slots.register({
      name: "settings.section",
      id: "dsh-feature-toggles",
      order: 7,
      label: function () { return "增强功能"; },
    }, FeaturesSection);
  });
  ctx.slots.inject("settings.section", function () {
    return ctx.slots.register({
      name: "settings.section",
      id: "dsh-balance",
      order: 7.1,
      label: function () { return "余额"; },
    }, BleSection);
  });
  ctx.slots.inject("settings.section", function () {
    return ctx.slots.register({
      name: "settings.section",
      id: "dsh-agent-teams",
      order: 7.2,
      label: function () { return "多智能体协作团队"; },
    }, TeamsSection);
  });
}

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
/**
 * dsh-font-custom — browser half: 字体与颜色自定义 settings section.
 *
 *   - 字体家族：界面字体 / 代码字体（下拉 + 自定义输入）
 *   - 字号：界面字号 / 代码字号 / 聊天正文字号（px，滑杆）
 *   - 颜色：主文字 / 次要文字 / 强调色（取色器，十六进制）
 *   - 实时预览；「恢复默认」一键还原；localStorage 持久化（稳定端口下
 *     origin 不变，重启后仍生效）
 *
 * 实现走 dsw 主题变量（--dsw-font-family / --dsw-alias-label-* 等，皮肤
 * 同一套变量体系）+ 对聊天消息行（[data-chat-flow-kind]）与代码块
 * （pre/code）的直接规则；样式标签挂在 document.head 末尾以赢得同特异性
 * 下的优先级。为避免皮肤切换/热重载把标签挤掉，用 MutationObserver 兜底
 * 重新 append。
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-font-custom",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    var STORE_KEY = "dsh-font-custom-config-v1";
    var STYLE_ID = "dsh-font-custom-overrides";

    var DEFAULTS = {
      uiFont: "",
      codeFont: "",
      uiSize: 14,
      codeSize: 13,
      chatSize: 15,
      primaryColor: "",
      secondaryColor: "",
      accentColor: "",
      // 余额 / 高峰提醒 widget 样式（V4）：文字颜色 + 流光（扫光动画）。
      widgetColor: "",
      widgetGlow: false,
      widgetGlowColor: ""
    };

    var FONT_PRESETS = [
      { id: "", label: "默认（跟随主题）" },
      { id: '"Segoe UI","Microsoft YaHei",system-ui,sans-serif', label: "Segoe UI + 微软雅黑" },
      { id: '"Microsoft YaHei","PingFang SC",system-ui,sans-serif', label: "微软雅黑" },
      { id: '"SimSun","Songti SC",serif', label: "宋体（衬线）" },
      { id: '"KaiTi","Kaiti SC",serif', label: "楷体" },
      { id: '"DengXian","LiXian",sans-serif', label: "等线" },
      { id: '"Source Han Sans SC","Noto Sans CJK SC",sans-serif', label: "思源黑体" },
      { id: "system-ui,sans-serif", label: "系统 UI" },
      { id: "custom", label: "自定义…" }
    ];
    var CODE_PRESETS = [
      { id: "", label: "默认（跟随主题）" },
      { id: '"Cascadia Code",Consolas,monospace', label: "Cascadia Code" },
      { id: "Consolas,monospace", label: "Consolas" },
      { id: '"JetBrains Mono","Fira Code",monospace', label: "JetBrains Mono / Fira Code" },
      { id: '"Sarasa Mono SC","Noto Sans Mono CJK SC",monospace', label: "更纱等宽（中英对齐）" },
      { id: "custom", label: "自定义…" }
    ];

    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

    // 只允许字体栈里的安全字符：字母数字、空格、引号、逗号、连字符、点。
    function safeFontStack(s) {
      var v = String(s || "").replace(/[\u0000-\u001f]/g, "").replace(/[{}<>]/g, "").trim();
      return v.slice(0, 200);
    }
    function safeColor(s) {
      var v = String(s || "").trim();
      return /^#[0-9a-fA-F]{3,8}$/.test(v) || /^(rgb|rgba|hsl|hsla)\([\d\s.,%]+\)$/i.test(v) ? v.slice(0, 40) : "";
    }
    function clampSize(v, lo, hi, dflt) {
      var n = Number(v);
      if (!Number.isFinite(n)) return dflt;
      return Math.min(hi, Math.max(lo, Math.round(n)));
    }

    function sanitize(cfg) {
      var c = cfg && typeof cfg === "object" ? cfg : {};
      return {
        uiFont: safeFontStack(c.uiFont),
        codeFont: safeFontStack(c.codeFont),
        uiSize: clampSize(c.uiSize, 11, 22, DEFAULTS.uiSize),
        codeSize: clampSize(c.codeSize, 10, 20, DEFAULTS.codeSize),
        chatSize: clampSize(c.chatSize, 11, 24, DEFAULTS.chatSize),
        primaryColor: safeColor(c.primaryColor),
        secondaryColor: safeColor(c.secondaryColor),
        accentColor: safeColor(c.accentColor),
        widgetColor: safeColor(c.widgetColor),
        widgetGlow: c.widgetGlow === true,
        widgetGlowColor: safeColor(c.widgetGlowColor)
      };
    }

    function buildCss(cfg) {
      var css = "";
      if (cfg.uiFont) css += ":root{--dsw-font-family:" + cfg.uiFont + ";--ds-font-family:" + cfg.uiFont + "}";
      if (cfg.codeFont) css += ":root{--ds-font-family-code:" + cfg.codeFont + ";--dsw-alias-font-mono:" + cfg.codeFont + "}";
      if (cfg.primaryColor) css += ":root{--dsw-alias-label-primary:" + cfg.primaryColor + "!important}";
      if (cfg.secondaryColor) css += ":root{--dsw-alias-label-secondary:" + cfg.secondaryColor + ";--dsw-alias-label-tertiary:" + cfg.secondaryColor + "}";
      if (cfg.accentColor) css += ":root{--dsw-alias-state-business-primary:" + cfg.accentColor + "}";
      // 字号仅在偏离默认时输出（默认值输出等于无操作，徒增覆盖面）。
      if (cfg.uiSize && cfg.uiSize !== DEFAULTS.uiSize) css += "body{font-size:" + cfg.uiSize + "px}";
      if (cfg.chatSize && cfg.chatSize !== DEFAULTS.chatSize) css += "[data-chat-flow-kind]{font-size:" + cfg.chatSize + "px}";
      if (cfg.codeSize && cfg.codeSize !== DEFAULTS.codeSize) css += "pre,code,kbd,samp{font-size:" + cfg.codeSize + "px}";
      // 余额 / 高峰提醒 widget 主题（V4）：变量 + 流光动画。变量未设置时
      // dsh-balance / dsh-offpeak 各自回退原默认色，零视觉变化。
      if (cfg.widgetColor) css += ":root{--eac-widget-fg:" + cfg.widgetColor + "}";
      if (cfg.widgetGlowColor) css += ":root{--eac-widget-glow:" + cfg.widgetGlowColor + "}";
      if (cfg.widgetGlow) {
        css += "@keyframes eacWidgetSweep{0%{background-position:220% 0}100%{background-position:-120% 0}}" +
          // 余额徽章：扫光掠过徽章背景（文本色不变，峰/谷徽章语义色保留）。
          "body[data-eac-widget-glow=\"1\"] .dsh-balance-dock{" +
          "background-image:linear-gradient(110deg,transparent 38%,var(--eac-widget-glow,#ffd76b) 50%,transparent 62%);" +
          "background-size:200% 100%;background-repeat:no-repeat;animation:eacWidgetSweep 2.6s linear infinite}" +
          // 高峰提醒弹窗标题：文字流光（currentColor → 流光色 → currentColor）。
          "body[data-eac-widget-glow=\"1\"] .dspg_title," +
          "body[data-eac-widget-glow=\"1\"] .__fc_wmock_title{" +
          "background-image:linear-gradient(110deg,currentColor 40%,var(--eac-widget-glow,#ffd76b) 50%,currentColor 60%);" +
          "background-size:200% 100%;-webkit-background-clip:text;background-clip:text;" +
          "-webkit-text-fill-color:transparent;animation:eacWidgetSweep 2.6s linear infinite}";
      }
      // 文字颜色覆盖（无 !important 不足以越过 dsh-offpeak 自带规则时兜底）：
      // OffPeak 弹窗标题消费 --eac-widget-fg（未设置时回退其原色）。
      if (cfg.widgetColor) {
        css += ".dspg_title,.__fc_wmock_title{color:var(--eac-widget-fg,#e6a23c)!important}";
      }
      return css;
    }

    function applyConfig(cfg) {
      var css = buildCss(cfg);
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        el.dataset.plugin = "dsh-font-custom";
        document.head.appendChild(el);
        // 皮肤切换/热重载会重排 head：被挤掉时重新挂回末尾。
        var mo = new MutationObserver(function () {
          var cur = document.getElementById(STYLE_ID);
          if (cur && cur.parentNode !== document.head) document.head.appendChild(cur);
          else if (!cur) {
            cur = document.createElement("style");
            cur.id = STYLE_ID;
            cur.textContent = css;
            document.head.appendChild(cur);
          }
        });
        mo.observe(document.head, { childList: true });
      }
      el.textContent = css;
      // 流光开关以 body 属性下发（CSS 变量无法直接门控 animation）。
      try {
        if (cfg.widgetGlow) document.body.setAttribute("data-eac-widget-glow", "1");
        else document.body.removeAttribute("data-eac-widget-glow");
      } catch (e) { /* body 未就绪时跳过 */ }
    }

    function loadStored() {
      var cfg = DEFAULTS;
      try {
        var raw = window.localStorage.getItem(STORE_KEY);
        if (raw) cfg = JSON.parse(raw);
      } catch (e) { /* 损坏配置回落默认 */ }
      return sanitize(cfg);
    }
    function store(cfg) {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* 存不进就算会话级 */ }
    }

    var NS = "fontCustom";
    var zh = {
      nav: "外观 · 字体与颜色",
      intro: "自定义界面的字体家族、字号与颜色：实时预览，保存后持久生效（本机浏览器存储）。皮肤使用同一套主题变量，自定义会覆盖皮肤默认值；「恢复默认」随时还原。",
      uiFont: "界面字体",
      codeFont: "代码字体",
      uiSize: "界面字号（px）",
      codeSize: "代码字号（px）",
      chatSize: "聊天正文字号（px）",
      primaryColor: "主文字颜色",
      secondaryColor: "次要文字颜色",
      accentColor: "强调色",
      custom: "自定义字体栈",
      customHint: "CSS font-family 语法，如 \"Noto Sans SC\", sans-serif",
      reset: "恢复默认",
      resetDone: "已恢复默认外观",
      preview: "预览：The quick brown fox 0123 —— 敏捷的棕色狐狸跳过了懒惰的狗。",
      previewCode: "const answer = 42; // 代码预览",
      widgetGroup: "余额 / 高峰提醒样式",
      widgetIntro: "自定义对话底部余额徽章与高峰价格提醒弹窗的文字颜色与流光效果（流光为循环扫光动画）。峰/谷徽章的橙绿语义色不受文字颜色影响。",
      widgetColor: "文字颜色",
      widgetGlow: "启用流光",
      widgetGlowColor: "流光颜色",
      widgetPreview: "预览效果",
      widgetPreviewClose: "关闭预览",
      widgetPreviewTitle: "样式预览",
      widgetMockBalance: "本轮 ¥0.4231 · 余额 ¥123.45",
      widgetMockPeak: "高峰价 · 剩 1 时 23 分",
      widgetMockRemindTitle: "⚡ 高峰时段 · 价格提醒",
      widgetMockRemindBody: "当前处于高峰时段，闲时价格为高峰一半。",
      widgetMockCmd: "把项目的测试全部跑一遍并修复失败项",
      widgetMockBtnNow: "继续执行",
      widgetMockBtnLater: "定时执行"
    };
    var en = {
      nav: "Appearance · Font & Color",
      intro: "Customize font families, sizes and colors: live preview, persisted locally. Skins share the same theme variables, so your overrides win; Reset restores defaults.",
      uiFont: "UI font",
      codeFont: "Code font",
      uiSize: "UI font size (px)",
      codeSize: "Code font size (px)",
      chatSize: "Chat text size (px)",
      primaryColor: "Primary text color",
      secondaryColor: "Secondary text color",
      accentColor: "Accent color",
      custom: "Custom font stack",
      customHint: "CSS font-family syntax, e.g. \"Noto Sans SC\", sans-serif",
      reset: "Reset to defaults",
      resetDone: "Appearance reset",
      preview: "Preview: The quick brown fox 0123.",
      previewCode: "const answer = 42; // code preview",
      widgetGroup: "Balance / peak reminder style",
      widgetIntro: "Customize the text color and the flowing-shine effect of the balance chip and the peak-hour reminder. Peak/off-peak badge colors stay semantic.",
      widgetColor: "Text color",
      widgetGlow: "Enable flowing shine",
      widgetGlowColor: "Shine color",
      widgetPreview: "Preview",
      widgetPreviewClose: "Close preview",
      widgetPreviewTitle: "Style preview",
      widgetMockBalance: "Turn ¥0.4231 · Balance ¥123.45",
      widgetMockPeak: "Peak · 1h 23m left",
      widgetMockRemindTitle: "⚡ Peak hours · Price reminder",
      widgetMockRemindBody: "You are in a peak window; off-peak price is half.",
      widgetMockCmd: "Run all project tests and fix failures",
      widgetMockBtnNow: "Continue",
      widgetMockBtnLater: "Schedule"
    };

    var CSS = ".__fc_root{max-width:640px;display:flex;flex-direction:column;gap:12px}" +
      ".__fc_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}" +
      ".__fc_grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
      "@media(max-width:560px){.__fc_grid{grid-template-columns:1fr}}" +
      ".__fc_field{display:flex;flex-direction:column;gap:4px}" +
      ".__fc_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__fc_input,.__fc_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__fc_range{width:100%;accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__fc_size{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:36px;text-align:right}" +
      ".__fc_row{display:flex;align-items:center;gap:8px}" +
      ".__fc_color{width:42px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;padding:1px;cursor:pointer}" +
      ".__fc_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__fc_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__fc_preview{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:6px}" +
      ".__fc_previewcode{font-family:var(--ds-font-family-code,monospace)}" +
      ".__fc_ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}" +
      // 预览弹窗（余额 / 高峰提醒样式）
      ".__fc_wmock_overlay{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.45);backdrop-filter:blur(4px)}" +
      ".__fc_wmock_box{width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 64px);overflow:auto;" +
      "background:var(--dsw-alias-bg-layer-2,#161b2c);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;" +
      "padding:16px 18px;box-shadow:0 16px 48px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:12px}" +
      ".__fc_wmock_head{display:flex;align-items:center;justify-content:space-between;gap:8px}" +
      ".__fc_wmock_row{display:flex;align-items:center;gap:8px;padding:4px 0}" +
      ".__fc_wmock_title{color:var(--dsw-alias-label-primary,#e6a23c)}";
    var tagId = "dsh-font-custom/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-font-custom";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function fontSelect(value, presets, onChange) {
      var isCustom = value && !presets.some(function (p) { return p.id === value; });
      return { isCustom: isCustom };
    }

    function FontCustomSection(props) {
      var t = props.t;
      var state = react.useState(null);
      var cfg = state[0];
      var setCfg = state[1];
      var okState = react.useState(false);
      var flashOk = okState[0];
      var setOk = okState[1];
      var pvState = react.useState(false);
      var previewOpen = pvState[0];
      var setPreviewOpen = pvState[1];

      react.useEffect(function () {
        var stored = loadStored();
        setCfg(stored);
        applyConfig(stored);
      }, []);

      if (!cfg) return h("div", { className: "__fc_root" }, h("p", { className: "__fc_hint" }, "…"));

      var update = function (patch) {
        var next = sanitize(Object.assign({}, cfg, patch));
        setCfg(next);
        applyConfig(next);
        store(next);
        setOk(true);
        setTimeout(function () { setOk(false); }, 1500);
      };

      var uiSel = fontSelect(cfg.uiFont, FONT_PRESETS);
      var codeSel = fontSelect(cfg.codeFont, CODE_PRESETS);

      var fontField = function (key, label, presets, selInfo) {
        var currentPreset = presets.find(function (p) { return p.id === cfg[key]; });
        var selectValue = selInfo.isCustom ? "custom" : (cfg[key] || "");
        return h("label", { className: "__fc_field" },
          h("span", { className: "__fc_label" }, label),
          h("select", {
            className: "__fc_select",
            value: selectValue,
            onChange: function (e) {
              var v = e.target.value;
              update(Object.defineProperty({}, key, { value: v === "custom" ? (selInfo.isCustom ? cfg[key] : "custom-placeholder") : v, enumerable: true }));
            }
          }, presets.map(function (p) {
            return h("option", { key: p.id || "default", value: p.id }, p.label);
          })),
          selectValue === "custom" ? h("input", {
            className: "__fc_input",
            value: cfg[key] === "custom-placeholder" ? "" : cfg[key],
            placeholder: t("customHint"),
            onChange: function (e) { var o = {}; o[key] = e.target.value; update(o); }
          }) : null
        );
      };

      var sizeField = function (key, label, lo, hi) {
        return h("label", { className: "__fc_field" },
          h("span", { className: "__fc_label" }, label),
          h("div", { className: "__fc_row" },
            h("input", {
              className: "__fc_range", type: "range", min: lo, max: hi, step: 1,
              value: cfg[key],
              onChange: function (e) { var o = {}; o[key] = Number(e.target.value); update(o); }
            }),
            h("span", { className: "__fc_size" }, String(cfg[key]))
          )
        );
      };

      var colorField = function (key, label) {
        return h("label", { className: "__fc_field" },
          h("span", { className: "__fc_label" }, label),
          h("div", { className: "__fc_row" },
            h("input", {
              className: "__fc_color", type: "color",
              value: /^#[0-9a-fA-F]{6}$/.test(cfg[key]) ? cfg[key] : "#e6ecff",
              onChange: function (e) { var o = {}; o[key] = e.target.value; update(o); }
            }),
            h("input", {
              className: "__fc_input", placeholder: "#RRGGBB",
              value: cfg[key],
              onChange: function (e) { var o = {}; o[key] = e.target.value; update(o); }
            })
          )
        );
      };

      return h("div", { className: "__fc_root" },
        h("p", { className: "__fc_hint", style: { margin: 0 } }, t("intro")),
        h("div", { className: "__fc_grid" },
          fontField("uiFont", t("uiFont"), FONT_PRESETS, uiSel),
          fontField("codeFont", t("codeFont"), CODE_PRESETS, codeSel),
          sizeField("uiSize", t("uiSize"), 11, 22),
          sizeField("chatSize", t("chatSize"), 11, 24),
          sizeField("codeSize", t("codeSize"), 10, 20),
          colorField("primaryColor", t("primaryColor")),
          colorField("secondaryColor", t("secondaryColor")),
          colorField("accentColor", t("accentColor"))
        ),
        h("div", { className: "__fc_preview" },
          h("div", { style: { color: cfg.primaryColor || undefined, fontSize: cfg.chatSize ? undefined : undefined } }, t("preview")),
          h("div", { className: "__fc_previewcode", style: { color: cfg.primaryColor || undefined } }, t("previewCode"))
        ),
        // —— 余额 / 高峰提醒样式（V4）——
        h("div", { className: "__fc_preview" },
          h("div", { className: "__fc_label" }, t("widgetGroup")),
          h("p", { className: "__fc_hint" }, t("widgetIntro")),
          h("div", { className: "__fc_grid" },
            colorField("widgetColor", t("widgetColor")),
            colorField("widgetGlowColor", t("widgetGlowColor")),
            h("label", { className: "__fc_field" },
              h("span", { className: "__fc_label" }, t("widgetGlow")),
              h("div", { className: "__fc_row" },
                h("input", {
                  type: "checkbox",
                  checked: cfg.widgetGlow === true,
                  onChange: function (e) { update({ widgetGlow: e.target.checked }); }
                }),
                h("button", {
                  className: "__fc_btn", style: { marginLeft: "auto" },
                  onClick: function () { setPreviewOpen(true); }
                }, t("widgetPreview"))
              )
            )
          )
        ),
        h("div", { className: "__fc_row" },
          h("button", {
            className: "__fc_btn",
            onClick: function () {
              setCfg(DEFAULTS);
              applyConfig(DEFAULTS);
              store(DEFAULTS);
            }
          }, t("reset")),
          flashOk ? h("span", { className: "__fc_ok" }, "✓") : null
        ),
        previewOpen ? widgetPreviewModal(t, function () { setPreviewOpen(false); }) : null
      );
    }

    // 预览弹窗（V4）：用真实样式类（.dsh-balance-dock / .dspg_*）复刻余额
    // 徽章与高峰提醒弹窗 —— 主题变量与流光动画即时生效，所见即所得。
    function widgetPreviewModal(t, onClose) {
      var close = function () { onClose(); };
      return h("div", {
        className: "__fc_wmock_overlay",
        onClick: function (e) { if (e.target === e.currentTarget) close(); }
      },
        h("div", { className: "__fc_wmock_box" },
          h("div", { className: "__fc_wmock_head" },
            h("span", { className: "__fc_label" }, t("widgetPreviewTitle")),
            h("button", { className: "__fc_btn", onClick: close }, t("widgetPreviewClose"))
          ),
          // 1) 余额徽章（对话底部统计栏内联样式）
          h("div", { className: "__fc_wmock_row" },
            h("span", { className: "dsh-balance-dock", style: { cursor: "default" } },
              t("widgetMockBalance"),
              " · ",
              h("span", { className: "dsh-balance-dock-period peak" }, t("widgetMockPeak"))
            )
          ),
          // 2) 高峰提醒弹窗（dsh-offpeak 的 .dspg_* 样式复刻）
          h("div", { className: "dspg_modal", style: { position: "static", width: "min(440px,100%)" } },
            h("div", { className: "__fc_wmock_title dspg_title" }, t("widgetMockRemindTitle")),
            h("div", { className: "dspg_sub" }, t("widgetMockRemindBody")),
            h("div", { className: "dspg_blocked" }, "本条命令已被拦截，尚未发送。"),
            h("div", { className: "dspg_cmd" }, t("widgetMockCmd")),
            h("div", { className: "dspg_row", style: { display: "flex", gap: "8px" } },
              h("button", { className: "dspg_btn dspg_btn_primary", style: { cursor: "default" } }, t("widgetMockBtnNow")),
              h("button", { className: "dspg_btn", style: { cursor: "default" } }, t("widgetMockBtnLater"))
            )
          )
        )
      );
    }

    var inject = ["slots", "locale"];

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-font-custom: dictionaries");
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "font-custom",
          order: 25,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(FontCustomSection, props);
        });
      });
      // 打开设置页前就应用已存配置（任何页面加载即生效，不限于设置页）。
      try { applyConfig(loadStored()); } catch (e) { /* 存储不可用时跳过 */ }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = { sanitize, buildCss, DEFAULTS };
    return module.exports;
  }
});

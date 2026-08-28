// dsh-side-session — 客户端 bundle（浏览器端）
//
// 形态（v0.2.0，2026-08-17 重构，依据用户要求）：
//  - 停靠面板钉在「页面最右缘」，展开时向右侧推开主界面（压缩主布局根 frame
//    宽度，AppFrame 的 ResizeObserver 自动重排三列），绝不遮挡聊天内容；
//  - 面板头部可直接「拖出」成独立浮窗（拖离右缘即撕出，跟随鼠标），浮窗可
//    拖拽移动 / 右下角缩放 / 双击或按钮收回侧栏；
//  - UI 与主界面完全同款：同一套 --dsw-alias-* / --dsw-specific-* 令牌，
//    用户消息复刻官方气泡（--dsw-specific-bubble、radius 22px），助手消息
//    复刻官方 markdown 排版（--dsw-font-markdown-base、代码块令牌），
//    输入框复刻官方 Composer 卡片（--dsw-specific-input-major、radius 22px）。
//  - 其余能力不变：footer 图标 / 斜杠命令 / Ctrl+Shift+S、三模式引擎、
//    流式输出、会话上下文捕获、设置持久化（新增面板宽度）。
//
// 实现约束：插件 require 只能取平台 seed 模块（跨插件值导入是构建错误），
// 故「同款 UI」通过复刻官方令牌与视觉参数实现，零构建、零新增依赖。

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-side-session",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var reactDom = require("react-dom/client");
    var jsxRuntime = require("react/jsx-runtime");
    var jsx = jsxRuntime.jsx;
    var jsxs = jsxRuntime.jsxs;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;
    var useLayoutEffect = react.useLayoutEffect;

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      if (children.length === 0) return jsx(type, props || {});
      if (children.length === 1)
        return jsx(type, Object.assign({}, props || {}, { children: children[0] }));
      return jsxs(type, Object.assign({}, props || {}, { children: children }));
    }

    // ------------------------------------------------------------------
    // 全局单例 Store（模块级，panel/float 共享；浮窗状态仅内存，不持久化）
    // ------------------------------------------------------------------
    var store = {
      mode: "1",
      carrier: "float", // 仅浮窗形态
      expanded: false, // 不自动弹出：由 footer 图标 / Ctrl+Shift+S / 斜杠命令唤起（符合 SPEC）
      sessionId: "",
      context: null,
      thread: [],
      streaming: false,
      error: "",
      floatPos: null, // {x,y} 浮窗左上角（仅内存）
    };
    var listeners = new Set();
    function getState() {
      return store;
    }
    function setState(patch) {
      Object.assign(store, patch);
      listeners.forEach(function (l) {
        l();
      });
    }
    function subscribe(l) {
      listeners.add(l);
      return function () {
        listeners.delete(l);
      };
    }
    function useStore() {
      var force = useState(0)[1];
      useEffect(function () {
        return subscribe(function () {
          force(function (x) {
            return x + 1;
          });
        });
      }, []);
      return store;
    }

    // ------------------------------------------------------------------
    // 设置（dsh-side-session 命名空间，持久化）
    // ------------------------------------------------------------------
    var settingsScope = null;
    var pluginSettings = {
      mode: "1",
      apiKey: "",
      model: "deepseek-chat",
      endpoint: "https://api.deepseek.com",
      contextLength: "2",
      animMs: 500,
    };

    function applySettingsSnapshot() {
      try {
        var snap = settingsScope.getSnapshot();
        if (snap && snap.status === "ready" && snap.value) {
          var v = snap.value;
          pluginSettings = {
            mode: String(v.mode || "1"),
            apiKey: v.apiKey || "",
            model: v.model || "deepseek-chat",
            endpoint: v.endpoint || "https://api.deepseek.com",
            contextLength: String(v.contextLength || "2"),
            animMs: Number(v.animMs != null ? v.animMs : 500),
          };
          if (getState().mode !== pluginSettings.mode && !isModePinActive()) setState({ mode: pluginSettings.mode });
          applyAnimDuration();
        }
      } catch (e) {}
    }

    function applyAnimDuration() {
      try {
        if (typeof document === "undefined") return;
        var ms = Math.max(0, Number(pluginSettings.animMs) || 0);
        document.documentElement.style.setProperty("--dss-pop-duration", ms + "ms");
      } catch (e) {}
    }

    function bindSettings(ctx) {
      try {
        settingsScope = ctx.settingsScope.bind({ namespace: "dsh-side-session" });
        applySettingsSnapshot();
        settingsScope.subscribe(applySettingsSnapshot);
      } catch (e) {
        console.warn("[dsh-side-session] settingsScope 不可用，使用内存默认配置");
      }
    }

    function setMode(m) {
      setState({ mode: m });
      pluginSettings.mode = m;
      // 写盘是异步的，快照可能先于落盘返回旧的 mode；短暂钉住用户的选择，
      // 避免「切到 2 → 下方新增的 api/模型输入框被快照回写瞬间拉回消失」。
      modePinnedUntil = Date.now() + 2500;
      try {
        if (settingsScope) settingsScope.set("mode", m);
      } catch (e) {
        console.warn("[dsh-side-session] set mode failed: " + ((e && e.message) || e));
      }
    }
    function setPluginSetting(key, val) {
      pluginSettings[key] = val;
      try {
        if (settingsScope) settingsScope.set(key, val);
      } catch (e) {}
    }

    // ------------------------------------------------------------------
    // 上下文获取
    // ------------------------------------------------------------------
    var lastFingerprint = "";
    var lastFullAt = 0; // 全量拉取节流：流式回合中日志 mtime 持续变化，
    // 若每次都拉全量会每 2s 传输数百 KB JSON 并触发重渲染；4s 节流足够
    // 保持面板新鲜，同时避免拖慢主对话 UI。
    function fetchContext(sessionId) {
      if (!sessionId) return;
      // 先轮询轻量 meta（计数+指纹），内容变化才拉全量 → 避免大 JSON 每 2s 传输解析
      fetch("/api/dsh-side-session/context?sessionId=" + encodeURIComponent(sessionId) + "&meta=1")
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (m) {
          if (!m || m.sessionId !== getState().sessionId) return;
          var fp = String(m.updatedAt || 0) + ":" + String(m.msgs || 0) + ":" + String(m.files || 0) + ":" + String(m.title || "");
          if (fp === lastFingerprint) return; // 无变化：不重拉、不重渲染
          lastFingerprint = fp;
          var now = Date.now();
          if (now - lastFullAt < 4000) return; // 全量节流：等待下一轮轮询再拉
          lastFullAt = now;
          fetch("/api/dsh-side-session/context?sessionId=" + encodeURIComponent(sessionId))
            .then(function (r) {
              return r.ok ? r.json() : null;
            })
            .then(function (data) {
              if (data && data.sessionId === getState().sessionId) setState({ context: data });
            })
            .catch(function () {});
        })
        .catch(function () {});
    }
    function loadContext(sessionId) {
      if (!sessionId) return;
      lastFingerprint = "";
      lastFullAt = 0; // 切换会话立即全量拉取（不节流）
      setState({ sessionId: String(sessionId), context: null });
      fetchContext(sessionId);
    }

    // ------------------------------------------------------------------
    // 系统提示 + 消息组装
    // ------------------------------------------------------------------
    function usesEnglishUi() {
      return typeof document !== "undefined" && String(document.documentElement.lang || "").toLowerCase().startsWith("en");
    }

    function buildSystemPrompt(ctx) {
      ctx = ctx || { title: "", files: [], transcript: [] };
      var lines = [];
      var english = usesEnglishUi();
      lines.push(english
        ? "You are a DSH temporary-session assistant. Answer the user's temporary questions from the imported current-session context below."
        : "你是一个「DSH 临时会话」辅助助手。当前用户正在主会话中工作，你基于下方自动导入的「当前会话上下文」回答用户的临时追问。");
      lines.push("");
      lines.push(english ? "Rules:" : "硬性规则：");
      lines.push(english ? "1. Explain, analyze, and answer questions only. Never modify files or propose write/edit/command operations." : "1. 你只做解释、分析、答疑，绝不修改任何文件，不要输出任何写文件/编辑/执行命令的操作。");
      lines.push(english ? "2. Stay grounded in the context. If it is insufficient, say that the current session context does not establish the answer." : "2. 回答紧扣上下文；上下文不足以回答时，明确说明「根据当前会话上下文无法确认」。");
      lines.push(english ? "3. Be concise and answer in English." : "3. 保持简洁，用中文。");
      lines.push("");
      lines.push(english ? "==== Current session context ====" : "==== 当前会话上下文 ====");
      lines.push((english ? "Session title: " : "会话标题：") + (ctx.title || (english ? "(unknown)" : "(未知)")));
      lines.push("");
      lines.push(english ? "--- Recent conversation ---" : "--- 对话记录（最近部分）---");
      var trans = ctx.transcript || [];
      if (trans.length === 0) lines.push(english ? "(none)" : "(无)");
      else {
        for (var i = 0; i < trans.length; i++) {
          var m = trans[i];
          var who = m.role === "assistant" ? (english ? "assistant" : "助手") : (english ? "user" : "用户");
          var text = (m.text || "").slice(0, 4000);
          lines.push("[" + who + "] " + text);
        }
      }
      lines.push("");
      lines.push(english ? "--- Files involved in this session ---" : "--- 本会话涉及的文件 ---");
      var files = ctx.files || [];
      if (files.length === 0) lines.push(english ? "(none)" : "(无)");
      else {
        var shown = 0;
        for (var j = 0; j < files.length; j++) {
          var f = files[j];
          lines.push(f.path + " [" + f.op + "]");
          if (f.op === "read") continue;
          var content = (f.newText || f.oldText || "").slice(0, 8000);
          if (content) lines.push(content);
          shown++;
          if (shown >= 40) {
            lines.push(english ? "...(file list truncated)" : "…(文件过多，已截断展示)");
            break;
          }
        }
      }
      lines.push("====================");
      return lines.join("\n");
    }

    function buildMessages(state, question) {
      var sys = buildSystemPrompt(state.context);
      var hist = state.thread.slice(0, -2).map(function (m) {
        return { role: m.role, content: m.text };
      });
      return [{ role: "system", content: sys }].concat(hist, [{ role: "user", content: question }]);
    }

    // ------------------------------------------------------------------
    // SSE 解析
    // ------------------------------------------------------------------
    function readSSE(response, onDelta) {
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      var stopped = false;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += decoder.decode(r.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            var chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            var parts = chunk.split("\n");
            for (var i = 0; i < parts.length; i++) {
              var t = parts[i].trim();
              if (!t.indexOf) continue;
              if (t.indexOf("data:") !== 0) continue;
              var data = t.slice(5).trim();
              if (data === "[DONE]") {
                stopped = true;
                return;
              }
              var json;
              try {
                json = JSON.parse(data);
              } catch (e) {
                continue;
              }
              if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
              var delta = json.choices && json.choices[0] && json.choices[0].delta;
              if (delta && typeof delta.content === "string") onDelta(delta.content);
            }
          }
          if (stopped) return;
          return pump();
        });
      }
      return pump();
    }

    // ------------------------------------------------------------------
    // 引擎调用
    // ------------------------------------------------------------------
    function appendAssistant(delta) {
      var t = getState().thread;
      var last = t[t.length - 1];
      if (last && last.role === "assistant") {
        t[t.length - 1] = Object.assign({}, last, { text: last.text + delta });
        setState({ thread: t.slice() });
      }
    }

    function ask(question) {
      var s = getState();
      if (s.streaming || !question || !question.trim()) return;
      var mode = s.mode;

      // 密钥缺失友好提示（mode1/2）
      if (mode === "2" && !pluginSettings.apiKey) {
        setState({
          streaming: false,
          error: usesEnglishUi() ? "The plugin API key is empty. Enter one under Settings > Temporary session, or switch modes." : "插件 API Key 为空：请在「设置 → 临时会话」填写 API Key，或切换到其他模式。",
        });
        return;
      }

      var userMsg = { role: "user", text: question };
      var assistantMsg = { role: "assistant", text: "" };
      setState({ streaming: true, error: "", thread: s.thread.concat([userMsg, assistantMsg]) });
      var state = getState();
      var messages = buildMessages(state, question);

      function fail(err) {
        setState({ streaming: false, error: String((err && err.message) || err) });
      }

      var body = { mode: mode, messages: messages, pluginSettings: pluginSettings, sessionId: state.sessionId };
      if (state.context) {
        if (state.context.provider) body.provider = state.context.provider;
        if (state.context.model) body.model = state.context.model;
      }
      fetch("/api/dsh-side-session/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) {
          if (!r.ok) {
            return r
              .json()
              .catch(function () {
                return { message: "HTTP " + r.status };
              })
              .then(function (e) {
                throw new Error(e.message || "HTTP " + r.status);
              });
          }
          return readSSE(r, appendAssistant);
        })
        .then(function () {
          setState({ streaming: false });
        })
        .catch(function (err) {
          fail(err);
        });
    }

    function clearThread() {
      setState({ thread: [], error: "" });
    }

    // ------------------------------------------------------------------
    // 轻量 markdown 渲染（主界面排版观感：整宽文本 + 令牌配色；
    // 无 dangerouslySetInnerHTML，所有内容经 React 转义）
    // ------------------------------------------------------------------
    function renderInline(text, keyBase) {
      var re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[([^\]]+)\]\(([^)\s]+)\))|(~~[^~\n]+~~)/g;
      var out = [];
      var last = 0;
      var m;
      var k = 0;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        if (m[1]) out.push(h("code", { key: keyBase + "c" + k++ }, m[1].slice(1, -1)));
        else if (m[2]) out.push(h("strong", { key: keyBase + "s" + k++ }, m[2].slice(2, -2)));
        else if (m[3]) out.push(h("em", { key: keyBase + "e" + k++ }, m[3].slice(1, -1)));
        else if (m[4])
          out.push(
            h("a", { key: keyBase + "a" + k++, href: m[6], target: "_blank", rel: "noreferrer" }, m[5])
          );
        else if (m[7]) out.push(h("del", { key: keyBase + "d" + k++ }, m[7].slice(2, -2)));
        last = re.lastIndex;
      }
      if (last < text.length) out.push(text.slice(last));
      if (out.length === 0) return text;
      return out;
    }

    function renderMarkdown(text) {
      var lines = String(text || "").split("\n");
      var blocks = [];
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];
        var fm = line.match(/^```(\S*)\s*$/);
        if (fm) {
          var lang = fm[1] || "";
          var buf = [];
          i++;
          while (i < lines.length && !/^```\s*$/.test(lines[i])) {
            buf.push(lines[i]);
            i++;
          }
          i++;
          blocks.push({ type: "code", text: buf.join("\n"), lang: lang });
          continue;
        }
        var hm = line.match(/^(#{1,4})\s+(.*)$/);
        if (hm) {
          blocks.push({ type: "h" + hm[1].length, text: hm[2] });
          i++;
          continue;
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          var items = [];
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
            i++;
          }
          blocks.push({ type: "ul", items: items });
          continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          var oitems = [];
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            oitems.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
            i++;
          }
          blocks.push({ type: "ol", items: oitems });
          continue;
        }
        if (/^\s*>\s?/.test(line)) {
          var q = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            q.push(lines[i].replace(/^\s*>\s?/, ""));
            i++;
          }
          blocks.push({ type: "quote", text: q.join("\n") });
          continue;
        }
        if (line.trim() === "") {
          i++;
          continue;
        }
        var para = [line];
        i++;
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !/^(```|#{1,4}\s)/.test(lines[i])
        ) {
          para.push(lines[i]);
          i++;
        }
        blocks.push({ type: "p", text: para.join("\n") });
      }
      return blocks.map(function (b, idx) {
        var kb = idx * 1000;
        switch (b.type) {
          case "code":
            return h(
              "pre",
              { key: idx },
              h("code", { className: b.lang ? "language-" + b.lang : "" }, b.text)
            );
          case "h1":
          case "h2":
          case "h3":
          case "h4":
            return h(b.type, { key: idx }, renderInline(b.text, kb));
          case "ul":
            return h(
              "ul",
              { key: idx },
              b.items.map(function (it, j) {
                return h("li", { key: j }, renderInline(it, kb + j * 10));
              })
            );
          case "ol":
            return h(
              "ol",
              { key: idx },
              b.items.map(function (it, j) {
                return h("li", { key: j }, renderInline(it, kb + j * 10));
              })
            );
          case "quote":
            return h("blockquote", { key: idx }, renderInline(b.text, kb));
          default:
            return h("p", { key: idx }, renderInline(b.text, kb));
        }
      });
    }

    // ------------------------------------------------------------------
    // CSS —— 与主界面同款（官方令牌 + 官方视觉参数）
    // ------------------------------------------------------------------
    var CSS = [
      // —— 停靠面板：钉在页面最右缘，主布局被向右推开（见 CarrierFrame 布局挤压 effect）——
      ".dss-root{position:fixed;z-index:80;top:0;bottom:0;right:0;display:flex;flex-direction:column;",
      "width:var(--dss-panel-width,380px);max-width:92vw;",
      "background:var(--dsw-alias-bg-base,#f9fafb);color:var(--dsw-alias-label-primary,#0f1115);",
      "border-left:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(0,0,0,.1));",
      "box-shadow:-8px 0 24px rgba(0,0,0,.06);font:inherit}",
      ".dss-root *{box-sizing:border-box}",
      // —— 浮窗：可拖拽、可缩放 ——
      ".dss-float{position:fixed;z-index:90;top:80px;right:80px;width:420px;height:560px;",
      "max-width:92vw;max-height:88vh;border-radius:14px;overflow:hidden;",
      "border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(0,0,0,.12));",
      "box-shadow:0 12px 40px rgba(0,0,0,.18);animation:dss-pop var(--dss-pop-duration,.5s) cubic-bezier(.16,1,.3,1)}",
      "@keyframes dss-pop{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion:reduce){.dss-float{animation:none}}",
      // —— 头部 ——
      ".dss-head{display:flex;align-items:center;gap:2px;height:46px;padding:0 10px 0 14px;flex:none;",
      "border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));cursor:grab;user-select:none}",
      ".dss-head:active{cursor:grabbing}",
      ".dss-title{font-size:14px;font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;",
      "text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dss-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;",
      "border-radius:8px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);",
      "cursor:pointer;flex:none;transition:background .12s,color .12s}",
      ".dss-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));",
      "color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dss-btn:disabled{opacity:.45;cursor:default}",
      ".dss-btn svg{width:15px;height:15px}",
      // —— 上下文卡（可折叠）——
      ".dss-ctx{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));",
      "background:var(--dsw-alias-bg-module-platform,#f5f5f7);flex:none}",
      ".dss-ctx-head{display:flex;align-items:center;gap:6px;padding:6px 12px;min-height:34px;cursor:pointer;",
      "font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);user-select:none}",
      ".dss-ctx-head:hover{color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dss-chevron{flex:none;transition:transform .15s}",
      ".dss-chevron[data-open='1']{transform:rotate(90deg)}",
      ".dss-ctx-summary{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
      "text-align:right;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}",
      ".dss-ctx-body{padding:2px 12px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);",
      "display:flex;flex-direction:column;gap:6px}",
      ".dss-chip{display:inline-block;margin:2px 4px 2px 0;padding:1px 8px;border-radius:999px;",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));",
      "color:var(--dsw-alias-label-tertiary,#81858c);font-size:10px;max-width:200px;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}",
      // —— 消息区 ——
      ".dss-thread{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;",
      "gap:14px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.18)) transparent}",
      ".dss-thread::-webkit-scrollbar{width:8px}",
      ".dss-thread::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.18));",
      "border-radius:4px;border:2px solid transparent;background-clip:padding-box}",
      // 用户消息：复刻官方气泡（.gdEzaW_bubble：--dsw-specific-bubble / radius 22px / 16px/24px）
      ".dss-msg.user{background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary,#0f1115);",
      "border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px;align-self:flex-end;",
      "max-width:85%;white-space:pre-wrap;word-break:break-word}",
      // 助手消息：复刻官方整宽 markdown 排版
      ".dss-msg.assistant{width:100%;min-width:0}",
      ".dss-md{min-width:0;overflow-wrap:anywhere;font:var(--dsw-font-markdown-base,16px/28px system-ui);",
      "color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dss-md p{margin:8px 0}",
      ".dss-md :first-child{margin-top:0}",
      ".dss-md :last-child{margin-bottom:0}",
      ".dss-md h1,.dss-md h2,.dss-md h3,.dss-md h4{font-weight:600;margin:14px 0 6px;line-height:1.4}",
      ".dss-md h1{font-size:18px}.dss-md h2{font-size:16px}.dss-md h3{font-size:15px}.dss-md h4{font-size:14px}",
      ".dss-md a{color:var(--dsw-alias-state-business-primary,#3964fe);text-decoration:none}",
      ".dss-md a:hover{text-decoration:underline}",
      ".dss-md ul,.dss-md ol{margin:8px 0;padding-left:20px}",
      ".dss-md li{margin:3px 0}",
      ".dss-md blockquote{border-left:3px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));margin:8px 0;",
      "padding:2px 12px;color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dss-md pre{background:var(--dsw-alias-markdown-code-block,#f5f5f7);",
      "border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));border-radius:10px;",
      "padding:10px 12px;overflow-x:auto;margin:8px 0}",
      ".dss-md code{font-family:var(--ds-font-family-code,ui-monospace,'SF Mono',Menlo,Consolas,monospace);",
      "font-size:12.5px;line-height:1.6}",
      ".dss-md :not(pre)>code{background:var(--dsw-alias-markdown-inline-code,#eef0f4);border-radius:5px;",
      "padding:1px 5px;font-size:12px}",
      ".dss-cursor{display:inline-block;width:8px;height:15px;vertical-align:-2px;border-radius:2px;",
      "background:var(--dsw-alias-state-business-primary,#3964fe);animation:dss-blink 1s steps(2) infinite}",
      "@keyframes dss-blink{0%,100%{opacity:1}50%{opacity:0}}",
      ".dss-err{padding:6px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary,#d92d2d);",
      "background:var(--dsw-alias-interactive-bg-hover-danger,rgba(217,45,45,.06));flex:none}",
      // —— 输入区：复刻官方 Composer 卡片（--dsw-specific-input-major / radius 22px / shadow-lv2）——
      ".dss-composer{flex:none;padding:10px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}",
      ".dss-card{display:flex;align-items:flex-end;gap:8px;",
      "border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(0,0,0,.1));",
      "background:var(--dsw-specific-input-major,#fff);box-shadow:var(--dsw-shadow-lv2,none);",
      "border-radius:22px;padding:8px 8px 8px 16px;transition:border-color .15s}",
      ".dss-card:focus-within{border-color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".dss-input-wrap{position:relative;flex:1;min-width:0}",
      ".dss-input-mirror{position:absolute;left:0;top:0;width:100%;min-height:26px;max-height:132px;",
      "padding:2px 0;font-size:15px;line-height:24px;font-family:inherit;white-space:pre-wrap;",
      "word-break:break-word;visibility:hidden;pointer-events:none;overflow:hidden}",
      ".dss-input{position:relative;width:100%;resize:none;border:none;outline:none;background:transparent;",
      "min-height:26px;max-height:132px;padding:2px 0;font-size:15px;line-height:24px;",
      "color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;",
      "caret-color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".dss-input::placeholder{color:var(--dsw-alias-label-caption,#9aa0a6)}",
      ".dss-send{background:var(--dsw-alias-button-info-fill,#3964fe);color:#fff;cursor:pointer;border:none;",
      "border-radius:999px;flex:none;place-items:center;width:34px;height:34px;transition:background-color .1s;",
      "display:grid;transform:translateY(-2px)}",
      ".dss-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2f5be8)}",
      ".dss-send:active{transform:translateY(-2px) scale(.94)}",
      ".dss-send:disabled{opacity:.4;cursor:default}",
      ".dss-send svg{width:16px;height:16px}",
      // —— 浮窗缩放手柄 ——
      ".dss-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:5}",
      ".dss-resize:after{content:'';position:absolute;right:4px;bottom:4px;width:7px;height:7px;",
      "border-right:2px solid var(--dsw-alias-label-tertiary,#81858c);",
      "border-bottom:2px solid var(--dsw-alias-label-tertiary,#81858c);border-radius:1px;opacity:.5}",
      // —— 左侧主栏 footer 唤起图标（对齐设置按钮：同款行样式 / hover / rail 圆钮）——
      ".dss-footer-icon{box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);height:34px;",
      "color:var(--dsw-alias-label-primary,#0f1115);background:0 0;border:none;border-radius:12px;",
      "flex:none;align-items:center;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;",
      "font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;",
      "transition:background .12s,color .12s;outline:none}",
      ".dss-footer-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",
      ".dss-footer-icon[data-on='1']{color:var(--dsw-alias-state-business-primary,#4176e6)}",
      ".dss-footer-icon[data-rail='1']{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;",
      "margin:8px 0 10px;padding:0}",
      ".dss-footer-icon[data-rail='1']:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",
      ".dss-footer-icon svg{flex:none}",
      ".dss-footer-label{white-space:nowrap;overflow:hidden}",
      // —— 设置面板 ——
      ".dss-settings{padding:16px;display:flex;flex-direction:column;gap:14px}",
      ".dss-set-row{display:flex;flex-direction:column;gap:6px}",
      ".dss-set-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}",
      ".dss-set-input,.dss-set-select{width:100%;padding:7px 10px;border-radius:8px;font-size:13px;",
      "background:var(--dsw-alias-bg-module-platform,#f5f5f7);color:var(--dsw-alias-label-primary,#1a1a1f);",
      "border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));outline:none;font-family:inherit}",
      ".dss-set-input:focus,.dss-set-select:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6)}",
      ".dss-set-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);line-height:1.5}",
      ".dss-set-apply{align-self:flex-start;padding:5px 16px;border-radius:8px;font-size:12px;border:none;cursor:pointer;background:var(--dsw-alias-state-business-primary,#4176e6);color:#fff;transition:opacity .15s,transform .1s}",
      ".dss-set-apply:hover{opacity:.88}",
      ".dss-set-apply:active{transform:scale(.96)}",
    ].join("");

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css='dsh-side-session/client.css']")) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-side-session";
      tag.dataset.pluginCss = "dsh-side-session/client.css";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ------------------------------------------------------------------
    // 输入框（行为级复刻 InputBar：mirror auto-grow + IME + 快捷键；
    // 视觉为官方 Composer 卡片）
    // ------------------------------------------------------------------
    function Composer() {
      var s = useStore();
      var valState = useState("");
      var val = valState[0];
      var setVal = valState[1];
      var taRef = useRef(null);
      var mirrorRef = useRef(null);
      var composingRef = useRef(false);
      var histRef = useRef({ stack: [""], idx: 0 });
      var lastInputAt = useRef(0);

      function pushHistory(v) {
        var h = histRef.current;
        var now = Date.now();
        if (now - lastInputAt.current < 800 && h.idx === h.stack.length - 1) {
          h.stack[h.idx] = v;
        } else {
          h.stack = h.stack.slice(0, h.idx + 1);
          h.stack.push(v);
          if (h.stack.length > 100) h.stack.shift();
          h.idx = h.stack.length - 1;
        }
        lastInputAt.current = now;
      }

      function setValAndHistory(v) {
        setVal(v);
        pushHistory(v);
      }

      useLayoutEffect(
        function () {
          if (!taRef.current || !mirrorRef.current) return;
          mirrorRef.current.textContent = (val || "") + "\n";
          var h = mirrorRef.current.offsetHeight;
          if (h < 26) h = 26;
          if (h > 132) h = 132;
          taRef.current.style.height = h + "px";
        },
        [val]
      );

      function send() {
        var q = val.trim();
        if (!q || s.streaming) return;
        setVal("");
        histRef.current = { stack: [""], idx: 0 };
        ask(q);
      }

      function onKeyDown(e) {
        var composing = composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
        if (composing) return;
        var key = e.key;
        var ctrl = e.ctrlKey || e.metaKey;
        if (key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
          return;
        }
        if (ctrl && !e.shiftKey && (key === "z" || key === "Z")) {
          e.preventDefault();
          var h = histRef.current;
          if (h.idx > 0) {
            h.idx--;
            setVal(h.stack[h.idx]);
          }
          return;
        }
        if (ctrl && (key === "y" || key === "Y" || (e.shiftKey && (key === "z" || key === "Z")))) {
          e.preventDefault();
          var h2 = histRef.current;
          if (h2.idx < h2.stack.length - 1) {
            h2.idx++;
            setVal(h2.stack[h2.idx]);
          }
          return;
        }
      }

      return h(
        "div",
        { className: "dss-composer" },
        h(
          "div",
          { className: "dss-card" },
          h(
            "div",
            { className: "dss-input-wrap" },
            h("div", { className: "dss-input-mirror", ref: mirrorRef, "aria-hidden": "true" }),
            h("textarea", {
              className: "dss-input",
              ref: taRef,
              placeholder: "基于上下文提问",
              value: val,
              rows: 1,
              disabled: s.streaming,
              onChange: function (e) {
                setValAndHistory(e.target.value);
              },
              onCompositionStart: function () {
                composingRef.current = true;
              },
              onCompositionEnd: function () {
                var self = this;
                setTimeout(function () {
                  composingRef.current = false;
                }, 10);
              },
              onKeyDown: onKeyDown,
            })
          ),
          h(
            "button",
            {
              className: "dss-send",
              onClick: send,
              disabled: s.streaming || !val.trim(),
              title: s.streaming ? "回答中…" : "发送",
              "aria-label": "发送",
            },
            h(
              "svg",
              {
                viewBox: "0 0 16 16",
                width: "16",
                height: "16",
                "aria-hidden": true,
              },
              h("path", {
                d: "M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z",
                fill: "currentColor",
              })
            )
          )
        )
      );
    }

    // ------------------------------------------------------------------
    // 上下文卡（可折叠单行摘要）
    // ------------------------------------------------------------------
    function ContextCard() {
      var s = useStore();
      var openState = useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var ctx = s.context;
      if (!ctx) {
        return h(
          "div",
          { className: "dss-ctx" },
          h(
            "div",
            { className: "dss-ctx-head", style: { cursor: "default" } },
            h("div", { className: "dss-title", style: { fontSize: "12px", fontWeight: 400 } },
              s.sessionId ? "正在加载上下文…" : "未检测到会话")
          )
        );
      }
      var files = ctx.files || [];
      var msgs = ctx.transcript || [];
      var summary =
        (ctx.title || "(未知会话)") +
        " · 对话 " + msgs.length + " 条 · 文件 " + files.length + " 个" +
        (ctx.truncated ? " · 已截断" : "");
      return h(
        "div",
        { className: "dss-ctx" },
        h(
          "div",
          { className: "dss-ctx-head", onClick: function () { setOpen(!open); } },
          h(
            "svg",
            {
              className: "dss-chevron",
              "data-open": open ? "1" : "0",
              width: "12",
              height: "12",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              "stroke-width": "2.2",
              "stroke-linecap": "round",
              "stroke-linejoin": "round",
            },
            h("path", { d: "M9 6l6 6-6 6" })
          ),
          h("span", null, "会话上下文"),
          h("span", { className: "dss-ctx-summary", title: summary }, summary)
        ),
        open
          ? h(
              "div",
              { className: "dss-ctx-body" },
              h("div", null, "会话：" + (ctx.title || "(未知)")),
              h(
                "div",
                null,
                "对话 " + msgs.length + " 条 · 文件 " + files.length + " 个" + (ctx.truncated ? " · 已截断" : "")
              ),
              files.length
                ? h(
                    "div",
                    null,
                    files.slice(0, 30).map(function (f) {
                      return h(
                        "span",
                        { className: "dss-chip", key: f.path, title: f.path },
                        f.op + ":" + f.path.split(/[\\/]/).pop()
                      );
                    })
                  )
                : null
            )
          : null
      );
    }

    // ------------------------------------------------------------------
    // 消息列表（用户=官方气泡；助手=官方 markdown 排版 + 流式光标）
    // ------------------------------------------------------------------
    function Thread() {
      var s = useStore();
      var ref = useRef(null);
      useEffect(function () {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
      });
      return h(
        "div",
        { className: "dss-thread", ref: ref },
        s.thread.length === 0
          ? h(
              "div",
              { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: "20px" } },
              "向当前会话上下文提问，答案仅存在于此临时会话，不污染主会话。"
            )
          : s.thread.map(function (m, i) {
              if (m.role === "user") {
                return h("div", { className: "dss-msg user", key: i }, m.text);
              }
              return h(
                "div",
                { className: "dss-msg assistant", key: i },
                m.text
                  ? h("div", { className: "dss-md" }, renderMarkdown(m.text))
                  : null,
                m.text === "" && s.streaming ? h("span", { className: "dss-cursor" }) : null
              );
            })
      );
    }

    // ------------------------------------------------------------------
    // 载体框架（侧栏停靠 / 浮窗）+ 主布局挤压 + 拖出撕离
    // ------------------------------------------------------------------
    function CarrierFrame() {
      var s = useStore();
      var rootRef = useRef(null);
      var floatRef = useRef(null);
      var drag = useRef(null); // { dx, dy } 头部抓取偏移
      var resize = useRef(null); // { sw, sh, sx, sy }

      // 浮窗内拖拽移动
      function onFloatDragStart(e) {
        if (e.button !== 0 || !floatRef.current) return;
        var r = floatRef.current.getBoundingClientRect();
        drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        document.body.style.userSelect = "none";
        function move(ev) {
          if (!drag.current || !floatRef.current) return;
          var x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - drag.current.dx));
          var y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - drag.current.dy));
          floatRef.current.style.left = x + "px";
          floatRef.current.style.top = y + "px";
          floatRef.current.style.right = "auto";
          floatRef.current.style.bottom = "auto";
          store.floatPos = { x: x, y: y }; // 同步（不触发重渲染，避免与 React 定位冲突）
        }
        function up() {
          drag.current = null;
          document.body.style.userSelect = "";
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      }

      // 浮窗右下角缩放
      function onResizeStart(e) {
        if (e.button !== 0 || !floatRef.current) return;
        var r = floatRef.current.getBoundingClientRect();
        resize.current = { sw: r.width, sh: r.height, sx: e.clientX, sy: e.clientY };
        document.body.style.userSelect = "none";
        function move(ev) {
          if (!resize.current || !floatRef.current) return;
          var w = Math.max(320, Math.min(window.innerWidth - 12, resize.current.sw + (ev.clientX - resize.current.sx)));
          var h = Math.max(360, Math.min(window.innerHeight - 12, resize.current.sh + (ev.clientY - resize.current.sy)));
          floatRef.current.style.width = w + "px";
          floatRef.current.style.height = h + "px";
        }
        function up() {
          resize.current = null;
          document.body.style.userSelect = "";
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      }

      // 浮窗定位：由 effect 从 store.floatPos 应用（拖拽中直接改 DOM，不参与 React 渲染）
      useEffect(function () {
        if (s.carrier !== "float" || !floatRef.current) return;
        var p = store.floatPos;
        if (p) {
          floatRef.current.style.left = p.x + "px";
          floatRef.current.style.top = p.y + "px";
          floatRef.current.style.right = "auto";
          floatRef.current.style.bottom = "auto";
        }
      }, [s.carrier]);

      // （原侧栏停靠挤压逻辑已移除：仅保留浮窗形态）

      var body = h(
        "div",
        { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
        h(
          "div",
          {
            className: "dss-head",
            onMouseDown: onFloatDragStart,
            title: "拖动移动浮窗",
          },
          h("div", { className: "dss-title" }, "临时会话"),
          h(
            "button",
            {
              className: "dss-btn",
              title: "隐藏浮窗",
              onClick: function () {
                setState({ expanded: false });
              },
            },
            h(
              "svg",
              {
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                "stroke-width": "1.8",
                "stroke-linecap": "round",
                "stroke-linejoin": "round",
              },
              h("path", { d: "M18 6L6 18" }),
              h("path", { d: "M6 6l12 12" })
            )
          ),
          h(
            "button",
            {
              className: "dss-btn",
              title: "清空临时会话",
              onClick: function () {
                clearThread();
              },
            },
            h(
              "svg",
              {
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                "stroke-width": "1.8",
                "stroke-linecap": "round",
                "stroke-linejoin": "round",
              },
              h("path", { d: "M3 6h18" }),
              h("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }),
              h("path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }),
              h("path", { d: "M10 11v6" }),
              h("path", { d: "M14 11v6" })
            )
          ),
          
        ),
        h(ContextCard, null),
        s.error ? h("div", { className: "dss-err" }, s.error) : null,
        h(Thread, null),
        h(Composer, null)
      );

      return h(
        "div",
        { className: "dss-root dss-float", ref: floatRef },
        body,
        h("div", { className: "dss-resize", onMouseDown: onResizeStart, title: "拖拽缩放" })
      );
    }

    function App() {
      var s = useStore();
      if (!s.expanded) return null;
      return h(CarrierFrame, null);
    }

    // ------------------------------------------------------------------
    // 左侧主栏 footer 唤起图标（sidebar.footer.action list 槽）
    // 与设置按钮同款：宽态整行（图标+文字）、rail 态圆形图标、同 hover/按压交互
    // ------------------------------------------------------------------
    function FooterIcon(props) {
      var s = useStore();
      var wide = !!(props && props.wide);
      return h(
        "button",
        {
          type: "button",
          className: "dss-footer-icon",
          "data-on": s.expanded ? "1" : "0",
          "data-rail": wide ? "0" : "1",
          title: "临时会话",
          "aria-haspopup": "dialog",
          "aria-expanded": s.expanded,
          onClick: function () {
            setState({ expanded: !s.expanded, carrier: "float" });
          },
        },
        h(
          "svg",
          {
            width: wide ? "16" : "18",
            height: wide ? "16" : "18",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          },
          h("path", {
            d: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
          })
        ),
        wide ? h("span", { className: "dss-footer-label" }, "临时会话") : null
      );
    }

    // ------------------------------------------------------------------
    // 设置面板（settings.section list 槽）
    // 三模式 select + API Key password（mode2 时展示）+ model + endpoint + 面板宽度
    // ------------------------------------------------------------------
    // 三模式 select + API Key password（mode2 时展示）+ model + endpoint + 面板宽度
    // ------------------------------------------------------------------
    // 已存 Key 的本地记忆：serve 端 apiKey 声明为 role("secret")，设置快照会
    // 整体移除该字段（值为 undefined），永远读不回明文。用 lastKnownApiKey
    // 记住最近一次落盘的 key，仅用于展示「已保存」状态与避免空串覆盖。
    var lastKnownApiKey = "";
    // 用户刚切过模式：短暂屏蔽快照回写把模式拉回旧值（写盘异步，快照可能
    // 先于落盘回来旧 mode，导致下面新增的 api/模型输入框瞬间消失）。
    var modePinnedUntil = 0;
    function isModePinActive() { return Date.now() < modePinnedUntil; }
    function settingsHasApiKey() { return !!(lastKnownApiKey || pluginSettings.apiKey); }
    function persistApiKey(value) {
      setPluginSetting("apiKey", value);
      if (value) lastKnownApiKey = value;
    }

    function SettingsCard(props) {
      useStore();
      var mode = pluginSettings.mode;
      var forceRenderState = useState(0);
      var forceRender = forceRenderState[1];
      // 三个字段的本地草稿：编辑期间任何外部快照回写都不得覆盖正在输入的值；
      // 未编辑过的字段每次渲染都从最新 pluginSettings 重新 seed（mode 切到 2
      // 后字段首次出现时拿到的是实时已存配置，而不是首次挂载时的旧快照）。
      var draftsRef = useRef({ apiKey: "", model: pluginSettings.model, endpoint: pluginSettings.endpoint });
      var editedRef = useRef({ apiKey: false, model: false, endpoint: false });
      var fields = ["apiKey", "model", "endpoint"];
      for (var fi = 0; fi < fields.length; fi++) {
        var fk = fields[fi];
        if (!editedRef.current[fk]) draftsRef.current[fk] = pluginSettings[fk];
      }
      function setDraft(key, value) {
        editedRef.current[key] = true;
        draftsRef.current[key] = value;
        forceRender(function (x) { return x + 1; });
      }
      function commitDraft(key) {
        var d = draftsRef.current[key];
        var base = key === "apiKey" ? settingsHasApiKey() ? (lastKnownApiKey || "") : "" : pluginSettings[key];
        if (key === "apiKey") {
          // 空串绝不覆盖已存 key；有真实输入才落盘（secret 快照读不回，用本地记忆比对）。
          if (d && d !== base) persistApiKey(d);
        } else if (d !== base) {
          setPluginSetting(key, d);
        }
        editedRef.current[key] = false;
        forceRender(function (x) { return x + 1; });
      }
      // 上下文长度：本地暂存，点「确定」才写入设置（避免 select 每次 change 都持久化导致卡顿）
      var ctxDraftState = useState(pluginSettings.contextLength || "2");
      var ctxDraft = ctxDraftState[0];
      var setCtxDraft = ctxDraftState[1];
      // 弹出动画时长：同上，选择暂存 + 确定保存
      var animDraftState = useState(pluginSettings.animMs != null ? pluginSettings.animMs : 500);
      var animDraft = animDraftState[0];
      var setAnimDraft = animDraftState[1];
      // 面板卸载（切设置页 / 模式切走）时把未提交草稿写回，避免丢输入。
      // cleanup 的闭包固定捕获首次渲染的草稿值，故经 ref 取最新草稿。
      var cleanupRef = useRef(false);
      useEffect(function () {
        return function () {
          if (cleanupRef.current) return;
          cleanupRef.current = true;
          var d = draftsRef.current;
          var edited = editedRef.current;
          if (edited.apiKey && d.apiKey && d.apiKey !== lastKnownApiKey) persistApiKey(d.apiKey);
          if (edited.model && d.model !== pluginSettings.model) setPluginSetting("model", d.model);
          if (edited.endpoint && d.endpoint !== pluginSettings.endpoint) setPluginSetting("endpoint", d.endpoint);
        };
      }, []);

      var hasSavedKey = settingsHasApiKey();

      return h(
        "div",
        { className: "dss-settings" },
        h(
          "div",
          { className: "dss-set-row" },
          h("div", { className: "dss-set-label" }, "回答引擎模式"),
          h(
            "select",
            { className: "dss-set-select", value: mode, onChange: function (e) { setMode(e.target.value); } },
            h("option", { value: "1" }, "1 · 复用 DSH 全局 Key"),
            h("option", { value: "2" }, "2 · 插件自带 Key"),
            h("option", { value: "3" }, "3 · 宿主 LLM（ctx.llm）")
          ),
          h("div", { className: "dss-set-hint" }, "三模式互斥、持久化、即时切换，无需重启 DSH。")
        ),
        h(
          "div",
          { className: "dss-set-row" },
          h("div", { className: "dss-set-label" }, "上下文长度"),
          h(
            "select",
            {
              className: "dss-set-select",
              value: ctxDraft,
              onChange: function (e) { setCtxDraft(e.target.value); },
            },
            h("option", { value: "1" }, "1 · 标准（120 条 / 40K 字符，省 token）"),
            h("option", { value: "2" }, "2 · 加长（600 条 / 200K 字符，推荐）"),
            h("option", { value: "3" }, "3 · 完整（5000 条 / 2M 字符，最接近通读全文，token 消耗大）")
          ),
          h(
            "button",
            {
              className: "dss-set-apply",
              onClick: function () { setPluginSetting("contextLength", ctxDraft); },
              title: "应用并保存",
            },
            "确定"
          ),
          h("div", { className: "dss-set-hint" }, "选择档位后点「确定」生效（控制临时会话能看到的对话条数与文件上限）。")
        ),
        h(
          "div",
          { className: "dss-set-row" },
          h("div", { className: "dss-set-label" }, "弹出动画时长"),
          h(
            "select",
            {
              className: "dss-set-select",
              value: String(animDraft),
              onChange: function (e) { setAnimDraft(Number(e.target.value)); },
            },
            h("option", { value: "0" }, "关闭（0ms）"),
            h("option", { value: "300" }, "快速（300ms）"),
            h("option", { value: "500" }, "标准（500ms，默认）"),
            h("option", { value: "800" }, "舒缓（800ms）"),
            h("option", { value: "1200" }, "缓慢（1200ms）")
          ),
          h(
            "button",
            {
              className: "dss-set-apply",
              onClick: function () {
                setPluginSetting("animMs", animDraft);
                applyAnimDuration();
              },
              title: "应用并保存",
            },
            "确定"
          ),
          h("div", { className: "dss-set-hint" }, "选择档位后点「确定」生效（0ms = 关闭动画）。")
        ),
        mode === "2"
          ? h(
              "div",
              null,
              h(
                "div",
                { className: "dss-set-row" },
                h("div", { className: "dss-set-label" }, "API Key"),
                h("input", {
                  className: "dss-set-input",
                  type: "password",
                  placeholder: hasSavedKey ? "●●●●（已保存，输入可替换）" : "sk-...",
                  value: draftsRef.current.apiKey,
                  onChange: function (e) { setDraft("apiKey", e.target.value); },
                  onBlur: function () { commitDraft("apiKey"); },
                  onKeyDown: function (e) { if (e.key === "Enter") commitDraft("apiKey"); },
                })
              ),
              h(
                "div",
                { className: "dss-set-row" },
                h("div", { className: "dss-set-label" }, "模型"),
                h("input", {
                  className: "dss-set-input",
                  placeholder: "deepseek-chat",
                  value: draftsRef.current.model,
                  onChange: function (e) { setDraft("model", e.target.value); },
                  onBlur: function () { commitDraft("model"); },
                  onKeyDown: function (e) { if (e.key === "Enter") commitDraft("model"); },
                })
              ),
              h(
                "div",
                { className: "dss-set-row" },
                h("div", { className: "dss-set-label" }, "API 基址"),
                h("input", {
                  className: "dss-set-input",
                  placeholder: "https://api.deepseek.com",
                  value: draftsRef.current.endpoint,
                  onChange: function (e) { setDraft("endpoint", e.target.value); },
                  onBlur: function () { commitDraft("endpoint"); },
                  onKeyDown: function (e) { if (e.key === "Enter") commitDraft("endpoint"); },
                })
              )
            )
          : null,
        h("div", { className: "dss-set-hint" }, "浮窗可自由拖动/缩放；左下角侧栏图标或 Ctrl+Shift+S 唤起。"),
        mode === "1"
          ? h("div", { className: "dss-set-hint" }, "使用 DSH 全局凭据（DEEPSEEK_API_KEY 环境变量或 ~/.dsh/.credentials.yaml）。")
          : null,
        mode === "2"
          ? h("div", { className: "dss-set-hint" }, hasSavedKey ? "已保存插件自带 Key；重新输入会替换旧值。" : "输入后回车 / 失焦即保存（Key 仅存储在本机 settings.yaml，界面不回显明文）。")
          : null,
        mode === "3"
          ? h("div", { className: "dss-set-hint" }, "走服务端 ctx.llm.stream，不读任何 key。需宿主 LLM 服务可用。")
          : null
      );
    }

    // ------------------------------------------------------------------
    // 会话监视：当前会话变化时重载上下文
    // ------------------------------------------------------------------
    function setupSessionWatcher(ctx) {
      function poll() {
        // 浮窗隐藏时暂停轮询（省资源）
        if (!getState().expanded) return;
        try {
          var sessions = ctx.get ? ctx.get("sessions", false) : null;
          var id = "";
          if (sessions && sessions.list && sessions.list.getSnapshot) {
            // 当前主对话 = sessions.list 快照的 current（用户当前选中的会话）
            var snap = sessions.list.getSnapshot();
            if (snap && snap.current) id = String(snap.current);
          }
          if (id) {
            if (String(id) !== getState().sessionId) loadContext(String(id)); // 自动导入主对话上下文
            else fetchContext(String(id)); // 实时刷新上下文（主对话新消息/文件变化即时可见）
          }
        } catch (e) {}
      }
      poll();
      var t = setInterval(poll, 2000);
      return function () {
        clearInterval(t);
      };
    }

    // ------------------------------------------------------------------
    // 全局快捷键 Ctrl+Shift+S 唤起浮窗
    // ------------------------------------------------------------------
    function setupHotkey() {
      if (typeof document === "undefined") return function () {};
      function onKey(e) {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "S" || e.key === "s")) {
          e.preventDefault();
          setState({ expanded: true, carrier: "float" });
        }
      }
      document.addEventListener("keydown", onKey);
      return function () {
        document.removeEventListener("keydown", onKey);
      };
    }

    // ------------------------------------------------------------------
    // 挂载
    // ------------------------------------------------------------------
    var mounted = false;
    function mount(ctx) {
      if (mounted || typeof document === "undefined") return;
      mounted = true;
      var container = document.createElement("div");
      container.id = "dsh-side-session-root";
      document.body.appendChild(container);
      try {
        reactDom.createRoot(container).render(h(App));
      } catch (e) {
        console.warn("[dsh-side-session] 挂载失败：" + String((e && e.message) || e));
      }
    }

    function apply(ctx) {
      ensureCss();
      bindSettings(ctx);

      ctx.effect(function () { return setupSessionWatcher(ctx); }, "dsh-side-session: session watcher");
      ctx.effect(function () { return mount(ctx); }, "dsh-side-session: mount");
      ctx.effect(function () { return setupHotkey(); }, "dsh-side-session: hotkey");

      // 左侧主栏 footer 唤起图标（list 槽，inject 嵌套写法）
      ctx.effect(function () {
        try {
          return ctx.slots.inject("sidebar.footer.action", function () {
            return ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-side-session", order: 220, label: "侧边临时会话" }, FooterIcon);
          }, "dsh-side-session");
        } catch (e) {
          console.warn("[dsh-side-session] sidebar.footer.action 槽不可用：" + String((e && e.message) || e));
        }
      }, "dsh-side-session: footer icon");

      // 设置面板（settings.section list 槽，inject 嵌套写法）
      ctx.effect(function () {
        try {
          return ctx.slots.inject("settings.section", function () {
            return ctx.slots.register({ name: "settings.section", id: "dsh-side-session", order: 80, label: function () { return "侧边临时会话"; } }, SettingsCard);
          }, "name");
        } catch (e) {
          console.warn("[dsh-side-session] settings.section 槽不可用：" + String((e && e.message) || e));
        }
      }, "dsh-side-session: settings");

      // 斜杠命令 /side-session（popupSelect：唤起浮窗 / 清空）
      ctx.effect(function () {
        try {
          if (!ctx.commandUi || typeof ctx.commandUi.register !== "function") return;
          return ctx.commandUi.register({
            name: "side-session",
            description: "临时会话",
            available: function () { return true; },
            ui: {
              kind: "popupSelect",
              options: function () {
                return Promise.resolve([
                  { id: "float", label: "唤起浮窗" },
                  { id: "clear", label: "清空临时会话" },
                ]);
              },
              onSelect: function (option) {
                if (option.id === "float") setState({ expanded: true, carrier: "float" });
                else if (option.id === "clear") clearThread();
              },
            },
          });
        } catch (e) {
          console.warn("[dsh-side-session] commandUi 注册失败：" + String((e && e.message) || e));
        }
      }, "dsh-side-session: slash command");
    }

    exports.apply = apply;
    exports.inject = ["slots", "settingsScope", "commandUi"];
    return module.exports;
  }
});

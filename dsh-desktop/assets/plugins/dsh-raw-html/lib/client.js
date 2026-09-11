/**
 * dsh-raw-html —— VCP 视觉通感协议支持（浏览器半侧）。
 *
 * 职责：
 * 1. 通过官方 conversation.chat.node slot 接管 assistant-step；仅当消息包含
 *    #vcp-root 且用户开启渲染时，使用隔离 Shadow DOM 渲染，其他内容复用官方
 *    Assistant 组件。插件渲染异常时由 slot 错误边界自动回退官方组件。
 * 2. 在 composer 尾部工具栏（发送按钮旁）注入「</>」按钮：点击弹出设置面板，
 *    内含两个独立开关：
 *    - 渲染 HTML：驱动 localStorage['dsh.rawHtml']（本插件渲染器读取）；
 *    - 美学注入：驱动 Host 侧美学协议注入（仅渲染开启时可用，置灰即强制关闭）。
 *    切换任一开关后自动强制刷新页面（新状态立即生效、全部消息重渲染）；
 *    面板底部另备「强制刷新页面」按钮，供调试注入代码时手动刷新。
 * 3. 注入 window.__dshInput(text)：VCP 按钮 onclick="input('...')" 经安全属性
 *    转换后桥接到这里，把文本填入输入框并发送。
 *
 * 本文件为手工维护的 __ModuleLoader__.load bundle（与 dsh-maid-emoji
 * 约定一致），不含 JSX；修改后执行 `node --check lib/client.js` 验证语法，
 * 刷新页面即生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-raw-html',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var RENDER_KEY = 'dsh.rawHtml'
    var AESTHETIC_KEY = 'dsh.rawHtmlAesthetic'
    var BTN_ID = 'dsh-raw-html-toggle'
    var PANEL_ID = 'dsh-raw-html-panel'
    /** 切换开关后延迟强制刷新页面的等待时间（ms）：先让状态落盘 + 上报 Host，再整页重载。 */
    var RELOAD_DELAY = 250
    /** Host 侧 RPC 调用器（可空）：开关切换时上报渲染/美学状态，驱动系统提示词注入。 */
    var hostRpc = null
    /** 延迟刷新定时器（防连点：后一次切换重置前一次）。 */
    var reloadTimer = null
    /** AgentTeams 团队模式（会话级；「更多模式」菜单行驱动，见 createPanel）。 */
    var teamsModeOn = false
    /** 面板内两个开关行的刷新回调（面板打开时挂载，关闭时清空）。 */
    var renderRowRefresh = null
    var aestheticRowRefresh = null

    // ---- 状态 ------------------------------------------------------------

    // 新安装默认关闭；只有用户明确开启后才渲染模型输出的 HTML。
    function isRenderEnabled() {
      try { return window.localStorage.getItem(RENDER_KEY) === '1' } catch (e) { return false }
    }
    function setRenderEnabled(on) {
      try { window.localStorage.setItem(RENDER_KEY, on ? '1' : '0') } catch (e) {}
    }
    /** 美学开关：无记录默认关闭。 */
    function isAestheticEnabled() {
      try { return window.localStorage.getItem(AESTHETIC_KEY) === '1' } catch (e) { return false }
    }
    function setAestheticEnabled(on) {
      try { window.localStorage.setItem(AESTHETIC_KEY, on ? '1' : '0') } catch (e) {}
    }
    /** 旧版单开关迁移：曾开启渲染（dsh.rawHtml=1）但无美学键 → 视为美学也开（保持旧体验，仅一次）。 */
    function migrateState() {
      try {
        if (window.localStorage.getItem(RENDER_KEY) === '1' && window.localStorage.getItem(AESTHETIC_KEY) === null) {
          window.localStorage.setItem(AESTHETIC_KEY, '1')
        }
      } catch (e) {}
    }

    // ---- DOM 定位（官方 data-* 标记，与 maid-atelier 皮肤同源）-------------

    function findComposer() {
      return document.querySelector('[data-composer-card]')
    }

    /** 尾部工具栏（发送按钮所在容器），找不到时回退到首行 / 卡片本身。 */
    function findTrailing(composer) {
      if (!composer) return null
      var t = composer.querySelector('[class*="trailing"]')
      if (t) return t
      var row = composer.querySelector(':scope > [class*="row"]')
      return row || composer
    }

    // 读取 DSH 原生 UI 当前生效的字体（跟随主人字体插件的设置）。
    // 下载按钮挂在 body 下，font-family:inherit 只继承 body 的默认字体，
    // 而主人用「另一个插件」统一改的是 DSH 面板/设置栏/左侧栏/composer 等
    // 原生 UI 区域的字体、body 未变 → 下载按钮字体不同步。故每次显示下载
    // 按钮时，从 DSH 原生元素（composer）读取计算后的字体同步过去。
    function nativeUIFontFamily() {
      try {
        var composer = findComposer()
        if (!composer) return null
        var ref = findTrailing(composer) || composer
        return window.getComputedStyle(ref).fontFamily || null
      } catch (e) { return null }
    }

    function findTextarea(composer) {
      if (!composer) return null
      return composer.querySelector('textarea') || composer.querySelector('[contenteditable="true"]')
    }

    function findSendButton(composer) {
      if (!composer) return null
      var primary = composer.querySelector('button[class*="primary"]')
      if (primary) return primary
      var btns = composer.querySelectorAll('button')
      for (var i = 0; i < btns.length; i++) {
        var aria = btns[i].getAttribute('aria-label') || ''
        if (/send|发送|submit/i.test(aria)) return btns[i]
      }
      return null
    }

    // ---- window.__dshInput：VCP 按钮 → 真实发送 ---------------------------

    /** 用原生 value setter 绕过 React 受控组件，再触发 input 事件。 */
    function setTextareaValue(ta, text) {
      var proto = ta.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(ta, text)
      ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    }

    function clickSend(composer) {
      var btn = findSendButton(composer)
      if (btn && !btn.disabled) {
        btn.click()
        return true
      }
      return false
    }

    /** 填入输入框并轮询点击发送（等待 React 状态同步后按钮解除 disabled）。 */
    function sendText(text) {
      var composer = findComposer()
      var ta = findTextarea(composer)
      if (!ta) {
        if (window.alert) window.alert('[dsh-raw-html] 未找到输入框，无法发送')
        return false
      }
      setTextareaValue(ta, String(text))
      var tries = 0
      var timer = window.setInterval(function () {
        tries += 1
        if (clickSend(composer) || tries > 20) window.clearInterval(timer)
      }, 100)
      return true
    }

    // ---- 「</>」按钮 + 设置面板（自 B 移植 · 2026-08-24）-------------------
    // 主题令牌（跟随皮肤）：--dsw-alias-* 为 DSH 设计系统别名层，各皮肤都会映射——
    // 按钮/面板自动契合用户切换的深色/浅色主题，看起来像原生 DSH 控件。
    function createButton() {
      var btn = document.createElement('button')
      btn.id = BTN_ID
      btn.type = 'button'
      btn.setAttribute('aria-haspopup', 'true')
      btn.title = '更多模式：AgentTeams 团队模式 / HTML 渲染与美学（渲染类开关切换后自动强制刷新）'
      btn.textContent = '模式'
      btn.style.cssText =
        'display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;' +
        'background:var(--dsw-alias-button-tool-bar-fill,rgba(84,85,87,.5));color:var(--dsw-alias-label-secondary,#555);font-size:12px;' +
        'font-family:inherit;cursor:pointer;white-space:nowrap;margin:0;flex:none;' +
        'transition:all .15s ease;'
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        togglePanel(btn)
      })
      return btn
    }

    /** 「更多模式」芯片挂载点：conversation.input.right 槽（order 4.5 →
     *  优化提示词按钮左边；列表按 order 升序渲染）。组件按会话挂载，
     *  每个会话拿到独立芯片；teamsMode 会话级状态随之复位。 */
    function registerModesChip(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
      ctx.slots.inject('conversation.input.right', function () {
        return ctx.slots.register({
          name: 'conversation.input.right',
          key: 'raw-html-modes',
          id: 'raw-html-modes',
          order: 4.5,
        }, ModesChip)
      })
    }

    function ModesChip() {
      var ref = React.useRef(null)
      React.useEffect(function () {
        var el = ref.current
        if (!el) return
        teamsModeOn = false // 会话级状态：切换会话即复位
        var btn = document.getElementById(BTN_ID)
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn)
        btn = createButton()
        el.appendChild(btn)
        return function () { if (btn.parentNode === el) el.removeChild(btn) }
      }, [])
      return h('div', {
        ref: ref,
        style: { display: 'inline-flex', alignItems: 'center', margin: '0 6px', flex: 'none' },
      })
    }

    // 面板内状态变化：刷新面板开关行 + 上报 Host
    function onChange() {
      if (renderRowRefresh) renderRowRefresh()
      if (aestheticRowRefresh) aestheticRowRefresh()
      syncHostState(hostRpc, isRenderEnabled(), isAestheticEnabled())
      window.dispatchEvent(new window.CustomEvent('dsh-raw-html-toggle', {
        detail: { render: isRenderEnabled(), aesthetic: isAestheticEnabled() },
      }))
    }

    /** 强制刷新浏览器：延迟一拍让 localStorage 状态落盘、Host 上报发出，再整页重载。
     *  刷新后渲染补丁以新状态重新加载、全部消息重渲染——方便观察开关效果与调试注入代码。 */
    function scheduleForceReload(sw) {
      if (reloadTimer) window.clearTimeout(reloadTimer)
      if (sw) {
        sw.textContent = '⟳ 刷新中'
        sw.style.opacity = '0.6'
      }
      reloadTimer = window.setTimeout(function () {
        window.location.reload()
      }, RELOAD_DELAY)
    }

    /** 生成一行开关：label + 描述 + ON/OFF 胶囊按钮。 */
    function makeRow(label, desc, getter, setter, disabledGetter) {
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 2px;'
      var left = document.createElement('div')
      left.style.cssText = 'flex:1;min-width:0;'
      var name = document.createElement('div')
      name.textContent = label
      name.style.cssText = 'font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111);line-height:1.4;'
      var d = document.createElement('div')
      d.textContent = desc
      d.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#666);line-height:1.45;margin-top:2px;'
      left.appendChild(name)
      left.appendChild(d)
      var sw = document.createElement('button')
      sw.type = 'button'
      function refresh() {
        var on = getter()
        var dis = disabledGetter()
        sw.textContent = on ? 'ON' : 'OFF'
        sw.disabled = dis
        sw.style.cssText =
          'min-width:44px;height:24px;padding:0 10px;border-radius:999px;font-size:11px;font-weight:600;flex:none;' +
          (dis ? 'opacity:.35;cursor:not-allowed;' : 'cursor:pointer;') +
          (on
            ? 'background:var(--dsw-alias-button-primary-fill,#0d1f33);color:var(--dsw-alias-label-primary-inverted,#fff);border:1px solid var(--dsw-alias-brand-primary,transparent);'
            : 'background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#555);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));')
      }
      sw.addEventListener('click', function () {
        if (disabledGetter()) return
        setter(!getter())
        onChange()
        scheduleForceReload(sw) // 切换后自动强制刷新：新状态立即生效，全部消息重渲染
      })
      row.appendChild(left)
      row.appendChild(sw)
      refresh()
      return { row: row, refresh: refresh }
    }

    function createPanel() {
      var panel = document.createElement('div')
      panel.id = PANEL_ID
      panel.setAttribute('role', 'menu')
      panel.style.cssText =
        'position:fixed;z-index:99999;width:248px;padding:10px 12px;' +
        'background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));' +
        'border-radius:var(--dsl-web-radius,12px);box-shadow:0 12px 34px rgba(0,0,0,.28);' +
        'font-family:inherit;color:var(--dsw-alias-label-primary,#111);'
      var title = document.createElement('div')
      title.textContent = '更多模式'
      title.style.cssText = 'font-size:11px;letter-spacing:.14em;color:var(--dsw-alias-label-secondary,#555);margin:0 2px 8px;'
      panel.appendChild(title)

      // AgentTeams 团队模式行（会话级开关）：开 = 发送 /agent-teams 激活；
      // 关 = 发送归档指令。与渲染类开关不同：发消息驱动，不刷新页面。
      var teamsRow = document.createElement('div')
      teamsRow.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 2px;'
      var teamsLeft = document.createElement('div')
      teamsLeft.style.cssText = 'flex:1;min-width:0;'
      var teamsName = document.createElement('div')
      teamsName.textContent = 'AgentTeams 团队模式'
      teamsName.style.cssText = 'font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111);line-height:1.4;'
      var teamsDesc = document.createElement('div')
      teamsDesc.textContent = '本会话进入多智能体协作（队长 / 子代理 / 任务 DAG）。开启发送 /agent-teams 激活；关闭发送归档指令。'
      teamsDesc.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#666);line-height:1.45;margin-top:2px;'
      teamsLeft.appendChild(teamsName)
      teamsLeft.appendChild(teamsDesc)
      var teamsSw = document.createElement('button')
      teamsSw.type = 'button'
      function refreshTeamsRow() {
        teamsSw.textContent = teamsModeOn ? 'ON' : 'OFF'
        teamsSw.style.cssText =
          'min-width:44px;height:24px;padding:0 10px;border-radius:999px;font-size:11px;font-weight:600;flex:none;cursor:pointer;' +
          (teamsModeOn
            ? 'background:var(--dsw-alias-button-primary-fill,#0d1f33);color:var(--dsw-alias-label-primary-inverted,#fff);border:1px solid var(--dsw-alias-brand-primary,transparent);'
            : 'background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#555);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));')
      }
      teamsSw.addEventListener('click', function () {
        teamsModeOn = !teamsModeOn
        refreshTeamsRow()
        sendText(teamsModeOn
          ? '/agent-teams'
          : '结束并归档当前 AgentTeams 团队。')
        window.setTimeout(closePanel, 200) // 让 sendText 的自动点击先落，再收起菜单
      })
      teamsRow.appendChild(teamsLeft)
      teamsRow.appendChild(teamsSw)
      refreshTeamsRow()
      panel.appendChild(teamsRow)

      var teamsDivider = document.createElement('div')
      teamsDivider.style.cssText = 'height:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.08));margin:6px 0;'
      panel.appendChild(teamsDivider)

      var hint = document.createElement('div')
      hint.textContent = '渲染类开关切换后自动强制刷新页面；团队模式开关即时发消息，不刷新'
      hint.style.cssText = 'font-size:10px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#777);margin:0 2px 8px;'
      panel.appendChild(hint)

      var renderRow = makeRow(
        '渲染 HTML',
        '把消息中的 HTML 渲染为真实界面（含公式/Mermaid/SVG）',
        isRenderEnabled,
        function (on) {
          setRenderEnabled(on)
          if (!on) setAestheticEnabled(false) // 渲染关闭 → 美学强制关闭
        },
        function () { return false }
      )
      renderRowRefresh = renderRow.refresh
      panel.appendChild(renderRow.row)

      var aesRow = makeRow(
        '美学注入',
        '注入四色系/明度/字体/SVG 装帧等规范，让输出更好看（仅渲染开启时可用）',
        isAestheticEnabled,
        setAestheticEnabled,
        function () { return !isRenderEnabled() }
      )
      aestheticRowRefresh = aesRow.refresh
      panel.appendChild(aesRow.row)

      var reloadBtn = document.createElement('button')
      reloadBtn.type = 'button'
      reloadBtn.textContent = '⟳ 强制刷新页面'
      reloadBtn.title = '立即强制刷新浏览器：重新加载渲染补丁并以当前状态重渲染全部消息（调试注入代码用）'
      reloadBtn.style.cssText =
        'width:100%;height:26px;margin-top:8px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.2));' +
        'border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);' +
        'font-size:11px;font-family:inherit;cursor:pointer;'
      reloadBtn.addEventListener('click', function () {
        reloadBtn.textContent = '⟳ 正在刷新…'
        reloadBtn.disabled = true
        scheduleForceReload()
      })
      panel.appendChild(reloadBtn)

      var aesBtn = document.createElement('button')
      aesBtn.type = 'button'
      aesBtn.textContent = '美学系统 ▸'
      aesBtn.title = '打开美学系统查看器：风格库色板 / 字体检测绿勾 / 外置字体库挂载'
      aesBtn.style.cssText =
        'width:100%;height:26px;margin-top:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));' +
        'border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);' +
        'font-size:11px;font-family:inherit;cursor:pointer;'
      aesBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        openAestheticsViewer()
      })
      panel.appendChild(aesBtn)
      return panel
    }

    function openPanel(anchor) {
      closePanel()
      var panel = createPanel()
      document.body.appendChild(panel)
      var rect = anchor.getBoundingClientRect()
      var left = Math.min(Math.max(8, rect.left + rect.width / 2 - 124), Math.max(8, window.innerWidth - 256))
      var top = rect.bottom + 6
      if (top + 236 > window.innerHeight) top = Math.max(8, rect.top - 242)
      panel.style.top = Math.round(top) + 'px'
      panel.style.left = Math.round(left) + 'px'

      var outside = function (e) {
        if (panel.contains(e.target)) return
        if (e.target === anchor || anchor.contains(e.target)) return
        closePanel()
      }
      var key = function (e) { if (e.key === 'Escape') closePanel() }
      panel._outside = outside
      panel._key = key
      // 延迟绑定，避免「打开面板的那次点击」立即触发关闭
      window.setTimeout(function () {
        document.addEventListener('click', outside)
      }, 0)
      document.addEventListener('keydown', key)
    }

    function closePanel() {
      renderRowRefresh = null
      aestheticRowRefresh = null
      var p = document.getElementById(PANEL_ID)
      if (!p) return
      if (p._outside) document.removeEventListener('click', p._outside)
      if (p._key) document.removeEventListener('keydown', p._key)
      p.remove()
    }

    function togglePanel(anchor) {
      if (document.getElementById(PANEL_ID)) {
        closePanel()
        return
      }
      openPanel(anchor)
    }

    // ---- Host 状态同步（驱动系统提示词里的 VCP 协议注入）-------------------

    function makeHostRpc(ctx) {
      try {
        var connection = (ctx && (ctx.get ? ctx.get('connection') : undefined)) || (ctx && ctx.connection)
        if (connection && connection.rpc && connection.rpc.call) {
          return connection.rpc.call.bind(connection.rpc)
        }
      } catch (e) {}
      return null
    }

    function syncHostState(rpc, render, aesthetic) {
      if (!rpc) return
      try {
        rpc('/dsh-raw-html', 'set-state', { render: render, aesthetic: aesthetic }).catch(function () {})
      } catch (e) {}
    }

    // ---- KaTeX 数学公式：自备全套（改名 CSS 防与 DSH 冲突）-------------------
    // DSH 前端内置 KaTeX（0.16.x）但为【延迟加载】：消息渲染（终帧挂载）时可能
    // 未就绪——JS 缺失则公式不渲染，或 CSS/字体未注册则公式 fallback 成普通字体
    // （先生实测「无报错但字体都是普通字体」的根因）。因此自备：
    //   - katex.min.js + auto-render.min.js：保证 window.katex / renderMathInElement 可用
    //   - katex-vd.css：katex.min.css 的【字体名全部加 _VD 后缀】（font-family 改名、
    //     url 文件名保留）→ 与 DSH 自带的 KaTeX_* 字体名【零冲突】，字体匹配唯一确定
    // 实测（puppeteer + 真实 Edge，v14/v15）：改名 CSS + 自备 JS → /vendor 字体 200
    // 加载、document.fonts.check('26px KaTeX_Main_VD')=true，黑板体/花体/哥特体/手写体
    // 全部正常；而注入原版 katex.min.css 会与 DSH 的 @font-face 同名冲突 → 公式
    // fallback 普通字体（v8 诊断证实：移除后 check 变 true）。
    // 生成方式：node 对 katex.min.css 做 (?<![\w/])KaTeX_[A-Za-z0-9]+ → $&_VD。

    function loadScriptOnce(id, src, onLoad) {
      var existing = document.getElementById(id)
      if (existing) {
        if (onLoad) onLoad()
        return
      }
      var s = document.createElement('script')
      s.id = id
      s.src = src
      s.async = true
      s.onload = function () { if (onLoad) onLoad() }
      document.head.appendChild(s)
    }

    function ensureMathAssets() {
      if (document.getElementById('dsh-raw-html-math-css')) return
      var css = document.createElement('link')
      css.id = 'dsh-raw-html-math-css'
      css.rel = 'stylesheet'
      css.href = '/vendor/katex-vd.css'
      document.head.appendChild(css)
      loadScriptOnce('dsh-raw-html-math-katex', '/vendor/katex.min.js', function () {
        loadScriptOnce('dsh-raw-html-math-autorender', '/vendor/auto-render.min.js', null)
      })
    }

    // Mermaid 图表引擎（VCP 卡片内 language-mermaid 代码块 → SVG）
    // 独立加载（不依赖 KaTeX 链）；本地 /vendor 资源秒加载，mermaid 未就绪时
    // 渲染层 processMath 轮询重试（同 KaTeX 模式）。
    // 加载完成后调用渲染层 warmupMermaid()：提前 initialize 引擎，首次图表
    // 渲染省去初始化时间（首图更快出现）。
    function ensureMermaidAssets() {
      loadScriptOnce('dsh-raw-html-mermaid', '/vendor/mermaid.min.js', function () {
        if (window.__vcpMath && typeof window.__vcpMath.warmupMermaid === 'function') {
          try { window.__vcpMath.warmupMermaid() } catch (e) { /* 预热失败不阻断 */ }
        }
      })
    }

    // VCP 色彩引擎（data-vcp-preset → --vcp-* 色板变量 · 自 B 移植 2026-08-24）
    // 模型只写声明（data-vcp-preset / data-vcp-soul / data-vcp-accent），hex 由引擎
    // 确定性生成（流式重建结果恒定、对比度/色域闭环保证）。/vendor 秒加载；引擎未就绪时
    // 渲染层 chromeForProps/applyColorVars 静默跳过，下一帧重试。
    function ensureColorEngine() {
      if (window.VCPColorEngine || window.__vcpColor) return
      loadScriptOnce('dsh-raw-html-color-engine', '/vendor/VCPColorEngine.js', null)
    }

    // ---- EAC assistant-step 渲染适配 -------------------------------------
    //
    // 旧实现修改 dsh-web-frontend 的压缩 Markdown bundle。这里改为使用内核
    // 已公开的 conversation.chat.node keyed slot：保留官方 assistant-step
    // 组件作为普通内容和故障回退，只接管包含 #vcp-root 的文本块。

    var officialAssistantComponent = null
    var rawHtmlCardSeq = 0
    var VCP_ROOT_RE = /<div\b[^>]*\bid\s*=\s*(['"])vcp-root\1[^>]*>/i

    function hasVcpRoot(text) {
      return typeof text === 'string' && VCP_ROOT_RE.test(text)
    }

    function unwrapVcpFences(text) {
      return String(text || '').replace(/```(?:html)?[ \t]*\r?\n([\s\S]*?)```/gi, function (all, body) {
        return hasVcpRoot(body) ? body : all
      })
    }

    function includeTrailingVcpStyles(text, end) {
      var rest = text.slice(end)
      var consumed = 0
      while (true) {
        var match = /^\s*<style\b[^>]*>[\s\S]*?<\/style\s*>/i.exec(rest.slice(consumed))
        if (!match) break
        consumed += match[0].length
      }
      return end + consumed
    }

    function findVcpEnd(text, start) {
      var token = /<\/?div\b[^>]*>/gi
      token.lastIndex = start
      var depth = 0
      var match
      while ((match = token.exec(text))) {
        if (/^<\s*\/div/i.test(match[0])) depth -= 1
        else if (!/\/\s*>$/.test(match[0])) depth += 1
        if (depth === 0) return includeTrailingVcpStyles(text, token.lastIndex)
      }
      return text.length
    }

    function splitVcpSegments(text) {
      var source = unwrapVcpFences(text)
      var segments = []
      var cursor = 0
      while (cursor < source.length) {
        var rest = source.slice(cursor)
        var match = VCP_ROOT_RE.exec(rest)
        if (!match) {
          if (rest) segments.push({ kind: 'official', text: rest })
          break
        }
        var start = cursor + match.index
        if (start > cursor) segments.push({ kind: 'official', text: source.slice(cursor, start) })
        var end = findVcpEnd(source, start)
        segments.push({ kind: 'vcp', html: source.slice(start, end) })
        cursor = end
      }
      return segments
    }

    // CSS url() 白名单：模型可控 CSS 里的外链 url（background:url(//evil.com/…)、
    // url(http://…) 等）会随渲染向第三方发起请求，可做追踪像素/数据外带。
    // 因此只放行不产生跨域请求的形态：
    //   · #…            同文档引用：SVG 渐变/裁剪 url(#g)、应用内 #/ 路由相对路径
    //   · /…（非 //）   同源根相对路径：插件文档约定的 /fonts/… 字体契约
    //                  （DESIGN.md / VCP-INTERACTIONS §8，下载内嵌也依赖它），
    //                  同源请求无第三方外带面；协议相对 //… 明确不放行
    //   · data:image/…  内联图片数据；data:text/html 等其余 data: 一律不放行
    // 其余（http(s)、协议相对 //、javascript:、未知协议、其余 data:）整体替换为
    // url(about:blank)，三种引号形态（"…"、'…'、无引号）均覆盖。白名单按原始
    // 文本判定。注意原注释「转义形态无法命中白名单只会落入替换分支」是错的：
    // 正则的引号分支 [^"]* 遇到 CSS 转义引号（\"）会提前失配，导致整个 url()
    // 匹配失败、原文存活（实测 url("//evil.com/\"x") 逐字节通过）。因此：
    //   1) 匹配正则必须转义感知（\\ 消费转义对，引号串/裸串都一样）；
    //   2) 判定前先把 CSS 转义解码（\73→s、\"→"），按浏览器语义判定；
    //   3) 未闭合引号串 url("… 兜底吞掉（fail-closed）。
    function cssUnescape(value) {
      return String(value).replace(/\\([0-9a-fA-F]{1,6}\s|[0-9a-fA-F]{1,6}|.)/g, function (all, esc) {
        if (/^[0-9a-fA-F]/.test(esc)) {
          var cp = parseInt(esc.trim(), 16)
          return String.fromCodePoint(!isNaN(cp) && cp <= 0x10ffff && cp > 0 ? cp : 0xfffd)
        }
        return esc
      })
    }

    // 转义感知的 @import 剥离：@\69 mport 这类 at-keyword 转义浏览器照样执行，
    // 字面正则 /\@import/ 打不到。逐字符扫描，@ 后解码 ident 命中 import 即
    // 跳到下一个分号（@import 无块形态），其余原样拷贝。
    function stripCssImports(css) {
      var out = ''
      var i = 0
      var n = css.length
      while (i < n) {
        var ch = css.charAt(i)
        if (ch !== '@') { out += ch; i++; continue }
        var j = i + 1
        var ident = ''
        while (j < n) {
          var c = css.charAt(j)
          if (c === '\\') {
            var m = /^\\([0-9a-fA-F]{1,6})(\s)?/.exec(css.slice(j, j + 9))
            if (m) {
              var cp2 = parseInt(m[1], 16)
              ident += String.fromCodePoint(!isNaN(cp2) && cp2 <= 0x10ffff && cp2 > 0 ? cp2 : 0xfffd)
              j += m[0].length
              continue
            }
            if (j + 1 < n) { ident += css.charAt(j + 1); j += 2; continue }
            j++
            continue
          }
          if (/[a-zA-Z0-9_-]/.test(c)) { ident += c; j++; continue }
          break
        }
        if (ident.toLowerCase() === 'import') {
          while (j < n && css.charAt(j) !== ';') j++
          if (j < n) j++
          i = j
          continue
        }
        out += ch
        i++
      }
      return out
    }

    function sanitizeCssUrl(all, dq, sq, bare) {
      var value = dq != null ? dq : sq != null ? sq : bare
      value = cssUnescape(String(value == null ? '' : value)).trim()
      if (!value) return 'url()'
      // 判定按解码后语义；放行时回原文（all）——原文解码后与判定值恒等，
      // 不存在「解码后允许但原文更危险」的形态。
      if (value.charAt(0) === '#') return all
      if (value.charAt(0) === '/' && value.charAt(1) !== '/') return all
      if (/^data:image\//i.test(value)) return all
      return 'url(about:blank)'
    }

    function sanitizeCss(css) {
      return stripCssImports(String(css || ''))
        .replace(/expression\s*\([^)]*\)/gi, '')
        .replace(/url\s*\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|((?:[^)'"\\]|\\[\s\S])*))\s*\)/gi, sanitizeCssUrl)
        // fail-closed：未闭合引号串的 url("…/url('… 吞到样式表尾（浏览器对
        // 未闭合串同样吞到块尾，判定面必须与浏览器一致，兜底即中和）。
        .replace(/url\s*\(\s*"(?:[^"\\]|\\[\s\S])*$/gi, 'url(about:blank)')
        .replace(/url\s*\(\s*'(?:[^'\\]|\\[\s\S])*$/gi, 'url(about:blank)')
        .replace(/(^|[;{])\s*(?:behavior|-moz-binding)\s*:[^;}]*(?=[;}])/gi, '$1')
        .replace(/(^|[;{])\s*position\s*:\s*(?:fixed|sticky)\s*;?/gi, '$1')
        .replace(/(^|[;{])\s*content\s*:[^;}]*(?=[;}])/gi, '$1')
        .replace(/z-index\s*:\s*(-?\d+)\s*;?/gi, function (all, raw) {
          return Math.abs(Number(raw)) >= 1000 ? '' : all
        })
    }

    function isAllowedUrl(value, image) {
      var raw = String(value || '').trim()
      if (!raw) return false
      var lower = raw.toLowerCase()
      if (lower.indexOf('//') === 0) return false
      if (lower.charAt(0) === '#' || (lower.charAt(0) === '/' && lower.charAt(1) !== '/')) return true
      if (/^https?:/i.test(raw)) return true
      if (!image && /^mailto:/i.test(raw)) return true
      if (image && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(raw)) return true
      return !/^[a-z][a-z0-9+.-]*:/i.test(raw)
    }

    // 脚本/嵌套浏览上下文类标签整体移除。SMIL 动画元素（animate/set/animateTransform）
    // 会在渲染期间动态改写其他元素的属性（如把 <a> 的 href 动画成 javascript: 协议），
    // 让静态属性净化失效，因此与脚本类标签一并整体禁止。animateTransform 用
    // 两种大小写形态登记：SVG 命名空间内解析器会调整为驼峰 localName（大小写敏感），
    // SVG 外的未知元素归 HTML 命名空间（大小写不敏感匹配），双写确保两条路径都命中。
    var VCP_BLOCKED_TAGS =
      'script,iframe,object,embed,base,meta,link,animate,set,animatetransform,animateTransform'

    // 单元素净化：内联样式清洗 + 属性白名单化 + 外链隔离。
    // 抽成独立函数，供 sanitizeVcpTree 对 <template> content 子树复用。
    function sanitizeVcpElement(el) {
      if (el.localName === 'style') {
        el.textContent = sanitizeCss(el.textContent)
        return
      }
      var attrs = Array.prototype.slice.call(el.attributes || [])
      for (var ai = 0; ai < attrs.length; ai++) {
        var attr = attrs[ai]
        var name = attr.name.toLowerCase()
        var value = attr.value
        if (name === 'onclick') {
          var inputMatch = /^input\s*\(\s*(['"])([\s\S]*?)\1\s*\)\s*;?\s*$/.exec(value)
          if (inputMatch) el.setAttribute('data-vcp-input', inputMatch[2])
          el.removeAttribute(attr.name)
          continue
        }
        if (/^on/i.test(name) || name === 'srcdoc' || name === 'srcset' || name === 'action' || name === 'formaction') {
          el.removeAttribute(attr.name)
          continue
        }
        if (name === 'style') {
          var safeStyle = sanitizeCss(value)
          if (safeStyle.trim()) el.setAttribute('style', safeStyle)
          else el.removeAttribute('style')
          continue
        }
        if (name === 'href' || name === 'xlink:href') {
          if (!isAllowedUrl(value, false)) el.removeAttribute(attr.name)
          continue
        }
        if (name === 'src' || name === 'poster') {
          if (!isAllowedUrl(value, true)) el.removeAttribute(attr.name)
        }
      }
      if (el.localName === 'a') {
        // http(s) 外链若在当前窗口点击，会把整个 Web UI 导航离站：统一改为新窗口
        // 打开；rel="noopener noreferrer" 切断新窗口对 window.opener 的访问，
        // 防止外站反向操控本页（反向标签劫持）。
        var linkHref = (el.getAttribute('href') || '').trim()
        if (/^https?:/i.test(linkHref)) el.setAttribute('target', '_blank')
        if (el.getAttribute('target') === '_blank') {
          el.setAttribute('rel', 'noopener noreferrer')
        }
      }
    }

    // 子树净化。<template> 的 content 是独立 DocumentFragment，
    // querySelectorAll('*') 不会进入其中——模板内的节点原本会整体绕过属性净化，
    // 在模板被克隆/实例化时原样生效，必须对每个 template 的 content 显式递归
    // （嵌套模板同样覆盖）。危险标签移除也按子树执行，模板内的脚本类/SMIL
    // 元素同样无处遁形。
    function sanitizeVcpTree(root) {
      var blocked = root.querySelectorAll(VCP_BLOCKED_TAGS)
      for (var bi = 0; bi < blocked.length; bi++) blocked[bi].remove()
      var elements = root.querySelectorAll('*')
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i]
        sanitizeVcpElement(el)
        if (el.localName === 'template' && el.content) sanitizeVcpTree(el.content)
      }
    }

    function sanitizeVcpHtml(rawHtml) {
      var parser = new window.DOMParser()
      var doc = parser.parseFromString(String(rawHtml || ''), 'text/html')
      if (!doc.body || !doc.body.querySelector('[id="vcp-root"]')) return ''
      sanitizeVcpTree(doc.body)
      return doc.body.innerHTML
    }

    function applyVcpColorVars(root) {
      var engine = window.__vcpColor || window.VCPColorEngine
      if (!engine || typeof engine.generate !== 'function') return
      var nodes = root.querySelectorAll('[data-vcp-preset],[data-vcp-movement],[data-vcp-soul],[data-vcp-accent]')
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i]
        try {
          var opts = {}
          if (el.dataset.vcpPreset) opts.movement = el.dataset.vcpPreset
          else if (el.dataset.vcpMovement) opts.movement = el.dataset.vcpMovement
          if (el.dataset.vcpMode) opts.mode = el.dataset.vcpMode
          if (el.dataset.vcpAccent) {
            if (el.dataset.vcpAccent.charAt(0) === '#') opts.accentHex = el.dataset.vcpAccent
            else opts.accentHue = parseFloat(el.dataset.vcpAccent)
          }
          if (el.dataset.vcpSoul) {
            var soul = el.dataset.vcpSoul.split(',')
            var soulNames = ['thermalSoul', 'valence', 'arousal', 'entropy']
            for (var si = 0; si < soulNames.length; si++) {
              var n = parseFloat(soul[si])
              if (!isNaN(n)) opts[soulNames[si]] = n
            }
          }
          var palette = engine.generate(opts)
          var hex = palette && palette.hex ? palette.hex : {}
          for (var key in hex) {
            if (!Object.prototype.hasOwnProperty.call(hex, key)) continue
            var kebab = key.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase() })
            el.style.setProperty('--vcp-' + kebab, hex[key])
          }
        } catch (e) {}
      }
    }

    function hydrateVcpCard(root, streaming) {
      applyVcpColorVars(root)
      if (streaming) return
      try {
        if (typeof window.renderMathInElement === 'function') {
          window.renderMathInElement(root, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '\\[', right: '\\]', display: true },
              { left: '\\(', right: '\\)', display: false },
            ],
            ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
            throwOnError: false,
          })
        }
      } catch (e) {}
      try {
              var mmPending = []
      var mmSeq = 0
      function vcpRenderDiagrams() {
        var codeNodes = root.querySelectorAll('pre > code.language-mermaid')
        for (var i = 0; i < codeNodes.length; i++) {
          var code = codeNodes[i]
          var box = document.createElement('div')
          box.className = 'mermaid'
          box.textContent = code.textContent
          code.parentNode.replaceWith(box)
        }
        mmPending = Array.prototype.slice.call(root.querySelectorAll('.mermaid:not([data-processed])'))
      }
      function vcpRenderOne(idx) {
        if (idx >= mmPending.length) return
        if (!window.mermaid || typeof window.mermaid.render !== 'function') {
          window.setTimeout(function () { vcpRenderOne(idx) }, 250)
          return
        }
        var el = mmPending[idx]
        var src = (el.textContent || '').trim()
        mmSeq += 1
        window.mermaid.render('vcp-mmd-' + mmSeq, src).then(function (res) {
          var svg = res && res.svg
          if (svg) {
            el.innerHTML = svg
            el.setAttribute('data-processed', '1')
            var s = el.querySelector('svg')
            if (s) {
              s.removeAttribute('width')
              s.style.width = '100%'
              s.style.height = 'auto'
              s.setAttribute('preserveAspectRatio', 'xMidYMid meet')
            }
          } else {
            el.textContent = src
          }
          vcpRenderOne(idx + 1)
        }).catch(function () {
          el.textContent = src
          vcpRenderOne(idx + 1)
        })
      }
      vcpRenderDiagrams()
      vcpRenderOne(0)      } catch (e) {}
    }

    var VCP_SHADOW_BASE =
      '<style data-eac-vcp-base>' +
      ':host{display:block;min-width:0;max-width:100%;isolation:isolate;overflow:auto;overscroll-behavior:contain;}' +
      '*,*::before,*::after{box-sizing:border-box;}' +
      '[id="vcp-root"]{max-width:100%;overflow-wrap:anywhere;}' +
      'img,svg,video,canvas{max-width:100%;height:auto;}' +
      'button,[data-vcp-input]{font:inherit;}' +
      '</style>' +
      '<link rel="stylesheet" href="/vendor/katex-vd.css">'

    function RawHtmlCard(props) {
      var hostRef = React.useRef(null)
      var cardIdRef = React.useRef(null)
      if (cardIdRef.current === null) {
        rawHtmlCardSeq += 1
        cardIdRef.current = 'dsh-vcp-card-' + rawHtmlCardSeq
      }
      var sanitized = React.useMemo(function () {
        return sanitizeVcpHtml(props.html)
      }, [props.html])

      React.useLayoutEffect(function () {
        var host = hostRef.current
        if (!host || !sanitized) return undefined
        var shadow = host.shadowRoot || host.attachShadow({ mode: 'open' })
        shadow.innerHTML = VCP_SHADOW_BASE + sanitized
        var click = function (event) {
          var path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
          for (var i = 0; i < path.length; i++) {
            var node = path[i]
            if (!node || !node.getAttribute) continue
            var text = node.getAttribute('data-vcp-input')
            if (text !== null) {
              event.preventDefault()
              event.stopPropagation()
              if (typeof window.__dshInput === 'function') window.__dshInput(text)
              return
            }
          }
        }
        shadow.addEventListener('click', click)
        var timer = window.setTimeout(function () { hydrateVcpCard(shadow, props.streaming) }, 0)
        return function () {
          window.clearTimeout(timer)
          shadow.removeEventListener('click', click)
        }
      }, [sanitized, props.streaming])

      if (!sanitized) {
        return h('pre', { className: 'dsh-vcp-invalid' }, props.html)
      }
      return h('div', {
        ref: hostRef,
        id: cardIdRef.current,
        className: 'dsh-vcp-shadow-host',
        'data-vcp-card-host': 'true',
      })
    }

    function cloneAssistantProps(props, blocks, status) {
      var data = Object.assign({}, props.node.data, { blocks: blocks })
      if (status) data.status = status
      return Object.assign({}, props, {
        node: Object.assign({}, props.node, { data: data }),
      })
    }

    function RawHtmlAssistant(props) {
      if (!officialAssistantComponent || !isRenderEnabled()) {
        return officialAssistantComponent ? h(officialAssistantComponent, props) : null
      }
      var data = props.node && props.node.data
      var blocks = data && Array.isArray(data.blocks) ? data.blocks : []
      var descriptors = []
      var officialBlocks = []
      var foundVcp = false

      function flushOfficial() {
        if (!officialBlocks.length) return
        descriptors.push({ kind: 'official', blocks: officialBlocks })
        officialBlocks = []
      }

      for (var bi = 0; bi < blocks.length; bi++) {
        var block = blocks[bi]
        if (!block || block.kind !== 'text' || !hasVcpRoot(block.text)) {
          officialBlocks.push(block)
          continue
        }
        var parts = splitVcpSegments(block.text)
        for (var pi = 0; pi < parts.length; pi++) {
          var part = parts[pi]
          if (part.kind === 'official') {
            if (part.text) officialBlocks.push(Object.assign({}, block, { text: part.text }))
          } else {
            foundVcp = true
            flushOfficial()
            descriptors.push({ kind: 'vcp', html: part.html })
          }
        }
      }
      flushOfficial()
      if (!foundVcp) return h(officialAssistantComponent, props)

      return h('div', { className: 'dsh-vcp-assistant', 'data-vcp-assistant': 'true' },
        descriptors.map(function (item, index) {
          if (item.kind === 'vcp') {
            return h(RawHtmlCard, {
              key: 'vcp-' + index,
              html: item.html,
              streaming: data.status === 'running',
            })
          }
          var status = data.status
          if (status === 'interrupted' && index !== descriptors.length - 1) status = 'settled'
          return h(officialAssistantComponent,
            Object.assign({ key: 'official-' + index }, cloneAssistantProps(props, item.blocks, status)))
        }))
    }

    function isReactComponentType(component) {
      if (typeof component === 'function' || typeof component === 'string') return true
      // React.memo() / React.forwardRef() return object component types.
      return component !== null && typeof component === 'object'
    }

    function registerAssistantRenderer(ctx) {
  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
  var takeoverDone = false
  function tryTakeover() {
    if (takeoverDone) return true
    var entries = typeof ctx.slots.entries === 'function' ? ctx.slots.entries('conversation.chat.node') : []
    var official = null
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (entry && entry.options && entry.options.key === 'assistant-step' && entry.component !== RawHtmlAssistant) {
        official = entry
        break
      }
    }
    if (!official || !isReactComponentType(official.component)) return false
    officialAssistantComponent = official.component
    takeoverDone = true
    ctx.slots.inject('conversation.chat.node', function () {
      return ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'assistant-step',
        priority: -1,
        locale: typeof official.locale === 'string' ? official.locale : 'conversation'
      }, RawHtmlAssistant)
    })
    return true
  }
  if (!tryTakeover()) {
    var retries = 0
    var retryTimer = setInterval(function () {
      retries++
      if (tryTakeover()) { clearInterval(retryTimer); return }
      if (retries >= 48) {
        clearInterval(retryTimer)
        console.warn('[dsh-raw-html] assistant-step renderer not found after retries; keeping official UI')
      }
    }, 250)
  }
}
    // ---- 卡片下载：hover 浮出「⤓ 下载 HTML」按钮 ----------------------------
    // 需求：渲染出的 VCP 卡片（装帧小说 / 图表 / 卡片）可下载为【自包含 HTML】存档。
    // 实现要点：
    //  - 全局单例浮动按钮（position:fixed 跟随 hover 的 #vcp-root 卡片右上角），
    //    事件委托定位，不往 React DOM 里插节点 → 对流式重建免疫。
    //  - 下载时取 card.outerHTML，把卡片内 <style> 的 @font-face 字体转 data URI 内嵌：
    //    · 内置精选 /fonts/Lanxi-*.woff2（7 款 OFL 开源）→ 内嵌
    //    · KaTeX /vendor/fonts/*.woff2（OFL 开源）→ 内嵌（只 woff2，删 woff/ttf 声明省体积）
    //    · 外置大库 /fonts/<子目录>/*.ttf（可能商业授权）→ 不内嵌，保留相对路径（本机可看）
    //  - Mermaid 已渲染为内联 SVG，自包含；表情包 <img> 为绝对 URL，本机打开仍可加载。

    var DL_BTN_ID = 'dsh-raw-html-dl'
    var dlBtn = null
    var dlCard = null
    var dlHideTimer = null
    var dlInitDone = false
    var dlCont = null

    function blobToDataUri(blob) {
      return new window.Promise(function (resolve, reject) {
        var fr = new window.FileReader()
        fr.onload = function () { resolve(fr.result) }
        fr.onerror = function () { reject(fr.error) }
        fr.readAsDataURL(blob)
      })
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    function extractCardTitle(card) {
      var h = card.querySelector('h1, h2, h3, .title')
      var t = h ? h.textContent.replace(/\s+/g, ' ').trim() : ''
      if (!t) {
        var m = card.querySelector('.motto, .headline')
        if (m) t = m.textContent.replace(/\s+/g, ' ').trim().slice(0, 20)
      }
      t = t.replace(/[\\/:*?"<>|\n\r]+/g, '').trim().slice(0, 40)
      return t || 'vcp-card-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    }

    // 收集「沉在卡尾」的 <style> 兄弟：VCP 规范要求 <style> 写在 #vcp-root 之后
    // （卡尾），渲染后它是 card 的【兄弟元素】而非子元素——downloadCard 只取
    // card.outerHTML 会漏掉它，导致下载的 HTML 丢失背景/字体等全部样式。
    // 按本消息唯一 id（#vcp-msg-N）过滤，只收属于这张卡、且不在 card 内部的 style。
    function collectSiblingStyles(card) {
      var root = card.parentElement
      if (!root) return ''
      var id = card.getAttribute('id')
      var styles = root.querySelectorAll('style[data-plugin="vcp-message"]')
      var out = []
      for (var i = 0; i < styles.length; i++) {
        var s = styles[i]
        if (card.contains(s)) continue
        if (id && s.textContent.indexOf('#' + id) === -1) continue
        out.push(s.outerHTML)
      }
      return out.join('\n')
    }

    function downloadCard(card) {
      var html = card.outerHTML
      // v6.19 修复：把沉卡尾的兄弟 <style> 拼回下载内容（否则下载丢背景/字体）。
      var siblingStyle = collectSiblingStyles(card)
      if (siblingStyle) html = siblingStyle + '\n' + html
      // 开源字体白名单：内置精选 Lanxi + KaTeX woff2；外置大库字体不在此列，保留相对路径
      var urlRe = /url\(\s*(['"]?)(\/fonts\/Lanxi-[A-Za-z0-9]+\.woff2|\/vendor\/fonts\/[^'"()\s]+\.woff2)\1\s*\)/g
      var urls = {}
      var m
      while ((m = urlRe.exec(html))) urls[m[2]] = true

      var katexCss = ''
      var katexPromise = window.Promise.resolve()
      if (card.querySelector('.katex')) {
        katexPromise = window.fetch('/vendor/katex-vd.css')
          .then(function (r) { return r.text() })
          .then(function (kc) {
            kc = kc.replace(/,url\(fonts\/[^)]*\.woff\)\s*format\([^)]*\)/g, '')
            kc = kc.replace(/,url\(fonts\/[^)]*\.ttf\)\s*format\([^)]*\)/g, '')
            var kre = /url\(fonts\/([^)]*\.woff2)\)/g
            var km
            while ((km = kre.exec(kc))) urls['/vendor/fonts/' + km[1]] = true
            katexCss = kc
          })
          .catch(function () {})
      }

      katexPromise.then(function () {
        var map = {}
        var jobs = Object.keys(urls).map(function (u) {
          return window.fetch(u)
            .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.blob() })
            .then(blobToDataUri)
            .then(function (uri) { map[u] = uri })
            .catch(function () {})
        })
        return window.Promise.all(jobs).then(function () { return map })
      }).then(function (map) {
        html = html.replace(urlRe, function (all, q, u) {
          return map[u] ? 'url(' + map[u] + ')' : all
        })
        if (katexCss) {
          katexCss = katexCss.replace(/url\(fonts\/([^)]*\.woff2)\)/g, function (all, name) {
            var u = '/vendor/fonts/' + name
            return map[u] ? 'url(' + map[u] + ')' : all
          })
        }
        var title = extractCardTitle(card)
        var doc =
          '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
          '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
          '<title>' + escapeHtml(title) + '</title>\n' +
          (katexCss ? '<style>' + katexCss + '</style>\n' : '') +
          '</head>\n<body style="margin:0;">\n' + html + '\n</body>\n</html>'

        var blob = new window.Blob([doc], { type: 'text/html;charset=utf-8' })
        var a = document.createElement('a')
        var objUrl = window.URL.createObjectURL(blob)
        a.href = objUrl
        a.download = title + '.html'
        document.body.appendChild(a)
        a.click()
        a.remove()
        window.setTimeout(function () { window.URL.revokeObjectURL(objUrl) }, 10000)
      })
    }

    function buildDlButton() {
      var btn = document.createElement('button')
      btn.id = DL_BTN_ID
      btn.type = 'button'
      btn.textContent = '⤓ 下载 HTML'
      btn.title = '下载此卡片为自包含 HTML（内嵌开源字体，任何地方打开都保持装帧效果）'
      btn.style.cssText =
        'display:none;position:fixed;z-index:2147483000;top:0;right:0;height:28px;padding:0 12px;' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;' +
        'background:var(--dsw-alias-bg-overlay,#fff);' +
        'color:var(--dsw-alias-label-primary,#111);' +
        'font-size:11px;font-family:inherit;font-weight:600;cursor:pointer;white-space:nowrap;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.14);'
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation()
        ev.preventDefault()
        var c = dlCard
        if (c) downloadCard(c)
      })
      return btn
    }

    function nearestScrollContainer(el) {
      var n = el
      while (n && n.nodeType === 1) {
        var cs = window.getComputedStyle(n)
        var ov = cs.overflowY
        if ((ov === 'auto' || ov === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n
        var root = n.getRootNode ? n.getRootNode() : null
        var next = n.parentElement
        if (!next && root && root.host) next = root.host
        if (!next) break
        n = next
      }
      return document.scrollingElement || document.documentElement
    }
    function positionDlButton(card) {
      var r = card.getBoundingClientRect()
      dlBtn.style.top = Math.max(6, r.top + 8) + 'px'
      dlBtn.style.right = Math.max(6, window.innerWidth - r.right + 8) + 'px'
    }

    function scheduleDlHide() {
      if (dlHideTimer) window.clearTimeout(dlHideTimer)
      dlHideTimer = window.setTimeout(function () {
        if (dlBtn) dlBtn.style.display = 'none'
        dlCard = null; dlCont = null
      }, 260)
    }

    function showDlFor(card) {
      if (!dlBtn || !dlBtn.isConnected) {
        dlBtn = buildDlButton()
        document.body.appendChild(dlBtn)
      }
      dlCard = card
      // 每次显示时同步 DSH 原生 UI 的字体（跟随主人字体插件的实时设置）
      var nf = nativeUIFontFamily()
      if (nf) dlBtn.style.fontFamily = nf
      dlCont = nearestScrollContainer(card)
      var vr = card.getBoundingClientRect()
      var vc = (dlCont || document.documentElement).getBoundingClientRect()
      if (vr.top < vc.top - 4 || vr.top + 40 > vc.bottom) {
        if (dlBtn) dlBtn.style.display = 'none'
        dlCard = null
        dlCont = null
        return
      }
      positionDlButton(card)
      dlBtn.style.display = 'inline-block'
      if (dlHideTimer) window.clearTimeout(dlHideTimer)
    }

    function initDownload() {
      if (dlInitDone) return
      dlInitDone = true
                              var hoverCard = null
      var dlRafRun = false
      function hideDlNow() {
        if (dlHideTimer) window.clearTimeout(dlHideTimer)
        if (dlBtn) dlBtn.style.display = 'none'
        dlCard = null
        dlCont = null
      }
      function dlFrame() {
        dlRafRun = false
        var card = hoverCard || dlCard
        if (!card) return
        if (!card.isConnected) {
          hoverCard = null
          dlCard = null
          dlCont = null
          if (dlBtn) dlBtn.style.display = 'none'
          return
        }
        var c = dlCont
        if (!c || !c.isConnected) c = dlCont = nearestScrollContainer(card)
        var cr = c.getBoundingClientRect()
        var r = card.getBoundingClientRect()
        if (r.bottom < cr.top - 20 || r.top > cr.bottom + 20) {
          if (dlBtn) dlBtn.style.display = 'none'
          dlCard = null
          return
        }
        dlCard = card
        if (!dlBtn || !dlBtn.isConnected) { dlBtn = buildDlButton(); document.body.appendChild(dlBtn) }
        var top = Math.max(cr.top + 8, r.top + 8)
        top = Math.min(top, cr.bottom - 30)
        var anchorRight = Math.min(cr.right - 8, r.right - 8)
        var anchorLeft = Math.max(cr.left + 8, r.left + 8)
        if (anchorRight - anchorLeft < 24) return
        var nf = nativeUIFontFamily()
        if (nf) dlBtn.style.fontFamily = nf
        dlBtn.style.top = Math.round(top) + 'px'
        dlBtn.style.right = Math.round(Math.max(1, window.innerWidth - anchorRight)) + 'px'
        if (dlBtn.style.display !== 'inline-block') dlBtn.style.display = 'inline-block'
        dlRafRun = true
        window.requestAnimationFrame(dlFrame)
      }
      function startHover(card) {
        hoverCard = card
        dlCard = card
        if (!dlRafRun) { dlRafRun = true; window.requestAnimationFrame(dlFrame) }
      }
function cardFromEvent(ev) {
        var path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target]
        var wrapper = null
        for (var i = 0; i < path.length; i++) {
          var node = path[i]
          if (!node || !node.matches) continue
          if (node.matches('[id="vcp-root"]')) return node
          if (!wrapper && node.matches('[id^="vcp-msg-"]')) wrapper = node
        }
        return wrapper
      }
      document.addEventListener('mouseover', function (ev) {
        var t = ev.target
        if (!t || !t.closest) return
        if (dlBtn && (t === dlBtn || dlBtn.contains(t))) {
          if (dlHideTimer) window.clearTimeout(dlHideTimer)
          return
        }
        var card = cardFromEvent(ev) || t.closest('[id="vcp-root"],[id^="vcp-msg-"]')
        if (card) startHover(card)
      })
      document.addEventListener('mouseout', function (ev) {
        var t = ev.target
        if (!t || !t.closest) return
        var rt = ev.relatedTarget
        if (rt && rt.closest) {
          if (dlBtn && (rt === dlBtn || rt.closest ? rt.closest('[id="vcp-root"],[id^="vcp-msg-"]') : false)) return
        }
        hoverCard = null
        scheduleDlHide()
      })
    }

    // ---- 美学系统查看器 v3（两列网格 · 紧凑控件 · Lanxi 前缀剥离 · 点卡锁定 + 打开源文档）---

    var AES_VIEWER_ID = 'dsh-raw-html-aes-viewer'

    // 全局当前打开的取色器（含关闭句柄）——模态/查看器关闭时统一清理，
    // 防止取色器面板残留 body 导致 panel 变量不同步、下次点不开。
    var aesOpenPicker = null
    /** 关闭所有取色器（清理残留 DOM + 事件监听 + 变量）。 */
    function aesCloseAllPickers() {
      if (aesOpenPicker && typeof aesOpenPicker.closePanel === 'function') {
        try { aesOpenPicker.closePanel() } catch (e) {}
      }
      var ps = document.querySelectorAll('.aes-picker')
      for (var pi = 0; pi < ps.length; pi++) ps[pi].remove()
      aesOpenPicker = null
    }

    function aesRpc(endpoint, payload) {
      return new window.Promise(function (resolve) {
        if (!hostRpc) { resolve(null); return }
        hostRpc('/dsh-raw-html', endpoint, payload || {})
          .then(function (r) { resolve(r && r.value !== undefined ? r.value : r) })
          .catch(function (err) {
            // RPC reject：尝试从 err 里读 Host 返回的 failResult 错误
            resolve(err && err.error ? err : null)
          })
      })
    }

    /** 全局注册已安装字体的 @font-face（apply 时一次性；只声明不下载，元素用到才按需加载）。
     *  根因（先生 2026-08-27 实测）：Lanxi-* 字体此前只在美学面板打开时才由 aesEnsureFontFace
     *  注册——聊天消息渲染时浏览器根本不认识「Lanxi-自由浪漫」等字体名 → font-family 全部
     *  回退系统黑体。这里启动即把 aliasMap 中「已安装」的字体声明注入全局容器
     *  （与 aesEnsureFontFace 同一容器、规则去重幂等），此后模型输出 font-family:'Lanxi-XXX'
     *  直接命中真实字体文件。
     *  重试 v2（先生 2026-08-27 · puppeteer 实测铁证）：apply 瞬间 connection RPC 未就绪
     *  → hostRpc 为 null → 0 条注入（诊断：fontHostExists=true 但 fontRuleCount=0）；
     *  v1 重试 5 次仍失败——因为 aesRpc 用的是 apply 时固定的 hostRpc 变量，重试的是
     *  同一把坏钥匙。v2：每次尝试都【重新 makeHostRpc(ctx)】，connection 一就绪即成功；
     *  并输出 console.debug 日志（注入条数/失败原因），便于 puppeteer 抓取验证。 */
    function ensureGlobalFonts(ctx, attempts) {
      attempts = attempts || 0
      function retry(reason) {
        if (attempts >= 5) {
          console.debug('[dsh-raw-html] ensureGlobalFonts 放弃：' + reason + '（已重试 ' + attempts + ' 次）')
          return 0
        }
        return new window.Promise(function (res) {
          window.setTimeout(function () { res(ensureGlobalFonts(ctx, attempts + 1)) }, 800 * (attempts + 1))
        })
      }
      // 关键：每次尝试都重新获取 RPC——apply 瞬间 connection 可能尚未就绪，
      // 模块级 hostRpc 是 apply 时固定的（可能是 null），重试必须重新取。
      var rpc = makeHostRpc(ctx)
      if (!rpc) return retry('connection 未就绪')
      return rpc('/dsh-raw-html', 'list-fonts', {}).then(function (r) {
        var d = r && r.value !== undefined ? r.value : r
        if (!d || d.error || !d.aliasMap || !d.installed) return retry('list-fonts 无数据' + (d && d.error ? ':' + d.error.message : ''))
        var host = document.getElementById('dsh-raw-html-aes-fontfaces')
        if (!host) {
          host = document.createElement('style')
          host.id = 'dsh-raw-html-aes-fontfaces'
          document.head.appendChild(host)
        }
        var added = 0
        for (var ak in d.aliasMap) {
          if (!Object.prototype.hasOwnProperty.call(d.aliasMap, ak)) continue
          var rel = d.aliasMap[ak]
          if (!rel || !d.installed[ak]) continue
          var rule = "@font-face{font-family:'" + ak + "';src:url('/fonts/" + rel + "');font-display:swap;}"
          if (host.textContent.indexOf(rule) === -1) { host.textContent += rule; added++ }
        }
        console.debug('[dsh-raw-html] ensureGlobalFonts 注入 @font-face ' + added + ' 条（已装 ' + Object.keys(d.installed).filter(function (k) { return d.installed[k] }).length + '/' + Object.keys(d.aliasMap).length + '）')
        return added
      }).catch(function (e) { return retry('RPC 异常:' + (e && e.message)) })
    }

    function aesBaseName(name) { return String(name).replace(/\.[^.]+$/, '') }
    /** 剥离 Lanxi- 前缀（显示用）：「Lanxi-超粗黑」→「超粗黑」。 */
    function aesDispFont(fam) { return String(fam).replace(/^Lanxi-/, '') }

    /** 从风格文档「字体」元信息行提取 Lanxi-* 字体名（去重）。 */
    function aesExtractFontNames(fontsStr) {
      if (!fontsStr) return []
      var m = String(fontsStr).match(/Lanxi-[\w\u4e00-\u9fa5-]+/g) || []
      var out = []
      for (var i = 0; i < m.length; i++) { var n = m[i].trim(); if (out.indexOf(n) === -1) out.push(n) }
      return out
    }

    function aesSwatches(colors) {
      if (!colors || !colors.length) return '<span class="aes-muted">（无色板）</span>'
      var html = ''
      for (var i = 0; i < colors.length; i++) html += '<span class="aes-swatch" style="background:' + colors[i] + ';" title="' + colors[i] + '"></span>'
      return html
    }

    /** 取色器独立样式表：选择器无 #AES_VIEWER_ID 前缀——面板挂 document.body（不在查看器内），
     *  必须用全局选择器才能命中。打开取色器时注入。 */
    function aesPickerSheet() {
      if (document.getElementById('dsh-raw-html-aes-picker-style')) return
      var css = [
        '.aes-picker{position:fixed;z-index:2147483006;width:280px;background:var(--dsw-alias-bg-overlay,#ffffff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));border-radius:14px;box-shadow:0 16px 42px rgba(0,0,0,.35);padding:12px;color-scheme:light dark;box-sizing:border-box;}',
        '.aes-picker-top{display:flex;align-items:center;gap:6px;margin-bottom:8px;}',
        '.aes-picker-hex{flex:1;font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-primary,#111);font-family:inherit;}',
        '.aes-picker-tool{flex:none;height:24px;padding:0 9px;font-size:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:7px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111);font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:3px;}',
        '.aes-picker-tool:hover{background:var(--dsw-alias-button-primary-fill,#0d1f33);color:#fff;}',
        '.aes-picker-sv{position:relative;width:100%;height:110px;border-radius:10px;margin-bottom:8px;cursor:crosshair;border:1px solid rgba(0,0,0,.14);}',
        '.aes-picker-sv-dot{position:absolute;width:13px;height:13px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.45);transform:translate(-50%,-50%);pointer-events:none;}',
        '.aes-picker-hue{position:relative;width:100%;height:20px;border-radius:10px;margin-bottom:8px;cursor:pointer;border:1px solid rgba(0,0,0,.14);background:linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);}',
        '.aes-picker-hue-dot{position:absolute;top:50%;width:7px;height:24px;border-radius:4px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.45);transform:translate(-50%,-50%);pointer-events:none;}',
        '.aes-picker-swatches{display:grid;grid-template-columns:repeat(9,1fr);gap:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}',
        '.aes-picker-swatch{width:100%;aspect-ratio:1;border-radius:5px;border:1px solid rgba(0,0,0,.12);cursor:pointer;padding:0;box-shadow:inset 0 1px 2px rgba(0,0,0,.15),inset 0 0 0 1px rgba(255,255,255,.2);transition:transform .1s ease;}',
        '.aes-picker-swatch:hover{transform:scale(1.12);}',
        '.aes-picker-swatch.on{outline:2px solid var(--dsw-alias-brand-primary,#0d1f33);outline-offset:1px;}',
        '.aes-picker-row{display:flex;gap:6px;align-items:center;}',
        '.aes-picker-input{flex:1;min-width:0;height:24px;font-size:11px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#111);font-family:inherit;}',
        '.aes-picker-ok{flex:none;height:24px;padding:0 12px;font-size:11px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111);font-family:inherit;cursor:pointer;}',
        '.aes-picker-ok:hover{background:var(--dsw-alias-button-primary-fill,#0d1f33);color:#fff;}',
      ].join('\n')
      var st = document.createElement('style')
      st.id = 'dsh-raw-html-aes-picker-style'
      st.textContent = css
      document.head.appendChild(st)
    }

    function aesSheet() {
      var css = [
        '#' + AES_VIEWER_ID + '{position:fixed;z-index:2147483001;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28);color-scheme:light dark;font-family:inherit;}',
        '#' + AES_VIEWER_ID + ' .aes-panel{width:min(780px,calc(100vw - 32px));height:min(720px,calc(100vh - 48px));display:flex;flex-direction:column;border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:0 24px 60px rgba(0,0,0,.32);}',
        '#' + AES_VIEWER_ID + ' .aes-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}',
        '#' + AES_VIEWER_ID + ' .aes-title{font-size:14px;font-weight:700;color:var(--dsw-alias-label-primary,#111);}',
        '#' + AES_VIEWER_ID + ' .aes-subtitle{font-size:11px;color:var(--dsw-alias-label-tertiary,#777);margin:2px 0 10px;}',
        '#' + AES_VIEWER_ID + ' .aes-body{flex:1;overflow:auto;padding:12px 16px;}',
        '#' + AES_VIEWER_ID + ' .aes-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
        '#' + AES_VIEWER_ID + ' .aes-style{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:12px;padding:9px 11px;cursor:pointer;transition:box-shadow .15s ease,border-color .15s ease;position:relative;}',
        '#' + AES_VIEWER_ID + ' .aes-style:hover{border-color:var(--dsw-alias-brand-primary,rgba(0,0,0,.25));box-shadow:0 2px 10px rgba(0,0,0,.06);}',
        '#' + AES_VIEWER_ID + ' .aes-style.aes-locked{border-color:var(--dsw-alias-brand-primary,#0d1f33);box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,rgba(13,31,51,.35));}',
        '#' + AES_VIEWER_ID + ' .aes-locktag{position:absolute;top:7px;left:9px;font-size:9px;font-weight:700;color:#fff;background:var(--dsw-alias-brand-primary,#0d1f33);border-radius:999px;padding:2px 7px;letter-spacing:.05em;}',
        '#' + AES_VIEWER_ID + ' .aes-style:hover .aes-del{opacity:1;}',
        '#' + AES_VIEWER_ID + ' .aes-del:hover{background:#dc2626;color:#fff;border-color:transparent;}',
        '#' + AES_VIEWER_ID + ' .aes-ops{position:absolute;top:7px;right:9px;display:flex;gap:4px;}',
        '#' + AES_VIEWER_ID + ' .aes-op-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-tertiary,#777);font-size:10px;line-height:1;padding:0;cursor:pointer;text-align:center;opacity:0;transition:opacity .12s ease,background .12s ease;font-family:inherit;}',
        '#' + AES_VIEWER_ID + ' .aes-style:hover .aes-op-btn{opacity:1;}',
        '#' + AES_VIEWER_ID + ' .aes-op-btn:hover{background:var(--dsw-alias-button-primary-fill,#0d1f33);color:#fff;}',
        '#' + AES_VIEWER_ID + ' .aes-style-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;padding-left:52px;padding-right:56px;}',
        '#' + AES_VIEWER_ID + ' .aes-style-name{flex:1;min-width:0;font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,#111);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '#' + AES_VIEWER_ID + ' .aes-style-slug{flex:none;font-size:9px;color:var(--dsw-alias-label-tertiary,#999);}',
        '#' + AES_VIEWER_ID + ' .aes-style-scene{font-size:10px;color:var(--dsw-alias-label-tertiary,#777);line-height:1.35;margin:1px 0 6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
        '#' + AES_VIEWER_ID + ' .aes-swatch{display:inline-block;width:15px;height:15px;border-radius:4px;margin:0 3px 2px 0;border:1px solid rgba(0,0,0,.15);box-shadow:inset 0 0 0 1px rgba(255,255,255,.25);vertical-align:middle;}',
        '#' + AES_VIEWER_ID + ' .aes-swatch-label{font-size:9px;color:var(--dsw-alias-label-tertiary,#777);margin-bottom:3px;}',
        '#' + AES_VIEWER_ID + ' .aes-fontrow{display:flex;gap:6px;align-items:center;margin-top:6px;}',
        '#' + AES_VIEWER_ID + ' .aes-select{flex:1;min-width:0;height:24px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:7px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#111);font-size:10px;font-family:inherit;padding:0 4px;}',
        '#' + AES_VIEWER_ID + ' .aes-preview{margin-top:5px;padding:5px 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary,#111);min-height:18px;word-break:break-all;}',
        '#' + AES_VIEWER_ID + ' .aes-footer{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}',
        '#' + AES_VIEWER_ID + ' .aes-row{display:flex;gap:6px;align-items:center;margin-top:8px;}',
        '#' + AES_VIEWER_ID + ' .aes-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:8px;padding:6px 8px;font-size:11px;font-family:inherit;color:var(--dsw-alias-label-primary,#111);background:transparent;}',
        '#' + AES_VIEWER_ID + ' .aes-btn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111);font-size:11px;font-family:inherit;padding:5px 9px;cursor:pointer;flex:none;}',
        '#' + AES_VIEWER_ID + ' .aes-btn:hover{background:var(--dsw-alias-button-primary-fill,#0d1f33);color:#fff;}',
        '#' + AES_VIEWER_ID + ' .aes-muted{font-size:10px;color:var(--dsw-alias-label-tertiary,#777);word-break:break-all;}',
        '#' + AES_VIEWER_ID + ' .aes-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#777);padding:8px 0;}',
        '#' + AES_VIEWER_ID + ' .aes-footer{flex:none;background:var(--dsw-alias-bg-overlay,#fff);border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding:12px 16px;}',
        '#' + AES_VIEWER_ID + ' .aes-modal{position:fixed;z-index:2147483002;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);}',
        '#' + AES_VIEWER_ID + ' .aes-modal-panel{width:min(480px,calc(100vw - 48px));max-height:calc(100vh - 80px);display:flex;flex-direction:column;border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:0 24px 60px rgba(0,0,0,.35);}',
        '#' + AES_VIEWER_ID + ' .aes-modal-body{flex:1;overflow:auto;padding:10px 16px;}',
        '#' + AES_VIEWER_ID + ' .aes-modal-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}',
        '#' + AES_VIEWER_ID + ' .aes-field{margin-bottom:10px;}',
        '#' + AES_VIEWER_ID + ' .aes-field-label{display:block;font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary,#111);margin-bottom:4px;}',
        '#' + AES_VIEWER_ID + ' .aes-ta{width:100%;box-sizing:border-box;resize:vertical;line-height:1.5;}',
        '#' + AES_VIEWER_ID + ' .aes-swatchedit{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 0;}',
        '#' + AES_VIEWER_ID + ' .aes-sw-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;box-shadow:0 1px 2px rgba(0,0,0,.18);border-radius:50%;}',
        '#' + AES_VIEWER_ID + ' .aes-sw-color{width:20px;height:20px;border:none;border-radius:50%;padding:0;cursor:pointer;background:none;transition:transform .12s ease;display:block;}',
        '#' + AES_VIEWER_ID + ' .aes-sw-color::-webkit-color-swatch-wrapper{padding:0;}',
        '#' + AES_VIEWER_ID + ' .aes-sw-color::-webkit-color-swatch{border:none;border-radius:50%;box-shadow:inset 0 1px 2px rgba(0,0,0,.25),inset 0 0 0 1px rgba(255,255,255,.35);}',
        '#' + AES_VIEWER_ID + ' .aes-sw-color:hover{transform:scale(1.15);}',
        '#' + AES_VIEWER_ID + ' .aes-sw-rm{position:absolute;top:-2px;right:-2px;width:12px;height:12px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-tertiary,#777);font-size:8px;line-height:10px;padding:0;cursor:pointer;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.15);opacity:0;transition:opacity .12s ease;}',
        '#' + AES_VIEWER_ID + ' .aes-sw-wrap:hover .aes-sw-rm{opacity:1;}',
        '#' + AES_VIEWER_ID + ' .aes-sw-add{border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.25));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:9px;font-weight:400;padding:2px 9px;cursor:pointer;font-family:inherit;line-height:1.5;transition:all .12s ease;}',
        '#' + AES_VIEWER_ID + ' .aes-sw-add:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));border-color:var(--dsw-alias-brand-primary,rgba(0,0,0,.4));color:var(--dsw-alias-label-primary,#111);}',
        // 取色器样式见 aesPickerSheet()（独立无前缀，面板挂 body 也能命中）
        '#' + AES_VIEWER_ID + ' .aes-fontsel-wide{width:100%;height:28px;margin-bottom:6px;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:8px;margin-bottom:8px;position:relative;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-head{display:flex;align-items:center;gap:6px;margin-bottom:6px;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-label{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);letter-spacing:.06em;flex:none;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-add{flex:none;height:22px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:7px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#111);font-size:10px;font-family:inherit;padding:0 8px;cursor:pointer;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-add:hover{background:var(--dsw-alias-button-primary-fill,#0d1f33);color:#fff;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-search{flex:1;min-width:0;height:22px;font-size:10px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#111);}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-menu{position:absolute;z-index:2147483003;min-width:160px;max-width:220px;max-height:180px;overflow-y:auto;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.25);padding:4px;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-menu-item{display:block;width:100%;text-align:left;border:none;background:none;font-size:12px;color:var(--dsw-alias-label-primary,#111);padding:6px 8px;border-radius:7px;cursor:pointer;font-family:inherit;line-height:1.4;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-menu-item .aes-fontcat-menu-meta{font-size:9px;color:var(--dsw-alias-label-tertiary,#999);margin-left:6px;}',
        '#' + AES_VIEWER_ID + ' .aes-fontchips{display:flex;flex-wrap:wrap;gap:5px;max-height:88px;overflow-y:auto;align-content:flex-start;padding:6px 2px 0 0;}',
        '#' + AES_VIEWER_ID + ' .aes-chip .aes-chip-x{top:-3px;right:-3px;}',
        '#' + AES_VIEWER_ID + ' .aes-chip{flex:none;position:relative;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.15));border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111);font-size:12px;padding:3px 12px 3px 10px;cursor:default;font-family:inherit;line-height:1.5;transition:all .12s ease;display:inline-flex;align-items:center;}',
        '#' + AES_VIEWER_ID + ' .aes-chip .aes-chip-x{position:absolute;top:-5px;right:-5px;width:13px;height:13px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-tertiary,#777);font-size:8px;line-height:11px;padding:0;cursor:pointer;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.15);opacity:0;transition:opacity .12s ease;font-family:inherit;}',
        '#' + AES_VIEWER_ID + ' .aes-chip:hover .aes-chip-x{opacity:1;}',
        '#' + AES_VIEWER_ID + ' .aes-chip .aes-chip-x:hover{background:#dc2626;color:#fff;border-color:transparent;}',
        '#' + AES_VIEWER_ID + ' .aes-chip .aes-chip-dot{font-size:8px;margin-left:4px;color:#16a34a;opacity:.85;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-empty{font-size:10px;color:var(--dsw-alias-label-tertiary,#999);padding:2px 0;}',
        '#' + AES_VIEWER_ID + ' .aes-fontcat-hint{font-size:10px;color:var(--dsw-alias-label-tertiary,#777);margin-top:2px;line-height:1.4;}',
        '#' + AES_VIEWER_ID + ' .aes-head.aes-head-viewer{flex-direction:column;align-items:stretch;padding:0;}',
        '#' + AES_VIEWER_ID + ' .aes-head-top{display:flex;align-items:center;justify-content:space-between;padding:12px 16px 6px;}',
        '#' + AES_VIEWER_ID + ' .aes-head-viewer .aes-searchbar{display:flex;gap:6px;padding:0 16px 10px;margin:0;background:transparent;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}',
        '#' + AES_VIEWER_ID + ' .aes-searchbar{position:relative;}',
        '#' + AES_VIEWER_ID + ' .aes-tagbtn{flex:none;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:7px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#111);font-size:10px;font-family:inherit;padding:0 10px;cursor:pointer;}',
        '#' + AES_VIEWER_ID + ' .aes-tagbtn:hover{background:var(--dsw-alias-button-primary-fill,#0d1f33);color:#fff;}',
        '#' + AES_VIEWER_ID + ' .aes-tagmenu{position:absolute;top:calc(100% - 4px);left:0;z-index:2147483003;min-width:170px;max-width:240px;max-height:220px;overflow-y:auto;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.25);padding:4px;}',
        '#' + AES_VIEWER_ID + ' .aes-tagmenu-item{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:none;background:none;font-size:11px;color:var(--dsw-alias-label-primary,#111);padding:5px 8px;border-radius:7px;cursor:pointer;font-family:inherit;}',
        '#' + AES_VIEWER_ID + ' .aes-tagmenu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
        '#' + AES_VIEWER_ID + ' .aes-tagmenu-item.on{color:var(--dsw-alias-brand-primary,#0d1f33);font-weight:600;}',
        '#' + AES_VIEWER_ID + ' .aes-tagmenu-item .aes-tagmenu-count{font-size:9px;color:var(--dsw-alias-label-tertiary,#999);margin-left:auto;font-weight:400;}',
        '#' + AES_VIEWER_ID + ' .aes-searchinp{height:26px;font-size:10px;padding:0 8px;}',
        '#' + AES_VIEWER_ID + ' .aes-newcard{border:1.5px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.25));background:transparent;display:flex;align-items:center;justify-content:center;min-height:120px;}',
        '#' + AES_VIEWER_ID + ' .aes-newcard:hover{border-color:var(--dsw-alias-brand-primary,rgba(0,0,0,.4));box-shadow:0 2px 10px rgba(0,0,0,.06);}',
        '#' + AES_VIEWER_ID + ' .aes-btn-primary{background:var(--dsw-alias-button-primary-fill,#0d1f33);color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent;font-weight:600;}',
        '#' + AES_VIEWER_ID + ' .aes-btn-primary:hover{background:var(--dsw-alias-button-primary-fill,#0d1f33);color:#fff;}'
      ].join('\n')
      var st = document.createElement('style')
      st.id = 'dsh-raw-html-aes-style'
      st.textContent = css
      return st
    }

    /** 动态加载字体（@font-face + fonts.load）用于预览；rel 为空则跳过（回退系统字体）。
     *  用一个统一 @font-face 容器，按 rule 字符串去重——绝不能按 family 生成 style id：
     *  中文字体名被替换成下划线后会互相撞 id（如「Lanxi-超粗黑」与「Lanxi-狂侠体」同 id），
     *  第二个字体的 @font-face 会被 getElementById 短路跳过、永不注入，导致预览失效。 */
    function aesEnsureFontFace(family, rel) {
      if (!rel) return window.Promise.resolve(false)
      var host = document.getElementById('dsh-raw-html-aes-fontfaces')
      if (!host) {
        host = document.createElement('style')
        host.id = 'dsh-raw-html-aes-fontfaces'
        document.head.appendChild(host)
      }
      var rule = "@font-face{font-family:'" + family + "';src:url('/fonts/" + rel + "');font-display:swap;}"
      if (host.textContent.indexOf(rule) === -1) host.textContent += rule
      return document.fonts.load("13px '" + family + "'").then(function () { return true }).catch(function () { return false })
    }

    /** 构建单个风格板块：名称/slug/场景 + 色板 + 字体下拉（剥离前缀）+ 预览 + 锁定标记 + 打开源文档。 */
    function aesBuildStyleSection(st, fontMap, aliasMap, installed, lockedSlug) {
      var sec = document.createElement('div')
      sec.className = 'aes-style' + (lockedSlug === st.slug ? ' aes-locked' : '')

      var head = document.createElement('div')
      head.className = 'aes-style-head'
      var nm = document.createElement('span')
      nm.className = 'aes-style-name'
      nm.textContent = st.name
      var slug = document.createElement('span')
      slug.className = 'aes-style-slug'
      slug.textContent = st.slug
      head.appendChild(nm)
      head.appendChild(slug)
      sec.appendChild(head)

      if (lockedSlug === st.slug) {
        var tag = document.createElement('span')
        tag.className = 'aes-locktag'
        tag.textContent = '已锁定'
        sec.appendChild(tag)
      }

      // 操作按钮：编辑 + 删除（右上角，hover 显现）
      {
        var ops = document.createElement('div')
        ops.className = 'aes-ops'
        // 打开源文档按钮：系统文件管理器定位 styles/<slug>.md（线条 SVG，与 ✎ 同一视觉语言）
        var openBtn = document.createElement('button')
        openBtn.type = 'button'
        openBtn.className = 'aes-op-btn'
        openBtn.title = '在文件管理器中打开此风格的源文档（styles/' + st.slug + '.md）'
        openBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>'
        openBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          aesOpenStyleFolder(st.slug)
        })
        ops.appendChild(openBtn)
        // 编辑按钮：打开新建模态的编辑模式（预填当前风格数据）
        var editBtn = document.createElement('button')
        editBtn.type = 'button'
        editBtn.className = 'aes-op-btn'
        editBtn.textContent = '✎'
        editBtn.title = '编辑此风格'
        editBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          openAesNewStyle(st)
        })
        ops.appendChild(editBtn)
        // 删除按钮：Host 侧二次校验保护内置
        var delBtn = document.createElement('button')
        delBtn.type = 'button'
        delBtn.className = 'aes-op-btn'
        delBtn.textContent = '🗑'
        delBtn.title = '删除此风格'
        delBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          if (!window.confirm('确定删除风格「' + st.name + '」吗？此操作不可恢复。')) return
          aesRpc('delete-style', { slug: st.slug }).then(function (d) {
            if (d && d.error) { window.alert('删除失败：' + (d.error.message || JSON.stringify(d.error))); return }
            var v = document.getElementById(AES_VIEWER_ID)
            if (v && typeof v._aesRender === 'function') v._aesRender()
          })
        })
        ops.appendChild(delBtn)
        sec.appendChild(ops)
      }

      if (st.scene) {
        var scene = document.createElement('div')
        scene.className = 'aes-style-scene'
        scene.textContent = st.scene
        sec.appendChild(scene)
      }


      var swLabel = document.createElement('div')
      swLabel.className = 'aes-swatch-label'
      swLabel.textContent = '色板'
      sec.appendChild(swLabel)
      var swDiv = document.createElement('div')
      swDiv.innerHTML = aesSwatches(st.colors)
      sec.appendChild(swDiv)

      var names = aesExtractFontNames(st.fonts)
      if (names.length) {
        var frow = document.createElement('div')
        frow.className = 'aes-fontrow'
        var sel = document.createElement('select')
        sel.className = 'aes-select'
        var opt0 = document.createElement('option')
        opt0.value = ''
        opt0.textContent = '字体预览'
        sel.appendChild(opt0)
        for (var i = 0; i < names.length; i++) {
          var n = names[i]
          var inst = fontMap[aesBaseName(n)]
          var aliasRel = aliasMap[n]
          var available = !!(inst || (aliasRel && installed[n]))
          var opt = document.createElement('option')
          opt.value = inst ? inst.rel : (aliasRel || n)
          opt.textContent = aesDispFont(n) + (available ? ' ✓' : ' ○')
          sel.appendChild(opt)
        }
        var prev = document.createElement('div')
        prev.className = 'aes-preview'
        prev.textContent = '床前明月光 · 0123456789'
        sel.addEventListener('change', function () {
          if (!sel.value) { prev.style.fontFamily = ''; return }
          var fam = sel.options[sel.selectedIndex].textContent.replace(/\s+[✓○]$/, '')
          var fullFam = sel.options[sel.selectedIndex].textContent.replace(/\s+[✓○]$/, '')
          // 补回 Lanxi- 前缀做 @font-face 引用
          var prefix = ''
          for (var k = 0; k < names.length; k++) { if (aesDispFont(names[k]) === fam) { prefix = names[k]; break } }
          prev.style.fontFamily = "'" + (prefix || fullFam) + "',sans-serif"
          aesEnsureFontFace(prefix || fullFam, sel.value)
        })
        // 下拉/预览是交互区：阻止点击冒泡到板块（否则点字体预览会误触锁定）
        frow.addEventListener('click', function (e) { e.stopPropagation() })
        frow.appendChild(sel)
        frow.appendChild(prev)
        sec.appendChild(frow)
      }

      // 点卡片 → 锁定/解锁该风格（边框高亮 + 左上角「已锁定」徽标）
      sec.addEventListener('click', function () { aesLockStyle(st.slug, lockedSlug === st.slug) })
      return sec
    }

    /** 系统文件夹选择器：FS Access API 读字体 → FontFace 注册当前窗口（仅本会话）。 */
    function aesPickSystemDir() {
      return new window.Promise(function (resolve, reject) {
        if (!window.showDirectoryPicker) { reject(new Error('浏览器不支持 File System Access API')); return }
        window.showDirectoryPicker().then(function (dir) {
          var names = []
          var jobs = []
          function walkDir(d) {
            var it = d.values()
            function step() {
              return it.next().then(function (r) {
                if (r.done) return window.Promise.resolve()
                var entry = r.value
                if (entry.kind === 'directory') return walkDir(entry).then(function () { return step() })
                if (entry.kind === 'file' && /\.(ttf|otf|woff2?)$/i.test(entry.name)) {
                  jobs.push(entry.getFile().then(function (f) {
                    return f.arrayBuffer().then(function (buf) {
                      var family = 'AesFont_' + entry.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]/g, '_')
                      var face = new window.FontFace(family, buf)
                      return face.load().then(function () { document.fonts.add(face); names.push(entry.name) })
                    })
                  }))
                  return step()
                }
                return step()
              })
            }
            return step()
          }
          walkDir(dir).then(function () { return window.Promise.all(jobs) }).then(function () { resolve(names) }).catch(reject)
        }).catch(reject)
      })
    }

    /** 打开风格源文档所在文件夹：Host 用系统文件管理器定位选中该 md。 */
    function aesOpenStyleFolder(slug) {
      aesRpc('open-style-folder', { slug: slug }).then(function (d) {
        if (d && d.error) window.alert('无法打开文件夹：' + (d.error.message || JSON.stringify(d.error)))
      })
    }

    /** 锁定/解锁风格：持久化到 Host（注入协议会优先提示该风格）。 */
    function aesLockStyle(slug, isLocked) {
      aesRpc('set-style', { style: isLocked ? '' : slug }).then(function (d) {
        // 原地重绘刷新锁定态（不关闭面板；openAestheticsViewer 是切换式，直接调会关掉自己）
        var v = document.getElementById(AES_VIEWER_ID)
        if (v && typeof v._aesRender === 'function') v._aesRender()
      })
    }

    function openAestheticsViewer() {
      closePanel()
      var existing = document.getElementById(AES_VIEWER_ID)
      if (existing) { existing.remove(); return }
      if (!document.getElementById('dsh-raw-html-aes-style')) document.head.appendChild(aesSheet())

      var view = document.createElement('div')
      view.id = AES_VIEWER_ID
      var panel = document.createElement('div')
      panel.className = 'aes-panel'

      // ---- 顶栏：head-top（标题+关闭）+ searchbar（检索栏融入，紧贴同底色）----
      var head = document.createElement('div')
      head.className = 'aes-head aes-head-viewer'
      var headTop = document.createElement('div')
      headTop.className = 'aes-head-top'
      var tWrap = document.createElement('div')
      var title = document.createElement('div')
      title.className = 'aes-title'
      title.textContent = '美学系统'
      var sub = document.createElement('div')
      sub.className = 'aes-subtitle'
      sub.textContent = '点击板块即锁定该风格 · 点右上角文件夹图标打开源文档'
      tWrap.appendChild(title)
      tWrap.appendChild(sub)
      var close = document.createElement('button')
      close.className = 'aes-btn'
      close.textContent = '✕ 关闭'
      close.addEventListener('click', function () { aesCloseAllPickers(); view.remove() })
      headTop.appendChild(tWrap)
      headTop.appendChild(close)
      head.appendChild(headTop)

      // 检索栏：创建一次，永不随 grid 重建（输入时焦点不丢）
      var searchbar = document.createElement('div')
      searchbar.className = 'aes-searchbar'
      // 标签过滤按钮 + 弹出菜单（替代原 multiple select——内容一多太长，改弹出式更好看）
      var tagBtn = document.createElement('button')
      tagBtn.type = 'button'
      tagBtn.className = 'aes-tagbtn'
      tagBtn.textContent = '标签'
      var tagMenu = document.createElement('div')
      tagMenu.className = 'aes-tagmenu'
      tagMenu.style.display = 'none'
      searchbar.appendChild(tagMenu)
      tagBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        var willShow = tagMenu.style.display === 'none'
        document.querySelectorAll('.aes-tagmenu').forEach(function (m) { if (m !== tagMenu) m.style.display = 'none' })
        document.querySelectorAll('.aes-fontcat-menu').forEach(function (m) { m.style.display = 'none' })
        tagMenu.style.display = willShow ? 'block' : 'none'
      })
      searchbar.appendChild(tagBtn)
      var searchInp = document.createElement('input')
      searchInp.className = 'aes-input aes-searchinp'
      searchInp.placeholder = '🔍 检索名称/场景/标签…'
      searchbar.appendChild(searchInp)
      head.appendChild(searchbar)
      panel.appendChild(head)

      // ---- 滚动区（只放 grid，searchbar/footer 不在此重建）----
      var body = document.createElement('div')
      body.className = 'aes-body'
      var loading = document.createElement('div')
      loading.className = 'aes-empty'
      loading.textContent = '加载中…'
      body.appendChild(loading)
      panel.appendChild(body)
      view.appendChild(panel)
      document.body.appendChild(view)

      var search = { tags: [], text: '' }
      view._aesSearch = search

      view.addEventListener('click', function (e) { if (e.target === view) { aesCloseAllPickers(); view.remove() } })
      var esc = function (e) { if (e.key === 'Escape') { if (view.querySelector('.aes-modal')) return; aesCloseAllPickers(); view.remove(); document.removeEventListener('keydown', esc) } }
      document.addEventListener('keydown', esc)

      // ---- 数据一次性加载，grid/footer 只负责渲染 ----
      var data = { styles: [], fonts: [], aliasMap: {}, installed: {}, extraRoots: [], locked: '' }
      var loaded = false

      function fontMap() {
        var m = {}
        for (var i = 0; i < data.fonts.length; i++) m[aesBaseName(data.fonts[i].name)] = data.fonts[i]
        return m
      }

      function buildTagOptions() {
        var tagCount = {}
        for (var i = 0; i < data.styles.length; i++) {
          (String(data.styles[i].tags || '').split(/[,，\s/]+/)).forEach(function (tg) { tg = tg.trim(); if (tg) tagCount[tg] = (tagCount[tg] || 0) + 1 })
        }
        var allTags = Object.keys(tagCount).sort(function (a, b) { return tagCount[b] - tagCount[a] })
        tagMenu.textContent = ''
        if (allTags.length) {
          for (var j = 0; j < allTags.length; j++) {
            (function (tag) {
              var item = document.createElement('button')
              item.type = 'button'
              item.className = 'aes-tagmenu-item' + (search.tags.indexOf(tag) !== -1 ? ' on' : '')
              item.textContent = (search.tags.indexOf(tag) !== -1 ? '✓ ' : '') + tag
              var cnt = document.createElement('span')
              cnt.className = 'aes-tagmenu-count'
              cnt.textContent = tagCount[tag]
              item.appendChild(cnt)
              item.addEventListener('click', function (e) {
                e.stopPropagation()
                var idx = search.tags.indexOf(tag)
                if (idx === -1) search.tags.push(tag); else search.tags.splice(idx, 1)
                buildTagOptions()
                buildGrid()
              })
              tagMenu.appendChild(item)
            })(allTags[j])
          }
        } else {
          var none = document.createElement('div')
          none.className = 'aes-fontcat-empty'
          none.textContent = '（无标签）'
          tagMenu.appendChild(none)
        }
        tagBtn.textContent = search.tags.length ? '标签 (' + search.tags.length + ')' : '标签'
      }

      // 输入事件只重建 grid——搜索框本身不被销毁，焦点保持（修复「一输入就跳出」）
      searchInp.addEventListener('input', function () {
        search.text = searchInp.value
        buildGrid()
      })

      function buildGrid() {
        body.textContent = ''
        var q = search.text.trim().toLowerCase()
        var filtered = data.styles.filter(function (st) {
          if (search.tags.length && !search.tags.some(function (tg) { return (String(st.tags || '').split(/[,，\s/]+/)).indexOf(tg) !== -1 })) return false
          if (q) {
            var hay = (st.name + ' ' + st.slug + ' ' + st.scene + ' ' + st.tags).toLowerCase()
            if (hay.indexOf(q) === -1) return false
          }
          return true
        })
        var secLabel = document.createElement('div')
        secLabel.className = 'aes-subtitle'
        secLabel.textContent = '共 ' + data.styles.length + ' 个风格' + (data.locked ? ' · 当前锁定：' + data.locked : ' · 未锁定（自动检索）')
        body.appendChild(secLabel)
        var grid = document.createElement('div')
        grid.className = 'aes-grid'
        grid.appendChild(aesBuildNewStyleCard())
        for (var j = 0; j < filtered.length; j++) grid.appendChild(aesBuildStyleSection(filtered[j], fontMap(), data.aliasMap, data.installed, data.locked))
        if (!filtered.length) {
          var empty = document.createElement('div')
          empty.className = 'aes-empty'
          empty.textContent = '没有匹配的风格——换个关键词，或点击「＋ 新建」创造它'
          empty.style.gridColumn = '1 / -1'
          grid.appendChild(empty)
        }
        body.appendChild(grid)
      }

      // ---- 底部外置字体库：固定，创建一次 ----
      var foot = document.createElement('div')
      foot.className = 'aes-footer'
      var fLabel = document.createElement('div')
      fLabel.className = 'aes-swatch-label'
      fLabel.textContent = '外置字体库（粘贴绝对路径，字体放进去后点刷新即用）'
      foot.appendChild(fLabel)
      var row = document.createElement('div')
      row.className = 'aes-row'
      var inp = document.createElement('input')
      inp.className = 'aes-input'
      inp.placeholder = 'D:\\我的字体（留空则仅内置精选字体）'
      var addBtn = document.createElement('button')
      addBtn.className = 'aes-btn'
      addBtn.textContent = '挂载'
      var pickBtn = document.createElement('button')
      pickBtn.className = 'aes-btn'
      pickBtn.textContent = '系统选择器'
      var refBtn = document.createElement('button')
      refBtn.className = 'aes-btn'
      refBtn.textContent = '⟳ 刷新'
      row.appendChild(inp)
      row.appendChild(addBtn)
      row.appendChild(pickBtn)
      row.appendChild(refBtn)
      foot.appendChild(row)
      var rootsDiv = document.createElement('div')
      rootsDiv.className = 'aes-muted'
      rootsDiv.style.marginTop = '8px'
      foot.appendChild(rootsDiv)
      var tmpDiv = document.createElement('div')
      tmpDiv.className = 'aes-muted'
      tmpDiv.style.marginTop = '4px'
      foot.appendChild(tmpDiv)
      function updateRoots() {
        rootsDiv.textContent = data.extraRoots && data.extraRoots.length ? '已挂载：' + data.extraRoots.join(' · ') : '已挂载：无（默认仅内置精选字体）'
      }
      addBtn.addEventListener('click', function () {
        var p = (inp.value || '').trim()
        if (!p) return
        aesRpc('add-fonts-root', { path: p }).then(function (d) {
          inp.value = ''
          data.extraRoots = (d && d.extraFonts) || data.extraRoots
          updateRoots()
          loadFontsOnly()
        })
      })
      refBtn.addEventListener('click', loadFontsOnly)
      pickBtn.addEventListener('click', function () {
        tmpDiv.textContent = '正在打开系统选择器…'
        aesPickSystemDir().then(function (names) {
          tmpDiv.textContent = names && names.length ? '本窗口临时挂载 ✓：' + names.join(' · ') : '（该目录无字体文件）'
        }).catch(function (e) { tmpDiv.textContent = '系统选择器不可用：' + ((e && e.message) || e) + '（请用粘贴路径）' })
      })
      panel.appendChild(foot)

      function loadFontsOnly() {
        aesRpc('list-fonts').then(function (fd) {
          data.fonts = (fd && fd.fonts) || []
          data.extraRoots = (fd && fd.extraFonts) || []
          data.aliasMap = (fd && fd.aliasMap) || {}
          data.installed = (fd && fd.installed) || {}
          updateRoots()
          buildGrid()
        })
      }

      function load() {
        aesRpc('get-state').then(function (st) {
          data.locked = (st && st.preferredStyle) || ''
          aesRpc('list-styles').then(function (sd) {
            data.styles = (sd && sd.styles) || []
            aesRpc('list-fonts').then(function (fd) {
              data.fonts = (fd && fd.fonts) || []
              data.extraRoots = (fd && fd.extraFonts) || []
              data.aliasMap = (fd && fd.aliasMap) || {}
              data.installed = (fd && fd.installed) || {}
              loaded = true
              buildTagOptions()
              updateRoots()
              buildGrid()
            })
          })
        })
      }

      // 锁定/新建/删除后原地刷新 grid（边框亮起），不关面板
      view._aesRender = function () {
        // 完全重载：重新拉取状态、风格列表、字体，让锁定态与增删立即生效
        aesRpc('get-state').then(function (st) {
          data.locked = (st && st.preferredStyle) || ''
          aesRpc('list-styles').then(function (sd) {
            data.styles = (sd && sd.styles) || []
            aesRpc('list-fonts').then(function (fd) {
              data.fonts = (fd && fd.fonts) || []
              data.extraRoots = (fd && fd.extraFonts) || []
              data.aliasMap = (fd && fd.aliasMap) || {}
              data.installed = (fd && fd.installed) || {}
              loaded = true
              buildTagOptions && buildTagOptions()
              buildGrid()
            })
          })
        })
      }
      load()
    }

    /** 新建框卡片：与风格板块同尺寸，虚线边框，永远在网格第一位。 */
    function aesBuildNewStyleCard() {
      var card = document.createElement('div')
      card.className = 'aes-style aes-newcard'
      card.title = '创建自定义美学风格'
      var inner = document.createElement('div')
      inner.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:120px;gap:6px;text-align:center;'
      var plus = document.createElement('div')
      plus.textContent = '＋'
      plus.style.cssText = 'font-size:26px;font-weight:300;color:var(--dsw-alias-label-tertiary,#999);line-height:1;'
      var lab = document.createElement('div')
      lab.textContent = '新建风格'
      lab.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#666);'
      var hint = document.createElement('div')
      hint.textContent = '把想法变成可检索的风格'
      hint.style.cssText = 'font-size:10px;color:var(--dsw-alias-label-tertiary,#999);'
      inner.appendChild(plus)
      inner.appendChild(lab)
      inner.appendChild(hint)
      card.appendChild(inner)
      card.addEventListener('click', function (e) { e.stopPropagation(); openAesNewStyle() })
      return card
    }

    // ---- 新建风格模态：用户自定义美学（把想法变成可检索的风格文档）-----------

    /** 色板编辑器：一排 <input type=color> + 加色/删色。 */
    /** 自定义取色弹层（跟随主题令牌、小圆角、小字号）。点击色块弹出。 */
    var AES_PRESET_COLORS = ['#F7F2EB', '#081F5C', '#334EAC', '#7096D1', '#D4A017', '#F5572F', '#C85A3F', '#A9714B', '#FFC700', '#7C5CFF', '#FF69B4', '#9400D3', '#00FFFF', '#00FF00', '#FF00FF', '#1C1C1A', '#2B2B2B', '#FFFFFF']

    /** 颜色转换：hex ↔ HSV。 */
    function aesHexToHsv(hex) {
      var r = parseInt(hex.slice(1, 3), 16) / 255
      var g = parseInt(hex.slice(3, 5), 16) / 255
      var b = parseInt(hex.slice(5, 7), 16) / 255
      var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
      var h = 0
      if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6
        else if (max === g) h = (b - r) / d + 2
        else h = (r - g) / d + 4
        h = h * 60; if (h < 0) h += 360
      }
      return { h: h, s: max === 0 ? 0 : d / max, v: max }
    }
    function aesHsvToHex(h, s, v) {
      s = s / 100; v = v / 100
      var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c
      var r = 0, g = 0, b = 0
      if (h < 60) { r = c; g = x }
      else if (h < 120) { r = x; g = c }
      else if (h < 180) { g = c; b = x }
      else if (h < 240) { g = x; b = c }
      else if (h < 300) { r = x; b = c }
      else { r = c; b = x }
      function p(n) { var s2 = Math.round(n * 255).toString(16); return s2.length < 2 ? '0' + s2 : s2 }
      return '#' + p(r + m) + p(g + m) + p(b + m)
    }

    /** 色块按钮 + 点击弹出自定义 HSV 取色器（可自由选任意颜色，含吸管）。
     *  面板挂 document.body + position:fixed + 超高 z-index：避免被模态内字体分类遮挡、
     *  也解决「关不掉」（点外部/Esc/✕ 均可关闭）。 */
    function aesColorChip(current, onPick) {
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'aes-sw-color'
      btn.style.background = current
      btn.title = '点击取色'
      var panel = null
      var hsv = aesHexToHsv(current)
      var h = hsv.h, s = hsv.s * 100, v = hsv.v * 100
      var escHandler = null
      var outsideHandler = null

      function closePanel() {
        if (panel) { panel.remove(); panel = null }
        if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null }
        if (outsideHandler) { document.removeEventListener('mousedown', outsideHandler); outsideHandler = null }
        aesOpenPicker = null
      }

      function setColor(hexStr, syncInput) {
        current = hexStr
        btn.style.background = hexStr
        onPick(hexStr)
        if (!panel) return
        var hexEl = panel.querySelector('.aes-picker-hex')
        if (hexEl) hexEl.textContent = hexStr.toUpperCase()
        if (syncInput) {
          var inp = panel.querySelector('.aes-picker-input')
          if (inp && document.activeElement !== inp) inp.value = hexStr
        }
        var sv = panel.querySelector('.aes-picker-sv')
        if (sv) sv.style.background = 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(' + h + ',100%,50%))'
        var svDot = panel.querySelector('.aes-picker-sv-dot')
        if (svDot) { svDot.style.left = s + '%'; svDot.style.top = (100 - v) + '%' }
        var hueDot = panel.querySelector('.aes-picker-hue-dot')
        if (hueDot) hueDot.style.left = (h / 360 * 100) + '%'
        var sws = panel.querySelectorAll('.aes-picker-swatch')
        for (var i = 0; i < sws.length; i++) sws[i].classList.toggle('on', sws[i].style.background.toLowerCase() === hexStr.toLowerCase())
      }

      function bindDrag(el, onMove) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault()
          e.stopPropagation()
          onMove(e)
          function mv(ev) { onMove(ev) }
          function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
          document.addEventListener('mousemove', mv)
          document.addEventListener('mouseup', up)
        })
      }

      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        // 强制清理：移除所有已存在的 .aes-picker 面板（含残留），重置 panel 状态
        try {
          var leftovers = document.querySelectorAll('.aes-picker')
          for (var lix = 0; lix < leftovers.length; lix++) { var lp = leftovers[lix]; if (lp && lp.parentNode) lp.parentNode.removeChild(lp) }
        } catch (le) {}
        if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null }
        if (outsideHandler) { document.removeEventListener('mousedown', outsideHandler); outsideHandler = null }
        panel = null
        aesOpenPicker = null

        panel = document.createElement('div')
        panel.className = 'aes-picker'
        // 内联样式强制生效：fixed + 顶层 z-index + 不透明背景，完全不依赖外部 CSS 类
        panel.style.cssText = 'position:fixed;z-index:2147483006;background:var(--dsw-alias-bg-overlay,#ffffff);width:280px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));border-radius:14px;box-shadow:0 16px 42px rgba(0,0,0,.35);padding:12px;color-scheme:light dark;display:block;'

        // 顶部行：hex + 吸管 + 关闭
        var top = document.createElement('div')
        top.className = 'aes-picker-top'
        var hex = document.createElement('div')
        hex.className = 'aes-picker-hex'
        hex.textContent = current.toUpperCase()
        top.appendChild(hex)
        if (window.EyeDropper) {
          var drop = document.createElement('button')
          drop.type = 'button'
          drop.className = 'aes-picker-tool'
          drop.textContent = '🖌 吸管'
          drop.title = '从屏幕任意位置取色'
          drop.addEventListener('click', function (ev) {
            ev.stopPropagation()
            try {
              var ed = new window.EyeDropper()
              ed.open().then(function (res) {
                if (res && res.sRGBHex) {
                  var hh = aesHexToHsv(res.sRGBHex)
                  h = hh.h; s = hh.s * 100; v = hh.v * 100
                  setColor(res.sRGBHex, true)
                }
              }).catch(function () {})
            } catch (err) {}
          })
          top.appendChild(drop)
        }
        var closeX = document.createElement('button')
        closeX.type = 'button'
        closeX.className = 'aes-picker-tool'
        closeX.textContent = '✕'
        closeX.title = '关闭'
        closeX.addEventListener('click', function (ev) { ev.stopPropagation(); closePanel() })
        top.appendChild(closeX)
        panel.appendChild(top)

        // 饱和度/明度 2D 面板（放大）
        var sv = document.createElement('div')
        sv.className = 'aes-picker-sv'
        sv.style.background = 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(' + h + ',100%,50%))'
        var svDot = document.createElement('div')
        svDot.className = 'aes-picker-sv-dot'
        sv.appendChild(svDot)
        bindDrag(sv, function (ev) {
          var r = sv.getBoundingClientRect()
          var x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
          var y = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))
          s = x * 100; v = (1 - y) * 100
          setColor(aesHsvToHex(h, s, v), true)
        })

        // 色相条（放大）
        var hue = document.createElement('div')
        hue.className = 'aes-picker-hue'
        var hueDot = document.createElement('div')
        hueDot.className = 'aes-picker-hue-dot'
        hue.appendChild(hueDot)
        bindDrag(hue, function (ev) {
          var r = hue.getBoundingClientRect()
          var x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
          h = Math.round(x * 360)
          setColor(aesHsvToHex(h, s, v), true)
        })

        // hex 输入 + 确定
        var row = document.createElement('div')
        row.className = 'aes-picker-row'
        var inp = document.createElement('input')
        inp.className = 'aes-picker-input'
        inp.value = current
        inp.placeholder = '#RRGGBB'
        inp.spellcheck = false
        inp.addEventListener('input', function () {
          var val = (inp.value || '').trim()
          if (/^#[0-9a-fA-F]{6}$/.test(val)) {
            var hh = aesHexToHsv(val)
            h = hh.h; s = hh.s * 100; v = hh.v * 100
            setColor(val)
          }
        })
        inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') closePanel() })
        var ok = document.createElement('button')
        ok.type = 'button'
        ok.className = 'aes-picker-ok'
        ok.textContent = '确定'
        ok.addEventListener('click', function () {
          var val = (inp.value || '').trim()
          if (/^#[0-9a-fA-F]{6}$/.test(val)) { var hh = aesHexToHsv(val); h = hh.h; s = hh.s * 100; v = hh.v * 100; setColor(val) }
          closePanel()
        })
        row.appendChild(inp)
        row.appendChild(ok)

        // 预设快捷色板（缩小 50%：9 列小圆点）
        var swRow = document.createElement('div')
        swRow.className = 'aes-picker-swatches'
        AES_PRESET_COLORS.forEach(function (c) {
          var sw = document.createElement('button')
          sw.type = 'button'
          sw.className = 'aes-picker-swatch'
          sw.style.background = c
          sw.title = c
          sw.addEventListener('click', function (ev) {
            ev.stopPropagation()
            var hh = aesHexToHsv(c); h = hh.h; s = hh.s * 100; v = hh.v * 100
            setColor(c, true)
          })
          swRow.appendChild(sw)
        })

        panel.appendChild(sv)
        panel.appendChild(hue)
        panel.appendChild(row)
        panel.appendChild(swRow)

        // 注入独立取色器样式（无前缀，面板挂 body 也能命中；不依赖查看器样式）
        try {
          if (typeof aesPickerSheet === 'function') aesPickerSheet()
        } catch (e) {}
        // 查看器样式（供面板内其他复用类兜底）
        if (!document.getElementById('dsh-raw-html-aes-style') && typeof aesSheet === 'function') {
          try { document.head.appendChild(aesSheet()) } catch (e) {}
        }
        // 记录全局引用（供 aesCloseAllPickers 清理）
        aesOpenPicker = { self: aesColorChip, closePanel: closePanel }

        // 挂 body + fixed 定位（不被模态内内容遮挡）
        document.body.appendChild(panel)
        var rect = btn.getBoundingClientRect()
        var pw = 280
        var left = Math.max(4, Math.min(rect.left, window.innerWidth - pw - 8))
        var estH = 300
        var topY = rect.bottom + 6
        if (topY + estH > window.innerHeight - 8) topY = Math.max(4, rect.top - estH - 6)
        panel.style.left = left + 'px'
        panel.style.top = topY + 'px'
        // 强制显隐确认（防御：某些环境 display 被样式覆盖）
        panel.style.display = 'block'
        if (window.console && console.debug) console.debug('[dsh-raw-html] aes-picker opened', left, topY)

        setColor(current)

        // 点击外部关闭
        outsideHandler = function (ev) {
          if (panel && !panel.contains(ev.target) && !btn.contains(ev.target)) closePanel()
        }
        document.addEventListener('mousedown', outsideHandler)
        // Esc 关闭
        escHandler = function (ev) { if (ev.key === 'Escape') closePanel() }
        document.addEventListener('keydown', escHandler)
      })
      return btn
    }

    /** 色板编辑器：一排取色圆点（点开自定义取色器）+ 加色/删色。 */
    function aesColorEditor(initial, onColorChange) {
      var box = document.createElement('div')
      box.className = 'aes-swatchedit'
      var colors = initial.slice()
      function render() {
        box.textContent = ''
        for (var i = 0; i < colors.length; i++) {
          (function (idx) {
            var wrap = document.createElement('span')
            wrap.className = 'aes-sw-wrap'
            var chip = aesColorChip(colors[idx], function (c) {
              colors[idx] = c
              onColorChange(colors.slice())
            })
            var rm = document.createElement('button')
            rm.type = 'button'
            rm.className = 'aes-sw-rm'
            rm.textContent = '✕'
            rm.title = '删除此色'
            rm.addEventListener('click', function (e) { e.stopPropagation(); colors.splice(idx, 1); render(); onColorChange(colors.slice()) })
            wrap.appendChild(chip)
            wrap.appendChild(rm)
            box.appendChild(wrap)
          })(i)
        }
        var add = document.createElement('button')
        add.type = 'button'
        add.className = 'aes-sw-add'
        add.textContent = '＋ 加色'
        add.addEventListener('click', function () { colors.push('#8899AA'); render(); onColorChange(colors.slice()) })
        box.appendChild(add)
      }
      render()
      return box
    }

    /** 字体分类板块：已选 chips（用字体本身渲染名字，hover 右上角 × 删除）+ 添加器（下拉菜单 + 搜索已加载字体）。 */
    /** 字体分类板块：已选 chips（用字体本身渲染名字，hover 右上角 × 删除）+ 添加器（下拉菜单 + 搜索已加载字体）。 */
    function aesFontCategory(label, initial, aliasMap, installed) {
      var wrap = document.createElement('div')
      wrap.className = 'aes-fontcat'
      var selected = (initial || []).slice()

      var head = document.createElement('div')
      head.className = 'aes-fontcat-head'
      var lab = document.createElement('div')
      lab.className = 'aes-fontcat-label'
      lab.textContent = label
      var addBtn = document.createElement('button')
      addBtn.type = 'button'
      addBtn.className = 'aes-fontcat-add'
      addBtn.textContent = '＋ 添加'
      var searchInp = document.createElement('input')
      searchInp.type = 'text'
      searchInp.className = 'aes-fontcat-search'
      searchInp.placeholder = '🔍 搜索字体…'
      head.appendChild(lab)
      head.appendChild(addBtn)
      head.appendChild(searchInp)
      wrap.appendChild(head)

      var chips = document.createElement('div')
      chips.className = 'aes-fontchips'
      wrap.appendChild(chips)

      var menu = document.createElement('div')
      menu.className = 'aes-fontcat-menu'
      menu.style.display = 'none'
      wrap.appendChild(menu)

      function isAliasKey(ak) { return Object.prototype.hasOwnProperty.call(aliasMap, ak) }

      // 字体懒加载观察器（先生 2026-08-27 定调 · 滚动加载）：菜单项滚动到可见才 load
      // 字体——首屏秒开、内存只驻留看过的字体（33 款 214MB 全量 → 仅首屏几十 MB）；
      // 已加载字体驻留 document.fonts，再次打开面板立即命中、无需重新下载。
      // root=menu（滚动容器）：菜单内部滚动时按可见性触发；display:none 时自动不触发。
      var fontLazyIO = null

      function buildMenu(filterText) {
        menu.textContent = ''
        var q = (filterText || '').trim().toLowerCase()
        var aliasKeys = Object.keys(aliasMap).sort(function (a, b) {
          if ((installed[b] ? 1 : 0) !== (installed[a] ? 1 : 0)) return (installed[b] ? 1 : 0) - (installed[a] ? 1 : 0)
          return a.localeCompare(b)
        })
        var added = 0
        // 滚动懒加载：断开旧观察器（菜单每次重建），按可见项观察；无 IO 时降级全量预加载
        if (fontLazyIO) fontLazyIO.disconnect()
        fontLazyIO = null
        if (window.IntersectionObserver) {
          fontLazyIO = new window.IntersectionObserver(function (entries) {
            for (var ei = 0; ei < entries.length; ei++) {
              var en = entries[ei]
              if (!en.isIntersecting) continue
              var it = en.target
              var rel2 = it.getAttribute('data-rel')
              if (rel2) aesEnsureFontFace(it.getAttribute('data-ak'), rel2)
              if (fontLazyIO) fontLazyIO.unobserve(it)
            }
          }, { root: menu, rootMargin: '60px 0px' })
        } else {
          // 降级（无 IntersectionObserver 的旧浏览器）：全量预加载已装字体（原行为）
          aliasKeys.forEach(function (ak) {
            if (selected.indexOf(ak) !== -1) return
            if (installed[ak] && aliasMap[ak]) aesEnsureFontFace(ak, aliasMap[ak])
          })
        }
        aliasKeys.forEach(function (ak) {
          if (selected.indexOf(ak) !== -1) return
          var disp = aesDispFont(ak)
          if (q && disp.toLowerCase().indexOf(q) === -1) return
          added++
          var item = document.createElement('button')
          item.type = 'button'
          item.className = 'aes-fontcat-menu-item'
          item.style.fontFamily = "'" + ak + "',sans-serif"
          item.setAttribute('data-ak', ak)
          if (installed[ak] && aliasMap[ak]) item.setAttribute('data-rel', aliasMap[ak])
          item.appendChild(document.createTextNode(disp))
          var meta = document.createElement('span')
          meta.className = 'aes-fontcat-menu-meta'
          meta.textContent = installed[ak] ? '已装' : '未装'
          item.appendChild(meta)
          if (fontLazyIO) fontLazyIO.observe(item)
          item.addEventListener('click', function () {
            selected.push(ak)
            if (aliasMap[ak]) aesEnsureFontFace(ak, aliasMap[ak])
            menu.style.display = 'none'
            searchInp.value = ''
            renderChips()
          })
          menu.appendChild(item)
        })
        if (!added) {
          var none = document.createElement('div')
          none.className = 'aes-fontcat-empty'
          none.textContent = '无匹配字体'
          menu.appendChild(none)
        }
      }

      // 点击菜单外部关闭（document 级 mousedown，面板打开时绑定）
      function closeMenuIfOutside(ev) {
        if (menu.style.display === 'none') return
        if (!wrap.contains(ev.target)) menu.style.display = 'none'
      }
      document.addEventListener('mousedown', closeMenuIfOutside)

      addBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        buildMenu(searchInp.value)
        var willShow = menu.style.display === 'none'
        document.querySelectorAll('.aes-fontcat-menu').forEach(function (m) { if (m !== menu) m.style.display = 'none' })
        menu.style.display = willShow ? 'block' : 'none'
      })
      searchInp.addEventListener('input', function () {
        if (menu.style.display !== 'none') buildMenu(searchInp.value)
      })
      menu.addEventListener('click', function (e) { e.stopPropagation() })

      function renderChips() {
        chips.textContent = ''
        if (!selected.length) {
          var empty = document.createElement('div')
          empty.className = 'aes-fontcat-empty'
          empty.textContent = '（未添加，agent 自由搭配）'
          chips.appendChild(empty)
          return
        }
        selected.forEach(function (ak) {
          var chip = document.createElement('span')
          chip.className = 'aes-chip'
          chip.style.fontFamily = "'" + ak + "',sans-serif"
          chip.title = ak + (isAliasKey(ak) && installed[ak] ? ' · 已装' : ' · 未装')
          chip.appendChild(document.createTextNode(aesDispFont(ak)))
          if (isAliasKey(ak) && installed[ak]) {
            var dot = document.createElement('span')
            dot.className = 'aes-chip-dot'
            dot.textContent = '✓'
            chip.appendChild(dot)
          }
          var x = document.createElement('button')
          x.type = 'button'
          x.className = 'aes-chip-x'
          x.textContent = '✕'
          x.title = '移除 ' + aesDispFont(ak)
          x.addEventListener('click', function (e) {
            e.stopPropagation()
            var idx = selected.indexOf(ak)
            if (idx !== -1) selected.splice(idx, 1)
            renderChips()
          })
          chip.appendChild(x)
          chips.appendChild(chip)
        })
      }

      renderChips()
      return {
        wrap: wrap,
        getValue: function () { return selected.slice() },
        setValue: function (names) {
          selected = (names || []).filter(function (n) { return isAliasKey(n) }).slice(0, 6)
          renderChips()
        },
      }
    }

    /** 新建风格模态：名称/slug/场景/标签/核心思路/色板编辑器/字体选择+预览/确定。 */
    function openAesNewStyle(existing) {
      existing = existing || null
      aesRpc('list-fonts').then(function (fd) {
        var aliasMap = (fd && fd.aliasMap) || {}
        var installed = (fd && fd.installed) || {}
        var view = document.getElementById(AES_VIEWER_ID)
        if (!view) return

        var mask = document.createElement('div')
        mask.className = 'aes-modal'
        var mpanel = document.createElement('div')
        mpanel.className = 'aes-modal-panel'

        var head = document.createElement('div')
        head.className = 'aes-head'
        var tWrap = document.createElement('div')
        var t = document.createElement('div')
        t.className = 'aes-title'
        t.textContent = existing ? '编辑美学风格' : '新建美学风格'
        var sub = document.createElement('div')
        sub.className = 'aes-subtitle'
        sub.textContent = existing ? '对「' + existing.name + '」进行改造，保存后即时生效' : '把找到的关键词与想法，变成一份可被检索的风格'
        tWrap.appendChild(t)
        tWrap.appendChild(sub)
        var close = document.createElement('button')
        close.className = 'aes-btn'
        close.textContent = '✕ 关闭'
        close.title = '关闭（不保存）'
        close.addEventListener('click', function () { aesCloseAllPickers(); mask.remove() })
        head.appendChild(tWrap)
        head.appendChild(close)
        mpanel.appendChild(head)

        var body = document.createElement('div')
        body.className = 'aes-modal-body'

        function field(label, node, hint) {
          var f = document.createElement('div')
          f.className = 'aes-field'
          var lb = document.createElement('label')
          lb.className = 'aes-field-label'
          lb.textContent = label
          f.appendChild(lb)
          f.appendChild(node)
          if (hint) { var h = document.createElement('div'); h.className = 'aes-muted'; h.textContent = hint; f.appendChild(h) }
          return f
        }

        var nameInp = document.createElement('input')
        nameInp.className = 'aes-input'
        nameInp.placeholder = '例如：琉璃手账 · 透明感'
        if (existing) nameInp.value = existing.name || ''
        body.appendChild(field('风格名称 *', nameInp))

        var slugInp = document.createElement('input')
        slugInp.className = 'aes-input'
        slugInp.placeholder = '留空自动生成（英文小写连字符最佳）'
        if (existing) { slugInp.value = existing.slug || ''; slugInp.readOnly = true; slugInp.title = '编辑模式下 slug 不可改（文件名/检索键）' }
        body.appendChild(field('标识 slug', slugInp, '留空将根据名称自动生成；仅用于文件命名与检索' + (existing ? '（编辑模式下锁定）' : '')))

        var sceneInp = document.createElement('input')
        sceneInp.className = 'aes-input'
        sceneInp.placeholder = '例如：手账 / 便签 / 心情记录'
        if (existing) sceneInp.value = existing.scene || ''
        body.appendChild(field('适用场景', sceneInp))

        var tagInp = document.createElement('input')
        tagInp.className = 'aes-input'
        tagInp.placeholder = '逗号分隔，例如：透明, 手账, 清新'
        if (existing) tagInp.value = existing.tags || ''
        body.appendChild(field('标签', tagInp))

        var descTa = document.createElement('textarea')
        descTa.className = 'aes-input aes-ta'
        descTa.rows = 4
        if (existing) descTa.value = existing.desc || ''
        descTa.placeholder = '这个风格的灵魂是什么？\n它像什么材质（纸/玻璃/塑料）？什么光（晨光/霓虹）？什么心绪（安静/雀跃）？\n有什么一眼可辨的视觉特征？\n写可迁移的判断逻辑——别人看到能照着做；留空可点「✨ AI 兜底」自动生成'
        var descWrap = document.createElement('div')
        var aiBtn = document.createElement('button')
        aiBtn.type = 'button'
        aiBtn.className = 'aes-btn'
        aiBtn.textContent = '✨ AI 生成'
        aiBtn.title = '输入你的想法后点击：AI 自动把名称/场景/标签/描述/色板/字体全部填好'
        aiBtn.addEventListener('click', function () {
          var idea = (nameInp.value || '') + ' ' + (sceneInp.value || '') + ' ' + (tagInp.value || '') + ' ' + (descTa.value || '')
          idea = idea.trim()
          if (!idea) { descTa.value = '（请输入你的想法，例如：想做一个透明感的手账风格，清新治愈）'; return }
          aiBtn.textContent = '⏳ AI 生成中…'
          aiBtn.disabled = true
          var hintEl = document.createElement('div')
          hintEl.className = 'aes-muted'
          hintEl.style.color = '#16a34a'
          hintEl.style.marginTop = '4px'
          hintEl.textContent = 'AI 正在理解你的想法并生成完整风格…'
          descWrap.appendChild(hintEl)
          aesRpc('ai-generate', { idea: idea }).then(function (d) {
            aiBtn.textContent = '✨ AI 生成'
            aiBtn.disabled = false
            if (!d || d.error) {
              hintEl.textContent = '生成失败：' + ((d && d.error && (d.error.message || JSON.stringify(d.error))) || '未知错误') + '，请重试或换一种描述'
              return
            }
            // 填名称/场景/标签/描述/slug
            if (d.name && !nameInp.value.trim()) nameInp.value = d.name
            if (d.slug && !slugInp.value.trim()) slugInp.value = d.slug
            if (d.scene && !sceneInp.value.trim()) sceneInp.value = d.scene
            if (d.tags && !tagInp.value.trim()) tagInp.value = d.tags
            if (d.desc) descTa.value = d.desc
            // 填色板
            if (d.colors && d.colors.length) {
              colorState = d.colors.slice()
              if (colorBox && colorBox.parentNode) {
                var newBox = aesColorEditor(colorState, function (c) { colorState = c })
                colorBox.parentNode.replaceChild(newBox, colorBox)
                colorBox = newBox
              }
            }
            // 填字体四分类
            if (d.fonts) {
              if (d.fonts.title) fontTitle.setValue(d.fonts.title)
              if (d.fonts.subtitle) fontSub.setValue(d.fonts.subtitle)
              if (d.fonts.body) fontBody.setValue(d.fonts.body)
              if (d.fonts.deco) fontDeco.setValue(d.fonts.deco)
            }
            hintEl.textContent = '✓ 已由 AI 生成完整风格，可再微调'
          })
        })
        descWrap.appendChild(descTa)
        descWrap.appendChild(aiBtn)
        descWrap.style.marginTop = '4px'
        body.appendChild(field('核心思路 / 判断准则', descWrap))

        var colorState = existing && existing.colors && existing.colors.length ? existing.colors.slice() : ['#F7F2EB', '#081F5C', '#334EAC', '#D4A017']
        var colorBox = aesColorEditor(colorState, function (c) { colorState = c })
        body.appendChild(field('色板', colorBox, '点色块改色，× 删除，+ 加色'))

        // 四分类字体：主标题/副标题/正文/装饰——agent 创作时按语境挑选，而非死绑一个
        // 编辑模式：预填 existing.fontCats（Host parseStyleMeta 解析的结构化字体分类）
        var initFonts = existing && existing.fontCats ? existing.fontCats : {}
        var fontTitle = aesFontCategory('主标题', initFonts.title || [], aliasMap, installed)
        var fontSub = aesFontCategory('副标题', initFonts.subtitle || [], aliasMap, installed)
        var fontBody = aesFontCategory('正文', initFonts.body || [], aliasMap, installed)
        var fontDeco = aesFontCategory('装饰', initFonts.deco || [], aliasMap, installed)
        var fontBlock = document.createElement('div')
        // 提示放在「字体分类（多选）」标题正下方、四分类之上
        var fontHint = document.createElement('div')
        fontHint.className = 'aes-fontcat-hint'
        fontHint.style.marginTop = '2px'
        fontHint.style.fontSize = '10px'
        fontHint.style.color = 'var(--dsw-alias-label-tertiary,#777)'
        fontHint.textContent = '每类可多选；agent 创作时会按内容语境从中挑选'
        fontBlock.appendChild(fontHint)
        fontBlock.appendChild(fontTitle.wrap)
        fontBlock.appendChild(fontSub.wrap)
        fontBlock.appendChild(fontBody.wrap)
        fontBlock.appendChild(fontDeco.wrap)
        body.appendChild(field('字体分类（多选）', fontBlock))

        mpanel.appendChild(body)

        var foot = document.createElement('div')
        foot.className = 'aes-modal-foot'
        var err = document.createElement('div')
        err.className = 'aes-muted'
        err.style.color = '#dc2626'
        err.style.flex = '1'
        var cancel = document.createElement('button')
        cancel.className = 'aes-btn'
        cancel.textContent = '取消'
        cancel.addEventListener('click', function () { aesCloseAllPickers(); mask.remove() })
        var ok = document.createElement('button')
        ok.className = 'aes-btn aes-btn-primary'
        ok.textContent = existing ? '保存修改' : '确定创建'
        ok.addEventListener('click', function () {
          var name = nameInp.value.trim()
          if (!name) { err.textContent = '请填写风格名称'; return }
          var slug = existing ? existing.slug : slugInp.value.trim()
          if (!slug) {
            slug = name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || ('user-style-' + Date.now().toString().slice(-6))
          }
          var payload = {
            name: name,
            slug: slug,
            scene: sceneInp.value.trim(),
            tags: tagInp.value.trim(),
            desc: descTa.value.trim(),
            colors: colorState,
            fonts: {
              title: fontTitle.getValue(),
              subtitle: fontSub.getValue(),
              body: fontBody.getValue(),
              deco: fontDeco.getValue(),
            },
          }
          var ep = existing ? 'update-style' : 'create-style'
          aesRpc(ep, payload).then(function (d) {
            if (d && d.error) { err.textContent = (existing ? '保存失败：' : '创建失败：') + (d.error.message || JSON.stringify(d.error)); return }
            if (!d || !d.slug) { err.textContent = (existing ? '保存失败：' : '创建失败：') + '未收到确认'; return }
            aesCloseAllPickers()
            mask.remove()
            var v = document.getElementById(AES_VIEWER_ID)
            if (v && typeof v._aesRender === 'function') v._aesRender()
          })
        })
        foot.appendChild(err)
        foot.appendChild(cancel)
        foot.appendChild(ok)
        mpanel.appendChild(foot)

        mask.appendChild(mpanel)
        view.appendChild(mask)

        mask.addEventListener('click', function (e) { if (e.target === mask) { aesCloseAllPickers(); mask.remove() } })
        var esc2 = function (e) { if (e.key === 'Escape') { aesCloseAllPickers(); mask.remove(); document.removeEventListener('keydown', esc2) } }
        document.addEventListener('keydown', esc2)
      })
    }

    // ---- 应用 ------------------------------------------------------------

    function apply(ctx) {
      // 旧版单开关状态迁移（仅一次）
      migrateState()

      // 暴露 input 桥（隔离渲染器把受控 onclick 转成 data-vcp-input 后调用）
      window.__dshInput = sendText

      // 通过官方 keyed slot 接管 assistant-step。普通消息始终复用官方组件；
      // raw-html 条目崩溃时，slot 错误边界会自动回退到被遮蔽的官方条目。
      registerAssistantRenderer(ctx)

      // 卡片 hover 下载：全局单例浮动按钮 + 事件委托（不插 React DOM）
      initDownload()

      // 加载 KaTeX 数学公式资源（改名版 CSS + katex.js → auto-render.js 链式）
      ensureMathAssets()
      // 加载 Mermaid 图表引擎（异步，未就绪时渲染层轮询重试）
      ensureMermaidAssets()
      // 加载 VCP 色彩引擎（data-vcp-preset 声明式配色，未就绪时渲染层静默降级）
      ensureColorEngine()

      // 初始化 Host RPC 并上报当前开关状态（Host 据此注入/撤回 VCP 协议说明）
      hostRpc = makeHostRpc(ctx)
      syncHostState(hostRpc, isRenderEnabled(), isAestheticEnabled())

      // 全局注册已安装字体 @font-face：模型输出的 Lanxi-* 字体名直接命中真实字体，
      // 不再回退系统黑体（先生 2026-08-27 实测：此前仅面板打开时才注册）
      ensureGlobalFonts(ctx)

      // 「更多模式」芯片：conversation.input.right 槽（order 4.5 → 优化提示词
      // 左边；槽渲染随 composer zone 出现，hero 与会话内均显示）。原 send 键
      // 尾部 DOM 注入 + MutationObserver 补挂机制整体退役。
      registerModesChip(ctx)

      window.addEventListener('pagehide', function () {
        closePanel()
      })
    }

    // 安全过滤函数导出：供 EAC 项目级测试（test/raw-html-sanitize.test.ts）在
    // Node/jsdom 中直接验证渲染安全模型，避免依赖已废弃的 bundle 注入引擎。
    exports.sanitizeVcpHtml = sanitizeVcpHtml
    exports.sanitizeCss = sanitizeCss
    exports.isAllowedUrl = isAllowedUrl
    exports.hasVcpRoot = hasVcpRoot
    exports.registerAssistantRenderer = registerAssistantRenderer

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})

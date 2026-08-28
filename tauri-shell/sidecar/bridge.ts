/// <reference lib="dom" />
'use strict';
// DSH 桌面桥（P3 全量版）：在 Tauri WebView2 里按 preload.js 的键集与语义
// 逐字节重建 window.dshDesktop（transport = 回环 WS JSON-RPC，而非 ipcRenderer）。
//
// 通道分流：
//   win.*                → Rust 壳层在 WS 中继处本地拦截（窗口控制/拖拽/开发工具）
//   其余（chrome.init / service.restart / balance.* / plugins.* / rescue.* …）
//                        → 转发 sidecar（lib/desktop 模块族，P3 渐进收编）
//   通知帧（无 id）      → win.maximized / dsh.balance / boot.web-ready 推送
//
// 页面侧 chrome：36px 玻璃栏（主窗）/ 24px 细条（浮窗），mousedown →
// win.start-dragging（WebView2 无 -webkit-app-region），5s 心跳，页面异常上报。
// 拖入文件路径（getPathForFile）返回 ''，与浏览器打开 WebUI 时一致，插件自带降级。

(function () {
  var BAR_ID = '__dsh_desktop_chrome__';
  var BAR_HEIGHT = 36;
  var FLOAT_BAR_ID = '__dsh_desktop_floatbar__';
  var FLOAT_BAR_HEIGHT = 24;

  // 回环 WS JSON-RPC 客户端（单源：assets/ws-jsonrpc-client.js，Rust 壳在
  // initialization_script 序列中先注入本桥）。connect/queue/call/重连逻辑
  // 只存在于单源文件；这里只做钩子接线与语义别名。
  var notifyHooks: ((method: string, params: any) => void)[] = [];
  var readyHooks: ((info: any) => void)[] = [];
  var rpc = (window as any).__DSH_WS_RPC__({
    onOpen: function () {
      call('chrome.init', {}).then(function (info) {
        try { readyHooks.forEach(function (h) { h(info); }); } catch (e) { /* 页面回调异常不断桥 */ }
      }).catch(function () { /* chrome.init 不可用不致命 */ });
    },
  });
  rpc.onNotify(function (method: string, params: any): void {
    try { notifyHooks.forEach(function (h) { h(method, params); }); } catch (e) { /* 同上 */ }
  });

  // fire-and-forget（ipcRenderer.send 语义）：不等回复，断了就丢。
  function send(method: string, params?: unknown): void { rpc.send(method, params); }
  // invoke 语义（ipcRenderer.invoke）：Promise + 超时。
  function call(method: string, params?: unknown, timeoutMs?: number): Promise<any> { return rpc.call(method, params, timeoutMs); }
  function onNotify(fn: (method: string, params: any) => void): void { notifyHooks.push(fn); }

  // ---------------------------------------------------------------------------
  // window.dshDesktop（键集与 preload.js:26-127 一致；契约测试锁定）
  // ---------------------------------------------------------------------------
  (window as any).dshDesktop = {
    appVersion: '', // chrome.init 回填；旧字段保持存在
    windowControls: {
      minimize: function () { return call('win.minimize', {}); },
      toggleMaximize: function () { return call('win.toggle-maximize', {}); },
      close: function () { return call('win.close', {}); },
      isMaximized: function () { return call('win.is-maximized', {}).then(function (r) { return !!(r && r.maximized); }); },
      onMaximizeChange: function (cb: (maximized: boolean) => void) {
        var hook = function (method: string, params: any) {
          if (method !== 'win.maximized') return;
          try { cb(!!(params && params.maximized)); } catch (e) { /* 回调异常不断桥 */ }
        };
        notifyHooks.push(hook);
        return function () {
          var i = notifyHooks.indexOf(hook);
          if (i >= 0) notifyHooks.splice(i, 1);
        };
      },
    },
    menu: {
      action: function (action: string, payload?: Record<string, unknown>) {
        var p = Object.assign({}, payload || {});
        (p as any).action = action;
        return call('menu.action', p);
      },
    },
    getInfo: function () { return call('chrome.init', {}); },
    refreshBalance: function () { return call('balance.refresh', {}); },
    // 插件市场：请求原地重启 dsh web 服务（安装/卸载插件后生效）。
    restartService: function () { return call('service.restart', { intent: 'restart-service' }); },
    // 会话浮窗（多窗口）：主窗请求把某个会话弹出到独立窗口；浮窗关闭自身。
    floatWindow: {
      open: function (sessionId: string) { return call('float.open', { sessionId: sessionId }); },
      close: function () {
        // 壳层按标签关窗：浮窗 init 脚本把 window.__DSH_FLOAT__.win 置为标签。
        var f = (window as any).__DSH_FLOAT__;
        send('float.close', { win: f && f.win });
      },
    },
    // 手机连接桥（5.1.1）：LAN 配对 + 白名单 RPC + 手机端占位页。消费端是
    // 内置插件 dsh-phone 的设置页「连接手机」；键集与 preload.ts 一致（契约锁定）。
    phoneBridge: {
      start: function () { return call('phone.start', {}); },
      stop: function () { return call('phone.stop', {}); },
      status: function () { return call('phone.status', {}); },
      decide: function (approved: boolean) { return call('phone.decide', { approved: !!approved }); },
      disconnect: function () { return call('phone.disconnect', {}); },
      onStatus: function (cb: (status: any) => void) {
        var hook = function (method: string, params: any) {
          if (method !== 'phone.status') return;
          try { cb(params); } catch (e) { /* 回调异常不断桥 */ }
        };
        notifyHooks.push(hook);
        return function () {
          var i = notifyHooks.indexOf(hook);
          if (i >= 0) notifyHooks.splice(i, 1);
        };
      },
    },
    // 插件保护中心：快照 / 回滚 / 体检 / 修复 / 事故报告。
    guard: {
      action: function (action: string, value?: unknown) { return call('guard.action', { action: action, value: value }); },
    },
    // 内置插件选择向导。
    pluginWizard: {
      open: function () { return call('wizard.open', {}); },
    },
    // 插件管理：列出/启停/移除恢复（写 profile cordis.patch.yml）。
    pluginManager: {
      list: function () { return call('plugins.list', {}); },
      setEnabled: function (id: string, enabled: boolean) { return call('plugins.set-enabled', { id: id, enabled: enabled }); },
      setRemoved: function (id: string, removed: boolean) { return call('plugins.set-removed', { id: id, removed: removed }); },
    },
    // 插件更新：清单 / 手动更新单个 / 自动更新开关。
    pluginUpdates: {
      list: function (force?: boolean) { return call('plugins.updates', { force: force === true }); },
      update: function (id: string) { return call('plugins.update', { id: id }); },
      setAutoUpdate: function (enabled: boolean) { return call('plugins.auto-update', { enabled: enabled }); },
    },
    // 图片粘贴：剪贴板图片存临时目录，返回 { ok, path, size }。
    imagePaste: {
      save: function (payload: Record<string, unknown>) { return call('image-paste.save', payload || {}); },
    },
    // 拖入文件（zip/二进制等）：dataUrl → 临时目录 → 真实路径，供 agent 按路径读取。
    fileDrop: {
      save: function (payload: Record<string, unknown>) { return call('file-drop.save', payload || {}); },
    },
    // Token 价格自定义：读取/保存/恢复（¥/百万 token）。
    balancePrices: {
      get: function (model: string) { return call('balance.prices-get', { model: model }); },
      set: function (model: string, prices: unknown) { return call('balance.prices-set', { model: model, prices: prices }); },
      reset: function (model: string) { return call('balance.prices-reset', { model: model }); },
    },
    balanceModels: {
      list: function () { return call('balance.models', {}); },
    },
    revertFiles: function (changes: unknown) { return call('files.revert', { changes: changes }); },
    openPath: function (path: string) { return call('files.open', { path: path }); },
    openExternal: function (url: string) { return call('shell.open-external', { url: url }); },
    copyText: function (text: string) { return call('clipboard.write-text', { text: text }); },
    // 浏览器环境无 File 磁盘路径：返回空串，插件降级为可读提示（与浏览器打开
    // WebUI 时的行为一致）。
    getPathForFile: function (): string { return ''; },
    // 恢复页面动作与状态读取。
    recovery: {
      getState: function () { return call('recovery.state', {}); },
      reload: function () { return call('recovery.reload', {}); },
      restart: function () { return call('recovery.restart', {}); },
      exportLogs: function () { return call('recovery.export-logs', {}); },
    },
    // 崩溃救援：状态/确认清单/AI 诊断/逐项批准/安全模式/重试/自动修复。
    rescue: {
      getState: function () { return call('rescue.state', {}); },
      confirm: function () { return call('rescue.confirm', {}); },
      diagnose: function (selections: unknown, userNote?: string) { return call('rescue.diagnose', { selections: selections, userNote: userNote }); },
      apply: function (suggestion: unknown) { return call('rescue.apply', { suggestion: suggestion }); },
      setSafeMode: function (on: boolean) { return call('rescue.safe-mode', { on: on }); },
      retry: function () { return call('rescue.retry', {}); },
      autoRepair: function () { return call('rescue.auto-repair', {}); },
    },
    // 桥内省（壳层页面与冒烟用；不属于 preload 键集）。
    _call: call,
    _send: send,
    _onNotify: onNotify,
    _onReady: function (fn: (info: any) => void) { readyHooks.push(fn); },
  };
  var dshDesktop: any = (window as any).dshDesktop;

  // ---------------------------------------------------------------------------
  // 浮窗模式：Rust 创建浮窗时注入 window.__DSH_FLOAT__ = { sessionId, win }，
  // 预置目标会话到持久化，让 Web UI 一启动就选中目标会话。
  // ---------------------------------------------------------------------------
  var FLOAT_MODE: { sessionId: string; win?: string } | null = (window as any).__DSH_FLOAT__ || null;
  if (FLOAT_MODE) {
    try {
      var key = 'dsh.sessions.current';
      var raw = localStorage.getItem(key);
      var parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object') {
        parsed.sessionId = String(FLOAT_MODE.sessionId);
        delete parsed.subagentAddress;
        localStorage.setItem(key, JSON.stringify(parsed));
      }
    } catch (e) { /* 忽略持久化失败 */ }
  }

  // 页面异常 → 壳层日志。
  window.addEventListener('error', function (e) {
    try { send('log.page-error', { message: 'window.onerror: ' + ((e && (e.message || e.error)) || 'unknown') }); } catch (err) { /* 忽略 */ }
  });
  window.addEventListener('unhandledrejection', function (e) {
    try { send('log.page-error', { message: 'unhandledrejection: ' + String((e && (e as any).reason && ((e as any).reason.message || (e as any).reason)) || e) }); } catch (err) { /* 忽略 */ }
  });

  // 余额推送 → window 事件（dsh-balance 插件订阅）。
  onNotify(function (method, params) {
    if (method !== 'dsh.balance') return;
    try { window.dispatchEvent(new CustomEvent('dsh-balance-changed', { detail: params })); } catch (e) { /* 忽略 */ }
  });

  // ---------------------------------------------------------------------------
  // Chrome DOM（36px 玻璃栏 / 浮窗 24px 细条；拖拽 = mousedown → win.start-dragging）
  // ---------------------------------------------------------------------------
  var GLYPHS = {
    menu: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="2.4" cy="6" r="1.15"/><circle cx="6" cy="6" r="1.15"/><circle cx="9.6" cy="6" r="1.15"/></svg>',
    min: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 6h7"/></svg>',
    max: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4"/></svg>',
    restore: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4.2 4.2V2.6h5.2v5.2H7.8"/><rect x="2.6" y="4.2" width="5.2" height="5.2" rx="1.2"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg>',
  };

  var menuOpen = false;
  var menuEl: HTMLElement | null = null;
  var maxBtn: HTMLElement | null = null;
  var state: any = { appVersion: '', agentVersion: '', agentSource: '', notifyOnTurnEnd: true, closeToTray: true, exitAction: 'ask', shortcutPolicy: 'auto' };

  var EXIT_ACTIONS = [
    { value: 'ask', label: '每次询问' },
    { value: 'minimize', label: '后台运行（最小化到托盘）' },
    { value: 'quit', label: '直接退出' },
  ];

  function esc(s: any): string { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string; }); }

  // WebView2 无 -webkit-app-region:drag —— mousedown 转发壳层 start_dragging。
  // 双击标题 = 最大化/还原（Electron 拖拽区默认行为对齐）。
  function armDrag(el: Element): void {
    var lastClick = 0;
    el.addEventListener('mousedown', function (e) {
      if ((e as MouseEvent).button !== 0) return;
      var target = e.target as HTMLElement | null;
      // 按钮上的按下不触发拖拽（关闭/菜单等仍可点击）。
      if (target && target.closest && target.closest('button')) return;
      var now = Date.now();
      if (now - lastClick < 400) {
        lastClick = 0;
        dshDesktop.windowControls.toggleMaximize().catch(function () { /* 壳层不可用时静默 */ });
        return;
      }
      lastClick = now;
      send('win.start-dragging', {});
    });
  }

  function renderMenu(): void {
    if (!menuEl) return;
    menuEl.innerHTML = '\
    <div class="dch-mh">\
      <div class="dch-mh-title">Deepseek Harness EAC <span style="font-weight:400;color:var(--dsw-alias-label-tertiary)">封装 v' + esc(state.appVersion) + '</span></div>\
      <div class="dch-mh-sub"><span>agent v' + esc(state.agentVersion) + '</span><span>' + esc(state.agentSource) + '</span></div>\
    </div>\
    <button class="dch-item" data-act="check-agent-update">检查 dsh 更新…</button>\
    <button class="dch-item" data-act="check-client-update">检查客户端更新…</button>\
    <div class="dch-repos">\
      <div class="dch-repos-title">更新源（点击复制）</div>\
      <div class="dch-repo-row">\
        <span class="dch-repo-url" title="' + esc(state.repoUrls ? state.repoUrls.github : '') + '">' + esc(state.repoUrls ? state.repoUrls.github : '') + '</span>\
        <button class="dch-copy" data-copy="github" title="复制地址">复制</button>\
      </div>\
      <div class="dch-repo-row">\
        <span class="dch-repo-url" title="' + esc(state.repoUrls ? state.repoUrls.gitee : '') + '">' + esc(state.repoUrls ? state.repoUrls.gitee : '') + '</span>\
        <button class="dch-copy" data-copy="gitee" title="复制地址">复制</button>\
      </div>\
    </div>\
    <button class="dch-item" data-act="toggle-notify"><span>会话完成通知</span>' + (state.notifyOnTurnEnd ? '<span class="dch-check">✓</span>' : '') + '</button>\
    <button class="dch-item" data-act="toggle-shortcut-policy"><span>桌面快捷方式自动维护</span>' + (state.shortcutPolicy !== 'never' ? '<span class="dch-check">✓</span>' : '') + '</button>\
    <div class="dch-exit-group">\
      <div class="dch-exit-title">关闭窗口时</div>\
      ' + EXIT_ACTIONS.map(function (opt) { return '<button class="dch-item dch-exit-item" data-act="set-exit-action" data-value="' + opt.value + '"><span>' + opt.label + '</span>' + (state.exitAction === opt.value ? '<span class="dch-check">✓</span>' : '') + '</button>'; }).join('') + '\
    </div>\
    <div class="dch-sep"></div>\
    <button class="dch-item" data-act="restart-service"><span>重启 Web 服务</span><span class="dch-kbd">不关闭应用</span></button>\
    <button class="dch-item" data-act="reload"><span>重新加载</span><span class="dch-kbd">Ctrl+R</span></button>\
    <button class="dch-item" data-act="devtools"><span>开发者工具</span><span class="dch-kbd">F12</span></button>\
    <button class="dch-item" data-act="fullscreen"><span>全屏</span><span class="dch-kbd">F11</span></button>\
    <div class="dch-sep"></div>\
    <button class="dch-item" data-act="open-browser">在浏览器中打开</button>\
    <button class="dch-item" data-act="export-logs">导出日志</button>\
    <button class="dch-item" data-act="feedback">反馈建议</button>\
    <div class="dch-sep"></div>\
    <button class="dch-item" data-act="about">关于 Deepseek Harness EAC</button>\
    <button class="dch-item" data-danger="1" data-act="quit">退出</button>';
    menuEl.querySelectorAll('.dch-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var act = (item as HTMLElement).getAttribute('data-act') || '';
        if (act === 'toggle-notify' || act === 'toggle-shortcut-policy' || act === 'set-exit-action') {
          var payload = act === 'set-exit-action' ? { value: (item as HTMLElement).getAttribute('data-value') } : undefined;
          dshDesktop.menu.action(act, payload).then(function (next: any) {
            if (next) state = Object.assign({}, state, next);
            renderMenu();
          }).catch(function () { /* 菜单动作失败静默 */ });
          return;
        }
        closeMenu();
        dshDesktop.menu.action(act).catch(function () { /* 同上 */ });
      });
    });
    (menuEl as HTMLElement).querySelectorAll('.dch-copy').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var kind = (btn as HTMLElement).getAttribute('data-copy');
        var url = state.repoUrls && (kind === 'github' ? state.repoUrls.github : state.repoUrls.gitee);
        if (!url) return;
        dshDesktop.copyText(url).then(function (r: any) {
          if (r && r.ok) {
            var prev = (btn as HTMLElement).textContent;
            (btn as HTMLElement).textContent = '已复制 ✓';
            setTimeout(function () { (btn as HTMLElement).textContent = prev; }, 1200);
          }
        }).catch(function () { /* 复制失败静默 */ });
      });
    });
  }

  function closeMenu(): void {
    menuOpen = false;
    if (menuEl) menuEl.hidden = true;
  }

  function openMenu(): void {
    if (!menuEl) return;
    dshDesktop.getInfo().then(function (info: any) {
      if (info) state = Object.assign({}, state, info);
      renderMenu();
      menuOpen = true;
      menuEl!.hidden = false;
    }).catch(function () {
      renderMenu();
      menuOpen = true;
      menuEl!.hidden = false;
    });
  }

  function setMaximized(isMax: boolean): void {
    if (!maxBtn) return;
    maxBtn.innerHTML = isMax ? GLYPHS.restore : GLYPHS.max;
    maxBtn.title = isMax ? '还原' : '最大化';
    maxBtn.setAttribute('aria-label', maxBtn.title);
  }

  // ---------------------------------------------------------------------------
  // UI 稳定性垫片（主窗与浮窗共用；issue #217 同款桥内 CSS 通道，不碰内核/插件）。
  // 背景：DSH 0.1.x 配套插件与内核弹层存在三类布局问题，全新/覆盖安装均复现：
  //  a) 抽搐 —— dsh-better-sidebar 对 #root 与中栏注入 0.3s margin 过渡，会话切换
  //     或面板开合时整条中栏（含输入栏）随之滑动/回读抖动；这里的布局让位仍
  //     保留，只是瞬间到位（transition 掐断）。
  //  b) 新建对话裁剪 —— hero 阶段 scrollBody 用 justify-content:center 居中内容，
  //     内容高于视口时顶部不可滚动到达、被 overflow 链与自绘标题栏切掉；改为
  //     flex-start + 子项 margin-block:auto：放得下时居中、放不下时从顶排布可滚。
  //  c) 模型选择弹层遮挡 —— 菜单 absolute 向上展开且 z 只有 20，顶部会捅出滚动
  //     容器/视口并被高 z 覆盖物盖住；抬到内容层之上并支持「翻转向下」救援。
  //  d) 悬停浮层横向溢出 —— 提示词优化面板与「/」命令菜单等 absolute 浮层向上展开
  //     时会把 hero 输入区滚动容器撑出横向溢出（hero 态只设 overflow-y，x 轴未
  //     裁剪），出现横贯窗口的横向滚动条；且面板常驻挂载（仅隐身），移出后溢出
  //     依旧。在输入区滚动体与 body 层把 x 轴溢出钉死，横向滚动条不再出现。
  // ---------------------------------------------------------------------------
  function injectUiPatchCss(): void {
    if (document.getElementById('dsh-ui-patch')) return;
    var tag = document.createElement('style');
    tag.id = 'dsh-ui-patch';
    tag.textContent = '\
  html[data-dsh-title-bar-height] #root,\
  html[data-dsh-title-bar-height] #root > div[data-slot="root"] > div > div:nth-child(2){transition:none!important}\
  html[data-dsh-title-bar-height] .wSkVaW_root[data-phase=hero] .wSkVaW_scrollBody{justify-content:flex-start!important}\
  html[data-dsh-title-bar-height] .wSkVaW_root[data-phase=hero] .wSkVaW_scrollBody > *{margin-block:auto!important}\
  html[data-dsh-title-bar-height] ._7KE1Ra_menu{z-index:5100!important}\
  html[data-dsh-title-bar-height] ._7KE1Ra_menu.dsh-popup-flip{top:calc(100% + 8px)!important;bottom:auto!important}\
  html[data-dsh-title-bar-height] .wSkVaW_composerStack:has(._7KE1Ra_menu){overflow:visible!important}\
  html[data-dsh-title-bar-height] .wSkVaW_root[data-phase=hero] .wSkVaW_scrollBody{overflow-x:hidden!important}\
  html[data-dsh-title-bar-height] body{overflow-x:hidden!important}';
    document.head.appendChild(tag);
  }

  // 模型选择弹层救援：菜单绝对定位向上展开（最高 360px + 8px 间距），在 hero
  // 页或矮窗口里顶部会越出滚动容器/视口被切。探到菜单顶部进入玻璃栏区（<40px）
  // 就翻转向下展开，并按触发钮下方可用空间收缩高度；菜单关闭或空间充足时还原。
  // 翻转向下后菜单会伸出 composerStack（overflow:auto）的盒子 —— 配套 CSS 用
  // :has(._7KE1Ra_menu) 在菜单打开时放开该容器裁剪（见 injectUiPatchCss）。
  function initPopupRescue(): void {
    var MENU_SEL = '._7KE1Ra_menu';
    var FLIP_CLS = 'dsh-popup-flip';
    var BAR_EDGE = 40;
    var probeTimer: number | null = null;
    // 翻转态按菜单元素保存（WeakSet，菜单卸载即回收）：翻转与否只在菜单开起来
    // 时判定一次。绝不能根据翻转后的 r.top 还原 —— 翻转让它 ≥40，还原又让它
    // <40，会形成每 200ms 翻转↔复原的震荡（弹层自带抽搐，且导致位置随机）。
    var flippedMenus = new WeakSet<HTMLElement>();

    function probeMenus(): void {
      probeTimer = null;
      var menus = document.querySelectorAll(MENU_SEL);
      var anyOpen = false;
      for (var i = 0; i < menus.length; i++) {
        var menu = menus[i] as HTMLElement;
        var r = menu.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // 未渲染/已关闭
        anyOpen = true;
        if (!flippedMenus.has(menu) && r.top < BAR_EDGE) flippedMenus.add(menu);
        if (flippedMenus.has(menu)) {
          var trigger = menu.parentElement as HTMLElement | null;
          var below = trigger ? window.innerHeight - trigger.getBoundingClientRect().bottom - 16 : 240;
          menu.classList.add(FLIP_CLS);
          // 下限 80（而非 120）：矮窗口下触发钮本身贴近视口底，过高的下限会让
          // 菜单底部挤出视口（实测 470px 高时 120 的底超出 12px）。
          menu.style.maxHeight = String(Math.max(80, Math.min(360, below))) + 'px';
        } else {
          menu.classList.remove(FLIP_CLS);
          menu.style.maxHeight = '';
        }
      }
      // 菜单存续期间低频轮询（内容加载会改变高度/位置）。
      if (anyOpen) probeTimer = window.setTimeout(probeMenus, 200);
    }

    function scheduleProbe(): void {
      if (probeTimer === null) probeMenus();
    }

    function start(): void {
      if (!document.body) return;
      new MutationObserver(scheduleProbe).observe(document.body, { childList: true, subtree: true });
      window.addEventListener('resize', scheduleProbe, { passive: true });
      scheduleProbe();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  function injectFloatBar(): void {
    if (document.getElementById(FLOAT_BAR_ID)) return;
    injectUiPatchCss();
    var style = document.createElement('style');
    style.textContent = '\
  #' + FLOAT_BAR_ID + '{position:fixed;top:0;left:0;right:0;height:' + FLOAT_BAR_HEIGHT + 'px;z-index:2147483000;\
    display:flex;align-items:center;justify-content:flex-end;gap:2px;padding:0 6px 0 10px;\
    user-select:none;box-sizing:border-box;cursor:default;\
    background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 70%,transparent);\
    backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);\
    border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(255,255,255,.09)) 50%,transparent)}\
  #' + FLOAT_BAR_ID + ' button{width:26px;height:22px;display:grid;place-items:center;border:none;border-radius:7px;\
    background:transparent;color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;padding:0;outline:none;transition:background .12s,color .12s}\
  #' + FLOAT_BAR_ID + ' button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09));\
    color:var(--dsw-alias-label-primary,#eef2ff)}\
  #' + FLOAT_BAR_ID + ' button.df-close:hover{background:#e81123;color:#fff}';
    document.head.appendChild(style);
    var layout = document.createElement('style');
    layout.textContent = 'body{box-sizing:border-box!important;padding-top:' + FLOAT_BAR_HEIGHT + 'px!important}';
    document.head.appendChild(layout);
    // 向页面声明浮窗拖拽条高度：fixed 定位的侧边栏据此自动下移顶部标签条。
    document.documentElement.setAttribute('data-dsh-title-bar-height', String(FLOAT_BAR_HEIGHT));
    var bar = document.createElement('div');
    bar.id = FLOAT_BAR_ID;
    bar.innerHTML = '<button class="df-close" title="关闭" aria-label="关闭">' + GLYPHS.close + '</button>';
    document.body.appendChild(bar);
    armDrag(bar);
    var closeBtn = bar.querySelector('.df-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { dshDesktop.floatWindow.close(); });
  }

  function injectChrome(): void {
    if (FLOAT_MODE) { injectFloatBar(); return; }
    if (document.getElementById(BAR_ID)) return;
    injectUiPatchCss();
    var style = document.createElement('style');
    style.textContent = '\
#' + BAR_ID + '{position:fixed;top:0;left:0;right:0;height:' + BAR_HEIGHT + 'px;z-index:2147483000;\
  display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 10px;\
  user-select:none;box-sizing:border-box;cursor:default;\
  font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif);\
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 74%,transparent);\
  backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);\
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(255,255,255,.09)) 55%,transparent)}\
#' + BAR_ID + ' .dch-left{display:flex;align-items:center;gap:8px;min-width:0}\
#' + BAR_ID + ' .dch-icon{width:20px;height:20px;border-radius:6px;display:block;flex:none;\
  background:#f6f8fc;box-shadow:0 1px 3px rgba(0,0,0,.35)}\
#' + BAR_ID + ' .dch-title{font-size:12.5px;font-weight:600;letter-spacing:.2px;line-height:16px;\
  color:var(--dsw-alias-label-primary,#e6ecff);white-space:nowrap}\
#' + BAR_ID + ' .dch-badge{font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;\
  color:var(--dsw-alias-label-tertiary,#93a5d8);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));\
  white-space:nowrap;font-family:var(--ds-font-family-code,Consolas,monospace)}\
#' + BAR_ID + ' .dch-right{display:flex;align-items:center;gap:2px}\
#' + BAR_ID + ' .dch-btn{width:30px;height:28px;display:grid;place-items:center;border:none;border-radius:8px;\
  background:transparent;color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;padding:0;outline:none;transition:background .12s,color .12s}\
#' + BAR_ID + ' .dch-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09));\
  color:var(--dsw-alias-label-primary,#eef2ff)}\
#' + BAR_ID + ' .dch-btn:active{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.14))}\
#' + BAR_ID + ' .dch-close:hover{background:#e81123;color:#fff}\
#' + BAR_ID + ' .dch-menu{position:fixed;top:' + (BAR_HEIGHT + 8) + 'px;right:8px;width:272px;z-index:2147483001;\
  box-sizing:border-box;padding:6px;\
  background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 92%,white));\
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));border-radius:14px;\
  box-shadow:0 12px 40px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);\
  backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);\
  color:var(--dsw-alias-label-primary,#e6ecff);font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif)}\
#' + BAR_ID + ' .dch-mh{padding:8px 10px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));\
  margin-bottom:6px}\
#' + BAR_ID + ' .dch-mh-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}\
#' + BAR_ID + ' .dch-mh-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);margin-top:3px;\
  line-height:16px;display:flex;gap:8px;flex-wrap:wrap}\
#' + BAR_ID + ' .dch-item{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:5px 10px;\
  border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#dbe4f8);\
  font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}\
#' + BAR_ID + ' .dch-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}\
#' + BAR_ID + ' .dch-item .dch-kbd{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-caption,#5f6f9c);\
  font-family:var(--ds-font-family-code,Consolas,monospace)}\
#' + BAR_ID + ' .dch-item .dch-check{margin-left:auto;color:var(--dsw-alias-state-success-primary,#3ddc84);font-size:12px}\
#' + BAR_ID + ' .dch-item[data-danger="1"]{color:var(--dsw-alias-state-error-primary,#ff7a85)}\
#' + BAR_ID + ' .dch-sep{height:1px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.08));margin:5px 6px}\
#' + BAR_ID + ' .dch-exit-group{padding:2px 0}\
#' + BAR_ID + ' .dch-exit-title{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b9ac4);padding:2px 10px 3px}\
#' + BAR_ID + ' .dch-exit-item{min-height:26px;font-size:12px;color:var(--dsw-alias-label-secondary,#b8c5ea)}\
#' + BAR_ID + ' .dch-repos{padding:6px 10px 10px;margin:2px 0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));\
  border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.03))}\
#' + BAR_ID + ' .dch-repos-title{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);margin-bottom:4px}\
#' + BAR_ID + ' .dch-repo-row{display:flex;align-items:center;gap:6px;min-height:24px}\
#' + BAR_ID + ' .dch-repo-url{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b8de);\
  font-family:var(--ds-font-family-code,Consolas,monospace);white-space:nowrap;overflow:hidden;\
  text-overflow:ellipsis;user-select:text;cursor:text}\
#' + BAR_ID + ' .dch-copy{flex:none;appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));\
  background:transparent;color:var(--dsw-alias-label-secondary,#a9b8de);border-radius:6px;padding:1px 8px;\
  font-size:10.5px;cursor:pointer;font-family:inherit;line-height:16px}\
#' + BAR_ID + ' .dch-copy:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));\
  color:var(--dsw-alias-label-primary,#e6ecff)}';
    document.head.appendChild(style);

    // 声明自绘标题栏高度：better-sidebar 等客户端插件据此自动下移 fixed 元素。
    document.documentElement.setAttribute('data-dsh-title-bar-height', String(BAR_HEIGHT));

    var layout = document.createElement('style');
    layout.textContent = 'body{box-sizing:border-box!important;padding-top:' + BAR_HEIGHT + 'px!important}' +
      // issue #217：壳自绘标题栏 z-index 极高（2147483000），内核模型下拉、
      // 优化提示词面板等 fixed/absolute 弹层在视口顶部附近会被标题栏或页内
      // 高 z 容器盖住/糊掉。对常见弹层形态统一把层级提到内容层之上
      // （5000，仍低于标题栏）。只提层级不动布局 —— 纯叠加修复。
      'html[data-dsh-title-bar-height] [role="dialog"]:not([aria-hidden="true"]),' +
      'html[data-dsh-title-bar-height] [data-floating-ui-portal],' +
      'html[data-dsh-title-bar-height] [data-radix-popper-content-wrapper]{z-index:5000!important}';
    document.head.appendChild(layout);

    var bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.innerHTML = '\
    <div class="dch-left">\
      <img class="dch-icon" alt="" draggable="false" />\
      <span class="dch-title">Deepseek Harness EAC</span>\
      <span class="dch-badge" hidden></span>\
    </div>\
    <div class="dch-right">\
      <button class="dch-btn" data-act="menu" title="菜单" aria-label="菜单">' + GLYPHS.menu + '</button>\
      <button class="dch-btn" data-act="min" title="最小化" aria-label="最小化">' + GLYPHS.min + '</button>\
      <button class="dch-btn" data-act="max" title="最大化" aria-label="最大化">' + GLYPHS.max + '</button>\
      <button class="dch-btn dch-close" data-act="close" title="关闭" aria-label="关闭">' + GLYPHS.close + '</button>\
    </div>\
    <div class="dch-menu" hidden></div>';
    document.body.appendChild(bar);

    var badge = bar.querySelector('.dch-badge') as HTMLElement | null;
    var icon = bar.querySelector('.dch-icon') as HTMLImageElement | null;
    maxBtn = bar.querySelector('[data-act="max"]') as HTMLElement | null;
    menuEl = bar.querySelector('.dch-menu') as HTMLElement | null;

    var left = bar.querySelector('.dch-left');
    if (left) armDrag(left);
    armDrag(bar);
    var minBtn = bar.querySelector('[data-act="min"]');
    if (minBtn) minBtn.addEventListener('click', function () { dshDesktop.windowControls.minimize(); });
    if (maxBtn) maxBtn.addEventListener('click', function () { dshDesktop.windowControls.toggleMaximize(); });
    var closeBtn2 = bar.querySelector('.dch-close');
    if (closeBtn2) closeBtn2.addEventListener('click', function () { dshDesktop.windowControls.close(); });
    var menuBtn = bar.querySelector('[data-act="menu"]');
    if (menuBtn) menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menuOpen) closeMenu(); else openMenu();
    });

    document.addEventListener('click', function (e) {
      if (menuOpen && !bar.contains(e.target as Node)) closeMenu();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

    // 初始化状态
    dshDesktop.getInfo().then(function (info: any) {
      if (!info) return;
      state = Object.assign({}, state, info);
      if (info.appVersion) {
        dshDesktop.appVersion = info.appVersion;
        if (badge) badge.textContent = 'v' + info.appVersion;
      }
      if (badge && info.agentVersion) badge.title = 'agent v' + info.agentVersion + '（' + info.agentSource + '）';
      if (badge && info.agentVersion) { badge.hidden = false; }
      if (icon && info.iconDataUri) icon.src = info.iconDataUri;
    }).catch(function () { /* 信息不可用不阻塞界面 */ });
    dshDesktop.windowControls.isMaximized().then(setMaximized).catch(function () { /* 同上 */ });
    dshDesktop.windowControls.onMaximizeChange(setMaximized);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectChrome);
  } else {
    injectChrome();
  }

  // ---------------------------------------------------------------------------
  // Renderer 心跳：每 5s 上报一次（visibilitychange 回前台时立即补报）。
  // ---------------------------------------------------------------------------
  (function () {
    var beat = function () { try { send('log.renderer-heartbeat', {}); } catch (e) { /* 忽略 */ } };
    beat();
    setInterval(beat, 5000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') beat();
    });
  })();

  initPopupRescue();
})();

// __DSH_MODULES_COMPAT_SHIM__ ---------------------------------------------------
// rc.2 内核兼容垫片：补发 globalThis.__DSH_MODULES__。
// 内核 0.1.1-rc.2 起客户端模块系统不再发布到该全局量（改为经
// window.__ModuleLoader__.create() 产物 + cordis ctx.modules 注入），而
// dsh-better-sidebar 等第三方插件的懒加载 chunk 仍按旧契约消费它，缺失即
// 在打开文件时报 'chunk "editor": client module system unavailable'。
// 本初始化脚本先于页面任何脚本执行（每次导航都注入）：在此拦截
// __ModuleLoader__ 赋值并包装 create()，把返回的 ClientModuleSystem 按旧
// 契约补发到全局（对齐旧内核 dsh-client-web AppWebEntry 的
// globalThis.__DSH_MODULES__ = this.modules）。任何一步异常都只空转，不阻断页面引导。
(function () {
  try {
    var w = window as any;
    var loader: any;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      get: function () { return loader; },
      set: function (v: any) {
        loader = v;
        if (v && typeof v.create === 'function' && !v.__dshModulesShim) {
          v.__dshModulesShim = true;
          var origCreate = v.create;
          v.create = function (this: any, options: any) {
            var mods = origCreate.call(this, options);
            try {
              if (mods && typeof mods.import === 'function' && !w.__DSH_MODULES__) {
                w.__DSH_MODULES__ = mods;
              }
            } catch (e) { /* 垫片不阻断引导 */ }
            return mods;
          };
        }
      }
    });
  } catch (e) { /* 已存在不可重定义的同名属性时放弃垫片 */ }
})();

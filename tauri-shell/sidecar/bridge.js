/// <reference lib="dom" />
'use strict';
(function () {
    var WS_URL = window.__DSH_BRIDGE_WS__ || 'ws://127.0.0.1:19873/ws';
    var BAR_ID = '__dsh_desktop_chrome__';
    var BAR_HEIGHT = 36;
    var FLOAT_BAR_ID = '__dsh_desktop_floatbar__';
    var FLOAT_BAR_HEIGHT = 24;
    var seq = 0;
    var pending = {};
    var ws = null;
    var wsReady = false;
    var notifyHooks = [];
    var readyHooks = [];
    var queue = [];
    function rawSend(obj) {
        try {
            if (ws)
                ws.send(JSON.stringify(obj));
        }
        catch (e) { /* 断线由重连兜底 */ }
    }
    // fire-and-forget（Electron ipcRenderer.send 语义）：不等回复，断了就丢。
    function send(method, params) {
        if (wsReady)
            rawSend({ jsonrpc: '2.0', method: method, params: params || {} });
    }
    // invoke 语义（ipcRenderer.invoke）：Promise + 超时。
    function call(method, params, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var id = ++seq;
            pending[id] = { resolve: resolve, reject: reject };
            if (!wsReady) {
                queue.push({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
            }
            else
                rawSend({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
            setTimeout(function () {
                if (pending[id]) {
                    delete pending[id];
                    reject(new Error('bridge call timeout: ' + method));
                }
            }, timeoutMs || 30000);
        });
    }
    function connect() {
        ws = new WebSocket(WS_URL);
        ws.onopen = function () {
            wsReady = true;
            while (queue.length)
                rawSend(queue.shift());
            call('chrome.init', {}).then(function (info) {
                try {
                    readyHooks.forEach(function (h) { h(info); });
                }
                catch (e) { /* 页面回调异常不断桥 */ }
            }).catch(function () { });
        };
        ws.onmessage = function (ev) {
            var msg;
            try {
                msg = JSON.parse(ev.data);
            }
            catch (e) {
                return;
            }
            if (msg.id != null && pending[msg.id]) {
                var r = pending[msg.id];
                delete pending[msg.id];
                if (msg.error)
                    r.reject(new Error(msg.error.message || 'rpc error'));
                else
                    r.resolve(msg.result);
            }
            else if (msg.method) {
                // 通知帧：win.maximized / dsh.balance / boot.web-ready …
                try {
                    notifyHooks.forEach(function (h) { h(msg.method, msg.params); });
                }
                catch (e) { /* 同上 */ }
            }
        };
        ws.onclose = function () {
            wsReady = false;
            setTimeout(connect, 1500);
        };
        ws.onerror = function () { try {
            if (ws)
                ws.close();
        }
        catch (e) { /* 重连由 onclose 驱动 */ } };
    }
    function onNotify(fn) { notifyHooks.push(fn); }
    window.addEventListener('DOMContentLoaded', function () { connect(); });
    // ---------------------------------------------------------------------------
    // window.dshDesktop（键集与 preload.js:26-127 一致；契约测试锁定）
    // ---------------------------------------------------------------------------
    window.dshDesktop = {
        appVersion: '', // chrome.init 回填；旧字段保持存在
        windowControls: {
            minimize: function () { return call('win.minimize', {}); },
            toggleMaximize: function () { return call('win.toggle-maximize', {}); },
            close: function () { return call('win.close', {}); },
            isMaximized: function () { return call('win.is-maximized', {}).then(function (r) { return !!(r && r.maximized); }); },
            onMaximizeChange: function (cb) {
                var hook = function (method, params) {
                    if (method !== 'win.maximized')
                        return;
                    try {
                        cb(!!(params && params.maximized));
                    }
                    catch (e) { /* 回调异常不断桥 */ }
                };
                notifyHooks.push(hook);
                return function () {
                    var i = notifyHooks.indexOf(hook);
                    if (i >= 0)
                        notifyHooks.splice(i, 1);
                };
            },
        },
        menu: {
            action: function (action, payload) {
                var p = Object.assign({}, payload || {});
                p.action = action;
                return call('menu.action', p);
            },
        },
        getInfo: function () { return call('chrome.init', {}); },
        refreshBalance: function () { return call('balance.refresh', {}); },
        // 插件市场：请求原地重启 dsh web 服务（安装/卸载插件后生效）。
        restartService: function () { return call('service.restart', { intent: 'restart-service' }); },
        // 会话浮窗（多窗口）：主窗请求把某个会话弹出到独立窗口；浮窗关闭自身。
        floatWindow: {
            open: function (sessionId) { return call('float.open', { sessionId: sessionId }); },
            close: function () {
                // 壳层按标签关窗：浮窗 init 脚本把 window.__DSH_FLOAT__.win 置为标签。
                var f = window.__DSH_FLOAT__;
                send('float.close', { win: f && f.win });
            },
        },
        // 插件保护中心：快照 / 回滚 / 体检 / 修复 / 事故报告。
        guard: {
            action: function (action, value) { return call('guard.action', { action: action, value: value }); },
        },
        // 内置插件选择向导。
        pluginWizard: {
            open: function () { return call('wizard.open', {}); },
        },
        // 插件管理：列出/启停/移除恢复（写 profile cordis.patch.yml）。
        pluginManager: {
            list: function () { return call('plugins.list', {}); },
            setEnabled: function (id, enabled) { return call('plugins.set-enabled', { id: id, enabled: enabled }); },
            setRemoved: function (id, removed) { return call('plugins.set-removed', { id: id, removed: removed }); },
        },
        // 插件更新：清单 / 手动更新单个 / 自动更新开关。
        pluginUpdates: {
            list: function (force) { return call('plugins.updates', { force: force === true }); },
            update: function (id) { return call('plugins.update', { id: id }); },
            setAutoUpdate: function (enabled) { return call('plugins.auto-update', { enabled: enabled }); },
        },
        // 图片粘贴：剪贴板图片存临时目录，返回 { ok, path, size }。
        imagePaste: {
            save: function (payload) { return call('image-paste.save', payload || {}); },
        },
        // Token 价格自定义：读取/保存/恢复（¥/百万 token）。
        balancePrices: {
            get: function (model) { return call('balance.prices-get', { model: model }); },
            set: function (model, prices) { return call('balance.prices-set', { model: model, prices: prices }); },
            reset: function (model) { return call('balance.prices-reset', { model: model }); },
        },
        balanceModels: {
            list: function () { return call('balance.models', {}); },
        },
        revertFiles: function (changes) { return call('files.revert', { changes: changes }); },
        openPath: function (path) { return call('files.open', { path: path }); },
        openExternal: function (url) { return call('shell.open-external', { url: url }); },
        copyText: function (text) { return call('clipboard.write-text', { text: text }); },
        // 浏览器环境无 File 磁盘路径：返回空串，插件降级为可读提示（与浏览器打开
        // WebUI 时的行为一致）。
        getPathForFile: function () { return ''; },
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
            diagnose: function (selections, userNote) { return call('rescue.diagnose', { selections: selections, userNote: userNote }); },
            apply: function (suggestion) { return call('rescue.apply', { suggestion: suggestion }); },
            setSafeMode: function (on) { return call('rescue.safe-mode', { on: on }); },
            retry: function () { return call('rescue.retry', {}); },
            autoRepair: function () { return call('rescue.auto-repair', {}); },
        },
        // 桥内省（壳层页面与冒烟用；不属于 preload 键集）。
        _call: call,
        _send: send,
        _onNotify: onNotify,
        _onReady: function (fn) { readyHooks.push(fn); },
    };
    var dshDesktop = window.dshDesktop;
    // ---------------------------------------------------------------------------
    // 浮窗模式：Rust 创建浮窗时注入 window.__DSH_FLOAT__ = { sessionId, win }，
    // 预置目标会话到持久化，让 Web UI 一启动就选中目标会话。
    // ---------------------------------------------------------------------------
    var FLOAT_MODE = window.__DSH_FLOAT__ || null;
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
        }
        catch (e) { /* 忽略持久化失败 */ }
    }
    // 页面异常 → 壳层日志。
    window.addEventListener('error', function (e) {
        try {
            send('log.page-error', { message: 'window.onerror: ' + ((e && (e.message || e.error)) || 'unknown') });
        }
        catch (err) { /* 忽略 */ }
    });
    window.addEventListener('unhandledrejection', function (e) {
        try {
            send('log.page-error', { message: 'unhandledrejection: ' + String((e && e.reason && (e.reason.message || e.reason)) || e) });
        }
        catch (err) { /* 忽略 */ }
    });
    // 余额推送 → window 事件（dsh-balance 插件订阅）。
    onNotify(function (method, params) {
        if (method !== 'dsh.balance')
            return;
        try {
            window.dispatchEvent(new CustomEvent('dsh-balance-changed', { detail: params }));
        }
        catch (e) { /* 忽略 */ }
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
    var menuEl = null;
    var maxBtn = null;
    var state = { appVersion: '', agentVersion: '', agentSource: '', notifyOnTurnEnd: true, closeToTray: true, exitAction: 'ask', shortcutPolicy: 'auto' };
    var EXIT_ACTIONS = [
        { value: 'ask', label: '每次询问' },
        { value: 'minimize', label: '后台运行（最小化到托盘）' },
        { value: 'quit', label: '直接退出' },
    ];
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
    // WebView2 无 -webkit-app-region:drag —— mousedown 转发壳层 start_dragging。
    // 双击标题 = 最大化/还原（Electron 拖拽区默认行为对齐）。
    function armDrag(el) {
        var lastClick = 0;
        el.addEventListener('mousedown', function (e) {
            if (e.button !== 0)
                return;
            var target = e.target;
            // 按钮上的按下不触发拖拽（关闭/菜单等仍可点击）。
            if (target && target.closest && target.closest('button'))
                return;
            var now = Date.now();
            if (now - lastClick < 400) {
                lastClick = 0;
                dshDesktop.windowControls.toggleMaximize().catch(function () { });
                return;
            }
            lastClick = now;
            send('win.start-dragging', {});
        });
    }
    function renderMenu() {
        if (!menuEl)
            return;
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
                var act = item.getAttribute('data-act') || '';
                if (act === 'toggle-notify' || act === 'toggle-shortcut-policy' || act === 'set-exit-action') {
                    var payload = act === 'set-exit-action' ? { value: item.getAttribute('data-value') } : undefined;
                    dshDesktop.menu.action(act, payload).then(function (next) {
                        if (next)
                            state = Object.assign({}, state, next);
                        renderMenu();
                    }).catch(function () { });
                    return;
                }
                closeMenu();
                dshDesktop.menu.action(act).catch(function () { });
            });
        });
        menuEl.querySelectorAll('.dch-copy').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var kind = btn.getAttribute('data-copy');
                var url = state.repoUrls && (kind === 'github' ? state.repoUrls.github : state.repoUrls.gitee);
                if (!url)
                    return;
                dshDesktop.copyText(url).then(function (r) {
                    if (r && r.ok) {
                        var prev = btn.textContent;
                        btn.textContent = '已复制 ✓';
                        setTimeout(function () { btn.textContent = prev; }, 1200);
                    }
                }).catch(function () { });
            });
        });
    }
    function closeMenu() {
        menuOpen = false;
        if (menuEl)
            menuEl.hidden = true;
    }
    function openMenu() {
        if (!menuEl)
            return;
        dshDesktop.getInfo().then(function (info) {
            if (info)
                state = Object.assign({}, state, info);
            renderMenu();
            menuOpen = true;
            menuEl.hidden = false;
        }).catch(function () {
            renderMenu();
            menuOpen = true;
            menuEl.hidden = false;
        });
    }
    function setMaximized(isMax) {
        if (!maxBtn)
            return;
        maxBtn.innerHTML = isMax ? GLYPHS.restore : GLYPHS.max;
        maxBtn.title = isMax ? '还原' : '最大化';
        maxBtn.setAttribute('aria-label', maxBtn.title);
    }
    function injectFloatBar() {
        if (document.getElementById(FLOAT_BAR_ID))
            return;
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
        if (closeBtn)
            closeBtn.addEventListener('click', function () { dshDesktop.floatWindow.close(); });
    }
    function injectChrome() {
        if (FLOAT_MODE) {
            injectFloatBar();
            return;
        }
        if (document.getElementById(BAR_ID))
            return;
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
        layout.textContent = 'body{box-sizing:border-box!important;padding-top:' + BAR_HEIGHT + 'px!important}';
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
        var badge = bar.querySelector('.dch-badge');
        var icon = bar.querySelector('.dch-icon');
        maxBtn = bar.querySelector('[data-act="max"]');
        menuEl = bar.querySelector('.dch-menu');
        var left = bar.querySelector('.dch-left');
        if (left)
            armDrag(left);
        armDrag(bar);
        var minBtn = bar.querySelector('[data-act="min"]');
        if (minBtn)
            minBtn.addEventListener('click', function () { dshDesktop.windowControls.minimize(); });
        if (maxBtn)
            maxBtn.addEventListener('click', function () { dshDesktop.windowControls.toggleMaximize(); });
        var closeBtn2 = bar.querySelector('.dch-close');
        if (closeBtn2)
            closeBtn2.addEventListener('click', function () { dshDesktop.windowControls.close(); });
        var menuBtn = bar.querySelector('[data-act="menu"]');
        if (menuBtn)
            menuBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (menuOpen)
                    closeMenu();
                else
                    openMenu();
            });
        document.addEventListener('click', function (e) {
            if (menuOpen && !bar.contains(e.target))
                closeMenu();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape')
            closeMenu(); });
        // 初始化状态
        dshDesktop.getInfo().then(function (info) {
            if (!info)
                return;
            state = Object.assign({}, state, info);
            if (info.appVersion) {
                dshDesktop.appVersion = info.appVersion;
                if (badge)
                    badge.textContent = 'v' + info.appVersion;
            }
            if (badge && info.agentVersion)
                badge.title = 'agent v' + info.agentVersion + '（' + info.agentSource + '）';
            if (badge && info.agentVersion) {
                badge.hidden = false;
            }
            if (icon && info.iconDataUri)
                icon.src = info.iconDataUri;
        }).catch(function () { });
        dshDesktop.windowControls.isMaximized().then(setMaximized).catch(function () { });
        dshDesktop.windowControls.onMaximizeChange(setMaximized);
    }
    // 退出弹窗 / 无需自绘标题栏的轻量窗口：跳过 chrome 栏注入。
    if (!window.__DSH_NO_CHROME__) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', injectChrome);
        }
        else {
            injectChrome();
        }
    }
    // ---------------------------------------------------------------------------
    // Renderer 心跳：每 5s 上报一次（visibilitychange 回前台时立即补报）。
    // ---------------------------------------------------------------------------
    (function () {
        var beat = function () { try {
            send('log.renderer-heartbeat', {});
        }
        catch (e) { /* 忽略 */ } };
        beat();
        setInterval(beat, 5000);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible')
                beat();
        });
    })();
})();

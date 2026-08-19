'use strict';

// DSH Desktop — frameless window chrome + IPC bridge (sandbox-safe preload).
//
// 职责：
//   1. 向页面注入自绘窗口栏（36px 玻璃条）：拖拽区、圆角应用图标、
//      标题/版本、菜单按钮（⋯）、最小化/最大化/关闭按钮，替代被移除的
//      原生标题栏与 文件/视图/帮助 菜单栏。
//   2. 通过 contextBridge 暴露 window.dshDesktop（窗口控制 / 菜单动作 /
//      余额刷新），并把主进程推送的余额数据转发成 window 上的
//      "dsh-balance-changed" 事件，供 dsh-balance 插件消费。
//   3. 把 Web UI 内容下移 36px（body padding-top），保证自绘栏不遮挡界面。

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const BAR_ID = '__dsh_desktop_chrome__';
const BAR_HEIGHT = 36;
const FLOAT_BAR_ID = '__dsh_desktop_floatbar__';
const FLOAT_BAR_HEIGHT = 24;

// ---------------------------------------------------------------------------
// Bridge (always exposed; the balance plugin reads it, the web UI keeps the
// legacy dshDesktop.appVersion field working).
// ---------------------------------------------------------------------------

const dshDesktop = {
  appVersion: '', // 由 chrome:init 回填；旧字段保持存在
  windowControls: {
    minimize: () => ipcRenderer.invoke('chrome:window', { action: 'minimize' }),
    toggleMaximize: () => ipcRenderer.invoke('chrome:window', { action: 'toggle-maximize' }),
    close: () => ipcRenderer.invoke('chrome:window', { action: 'close' }),
    isMaximized: () => ipcRenderer.invoke('chrome:window', { action: 'is-maximized' }),
    onMaximizeChange: (cb) => {
      const listener = (_e, isMax) => { try { cb(isMax); } catch {} };
      ipcRenderer.on('chrome:maximized', listener);
      return () => ipcRenderer.removeListener('chrome:maximized', listener);
    },
  },
  menu: {
    action: (action, payload) => ipcRenderer.invoke('chrome:menu', { action, ...payload }),
  },
  getInfo: () => ipcRenderer.invoke('chrome:init'),
  refreshBalance: () => ipcRenderer.invoke('dsh:balance-refresh'),
  // 插件市场：请求主进程原地重启 dsh web 服务（安装/卸载插件后生效）。
  restartService: () => ipcRenderer.invoke('chrome:restart-service', { intent: 'restart-service' }),
  // 会话浮窗（V4 多窗口）：主窗请求把某个会话弹出到独立窗口；浮窗关闭自身。
  floatWindow: {
    open: (sessionId) => ipcRenderer.invoke('chrome:float-window', { action: 'open', sessionId }),
    close: () => ipcRenderer.send('float:close'),
  },
  // 插件保护中心（plugin-guard.js）：快照 / 回滚 / 体检 / 修复 / 事故报告。
  // 设置页「插件保护」分区（dsh-plugin-shield 插件）从这里驱动主进程引擎。
  guard: {
    action: (action, value) => ipcRenderer.invoke('guard:action', { action, value }),
  },
  // 内置插件选择向导：设置页「插件 → 选择向导」（dsh-plugin-wizard 插件）
  // 从这里二次打开向导窗口，按需启用/停用内置插件。
  pluginWizard: {
    open: () => ipcRenderer.invoke('onboard:open'),
  },
  // 插件管理（dsh-plugin-manager 插件「管理」标签）：列出配套/用户/核心插件
  // 及启用状态，写入/移除 profile cordis.patch.yml 的 disabled 条目
  // （完全退出并重启应用后生效，返回 { ok, restartRequired }）。
  pluginManager: {
    list: () => ipcRenderer.invoke('dsh:plugin-list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('dsh:plugin-set-enabled', { id, enabled }),
    // V4.2：移除（卸载语义）/恢复内置插件，返回 { ok, restartRequired }。
    setRemoved: (id, removed) => ipcRenderer.invoke('dsh:plugin-set-removed', { id, removed }),
  },
  // 插件更新（V4.3，dsh-plugin-marketplace「更新」标签）：内置插件上游更新
  // —— 清单 / 手动更新单个 / 自动更新开关（默认关，仅提示）。
  pluginUpdates: {
    list: (force = false) => ipcRenderer.invoke('dsh:plugin-updates', { force }),
    update: (id) => ipcRenderer.invoke('dsh:plugin-update', { id }),
    setAutoUpdate: (enabled) => ipcRenderer.invoke('dsh:plugin-auto-update', { enabled }),
  },
  // 图片粘贴（V4.2，dsh-image-paste 插件）：把剪贴板图片存到临时目录
  // （%TEMP%/dsh-paste/），返回 { ok, path, size } 供 agent 读取。
  imagePaste: {
    save: (payload) => ipcRenderer.invoke('dsh:image-paste-save', payload),
  },
  // Token 价格自定义（V4.2，dsh-balance 插件「价格设置」页）：读取默认档/
  // 当前覆盖、保存自定义价格（¥/百万 token）、恢复默认。
  balancePrices: {
    get: (model) => ipcRenderer.invoke('dsh:balance-prices-get', { model }),
    set: (model, prices) => ipcRenderer.invoke('dsh:balance-prices-set', { model, prices }),
    reset: (model) => ipcRenderer.invoke('dsh:balance-prices-reset', { model }),
  },
  // 「文件」视图的还原请求：changes = [{path, op, oldText, newText}]（逆序）。
  revertFiles: (changes) => ipcRenderer.invoke('dsh:file-revert', { changes }),
  // 「全部文件」视图：用系统默认程序打开项目文件。
  openPath: (path) => ipcRenderer.invoke('dsh:file-open', { path }),
  // 预览面板：用系统浏览器打开 URL（端口预览等）。
  openExternal: (url) => ipcRenderer.invoke('dsh:open-external', { url }),
  // 复制文本到剪贴板（更新源地址等）。
  copyText: (text) => ipcRenderer.invoke('dsh:copy-text', { text }),
  // 拖入文件（dsh-file-drop）：取浏览器 File 对象的完整磁盘路径
  // （webUtils.getPathForFile，仅 Electron 环境；浏览器打开 WebUI 时
  // 返回空字符串，插件自动降级为可读提示）。
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  // 恢复页面（assets/recovery.html）使用的动作与状态读取。
  recovery: {
    getState: () => ipcRenderer.invoke('chrome:recovery-state'),
    reload: () => ipcRenderer.invoke('chrome:recovery-reload'),
    restart: () => ipcRenderer.invoke('chrome:recovery-restart'),
    exportLogs: () => ipcRenderer.invoke('chrome:export-logs'),
  },
};

contextBridge.exposeInMainWorld('dshDesktop', dshDesktop);

// ---------------------------------------------------------------------------
// 浮窗模式检测（V4 多窗口，移植自上游 dsh_desktop）：process.argv 由
// webPreferences.additionalArguments 注入。浮窗内暴露 window.__DSH_FLOAT__ =
// { sessionId } 供 dsh-float-window 插件识别，并预置目标会话到持久化，
// 让 Web UI 一启动就选中目标会话（比启动后 sessions.open() 可靠：会话服务
// 在 boot 早期尚未就绪时 open() 会抛 unknown session）。
// ---------------------------------------------------------------------------
const FLOAT_ARG = process.argv.find((a) => a.startsWith('--dsh-float='));
const FLOAT_MODE = FLOAT_ARG ? { sessionId: FLOAT_ARG.slice('--dsh-float='.length) } : null;
if (FLOAT_MODE) {
  contextBridge.exposeInMainWorld('__DSH_FLOAT__', FLOAT_MODE);
  try {
    const key = 'dsh.sessions.current';
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') {
      parsed.sessionId = String(FLOAT_MODE.sessionId);
      delete parsed.subagentAddress;
      localStorage.setItem(key, JSON.stringify(parsed));
    }
  } catch (_e) { /* 忽略持久化失败 */ }
}

// 页面异常 → 主进程日志（desktop.log），便于排查插件空白视图。
window.addEventListener('error', (e) => {
  try { ipcRenderer.send('dsh:page-error', 'window.onerror: ' + ((e && (e.message || e.error)) || 'unknown')); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { ipcRenderer.send('dsh:page-error', 'unhandledrejection: ' + String((e && e.reason && (e.reason.message || e.reason)) || e)); } catch {}
});

// 余额推送 → window 事件（dsh-balance 插件订阅）。
ipcRenderer.on('dsh:balance', (_e, data) => {
  try { window.dispatchEvent(new CustomEvent('dsh-balance-changed', { detail: data })); } catch {}
});

// ---------------------------------------------------------------------------
// Chrome DOM
// ---------------------------------------------------------------------------

const CHROME_CSS = `
#${BAR_ID}{position:fixed;top:0;left:0;right:0;height:${BAR_HEIGHT}px;z-index:2147483000;
  display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 10px;
  -webkit-app-region:drag;user-select:none;box-sizing:border-box;
  font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif);
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 74%,transparent);
  backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(255,255,255,.09)) 55%,transparent)}
#${BAR_ID} .dch-left{display:flex;align-items:center;gap:8px;min-width:0;
  -webkit-app-region:drag}
#${BAR_ID} .dch-icon{width:20px;height:20px;border-radius:6px;display:block;flex:none;
  -webkit-app-region:drag;background:#f6f8fc;box-shadow:0 1px 3px rgba(0,0,0,.35)}
#${BAR_ID} .dch-title{font-size:12.5px;font-weight:600;letter-spacing:.2px;line-height:16px;
  color:var(--dsw-alias-label-primary,#e6ecff);white-space:nowrap;-webkit-app-region:drag}
#${BAR_ID} .dch-badge{font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;
  color:var(--dsw-alias-label-tertiary,#93a5d8);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));
  white-space:nowrap;-webkit-app-region:drag;font-family:var(--ds-font-family-code,Consolas,monospace)}
#${BAR_ID} .dch-right{display:flex;align-items:center;gap:2px;-webkit-app-region:no-drag}
#${BAR_ID} .dch-btn{width:30px;height:28px;display:grid;place-items:center;border:none;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;padding:0;
  -webkit-app-region:no-drag;outline:none;transition:background .12s,color .12s}
#${BAR_ID} .dch-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09));
  color:var(--dsw-alias-label-primary,#eef2ff)}
#${BAR_ID} .dch-btn:active{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.14))}
#${BAR_ID} .dch-close:hover{background:#e81123;color:#fff}
#${BAR_ID} .dch-menu{position:fixed;top:${BAR_HEIGHT + 8}px;right:8px;width:272px;z-index:2147483001;
  -webkit-app-region:no-drag;box-sizing:border-box;padding:6px;
  background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 92%,white));
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));border-radius:14px;
  box-shadow:0 12px 40px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);
  backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);
  color:var(--dsw-alias-label-primary,#e6ecff);font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif)}
#${BAR_ID} .dch-mh{padding:8px 10px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));
  margin-bottom:6px}
#${BAR_ID} .dch-mh-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
#${BAR_ID} .dch-mh-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);margin-top:3px;
  line-height:16px;display:flex;gap:8px;flex-wrap:wrap}
#${BAR_ID} .dch-item{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:5px 10px;
  border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#dbe4f8);
  font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer;-webkit-app-region:no-drag}
#${BAR_ID} .dch-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
#${BAR_ID} .dch-item .dch-kbd{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-caption,#5f6f9c);
  font-family:var(--ds-font-family-code,Consolas,monospace)}
#${BAR_ID} .dch-item .dch-check{margin-left:auto;color:var(--dsw-alias-state-success-primary,#3ddc84);font-size:12px}
#${BAR_ID} .dch-item[data-danger="1"]{color:var(--dsw-alias-state-error-primary,#ff7a85)}
#${BAR_ID} .dch-sep{height:1px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.08));margin:5px 6px}
#${BAR_ID} .dch-exit-group{padding:2px 0}
#${BAR_ID} .dch-exit-title{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b9ac4);padding:2px 10px 3px}
#${BAR_ID} .dch-exit-item{min-height:26px;font-size:12px;color:var(--dsw-alias-label-secondary,#b8c5ea)}
#${BAR_ID} .dch-repos{padding:6px 10px 10px;margin:2px 0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));
  border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.03))}
#${BAR_ID} .dch-repos-title{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);margin-bottom:4px}
#${BAR_ID} .dch-repo-row{display:flex;align-items:center;gap:6px;min-height:24px}
#${BAR_ID} .dch-repo-url{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#a9b8de);
  font-family:var(--ds-font-family-code,Consolas,monospace);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;user-select:text;cursor:text}
#${BAR_ID} .dch-copy{flex:none;appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:transparent;color:var(--dsw-alias-label-secondary,#a9b8de);border-radius:6px;padding:1px 8px;
  font-size:10.5px;cursor:pointer;font-family:inherit;line-height:16px}
#${BAR_ID} .dch-copy:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));
  color:var(--dsw-alias-label-primary,#e6ecff)}
`;

const GLYPHS = {
  menu: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="2.4" cy="6" r="1.15"/><circle cx="6" cy="6" r="1.15"/><circle cx="9.6" cy="6" r="1.15"/></svg>',
  min: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 6h7"/></svg>',
  max: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4"/></svg>',
  restore: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4.2 4.2V2.6h5.2v5.2H7.8"/><rect x="2.6" y="4.2" width="5.2" height="5.2" rx="1.2"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg>',
};

let menuOpen = false;
let menuEl = null;
let maxBtn = null;
let state = { appVersion: '', agentVersion: '', agentSource: '', notifyOnTurnEnd: true, closeToTray: true, exitAction: 'ask', shortcutPolicy: 'auto' };

const EXIT_ACTIONS = [
  { value: 'ask', label: '每次询问' },
  { value: 'minimize', label: '后台运行（最小化到托盘）' },
  { value: 'quit', label: '直接退出' },
];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderMenu() {
  if (!menuEl) return;
  menuEl.innerHTML = `
    <div class="dch-mh">
      <div class="dch-mh-title">Deepseek Harness EAC <span style="font-weight:400;color:var(--dsw-alias-label-tertiary)">封装 v${esc(state.appVersion)}</span></div>
      <div class="dch-mh-sub"><span>agent v${esc(state.agentVersion)}</span><span>${esc(state.agentSource)}</span></div>
    </div>
    <button class="dch-item" data-act="check-agent-update">检查 dsh 更新…</button>
    <button class="dch-item" data-act="check-client-update">检查客户端更新…</button>
    <div class="dch-repos">
      <div class="dch-repos-title">更新源（点击复制）</div>
      <div class="dch-repo-row">
        <span class="dch-repo-url" title="${esc(state.repoUrls ? state.repoUrls.github : '')}">${esc(state.repoUrls ? state.repoUrls.github : '')}</span>
        <button class="dch-copy" data-copy="github" title="复制地址">复制</button>
      </div>
      <div class="dch-repo-row">
        <span class="dch-repo-url" title="${esc(state.repoUrls ? state.repoUrls.gitee : '')}">${esc(state.repoUrls ? state.repoUrls.gitee : '')}</span>
        <button class="dch-copy" data-copy="gitee" title="复制地址">复制</button>
      </div>
    </div>
    <button class="dch-item" data-act="toggle-notify"><span>会话完成通知</span>${state.notifyOnTurnEnd ? '<span class="dch-check">✓</span>' : ''}</button>
    <button class="dch-item" data-act="toggle-shortcut-policy"><span>桌面快捷方式自动维护</span>${state.shortcutPolicy !== 'never' ? '<span class="dch-check">✓</span>' : ''}</button>
    <div class="dch-exit-group">
      <div class="dch-exit-title">关闭窗口时</div>
      ${EXIT_ACTIONS.map((opt) => `<button class="dch-item dch-exit-item" data-act="set-exit-action" data-value="${opt.value}"><span>${opt.label}</span>${state.exitAction === opt.value ? '<span class="dch-check">✓</span>' : ''}</button>`).join('')}
    </div>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="restart-service"><span>重启 Web 服务</span><span class="dch-kbd">不关闭应用</span></button>
    <button class="dch-item" data-act="reload"><span>重新加载</span><span class="dch-kbd">Ctrl+R</span></button>
    <button class="dch-item" data-act="devtools"><span>开发者工具</span><span class="dch-kbd">F12</span></button>
    <button class="dch-item" data-act="fullscreen"><span>全屏</span><span class="dch-kbd">F11</span></button>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="open-browser">在浏览器中打开</button>
    <button class="dch-item" data-act="export-logs">导出日志</button>
    <button class="dch-item" data-act="feedback">反馈建议</button>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="about">关于 Deepseek Harness EAC</button>
    <button class="dch-item" data-danger="1" data-act="quit">退出</button>`;
  menuEl.querySelectorAll('.dch-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const act = item.dataset.act;
      if (act === 'toggle-notify') {
        const next = await dshDesktop.menu.action(act);
        if (next) state = { ...state, ...next };
        renderMenu();
        return;
      }
      if (act === 'toggle-shortcut-policy') {
        const next = await dshDesktop.menu.action(act);
        if (next) state = { ...state, ...next };
        renderMenu();
        return;
      }
      if (act === 'set-exit-action') {
        const next = await dshDesktop.menu.action(act, { value: item.dataset.value });
        if (next) state = { ...state, ...next };
        renderMenu();
        return;
      }
      closeMenu();
      dshDesktop.menu.action(act);
    });
  });
  // 更新源复制按钮
  menuEl.querySelectorAll('.dch-copy').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const kind = btn.dataset.copy;
      const url = state.repoUrls && (kind === 'github' ? state.repoUrls.github : state.repoUrls.gitee);
      if (!url) return;
      const r = await dshDesktop.copyText(url);
      if (r && r.ok) {
        const prev = btn.textContent;
        btn.textContent = '已复制 ✓';
        setTimeout(() => { btn.textContent = prev; }, 1200);
      }
    });
  });
}

function closeMenu() {
  menuOpen = false;
  if (menuEl) menuEl.hidden = true;
}

function openMenu() {
  if (!menuEl) return;
  dshDesktop.getInfo().then((info) => {
    if (info) state = { ...state, ...info };
    renderMenu();
    menuOpen = true;
    menuEl.hidden = false;
  }).catch(() => {
    renderMenu();
    menuOpen = true;
    menuEl.hidden = false;
  });
}

function setMaximized(isMax) {
  if (!maxBtn) return;
  maxBtn.innerHTML = isMax ? GLYPHS.restore : GLYPHS.max;
  maxBtn.title = isMax ? '还原' : '最大化';
  maxBtn.setAttribute('aria-label', maxBtn.title);
}

// 浮窗的细拖拽条（纯拖拽 + 关闭按钮，跳过完整自绘标题栏）。
function injectFloatBar() {
  if (document.getElementById(FLOAT_BAR_ID)) return;
  const style = document.createElement('style');
  style.textContent = `
  #${FLOAT_BAR_ID}{position:fixed;top:0;left:0;right:0;height:${FLOAT_BAR_HEIGHT}px;z-index:2147483000;
    display:flex;align-items:center;justify-content:flex-end;gap:2px;padding:0 6px 0 10px;
    -webkit-app-region:drag;user-select:none;box-sizing:border-box;
    background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 70%,transparent);
    border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(255,255,255,.09)) 50%,transparent)}
  #${FLOAT_BAR_ID} button{width:26px;height:22px;display:grid;place-items:center;border:none;border-radius:7px;
    background:transparent;color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;padding:0;
    -webkit-app-region:no-drag;outline:none;transition:background .12s,color .12s}
  #${FLOAT_BAR_ID} button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09));
    color:var(--dsw-alias-label-primary,#eef2ff)}
  #${FLOAT_BAR_ID} button.df-close:hover{background:#e81123;color:#fff}`;
  document.head.appendChild(style);
  const layout = document.createElement('style');
  layout.textContent = `body{box-sizing:border-box!important;padding-top:${FLOAT_BAR_HEIGHT}px!important}`;
  document.head.appendChild(layout);
  // 向页面声明浮窗拖拽条高度：fixed 定位的侧边栏（dsh-better-sidebar）读取
  // 该属性自动下移顶部标签条，body padding 只对普通流内容生效。
  document.documentElement.setAttribute('data-dsh-title-bar-height', String(FLOAT_BAR_HEIGHT));
  const bar = document.createElement('div');
  bar.id = FLOAT_BAR_ID;
  bar.innerHTML = `<button class="df-close" title="关闭" aria-label="关闭">${GLYPHS.close}</button>`;
  document.body.appendChild(bar);
  bar.querySelector('.df-close').addEventListener('click', () => dshDesktop.floatWindow.close());
}

function injectChrome() {
  if (FLOAT_MODE) { injectFloatBar(); return; }
  if (document.getElementById(BAR_ID)) return;
  const style = document.createElement('style');
  style.textContent = CHROME_CSS;
  document.head.appendChild(style);

  // 声明自绘标题栏高度：better-sidebar 等客户端插件据此自动下移其
  // fixed 定位的顶部元素（标签栏 + 折叠按钮）。不设置时它们渲染在视口
  // 顶部 0-36px，正好被本玻璃栏盖住——用户“看不到标签栏、无法折叠”
  // 的根因。dsh web 本体不消费该属性，不会双重下移。
  document.documentElement.setAttribute('data-dsh-title-bar-height', String(BAR_HEIGHT));

  // 内容区整体下移，避免遮挡 Web UI 顶部。
  const layout = document.createElement('style');
  layout.textContent = `body{box-sizing:border-box!important;padding-top:${BAR_HEIGHT}px!important}`;
  document.head.appendChild(layout);

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.innerHTML = `
    <div class="dch-left">
      <img class="dch-icon" alt="" draggable="false" />
      <span class="dch-title">Deepseek Harness EAC</span>
      <span class="dch-badge" hidden></span>
    </div>
    <div class="dch-right">
      <button class="dch-btn" data-act="menu" title="菜单" aria-label="菜单">${GLYPHS.menu}</button>
      <button class="dch-btn" data-act="min" title="最小化" aria-label="最小化">${GLYPHS.min}</button>
      <button class="dch-btn" data-act="max" title="最大化" aria-label="最大化">${GLYPHS.max}</button>
      <button class="dch-btn dch-close" data-act="close" title="关闭" aria-label="关闭">${GLYPHS.close}</button>
    </div>
    <div class="dch-menu" hidden></div>`;
  document.body.appendChild(bar);

  const badge = bar.querySelector('.dch-badge');
  const icon = bar.querySelector('.dch-icon');
  maxBtn = bar.querySelector('[data-act="max"]');
  menuEl = bar.querySelector('.dch-menu');

  bar.querySelector('[data-act="min"]').addEventListener('click', () => dshDesktop.windowControls.minimize());
  bar.querySelector('[data-act="max"]').addEventListener('click', () => dshDesktop.windowControls.toggleMaximize());
  bar.querySelector('.dch-close').addEventListener('click', () => dshDesktop.windowControls.close());
  bar.querySelector('[data-act="menu"]').addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuOpen) closeMenu(); else openMenu();
  });

  document.addEventListener('click', (e) => {
    if (menuOpen && !bar.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // 初始化状态
  dshDesktop.getInfo().then((info) => {
    if (!info) return;
    state = { ...state, ...info };
    if (info.appVersion) badge.textContent = 'v' + info.appVersion;
    if (info.agentVersion) badge.title = 'agent v' + info.agentVersion + '（' + info.agentSource + '）';
    if (info.agentVersion) { badge.hidden = false; }
    if (info.iconDataUri) icon.src = info.iconDataUri;
  }).catch(() => {});
  dshDesktop.windowControls.isMaximized().then(setMaximized).catch(() => {});
  dshDesktop.windowControls.onMaximizeChange(setMaximized);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectChrome);
} else {
  injectChrome();
}

// ---------------------------------------------------------------------------
// Renderer 心跳：每 5s 向主进程上报一次。主进程用它兜底判定「挂起但
// Chromium 未发出 unresponsive 事件」的场景（窗口不可见时页面定时器会被
// 节流，主进程只对可见窗口做判定；重新可见时立即补报一次心跳）。
// ---------------------------------------------------------------------------
{
  const beat = () => {
    try { ipcRenderer.send('dsh:renderer-heartbeat'); } catch {}
  };
  beat();
  setInterval(beat, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beat();
  });
}

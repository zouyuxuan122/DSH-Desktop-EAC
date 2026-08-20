/**
 * preload/chrome.ts — 自绘窗口栏与菜单（Task 6.4 自 preload.js 提取）。
 *
 * 主窗：注入 36px 玻璃条（拖拽区 / 圆角应用图标 / 标题版本徽标 / 菜单按钮
 * ⋯ / 最小化 / 最大化 / 关闭），替代被移除的原生标题栏与菜单栏；内容区
 * 整体下移 36px（body padding-top + data-dsh-title-bar-height 声明）。
 * 浮窗：只注入 24px 细拖拽条（纯拖拽 + 关闭）。
 */

import type { ChromeInfo, DshDesktopApi, FloatMode } from './api.js';

/** 主窗玻璃栏 DOM id / 高度。 */
export const BAR_ID = '__dsh_desktop_chrome__';
export const BAR_HEIGHT = 36;
/** 浮窗细拖拽条 DOM id / 高度。 */
export const FLOAT_BAR_ID = '__dsh_desktop_floatbar__';
export const FLOAT_BAR_HEIGHT = 24;

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

/** 按钮 SVG 图标（12×12，currentColor）。 */
const GLYPHS: Record<string, string> = {
  menu: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="2.4" cy="6" r="1.15"/><circle cx="6" cy="6" r="1.15"/><circle cx="9.6" cy="6" r="1.15"/></svg>',
  min: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 6h7"/></svg>',
  max: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4"/></svg>',
  restore: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4.2 4.2V2.6h5.2v5.2H7.8"/><rect x="2.6" y="4.2" width="5.2" height="5.2" rx="1.2"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg>',
};

/** 「关闭窗口时」的三个选项。 */
const EXIT_ACTIONS: Array<{ value: string; label: string }> = [
  { value: 'ask', label: '每次询问' },
  { value: 'minimize', label: '后台运行（最小化到托盘）' },
  { value: 'quit', label: '直接退出' },
];

/** HTML 转义（菜单文案/URL 注入 innerHTML 前）。 */
function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c] ?? c,
  );
}

let menuOpen = false;
let menuEl: HTMLElement | null = null;
let maxBtn: HTMLElement | null = null;
let state: ChromeInfo = {
  appVersion: '',
  agentVersion: '',
  agentSource: '',
  notifyOnTurnEnd: true,
  closeToTray: true,
  exitAction: 'ask',
  shortcutPolicy: 'auto',
};

/** 渲染菜单内容（每次 openMenu 前重画，状态实时）。 */
function renderMenu(api: DshDesktopApi): void {
  if (!menuEl) return;
  const repoGithub = state.repoUrls ? String(state.repoUrls.github ?? '') : '';
  const repoGitee = state.repoUrls ? String(state.repoUrls.gitee ?? '') : '';
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
        <span class="dch-repo-url" title="${esc(repoGithub)}">${esc(repoGithub)}</span>
        <button class="dch-copy" data-copy="github" title="复制地址">复制</button>
      </div>
      <div class="dch-repo-row">
        <span class="dch-repo-url" title="${esc(repoGitee)}">${esc(repoGitee)}</span>
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
    <button class="dch-item" data-act="open-terminal"><span>内置终端</span><span class="dch-kbd">Node+npm</span></button>
    <button class="dch-item" data-act="devtools"><span>开发者工具</span><span class="dch-kbd">F12</span></button>
    <button class="dch-item" data-act="fullscreen"><span>全屏</span><span class="dch-kbd">F11</span></button>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="open-browser">在浏览器中打开</button>
    <button class="dch-item" data-act="export-logs">导出日志</button>
    <button class="dch-item" data-act="feedback">反馈建议</button>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="about">关于 Deepseek Harness EAC</button>
    <button class="dch-item" data-danger="1" data-act="quit">退出</button>`;
  menuEl.querySelectorAll<HTMLElement>('.dch-item').forEach((item) => {
    item.addEventListener('click', () => void (async () => {
      const act = item.dataset.act ?? '';
      if (act === 'toggle-notify' || act === 'toggle-shortcut-policy') {
        const next = (await api.menu.action(act)) as ChromeInfo | null;
        if (next) state = { ...state, ...next };
        renderMenu(api);
        return;
      }
      if (act === 'set-exit-action') {
        const next = (await api.menu.action(act, { value: item.dataset.value })) as ChromeInfo | null;
        if (next) state = { ...state, ...next };
        renderMenu(api);
        return;
      }
      closeMenu();
      void api.menu.action(act);
    })());
  });
  // 更新源复制按钮
  menuEl.querySelectorAll<HTMLElement>('.dch-copy').forEach((btn) => {
    btn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        const kind = btn.dataset.copy;
        const url = state.repoUrls && (kind === 'github' ? state.repoUrls.github : state.repoUrls.gitee);
        if (!url) return;
        const r = await api.copyText(String(url));
        if (r && r.ok) {
          const prev = btn.textContent;
          btn.textContent = '已复制 ✓';
          setTimeout(() => {
            btn.textContent = prev;
          }, 1200);
        }
      })();
    });
  });
}

function closeMenu(): void {
  menuOpen = false;
  if (menuEl) menuEl.hidden = true;
}

function openMenu(api: DshDesktopApi): void {
  if (!menuEl) return;
  const el = menuEl;
  api
    .getInfo()
    .then((info) => {
      if (info) state = { ...state, ...info };
      renderMenu(api);
      menuOpen = true;
      el.hidden = false;
    })
    .catch(() => {
      renderMenu(api);
      menuOpen = true;
      el.hidden = false;
    });
}

/** 最大化/还原图标切换。 */
function setMaximized(isMax: boolean): void {
  if (!maxBtn) return;
  maxBtn.innerHTML = isMax ? (GLYPHS.restore as string) : (GLYPHS.max as string);
  maxBtn.title = isMax ? '还原' : '最大化';
  maxBtn.setAttribute('aria-label', maxBtn.title);
}

/** 浮窗的细拖拽条（纯拖拽 + 关闭按钮，跳过完整自绘标题栏）。 */
function injectFloatBar(api: DshDesktopApi): void {
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
  const closeBtn = bar.querySelector('.df-close');
  if (closeBtn) closeBtn.addEventListener('click', () => api.floatWindow.close());
}

/**
 * 注入自绘 chrome：浮窗模式只装细拖拽条；主窗装完整玻璃栏 + 菜单。
 * DOM ready 由调用方（preload.ts）保证。
 */
export function injectChrome(api: DshDesktopApi, floatMode: FloatMode | null): void {
  if (floatMode) {
    injectFloatBar(api);
    return;
  }
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

  const badge = bar.querySelector<HTMLElement>('.dch-badge');
  const icon = bar.querySelector<HTMLImageElement>('.dch-icon');
  maxBtn = bar.querySelector('[data-act="max"]');
  menuEl = bar.querySelector('.dch-menu');

  const minBtn = bar.querySelector('[data-act="min"]');
  if (minBtn) minBtn.addEventListener('click', () => void api.windowControls.minimize());
  if (maxBtn) maxBtn.addEventListener('click', () => void api.windowControls.toggleMaximize());
  const closeBtn = bar.querySelector('.dch-close');
  if (closeBtn) closeBtn.addEventListener('click', () => void api.windowControls.close());
  const menuBtn = bar.querySelector('[data-act="menu"]');
  if (menuBtn) {
    menuBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      if (menuOpen) closeMenu();
      else openMenu(api);
    });
  }

  document.addEventListener('click', (e: Event) => {
    if (menuOpen && !bar.contains(e.target as Node)) closeMenu();
  });
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeMenu();
  });

  // 初始化状态
  api
    .getInfo()
    .then((info) => {
      if (!info) return;
      state = { ...state, ...info };
      if (badge) {
        if (info.appVersion) badge.textContent = 'v' + info.appVersion;
        if (info.agentVersion) badge.title = 'agent v' + info.agentVersion + '（' + info.agentSource + '）';
        if (info.agentVersion) badge.hidden = false;
      }
      if (icon && info.iconDataUri) icon.src = info.iconDataUri;
    })
    .catch(() => {});
  api.windowControls.isMaximized().then(setMaximized).catch(() => {});
  api.windowControls.onMaximizeChange(setMaximized);
}

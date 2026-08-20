/**
 * preload/api.ts — contextBridge 桥接面（Task 6.4 自 preload.js 提取）。
 *
 * 暴露 window.dshDesktop（窗口控制 / 菜单动作 / 余额刷新 / 插件管理 / 恢复
 * 页动作等）—— **API 面与拆分前逐项一致**，各客户端插件（dsh-balance /
 * dsh-plugin-manager / dsh-plugin-shield / dsh-float-window…）零改动。
 *
 * 另含：浮窗模式检测（window.__DSH_FLOAT__ + 目标会话预置）、页面异常上报、
 * 余额推送转 window 事件、渲染进程心跳。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

/** window.dshDesktop 的完整 API 面（对页面与客户端插件公开）。 */
export interface DshDesktopApi {
  appVersion: string;
  windowControls: {
    minimize(): Promise<unknown>;
    toggleMaximize(): Promise<unknown>;
    close(): Promise<unknown>;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(cb: (isMax: boolean) => void): () => void;
  };
  menu: {
    action(action: string, payload?: Record<string, unknown>): Promise<unknown>;
  };
  getInfo(): Promise<ChromeInfo | null>;
  refreshBalance(): Promise<unknown>;
  restartService(): Promise<unknown>;
  floatWindow: {
    open(sessionId: string): Promise<unknown>;
    close(): void;
  };
  guard: {
    action(action: string, value?: unknown): Promise<unknown>;
  };
  pluginWizard: {
    open(): Promise<unknown>;
  };
  pluginManager: {
    list(): Promise<unknown>;
    setEnabled(id: string, enabled: boolean): Promise<unknown>;
    setRemoved(id: string, removed: boolean): Promise<unknown>;
  };
  pluginUpdates: {
    list(force?: boolean): Promise<unknown>;
    update(id: string): Promise<unknown>;
    setAutoUpdate(enabled: boolean): Promise<unknown>;
  };
  imagePaste: {
    save(payload: unknown): Promise<unknown>;
  };
  balancePrices: {
    get(model: string): Promise<unknown>;
    set(model: string, prices: unknown): Promise<unknown>;
    reset(model: string): Promise<unknown>;
  };
  revertFiles(changes: unknown): Promise<unknown>;
  openPath(path: string): Promise<unknown>;
  openExternal(url: string): Promise<unknown>;
  copyText(text: string): Promise<{ ok?: boolean } | null>;
  getPathForFile(file: unknown): string;
  recovery: {
    getState(): Promise<unknown>;
    reload(): Promise<unknown>;
    restart(): Promise<unknown>;
    exportLogs(): Promise<unknown>;
  };
}

/** chrome:init 返回的应用信息（菜单头 + 徽标消费）。 */
export interface ChromeInfo {
  appVersion?: string;
  agentVersion?: string;
  agentSource?: string;
  notifyOnTurnEnd?: boolean;
  closeToTray?: boolean;
  exitAction?: string;
  shortcutPolicy?: string;
  repoUrls?: { github?: string; gitee?: string };
  iconDataUri?: string;
  [k: string]: unknown;
}

/** 浮窗模式标记（window.__DSH_FLOAT__）。 */
export interface FloatMode {
  sessionId: string;
}

/** 当前是否浮窗（由 --dsh-float= 启动参数注入，见 exposeBridge）。 */
export let FLOAT_MODE: FloatMode | null = null;

/**
 * 暴露 window.dshDesktop 并挂全部被动通道（异常上报 / 余额转发 / 心跳 /
 * 浮窗标记）。返回 api 供 chrome 注入层调用（菜单动作等）。
 */
export function exposeBridge(): DshDesktopApi {
  const dshDesktop: DshDesktopApi = {
    appVersion: '', // 由 chrome:init 回填；旧字段保持存在
    windowControls: {
      minimize: () => ipcRenderer.invoke('chrome:window', { action: 'minimize' }) as Promise<unknown>,
      toggleMaximize: () => ipcRenderer.invoke('chrome:window', { action: 'toggle-maximize' }) as Promise<unknown>,
      close: () => ipcRenderer.invoke('chrome:window', { action: 'close' }) as Promise<unknown>,
      isMaximized: () => ipcRenderer.invoke('chrome:window', { action: 'is-maximized' }) as Promise<boolean>,
      onMaximizeChange: (cb: (isMax: boolean) => void): (() => void) => {
        const listener = (_e: unknown, isMax: boolean): void => {
          try {
            cb(isMax);
          } catch {
            /* 回调异常不影响通道 */
          }
        };
        ipcRenderer.on('chrome:maximized', listener);
        return () => ipcRenderer.removeListener('chrome:maximized', listener);
      },
    },
    menu: {
      action: (action: string, payload: Record<string, unknown> = {}) =>
        ipcRenderer.invoke('chrome:menu', { action, ...payload }) as Promise<unknown>,
    },
    getInfo: () => ipcRenderer.invoke('chrome:init') as Promise<ChromeInfo | null>,
    refreshBalance: () => ipcRenderer.invoke('dsh:balance-refresh') as Promise<unknown>,
    // 插件市场：请求主进程原地重启 dsh web 服务（安装/卸载插件后生效）。
    restartService: () => ipcRenderer.invoke('chrome:restart-service', { intent: 'restart-service' }) as Promise<unknown>,
    // 会话浮窗（V4 多窗口）：主窗请求把某个会话弹出到独立窗口；浮窗关闭自身。
    floatWindow: {
      open: (sessionId: string) => ipcRenderer.invoke('chrome:float-window', { action: 'open', sessionId }) as Promise<unknown>,
      close: (): void => {
        ipcRenderer.send('float:close');
      },
    },
    // 插件保护中心（lib/plugin-guard）：快照 / 回滚 / 体检 / 修复 / 事故报告。
    // 设置页「插件保护」分区（dsh-plugin-shield 插件）从这里驱动主进程引擎。
    guard: {
      action: (action: string, value?: unknown) => ipcRenderer.invoke('guard:action', { action, value }) as Promise<unknown>,
    },
    // 内置插件选择向导：设置页「插件 → 选择向导」（dsh-plugin-wizard 插件）
    // 从这里二次打开向导窗口，按需启用/停用内置插件。
    pluginWizard: {
      open: () => ipcRenderer.invoke('onboard:open') as Promise<unknown>,
    },
    // 插件管理（dsh-plugin-manager 插件「管理」标签）：列出配套/用户/核心插件
    // 及启用状态，写入/移除 profile cordis.patch.yml 的 disabled 条目
    // （完全退出并重启应用后生效，返回 { ok, restartRequired }）。
    pluginManager: {
      list: () => ipcRenderer.invoke('dsh:plugin-list') as Promise<unknown>,
      setEnabled: (id: string, enabled: boolean) =>
        ipcRenderer.invoke('dsh:plugin-set-enabled', { id, enabled }) as Promise<unknown>,
      // V4.2：移除（卸载语义）/恢复内置插件，返回 { ok, restartRequired }。
      setRemoved: (id: string, removed: boolean) =>
        ipcRenderer.invoke('dsh:plugin-set-removed', { id, removed }) as Promise<unknown>,
    },
    // 插件更新（V4.3，dsh-plugin-marketplace「更新」标签）：内置插件上游更新
    // —— 清单 / 手动更新单个 / 自动更新开关（默认关，仅提示）。
    pluginUpdates: {
      list: (force = false) => ipcRenderer.invoke('dsh:plugin-updates', { force }) as Promise<unknown>,
      update: (id: string) => ipcRenderer.invoke('dsh:plugin-update', { id }) as Promise<unknown>,
      setAutoUpdate: (enabled: boolean) => ipcRenderer.invoke('dsh:plugin-auto-update', { enabled }) as Promise<unknown>,
    },
    // 图片粘贴（V4.2，dsh-image-paste 插件）：把剪贴板图片存到临时目录
    // （%TEMP%/dsh-paste/），返回 { ok, path, size } 供 agent 读取。
    imagePaste: {
      save: (payload: unknown) => ipcRenderer.invoke('dsh:image-paste-save', payload) as Promise<unknown>,
    },
    // Token 价格自定义（V4.2，dsh-balance 插件「价格设置」页）：读取默认档/
    // 当前覆盖、保存自定义价格（¥/百万 token）、恢复默认。
    balancePrices: {
      get: (model: string) => ipcRenderer.invoke('dsh:balance-prices-get', { model }) as Promise<unknown>,
      set: (model: string, prices: unknown) => ipcRenderer.invoke('dsh:balance-prices-set', { model, prices }) as Promise<unknown>,
      reset: (model: string) => ipcRenderer.invoke('dsh:balance-prices-reset', { model }) as Promise<unknown>,
    },
    // 「文件」视图的还原请求：changes = [{path, op, oldText, newText}]（逆序）。
    revertFiles: (changes: unknown) => ipcRenderer.invoke('dsh:file-revert', { changes }) as Promise<unknown>,
    // 「全部文件」视图：用系统默认程序打开项目文件。
    openPath: (path: string) => ipcRenderer.invoke('dsh:file-open', { path }) as Promise<unknown>,
    // 预览面板：用系统浏览器打开 URL（端口预览等）。
    openExternal: (url: string) => ipcRenderer.invoke('dsh:open-external', { url }) as Promise<unknown>,
    // 复制文本到剪贴板（更新源地址等）。
    copyText: (text: string) => ipcRenderer.invoke('dsh:copy-text', { text }) as Promise<{ ok?: boolean } | null>,
    // 拖入文件（dsh-file-drop）：取浏览器 File 对象的完整磁盘路径
    // （webUtils.getPathForFile，仅 Electron 环境；浏览器打开 WebUI 时
    // 返回空字符串，插件自动降级为可读提示）。
    getPathForFile: (file: unknown): string => {
      try {
        return webUtils.getPathForFile(file as File) || '';
      } catch {
        return '';
      }
    },
    // 恢复页面（assets/recovery.html）使用的动作与状态读取。
    recovery: {
      getState: () => ipcRenderer.invoke('chrome:recovery-state') as Promise<unknown>,
      reload: () => ipcRenderer.invoke('chrome:recovery-reload') as Promise<unknown>,
      restart: () => ipcRenderer.invoke('chrome:recovery-restart') as Promise<unknown>,
      exportLogs: () => ipcRenderer.invoke('chrome:export-logs') as Promise<unknown>,
    },
  };

  contextBridge.exposeInMainWorld('dshDesktop', dshDesktop);

  // 浮窗模式检测（V4 多窗口，移植自上游 dsh_desktop）：process.argv 由
  // webPreferences.additionalArguments 注入。浮窗内暴露 window.__DSH_FLOAT__ =
  // { sessionId } 供 dsh-float-window 插件识别，并预置目标会话到持久化，
  // 让 Web UI 一启动就选中目标会话（比启动后 sessions.open() 可靠：会话服务
  // 在 boot 早期尚未就绪时 open() 会抛 unknown session）。
  const floatArg = process.argv.find((a) => a.startsWith('--dsh-float='));
  FLOAT_MODE = floatArg ? { sessionId: floatArg.slice('--dsh-float='.length) } : null;
  if (FLOAT_MODE) {
    contextBridge.exposeInMainWorld('__DSH_FLOAT__', FLOAT_MODE);
    try {
      const key = 'dsh.sessions.current';
      const raw = localStorage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (parsed && typeof parsed === 'object') {
        parsed.sessionId = String(FLOAT_MODE.sessionId);
        delete parsed.subagentAddress;
        localStorage.setItem(key, JSON.stringify(parsed));
      }
    } catch {
      /* 忽略持久化失败 */
    }
  }

  // 页面异常 → 主进程日志（desktop.log），便于排查插件空白视图。
  window.addEventListener('error', (e: ErrorEvent) => {
    try {
      ipcRenderer.send('dsh:page-error', 'window.onerror: ' + ((e && (e.message || e.error)) || 'unknown'));
    } catch {
      /* 上报失败静默 */
    }
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    try {
      ipcRenderer.send('dsh:page-error', 'unhandledrejection: ' + String((e && e.reason && ((e.reason as Error).message || e.reason)) || e));
    } catch {
      /* 上报失败静默 */
    }
  });

  // 余额推送 → window 事件（dsh-balance 插件订阅）。
  ipcRenderer.on('dsh:balance', (_e, data: unknown) => {
    try {
      window.dispatchEvent(new CustomEvent('dsh-balance-changed', { detail: data }));
    } catch {
      /* 派发失败静默 */
    }
  });

  // 渲染进程心跳：每 5s 向主进程上报一次。主进程用它兜底判定「挂起但
  // Chromium 未发出 unresponsive 事件」的场景（窗口不可见时页面定时器会被
  // 节流，主进程只对可见窗口做判定；重新可见时立即补报一次心跳）。
  {
    const beat = (): void => {
      try {
        ipcRenderer.send('dsh:renderer-heartbeat');
      } catch {
        /* 主进程可能正在退出 */
      }
    };
    beat();
    setInterval(beat, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') beat();
    });
  }

  return dshDesktop;
}

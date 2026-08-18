'use strict';

// IPC 注册（architecture-refactor-plan.md Phase 1：ipc/register-ipc）。
//
// 从 main.js 的 registerChromeIpc 原样迁出：34 个 renderer→main 通道按领域
// 分组注册。通道契约见 ipc/contracts.js（test/ipc-contracts.test.mjs 静态
// 比对 main.js / preload 防漂移）。
//
// 依赖注入约定：
//   · 「稳定引用」（函数 / 常量 / Set/Map）按引用传入，调用期语义与 main.js
//     模块作用域一致 —— handler 主体逐行保持原状；
//   · 「可变状态」（mainWindow / serverProc / recovery / wizardWindow / …，
//     main.js 里是 let）以 ctx.x() 访问器调用 —— 每次 handler 执行都取当前值，
//     等价于原先闭包读取模块级变量；
//   · 两处写入（notifyOnTurnEnd / forceQuit）经 ctx.setX 提交。
// 未授权响应形状（null / [] / {ok:false,error:…}）与 sender 校验规则全部
// 保持 main.js 原状，与契约表 unauthorized 字段一一对应。

function registerIpc({ ipcMain, ctx, log }) {
  // ---- 稳定引用（按引用解构；可变状态一律用 ctx.x() 访问器） ----
  const {
    app, fs, path, shell, clipboard,
    updater, pluginUpdater, balance, onboardingLogic,
    updCtx, loadSettings, saveSettings,
    desktopProfile, desktopProfileDir,
    APP_VERSION, FLOAT_MAX, COMPANION_PLUGINS, DANGEROUS_EXT,
    floatWindows, floatBySession,
    restartApp, startAndShowGuarded, restartWebServiceCore,
    runUpdateFlow, runClientUpdateFlow, showBox, closeWizard, openPluginWizard,
    createFloatWindow, pluginManagerCollect, pluginManagerSetEnabled,
    pluginManagerSetRemoved, pluginManagerUninstall, pluginManagerRestore,
    ensureDesktopProfileInit, buildOnboardingCatalog, pluginCurrentState,
    imagePasteSave, refreshBalance, isUnderFileRoots, repoUrls, ensureGuard,
    copyPluginPackage, pluginUpdateSources, dshVersion, dshVersionSource,
    getExitAction, closeToTrayEnabled, setCloseToTray, setExitAction, showAbout,
  } = ctx;

  ipcMain.handle('chrome:init', async (event) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return null;
    let iconDataUri = '';
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
      if (buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50) {
        iconDataUri = 'data:image/png;base64,' + buf.toString('base64');
      }
    } catch (err) {
      log('chrome', '读取图标失败（恢复页将无图标）: ' + err.message);
    }
    const s = loadSettings(updCtx());
    const urls = repoUrls();
    return {
      appVersion: APP_VERSION,
      agentVersion: dshVersion(),
      agentSource: dshVersionSource(),
      notifyOnTurnEnd: ctx.notifyOnTurnEnd(),
      closeToTray: s.closeToTray !== false,
      exitAction: getExitAction(),
      shortcutPolicy: s.shortcutPolicy === 'never' ? 'never' : 'auto',
      iconDataUri,
      repoUrls: urls,
      staticPort: ctx.previewStaticPort(),
    };
  });

  // Renderer 心跳：preload 每 5s 上报一次，恢复状态机用它兜底判定
  // 「挂起但 Chromium 未发出 unresponsive」的场景。
  ipcMain.on('dsh:renderer-heartbeat', (event) => {
    if (ctx.recovery()) ctx.recovery().noteHeartbeat(event.sender.id);
  });

  // 恢复页面（assets/recovery.html）的按钮与状态读取。全部校验来源必须是主窗。
  ipcMain.handle('chrome:recovery-state', (event) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return null;
    return {
      appVersion: APP_VERSION,
      logsDir: ctx.logsDir(),
      crashDumpsDir: app.getPath('crashDumps'),
      state: ctx.recovery() ? ctx.recovery().stateOf(ctx.mainWindow()) : null,
    };
  });

  ipcMain.handle('chrome:recovery-reload', async (event) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    // 服务进程已退出时先重启服务（可能换新端口），再恢复加载。
    if (!ctx.serverProc() || ctx.serverProc().exitCode !== null || ctx.serverProc().killed) {
      try {
        await startAndShowGuarded();
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    ctx.recovery().retryNow(ctx.mainWindow());
    return { ok: true };
  });

  ipcMain.handle('chrome:recovery-restart', (event) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    log('recovery', '用户在恢复页面选择重启客户端');
    restartApp({ force: true });
    return { ok: true };
  });

  ipcMain.handle('chrome:recovery-open-logs', (event) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    shell.openPath(ctx.logsDir());
    return { ok: true };
  });

  ipcMain.handle('chrome:window', (event, { action } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return null;
    switch (action) {
      case 'minimize': ctx.mainWindow().minimize(); break;
      case 'toggle-maximize': ctx.mainWindow().isMaximized() ? ctx.mainWindow().unmaximize() : ctx.mainWindow().maximize(); break;
      case 'close': ctx.mainWindow().close(); break;
      case 'is-maximized': return ctx.mainWindow().isMaximized();
    }
    return null;
  });

  ipcMain.handle('chrome:menu', async (event, { action, value } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) {
      return { notifyOnTurnEnd: ctx.notifyOnTurnEnd(), closeToTray: closeToTrayEnabled(), exitAction: getExitAction() };
    }
    switch (action) {
      case 'reload': ctx.mainWindow().reload(); break;
      case 'devtools': ctx.mainWindow().webContents.toggleDevTools(); break;
      case 'fullscreen': ctx.mainWindow().setFullScreen(!ctx.mainWindow().isFullScreen()); break;
      case 'open-browser': if (ctx.webUrl()) shell.openExternal(ctx.webUrl()); break;
      case 'open-logs': shell.openPath(ctx.logsDir()); break;
      case 'feedback': shell.openExternal('https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues'); break;
      case 'check-agent-update': runUpdateFlow(true); break;
      case 'check-client-update': runClientUpdateFlow(true); break;
      case 'toggle-notify': {
        ctx.setNotifyOnTurnEnd(!ctx.notifyOnTurnEnd());
        const s = loadSettings(updCtx());
        s.notifyOnTurnEnd = ctx.notifyOnTurnEnd();
        saveSettings(updCtx(), s);
        break;
      }
      case 'toggle-close-to-tray': setCloseToTray(!closeToTrayEnabled()); break;
      case 'set-exit-action': setExitAction(value); break;
      case 'restart-service': {
        // 不关闭应用重启 dsh web 服务（皮肤/插件切换后生效，等同市场安装
        // 后的自动重启路径）。窗口由 startAndShow 重载到新端口。
        const r = await restartWebServiceCore();
        if (!r.ok && r.error !== 'not-running') {
          showBox({
            type: 'error',
            title: '重启 Web 服务失败',
            message: 'dsh web 服务重启未成功。',
            detail: r.error,
            buttons: ['确定'],
          }).catch(() => {});
        }
        break;
      }
      case 'toggle-shortcut-policy': {
        // V4（用户建议③）：桌面快捷方式自动维护开关。关掉后启动不再自动
        // 创建/修复桌面快捷方式（开始菜单的仍维护 —— 系统通知的前置条件）。
        const s = updater.loadSettings(updCtx());
        s.shortcutPolicy = s.shortcutPolicy === 'never' ? 'auto' : 'never';
        updater.saveSettings(updCtx(), s);
        log('boot', '桌面快捷方式自动维护: ' + s.shortcutPolicy);
        break;
      }
      case 'about': showAbout(); break;
      case 'quit': ctx.setForceQuit(true); app.quit(); break;
    }
    const menuState = updater.loadSettings(updCtx());
    return {
      notifyOnTurnEnd: ctx.notifyOnTurnEnd(),
      closeToTray: closeToTrayEnabled(),
      exitAction: getExitAction(),
      shortcutPolicy: menuState.shortcutPolicy === 'never' ? 'never' : 'auto',
    };
  });

  // 插件市场：原地重启 dsh web 服务（安装/卸载插件后生效，窗口重载到新端口）。
  // 核心逻辑 restartWebServiceCore 在模块作用域（⋯ 菜单与托盘共用）。
  ipcMain.handle('chrome:restart-service', async (event, payload = {}) => {
    if (payload?.intent !== 'restart-service') return { ok: false, error: 'missing-intent' };
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    return restartWebServiceCore();
  });

  // 插件保护中心（plugin-guard.js）：快照 / 回滚 / 体检 / 修复 / 事故报告。
  // 设置页「插件保护」分区（dsh-plugin-shield 插件）从这里取数与触发动作。
  ipcMain.handle('guard:action', async (event, { action, value } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    const g = ensureGuard();
    switch (action) {
      case 'status': {
        const st = (() => { try { return updater.loadSettings(updCtx()); } catch { return {}; } })();
        return {
          ok: true,
          profile: desktopProfile(),
          shareWebProfile: st.shareWebProfile === true,
          snapshots: g.listSnapshots().slice(0, 20),
          incidents: g.listIncidents().slice(0, 20),
          lastGood: g.lastGoodSnapshot(),
        };
      }
      case 'snapshot': {
        const s = g.snapshot(String(value || 'manual'));
        return { ok: !!s, snapshot: s };
      }
      case 'restore': {
        if (ctx.serverProc() && !ctx.restartingServer()) {
          // 服务运行中不能换配置文件（文件锁 + 进程内存态）：走标准重启窗口。
          return { ok: false, error: 'service-running', hint: '请先重启 Web 服务（或让回滚在重启间隙执行）' };
        }
        return g.restore(value);
      }
      case 'check':
        return { ok: true, report: g.healthCheck() };
      case 'repair': {
        const r = g.repair();
        return { ok: true, applied: r.applied };
      }
      case 'incident':
        return g.readIncident(value);
      case 'resolve-incident':
        return g.resolveIncident(value);
      default:
        return { ok: false, error: 'unknown action' };
    }
  });

  // 插件管理（V4，设置页「插件 → 管理」标签，dsh-plugin-manager 插件消费）：
  //   list —— 收集配套/用户/核心插件：id、包名、描述、启用状态
  //   set  —— 写入/移除 profile cordis.patch.yml 的用户层 disabled 条目
  //           （纯文本手术；完全退出并重启应用后生效）
  ipcMain.handle('dsh:plugin-list', async (event) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return [];
    return pluginManagerCollect();
  });

  ipcMain.handle('dsh:plugin-set-enabled', async (event, { id, enabled } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    const row = pluginManagerCollect().find((r) => r.id === id);
    if (!row) return { ok: false, error: '未知插件: ' + String(id) };
    if (!row.toggleable) return { ok: false, error: '该插件不可关闭: ' + String(id) };
    try {
      const res = pluginManagerSetEnabled(id, !!enabled);
      if (!res.ok) return res;
      log('plugin-manager', '已' + (enabled ? '启用' : '关闭') + '插件 ' + id);
      return { ok: true, restartRequired: true };
    } catch (err) {
      log('plugin-manager', '设置插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 内置插件移除/恢复（V4.2）：移除 = 卸载语义（清 patch 行 + 删包副本 +
  // 记入 settings.removedPlugins 跳过下次 sync）；恢复 = 清跳过清单 + 立即
  // 复制包与行。两者都需重启 Web 服务生效。
  ipcMain.handle('dsh:plugin-set-removed', async (event, { id, removed } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    try {
      const res = pluginManagerSetRemoved(String(id), !!removed);
      return res.ok ? { ok: true, restartRequired: true } : res;
    } catch (err) {
      log('plugin-manager', '移除/恢复插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 插件更新（V4.3，设置页「插件 → 更新」标签，dsh-plugin-marketplace 插件
  // 消费）：内置插件上游更新 —— 检测清单 / 手动更新单个 / 自动更新开关。
  // 数据与动作都在主进程完成（npm 镜像链 + 覆盖层），Web 端只做展示。
  ipcMain.handle('dsh:plugin-updates', async (event, { force = false } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return null;
    try {
      const settingsCtx = updCtx();
      const list = await pluginUpdater.checkPluginUpdates(settingsCtx, pluginUpdateSources(), {
        force: !!force,
        profileDirP: desktopProfileDir(),
      });
      return {
        list,
        autoUpdate: pluginUpdater.isAutoUpdateEnabled(settingsCtx),
        checkedAt: updater.loadSettings(settingsCtx).pluginUpdateCheckedAt || null,
      };
    } catch (err) {
      log('plugin-update', '插件更新清单加载失败: ' + String((err && err.message) || err));
      return { list: [], autoUpdate: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:plugin-update', async (event, { id } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    const source = pluginUpdateSources().find((s) => s.id === String(id));
    if (!source) return { ok: false, error: '未知或不可更新的内置插件: ' + String(id) };
    try {
      const res = await pluginUpdater.applyBuiltinPluginUpdate(updCtx(), source, {
        profileDirP: desktopProfileDir(),
        guard: ensureGuard(),
        copyIntoProfile: (overlayDir, name) => copyPluginPackage(desktopProfileDir(), overlayDir, name),
      });
      if (!res.ok) return res;
      if (res.noop) return { ok: true, noop: true, current: res.current, latest: res.latest };
      log('plugin-update', '手动更新内置插件 ' + id + ' → ' + res.latest + (res.restartRequired ? '（重启服务生效）' : ''));
      return { ok: true, version: res.latest, restartRequired: res.restartRequired };
    } catch (err) {
      log('plugin-update', '更新插件 ' + id + ' 失败: ' + String((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:plugin-auto-update', async (event, { enabled } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    try {
      const settingsCtx = updCtx();
      const s = updater.loadSettings(settingsCtx);
      s.pluginAutoUpdate = !!enabled;
      updater.saveSettings(settingsCtx, s);
      log('plugin-update', '内置插件自动更新已' + (enabled ? '开启' : '关闭'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 图片粘贴（V4.2，dsh-image-paste 插件）：把剪贴板图片存到临时目录供
  // agent 的 inspect_image 读取。只接受 image/* 的 data URL，限 15MB，
  // 文件名清洗（防路径穿越），写入路径固定为 %TEMP%/dsh-paste/。
  ipcMain.handle('dsh:image-paste-save', async (event, { dataUrl, name } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    try {
      const res = imagePasteSave(String(dataUrl || ''), String(name || '粘贴图片'));
      if (!res.ok) return res;
      log('plugin-manager', '已保存粘贴图片: ' + res.path);
      return res;
    } catch (err) {
      log('plugin-manager', '保存粘贴图片失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 内置插件选择向导（assets/onboarding.html，onboarding-preload.js 桥）：
  //   list   —— 目录（核心/推荐标记 + 描述 + 体积）+ 模式 + 当前启停状态
  //   submit —— 校验选择 → 写 disabled/裸条目 → 持久化 settings → 关窗；
  //             rerun 模式随后重启 Web 服务使 host 侧插件生效
  //   close  —— 用户点「跳过」/关闭窗口（走 closed 事件的 cancelled 分支）
  // 来源校验：只接受向导窗口自身的 webContents。
  ipcMain.handle('onboard:list', async (event) => {
    if (!ctx.wizardWindow() || event.sender !== ctx.wizardWindow().webContents) return null;
    return {
      mode: ctx.wizardMode(),
      catalog: buildOnboardingCatalog(),
      current: ctx.wizardMode() === 'rerun' ? pluginCurrentState() : null,
    };
  });

  ipcMain.handle('onboard:submit', async (event, { ids } = {}) => {
    if (!ctx.wizardWindow() || event.sender !== ctx.wizardWindow().webContents) return { ok: false, error: 'unauthorized' };
    // 首次向导时 sync 尚未运行、profile 目录可能还不存在：先按官方模板初始化
    // （package.json / pnpm-workspace.yaml / 空 patch 层），否则写盘 ENOENT。
    ensureDesktopProfileInit();
    const want = onboardingLogic.sanitizeSelection(ids, COMPANION_PLUGINS, onboardingLogic.CORE_PLUGIN_IDS);
    // 首次：patch 行尚未写全，normalize 全部非核心插件（current=null）；
    // 二次：只切换与用户选择不同的插件。
    const current = ctx.wizardMode() === 'rerun' ? pluginCurrentState() : null;
    const ops = onboardingLogic.buildSelectionOps(COMPANION_PLUGINS, onboardingLogic.CORE_PLUGIN_IDS, want, current);
    const errors = [];
    for (const op of ops) {
      try {
        const res = pluginManagerSetEnabled(op.id, op.enable);
        if (!res.ok) errors.push(op.id + ': ' + (res.error || 'unknown'));
        else log('plugin-manager', '向导已' + (op.enable ? '启用' : '停用') + '内置插件 ' + op.id);
      } catch (err) {
        errors.push(op.id + ': ' + ((err && err.message) || err));
      }
    }
    const s = updater.loadSettings(updCtx());
    s.pluginOnboardingDone = true;
    s.builtinPluginSelection = Array.from(want);
    updater.saveSettings(updCtx(), s);
    log('boot', '插件选择向导已应用：' + ops.length + ' 个插件状态变更' + (errors.length ? '，失败 ' + errors.join('; ') : ''));
    const mode = ctx.wizardMode();
    closeWizard({ ok: true, applied: ops.length, errors });
    if (mode === 'rerun' && ctx.serverProc() && ctx.serverProc().exitCode === null) {
      // 二次向导：重启 Web 服务让 host 侧插件生效（与插件市场安装后同路径）。
      restartWebServiceCore();
    }
    return { ok: true, applied: ops.length, errors };
  });

  ipcMain.on('onboard:close', (event) => {
    if (!ctx.wizardWindow() || event.sender !== ctx.wizardWindow().webContents) return;
    closeWizard({ ok: false, cancelled: true });
  });

  // 设置页「插件 → 选择向导」（dsh-plugin-wizard 插件）二次打开入口。
  ipcMain.handle('onboard:open', (event) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    if (ctx.wizardWindow() && !ctx.wizardWindow().isDestroyed()) {
      ctx.wizardWindow().focus();
      return { ok: true, reused: true };
    }
    openPluginWizard({ mode: 'rerun' });
    return { ok: true };
  });

  ipcMain.handle('dsh:plugin-uninstall', async (event, { id } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    const row = pluginManagerCollect().find((r) => r.id === id);
    if (!row) return { ok: false, error: '未知插件: ' + String(id) };
    if (!row.uninstallable) return { ok: false, error: '该插件不可卸载: ' + String(id) };
    return pluginManagerUninstall(id);
  });

  ipcMain.handle('dsh:plugin-restore', async (event, { id } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    const row = pluginManagerCollect().find((r) => r.id === id);
    if (!row) return { ok: false, error: '未知插件: ' + String(id) };
    if (!row.restorable) return { ok: false, error: '该插件当前不可恢复: ' + String(id) };
    return pluginManagerRestore(id);
  });

  // 会话浮窗（V4 多窗口）：主窗请求把某个会话弹出到独立窗口（校验来源与
  // 数量上限）；浮窗自己只允许关闭自身。
  ipcMain.handle('chrome:float-window', (event, { action, sessionId } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    if (action !== 'open') return { ok: false, error: 'bad-action' };
    if (!ctx.webUrl()) return { ok: false, error: 'not-ready' };
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'bad-session' };
    // 同一会话只保留一个浮窗：拖出/按钮连续触发或重复请求时，
    // 复用已有窗口而不是再开第二个。
    const existing = floatBySession.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true, id: existing.id, reused: true };
    }
    if (existing) floatBySession.delete(sessionId);
    if (floatWindows.size >= FLOAT_MAX) return { ok: false, error: 'too-many' };
    const win = createFloatWindow(sessionId);
    if (!win) return { ok: false, error: 'too-many' };
    return { ok: true, id: win.id };
  });

  // 浮窗关闭：仅允许浮窗关闭自身（校验发送者属于某个浮窗）。
  ipcMain.on('float:close', (event) => {
    for (const win of floatWindows) {
      if (!win.isDestroyed() && win.webContents === event.sender) { win.close(); break; }
    }
  });

  // 复制文本到剪贴板（菜单「更新源」复制按钮 / 关于对话框）。
  ipcMain.handle('dsh:copy-text', (event, { text } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false };
    if (typeof text !== 'string' || !text || text.length > 2048) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  // preload 转发的页面异常（window.onerror / unhandledrejection）。
  ipcMain.on('dsh:page-error', (event, payload) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return;
    log('page-error', String(payload));
  });

  ipcMain.handle('dsh:balance-refresh', async (event) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return ctx.balanceCache();
    return refreshBalance();
  });

  // Token 价格自定义（V4.2，dsh-balance 插件「价格设置」页）：读写
  // settings.json 的 balancePrices.<model>.{peak,offpeak}（¥/百万 token，
  // 三字段 cacheMiss/cacheHit/output，必须为 >= 0 的数字）。保存后立即
  // 重推余额数据，dock 的费用估算即时生效。
  ipcMain.handle('dsh:balance-prices-get', async (event, { model } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    const s = updater.loadSettings(updCtx());
    const defaults = balance.DEFAULT_PRICES[String(model || '')] || balance.FALLBACK_PRICES;
    const current = (s.balancePrices && s.balancePrices[String(model || '')]) || null;
    return { ok: true, model: String(model || ''), defaults, current };
  });

  ipcMain.handle('dsh:balance-prices-set', async (event, { model, prices } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    const m = String(model || '');
    if (!balance.DEFAULT_PRICES[m]) return { ok: false, error: '未知模型: ' + m };
    try {
      const cleaned = balance.sanitizePrices(prices);
      const settingsCtx = updCtx();
      const s = updater.loadSettings(settingsCtx);
      if (!s.balancePrices || typeof s.balancePrices !== 'object') s.balancePrices = {};
      s.balancePrices[m] = cleaned;
      updater.saveSettings(settingsCtx, s);
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:balance-prices-reset', async (event, { model } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'unauthorized' };
    const m = String(model || '');
    try {
      const settingsCtx = updCtx();
      const s = updater.loadSettings(settingsCtx);
      if (s.balancePrices && s.balancePrices[m]) {
        delete s.balancePrices[m];
        updater.saveSettings(settingsCtx, s);
      }
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 文件还原（「文件」视图的回退）：按会话日志里已持久化的写前/写后全文，
  // 做精确内容匹配后替换 —— 只有内容一致才动手，天然幂等且安全。
  ipcMain.handle('dsh:file-revert', async (event, { changes } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { results: [] };
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) return { results: [] };
    const results = [];
    for (const c of changes) {
      const p = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(p) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: p, status: 'invalid' });
        continue;
      }
      if (!isUnderFileRoots(p)) {
        results.push({ path: p, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(p);
        const content = exists ? fs.readFileSync(p, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          // 新建 → 删除（内容必须仍是 agent 写入的原文）
          if (content !== null && content === newText) { fs.rmSync(p); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
        } else if (newText === '' && oldText !== '') {
          // 删除 → 恢复（文件必须仍不存在）
          if (content === null) { fs.writeFileSync(p, oldText, 'utf8'); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: 'conflict' });
        } else {
          if (content !== null && content.includes(newText)) {
            fs.writeFileSync(p, content.replace(newText, oldText), 'utf8');
            results.push({ path: p, status: 'reverted' });
          } else if (content !== null && content === oldText) {
            results.push({ path: p, status: 'skipped' });
          } else {
            results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (err) {
        results.push({ path: p, status: 'failed', error: String((err && err.message) || err) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  });

  // 「全部文件」视图的打开请求：用系统默认程序打开项目文件。
  ipcMain.handle('dsh:file-open', async (event, { path: p } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'forbidden' };
    if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'path must be absolute' };
    if (!isUnderFileRoots(p)) return { ok: false, error: 'path outside session workspace' };
    if (DANGEROUS_EXT.test(p)) return { ok: false, error: 'executable files are not openable from the file view' };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: 'file not found' };
      const msg = await shell.openPath(p);
      if (msg) return { ok: false, error: msg };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 预览面板：用系统浏览器打开 http(s) URL。
  ipcMain.handle('dsh:open-external', async (event, { url } = {}) => {
    if (!ctx.mainWindow() || event.sender !== ctx.mainWindow().webContents) return { ok: false, error: 'forbidden' };
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = { registerIpc };

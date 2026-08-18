'use strict';

// 客户端自更新流程（architecture-refactor-plan.md Phase 1：updates 领域，与
// updater.js / client-updater.js / plugin-updater.js 同层）。
//
// 从 main.js 原样迁出：更新 DSH Desktop 封装本身（区别于 agent 更新）。
//   · runClientUpdateFlow —— 检查最新版 → 弹窗征询 → 保护快照 → 多源下载
//     （GitHub ↔ Gitee 备用源自动切换）→ 提示重启安装；支持手动检查与
//     启动后周期静默检查（跳过/稍后版本去重），E2E 自动接受钩子；
//   · offerPendingClientUpdate —— 启动时发现已下载未安装的更新时提示安装。
// Linux 由系统包管理器更新，仅提示。
//
// 依赖注入：quitting / clientUpdateBusy 为 main.js 可变 let，经 getter /
// setter 调用期取值；其余稳定引用按引用传入。

function createClientUpdateFlow(deps) {
  const {
    isWin,
    getQuitting,
    getClientUpdateBusy, setClientUpdateBusy,
    showBox, showUpdateWindow, makeUpdateProgressPusher,
    ensureGuard, restartWithClientUpdate,
    clientUpdater, updater,
    updCtx, loadSettings, saveSettings,
    APP_VERSION, fs, log,
  } = deps;

async function runClientUpdateFlow(manual) {
  if (getQuitting()) return;
  if (!isWin) {
    if (manual) {
      await showBox({
        type: 'info',
        title: '客户端更新',
        message: 'Linux 版本由系统包管理器更新。',
        detail: 'Arch Linux 请下载新的 .pacman 包后运行：\n\nsudo pacman -U ./Deepseek-Harness-EAC-*.pacman',
        buttons: ['确定'],
      });
    }
    return;
  }
  if (getClientUpdateBusy()) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '客户端更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  const ctx = updCtx();
  const settings = loadSettings(ctx);
  let release;
  try {
    release = await clientUpdater.checkLatest(ctx, APP_VERSION);
  } catch (err) {
    log('client-update', '检查失败: ' + err.message);
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查客户端更新失败',
        message: '无法连接上游发布源。',
        detail: err.message + '\n\n可通过环境变量 DSH_DESKTOP_RELEASE_API 指定镜像 API。',
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!release.isNewer) {
    if (manual) {
      await showBox({
        type: 'info',
        title: '检查客户端更新',
        message: '当前已是最新版本。',
        detail: `Deepseek Harness EAC（封装版本 v${APP_VERSION}）\n上游最新：${release.version}（${release.source}）`,
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!manual && settings.skipClientVersion === release.version) return;
  // M7 修复：用户选过"稍后"的同版本不再每 12h 重复弹窗/重复下载。
  if (!manual && settings.pendingClientVersion === release.version) return;
  // E2E 自动化钩子（与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同惯例）：自动接受
  // 「立即更新」，让 scripts/e2e-v4.js 能无人值守跑完整更新链路。默认关闭。
  const autoAcceptUpdate = process.env.DSH_DESKTOP_TEST_AUTO_UPDATE === '1';
  const notes = release.body ? '\n\n更新说明：\n' + release.body.slice(0, 800) : '';
  const { response } = autoAcceptUpdate ? { response: 0 } : await showBox({
    type: 'info',
    title: '发现新版本客户端',
    message: `Deepseek Harness EAC 封装发布了新版本：v${release.version}`,
    detail: `当前版本：v${APP_VERSION}\n发布来源：${release.source}${notes}\n\n是否立即更新？下载后自动替换并重启应用。`,
    buttons: ['立即更新', '跳过此版本', '稍后'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 1) {
    settings.skipClientVersion = release.version;
    saveSettings(ctx, settings);
    log('client-update', '用户跳过版本 ' + release.version);
    return;
  }
  if (response === 2) {
    // M7 修复：记录"稍后"版本，周期检查不再重复打扰（新版本出现时仍会提示）。
    settings.pendingClientVersion = release.version;
    saveSettings(ctx, settings);
    log('client-update', '用户稍后处理版本 ' + release.version);
    return;
  }

  setClientUpdateBusy(true);
  const progressWin = showUpdateWindow(release.version, 'client');
  const progress = makeUpdateProgressPusher(progressWin);
  try {
    // V4.1 更新保障①：客户端更新前同样强制插件/配置快照，失败则中止
    //（下载与安装都不动 profile，但多一道回滚点总比少一道强）。
    if (!ensureGuard().snapshot('pre-update:client:' + release.version)) {
      throw new Error('更新前保护快照失败（profile 不可读），已中止客户端更新。');
    }
    // V4.2：探测其余发布源的同版本 release 作为备用下载源（GitHub ↔ Gitee），
    // 主源多次失败/卡住时自动切换，全程在弹窗内提示。
    const fallbacks = await clientUpdater.releaseFallbacks(ctx, release);
    const speedState = { t: 0, bytes: 0, speed: null };
    const { filePath, size } = await clientUpdater.downloadRelease(ctx, release, {
      fallbacks,
      onSourceChange: (source, idx, urls) => {
        log('client-update', `切换备用下载源（${idx + 1}/${urls.length}）`);
        progress.force({ stage: '下载停滞，已自动切换下载源（' + (idx + 1) + '/' + urls.length + '）…' });
      },
      onProgress: (received, total) => {
        const now = Date.now();
        if (speedState.t && now - speedState.t >= 500) {
          const inst = (received - speedState.bytes) / ((now - speedState.t) / 1000);
          speedState.speed = speedState.speed == null ? inst : speedState.speed * 0.7 + inst * 0.3;
        }
        speedState.t = now;
        speedState.bytes = received;
        const sp = speedState.speed || 0;
        const pct = total > 0 ? Math.round((received * 100) / total) : -1;
        const meta = {};
        if (pct >= 0 && sp > 0 && received < total) {
          meta.speedMBps = sp / 1048576;
          meta.etaSec = (total - received) / sp;
        }
        progress.client(received, total, meta);
      },
    });
    settings.pendingClientUpdate = { version: release.version, path: filePath, source: release.source };
    settings.skipClientVersion = null;
    settings.pendingClientVersion = null;
    saveSettings(ctx, settings);
    const { response: r2 } = autoAcceptUpdate ? { response: 0 } : await showBox({
      type: 'info',
      title: '下载完成',
      message: `已准备好 Deepseek Harness EAC 封装 v${release.version}（${Math.round(size / 1048576)} MB）。`,
      detail: '立即重启应用完成更新？\n· 重启后自动安装新版本并启动\n· 插件、皮肤、会话与配置全部保留（仅替换程序本体）\n· 选择稍后重启：下次启动时再提示安装',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r2 === 0) await restartWithClientUpdate(ctx, settings.pendingClientUpdate);
  } catch (err) {
    log('client-update', '更新失败: ' + err.message);
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成客户端更新，仍使用当前版本。',
      detail: err.message,
      buttons: ['确定'],
    });
  } finally {
    setClientUpdateBusy(false);
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

function offerPendingClientUpdate() {
  if (!isWin) return;
  const ctx = updCtx();
  const settings = loadSettings(ctx);
  const pending = settings.pendingClientUpdate;
  if (!pending || !pending.path) return;
  if (!fs.existsSync(pending.path)) {
    settings.pendingClientUpdate = null;
    saveSettings(ctx, settings);
    return;
  }
  if (updater.compareVersions(pending.version, APP_VERSION) <= 0) {
    settings.pendingClientUpdate = null;
    saveSettings(ctx, settings);
    return;
  }
  showBox({
    type: 'info',
    title: '有待安装的客户端更新',
    message: `已下载 Deepseek Harness EAC 封装 v${pending.version}，是否现在安装并重启？`,
    detail: '安装包保存在数据目录的 updates 文件夹中。\n插件、皮肤、会话与配置全部保留（仅替换程序本体）。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then(async ({ response }) => {
    if (response !== 0) return;
    await restartWithClientUpdate(ctx, pending);
  });
}
  return {
    runClientUpdateFlow,
    offerPendingClientUpdate,
  };
}

module.exports = { createClientUpdateFlow };

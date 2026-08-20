/**
 * lib/boot.ts — 启动编排与失败处理（Task 5.4 自 main.js 提取）。
 *
 * boot()：userData/日志初始化 → IPC/托盘/预览服务注册 → 新老用户判定 →
 * 看门狗/崩溃自回退 → 渲染自恢复装配 → 一次性迁移 → 选择向导 → 插件/技能
 * 同步 → koffi 预检 → 市场排队任务 → 捆绑完整性校验 → 守护启动 Web 服务 →
 * 健康确认/备份清理/会话监听/余额/更新定时器。
 * handleBootFailure()：插件归因停用 → 快照回滚 → 版本回退的多级失败链。
 * fatal()：终态错误对话框。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { app, dialog, clipboard, Menu } from 'electron';
import * as updater from '../updater.js';
import * as structuredLogger from '../logger.js';
import * as bundleIntegrity from '../bundle-integrity.js';
import type { BundleManifest } from '../bundle-integrity.js';
import { SessionWatcher } from '../session-watcher.js';
import { buildErrorDetail } from '../error-detail.js';
import { state } from './state.js';
import { log } from './log.js';
import { updCtx, dshVersion, dshVersionSource } from './proc.js';
import { desktopProfile } from './paths.js';
import {
  writeRunState, markCleanExit, detectUncleanPreviousRun, notifyUncleanRestart,
  autoRollbackClientIfCrashed, cleanupClientBackupIfHealthy, offerBackupCleanupConfirm,
} from './run-state.js';
import { startWatchdog, startJunctionWatchdog } from './watchdog-boot.js';
import { startAndShow, startAndShowGuarded } from './server.js';
import { startPreviewStaticServer } from './preview.js';
import {
  createWindow, initRendererRecovery, startHeartbeatLoop, showBox,
} from './window.js';
import { createTray } from './tray.js';
import { ensureGuard } from './guard.js';
import { applyKoffiPreflightAsync } from './preflight.js';
import {
  computeOnboardingNeed, runPluginOnboardingIfNeeded,
} from './onboarding.js';
import {
  syncCompanionPlugins, syncBundledSkills, healProfileModules, restoreKeptArtifacts,
} from './plugins.js';
import { processPendingMarketOps } from './market-ops.js';
import { migrateFromSharedWebProfile, warnTempRun } from './migration.js';
import { maintainShortcuts } from './shortcuts.js';
import { startBalanceLoop, onSessionTurnEnd } from './balance-ui.js';
import {
  pluginManagerCollect, pluginManagerSetEnabled,
} from './plugin-manager-core.js';
import {
  runUpdateFlow, runPluginUpdateCheck, runClientUpdateFlow,
  offerPendingClientUpdate, scheduleClientUpdateRescue,
} from './update-flow.js';
import { registerIpc } from './ipc/index.js';
import {
  openRecoveryCenter, archivePluginProfiles,
} from './recovery-center/register.js';
import { recordStartFailure } from './supervisor/registry.js';
import {
  getExtensionHostManager, startEnabledExtensionHosts, ensureBundledSdkPlugins,
} from './extension-host/manager.js';
import { startExtensionBridgeServer } from './extension-host/bridge-server.js';

/** 更新定时器间隔：agent 6 小时 / 插件 6 小时 / 客户端 12 小时。 */
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 失败处理链
// ---------------------------------------------------------------------------

/**
 * 启动失败多级处置链：插件归因停用 → 保护中心快照回滚 → 客户端版本回退
 * （每级之间重新尝试启动；全部失败才停留在此界面）。供 boot 的 catch 与
 * bridge（server 守护启动失败重试）共用。
 */
export function handleBootFailure(err: unknown): void {
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) {
    // V4.1 更新保障②：上次更新保留的上一版本备份可用时，优先提供
    // 「回退到上一版本」（比退回内置版更贴近用户原状态）。
    const prev = updater.previousAgentInfo(updCtx());
    // V4.2 插件即时提醒：报错文案归因到 profile 里的插件时，提供
    // 「停用插件 X 并重试」（写盘停用，重启不还原）；另有最后良好快照时
    // 提供「回滚到最后良好快照并重试」。两项都失败才轮到版本级回退。
    let blame: { name: string; rowId: string | null; kind: string } | null = null;
    let blameRow: { id: string; name: string; toggleable?: boolean } | null = null;
    try {
      const g = ensureGuard();
      if (typeof g.attributeBootFailure === 'function') {
        blame = g.attributeBootFailure(String((err as Error)?.message || err));
      }
      if (blame) {
        try {
          blameRow =
            (pluginManagerCollect() as { id: string; name: string; toggleable?: boolean }[])
              .find((r) => r.id === blame?.rowId) ?? null;
        } catch {
          blameRow = null;
        }
        // Phase 0.3：启动失败归因落扩展注册表（恢复中心展示 + Agent 诊断）。
        if (blame.rowId) recordStartFailure(blame.rowId, String((err as Error)?.message || err));
      }
    } catch {
      /* 归因失败走通用按钮链 */
    }
    const lastGood = (() => {
      try {
        return ensureGuard().lastGoodSnapshot();
      } catch {
        return null;
      }
    })();
    const btnDisable = blameRow && blameRow.toggleable ? '停用插件 ' + blameRow.name + ' 并重试' : null;
    const btnRollback = lastGood ? '回滚到最后良好快照并重试' : null;
    const buttons = [
      // VNext Phase 0：启动失败必定可达恢复中心（架构文档 §9 交付标准）。
      '打开恢复中心',
      ...(btnDisable ? [btnDisable] : []),
      ...(btnRollback ? [btnRollback] : []),
      ...(prev
        ? ['回退到上一版本并重试', '回退到内置版本', '重试', '退出']
        : ['回退到内置版本并重试', '重试', '退出']),
    ];
    const detailLines = [String((err as Error)?.message || err)];
    if (blame) {
      detailLines.push('', `报错指向插件「${blame.name}」（${blame.kind === 'patchRow' ? 'patch 行 ' + blame.rowId : blame.kind}），可先停用该插件后重试。`);
    }
    if (lastGood) {
      detailLines.push(`存在最后良好快照（${lastGood.reason || lastGood.id}），可一键回滚后重试。`);
    }
    if (prev) detailLines.push('', `可回退到上一版本（v${prev.version}）或内置版本继续使用。`);
    else detailLines.push('', '可回退到内置版本继续使用。');
    void showBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: prev ? '更新后的 agent 无法启动。' : 'DeepSeek Harness 无法启动。',
      detail: detailLines.join('\n'),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    }).then(({ response }) => {
      let i = 0;
      const take = (): number => i++;
      // 恢复中心优先：停用/回滚/重试在中心里都有，且能看档案与日志。
      if (response === take()) {
        openRecoveryCenter();
        return;
      }
      // 归因到插件时，优先给「停用插件」——
      if (btnDisable && blameRow && response === take()) {
        try {
          pluginManagerSetEnabled(blameRow.id, false);
          log('plugin-manager', `启动失败后停用插件: ${blameRow.id}`);
        } catch (e2) {
          log('plugin-manager', '停用插件失败: ' + String((e2 as Error).message));
        }
        void startAndShow().catch((e2) => handleBootFailure(e2));
        return;
      }
      if (btnRollback && lastGood && response === take()) {
        try {
          ensureGuard().restore(lastGood.id);
        } catch (e2) {
          log('guard', '回滚快照失败: ' + String((e2 as Error).message));
        }
        void startAndShow().catch((e2) => handleBootFailure(e2));
        return;
      }
      if (prev && response === take()) {
        updater.rollbackToPrevious(updCtx());
        void startAndShow().catch((e2) => fatal('Deepseek Harness 启动失败', e2));
      } else if ((prev && response === take()) || (!prev && response === take())) {
        updater.rollback(updCtx());
        void startAndShow().catch((e2) => fatal('Deepseek Harness 启动失败', e2));
      } else if ((prev && response === take()) || (!prev && response === take())) {
        void startAndShow().catch((e2) => handleBootFailure(e2));
      } else {
        app.quit();
      }
    });
  } else {
    fatal('Deepseek Harness 启动失败', err);
  }
  // dsh web 起不来（如 v3.0.0 schemastery 闭包缺陷）的用户永远走不到
  // 成功链上的自动更新定时器，只能手动重装。主动查一次客户端更新，
  // manual=true 绕过 skip/稍后 抑制，让修复版本能下载并自愈。
  scheduleClientUpdateRescue();
}

/**
 * 终态致命错误弹窗（boot 链与恢复流程的兜底出口）：附错误详情构建器产出的
 * 诊断文本；按钮含「打开恢复中心」（不依赖 Web UI/主窗，仍可处置插件）、
 * 「复制日志」；有主窗时多一个「重试」（重走 startAndShow）。退出路径均
 * markCleanExit，避免看门狗把已知坏安装反复拉起。
 */
export function fatal(title: string, err: unknown): void {
  log('fatal', title + ': ' + String((err as Error)?.stack || (err as Error)?.message || err));
  const detail = buildErrorDetail(err, state.logsDir, ['dsh-web.log', 'desktop.log']);
  if (!state.mainWindow || state.mainWindow.isDestroyed()) {
    void dialog
      .showMessageBox({
        type: 'error',
        title,
        message: title,
        detail,
        buttons: ['打开恢复中心', '复制日志', '退出'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) {
          // 恢复中心不依赖 Web UI/主窗 —— 终态失败下仍可处置插件。
          openRecoveryCenter();
          return;
        }
        if (response === 1) clipboard.writeText(detail);
        markCleanExit(); // 启动失败属已知退出：避免看门狗反复拉起反复失败
        app.exit(1);
      });
    return;
  }
  void showBox({
    type: 'error',
    title,
    message: title,
    detail,
    buttons: ['打开恢复中心', '复制日志', '重试', '退出'],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  }).then(({ response }) => {
    if (response === 0) {
      openRecoveryCenter();
      return;
    }
    if (response === 1) clipboard.writeText(detail);
    else if (response === 2) void startAndShow().catch((err2) => handleBootFailure(err2));
    else app.quit();
  });
}

// Issue #7: verify the bundled node_modules against the build-time manifest
// before starting dsh web. A botched upgrade leaves empty package skeletons;
// Node then dies with ERR_MODULE_NOT_FOUND in a loop. Tell the user to
// reinstall instead (with an escape hatch to continue anyway).
export function verifyBundledModules(): Promise<void> {
  if (!app.isPackaged) return Promise.resolve();
  const appDir = path.join(process.resourcesPath, 'app');
  const manifestPath = path.join(appDir, 'bundle-manifest.json');
  let manifest: BundleManifest | null = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BundleManifest;
  } catch {
    return Promise.resolve();
  }
  const r = bundleIntegrity.verifyBundle(path.join(appDir, 'node_modules'), manifest);
  if (r.skipped || r.ok) return Promise.resolve();
  const sample = r.damaged.slice(0, 5).map((d) => `${d.name}（${d.reason}）`).join('、');
  log('boot', `捆绑依赖完整性校验失败（${r.damaged.length} 个包受损）: ${sample}${r.damaged.length > 5 ? ' 等' : ''}`);
  return showBox({
    type: 'error',
    title: '程序文件受损',
    message: `检测到 ${r.damaged.length} 个捆绑依赖包文件缺失，可能是升级中断或安全软件清理所致。`,
    detail: `受损包: ${sample}${r.damaged.length > 5 ? `（共 ${r.damaged.length} 个）` : ''}\n\n建议重新下载安装包覆盖安装（GitHub Releases 最新版）。\n选择「仍然启动」大概率无法正常运行。`,
    buttons: ['仍然启动', '退出'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response !== 0) {
      state.forceQuit = true;
      markCleanExit(); // 用户选择退出：不让看门狗拉起一个已知损坏的安装
      app.exit(1);
    }
  });
}

// ---------------------------------------------------------------------------
// 启动编排
// ---------------------------------------------------------------------------

/**
 * 应用启动编排主流程（详见文件头）。任何一步抛错都走 handleBootFailure
 * 的多级失败链；窗口就绪后的定时器/监听器全部非阻塞（void/nextTick），
 * 不阻塞「启动就绪」的到达。
 */
export async function boot(): Promise<void> {
  // Portable builds keep all data next to the exe.
  if (!app.isPackaged && process.env.DSH_DESKTOP_USERDATA) {
    app.setPath('userData', process.env.DSH_DESKTOP_USERDATA);
  } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
  }

  state.userDataDir = app.getPath('userData');
  state.logsDir = path.join(state.userDataDir, 'logs');
  // DSH_HOME: respect an explicit override; otherwise let dsh use its own
  // default (~/.dsh), so the desktop app shares config/sessions with the CLI.
  state.dshHome = process.env.DSH_HOME || '';
  fs.mkdirSync(state.logsDir, { recursive: true });
  if (state.dshHome) fs.mkdirSync(state.dshHome, { recursive: true });
  // 日志系统（AC-1：先 init，后 log() 调用，保证结构化 boot 行落到 main.00）
  try {
    structuredLogger.init({
      logsDir: state.logsDir,
      level: process.env.DSH_LOG_LEVEL || (app.isPackaged ? 'info' : 'debug'),
      appVersion: app.getVersion(),
      env: app.isPackaged ? 'production' : 'development',
    });
  } catch (e) {
    // 日志系统初始化失败不影响启动（仍然写 desktop.log）。
    try {
      console.error('[logger.init fail]', (e as Error).message);
    } catch {
      /* console 不可用则静默 */
    }
  }
  state.desktopLog = fs.createWriteStream(path.join(state.logsDir, 'desktop.log'), { flags: 'a' });
  log('boot', `Deepseek Harness EAC（封装 ${app.getVersion()}）  userData=${state.userDataDir}  dshHome=${state.dshHome || '(dsh 默认)'}  agent=${dshVersion()}(${dshVersionSource()})`);

  // 移除原生菜单栏（文件/视图/帮助），全部功能由自绘 chrome 与托盘提供。
  Menu.setApplicationMenu(null);
  startPreviewStaticServer();
  registerIpc();
  createTray();
  // VNext Phase 0 入口③：DSH_DESKTOP_RECOVERY=1 直开恢复中心（跳过常规
  // boot 链 —— 不迁移、不同步插件、不拉 Web 服务；处置完成后可在中心内
  // 重试启动或安全模式重启）。
  if (process.env.DSH_DESKTOP_RECOVERY === '1') {
    log('boot', '恢复中心直达模式（DSH_DESKTOP_RECOVERY=1），跳过常规启动链');
    openRecoveryCenter();
    return;
  }
  // 新老用户判定必须在任何写盘之前：run-state / migrate 标记 / 稳定端口
  // 都会在启动早期创建 settings.json，事后无法区分全新安装与升级。
  const onboardingNeeded = computeOnboardingNeed();
  // 看门狗 + 运行状态标记（安装版）：意外崩溃后自动拉起并告知用户。
  writeRunState();
  startWatchdog();
  const uncleanPrev = detectUncleanPreviousRun();
  // V4.1 更新保障③：便携版客户端更新后若新版崩溃（非干净退出 + 上一版
  // 备份 marker 仍在），先用上一版还原再继续启动，随后再告知用户。
  autoRollbackClientIfCrashed(uncleanPrev);
  if (uncleanPrev) notifyUncleanRestart(uncleanPrev);
  // 渲染进程崩溃/挂起自恢复状态机：必须在 createWindow 之前装配。
  initRendererRecovery();
  startHeartbeatLoop();
  // 一次性迁移：从共享 web profile 切到桌面专属 profile（与原生 CLI 共存）。
  migrateFromSharedWebProfile();
  // 首次启动内置插件选择向导：仅全新用户展示（升级用户静默跳过）。提交的
  // 选择在 onboard:submit 里已写入 patch（disabled/裸条目），此后 sync 的
  // 「已有行不重写」规则天然保留用户选择。
  await runPluginOnboardingIfNeeded(onboardingNeeded);
  syncCompanionPlugins();
  syncBundledSkills();
  healProfileModules();
  // VNext Phase 0.3：插件档案（来源/风险等级/失败归因）落扩展注册表。
  archivePluginProfiles();
  createWindow();
  // koffi FFI 预检（koffi-preflight.js，V4 改异步：同步 spawnSync 会把主
  // 进程事件循环卡住最长 20 秒）：失败则注入目录选择器降级 overlay，
  // 由 startAndShow 以 --patch 交给 dsh web。必须在 startAndShow 之前完成。
  // junction 归属守卫：原生 dsh 会把共享模块指到它自己的闭包，这里先纠偏
  // 一次，并启动周期巡检（原生进程退出后自动恢复指向）。
  applyKoffiPreflightAsync()
    .then(() => {
      ensureGuard().repairJunctions();
      startJunctionWatchdog();
    })
    // 插件市场排队任务（服务运行中撞文件锁转待重启的安装/卸载）：趁服务
    // 尚未启动、无文件锁时先完成，再拉起 Web 服务。
    .then(() => processPendingMarketOps())
    .then(async () => {
      // 排队的 pnpm 操作可能刚重写 profile node_modules（删掉配套插件副本、
      // hoist 核心包形成双实例）—— 服务启动前重建副本并清理遮蔽，
      // 保证加载的始终是内置分发版本。
      syncCompanionPlugins();
      syncBundledSkills();
      healProfileModules();
      // V4 兜底：上次 pnpm 后异常退出没回填的第三方构建产物（meow-memory
      // 的 lib/ 等）在这里补上（processPendingMarketOps 正常路径已含回填，
      // 这里覆盖崩溃/强杀场景；无缓存时为空操作）。
      await restoreKeptArtifacts(desktopProfile());
    })
    .then(() => verifyBundledModules())
    .then(async () => {
      // VNext Phase 2：Core Bridge 回环端点必须在 dsh web 拉起之前就绪
      // （childEnv 会把 URL/token 注入其子进程环境；失败不阻断核心启动，
      // 仅隔离插件工具不可用）。
      try {
        state.eacBridge = await startExtensionBridgeServer(getExtensionHostManager());
      } catch (err) {
        log('ext-host', 'Core Bridge 端点启动失败（隔离插件工具不可用）: ' + String((err as Error).message));
      }
    })
    .then(() => startAndShowGuarded())
    .then(() => {
      // V4.1 更新保障②/③：新版健康启动 —— 清理官方 dsh 上一版本备份与
      // 便携版客户端旧 exe 备份（崩溃自回退的保险丝就此解除）。
      updater.confirmPreviousAgentHealthy(updCtx());
      cleanupClientBackupIfHealthy();
      // VNext Phase 2：核心 Web 服务健康后安装随包示例插件并并行拉起全部
      // 启用的 SDK 插件 Host（进程隔离 + Job 围栏；失败不影响核心）。
      ensureBundledSdkPlugins();
      void startEnabledExtensionHosts();
      // V4.3 PR（独有价值）：客户端更新成功后 24h 内非阻塞询问是否清理 4 目录备份
      // （超 24h 自动登记 pendingBackupCleanup；确认删时保留 manifest.json 诊断副本）。
      offerBackupCleanupConfirm();
      // Session-completion notifications: watch dsh session logs under the
      // effective DSH_HOME (same config the CLI uses).
      const s = updater.loadSettings(updCtx());
      state.notifyOnTurnEnd = s.notifyOnTurnEnd !== false;
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      state.sessionWatcher = new SessionWatcher({
        sessionsDir: path.join(home, 'sessions'),
        log,
        onTurnEnd: (info) => {
          onSessionTurnEnd(info);
          // VNext Phase 2：回合结束广播给全部隔离插件（SDK ctx.on('turn-end')）。
          try {
            getExtensionHostManager().broadcastEvent('turn-end', info);
          } catch {
            /* 无宿主时忽略 */
          }
        },
      });
      state.sessionWatcher.start();
      maintainShortcuts();
      warnTempRun();
      startBalanceLoop();
      offerPendingClientUpdate();

      if (!process.env.DSH_DESKTOP_SKIP_AUTO_UPDATE) {
        // dsh agent 更新：启动 15 秒后 + 每 6 小时。
        setTimeout(() => void runUpdateFlow(false), 15000).unref();
        setInterval(() => void runUpdateFlow(false), AUTO_UPDATE_INTERVAL_MS).unref();
      }
      if (!process.env.DSH_DESKTOP_SKIP_CLIENT_UPDATE) {
        // 客户端（封装）更新：启动 60 秒后 + 每 12 小时。
        setTimeout(() => void runClientUpdateFlow(false), 60000).unref();
        setInterval(() => void runClientUpdateFlow(false), 12 * 3600 * 1000).unref();
      }
      if (!process.env.DSH_DESKTOP_SKIP_PLUGIN_UPDATE) {
        // 内置插件上游更新检查：启动 20 秒后 + 每 6 小时（24h 落盘节流
        // 在 runPluginUpdateCheck 内；默认仅提示，见 plugin-updater.js）。
        setTimeout(() => void runPluginUpdateCheck(false), 20000).unref();
        setInterval(() => void runPluginUpdateCheck(false), 6 * 3600 * 1000).unref();
      }
    })
    .catch((err) => handleBootFailure(err));
}

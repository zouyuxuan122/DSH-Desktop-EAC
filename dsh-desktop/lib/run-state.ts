/**
 * lib/run-state.ts — 运行状态标记与客户端更新崩溃自回退（Task 2.1 自 main.js 提取）。
 *
 * 三个子域（均为启动/退出链路，逻辑逐行等价迁移）：
 *   1) run-state.json：主进程写心跳式运行状态，watchdog.js（独立进程）轮询
 *      父 PID 判定「意外崩溃 → 拉起应用」；
 *   2) 客户端更新崩溃自回退（V4.1 更新保障③）：便携版更新脚本保留上一版
 *      exe（.bak + marker），新版崩溃则下次启动自动还原；
 *   3) 更新成功后的 24h 内非阻塞备份清理确认（V4.3）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, dialog, Notification } from 'electron';
import * as updater from '../updater.js';
import { state } from './state.js';
import { log } from './log.js';
import { IS_WIN, updCtx } from './proc.js';
import { bridge } from './bridge.js';

/** run-state.json 路径（userData 目录）。 */
export function runStatePath(): string {
  return path.join(state.userDataDir, 'run-state.json');
}

/** 写运行状态（pid/exe/版本/启动时间；cleanExit 默认 false）。 */
export function writeRunState(extra: Record<string, unknown> = {}): void {
  try {
    fs.writeFileSync(
      runStatePath(),
      JSON.stringify({
        pid: process.pid,
        exe: process.execPath,
        cleanExit: false,
        startedAt: new Date().toISOString(),
        version: app.getVersion(),
        ...extra,
      }),
    );
  } catch (err) {
    log('watchdog', '写运行状态失败: ' + String((err as Error).message));
  }
}

/** 退出前标记 cleanExit=true（看门狗据此安静退出，不拉起新实例）。 */
export function markCleanExit(): void {
  try {
    const p = runStatePath();
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    } catch {
      /* 首次或损坏：用空对象 */
    }
    prev.cleanExit = true;
    prev.endedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(prev));
  } catch (err) {
    log('watchdog', '写退出标记失败: ' + String((err as Error).message));
  }
}

/** 检测上次运行是否未正常退出（返回上次的 run-state，干净则 null）。 */
export function detectUncleanPreviousRun(): Record<string, unknown> | null {
  try {
    const prev = JSON.parse(fs.readFileSync(runStatePath(), 'utf8')) as Record<string, unknown>;
    if (prev && prev.cleanExit !== true && prev.pid && Number(prev.pid) !== process.pid) {
      log('crash', '检测到上次运行未正常退出: ' + JSON.stringify(prev));
      return prev;
    }
  } catch {
    /* 无文件 = 首次运行 */
  }
  return null;
}

/** 崩溃自动恢复后的系统通知（点击聚焦主窗）。 */
export function notifyUncleanRestart(prev: Record<string, unknown>): void {
  try {
    const started =
      typeof prev.startedAt === 'string' && prev.startedAt ? new Date(prev.startedAt) : null;
    const when =
      started && !Number.isNaN(started.getTime())
        ? started.toLocaleString('zh-CN', { hour12: false })
        : '上次';
    const n = new Notification({
      title: 'Deepseek Harness EAC 已自动恢复',
      body: `检测到应用在 ${when} 前后未正常退出，看门狗已重新启动应用。`,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    });
    n.on('click', () => bridge.showMainWindow());
    n.show();
  } catch (err) {
    log('crash', '恢复通知发送失败: ' + String((err as Error).message));
  }
}

// ---------------------------------------------------------------------------
// 客户端更新崩溃自回退（V4.1 更新保障③）：便携版更新脚本在成功替换后保留
// 上一版 exe（%EXE%.bak）并写 marker；新版若崩溃（上次运行非干净退出且
// marker 仍在 —— marker 只在健康启动成功链上被清），下次启动自动用上一版
// 还原。崩溃副本留作诊断，另发系统通知告知。
// ---------------------------------------------------------------------------

/** 便携版更新备份三件套路径（非便携版返回 null）。 */
export function clientBackupPaths(): { exe: string; bak: string; marker: string } | null {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!exe) return null;
  return { exe, bak: exe + '.bak', marker: exe + '.bak.marker' };
}

/** 检测到上次运行崩溃且存在更新备份 → 自动回退到上一版 exe。 */
export function autoRollbackClientIfCrashed(prevUnclean: Record<string, unknown> | null): boolean {
  const p = clientBackupPaths();
  if (!p || !prevUnclean) return false;
  if (!fs.existsSync(p.bak) || !fs.existsSync(p.marker)) return false;
  try {
    fs.copyFileSync(p.exe, p.exe + '.crash-' + Date.now());
    fs.copyFileSync(p.bak, p.exe);
    fs.rmSync(p.marker, { force: true });
    log('client-update', '检测到客户端更新后启动失败，已自动回退到上一版本');
    try {
      const n = new Notification({
        title: 'Deepseek Harness EAC 已自动回退',
        body: '更新后的版本启动失败，已自动回退到上一版本并保留崩溃副本。',
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      });
      n.on('click', () => bridge.showMainWindow());
      n.show();
    } catch (err) {
      log('client-update', '回退通知发送失败: ' + String((err as Error).message));
    }
    return true;
  } catch (err) {
    log('client-update', '自动回退失败: ' + String((err as Error).message));
    return false;
  }
}

/** 新版健康启动（boot 成功链）后调用：清理上一版备份与 marker。 */
export function cleanupClientBackupIfHealthy(): void {
  const p = clientBackupPaths();
  if (!p || !fs.existsSync(p.marker)) return;
  try {
    fs.rmSync(p.bak, { force: true });
    fs.rmSync(p.marker, { force: true });
    log('client-update', '新版启动确认健康，已清理上一版备份');
  } catch (err) {
    log('client-update', '清理上一版备份失败: ' + String((err as Error).message));
  }
}

// V4.3 PR（独有价值，review 保留项）：客户端更新成功后 24h 内非阻塞询问
// 是否清理 4 目录 robocopy 备份。超 24h 不自动弹（避免打扰）；用户取消则写
// pendingBackupCleanup 进 settings，设置页可手动清理；确认则递归删除备份
// 目录，但保留 manifest.json 诊断副本到 backups/<ts>.manifest.json 。
//
// Review 特别提示：offerBackupCleanupConfirm 曾留有一个「空操作 setTimeout」
// 死代码，本实现明确不引入无副作用定时器，避免 review 打回。
export function offerBackupCleanupConfirm(): void {
  if (!IS_WIN) return;
  const marker = path.join(state.userDataDir, 'updates', '.backup-ts');
  if (!fs.existsSync(marker)) return;
  let ts = '';
  try {
    ts = String(fs.readFileSync(marker, 'utf8')).trim();
  } catch {
    ts = '';
  }
  if (!ts) {
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      /* 忽略 */
    }
    return;
  }
  // 24h 窗口：超期不弹（marker 先保留，settings 里可看到并清理）。
  const tsNum = Number(ts);
  const ageSec = Number.isFinite(tsNum) && tsNum > 1e9 ? Math.floor(Date.now() / 1000) - tsNum : 0;
  if (ageSec > 24 * 3600) {
    log(
      'client-update',
      `备份 ${ts} 已超 24h（${Math.floor(ageSec / 3600)}h），跳过自动清理确认（可在设置页手动清理）`,
    );
    try {
      const c = updCtx();
      const s = updater.loadSettings(c);
      s.pendingBackupCleanup = ts;
      updater.saveSettings(c, s);
    } catch {
      /* settings 写失败不打扰 */
    }
    return;
  }
  // 删除 marker（无论用户确认/取消，本提示只弹一次）
  try {
    fs.rmSync(marker, { force: true });
  } catch {
    /* 忽略 */
  }
  // 非阻塞异步（不阻塞 mainWindow 显示）；dialog.showMessageBox 返回 Promise
  // （Electron 下主进程调用即异步，回调中处理用户选择）。
  const ageInfo =
    ageSec > 0
      ? `（已保留 ${Math.floor(ageSec / 3600)} 小时 ${Math.floor((ageSec % 3600) / 60)} 分钟）`
      : '';
  // 等主窗口就绪后再弹，避免在启动早期抢焦点
  const fire = (): void => {
    const opts = {
      type: 'question' as const,
      title: '更新成功',
      message: '客户端更新成功，是否删除更新前的备份？',
      detail: `备份包含用户目录、安装目录等 4 个目录${ageInfo}；保留可随时在「设置 - 存储管理」手动清理。`,
      buttons: ['保留备份', '删除备份'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    // Electron 类型重载不收 undefined；无主窗时走无父窗重载（运行时语义一致）。
    const p = state.mainWindow
      ? dialog.showMessageBox(state.mainWindow, opts)
      : dialog.showMessageBox(opts);
    p
      .then(({ response }) => {
        const backupDir = path.join(state.userDataDir, 'backups', ts);
        if (response === 1) {
          // 1 = 删除备份：保留 manifest 诊断副本，递归删目录
          try {
            const srcManifest = path.join(backupDir, 'manifest.json');
            const dstManifest = path.join(state.userDataDir, 'backups', `${ts}.manifest.json`);
            if (fs.existsSync(srcManifest)) {
              try {
                fs.copyFileSync(srcManifest, dstManifest);
              } catch (err) {
                log('client-update', '备份 manifest 诊断副本保留失败: ' + String((err as Error).message));
              }
            }
            if (fs.existsSync(backupDir))
              fs.rmSync(backupDir, { recursive: true, force: true, maxRetries: 3 });
            log('client-update', `已清理备份 ${ts}（保留诊断副本）`);
            try {
              const n = new Notification({
                title: '备份已清理',
                body: '更新前的备份已删除，诊断清单保留在 backups 目录下。',
                icon: path.join(__dirname, '..', 'assets', 'icon.png'),
              });
              n.on('click', () => bridge.showMainWindow());
              n.show();
            } catch {
              /* 通知失败不影响清理结果 */
            }
          } catch (err) {
            log('client-update', `清理备份 ${ts} 失败: ` + String((err as Error).message));
          }
        } else {
          // 0 = 保留：写 pendingBackupCleanup 进 settings
          try {
            const c = updCtx();
            const s = updater.loadSettings(c);
            s.pendingBackupCleanup = ts;
            updater.saveSettings(c, s);
            log('client-update', `已登记保留备份 ${ts}，设置页可手动清理`);
          } catch (err) {
            log('client-update', '写 pendingBackupCleanup 失败: ' + String((err as Error).message));
          }
        }
      })
      .catch((err) => {
        log('client-update', '备份确认对话框失败: ' + String((err as Error).message));
      });
  };
  if (state.mainWindow && state.mainWindow.isVisible()) {
    fire();
  } else {
    // 若主窗口尚未 ready，等 once('ready-to-show') 再弹
    const onceReady = (): void => {
      fire();
      if (state.mainWindow) state.mainWindow.removeListener('ready-to-show', onceReady);
    };
    if (state.mainWindow) state.mainWindow.once('ready-to-show', onceReady);
  }
}

/**
 * lib/ipc/plugin.ts — 插件域 IPC（Task 4 自 registerChromeIpc 拆分）。
 *
 * guard:action（插件保护中心）/ dsh:plugin-list / dsh:plugin-set-enabled /
 * dsh:plugin-set-removed（移除/恢复）/ dsh:plugin-updates / dsh:plugin-update /
 * dsh:plugin-auto-update（上游更新）/ dsh:image-paste-save（图片粘贴）。
 */

import { ipcMain } from 'electron';
import * as updater from '../../updater.js';
import * as pluginUpdater from '../../plugin-updater.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { updCtx } from '../proc.js';
import { desktopProfile, desktopProfileDir } from '../paths.js';
import { ensureGuard } from '../guard.js';
import { pluginUpdateSources } from '../plugin-registry-data.js';
import { copyPluginPackage } from '../plugin-copy.js';
import {
  pluginManagerCollect, pluginManagerSetEnabled, pluginManagerSetRemoved,
  removedPluginIds, imagePasteSave,
} from '../plugin-manager-core.js';
import { fromMainWindow } from './sender.js';

/** 管理页插件行的最小形状（toggleable 校验用）。 */
interface PluginRow {
  id: string;
  toggleable?: boolean;
}

/** 注册插件域全部 channel（清单见文件头；boot 时经 lib/ipc/index.ts 统一调用）。 */
export function registerPluginIpc(): void {
  // 插件保护中心（plugin-guard.js）：快照 / 回滚 / 体检 / 修复 / 事故报告。
  // 设置页「插件保护」分区（dsh-plugin-shield 插件）从这里取数与触发动作。
  ipcMain.handle('guard:action', async (event, { action, value } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    const g = ensureGuard();
    switch (action) {
      case 'status': {
        const st = (() => {
          try {
            return updater.loadSettings(updCtx());
          } catch {
            return {};
          }
        })();
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
        if (state.serverProc && !state.restartingServer) {
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
    if (!fromMainWindow(event)) return [];
    return pluginManagerCollect();
  });

  ipcMain.handle('dsh:plugin-set-enabled', async (event, { id, enabled } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    const row = (pluginManagerCollect() as PluginRow[]).find((r) => r.id === id);
    if (!row) return { ok: false, error: '未知插件: ' + String(id) };
    if (!row.toggleable) return { ok: false, error: '该插件不可关闭: ' + String(id) };
    try {
      const res = pluginManagerSetEnabled(String(id), !!enabled);
      if (!res.ok) return res;
      log('plugin-manager', '已' + (enabled ? '启用' : '关闭') + '插件 ' + String(id));
      return { ok: true, restartRequired: true };
    } catch (err) {
      log('plugin-manager', '设置插件 ' + String(id) + ' 失败: ' + String((err as Error).message));
      return { ok: false, error: String((err as Error).message) };
    }
  });

  // 内置插件移除/恢复（V4.2）：移除 = 卸载语义（清 patch 行 + 删包副本 +
  // 记入 settings.removedPlugins 跳过下次 sync）；恢复 = 清跳过清单 + 立即
  // 复制包与行。两者都需重启 Web 服务生效。
  ipcMain.handle('dsh:plugin-set-removed', async (event, { id, removed } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    try {
      const res = pluginManagerSetRemoved(String(id), !!removed);
      return res.ok ? { ok: true, restartRequired: true } : res;
    } catch (err) {
      log('plugin-manager', '移除/恢复插件 ' + String(id) + ' 失败: ' + String((err as Error).message));
      return { ok: false, error: String((err as Error).message) };
    }
  });

  // 插件更新（V4.3，设置页「插件 → 更新」标签，dsh-plugin-marketplace 插件
  // 消费）：内置插件上游更新 —— 检测清单 / 手动更新单个 / 自动更新开关。
  // 数据与动作都在主进程完成（npm 镜像链 + 覆盖层），Web 端只做展示。
  ipcMain.handle('dsh:plugin-updates', async (event, { force = false } = {}) => {
    if (!fromMainWindow(event)) return null;
    try {
      const ctx = updCtx();
      const list = await pluginUpdater.checkPluginUpdates(
        ctx,
        pluginUpdateSources(removedPluginIds()),
        { force: !!force, profileDirP: desktopProfileDir() },
      );
      return {
        list,
        autoUpdate: pluginUpdater.isAutoUpdateEnabled(ctx),
        checkedAt: updater.loadSettings(ctx).pluginUpdateCheckedAt || null,
      };
    } catch (err) {
      log('plugin-update', '插件更新清单加载失败: ' + String((err as Error).message));
      return { list: [], autoUpdate: false, error: String((err as Error).message) };
    }
  });

  ipcMain.handle('dsh:plugin-update', async (event, { id } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    const source = pluginUpdateSources(removedPluginIds()).find((s) => s.id === String(id));
    if (!source) return { ok: false, error: '未知或不可更新的内置插件: ' + String(id) };
    try {
      const res = await pluginUpdater.applyBuiltinPluginUpdate(updCtx(), source, {
        profileDirP: desktopProfileDir(),
        guard: ensureGuard(),
        copyIntoProfile: (overlayDir: string, name: string) =>
          copyPluginPackage(desktopProfileDir(), overlayDir, name),
      });
      if (!res.ok) return res;
      if (res.noop) return { ok: true, noop: true, current: res.current, latest: res.latest };
      log('plugin-update', '手动更新内置插件 ' + String(id) + ' → ' + res.latest + (res.restartRequired ? '（重启服务生效）' : ''));
      return { ok: true, version: res.latest, restartRequired: res.restartRequired };
    } catch (err) {
      log('plugin-update', '更新插件 ' + String(id) + ' 失败: ' + String((err as Error).message));
      return { ok: false, error: String((err as Error).message) };
    }
  });

  ipcMain.handle('dsh:plugin-auto-update', async (event, { enabled } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    try {
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      s.pluginAutoUpdate = !!enabled;
      updater.saveSettings(ctx, s);
      log('plugin-update', '内置插件自动更新已' + (enabled ? '开启' : '关闭'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  // 图片粘贴（V4.2，dsh-image-paste 插件）：把剪贴板图片存到临时目录供
  // agent 的 inspect_image 读取。只接受 image/* 的 data URL，限 15MB，
  // 文件名清洗（防路径穿越），写入路径固定为 %TEMP%/dsh-paste/。
  ipcMain.handle('dsh:image-paste-save', async (event, { dataUrl, name } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    try {
      const res = imagePasteSave(String(dataUrl || ''), String(name || '粘贴图片'));
      if (!res.ok) return res;
      log('plugin-manager', '已保存粘贴图片: ' + String(res.path));
      return res;
    } catch (err) {
      log('plugin-manager', '保存粘贴图片失败: ' + String((err as Error).message));
      return { ok: false, error: String((err as Error).message) };
    }
  });
}

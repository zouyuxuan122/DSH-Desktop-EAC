/**
 * lib/ipc/session.ts — 会话/余额/文件域 IPC（Task 4 自 registerChromeIpc 拆分）。
 *
 * chrome:float-window + float:close（会话浮窗）/ dsh:balance-refresh /
 * dsh:balance-prices-get/set/reset（价格自定义）/ dsh:file-revert（精确
 * 内容回退）/ dsh:file-open（文件视图打开，Skills 根白名单 + 危险扩展名
 * 围栏）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ipcMain, shell } from 'electron';
import * as updater from '../../updater.js';
import * as balance from '../../balance.js';
import { state } from '../state.js';
import { log } from '../log.js';
import { updCtx } from '../proc.js';
import { DANGEROUS_EXT, isUnderFileRoots } from '../paths.js';
import { refreshBalance } from '../balance-ui.js';
import { createFloatWindow, FLOAT_MAX } from '../window.js';
import { fromMainWindow } from './sender.js';

/** 文件还原的单条变更（写前/写后全文精确匹配）。 */
interface RevertChange {
  path?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

/** 单条还原结果。 */
interface RevertResult {
  path: string;
  status: string;
  error?: string;
}

/** 注册会话/余额/文件域全部 channel（清单见文件头；boot 时经 lib/ipc/index.ts 统一调用）。 */
export function registerSessionIpc(): void {
  // 会话浮窗（V4 多窗口）：主窗请求把某个会话弹出到独立窗口（校验来源与
  // 数量上限）；浮窗自己只允许关闭自身。
  ipcMain.handle('chrome:float-window', (event, { action, sessionId } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    if (action !== 'open') return { ok: false, error: 'bad-action' };
    if (!state.webUrl) return { ok: false, error: 'not-ready' };
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'bad-session' };
    // 同一会话只保留一个浮窗：拖出/按钮连续触发或重复请求时，
    // 复用已有窗口而不是再开第二个。
    const existing = state.floatBySession.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true, id: existing.id, reused: true };
    }
    if (existing) state.floatBySession.delete(sessionId);
    if (state.floatWindows.size >= FLOAT_MAX) return { ok: false, error: 'too-many' };
    const win = createFloatWindow(sessionId);
    if (!win) return { ok: false, error: 'too-many' };
    return { ok: true, id: win.id };
  });

  // 浮窗关闭：仅允许浮窗关闭自身（校验发送者属于某个浮窗）。
  ipcMain.on('float:close', (event) => {
    for (const win of state.floatWindows) {
      if (!win.isDestroyed() && win.webContents === event.sender) {
        win.close();
        break;
      }
    }
  });

  ipcMain.handle('dsh:balance-refresh', async (event) => {
    if (!fromMainWindow(event)) return state.balanceCache;
    return refreshBalance();
  });

  // Token 价格自定义（V4.2，dsh-balance 插件「价格设置」页）：读写
  // settings.json 的 balancePrices.<model>.{peak,offpeak}（¥/百万 token，
  // 三字段 cacheMiss/cacheHit/output，必须为 >= 0 的数字）。保存后立即
  // 重推余额数据，dock 的费用估算即时生效。
  ipcMain.handle('dsh:balance-prices-get', async (event, { model } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    const s = updater.loadSettings(updCtx());
    const defaults = balance.DEFAULT_PRICES[String(model ?? '')] ?? balance.FALLBACK_PRICES;
    const prices = s.balancePrices as Record<string, unknown> | undefined;
    const current = (prices && prices[String(model ?? '')]) || null;
    return { ok: true, model: String(model ?? ''), defaults, current };
  });

  ipcMain.handle('dsh:balance-prices-set', async (event, { model, prices } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    const m = String(model ?? '');
    if (!balance.DEFAULT_PRICES[m]) return { ok: false, error: '未知模型: ' + m };
    try {
      const cleaned = balance.sanitizePrices(prices);
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      if (!s.balancePrices || typeof s.balancePrices !== 'object') s.balancePrices = {};
      (s.balancePrices as Record<string, unknown>)[m] = cleaned;
      updater.saveSettings(ctx, s);
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  ipcMain.handle('dsh:balance-prices-reset', async (event, { model } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
    const m = String(model ?? '');
    try {
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      const prices = s.balancePrices as Record<string, unknown> | undefined;
      if (prices && prices[m]) {
        delete prices[m];
        updater.saveSettings(ctx, s);
      }
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  // 文件还原（「文件」视图的回退）：按会话日志里已持久化的写前/写后全文，
  // 做精确内容匹配后替换 —— 只有内容一致才动手，天然幂等且安全。
  ipcMain.handle('dsh:file-revert', async (event, { changes } = {}) => {
    if (!fromMainWindow(event)) return { results: [] };
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300)
      return { results: [] };
    const results: RevertResult[] = [];
    for (const c of changes as RevertChange[]) {
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
          if (content !== null && content === newText) {
            fs.rmSync(p);
            results.push({ path: p, status: 'reverted' });
          } else {
            results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
          }
        } else if (newText === '' && oldText !== '') {
          // 删除 → 恢复（文件必须仍不存在）
          if (content === null) {
            fs.writeFileSync(p, oldText, 'utf8');
            results.push({ path: p, status: 'reverted' });
          } else {
            results.push({ path: p, status: 'conflict' });
          }
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
        results.push({ path: p, status: 'failed', error: String((err as Error).message) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  });

  // 「全部文件」视图的打开请求：用系统默认程序打开项目文件。
  ipcMain.handle('dsh:file-open', async (event, { path: p } = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'forbidden' };
    if (typeof p !== 'string' || !path.isAbsolute(p))
      return { ok: false, error: 'path must be absolute' };
    // Skills 根目录（~/.dsh/skills、~/.agents/skills）不在会话工作区内，但
    // 「设置 → Skills 与 MCP → 打开目录」需要放行；严格限定为两个根本身及其
    // 子路径（白名单，非任意路径），危险扩展名检查仍生效。
    const skillsRoots = [
      path.join(state.dshHome || path.join(os.homedir(), '.dsh'), 'skills'),
      path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'),
    ];
    const underSkillsRoot = skillsRoots.some((r) => {
      const rp = path.resolve(r);
      return p === rp || p.startsWith(rp + path.sep);
    });
    if (!underSkillsRoot && !isUnderFileRoots(p))
      return { ok: false, error: 'path outside session workspace' };
    if (DANGEROUS_EXT.test(p))
      return { ok: false, error: 'executable files are not openable from the file view' };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: 'file not found' };
      const msg = await shell.openPath(p);
      if (msg) return { ok: false, error: msg };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });
}

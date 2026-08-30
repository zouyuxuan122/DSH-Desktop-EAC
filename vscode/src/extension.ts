// src/extension.ts — 插件入口：装配各模块、注册命令、监听配置变更
import * as vscode from 'vscode';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { initI18n, t } from './i18n';
import { readConfig, resolveRepoRoot, type DshConfig } from './config';
import { probeService } from './service/detect';
import { ServiceManager, defaultDshHome, type ManagerOptions } from './service/manager';
import { bundledNodeExe, bundledDshBin } from './service/process';
import { DshPanelProvider } from './panel/provider';
import { StatusBarController } from './statusbar';
import { createDesktopCore } from './core/desktopCore';

/** 桌面版 userData 目录（%APPDATA%/Deepseek Harness EAC v4Lite）——与桌面版共享 settings.json 与稳定端口。
 *  环境变量 DSH_EAC_USER_DATA 可覆盖（测试/便携场景隔离）。 */
function defaultUserDataDir(): string {
  if (process.env.DSH_EAC_USER_DATA) return process.env.DSH_EAC_USER_DATA;
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Deepseek Harness EAC v4Lite');
}

let manager: ServiceManager | null = null;
let output: vscode.OutputChannel | null = null;
/** 日志目录（激活时确定；appendLog 同时落盘，便于诊断） */
let logsDirPath: string | null = null;
/** 当前展示用 URL（供「复制网址」命令使用） */
let currentUrl: string | null = null;

/** 日志缓冲（供「复制日志」命令 dshEac.copyLogs 使用；上限行数防内存膨胀） */
const logBuffer: string[] = [];
const LOG_BUFFER_MAX = 5000;

/** 统一日志出口：加 HH:MM:SS 时间戳 → 写入输出通道 + 日志缓冲 + 落盘 */
function appendLog(line: string): void {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const full = `[${ts}] ${line}`;
  logBuffer.push(full);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  output?.appendLine(full);
  // 落盘（有界追加；供离线诊断）
  if (logsDirPath) {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      fs.appendFileSync(join(logsDirPath, 'dsh-eac.log'), `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      /* 日志落盘失败不影响运行 */
    }
  }
}

/** 解析 VS Code 工作区根目录（dshEac.workspaceRootIndex 指定多根工作区的第几个根） */
function resolveWorkspaceRoot(folders: readonly vscode.WorkspaceFolder[], index: number): string | undefined {
  if (folders.length === 0) return undefined;
  const idx = index >= 0 && index < folders.length ? index : 0;
  return folders[idx].uri.fsPath;
}

/** DshConfig → ManagerOptions */
function toManagerOptions(config: DshConfig, repoRoot: string, userDataDir: string, logsDir: string): ManagerOptions {
  return {
    host: config.host,
    port: config.port,
    autoStart: config.autoStart,
    stopOnExit: config.stopOnExit,
    profile: config.profile,
    dshHome: resolveDshHome(config),
    extraArgs: config.extraArgs,
    patchOverlays: config.patchOverlays,
    openInBrowser: config.openInBrowser,
    repoRoot,
    userDataDir,
    logsDir,
    cwd: resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], config.workspaceRootIndex),
    syncBuiltinPlugins: config.syncBuiltinPlugins,
    startTimeoutMs: 15000,
    firstBootTimeoutMs: 300000,
    healthIntervalMs: 30000,
  };
}

/** 解析 DSH_HOME：显式环境变量优先（与桌面版一致），其次用户配置，缺省 ~/.dsh-v4lite */
function resolveDshHome(config: DshConfig): string {
  return config.dshHome || process.env.DSH_HOME || defaultDshHome();
}

/** 仓库根目录解析（env DSH_EAC_REPO_ROOT → <extensionPath>/runtime → 扩展目录上一级）。
 *  内置 IDE 模式（扩展作为内置扩展分发、运行时捆绑在 runtime/ 内）无需任何环境变量。 */
function repoRootFromContext(context: vscode.ExtensionContext): string {
  return resolveRepoRoot(context.extensionPath);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initI18n(vscode.env.language);
  output = vscode.window.createOutputChannel('DSH EAC');
  output.appendLine('DSH EAC 插件已激活');
  appendLog(`扩展目录: ${context.extensionPath}`);
  appendLog(`VS Code 版本: ${vscode.version} / 语言: ${vscode.env.language}`);

  const { config, errors } = readConfig();
  for (const e of errors) appendLog(`[config] ${e}`);

  const repoRoot = repoRootFromContext(context);
  const userDataDir = defaultUserDataDir();
  const logsDir = join(userDataDir, 'logs');
  logsDirPath = logsDir;
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    /* 日志目录创建失败不阻塞启动 */
  }
  appendLog(`仓库根: ${repoRoot}`);
  appendLog(`用户数据目录: ${userDataDir}`);
  appendLog(`内置 Node: ${bundledNodeExe(repoRoot)}`);
  appendLog(`内置 dsh: ${bundledDshBin(repoRoot)}`);

  // 创建 desktop-core 实例：复用 lite-Windows 的插件生态编排（内置插件/皮肤同步、
  // 插件启停、保护中心、市场排队任务、余额、更新），完整保留万物皆插件能力。
  const core = createDesktopCore(repoRoot, {
    userDataDir,
    logsDir,
    dshHome: resolveDshHome(config),
    nodeExe: () => bundledNodeExe(repoRoot),
    npmCli: () => join(repoRoot, 'vendor', 'npm', 'bin', 'npm-cli.js'),
    log: (tag, msg) => appendLog(`[${tag}] ${msg}`),
    notify: (title, body) => {
      void vscode.window.showInformationMessage(`${title}: ${body}`);
    },
  });
  appendLog(`desktop-core 就绪（内置插件 ${core.companionPluginsCount ?? 0} 个）`);

  // 服务管理器
  manager = new ServiceManager(toManagerOptions(config, repoRoot, userDataDir, logsDir), {
    probeService,
    spawnImpl: require('node:child_process').spawn,
    log: (line) => appendLog(line),
    core,
    onPortFallback: (_requestedPort, fallbackPort) => {
      appendLog(`端口被占用，本次会话临时改用端口 ${fallbackPort}`);
      void vscode.window.showWarningMessage(t('info.portChanged', { port: fallbackPort }));
    },
    onSyncDone: (count) => {
      appendLog(`内置插件同步完成（${count} 个条目）`);
      void vscode.window.showInformationMessage(t('info.pluginsSynced', { count }));
    },
    onReady: (port, url) => {
      currentUrl = url;
      appendLog(`DSH 服务已就绪: ${url}`);
    },
  });

  // 面板 provider（左侧活动栏 + 右侧辅助侧边栏）
  const leftProvider = new DshPanelProvider(manager);
  const rightProvider = new DshPanelProvider(manager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dshEac.panel', leftProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('dshEac.panel.secondary', rightProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // 状态栏
  const statusbar = new StatusBarController(manager);
  context.subscriptions.push(statusbar);

  // 命令注册
  const openPanel = () => {
    void vscode.commands.executeCommand('dshEac.panel.focus');
  };
  const openSecondary = () => {
    void vscode.commands.executeCommand('dshEac.panel.secondary.focus');
  };
  const openExternal = () => {
    const url = currentUrl ?? manager?.getSnapshot().url;
    if (url) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    } else {
      void vscode.window.showWarningMessage(t('info.notReady'));
    }
  };
  const copyUrl = () => {
    const url = currentUrl ?? manager?.getSnapshot().url;
    if (url) {
      void vscode.env.clipboard.writeText(url);
      void vscode.window.showInformationMessage(t('info.urlCopied', { url }));
    } else {
      void vscode.window.showWarningMessage(t('info.notReady'));
    }
  };
  const showLogs = () => {
    output?.show();
  };
  const syncPlugins = async () => {
    if (!manager) return;
    try {
      core.ensureDesktopProfileInit();
      const r = core.syncAll();
      void vscode.window.showInformationMessage(
        r.ok ? t('info.pluginsSynced', { count: core.companionPluginsCount ?? 0 }) : t('err.syncFailed', { message: r.message ?? 'unknown' }),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(t('err.syncFailed', { message: String((err as Error)?.message ?? err) }));
    }
  };
  const openProfile = () => {
    const dir = join(config.dshHome || defaultDshHome(), 'profiles', config.profile);
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
  };
  const openDshHome = () => {
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(config.dshHome || defaultDshHome()), { forceNewWindow: true });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('dshEac.openPanel', openPanel),
    vscode.commands.registerCommand('dshEac.openSecondary', openSecondary),
    vscode.commands.registerCommand('dshEac.openExternal', openExternal),
    vscode.commands.registerCommand('dshEac.restart', () => void manager?.restart()),
    vscode.commands.registerCommand('dshEac.stop', () => void manager?.stop()),
    vscode.commands.registerCommand('dshEac.copyUrl', copyUrl),
    vscode.commands.registerCommand('dshEac.showLogs', showLogs),
    vscode.commands.registerCommand('dshEac.syncPlugins', syncPlugins),
    vscode.commands.registerCommand('dshEac.openProfile', openProfile),
    vscode.commands.registerCommand('dshEac.openDshHome', openDshHome),
  );

  // 配置变更：服务相关设置变化时按需重启
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('dshEac')) return;
      const next = readConfig();
      for (const err of next.errors) appendLog(`[config] ${err}`);
      const opts = toManagerOptions(next.config, repoRoot, userDataDir, logsDir);
      const changed =
        opts.profile !== config.profile ||
        opts.dshHome !== config.dshHome ||
        opts.extraArgs.join('\u0000') !== config.extraArgs.join('\u0000') ||
        opts.patchOverlays.join('\u0000') !== config.patchOverlays.join('\u0000') ||
        opts.syncBuiltinPlugins !== config.syncBuiltinPlugins;
      Object.assign(config, next.config);
      manager?.updateOptions(opts);
      if (changed && manager) {
        appendLog('[config] 服务相关设置变更，重启服务');
        void manager.restart();
      }
    }),
  );

  appendLog('DSH EAC 插件激活完成');
}

export function deactivate(): void {
  if (manager) {
    manager.dispose();
    // 退出时停止插件自启的服务（stopOnExit 语义，桌面版一致：不留孤儿进程）
    void manager.stop();
  }
}

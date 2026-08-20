/**
 * lib/market-ops.ts — 插件市场排队任务（Task 5.2 自 main.js 提取）。
 *
 * 服务运行中安装/卸载撞上 Windows 文件锁（EPERM，如 sqlite-vec 的 vec0.dll
 * 被运行中的 web 进程加载）时，市场插件把任务写进 profile 的
 * .dsh-market-pending.json。这里在"无服务进程持锁"的窗口期（应用启动时 /
 * 原地重启 kill 完旧进程后）用 dsh CLI 完成它。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { state } from './state.js';
import { log } from './log.js';
import { nodeExe, dshBin } from './proc.js';
import { desktopProfile, profileDirFor, artifactCacheDirFor } from './paths.js';
import { childEnv } from './server.js';
import { bridge } from './bridge.js';
import { artifactKeep, allowBuilds } from './market-modules.js';
import { managedPackageNames, healProfileModules } from './plugins.js';

const MARKER_NAME = '.dsh-market-pending.json';
const MARKER_MAX_ATTEMPTS = 3;

/** 单个排队任务的形状（marker 文件解析结果）。 */
export interface MarketJob {
  target: string;
  profile: string;
  kind: 'install' | 'uninstall';
  label?: string;
  attempts?: number;
}

// 删除排队标记文件。曾有残留进程短暂持锁导致 rmSync 静默失败、标记
// "复活"并反复触发 pnpm 的案例 —— 带重试 + 改名兜底，返回是否真正删除。
function removeMarkerFile(file: string): boolean {
  try {
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 落到改名兜底 */
  }
  if (!fs.existsSync(file)) return true;
  try {
    fs.renameSync(file, file + '.stale-' + Date.now());
  } catch {
    /* 锁着也无可奈何，交给 attempts 上限 */
  }
  return !fs.existsSync(file);
}

/** 扫描全部 profile 的排队标记（字段不完整/损坏的标记就地删除）。 */
function pendingMarketMarkers(): { marker: string; job: MarketJob }[] {
  const out: { marker: string; job: MarketJob }[] = [];
  try {
    const home = state.dshHome || path.join(os.homedir(), '.dsh');
    const profilesRoot = path.join(home, 'profiles');
    if (!fs.existsSync(profilesRoot)) return out;
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const marker = path.join(profilesRoot, entry.name, MARKER_NAME);
      if (!fs.existsSync(marker)) continue;
      try {
        // 去掉可能的 UTF-8 BOM（外部编辑器写入的标记）再解析。
        const job = JSON.parse(
          fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, ''),
        ) as MarketJob;
        if (
          job && typeof job.target === 'string' && job.target
          && typeof job.profile === 'string' && /^[A-Za-z0-9_-]+$/.test(job.profile)
          && (job.kind === 'install' || job.kind === 'uninstall')
        ) {
          // V4.2：旧版 host 可能把目录默认 profile 'web' 写进标记（桌面壳跑
          // 在 web-desktop）—— 归一化后再执行，避免对不存在的 profile 跑 pnpm。
          job.profile = job.profile === 'web' ? desktopProfile() : job.profile;
          out.push({ marker, job });
        } else {
          log('market-pending', '标记字段不完整，已删除: ' + marker);
          removeMarkerFile(marker);
        }
      } catch (err) {
        log('market-pending', `标记损坏，已删除: ${marker} (${String((err as Error).message)})`);
        removeMarkerFile(marker);
      }
    }
  } catch (err) {
    log('market-pending', '扫描排队任务失败: ' + String((err as Error).message));
  }
  return out;
}

/** 任务收尾：成功删标记；失败记 attempts，超上限放弃。 */
function finishMarketMarker(
  marker: string, job: MarketJob, attempts: number, ok: boolean, tail: string,
): void {
  if (ok) {
    log('market-pending', '排队任务完成: ' + (job.label ?? job.target));
    if (!removeMarkerFile(marker)) {
      log('market-pending', '警告: 排队标记删除失败（文件被占用？），已尝试改名兜底');
    }
    return;
  }
  if (attempts >= MARKER_MAX_ATTEMPTS) {
    const last = String(tail ?? '').split(/\r?\n/).filter(Boolean).pop() ?? '';
    log('market-pending', `排队任务连续 ${attempts} 次失败，放弃并清除: ${job.label ?? job.target}${last ? ' — ' + last.slice(0, 200) : ''}`);
    removeMarkerFile(marker);
    return;
  }
  try {
    fs.writeFileSync(marker, JSON.stringify({ ...job, attempts }, null, 2));
  } catch {
    /* 写失败：下次按原 attempts 继续 */
  }
  log('market-pending', '排队任务失败（下次启动重试）: ' + (job.label ?? job.target));
}

// 必须在"没有任何 dsh web 进程持锁"时调用；调用方负责先等待旧进程退出。
export async function processPendingMarketOps(): Promise<void> {
  const items = pendingMarketMarkers();
  if (items.length === 0) return;
  const nodeBin = nodeExe();
  const bin = dshBin();
  if (!fs.existsSync(nodeBin) || !fs.existsSync(bin)) {
    log('market-pending', '找不到 node/dsh CLI，跳过排队任务');
    return;
  }
  log('market-pending', `发现 ${items.length} 个排队任务，开始执行（Web 服务启动前，无文件锁）`);
  // V4：pnpm 即将重写 node_modules —— 先快照第三方包（含人工补齐的构建
  // 产物），任务结束后回填被清掉的部分（meow-memory 修复）。
  const profiles = [...new Set(items.map((it) => it.job.profile))];
  const ak = await artifactKeep();
  if (typeof ak.snapshotArtifacts === 'function') {
    const snap = ak.snapshotArtifacts as (a: string, b: string, o: Record<string, unknown>) => void;
    for (const profile of profiles) {
      try {
        snap(profileDirFor(profile), artifactCacheDirFor(profile), {
          managedNames: managedPackageNames(),
          log: (m: string) => log('artifact-keep', m),
        });
      } catch (err) {
        log('artifact-keep', `snapshot ${profile} 失败: ` + String((err as Error).message));
      }
    }
  }
  await new Promise<void>((resolve) => {
    let idx = 0;
    // V4.2：allowBuilds 自动放行后的重试只允许一次（同一 marker）。
    const retriedMarkers = new Set<string>();
    const next = async (): Promise<void> => {
      if (idx >= items.length) {
        // pnpm 可能重新 hoist 出 @deepseek-ai 遮蔽拷贝，装完立刻清理，
        // 避免模块双实例（Symbol 身份不一致）问题拖到下次启动。
        healProfileModules();
        resolve();
        return;
      }
      const { marker, job } = items[idx] as { marker: string; job: MarketJob };
      const retried = retriedMarkers.has(marker);
      const attempts = Number(job.attempts ?? 0) + 1;
      const action = job.kind === 'uninstall' ? 'remove' : 'add';
      // 安装前快照（保护中心）：排队任务改的是 profile 配置面，可回滚。
      bridge.ensureGuard().snapshot('market:' + job.target);
      log('market-pending', `执行(${attempts}/${MARKER_MAX_ATTEMPTS}): dsh plugin --profile ${job.profile} ${action} ${job.target}`);
      const child = spawn(
        nodeBin,
        [bin, 'plugin', '--profile', job.profile, action, job.target],
        {
          cwd: state.userDataDir,
          // CI=true 与市场插件 host 侧一致：pnpm v10 无 TTY 时对被忽略的构建
          // 脚本静默放行，而不是 ERR_PNPM_IGNORED_BUILDS 硬失败。
          env: { ...childEnv(), CI: 'true' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      state.marketOpChild = child;
      let tail = '';
      const onData = (c: Buffer): void => {
        const text = c.toString();
        tail = (tail + text).slice(-8000);
        for (const line of text.split(/\r?\n/)) {
          const s = line.trim();
          // Progress: \r 进度条不进日志，只保留有信息量的行。
          if (s && !/^Progress:/.test(s)) log('market-pending', s.slice(0, 300));
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => {
        log('market-pending', '排队任务超时（5 分钟），强制终止');
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } catch {
          /* kill 失败由 close 事件兜底 */
        }
      }, 5 * 60 * 1000);
      child.on('error', (err) => {
        clearTimeout(timer);
        if (state.marketOpChild === child) state.marketOpChild = null;
        finishMarketMarker(marker, job, attempts, false, String(err.message));
        idx += 1;
        void next();
      });
      child.on('close', async (code) => {
        clearTimeout(timer);
        if (state.marketOpChild === child) state.marketOpChild = null;
        // V4.2：pnpm 封锁构建脚本硬失败时，解析包名自动写入 allowBuilds 后
        // 重试同一任务一次（不消耗 attempts）。
        if (code !== 0 && !retried) {
          try {
            const ab = await allowBuilds();
            const parse = ab.parseBlockedBuildKeys as ((t: string) => string[]) | undefined;
            const keys = parse ? parse(tail) : [];
            if (keys && keys.length > 0) {
              const ensure = ab.ensureAllowBuilds as
                | ((f: string, k: string[]) => Promise<{ wrote: boolean; added: string[] }>)
                | undefined;
              if (ensure) {
                const r = await ensure(
                  path.join(profileDirFor(job.profile), 'pnpm-workspace.yaml'), keys,
                );
                if (r && r.wrote) {
                  log('market-pending', `[allowBuilds] 已自动放行 ${r.added.join(', ')}，自动重试`);
                  retriedMarkers.add(marker);
                  void next();
                  return;
                }
              }
            }
          } catch (err) {
            log('market-pending', '[allowBuilds] 自动放行失败: ' + String((err as Error).message));
          }
        }
        finishMarketMarker(marker, job, attempts, code === 0, tail);
        idx += 1;
        void next();
      });
    };
    void next();
  });
  // pnpm 重写完成：回填被清掉的第三方构建产物（lib/ 等）。
  if (typeof ak.restoreArtifacts === 'function') {
    const restore = ak.restoreArtifacts as (a: string, b: string, o: Record<string, unknown>) => void;
    for (const profile of profiles) {
      try {
        restore(profileDirFor(profile), artifactCacheDirFor(profile), {
          log: (m: string) => log('artifact-keep', m),
        });
      } catch (err) {
        log('artifact-keep', `restore ${profile} 失败: ` + String((err as Error).message));
      }
    }
  }
}

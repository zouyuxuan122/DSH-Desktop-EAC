/**
 * lib/client-update/download.ts — 断点续传下载与哈希计算（Task 6.1 自
 * client-updater.js 提取）。
 *
 * 下载策略（慢链路实战沉淀，勿简化）：
 *   - 单次尝试失败保留 .part，下次从已落盘字节 Range 续传；
 *   - 空闲超时 60s（无整体超时：167MB 在慢链路要传十几分钟）；
 *   - 指数退避重试（3s × 2^n，封顶 30s）；
 *   - 同源多次失败自动切换镜像源（切换时丢弃 .part —— 不同来源文件
 *     可能不一致，断点续传不安全）；
 *   - Gitee 分片下载后按序拼接（concatFiles）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getResponse, headerValue, isNoSpaceError, noSpaceError } from './net.js';
import { MIN_VALID_BYTES, expectedSha256, selectAsset } from './release.js';
import type { ClientUpdCtx, DownloadResult, NormalizedRelease, ReleaseDownloadResult } from './types.js';

/** 进度回调：(received, total)，total 可能为 0（服务器未给 content-length）。 */
type OnProgress = (received: number, total: number) => void;

/** 单次下载尝试。resumeFrom > 0 时发 Range 续传请求并以追加模式写入；
 *  失败时保留 .part 供下一次断点续传（不删）。 */
function downloadFileOnce(
  url: string,
  dest: string,
  opts: { onProgress?: OnProgress | undefined; resumeFrom?: number } = {},
): Promise<DownloadResult> {
  const { onProgress, resumeFrom = 0 } = opts;
  return new Promise<DownloadResult>((resolve, reject) => {
    const tmp = dest + '.part';
    let received = resumeFrom;
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    /** 一次性落定：首个到达的 resolve/reject 生效，其余忽略。 */
    const finishOk = (r: DownloadResult): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      resolve(r);
    };
    const finishErr = (e: unknown): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    // 空闲超时：60 秒没有任何数据到达才判死（167MB 的安装包在慢链路上
    // 要传十几分钟，不能设整体超时）。每个数据块重置计时。
    const bumpIdle = (stream: { destroy?(err?: Error): void }): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          stream.destroy?.(new Error('下载超时'));
        } catch {
          /* already destroyed */
        }
      }, 60_000);
    };
    const reqHeaders = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
    getResponse(url, { timeoutMs: 60_000, headers: reqHeaders }).then(
      ({ status, headers, stream }) => {
        if (settled) {
          stream.resume();
          return;
        }
        if (status === 416) {
          // .part 比远端文件还长（上轮损坏/上游换了文件）：作废重来
          stream.resume();
          try {
            fs.rmSync(tmp, { force: true });
          } catch {
            /* 删除失败由下次全新下载覆盖 */
          }
          finishErr(new Error('RESUME_INVALID'));
          return;
        }
        const partial = status === 206;
        if (status !== 200 && !partial) {
          stream.resume();
          finishErr(new Error('下载失败 HTTP ' + status));
          return;
        }
        if (partial) {
          const cr = String(headerValue(headers, 'content-range') || '');
          const m = /^bytes (\d+)-/i.exec(cr);
          if (m && Number(m[1]) !== resumeFrom) {
            stream.resume();
            finishErr(new Error('RESUME_INVALID'));
            return;
          }
        }
        // 服务器忽略 Range 回 200 全量时必须覆盖写（追加会把旧半截拼在前面）
        const append = partial && resumeFrom > 0;
        if (!append) received = 0;
        const file = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' });
        const fail = (err: Error): void => {
          file.close(() => {});
          // 保留 .part：下一次重试从已落盘字节续传
          finishErr(err);
        };
        const declared = Number(headerValue(headers, 'content-length') || 0);
        const total = append ? (declared ? resumeFrom + declared : 0) : declared;
        bumpIdle(stream);
        stream.on('data', (c: Buffer) => {
          received += c.length;
          bumpIdle(stream);
          if (onProgress) {
            try {
              onProgress(received, total);
            } catch {
              /* 进度回调异常不中断下载 */
            }
          }
        });
        stream.on('aborted', () => fail(new Error('连接中断')));
        stream.on('error', fail);
        file.on('finish', () => {
          if (settled) return;
          try {
            fs.renameSync(tmp, dest);
          } catch (err) {
            finishErr(err);
            return;
          }
          finishOk({ path: dest, size: received });
        });
        file.on('error', fail);
        stream.pipe(file as unknown as NodeJS.WritableStream);
      },
      (err: unknown) => finishErr(err),
    );
  });
}

/** 带断点续传 + 指数退避重试的下载。慢链路上 167MB 直连常被 RST
 *  （net::ERR_CONNECTION_RESET），一锤子流下载必然偶发失败；每次重试
 *  从已落盘的 .part 断点继续，而不是整包重来。 */
export async function downloadFile(
  url: string,
  dest: string,
  opts: { onProgress?: OnProgress | undefined; ctx?: ClientUpdCtx | null; maxAttempts?: number } = {},
): Promise<DownloadResult> {
  const { onProgress, ctx = null, maxAttempts = 10 } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resumeFrom = 0;
    try {
      resumeFrom = fs.statSync(dest + '.part').size;
    } catch {
      /* 无残留，全新下载 */
    }
    if (attempt > 1 || resumeFrom > 0) {
      ctx?.log?.('client-update', `下载尝试 ${attempt}/${maxAttempts}（从 ${Math.round(resumeFrom / 1048576)} MB 处续传）`);
    }
    try {
      return await downloadFileOnce(url, dest, { onProgress, resumeFrom });
    } catch (err) {
      lastErr = err;
      if (isNoSpaceError(err)) break; // 磁盘满：重试只会继续写失败，直接终止并提示
      if ((err as Error).message === 'RESUME_INVALID') continue; // .part 已作废，立即全新重试
      if (attempt < maxAttempts) {
        const delay = Math.min(3000 * 2 ** (attempt - 1), 30_000);
        ctx?.log?.('client-update', `下载中断（${(err as Error).message}），${Math.round(delay / 1000)}s 后从断点重试`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  if (isNoSpaceError(lastErr)) {
    throw noSpaceError('磁盘空间不足，无法下载更新包。请清理磁盘空间（如临时文件、旧安装包）后重试。');
  }
  throw lastErr instanceof Error ? lastErr : new Error('下载失败');
}

// 同源多次失败后自动切换镜像源（GitHub ↔ Gitee 等）：切换时丢弃旧 .part
//（不同来源的文件可能不一致，断点续传不安全），整包重新下载。
export async function downloadWithSourceSwitch(
  urls: string[],
  dest: string,
  opts: {
    onProgress?: OnProgress | undefined;
    ctx?: ClientUpdCtx | null;
    onSourceChange?: ((idx: number) => void) | null;
  } = {},
): Promise<DownloadResult> {
  const { onProgress, ctx = null, onSourceChange = null } = opts;
  let lastErr: unknown;
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) {
      try {
        fs.rmSync(dest + '.part', { force: true });
      } catch {
        /* 删除失败由全新下载覆盖 */
      }
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* 同上 */
      }
      ctx?.log?.('client-update', `当前下载源失败（${lastErr instanceof Error ? lastErr.message : String(lastErr)}），切换备用源 ${i + 1}/${urls.length}`);
      if (onSourceChange) {
        try {
          onSourceChange(i);
        } catch {
          /* 回调异常不中断切换 */
        }
      }
    }
    try {
      return await downloadFile(urls[i] as string, dest, {
        onProgress: onProgress ?? undefined,
        ctx,
        maxAttempts: i === 0 ? 4 : 6,
      });
    } catch (err) {
      lastErr = err;
      if (isNoSpaceError(err)) throw err; // 磁盘满：换源也不会好转
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('下载失败');
}

/** 按序拼接分片文件到 dest（Gitee .part1/.part2 → 单文件），拼接后删分片。 */
export async function concatFiles(sources: string[], dest: string): Promise<void> {
  const out = fs.createWriteStream(dest);
  for (const s of sources) {
    await new Promise<void>((res, rej) => {
      const rs = fs.createReadStream(s);
      rs.on('error', rej);
      rs.on('end', res);
      rs.pipe(out, { end: false });
    });
    fs.rmSync(s, { force: true });
  }
  await new Promise<void>((res, rej) => {
    out.on('error', rej);
    out.end(res);
  });
}

// --- SHA-256 内容校验（V4）--------------------------------------------------
//
// 此前下载完成只比对文件大小（±2MB 还只告警不拦截），与不做内容校验没有
// 差别：传输损坏 / 投毒的镜像 / 被劫持的下载源都会把替换流程照走到底。
// 现在按以下优先级取“公布哈希”，取到即强校验，不一致 → 删除文件并中止：
//   1. release 资产自带的 digest 字段（GitHub API 提供，"sha256:<hex>"）；
//   2. release 里的 SHA256SUMS.txt 资产（发布脚本随包生成，Gitee 也可用；
//      覆盖 Gitee 分片合并后的最终文件名）；
//   3. 都没有（老 release / 自定义镜像）：记录告警后放行，保持向后兼容。

/** 流式计算文件 SHA-256（hex 小写）。 */
export function computeSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c: Buffer) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/** downloadRelease 的回调面。 */
export interface DownloadReleaseOpts {
  onProgress?: (received: number, total: number) => void;
  onSourceChange?: (source: string, idx: number, urls: string[]) => void;
  /** 备用源 release 列表（releaseFallbacks 的产物）。 */
  fallbacks?: NormalizedRelease[];
}

/**
 * 下载 release 主资产到 <userData>/updates/：分片按序下载并拼接、备用源
 * 自动切换、大小下限校验、SHA-256 内容校验（有公布哈希即强校验）。
 */
export async function downloadRelease(
  ctx: ClientUpdCtx,
  release: NormalizedRelease,
  opts: DownloadReleaseOpts = {},
): Promise<ReleaseDownloadResult> {
  const { onProgress, onSourceChange, fallbacks = [] } = opts;
  const dir = path.join(ctx.userDataDir, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const sel = selectAsset(release);
  const split = sel.parts.length > 1;
  const finalPath = path.join(dir, sel.name);
  const partPaths: string[] = [];
  let merged = 0;
  // 备用源按相同的分片名对齐（命名规则一致时索引即对应；对不上就跳过）。
  const fbSelections = [];
  for (const fb of fallbacks) {
    try {
      const fbSel = selectAsset(fb);
      if (fbSel.parts.length === sel.parts.length && fbSel.parts.every((p, i) => p.name === sel.parts[i]?.name)) {
        fbSelections.push(fbSel);
      }
    } catch {
      /* 备用源资产形状不一致：跳过 */
    }
  }
  for (let i = 0; i < sel.parts.length; i++) {
    const p = sel.parts[i];
    if (!p) continue;
    ctx.log('client-update', `下载 ${p.name}（${Math.round(p.size / 1048576)} MB）`);
    const dest = split ? finalPath + '.part' + (i + 1) : finalPath;
    const urls = [p.url, ...fbSelections.map((f) => f.parts[i]?.url || '').filter(Boolean)];
    const res = await downloadWithSourceSwitch(urls, dest, {
      ctx,
      onSourceChange: (idx) => {
        if (onSourceChange) onSourceChange(release.source, idx, urls);
      },
      onProgress: (r) => {
        if (onProgress) onProgress(split ? merged + r : r, sel.totalSize);
      },
    });
    if (split) {
      merged += res.size;
      partPaths.push(dest);
    }
  }
  if (split) {
    ctx.log('client-update', `合并 ${partPaths.length} 个分片 → ${sel.name}`);
    try {
      await concatFiles(partPaths, finalPath);
    } catch (err) {
      if (isNoSpaceError(err)) throw noSpaceError('磁盘空间不足，无法合并更新分片。请清理磁盘空间后重试。');
      throw err;
    }
  }
  const stat = fs.statSync(finalPath);
  if (stat.size < MIN_VALID_BYTES) {
    fs.rmSync(finalPath, { force: true });
    throw new Error('下载文件异常（仅 ' + Math.round(stat.size / 1048576) + ' MB），已丢弃');
  }
  // V4：SHA-256 内容校验 —— 有公布哈希即强校验；不一致删除文件并中止
  // 更新（绝不运行被篡改/损坏的安装包）。
  const expected = await expectedSha256(ctx, release, sel);
  if (expected) {
    ctx.log('client-update', `校验 SHA-256（期望 ${expected.slice(0, 16)}…）`);
    const actual = await computeSha256(finalPath);
    if (actual !== expected) {
      fs.rmSync(finalPath, { force: true });
      throw new Error(
        `SHA-256 校验失败，已中止更新并删除下载文件（期望 ${expected}，实际 ${actual}）。` +
          '文件可能在传输中损坏或下载源被篡改，请稍后重试或手动从官方 Release 下载。',
      );
    }
    ctx.log('client-update', 'SHA-256 校验通过');
  } else {
    ctx.log('client-update', '上游未提供哈希（无 digest / SHA256SUMS.txt），跳过内容校验（大小校验兜底）');
    if (sel.totalSize > 0 && Math.abs(stat.size - sel.totalSize) > 2 * 1024 * 1024) {
      ctx.log('client-update', `大小与上游声明不一致：期望 ${sel.totalSize} 实际 ${stat.size}（继续，安装器会自校验）`);
    }
  }
  ctx.log('client-update', `下载完成: ${finalPath}（${Math.round(stat.size / 1048576)} MB）`);
  return { filePath: finalPath, size: stat.size, sha256Verified: !!expected };
}

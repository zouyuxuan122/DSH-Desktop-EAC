'use strict';

// H2/H3 路径围栏：文件还原/打开只允许「会话 cwd」之下的项目文件。
// 任意绝对路径（如写入 Startup\*.bat）一律拒绝；缓存 5 分钟。
// （ADR 0002 L2 业务服务层；Wave 1 自 file-roots.js 类型化迁出，行为零变更。）

import path = require('node:path');
import fs = require('node:fs');
import os = require('node:os');
import zlib = require('node:zlib');
// session-watcher.js 尚未类型化（Wave 3 收编），先以窄签名消费。
const { scanZstdFrames } = require('../../session-watcher') as {
  scanZstdFrames(buf: Buffer): { frames: { start: number; end: number }[] };
};

export const DANGEROUS_EXT = /\.(bat|cmd|com|exe|ps1|vbs|lnk|js|jse|msi|scr|pif|reg)$/i;

const fileRootsCache: { at: number; roots: string[] } = { at: 0, roots: [] };

interface SessionHeader { cwd?: unknown }

export function fileRoots(): string[] {
  if (Date.now() - fileRootsCache.at < 5 * 60 * 1000) return fileRootsCache.roots;
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const roots: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'session.jsonl.zstd') continue;
      try {
        const buf = fs.readFileSync(p);
        const { frames } = scanZstdFrames(buf);
        if (frames.length === 0) continue;
        const text = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
        const header = JSON.parse(text.split('\n', 1)[0]) as SessionHeader;
        if (header && typeof header.cwd === 'string' && header.cwd) roots.push(header.cwd);
      } catch { /* 跳过损坏日志 */ }
    }
  };
  walk(path.join(dshHome, 'sessions'));
  fileRootsCache.roots = [...new Set(roots)];
  fileRootsCache.at = Date.now();
  return fileRootsCache.roots;
}

export function isUnderFileRoots(p: string): boolean {
  const resolved = path.resolve(p);
  return fileRoots().some((r) => {
    const rp = path.resolve(r);
    return resolved === rp || resolved.startsWith(rp + path.sep);
  });
}

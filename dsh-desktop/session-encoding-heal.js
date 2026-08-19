'use strict';

// session-encoding-heal.js — 会话编码一致性自愈（启动失败救援）。
//
// 背景（Issue #77）：会话持久化后端 @deepseek-ai/dsh-session-persistence-jsonl
// 以 DEFAULT_COMPRESSION = "zstd" 运行；插件树加载时 listArtifacts() →
// checkRootEncoding() 会遍历每个会话目录，只要发现同目录里同时存在「相反
// 物理编码」的文件（当前后端为 zstd 时即明文 session.jsonl）就抛
// encodingMismatch，导致整个 `dsh web` 进程退出码 1 —— 桌面端表现为
// 「Web UI 未在预期时间内就绪」，且体检/回滚链路救不回来（它们只看插件层）。
//
// 明文快照是权威 zstd 日志的旧前缀（Issue #77 已逐字节确认），因此当两种
// 格式并存时：保留后端在用的编码文件（zstd），把相反格式文件改名归档
// （绝不删除，数据无损，用户可手动找回）。此模块只在启动确因 encodingMismatch
// 失败时经守护启动的 preRetry 钩子触发，不做任何常态化的会话目录写操作。

const fs = require('node:fs');
const path = require('node:path');

// dsh-session-persistence-jsonl 的 encodingMismatch 报错特征（rc.6/rc.7 一致）：
//   session artifact "…session.jsonl" uses .jsonl, but this backend is
//   configured for compression "zstd"; use a separate root …
const ENCODING_MISMATCH_RE = /uses \.jsonl(?:\.zstd)?, but this backend is configured for compression/i;

/** 报错文案（含 dsh-web.log 尾部）是否为会话编码不一致崩溃。 */
function isEncodingMismatch(errText) {
  return ENCODING_MISMATCH_RE.test(String(errText || ''));
}

// 会话目录布局与后端约定一致：<sessionsDir>/<projectKey>/<session-…>/ ，
// 日志文件名为 session.jsonl（明文）或 session.jsonl.zstd（zstd）。
const LIVE_SUFFIX = { zstd: '.jsonl.zstd', none: '.jsonl' };
const STALE_SUFFIX = { zstd: '.jsonl', none: '.jsonl.zstd' };

/**
 * 扫描会话根目录，归档与后端编码相反的遗留日志文件（仅当同目录两种格式并存）。
 * 数据无损：保留后端在用编码的文件（权威），相反格式文件改名为
 * `<name>.bak-<时间戳>`，绝不删除。
 *
 * @param {string} sessionsDir  <DSH_HOME>/sessions
 * @param {{ compression?: 'zstd'|'none', log?: (tag: string, msg: string) => void }} [opts]
 * @returns {string[]} 已归档（改名后）的文件绝对路径
 */
function healSessionEncodingConflicts(sessionsDir, opts = {}) {
  const compression = opts.compression === 'none' ? 'none' : 'zstd';
  const log = opts.log || (() => {});
  const liveSuffix = LIVE_SUFFIX[compression];
  const staleSuffix = STALE_SUFFIX[compression];
  const archived = [];
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return archived;

  let projects;
  try { projects = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch { return archived; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projDir = path.join(sessionsDir, project.name);
    let sessionDirs;
    try { sessionDirs = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
    for (const sess of sessionDirs) {
      if (!sess.isDirectory()) continue;
      const dir = path.join(projDir, sess.name);
      const live = path.join(dir, 'session' + liveSuffix);
      const stale = path.join(dir, 'session' + staleSuffix);
      // 只在两种格式并存时动手：保留 live（权威），归档 stale。
      if (!fs.existsSync(live) || !fs.existsSync(stale)) continue;
      const bak = stale + '.bak-' + Date.now();
      try {
        fs.renameSync(stale, bak);
        archived.push(bak);
        log('session-heal', `会话编码冲突：已归档 ${stale} → ${path.basename(bak)}（保留 ${path.basename(live)}）`);
      } catch (err) {
        log('session-heal', `归档 ${stale} 失败: ` + String((err && err.message) || err));
      }
    }
  }
  return archived;
}

module.exports = { isEncodingMismatch, healSessionEncodingConflicts };

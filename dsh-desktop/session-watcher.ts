'use strict';

// Watches dsh session logs (<DSH_HOME>/sessions/**/session.jsonl.zstd) and
// fires onTurnEnd when a TOP-LEVEL session's agent turn finishes.
//
// On-disk format (dsh-session-persistence-jsonl): the log is concatenated
// zstd frames; each frame holds JSONL records. The first record of the first
// frame is the session header; event rows may pack delta runs into
// 'text-chunks' / 'reasoning-chunks' / 'tool-call-chunks' storage rows.
// A 'turn/end' event marks the end of the agent's run.
//
// Decoding mirrors the persistence backend's public-API path exactly:
// structurally scan complete frame ranges, then zstdDecompressSync each
// frame (node:zlib — same codec dsh itself uses). No third-party deps.

import fs = require('node:fs');
import path = require('node:path');
import zlib = require('node:zlib');

const ZSTD_MAGIC = 4247762216; // 28 B5 2F FD little-endian

// Structural zstd frame scanner (ported from dsh-session-persistence-jsonl).
interface ScanFrame { start: number; end: number }
interface ScanResult { frames: ScanFrame[]; tornStart: number | null }

function scanZstdFrames(buffer: Buffer): ScanResult {
  const frames: ScanFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      // Bytes before the next frame magic should not exist in a healthy log;
      // stop scanning and keep what we have.
      return { frames, tornStart: start };
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) return { frames, tornStart: start };
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return { frames, tornStart: start };
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornStart: null };
}

function decodeFrame(buf: Buffer): string {
  return zlib.zstdDecompressSync(buf).toString('utf8');
}

// Expand one JSONL row into its events (storage rows pack many chunk events).
function expandRow(line: string): unknown[] {
  let row;
  try { row = JSON.parse(line); } catch { return []; }
  if (!row || typeof row !== 'object') return [];
  switch (row.type) {
    case 'text-chunks':
    case 'reasoning-chunks':
      return Array.isArray(row.data && row.data.texts) ? row.data.texts : [];
    case 'tool-call-chunks':
      return Array.isArray(row.data && row.data.args) ? row.data.args : [];
    default:
      return [row];
  }
}

class SessionWatcher {
  sessionsDir: string;
  onTurnEnd: (info: Record<string, unknown>) => void;
  log: (tag: string, msg: string) => void;
  files: Map<string, {
    size: number; consumed: number; header: Record<string, unknown> | null;
    title: string | null; baseline: boolean; hasTurnEvents: boolean;
  }>;
  timer: NodeJS.Timeout | null;

  constructor({ sessionsDir, onTurnEnd, log }: { sessionsDir: string; onTurnEnd?: () => void; log?: (tag: string, msg: string) => void }) {
    this.sessionsDir = sessionsDir;
    this.onTurnEnd = onTurnEnd || (() => {});
    this.log = log || (() => {});
    this.files = new Map(); // absPath -> { size, consumed, header, title, baseline }
    this.timer = null;
  }

  start(intervalMs = 2000) {
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listLogs() {
    try {
      if (!fs.existsSync(this.sessionsDir)) return [];
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name === 'session.jsonl.zstd') out.push(p);
        }
      };
      walk(this.sessionsDir);
      return out;
    } catch (err) {
      this.log('watch', 'listLogs 失败: ' + String((err as Error) && (err as Error).message || err));
      return [];
    }
  }

  scan() {
    let any = false;
    for (const file of this.listLogs()) {
      try { any = this.process(file) || any; } catch (err) { this.log('watch', '处理失败 ' + file + ': ' + String((err as Error) && (err as Error).message || err)); }
    }
    return any;
  }

  process(file: string): boolean {
    let st;
    try { st = fs.statSync(file); } catch { this.files.delete(file); return false; }
    let rec = this.files.get(file);
    if (!rec) {
      rec = { size: 0, consumed: 0, header: null, title: null, baseline: false, hasTurnEvents: false };
      this.files.set(file, rec);
    }
    if (st.size === rec.size) return false;

    let buf;
    try { buf = fs.readFileSync(file); } catch { return false; }

    // Session header from the first frame (first sight only).
    if (!rec.header) {
      const { frames } = scanZstdFrames(buf);
      if (frames.length > 0) {
        try {
          const text = decodeFrame(buf.subarray(frames[0]!.start, frames[0]!.end));
          const firstLine = text.split('\n')[0]!;
          const h = JSON.parse(firstLine) as Record<string, any>;
          if (h && h.type === 'session') rec.header = h;
        } catch { /* keep null; retry next poll */ }
      }
    }

    const { frames } = scanZstdFrames(buf);
    let turnEnds = 0;
    let assistantMessages = 0;
    let consumed = rec.consumed;
    for (const { start, end } of frames) {
      if (start < consumed) continue;
      let text;
      try { text = decodeFrame(buf.subarray(start, end)); } catch { break; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        for (const ev of expandRow(line) as Array<Record<string, any>>) {
          if (!ev || typeof ev !== 'object') continue;
          if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') rec.title = ev.data.title;
          if (ev.type === 'turn/start' || ev.type === 'turn/end') rec.hasTurnEvents = true;
          if (ev.type === 'turn/end') turnEnds += 1;
          if (ev.type === 'assistant/message') assistantMessages += 1;
        }
      }
      consumed = end;
    }
    rec.consumed = consumed;
    rec.size = st.size;

    // Baseline: events that existed before first sight are historical —
    // never toast for them; only LIVE completions notify.
    // Sessions that emit turn/start|turn/end (current format) notify on
    // turn/end (the definitive run-finished marker, incl. goal sessions).
    // Older logs without turn events fall back to assistant/message.
    const live = rec.baseline;
    rec.baseline = true;
    let count = 0;
    if (rec.hasTurnEvents) count = turnEnds;
    else count = assistantMessages;
    if (live && count > 0) this.emit(rec, count);
    return count > 0;
  }

  emit(rec: { header?: Record<string, any> | null; title?: string | null }, count: number): void {
    const h = rec.header || {};
    if (h.delegationDepth > 0) return; // subagent logs are noise for toasts
    let title = 'DSH 任务完成';
    let body;
    if (rec.title) {
      title = rec.title;
    }
    const cwdBase = h.cwd ? path.basename(h.cwd) : null;
    const shortId = h.id ? h.id.slice(-8) : null;
    body = [cwdBase, shortId ? '会话 ' + shortId : null].filter(Boolean).join(' · ');
    body += (count > 1 ? '（' + count + ' 轮任务完成）' : '');
    try { this.onTurnEnd({ title, body, sessionId: h.id, cwd: h.cwd }); }
    catch (err) { this.log('watch', 'onTurnEnd 回调异常: ' + String((err as Error) && (err as Error).message || err)); }
  }
}

module.exports = { SessionWatcher, scanZstdFrames, expandRow };

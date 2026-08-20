/**
 * session-watcher.ts — dsh 会话日志监听器（Task 7.1 自 session-watcher.js
 * 迁 TS）。
 *
 * 监听 <DSH_HOME>/sessions 下各会话目录的 session.jsonl.zstd，顶层会话的
 * agent 回合结束时触发 onTurnEnd。
 *
 * 磁盘格式（dsh-session-persistence-jsonl）：日志是拼接的 zstd 帧；每帧
 * 承载 JSONL 记录。第一帧首行是会话头；事件行可能把增量 run 打包进
 * 'text-chunks' / 'reasoning-chunks' / 'tool-call-chunks' 存储行。
 * 'turn/end' 事件标记 agent 运行结束。
 *
 * 解码与持久化后端的公开 API 路径完全一致：结构化扫描完整帧区间后逐帧
 * zstdDecompressSync（node:zlib —— 与 dsh 本体同一编解码器），零第三方依赖。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const ZSTD_MAGIC = 4247762216; // 28 B5 2F FD little-endian

/** 帧区间。 */
export interface ZstdFrame {
  start: number;
  end: number;
}

/** 帧扫描结果（tornStart = 起始的损坏/未写完偏移）。 */
export interface FrameScanResult {
  frames: ZstdFrame[];
  tornStart?: number;
}

/** 结构化 zstd 帧扫描器（移植自 dsh-session-persistence-jsonl）。 */
export function scanZstdFrames(buffer: Buffer): FrameScanResult {
  const frames: ZstdFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      // 下一帧 magic 之前不应有字节（健康日志）；停止扫描并保留已得。
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
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
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
  return { frames };
}

/** 解码单个 zstd 帧 → utf8 文本。 */
function decodeFrame(buf: Buffer): string {
  return zlib.zstdDecompressSync(buf).toString('utf8');
}

/** 事件行的最小形状。 */
interface EventRow {
  type?: unknown;
  data?: unknown;
}

/** 会话头（第一帧首行）。 */
interface SessionHeader {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
  delegationDepth?: unknown;
}

/** 回合结束通知的载荷。 */
export interface TurnEndInfo {
  title: string;
  body: string;
  sessionId: string | null;
  cwd: string | null;
}

/** 把一行 JSONL 展开为其事件集合（存储行打包了多个 chunk 事件）。 */
export function expandRow(line: string): unknown[] {
  let row: EventRow | null;
  try {
    row = JSON.parse(line) as EventRow;
  } catch {
    return [];
  }
  if (!row || typeof row !== 'object') return [];
  const data = (row.data ?? null) as { texts?: unknown[]; args?: unknown[] } | null;
  switch (row.type) {
    case 'text-chunks':
    case 'reasoning-chunks':
      return data && Array.isArray(data.texts) ? (data.texts as unknown[]) : [];
    case 'tool-call-chunks':
      return data && Array.isArray(data.args) ? (data.args as unknown[]) : [];
    default:
      return [row];
  }
}

/** 单个会话文件的增量消费状态。 */
interface FileRecord {
  size: number;
  consumed: number;
  header: SessionHeader | null;
  title: string | null;
  baseline: boolean;
  hasTurnEvents: boolean;
}

/** SessionWatcher 构造参数。 */
export interface SessionWatcherOpts {
  sessionsDir: string;
  onTurnEnd?: (info: TurnEndInfo) => void;
  log?: (tag: string, msg: string) => void;
}

export class SessionWatcher {
  readonly sessionsDir: string;
  private readonly onTurnEnd: (info: TurnEndInfo) => void;
  private readonly log: (tag: string, msg: string) => void;
  private files = new Map<string, FileRecord>(); // absPath -> 增量状态
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: SessionWatcherOpts) {
    this.sessionsDir = opts.sessionsDir;
    this.onTurnEnd = opts.onTurnEnd || ((): void => {});
    this.log = opts.log || ((): void => {});
  }

  start(intervalMs = 2000): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 枚举全部会话日志（递归 sessionsDir）。 */
  listLogs(): string[] {
    try {
      if (!fs.existsSync(this.sessionsDir)) return [];
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name === 'session.jsonl.zstd') out.push(p);
        }
      };
      walk(this.sessionsDir);
      return out;
    } catch (err) {
      this.log('watch', 'listLogs 失败: ' + String((err as Error).message));
      return [];
    }
  }

  scan(): boolean {
    let any = false;
    for (const file of this.listLogs()) {
      try {
        any = this.process(file) || any;
      } catch (err) {
        this.log('watch', '处理失败 ' + file + ': ' + String((err as Error).message));
      }
    }
    return any;
  }

  /** 处理一个日志文件的增量（含首次基线）。返回本轮是否计数 > 0。 */
  process(file: string): boolean {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.files.delete(file);
      return false;
    }
    let rec = this.files.get(file);
    if (!rec) {
      rec = { size: 0, consumed: 0, header: null, title: null, baseline: false, hasTurnEvents: false };
      this.files.set(file, rec);
    }
    if (st.size === rec.size) return false;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return false;
    }

    // Session header from the first frame (first sight only).
    if (!rec.header) {
      const { frames } = scanZstdFrames(buf);
      const first = frames[0];
      if (first) {
        try {
          const text = decodeFrame(buf.subarray(first.start, first.end));
          const firstLine = text.split('\n')[0] as string;
          const h = JSON.parse(firstLine) as SessionHeader;
          if (h && h.type === 'session') rec.header = h;
        } catch {
          /* 保持 null；下轮重试 */
        }
      }
    }

    const { frames } = scanZstdFrames(buf);
    let turnEnds = 0;
    let assistantMessages = 0;
    let consumed = rec.consumed;
    for (const { start, end } of frames) {
      if (start < consumed) continue;
      let text: string;
      try {
        text = decodeFrame(buf.subarray(start, end));
      } catch {
        break;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        for (const ev of expandRow(line) as EventRow[]) {
          if (!ev || typeof ev !== 'object') continue;
          const data = ev.data as { title?: unknown } | undefined;
          if (ev.type === 'session/title' && data && typeof data.title === 'string') rec.title = data.title;
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
    const count = rec.hasTurnEvents ? turnEnds : assistantMessages;
    if (live && count > 0) this.emit(rec, count);
    return count > 0;
  }

  private emit(rec: FileRecord, count: number): void {
    const h = rec.header || ({} as SessionHeader);
    if (Number(h.delegationDepth) > 0) return; // 子代理日志对通知是噪音
    let title = 'DSH 任务完成';
    if (rec.title) {
      title = rec.title;
    }
    const cwd = typeof h.cwd === 'string' ? h.cwd : null;
    const cwdBase = cwd ? path.basename(cwd) : null;
    const sid = typeof h.id === 'string' ? h.id : null;
    const shortId = sid ? sid.slice(-8) : null;
    let body = [cwdBase, shortId ? '会话 ' + shortId : null].filter(Boolean).join(' · ');
    body += count > 1 ? '（' + count + ' 轮任务完成）' : '';
    try {
      this.onTurnEnd({ title, body, sessionId: sid, cwd });
    } catch (err) {
      this.log('watch', 'onTurnEnd 回调异常: ' + String((err as Error).message));
    }
  }
}

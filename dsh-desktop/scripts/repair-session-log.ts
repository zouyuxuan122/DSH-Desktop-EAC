'use strict';
// 修复被拼接/撕裂的 dsh 会话日志：保留 header + live epoch，对 live epoch 缺失
// 的种子事件做「重编号安全」的合成，把 stale epoch 归档为独立会话，并备份
// 原文件。写盘前先验证密度。
//
//   node scripts/repair-session-log.js <session.jsonl.zstd>

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import { scanZstdFrames, type ZstdFrame } from './zstd-frames.js';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/repair-session-log.js <session.jsonl.zstd>');
  process.exit(2);
}
const dir = path.dirname(file);
const buf = fs.readFileSync(file);
console.log(`input: ${file} (${buf.length} bytes)`);

/** 展开后的会话事件（或原始行）。seq 为事件序号，chunk 行展开后逐成员递增。 */
type EventRow = Record<string, unknown>;

function decodeFrame(b: Buffer, frame: ZstdFrame): string {
  return zlib.zstdDecompressSync(b.subarray(frame.start, frame.end)).toString('utf8');
}

// 镜像 @deepseek-ai/dsh-session 的 decodeStorageRecord：chunk 行展开为
// assistant/chunk 事件，seq = row.seq0 + k（成员是纯字符串）。
function expandRow(row: unknown): EventRow[] {
  if (!row || typeof row !== 'object') return [];
  const r = row as EventRow;
  switch (r.type) {
    case 'text-chunks':
    case 'reasoning-chunks':
    case 'tool-call-chunks': {
      const data = (r.data && typeof r.data === 'object' ? r.data : {}) as EventRow;
      const members = r.type === 'tool-call-chunks' ? data.args : data.texts;
      if (!Array.isArray(members)) return [r];
      const seq0 = typeof r.seq0 === 'number' ? r.seq0 : 0;
      const events: EventRow[] = [];
      for (let k = 0; k < members.length; k++) {
        events.push({ type: 'assistant/chunk', seq: seq0 + k, time: r.time0 });
      }
      return events;
    }
    default:
      return [r];
  }
}

// Pass 1：全部解压、展开行、验证 seq 密度并定位断档。
const { frames, tornStart } = scanZstdFrames(buf);
if (tornStart !== undefined) {
  console.error(`ABORT: torn tail at ${tornStart}`);
  process.exit(2);
}
console.log(`frames=${frames.length}`);

interface GapInfo {
  expected: number;
  got: number;
  type: unknown;
  time: unknown;
}

let counter = 0; // 下一个展开事件应有的 seq
let gapAtFrame = -1;
let gapInfo: GapInfo | null = null;
let totalEvents = 0;
let lastSeqSeen = -1;
const rowsByFrame: unknown[][] = [];
for (let fi = 0; fi < frames.length; fi++) {
  const frame = frames[fi];
  if (!frame) continue;
  let text: string;
  try {
    text = decodeFrame(buf, frame);
  } catch (e) {
    console.error(`ABORT: frame ${fi} decode failed: ${(e as Error).message}`);
    process.exit(2);
  }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      console.error(`ABORT: unparsable row in frame ${fi}`);
      process.exit(2);
    }
    rows.push(row);
    if (fi === 0) continue; // header 行没有 seq
    for (const ev of expandRow(row)) {
      if (!ev || typeof ev !== 'object') continue;
      const seq = ev.seq;
      if (typeof seq !== 'number') {
        console.error(`ABORT: frame ${fi} event without numeric seq: ${JSON.stringify(ev).slice(0, 120)}`);
        process.exit(2);
      }
      if (seq !== counter && gapAtFrame === -1) {
        gapAtFrame = fi;
        gapInfo = { expected: counter, got: seq, type: ev.type, time: ev.time };
      }
      counter = seq + 1;
      lastSeqSeen = seq;
      totalEvents += 1;
    }
  }
  rowsByFrame.push(rows);
}
if (gapAtFrame === -1 || !gapInfo) {
  console.log('no gap found — file already dense; nothing to repair');
  process.exit(0);
}
console.log(`gap at frame ${gapAtFrame}: expected seq ${gapInfo.expected}, got ${gapInfo.got} (${String(gapInfo.type)} @ ${String(gapInfo.time)})`);
console.log(`totalEvents=${totalEvents} lastSeq=${lastSeqSeen} (file expects next=${counter})`);

// 检出断档的帧即 live epoch 的首帧。
const liveStartFrame = gapAtFrame;
if (liveStartFrame === -1) {
  console.error('ABORT: could not locate live epoch start');
  process.exit(2);
}
console.log(`live epoch starts at frame ${liveStartFrame}; stale epoch = frames 1..${liveStartFrame - 1}`);

// live epoch 单独的密度校验（必须恰为 gapInfo.got .. lastSeqSeen 连续）。
let liveCounter = gapInfo.got;
let liveDense = true;
for (let fi = liveStartFrame; fi < frames.length; fi++) {
  for (const row of rowsByFrame[fi] ?? []) {
    for (const ev of expandRow(row)) {
      if (ev && typeof ev.seq === 'number') {
        if (ev.seq !== liveCounter) {
          console.error(`ABORT: live epoch not dense at frame ${fi}: expected ${liveCounter}, got ${ev.seq}`);
          liveDense = false;
        }
        liveCounter = ev.seq + 1;
      }
    }
  }
}
if (!liveDense) process.exit(2);
console.log(`live epoch dense: seqs ${gapInfo.got}..${lastSeqSeen} (${liveCounter - gapInfo.got} events)`);

// stale epoch 尾部必须以 turn/end 收束（干净的归档边界）。
const staleTailRows = rowsByFrame[liveStartFrame - 1] ?? [];
const staleLastEvents: EventRow[] = [];
for (const row of staleTailRows) {
  for (const ev of expandRow(row)) {
    if (ev && typeof ev.seq === 'number') staleLastEvents.push(ev);
  }
}
const staleLast = staleLastEvents[staleLastEvents.length - 1];
if (!staleLast || staleLast.type !== 'turn/end') {
  console.error(`ABORT: stale epoch does not end with turn/end (last: ${staleLast && String(staleLast.type)} seq ${staleLast && String(staleLast.seq)})`);
  process.exit(2);
}
const staleTurn = (staleLast.data && typeof staleLast.data === 'object' ? (staleLast.data as EventRow).turn : undefined);
console.log(`stale epoch ends cleanly: ${String(staleLast.type)} seq ${String(staleLast.seq)} turn ${String(staleTurn)}`);

// 读原始 header 行（frame 0）。
const headerFrame = frames[0];
if (!headerFrame) {
  console.error('ABORT: empty log (no header frame)');
  process.exit(2);
}
const headerLine = decodeFrame(buf, headerFrame).split('\n', 1)[0] ?? '';
const header = JSON.parse(headerLine) as EventRow;
console.log(`header id=${String(header.id)} cwd=${String(header.cwd)}`);

// 合成 live epoch 缺失的种子事件（seq 0..gapInfo.got-1）。取值来自 stale
// epoch 自己的种子事件（同策略种子）；time = live epoch 首事件时间。
const seedsNeeded = gapInfo.got; // 需要合成的种子事件数（0..N-1）
const staleSeedEvents: EventRow[] = [];
for (const row of rowsByFrame[1] ?? []) {
  for (const ev of expandRow(row)) {
    if (ev && typeof ev.seq === 'number' && ev.seq < gapInfo.got) staleSeedEvents.push(ev);
  }
}
staleSeedEvents.sort((a, b) => Number(a.seq) - Number(b.seq));
if (staleSeedEvents.length < seedsNeeded) {
  console.error(`ABORT: only ${staleSeedEvents.length} seed templates available, need ${seedsNeeded}`);
  process.exit(2);
}
const t0 = (typeof gapInfo.time === 'number' ? gapInfo.time : null) ?? Date.now();
const seedEvents = staleSeedEvents.slice(0, seedsNeeded).map((ev, i): EventRow => ({
  type: ev.type, seq: i, time: t0, data: ev.data,
}));
console.log(`synthesized ${seedEvents.length} seed events: ${seedEvents.map((e) => `${String(e.type)}(seq ${String(e.seq)})`).join(', ')}`);

const seedFrameBuf = zlib.zstdCompressSync(Buffer.from(seedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'));

// ---- 备份原文件 ----
const bakPath = path.join(dir, `session.jsonl.zstd.corrupt-backup-${Date.now()}`);
fs.writeFileSync(bakPath, buf);
console.log(`backup written: ${bakPath}`);

// ---- 组装修复后的 live 文件：header + 种子 + live 帧 ----
const liveParts = [buf.subarray(headerFrame.start, headerFrame.end), seedFrameBuf];
for (let fi = liveStartFrame; fi < frames.length; fi++) {
  const frame = frames[fi];
  if (frame) liveParts.push(buf.subarray(frame.start, frame.end));
}
const repaired = Buffer.concat(liveParts);

const tmpPath = path.join(dir, `session.jsonl.zstd.${crypto.randomBytes(6).toString('hex')}.tmp`);
fs.writeFileSync(tmpPath, repaired);
let renamed = false;
for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
  try {
    fs.renameSync(tmpPath, file);
    renamed = true;
  } catch (e) {
    console.error(`rename attempt ${attempt + 1} failed: ${(e as Error).message}`);
    if (attempt < 4) {
      const wait = Date.now() + 300;
      while (Date.now() < wait) { /* 自旋等待重试（Windows 文件占用窗口） */ }
    }
  }
}
if (!renamed) {
  console.error('ABORT: could not swap repaired file into place');
  process.exit(2);
}
console.log(`repaired live file written: ${file} (${repaired.length} bytes)`);

// ---- stale epoch 归档为独立会话（会话目录的同级） ----
const archiveId = `session-${crypto.randomUUID()}`;
const archiveDir = path.join(path.dirname(dir), archiveId);
fs.mkdirSync(archiveDir, { recursive: true });
const archiveHeader = {
  type: 'session', version: 0, id: archiveId,
  createdAt: header.createdAt, cwd: header.cwd,
  delegationDepth: header.delegationDepth ?? 0, agentPreset: header.agentPreset ?? 'standard',
};
const archiveHeaderFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(archiveHeader) + '\n', 'utf8'));
const archiveParts = [archiveHeaderFrame];
for (let fi = 1; fi < liveStartFrame; fi++) {
  const frame = frames[fi];
  if (frame) archiveParts.push(buf.subarray(frame.start, frame.end));
}
fs.writeFileSync(path.join(archiveDir, 'session.jsonl.zstd'), Buffer.concat(archiveParts));
console.log(`stale epoch archived as new session: ${archiveId} (${liveStartFrame - 1} frames)`);

// ---- 验证修复后的文件 ----
const vbuf = fs.readFileSync(file);
const v = scanZstdFrames(vbuf);
if (v.tornStart !== undefined) {
  console.error('VERIFY FAILED: torn tail');
  process.exit(3);
}
let vcounter = 0;
let vok = true;
outer:
for (let fi = 0; fi < v.frames.length; fi++) {
  const vframe = v.frames[fi];
  if (!vframe) continue;
  const text = decodeFrame(vbuf, vframe);
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      console.error('VERIFY FAILED: unparsable row');
      process.exit(3);
    }
    if (fi === 0) continue;
    for (const ev of expandRow(row)) {
      if (ev && typeof ev.seq === 'number') {
        if (ev.seq !== vcounter) {
          console.error(`VERIFY FAILED at frame ${fi}: expected ${vcounter}, got ${ev.seq}`);
          vok = false;
          break outer;
        }
        vcounter = ev.seq + 1;
      }
    }
  }
}
console.log(`verify: ${vok ? 'OK' : 'FAILED'} — ${v.frames.length} frames, dense seqs 0..${vcounter - 1}`);
if (!vok) process.exit(3);
console.log('DONE');

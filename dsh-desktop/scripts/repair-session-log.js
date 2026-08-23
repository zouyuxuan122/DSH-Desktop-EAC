'use strict';
// Repair a spliced dsh session log: keep header + live epoch, renumber-safe
// synthesis of the epoch's missing seed events, archive the stale epoch as a
// separate session, backup the original file. Verifies density before writing.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const file = process.argv[2];
const dir = path.dirname(file);
const buf = fs.readFileSync(file);
console.log(`input: ${file} (${buf.length} bytes)`);

const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start };
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
  return { frames };
}

function decodeFrame(b, frame) {
  return zlib.zstdDecompressSync(b.subarray(frame.start, frame.end)).toString('utf8');
}

// Mirrors @deepseek-ai/dsh-session decodeStorageRecord: chunk rows expand to
// assistant/chunk events with seq = row.seq0 + k (members are plain strings).
function expandRow(row) {
  if (!row || typeof row !== 'object') return [];
  switch (row.type) {
    case 'text-chunks':
    case 'reasoning-chunks':
    case 'tool-call-chunks': {
      const members = row.type === 'tool-call-chunks' ? row.data.args : row.data.texts;
      if (!Array.isArray(members)) return [row];
      const events = [];
      for (let k = 0; k < members.length; k++) {
        events.push({ type: 'assistant/chunk', seq: row.seq0 + k, time: row.time0 });
      }
      return events;
    }
    default:
      return [row];
  }
}

// Pass 1: decode everything, expand rows, verify seq density and find the gap.
const { frames, tornStart } = scanZstdFrames(buf);
if (tornStart !== undefined) { console.error(`ABORT: torn tail at ${tornStart}`); process.exit(2); }
console.log(`frames=${frames.length}`);

let counter = 0;           // expected seq for the next expanded event
let gapAtFrame = -1, gapInfo = null;
let totalEvents = 0;
let lastSeqSeen = -1;
const rowsByFrame = [];
for (let fi = 0; fi < frames.length; fi++) {
  let text;
  try { text = decodeFrame(buf, frames[fi]); }
  catch (e) { console.error(`ABORT: frame ${fi} decode failed: ${e.message}`); process.exit(2); }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { console.error(`ABORT: unparsable row in frame ${fi}`); process.exit(2); }
    rows.push(row);
    if (fi === 0) continue; // header row has no seq
    for (const ev of expandRow(row)) {
      if (!ev || typeof ev !== 'object') continue;
      const seq = ev.seq;
      if (typeof seq !== 'number') { console.error(`ABORT: frame ${fi} event without numeric seq: ${JSON.stringify(ev).slice(0, 120)}`); process.exit(2); }
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
if (gapAtFrame === -1) { console.log('no gap found — file already dense; nothing to repair'); process.exit(0); }
console.log(`gap at frame ${gapAtFrame}: expected seq ${gapInfo.expected}, got ${gapInfo.got} (${gapInfo.type} @ ${gapInfo.time})`);
console.log(`totalEvents=${totalEvents} lastSeq=${lastSeqSeen} (file expects next=${counter})`);

// The frame where the gap was detected is the first frame of the live epoch.
const liveStartFrame = gapAtFrame;
if (liveStartFrame === -1) { console.error('ABORT: could not locate live epoch start'); process.exit(2); }
console.log(`live epoch starts at frame ${liveStartFrame}; stale epoch = frames 1..${liveStartFrame - 1}`);

// Density check for the live epoch alone (must be exactly gapInfo.got .. lastSeqSeen).
let liveCounter = gapInfo.got;
let liveDense = true;
for (let fi = liveStartFrame; fi < frames.length; fi++) {
  for (const row of rowsByFrame[fi]) {
    for (const ev of expandRow(row)) {
      if (ev && typeof ev.seq === 'number') {
        if (ev.seq !== liveCounter) { console.error(`ABORT: live epoch not dense at frame ${fi}: expected ${liveCounter}, got ${ev.seq}`); liveDense = false; }
        liveCounter = ev.seq + 1;
      }
    }
  }
}
if (!liveDense) process.exit(2);
console.log(`live epoch dense: seqs ${gapInfo.got}..${lastSeqSeen} (${liveCounter - gapInfo.got} events)`);

// Stale epoch tail must end with a turn/end (clean archive boundary).
const staleTailRows = rowsByFrame[liveStartFrame - 1];
const staleLastEvents = [];
for (const row of staleTailRows) for (const ev of expandRow(row)) if (ev && typeof ev.seq === 'number') staleLastEvents.push(ev);
const staleLast = staleLastEvents[staleLastEvents.length - 1];
if (!staleLast || staleLast.type !== 'turn/end') {
  console.error(`ABORT: stale epoch does not end with turn/end (last: ${staleLast && staleLast.type} seq ${staleLast && staleLast.seq})`);
  process.exit(2);
}
console.log(`stale epoch ends cleanly: ${staleLast.type} seq ${staleLast.seq} turn ${staleLast.data && staleLast.data.turn}`);

// Read the original header line (frame 0).
const headerLine = decodeFrame(buf, frames[0]).split('\n', 1)[0];
const header = JSON.parse(headerLine);
console.log(`header id=${header.id} cwd=${header.cwd}`);

// Synthesize the live epoch's missing seed events (seqs 0..gapInfo.got-1).
// Values are taken from the stale epoch's own seed events (same policy seeds);
// time = the live epoch's first event time.
const seedsNeeded = gapInfo.got; // how many seed events to synthesize (0..N-1)
const staleSeedEvents = [];
for (const row of rowsByFrame[1]) for (const ev of expandRow(row)) if (ev && typeof ev.seq === 'number' && ev.seq < gapInfo.got) staleSeedEvents.push(ev);
staleSeedEvents.sort((a, b) => a.seq - b.seq);
if (staleSeedEvents.length < seedsNeeded) { console.error(`ABORT: only ${staleSeedEvents.length} seed templates available, need ${seedsNeeded}`); process.exit(2); }
const t0 = gapInfo.time ?? Date.now();
const seedEvents = staleSeedEvents.slice(0, seedsNeeded).map((ev, i) => ({
  type: ev.type, seq: i, time: t0, data: ev.data,
}));
console.log(`synthesized ${seedEvents.length} seed events: ${seedEvents.map(e => `${e.type}(seq ${e.seq})`).join(', ')}`);

const seedFrameBuf = zlib.zstdCompressSync(Buffer.from(seedEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8'));

// ---- backup original ----
const bakPath = path.join(dir, `session.jsonl.zstd.corrupt-backup-${Date.now()}`);
fs.writeFileSync(bakPath, buf);
console.log(`backup written: ${bakPath}`);

// ---- build repaired live file: header + seeds + live frames ----
const liveParts = [buf.subarray(frames[0].start, frames[0].end), seedFrameBuf];
for (let fi = liveStartFrame; fi < frames.length; fi++) liveParts.push(buf.subarray(frames[fi].start, frames[fi].end));
const repaired = Buffer.concat(liveParts);

const tmpPath = path.join(dir, `session.jsonl.zstd.${crypto.randomBytes(6).toString('hex')}.tmp`);
fs.writeFileSync(tmpPath, repaired);
let renamed = false;
for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
  try {
    fs.renameSync(tmpPath, file);
    renamed = true;
  } catch (e) {
    console.error(`rename attempt ${attempt + 1} failed: ${e.message}`);
    if (attempt < 4) { const wait = Date.now() + 300; while (Date.now() < wait) {} }
  }
}
if (!renamed) { console.error('ABORT: could not swap repaired file into place'); process.exit(2); }
console.log(`repaired live file written: ${file} (${repaired.length} bytes)`);

// ---- archive the stale epoch as a separate session (sibling of the session dir) ----
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
for (let fi = 1; fi < liveStartFrame; fi++) archiveParts.push(buf.subarray(frames[fi].start, frames[fi].end));
fs.writeFileSync(path.join(archiveDir, 'session.jsonl.zstd'), Buffer.concat(archiveParts));
console.log(`stale epoch archived as new session: ${archiveId} (${liveStartFrame - 1} frames)`);

// ---- verify repaired file ----
const vbuf = fs.readFileSync(file);
const v = scanZstdFrames(vbuf);
if (v.tornStart !== undefined) { console.error('VERIFY FAILED: torn tail'); process.exit(3); }
let vcounter = 0, vok = true;
outer:
for (let fi = 0; fi < v.frames.length; fi++) {
  const text = decodeFrame(vbuf, v.frames[fi]);
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { console.error('VERIFY FAILED: unparsable row'); process.exit(3); }
    if (fi === 0) continue;
    for (const ev of expandRow(row)) {
      if (ev && typeof ev.seq === 'number') {
        if (ev.seq !== vcounter) { console.error(`VERIFY FAILED at frame ${fi}: expected ${vcounter}, got ${ev.seq}`); vok = false; break outer; }
        vcounter = ev.seq + 1;
      }
    }
  }
}
console.log(`verify: ${vok ? 'OK' : 'FAILED'} — ${v.frames.length} frames, dense seqs 0..${vcounter - 1}`);
if (!vok) process.exit(3);
console.log('DONE');

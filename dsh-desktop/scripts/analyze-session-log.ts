'use strict';
// 一次性诊断工具：解压 dsh 会话日志（zstd 帧拼接）并定位 seq 断档，
// 镜像 dsh 自带 reader 的读取方式。
//
//   node scripts/analyze-session-log.js <session.jsonl.zstd>

import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { scanZstdFrames } from './zstd-frames.js';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/analyze-session-log.js <session.jsonl.zstd>');
  process.exit(2);
}
const buf = fs.readFileSync(file);
console.log(`file=${file} bytes=${buf.length}`);

/** 解析出的一行日志（seq 缺失时为 null，type 标注解析状态）。 */
interface LogRow {
  line: number;
  seq: number | null;
  type: unknown;
  time: unknown;
  frame?: number;
  raw?: string;
}

const { frames, tornStart } = scanZstdFrames(buf);
console.log(`frames=${frames.length} tornStart=${tornStart === undefined ? 'none' : tornStart}`);

const rows: LogRow[] = [];
let lineNo = 0;
for (const [fi, { start, end }] of frames.entries()) {
  let text: string;
  try {
    text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
  } catch (e) {
    console.log(`frame#${fi} decode FAILED: ${(e as Error).message}`);
    continue;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    lineNo += 1;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      rows.push({ line: lineNo, seq: null, type: 'PARSE-ERR', time: null, raw: line.slice(0, 120) });
      continue;
    }
    if (!row || typeof row !== 'object') {
      rows.push({ line: lineNo, seq: null, type: String(row), time: null, raw: line.slice(0, 120) });
      continue;
    }
    const r = row as Record<string, unknown>;
    const data = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
    rows.push({
      line: lineNo,
      seq: typeof r.seq === 'number' ? r.seq : null,
      type: r.type,
      time: r.time ?? data.time ?? data.timestamp ?? null,
      frame: fi,
    });
  }
}
console.log(`totalLines=${rows.length}`);

console.log('\n--- first 6 rows ---');
for (const r of rows.slice(0, 6)) console.log(JSON.stringify(r));
console.log('--- last 6 rows ---');
for (const r of rows.slice(-6)) console.log(JSON.stringify(r));
console.log('--- rows around line 13210 ---');
for (const r of rows.slice(13198, 13222)) console.log(JSON.stringify(r));

console.log('\n--- seq discontinuities ---');
let prev: number | null = null;
let prevLine = 0;
let count = 0;
for (const r of rows) {
  if (r.seq !== null) {
    if (prev !== null && r.seq !== prev + 1) {
      console.log(`line ${prevLine}->${r.line}: seq ${prev} -> ${r.seq}  type=${String(r.type)} frame=${r.frame}`);
      if (++count >= 40) {
        console.log('... (capped)');
        break;
      }
    }
    prev = r.seq;
    prevLine = r.line;
  }
}
if (count === 0) console.log('none');
console.log(`\nlastSeenSeq=${prev} at line ${prevLine}`);

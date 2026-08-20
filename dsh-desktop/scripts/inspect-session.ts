'use strict';
// 用 node:zlib 检查 dsh 会话文件（与 dsh 自身同款编解码器）。
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

const f = process.argv[2];
if (!f) {
  console.error('用法: node scripts/inspect-session.js <session.jsonl.zstd> [尾部行数]');
  process.exit(1);
}
const tailN = Number.parseInt(process.argv[3] || '8', 10) || 8;
const txt = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');
const lines = txt.split('\n').filter(Boolean);
console.log('LINES=' + lines.length);

// 首行必须是会话头。
const header = lines[0];
if (header === undefined) throw new Error('会话文件为空：' + f);
console.log('HEADER=' + header.slice(0, 200));

// 事件类型词表统计。
const typeCounts: Record<string, number> = {};
let jsonOk = 0;
for (const line of lines) {
  try {
    const obj = JSON.parse(line) as { type?: string };
    jsonOk++;
    const t = obj.type ?? '(no type)';
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  } catch { /* 跳过无法解析的行 */ }
}
console.log('jsonOk=' + jsonOk);
console.log('=== event types ===');
for (const [t, n] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(6), t);
}
console.log('=== last ' + tailN + ' lines ===');
for (const line of lines.slice(-tailN)) {
  console.log('----');
  console.log(line.slice(0, 350));
}

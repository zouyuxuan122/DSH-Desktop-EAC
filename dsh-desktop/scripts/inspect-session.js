'use strict';
// Inspect a dsh session file using node:zlib (the same codec dsh itself uses).
const fs = require('node:fs');
const zlib = require('node:zlib');

const f = process.argv[2];
const tailN = parseInt(process.argv[3] || '8', 10);
const txt = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');
const lines = txt.split('\n').filter(Boolean);
console.log('LINES=' + lines.length);

// First line must be the session header.
console.log('HEADER=' + lines[0].slice(0, 200));

// Event type vocabulary.
const typeCounts = {};
let jsonOk = 0;
for (const line of lines) {
  try {
    const obj = JSON.parse(line);
    jsonOk++;
    const t = obj.type || '(no type)';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  } catch { /* skip */ }
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

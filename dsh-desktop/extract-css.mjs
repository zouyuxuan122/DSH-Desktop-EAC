// 提取 SettingsRoot.module.css 的 panel/overlay 规则
import { readFileSync } from 'node:fs';
const t = readFileSync('node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js', 'utf8');
const i = t.indexOf('SettingsRoot.module.css.mjs');
const seg = t.slice(Math.max(0, i - 6000), i);
// css 是转义过的模板串，直接按 VOzbGW 关键词切出相关规则文本
const marker = 'VOzbGW';
let idx = seg.indexOf(marker);
const seen = new Set();
while (idx !== -1 && seen.size < 12) {
  // 规则以 .VOzbGW_xxx{ 开头
  const start = seg.lastIndexOf('.', idx);
  const braceOpen = seg.indexOf('{', idx);
  if (braceOpen === -1) break;
  const depthEnd = braceOpen + 1;
  const rule = seg.slice(start, depthEnd + 260).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  const key = seg.slice(start, braceOpen);
  if (!seen.has(key)) { seen.add(key); console.log('=== ' + key + ' ==='); console.log(rule); console.log(); }
  idx = seg.indexOf(marker, idx + 1);
}

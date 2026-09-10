import fs from 'node:fs';
import { migrateWebuiContinue } from './webui-continue-compat.mjs';

const target = process.argv[2];
if (!target) throw new Error('usage: node patch-webui-continue.mjs <client.js>');

const source = fs.readFileSync(target, 'utf8');
const patched = migrateWebuiContinue(source);
const changed = patched !== source;
if (changed) fs.writeFileSync(target, patched);

console.log(JSON.stringify({
  target,
  changed,
  readableStats: patched.includes('const formatStat = (key, values) => {'),
  rawSpeedRemoved: !patched.includes('stats.tokensPerSecond'),
}));

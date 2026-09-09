import fs from 'node:fs';
import { migrateStatusRotator } from './status-rotator-compat.mjs';

const target = process.argv[2];
if (!target) throw new Error('usage: node patch-status-rotator.mjs <client.js>');

const source = fs.readFileSync(target, 'utf8');
const patched = migrateStatusRotator(source);
const changed = patched !== source;
if (changed) fs.writeFileSync(target, patched);

console.log(JSON.stringify({
  target,
  changed,
  pillDisabled: patched.includes('AIO disables the optional status-rotator Pill.') &&
    patched.includes('cfg.pill = { ...(cfg.pill || {}), enabled: false };'),
}));

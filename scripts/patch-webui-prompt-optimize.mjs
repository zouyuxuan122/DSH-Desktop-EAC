import fs from 'node:fs';
import { migrateWebuiPromptOptimize } from './webui-prompt-optimize-compat.mjs';

const target = process.argv[2];
if (!target) throw new Error('usage: node patch-webui-prompt-optimize.mjs <client.js>');

const source = fs.readFileSync(target, 'utf8');
const patched = migrateWebuiPromptOptimize(source);
const changed = patched !== source;
if (changed) fs.writeFileSync(target, patched);

console.log(JSON.stringify({ target, changed, promptOptimize: patched.includes('const mountPromptOptimize = () => {') }));

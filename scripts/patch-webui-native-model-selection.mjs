import fs from 'node:fs';
import { migrateWebuiNativeModelSelection } from './webui-native-model-selection-compat.mjs';

const target = process.argv[2];
if (!target) throw new Error('usage: node patch-webui-native-model-selection.mjs <client.js>');

const source = fs.readFileSync(target, 'utf8');
const patched = migrateWebuiNativeModelSelection(source);
const changed = patched !== source;
if (changed) fs.writeFileSync(target, patched);

console.log(JSON.stringify({ target, changed, nativeModelSelection: patched.includes('AIO keeps provider/model selection in the host native control.') }));

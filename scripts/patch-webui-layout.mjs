import fs from 'node:fs';
import { migrateWebuiLayout } from './webui-layout-compat.mjs';

const target = process.argv[2];
if (!target) throw new Error('usage: node patch-webui-layout.mjs <client.js>');

const source = fs.readFileSync(target, 'utf8');
const patched = migrateWebuiLayout(source);
const changed = patched !== source;
if (changed) fs.writeFileSync(target, patched);

console.log(JSON.stringify({
  target,
  changed,
  usageNavigation: patched.includes('children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageWorkbenchEntry, {})'),
}));

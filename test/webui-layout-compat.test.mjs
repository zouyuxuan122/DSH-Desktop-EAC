import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateWebuiLayout } from '../scripts/webui-layout-compat.mjs';
import { migrateStatusRotator } from '../scripts/status-rotator-compat.mjs';

const usage = 'name: "usage",\n\t\t\t\tchildren: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageWorkbenchEntry, {})';
test('AIO removes only the WebUI usage/balance sidebar portal', () => {
  const source = `prefix\n${usage}\nname: "skills",\nchildren: SkillsEntry\nsuffix`;
  const patched = migrateWebuiLayout(source);
  assert.match(patched, /name: "usage",\n\t\t\t\tchildren: null/);
  assert.match(patched, /name: "skills",\nchildren: SkillsEntry/);
  assert.equal(migrateWebuiLayout(patched), patched);
});

test('AIO disables the status-rotator pill after all config sources merge', () => {
  const source = '\t\t\t\tconfig = cfg;\n';
  const patched = migrateStatusRotator(source);
  assert.ok(patched.includes('cfg.pill = { ...(cfg.pill || {}), enabled: false };'));
  assert.equal(migrateStatusRotator(patched), patched);
  const crlf = migrateStatusRotator(source.replace(/\n/g, '\r\n'));
  assert.ok(crlf.includes('\r\n'));
  assert.ok(!/(?<!\r)\n/.test(crlf));
});

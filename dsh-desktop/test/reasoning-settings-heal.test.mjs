import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  removeUnsupportedOffReasoning,
  healUnsupportedOffReasoning,
} = require('../reasoning-settings-heal.js');

test('removes off from a third-party default model', () => {
  const before = [
    'agent-default-model:',
    '  provider: q',
    '  model: gpt-5.6-sol',
    '  reasoningEffort: off',
    'other:',
    '  enabled: true',
    '',
  ].join('\n');
  const result = removeUnsupportedOffReasoning(before);
  assert.equal(result.changed, true);
  assert.equal(result.provider, 'q');
  assert.equal(result.text, before.replace('  reasoningEffort: off\n', ''));
});

test('preserves official providers and supported third-party levels', () => {
  const official = 'agent-default-model:\n  provider: deepseek-official\n  reasoningEffort: off\n';
  assert.deepEqual(removeUnsupportedOffReasoning(official), {
    text: official,
    changed: false,
    provider: 'deepseek-official',
  });

  const high = 'agent-default-model:\n  provider: q\n  reasoningEffort: high\n';
  assert.deepEqual(removeUnsupportedOffReasoning(high), {
    text: high,
    changed: false,
    provider: 'q',
  });
});

test('preserves BOM and CRLF while removing quoted off', () => {
  const before = '\uFEFFagent-default-model:\r\n  provider: "q"\r\n  reasoningEffort: "off" # UI value\r\n';
  const result = removeUnsupportedOffReasoning(before);
  assert.equal(result.changed, true);
  assert.equal(result.text, '\uFEFFagent-default-model:\r\n  provider: "q"\r\n');
});

test('skips unsupported inline YAML instead of rewriting it', () => {
  const before = 'agent-default-model: { provider: q, reasoningEffort: off }\n';
  assert.equal(removeUnsupportedOffReasoning(before).changed, false);
});

test('heals settings.yaml idempotently on disk', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reasoning-heal-'));
  try {
    const file = join(home, 'settings.yaml');
    writeFileSync(file, 'agent-default-model:\n  provider: q\n  model: gpt-5.6-sol\n  reasoningEffort: off\n');
    assert.equal(healUnsupportedOffReasoning(home), 'healed');
    assert.equal(healUnsupportedOffReasoning(home), 'kept');
    assert.equal(readFileSync(file, 'utf8'), 'agent-default-model:\n  provider: q\n  model: gpt-5.6-sol\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const {
  MANAGED_PRESETS,
  migrateManagedCompactPresets,
  migratePresetFile,
  parsePreset,
  replaceCompactionGroup,
} = require('../compact-preset-migrate.js')

test('dsh-compact migration: replaces the complete known compaction group with one agent entry', () => {
  const before = [
    '- id: before',
    "  name: 'before'",
    '# ── compaction ──────────────────────────────────────────────────────────────',
    '',
    '# stale compaction-basic explanation',
    '- id: compaction',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    compaction: true',
    '    toolResultPruner: true',
    '  config:',
    '    - id: compaction-basic',
    "      name: '@deepseek-ai/dsh-compaction-basic'",
    '    - id: command-compact',
    "      name: '@deepseek-ai/dsh-command-compact'",
    '    - id: tool-result-pruner',
    "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '- id: after',
    "  name: 'after'",
    '',
  ].join('\n')
  const result = replaceCompactionGroup(before)
  assert.equal(result.changed, true)
  assert.match(result.text, /- id: compact-agent\n  name: 'dsh-compact\/agent'/)
  assert.doesNotMatch(result.text, /id: compaction-basic|id: command-compact|id: tool-result-pruner/)
  assert.doesNotMatch(result.text, /stale compaction-basic explanation/)
  assert.match(result.text, /single product-level entry/)
  assert.match(result.text, /- id: before/)
  assert.match(result.text, /- id: after/)
  parsePreset(result.text)
})

test('dsh-compact migration: creates one backup and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compact-migrate-'))
  try {
    const file = join(dir, 'agent.cordis.yml')
    const before = [
      "- id: platform",
      "  name: 'x'",
      "  disabled: !!js process.platform !== 'win32'",
      '- id: compaction',
      '  name: cordis:group',
      '  group: true',
      '  isolate:',
      '    compaction: true',
      '    toolResultPruner: true',
      '  config:',
      '    - id: compaction-basic',
      "      name: 'dsh-compact/engine'",
      '    - id: command-compact',
      "      name: '@deepseek-ai/dsh-command-compact'",
      '    - id: tool-result-pruner',
      "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      '      config:',
      '        thresholdChars: 9000',
      '        headChars: 5000',
      '        tailChars: 1200',
      '',
      '# ── delegation and workflows ────────────────────────────────────────────────',
      '# this comment must survive migration',
      '- id: delegation',
      '  name: cordis:group',
      '',
    ].join('\r\n')
    writeFileSync(file, before)
    assert.equal(migratePresetFile(file).status, 'migrated')
    assert.equal(readFileSync(file + '.bak', 'utf8'), before)
    const migrated = readFileSync(file, 'utf8')
    assert.match(migrated, /dsh-compact\/agent/)
    assert.match(migrated, /!!js process\.platform/)
    assert.match(migrated, /thresholdChars: 9000/)
    assert.match(migrated, /headChars: 5000/)
    assert.match(migrated, /tailChars: 1200/)
    assert.match(migrated, /this comment must survive migration/)
    assert.equal(migrated.includes('\r\n'), true)
    assert.equal(migratePresetFile(file).status, 'kept')
    assert.equal(readFileSync(file + '.bak', 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dsh-compact migration: invalid YAML is never modified or backed up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compact-invalid-'))
  try {
    const file = join(dir, 'agent.cordis.yml')
    const before = "config: [\n  - id: compaction-basic\n    name: '@deepseek-ai/dsh-compaction-basic'\n"
    writeFileSync(file, before)
    assert.equal(migratePresetFile(file).status, 'invalid')
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.equal(existsSync(file + '.bak'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dsh-compact migration: accepts BOM and preserves !!js as inert data', () => {
  const source = [
    '\uFEFF- id: platform',
    "  name: 'x'",
    "  disabled: !!js (() => { throw new Error('must not execute') })()",
    '- id: compaction',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    compaction: true',
    '    toolResultPruner: true',
    '  config:',
    '    - id: compaction-basic',
    "      name: '@deepseek-ai/dsh-compaction-basic'",
    '    - id: command-compact',
    "      name: '@deepseek-ai/dsh-command-compact'",
    '    - id: tool-result-pruner',
    "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '',
  ].join('\n')
  const parsed = parsePreset(source)
  assert.deepEqual(parsed[0].disabled, { __jsExpr: "(() => { throw new Error('must not execute') })()" })
  const result = replaceCompactionGroup(source)
  assert.equal(result.changed, true)
  assert.equal(result.text.charCodeAt(0), 0xFEFF)
  assert.match(result.text, /!!js \(\(\) =>/)
})

test('dsh-compact migration: leaves incomplete or unfamiliar compaction groups untouched', () => {
  const before = [
    '- id: compaction',
    '  name: cordis:group',
    '  group: true',
    '  config:',
    '    - id: compaction-basic',
    "      name: '@deepseek-ai/dsh-compaction-basic'",
    '',
  ].join('\n')
  assert.deepEqual(replaceCompactionGroup(before), { text: before, changed: false })
})

test('dsh-compact migration: only scans EAC-managed preset names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compact-managed-'))
  try {
    for (const name of [...MANAGED_PRESETS, 'custom-user-preset']) {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(
        join(dir, name, 'agent.cordis.yml'),
        [
          '- id: compaction',
          '  name: cordis:group',
          '  group: true',
          '  isolate:',
          '    compaction: true',
          '    toolResultPruner: true',
          '  config:',
          '    - id: compaction-basic',
          "      name: '@deepseek-ai/dsh-compaction-basic'",
          '    - id: command-compact',
          "      name: '@deepseek-ai/dsh-command-compact'",
          '    - id: tool-result-pruner',
          "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
          '',
        ].join('\n'),
      )
    }
    migrateManagedCompactPresets(dir)
    for (const name of MANAGED_PRESETS) {
      assert.match(readFileSync(join(dir, name, 'agent.cordis.yml'), 'utf8'), /dsh-compact\/agent/)
    }
    assert.match(
      readFileSync(join(dir, 'custom-user-preset', 'agent.cordis.yml'), 'utf8'),
      /@deepseek-ai\/dsh-compaction-basic/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

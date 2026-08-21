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
  replaceCompactionEngine,
} = require('../compact-preset-migrate.js')

test('dsh-compact migration: only replaces the exact compaction-basic row', () => {
  const before = [
    'config:',
    '  - id: compaction-basic',
    "    name: '@deepseek-ai/dsh-compaction-basic'",
    '  - id: other',
    "    name: '@deepseek-ai/dsh-compaction-basic'",
    "note: '@deepseek-ai/dsh-compaction-basic'",
    '',
  ].join('\n')
  const result = replaceCompactionEngine(before)
  assert.equal(result.changed, true)
  assert.match(result.text, /id: compaction-basic\n\s+name: 'dsh-compact\/engine'/)
  assert.match(result.text, /id: other\n\s+name: '@deepseek-ai\/dsh-compaction-basic'/)
  assert.match(result.text, /note: '@deepseek-ai\/dsh-compaction-basic'/)
})

test('dsh-compact migration: creates one backup and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compact-migrate-'))
  try {
    const file = join(dir, 'agent.cordis.yml')
    const before = "config:\n  - id: compaction-basic\n    name: '@deepseek-ai/dsh-compaction-basic'\n"
    writeFileSync(file, before)
    assert.equal(migratePresetFile(file).status, 'migrated')
    assert.equal(readFileSync(file + '.bak', 'utf8'), before)
    const migrated = readFileSync(file, 'utf8')
    assert.match(migrated, /dsh-compact\/engine/)
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

test('dsh-compact migration: only scans EAC-managed preset names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compact-managed-'))
  try {
    for (const name of [...MANAGED_PRESETS, 'custom-user-preset']) {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(
        join(dir, name, 'agent.cordis.yml'),
        "config:\n  - id: compaction-basic\n    name: '@deepseek-ai/dsh-compaction-basic'\n",
      )
    }
    migrateManagedCompactPresets(dir)
    for (const name of MANAGED_PRESETS) {
      assert.match(readFileSync(join(dir, name, 'agent.cordis.yml'), 'utf8'), /dsh-compact\/engine/)
    }
    assert.match(
      readFileSync(join(dir, 'custom-user-preset', 'agent.cordis.yml'), 'utf8'),
      /@deepseek-ai\/dsh-compaction-basic/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

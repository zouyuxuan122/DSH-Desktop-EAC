import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const main = readFileSync(join(root, 'main.js'), 'utf8')

test('dsh-compact integration: new plugin is bundled and old browser trigger is retired', () => {
  assert.match(main, /\{ id: 'compact', name: 'dsh-compact', dir: 'dsh-compact' \}/)
  assert.doesNotMatch(
    main.slice(main.indexOf('const COMPANION_PLUGINS'), main.indexOf('const PLUGIN_UPDATE_SOURCES')),
    /\{ id: 'auto-compact'/,
  )
  assert.match(main, /\{ id: 'auto-compact', name: 'dsh-auto-compact' \}/)
  for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE', 'lib/index.js', 'lib/engine.js', 'lib/policy.js', 'lib/client.js']) {
    assert.equal(existsSync(join(root, 'assets', 'plugins', 'dsh-compact', file)), true, `missing ${file}`)
  }
  const client = readFileSync(join(root, 'assets', 'plugins', 'dsh-compact', 'lib', 'client.js'), 'utf8')
  assert.doesNotMatch(client, /inputActions|setDraft\s*\(|\.submit\s*\(/)
  assert.match(client, /dsh-auto-compact-config-v1/)
})

test('dsh-compact integration: package is core because managed presets depend on it', async () => {
  const onboarding = await import('../scripts/onboarding.js')
  assert.equal(onboarding.default.CORE_PLUGIN_IDS.has('compact'), true)
  assert.match(main, /核心插件不可停用/)
})

test('dsh-compact integration: every managed preset has exactly one compaction service', async () => {
  const migration = await import('../compact-preset-migrate.js')
  for (const name of migration.default.MANAGED_PRESETS) {
    const file = join(root, 'assets', 'agent-presets', name, 'agent.cordis.yml')
    const text = readFileSync(file, 'utf8')
    assert.equal((text.match(/id:\s*compaction-basic/g) ?? []).length, 1, `${name} compaction id count`)
    assert.equal((text.match(/name:\s*['"]dsh-compact\/engine['"]/g) ?? []).length, 1, `${name} engine count`)
    assert.equal(text.includes('@deepseek-ai/dsh-compaction-basic'), false, `${name} retains old engine`)
    assert.match(text, /name:\s*['"]@deepseek-ai\/dsh-command-compact['"]/, `${name} lost /compact command`)
  }
})

test('dsh-compact integration: migration helper is included in packaged app', () => {
  const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  assert.match(builder, /- compact-preset-migrate\.js/)
  assert.match(builder, /- assets\/\*\*\/\*/)
})

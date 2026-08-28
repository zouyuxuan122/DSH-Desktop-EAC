import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import * as CompactAgent from '../assets/plugins/dsh-compact/lib/agent.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// ADR 0002：注册表迁至 lib/desktop/companion-sync.js，启停文案迁至 plugin-ops.js。
const main = readFileSync(join(root, 'lib', 'desktop', 'companion-sync.ts'), 'utf8')
const pluginOpsSrc = readFileSync(join(root, 'lib', 'desktop', 'plugin-ops.ts'), 'utf8')

test('dsh-compact integration: new plugin is bundled and old browser trigger is retired', () => {
  assert.match(main, /\{ id: 'compact', name: 'dsh-compact', dir: 'dsh-compact' \}/)
  assert.doesNotMatch(
    main.slice(main.indexOf('const COMPANION_PLUGINS'), main.indexOf('const PLUGIN_UPDATE_SOURCES')),
    /\{ id: 'auto-compact'/,
  )
  assert.match(main, /\{ id: 'auto-compact', name: 'dsh-auto-compact' \}/)
  for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE', 'lib/index.js', 'lib/agent.js', 'lib/engine.js', 'lib/policy.js', 'lib/client.js']) {
    assert.equal(existsSync(join(root, 'assets', 'plugins', 'dsh-compact', file)), true, `missing ${file}`)
  }
  const client = readFileSync(join(root, 'assets', 'plugins', 'dsh-compact', 'lib', 'client.js'), 'utf8')
  assert.doesNotMatch(client, /inputActions|setDraft\s*\(|\.submit\s*\(/)
  assert.match(client, /dsh-auto-compact-config-v1/)
})

test('dsh-compact integration: package is core because managed presets depend on it', async () => {
  const onboarding = await import('../scripts/onboarding.js')
  assert.equal(onboarding.default.CORE_PLUGIN_IDS.has('compact'), true)
  assert.match(pluginOpsSrc, /核心插件不可停用/)
})

test('dsh-compact integration: every managed preset exposes one composite compact entry', async () => {
  const migration = await import('../compact-preset-migrate.js')
  for (const name of migration.default.MANAGED_PRESETS) {
    const file = join(root, 'assets', 'agent-presets', name, 'agent.cordis.yml')
    const text = readFileSync(file, 'utf8')
    assert.equal((text.match(/id:\s*compact-agent/g) ?? []).length, 1, `${name} compact-agent count`)
    assert.equal((text.match(/name:\s*['"]dsh-compact\/agent['"]/g) ?? []).length, 1, `${name} agent entry count`)
    assert.equal((text.match(/id:\s*compaction-basic/g) ?? []).length, 0, `${name} exposes engine row`)
    assert.equal((text.match(/id:\s*command-compact/g) ?? []).length, 0, `${name} exposes command row`)
    assert.equal((text.match(/id:\s*tool-result-pruner/g) ?? []).length, 0, `${name} exposes pruner row`)
    assert.equal(text.includes('@deepseek-ai/dsh-compaction-basic'), false, `${name} retains old engine`)
  }
})

test('dsh-compact integration: plugin inventory hides implementation-level compact entries', () => {
  const client = readFileSync(join(root, 'assets', 'plugins', 'dsh-compact', 'lib', 'client.js'), 'utf8')
  for (const id of ['compaction-basic', 'command-compact', 'tool-result-pruner', 'compact-agent']) {
    assert.match(client, new RegExp(`data-plugin-entry.*${id}`), `inventory filter missing ${id}`)
  }
})

test('dsh-compact integration: composite agent starts engine, command and pruner together', async () => {
  const ctx = new Context()
  let compactCommand

  class StubService extends Service {
    constructor(context, name) {
      super(context, name)
    }
  }
  class Commands extends Service {
    constructor(context) {
      super(context, 'commands')
    }
    register(command) {
      compactCommand = command
      return () => {
        if (compactCommand === command) compactCommand = undefined
      }
    }
  }

  const providers = await Promise.all([
    ctx.plugin(class Llm extends StubService {
      constructor(context) { super(context, 'llm') }
    }),
    ctx.plugin(class TokenMeter extends StubService {
      constructor(context) { super(context, 'tokenMeter') }
    }),
    ctx.plugin(class Sessions extends StubService {
      constructor(context) { super(context, 'sessions') }
    }),
    ctx.plugin(Commands),
  ])

  const handle = ctx.plugin(CompactAgent)
  await handle.await()
  assert.equal(ctx.get('compaction')?.dshCompact, true)
  assert.ok(ctx.get('toolResultPruner'))
  assert.equal(compactCommand?.name, 'compact')

  await handle.dispose()
  assert.equal(ctx.get('compaction'), undefined)
  assert.equal(ctx.get('toolResultPruner'), undefined)
  assert.equal(compactCommand, undefined)
  await Promise.all(providers.reverse().map((provider) => provider.dispose()))
})

test('dsh-compact integration: migration helper is included in packaged app', () => {
  const stage = readFileSync(join(root, '..', 'tauri-shell', 'stage-resources.mjs'), 'utf8')
  assert.match(stage, /'compact-preset-migrate\.js'/, 'ROOT_FILES 应含 compact-preset-migrate.js')
  assert.match(stage, /cpSync\(path\.join\(dd, 'assets'\)/, 'stage 应整体装配 assets/ 目录')
})

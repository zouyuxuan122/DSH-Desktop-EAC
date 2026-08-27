import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

test('client registers settings.plugin.item with a key for DSH keyed slots', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  let capturedOptions
  const ctx = {
    slots: {
      inject(name, register) {
        assert.equal(name, 'settings.plugin.item')
        register()
      },
      register(options) {
        capturedOptions = options
        return {}
      },
    },
  }

  const React = {
    createElement() {},
    useEffect() {},
    useRef() { return { current: undefined } },
    useState() { return [] },
  }

  let client
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          client = factory((id) => {
            if (id === 'react') return React
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
    },
    console,
  }

  runInNewContext(source, sandbox)
  client.apply(ctx)

  assert.ok(capturedOptions, 'expected settings.plugin.item registration')
  assert.equal(capturedOptions.name, 'settings.plugin.item')
  assert.equal(capturedOptions.key, 'dsh-dafeiyu')
  assert.equal(capturedOptions.id, 'dsh-dafeiyu')
})

test('client apply does not throw when the slot contract changes or fails', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  const React = {
    createElement() {},
    useEffect() {},
    useRef() { return { current: undefined } },
    useState() { return [] },
  }

  let client
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          client = factory((id) => {
            if (id === 'react') return React
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
    },
    console: { error() {} },
  }

  runInNewContext(source, sandbox)

  // DSH may invoke the inject callback asynchronously, so a throw must be
  // contained inside that callback too. A broken card must degrade to "missing",
  // never fail the whole WebUI load.
  let registerAttempted = 0
  let injectAttempted = 0
  const ctx = {
    slots: {
      inject(name, register) {
        injectAttempted += 1
        assert.equal(name, 'settings.plugin.item')
        register() // simulate DSH invoking the card registration later
      },
      register() {
        registerAttempted += 1
        throw new Error('keyed slot settings.plugin.item requires options.key')
      },
    },
  }

  assert.doesNotThrow(() => client.apply(ctx))
  assert.equal(injectAttempted, 1)
  assert.equal(registerAttempted, 1)
})

test('client apply also contains a synchronous inject failure', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  const React = {
    createElement() {},
    useEffect() {},
    useRef() { return { current: undefined } },
    useState() { return [] },
  }

  let client
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          client = factory((id) => {
            if (id === 'react') return React
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
    },
    console: { error() {} },
  }
  runInNewContext(source, sandbox)

  let registerAttempted = 0
  const ctx = {
    slots: {
      inject() { throw new Error('slots service contract changed') },
      register() { registerAttempted += 1 },
    },
  }

  assert.doesNotThrow(() => client.apply(ctx))
  assert.equal(registerAttempted, 0)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createConfigHandler } from '../src/index.js'

function settingsFixture() {
  let value = { enabled: true, scale: 1, bubbleScale: 1, activityLevel: 'normal', reducedMotion: false, soundEnabled: true, includeSubagents: false }
  return {
    get: () => ({ ...value }),
    update: async (patch) => { value = { ...value, ...patch } },
  }
}

async function request(handler, { method = 'GET', body = '', address = '127.0.0.1', origin } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [])
  req.method = method
  req.socket = { remoteAddress: address }
  req.headers = { host: '127.0.0.1:2026', ...(origin ? { origin } : {}) }
  let status
  let payload = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk = '') { payload += chunk },
  }
  await handler(req, res)
  return { status, body: JSON.parse(payload) }
}

test('local config endpoint reads and persists an allowed patch', async () => {
  const settings = settingsFixture()
  const handler = createConfigHandler(settings)
  const initial = await request(handler)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.enabled, true)

  const changed = await request(handler, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false, scale: 0.8, bubbleScale: 0.8, soundEnabled: false }),
    origin: 'http://127.0.0.1:2026',
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.enabled, false)
  assert.equal(changed.body.scale, 0.8)
  assert.equal(changed.body.bubbleScale, 0.8)
  assert.equal(changed.body.soundEnabled, false)
})

test('local config endpoint rejects remote, cross-origin, and unknown writes', async () => {
  const handler = createConfigHandler(settingsFixture())
  assert.equal((await request(handler, { address: '192.168.1.8' })).status, 403)
  assert.equal((await request(handler, { origin: 'https://example.com' })).status, 403)
  assert.equal((await request(handler, { method: 'PATCH', body: '{"surprise":true}' })).status, 400)
})

test('settings client debounces each slider independently', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /sliderTimers = useRef\(new Map\(\)\)/u)
  assert.match(source, /sliderTimers\.current\.get\(field\)/u)
  assert.match(source, /sliderTimers\.current\.set\(field, timer\)/u)
  assert.match(source, /key: 'dsh-dafeiyu'/u)
})

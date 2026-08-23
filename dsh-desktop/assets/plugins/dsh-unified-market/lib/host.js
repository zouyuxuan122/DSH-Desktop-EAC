// dsh-unified-market — 统一插件市场 host 半边（DSH Desktop 内置，EAC 特化）。
//
// 集成三个社区市场的能力，注册一个 HTTP 路由（/api/dsh-unified-market）：
//   · 精选目录（awesome-dsh-plugin.com）—— 离线快照兜底、来源白名单；
//   · GitHub dsh-plugin 生态检索 —— 双镜像抓取、中文简介（README.zh.md）；
//   · npm registry 检索 —— dsh-plugin 关键字、版本对照更新。
//
// EAC 特化（这是 zat / npm 市场在桌面壳里失效的根因修复）：
//   · 所有读写都解析到桌面专属 profile：DSH_DESKTOP_PROFILE → DSH_PROFILE → web
//     （EAC 桌面壳实际跑在 web-desktop，zat 落回 web、marketplace 写死 web，
//      所以它们的一键检测/修复是摆设 —— 扫错目录了）；
//   · 一键检测/一键修复对真实生效的 profile 全量扫描；
//   · 后台自动检测 + 可配置自动升级（默认仅提示）；
//   · 市场自身自更新（作为内置插件，上游发布后经官方 plugin-updater 更新，
//     自带 selfUpdate 检查接口）。
//
// 安装安全链路（沿用官方 webui-market 的成熟设计）：
//   来源白名单 → 冲突预检 → 试装验证（临时 DSH_HOME 实际启动，仅认
//   `dsh web:` 就绪行）→ 安装前快照 → pnpm allowBuilds 放行重试 →
//   第三方本地构建产物保留 → 简单插件热挂载免重启。
// Install/uninstall run as background operations: the route returns an op id
// immediately, the browser polls it, and a hard timeout kills the child so a
// dead network cannot hang the request forever.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
// pnpm 重写 node_modules 前后快照/回填第三方包的本地构建产物
// （meow-memory 等人工补齐的 lib/ 不再被每次安装/更新清掉）。
import { snapshotArtifacts, restoreArtifacts } from './artifact-keep.mjs'
// pnpm 封锁构建脚本（prepare/install）时自动放行并重试，安装
// 不再因为 "allowBuilds 加白名单" 的提示而失败。
import { parseBlockedBuildKeys, readAllowBuilds, ensureAllowBuilds } from './allow-builds.mjs'
// 安装前轻量冲突预检（patch 行/settings 命名空间/核心依赖版本），
// refuse 直接拒绝、warn 由 UI 红字提醒；只读不写。
import { scanCandidate, collectProfileState } from './plugin-conflict-scan.mjs'

export const name = 'dsh-unified-market'

/** 本市场自身版本（与 package.json 同步；自更新检测用）。 */
export const SELF_VERSION = '0.2.1'

/** Hard dependency: the HTTP carrier must exist before the route registers. */
export const inject = ['webServer']

const DEFAULT_TIMEOUT = 120000

/** 后台自动检测间隔（毫秒）：启动 20 秒后首检，之后每 6 小时。 */
const AUTO_CHECK_DELAY = 20000
const AUTO_CHECK_INTERVAL = 6 * 3600 * 1000
/** 落盘节流：同一轮检测赶不上时跳过（防高频重启刷检测）。 */
const AUTO_CHECK_MIN_GAP = 4 * 3600 * 1000
/** GitHub 检索性能阈值。 */
const GH_TIMEOUT_MS = 15000

/** The single live background op (one at a time keeps the CLI's pnpm serial). */
let activeOp = null
let opCounter = 0

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function parseCmd(cmd) {
  if (!cmd) return null
  const m = /^dsh plugin --profile (\S+) (\w+)(?:\s+(\S+))?/.exec(String(cmd).trim())
  if (!m) return null
  return { profile: m[1], action: m[2], source: m[3] || '' }
}

function parseSite(html) {
  const plugins = []
  const cats = []
  const itemRe = /<li class="item"[^>]*data-cat="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g
  let m
  while ((m = itemRe.exec(html)) !== null) {
    const cat = m[1]
    const body = m[2]
    const a = /<a href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(body)
    const by = /<span class="by"[^>]*>([^<]+)<\/span>/.exec(body)
    const p = /<p>([\s\S]*?)<\/p>/.exec(body)
    const cmd = /data-cmd="([^"]+)"/.exec(body)
    const stars = /<span class="stars"[^>]*>\s*★\s*([\d,.]+)/.exec(body)
    if (!a) continue
    const cc = cmd ? parseCmd(cmd[1]) : null
    let name = a[2].trim()
    let owner = by ? by[1].trim() : ''
    // The site used to print the short repo name next to a .by span; it now
    // prints "owner/repo" without a .by span. Split it back so cards keep the
    // short-name + @owner layout (the bundled snapshot predates the redesign).
    if (!owner) {
      const ghOwner = /^https?:\/\/github\.com\/([^/]+)\//.exec(a[1])
      const slash = name.indexOf('/')
      if (ghOwner && slash > 0) {
        owner = ghOwner[1]
        name = name.slice(slash + 1)
      }
    }
    plugins.push({
      cat,
      name,
      url: a[1],
      by: owner,
      desc: p ? decodeEntities(p[1]).replace(/<[^>]+>/g, '').trim() : '',
      cmd: cmd ? cmd[1] : null,
      profile: cc ? cc.profile : 'web',
      source: cc ? cc.source : null,
      stars: stars ? Number(stars[1].replace(/,/g, '')) : null,
      added: null,
    })
  }
  const catRe = /data-cat="([^"]+)">([^<]+)<small>(\d+)<\/small>/g
  while ((m = catRe.exec(html)) !== null) {
    cats.push({ id: m[1], label: m[2].trim(), count: Number(m[3]) })
  }
  return { plugins, cats }
}

function dshHome() {
  return process.env.DSH_HOME || (homedir() + '/.dsh')
}

// Desktop shell runs its web UI on a dedicated profile (web-desktop) so
// installs never collide with the native CLI's 'web' profile; it exports the
// name through DSH_DESKTOP_PROFILE. Standalone (CLI) installs keep 'web'.
// EAC 特化：DSH_DESKTOP_PROFILE 优先，其次 DSH_PROFILE，最后回落 'web'
// （zat 只认 DSH_PROFILE、marketplace 写死 'web'，是它们在桌面壳里
//  一键检测/修复失效的根因 —— 修复点）。
function desktopProfile() {
  const p = process.env.DSH_DESKTOP_PROFILE || process.env.DSH_PROFILE
  if (p && /^[A-Za-z0-9_-]+$/.test(p)) return p
  // 桌面环境下默认使用 web-desktop，避免插件安装到 web profile 而加载时使用 web-desktop profile
  if (process.env.DSH_DESKTOP === '1') return 'web-desktop'
  return 'web'
}

/**
 * Resolve the dsh CLI entry. Prefers the exact entry that launched THIS host
 * process (global bin, local install, or `node --import tsx/esm .../bin.ts`
 * source launch), so installs work in every launch shape; falls back to the
 * checkout's bin or $DSH_BIN.
 * @param {string} [explicit] - a hand-filled CLI path (panel), used verbatim.
 * @returns {{ file: string, args: string[] } | null} argv prefix to re-invoke
 * the CLI: process.execPath + (execArgv for source launches) + the entry.
 * For source launches the caller must use the returned `cwd` (the entry's
 * directory) as the spawn cwd: execArgv loaders like tsx resolve from there,
 * not from the profile directory.
 */
function dshInvoke(explicit) {
  if (explicit && explicit.trim()) {
    return invokeEntry(explicit.trim())
  }
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    return invokeEntry(entry)
  }
  const cand = process.cwd().replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
  try {
    if (existsSync(cand)) return { file: process.execPath, args: [cand], cwd: undefined }
  } catch {}
  if (process.env.DSH_BIN) return invokeEntry(process.env.DSH_BIN)
  return null
}

/**
 * Build the node argv for one CLI entry. A `.ts` entry needs the tsx loader:
 * execArgv loaders do NOT propagate to spawned children, so they are re-added
 * explicitly (deduplicated against what the host already runs under). For
 * source launches cwd is pinned to the entry's directory so the loader can
 * resolve from the harness's node_modules.
 * @returns {{ file: string, args: string[], cwd: string | undefined }}
 */
function invokeEntry(entry) {
  const isTs = /\.ts$/.test(entry)
  const loader = isTs && !process.execArgv.some((a) => String(a).includes('tsx'))
    ? ['--import', 'tsx']
    : []
  return {
    file: process.execPath,
    args: [...process.execArgv, ...loader, entry],
    cwd: isTs ? dirname(entry) : undefined,
  }
}

/** The resolved CLI entry path, for display/probing; null when undetectable. */
function dshBin(explicit) {
  const inv = dshInvoke(explicit)
  return inv === null ? null : inv.args[inv.args.length - 1]
}

function profileDir(profile) {
  return dshHome().replace(/[\\/]+$/, '') + '/profiles/' + profile
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** Same-origin check: the browser's Origin host must equal the request Host. */
function sameOrigin(req) {
  const origin = req.headers && req.headers.origin
  const host = req.headers && req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function validProfile(p) {
  return typeof p === 'string' && /^[A-Za-z0-9_-]+$/.test(p)
}

// 目录条目（官网 HTML）不带 profile，客户端默认填 dsh CLI 生态的 'web'。
// 桌面壳跑在专属 profile（web-desktop，见 main.js DSH_DESKTOP_PROFILE）上，
// profiles/web 并不存在 —— 直接信任 'web' 会让 spawn 以不存在的目录作 cwd，
// Node 把它报成 "spawn <node.exe> ENOENT"（锅记在可执行文件头上，误导排查）。
// 统一把 'web' 映射到桌面 profile；CLI 直连（无 DSH_DESKTOP_PROFILE）时
// desktopProfile() 就是 'web'，映射恒等、行为不变。
function resolveProfile(requested) {
  return requested !== 'web' && validProfile(requested) ? requested : desktopProfile()
}

function opSnapshot() {
  if (!activeOp) return null
  const { id, kind, profile, target, label, startedAt, status, output, exitCode, bin, hot, pendingRestart } = activeOp
  return {
    id, kind, profile, target, label, startedAt,
    status, output: String(output || '').slice(-20000), exitCode,
    elapsedMs: Date.now() - startedAt,
    timeoutMs: DEFAULT_TIMEOUT,
    bin: bin || null,
    hot: hot === true,
    pendingRestart: pendingRestart === true,
  }
}

/** Kill a running child, killing its whole process tree on Windows. */
function killChild(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill()
    }
  } catch {}
}

/** Terminal output cap: pnpm logs can be large; keep the tail only. */
const MAX_OUTPUT = 200000

function appendOutput(op, text) {
  op.output = (op.output + String(text)).slice(-MAX_OUTPUT)
}

/** Settle an op to a terminal status and drop its pending timeout timer. */
function settleOp(op, status, exitCode) {
  clearTimeout(op.timer)
  op.status = status
  if (exitCode !== undefined) op.exitCode = exitCode
}

/** Start one install/uninstall as a background op. Returns { ok, opId? } or { ok, error }. */
function startOp(kind, profile, target, label, explicitBin, initialOutput) {
  profile = resolveProfile(profile)
  const inv = dshInvoke(explicitBin)
  if (!inv) return { ok: false, error: 'dsh CLI 未定位（可在面板填写路径）' }
  const bin = inv.args[inv.args.length - 1]
  const op = {
    id: 'op-' + (++opCounter),
    kind, profile, target, label,
    startedAt: Date.now(),
    status: 'running',
    output: initialOutput || '',
    exitCode: null,
    bin,
    // hot: true when the installed plugin was mounted live (no restart).
    hot: false,
    beforeDeps: readProfileDeps(profile),
  }
  const cwd = inv.cwd ?? profileDir(profile)
  // V4：pnpm（plugin add/remove）会按锁文件重新解包整棵 node_modules，
  // 人工补齐的构建产物（meow-memory 的 lib/ 等）会随之消失。先快照
  // 第三方包，结束后回填（内置包由客户端启动同步重建，无需缓存）。
  try {
    const home0 = dshHome().replace(/[\\/]+$/, '')
    snapshotArtifacts(profileDir(profile), home0 + '/plugin-artifact-cache/' + profile, {
      managedNames: readBuiltinPlugins(profile),
      log: (m) => appendOutput(op, '[keep] ' + m),
    })
  } catch (err) {
    appendOutput(op, '\n[keep] 快照失败（不影响安装）: ' + String((err && err.message) || err))
  }
  // 启动（或重试）一次 pnpm 子进程。retried=true 表示已因 allowBuilds
  // 自动放行而重试过，不再二次重试，避免死循环。
  function startChild(op, retried) {
  const child = spawn(inv.file, [...inv.args, 'plugin', '--profile', profile, kind === 'uninstall' ? 'remove' : 'add', target], {
    cwd,
    // CI=true: pnpm v10 blocks forever on a silent interactive prompt without
    // a TTY (observed on re-add over a pinned git spec); CI forces fail-fast.
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  op.child = child
  child.stdout.on('data', (d) => { appendOutput(op, d.toString()) })
  child.stderr.on('data', (d) => { appendOutput(op, d.toString()) })
  child.on('error', (err) => {
    if (op.status !== 'running') return
    appendOutput(op, '\n[error] ' + String((err && err.message) || err))
    settleOp(op, 'failed')
  })
  child.on('close', async (code) => {
    if (op.status !== 'running') return
    const ok = code === 0
    // V4：pnpm 已退出 —— 回填被重新解包清掉的第三方构建产物（先回填再
    // 热挂载，热挂载读到的才是补齐后的树）。
    try {
      const home0 = dshHome().replace(/[\\/]+$/, '')
      restoreArtifacts(profileDir(op.profile), home0 + '/plugin-artifact-cache/' + op.profile, {
        log: (m) => appendOutput(op, '[keep] ' + m),
      })
    } catch (err) {
      appendOutput(op, '\n[keep] 回填失败: ' + String((err && err.message) || err))
    }
    if (!ok && /EPERM|EBUSY|resource busy|being used by another process/i.test(String(op.output || ''))) {
      // Windows 文件锁：运行中的 web 进程加载了原生模块（如 sqlite-vec 的
      // vec0.dll），pnpm 无法重写其目录。排队到下次服务启动前执行（那时无锁）。
      try {
        writeFileSync(join(profileDir(op.profile), '.dsh-market-pending.json'), JSON.stringify({
          kind: op.kind, target: op.target, label: op.label, profile: op.profile,
          attempts: 0, ts: Date.now(),
        }, null, 2))
        op.pendingRestart = true
        appendOutput(op, '\n[pending] 文件被运行中的服务占用（Windows 文件锁）。任务已排队：重启 Web 服务后自动完成，无需手动重试。\n')
      } catch { /* 标记写入失败则按普通失败处理 */ }
    }
    if (!ok && !retried) {
      // V4.2：pnpm 默认封锁依赖构建脚本（prepare/install），git 源插件必
      // 被拦。从失败输出里解析被锁的包名，自动写入 pnpm-workspace.yaml
      // 的 allowBuilds（兼容旧名 onlyBuiltDependencies）后重试一次。
      const keys = parseBlockedBuildKeys(String(op.output || ''))
      if (keys.length > 0) {
        try {
          const r = ensureAllowBuilds(join(profileDir(op.profile), 'pnpm-workspace.yaml'), keys)
          if (r.wrote) {
            appendOutput(op, '\n[allowBuilds] pnpm 封锁了构建脚本，已自动放行: ' + r.added.join(', ') + '，自动重试一次\n')
            startChild(op, true)
            return
          }
        } catch (err) {
          appendOutput(op, '\n[allowBuilds] 自动放行失败: ' + String((err && err.message) || err))
        }
      }
    }
    if (ok && op.kind === 'install' && hotCtx !== null) {
      // Trial-boot already proved the bundle boots; hot-mount is the bonus
      // that skips the restart. Failure here only falls back to restart.
      const mounted = await tryHotMountAll(hotCtx, op.profile, op.beforeDeps)
      if (mounted) {
        op.hot = true
        appendOutput(op, '\n[hot] 已热挂载（无需重启，刷新页面即可使用）\n')
      } else {
        appendOutput(op, '\n[hot] 热挂载不可用（插件 patch 较复杂或环境不支持），重启 web 后生效\n')
      }
    }
    settleOp(op, ok ? 'done' : 'failed', code)
  })
  op.timer = setTimeout(() => {
    if (op.status !== 'running') return
    appendOutput(op, '\n\n[timeout] 操作超过 ' + Math.round(DEFAULT_TIMEOUT / 1000) + ' 秒未完成，已自动终止（可能是网络不通或 pnpm 卡住，可重试）')
    settleOp(op, 'timeout')
    killChild(child)
  }, DEFAULT_TIMEOUT)
  }
  startChild(op, false)
  activeOp = op
  return { ok: true, opId: op.id }
}

/** Host ctx for hot-mounting, set by apply(); null in headless/test contexts. */
let hotCtx = null

/** Abort the live op (used by the panel's kill button). */
function killOp() {
  const op = activeOp
  if (!op || op.status !== 'running') return { ok: false, error: '没有正在运行的任务' }
  appendOutput(op, '\n\n[killed] 已由用户终止')
  settleOp(op, 'killed')
  killChild(op.child)
  return { ok: true }
}

/** Raw manifest mirrors, tried in order; GitHub raw is unstable behind CN networks. */
const RAW_MIRRORS = [
  'https://raw.githubusercontent.com',
  'https://raw.gitmirror.com',
]

/**
 * Classify a github: source. The only static signal left is the fast path: a
 * manifest that declares a web client half (`dsh.client.platform === 'web'`)
 * is certainly a web-profile plugin and can install without a trial boot.
 * Everything else — including an unfetchable manifest — goes through the boot
 * probe, which decides by actually starting the composed profile.
 * @returns {Promise<{known: boolean, webClient: boolean, fetchFailed?: boolean}>}
 */
async function classifyPlugin(source) {
  const spec = String(source || '')
  const m = /^github:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(spec)
  if (!m) return { known: false, webClient: false } // registry spec — probe decides
  const [, owner, repo] = m
  let pkg
  for (const base of RAW_MIRRORS) {
    try {
      const r = await fetch(`${base}/${owner}/${repo}/HEAD/package.json`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) continue
      pkg = await r.json()
      break
    } catch { /* try next mirror */ }
  }
  if (pkg === undefined || typeof pkg !== 'object') return { known: false, webClient: false, fetchFailed: true }
  const dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  const client = dsh.client
  return { known: true, webClient: client !== undefined && client.platform === 'web' }
}

/**
 * Trial boot probe: prove the candidate boots under the web profile before
 * touching the real one. A throwaway DSH_HOME is seeded with the web profile
 * template, the same `dsh plugin --profile web add` CLI installs the candidate
 * there, then the composed profile is booted on a free OS-assigned port
 * (`--port 0`). Success = the `dsh web:` readiness line appears, which the
 * web-app glue prints only after its Loader tree settles — a failed boot
 * (duplicate services, broken rows) never reaches it and the real boot error
 * is captured instead. The temp home is deleted either way; nothing in the
 * real profile is ever written, so there is nothing to roll back.
 * @param {string} bin - path to the dsh CLI entry (node script).
 * @param {string} source - the install spec (github:, registry, link:, ...).
 * @returns {Promise<{ok: true} | {ok: false, stage: 'install'|'boot', output: string}>}
 */
async function runProbe(explicitBin, source) {
  const inv = dshInvoke(explicitBin)
  if (!inv) return { ok: false, stage: 'install', output: 'dsh CLI 未定位（可在面板填写路径）' }
  const home = mkdtempSync(join(tmpdir(), 'dsh-mkts-probe-'))
  try {
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2) + '\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    // V4.2：试装环境沿用真实 profile 已放行的构建脚本键，试装结论与真实
    // 安装保持一致（真实 profile 放行过的构建依赖不会在试装里误判失败）。
    try {
      const seedKeys = readAllowBuilds(profileDir(desktopProfile()) + '/pnpm-workspace.yaml')
      if (seedKeys.length > 0) ensureAllowBuilds(join(profileDir, 'pnpm-workspace.yaml'), seedKeys)
    } catch {}
    const env = { ...process.env, DSH_HOME: home, CI: 'true' }

    // Outer cwd must let execArgv loaders (tsx) resolve from the harness, not
    // from the profile: `dsh plugin` chdirs into the profile itself, and the
    // trial profile is located via DSH_HOME, so both steps run from inv.cwd.
    const runCwd = inv.cwd ?? profileDir

    // 1) Install the candidate into the trial profile through the SAME CLI path.
    // V4.2：pnpm 封锁构建脚本时从输出解析包名、自动写入试装 workspace 的
    // allowBuilds 后重试（最多一次），避免试装因放行缺失误报失败。
    let install = await spawnCapture(inv.file,
      [...inv.args, 'plugin', '--profile', 'web', 'add', source],
      { cwd: runCwd, env, timeoutMs: PROBE_INSTALL_TIMEOUT })
    if (!install.ok) {
      const keys = parseBlockedBuildKeys(String(install.output || ''))
      if (keys.length > 0) {
        try {
          const r = ensureAllowBuilds(join(profileDir, 'pnpm-workspace.yaml'), keys)
          if (r.wrote) {
            install = await spawnCapture(inv.file,
              [...inv.args, 'plugin', '--profile', 'web', 'add', source],
              { cwd: runCwd, env, timeoutMs: PROBE_INSTALL_TIMEOUT })
          }
        } catch {}
      }
    }
    if (!install.ok) {
      return { ok: false, stage: 'install', output: install.output }
    }

    // 2) Boot the composed trial profile; the readiness line is the verdict.
    const boot = await spawnCapture(inv.file,
      [...inv.args, '--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
      { cwd: runCwd, env, timeoutMs: PROBE_BOOT_TIMEOUT, readyRe: READY_LINE_RE })
    if (boot.ready) return { ok: true }
    return { ok: false, stage: 'boot', output: boot.output }
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
}

/** Spawn one child, capture its output, optionally wait for a readiness line. */
function spawnCapture(exe, args, { cwd, env, timeoutMs, readyRe }) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const onData = (d) => {
      output = (output + String(d)).slice(-MAX_OUTPUT)
      if (readyRe && readyRe.test(output)) {
        finish({ ok: true, ready: true, output })
        killChild(child)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => finish({ ok: false, ready: false, output: output + '\n[error] ' + String((err && err.message) || err) }))
    child.on('close', (code) => finish({ ok: code === 0, ready: false, code, output }))
    const timer = setTimeout(() => {
      finish({ ok: false, ready: false, timedOut: true, output: output + '\n[probe timeout ' + Math.round(timeoutMs / 1000) + 's]' })
      killChild(child)
    }, timeoutMs)
  })
}

/** The web-app readiness line, printed only after the Loader tree settles. */
const READY_LINE_RE = /dsh web:\s+http:\/\//

/** Probe stage timeouts: install may hit the network; boot is local. */
const PROBE_INSTALL_TIMEOUT = 240000
const PROBE_BOOT_TIMEOUT = 120000

/**
 * 隔离预取（stage）：在临时 DSH_HOME 的 web profile 里真正执行一次
 * `dsh plugin add` —— 验证目标可安装「且」把依赖拉到本地（pnpm 全局缓存复用，
 * 第二次装进真实 profile 时快且不重复下载）。失败即返回真实原因，绝不触碰
 * 真实 profile；成功返回后由调用方决定是否写入真实 profile。
 * @returns {Promise<{ok: boolean, output: string}>}
 */
async function stageFetch(target, bin) {
  const inv = dshInvoke(bin)
  if (!inv) return { ok: false, output: 'dsh CLI 未定位' }
  const home = mkdtempSync(join(tmpdir(), 'dsh-um-update-'))
  try {
    const pd = join(home, 'profiles', 'web')
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, 'package.json'), JSON.stringify({
      name: 'dsh-profile-staging', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2) + '\n')
    writeFileSync(join(pd, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(pd, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    const env = { ...process.env, DSH_HOME: home, CI: 'true' }
    const runCwd = inv.cwd ?? pd
    let r = await spawnCapture(inv.file, [...inv.args, 'plugin', '--profile', 'web', 'add', target],
      { cwd: runCwd, env, timeoutMs: PROBE_INSTALL_TIMEOUT })
    // pnpm allowBuilds 拦截：放行后重试一次（镜像真实安装链路的处理）。
    if (!r.ok) {
      const keys = parseBlockedBuildKeys(String(r.output || ''))
      if (keys.length > 0) {
        try {
          const res = ensureAllowBuilds(join(pd, 'pnpm-workspace.yaml'), keys)
          if (res && res.wrote) {
            r = await spawnCapture(inv.file, [...inv.args, 'plugin', '--profile', 'web', 'add', target],
              { cwd: runCwd, env, timeoutMs: PROBE_INSTALL_TIMEOUT })
          }
        } catch { /* keep original failure */ }
      }
    }
    if (!r.ok) return { ok: false, output: String(r.output || '').slice(-260) || '安装失败' }
    return { ok: true, output: '已拉取到本地（隔离安装验证通过，进入安装）' }
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
}

/**
 * 服务启动时消费排队更新（.dsh-market-pending.json）：在服务刚启动的早期窗口
 * 执行 dsh CLI 完成之前因 Windows 文件锁排队的更新；若仍被锁，dsh 会保留
 * pending 供下次启动再试。fire-and-forget，不阻塞启动。
 */
async function consumePendingUpdates(profile) {
  try {
    const marker = join(profileDir(profile), '.dsh-market-pending.json')
    if (!existsSync(marker)) return
    const raw = JSON.parse(readFileSync(marker, 'utf8'))
    const arr = Array.isArray(raw) ? raw : (raw && raw.target ? [raw] : [])
    if (arr.length === 0) return
    const bin = dshBin()
    if (!bin) return
    for (const job of arr) {
      const target = String(job.target || '')
      if (!target) continue
      try {
        const name = String(job.label || target).split('@')[0]
        await runUpdateWithAllowBuilds(profile, target, name, bin)
      } catch { /* item stays for next boot */ }
    }
  } catch { /* unreadable marker — ignore */ }
}

/**
 * Snapshot a profile's manifest before a real install, so a later failure can
 * be rolled back by restoring the file (or simply by `dsh plugin remove`).
 * @returns {string|null} the snapshot path, or null when the profile has no manifest.
 */
function snapshotProfile(profile) {
  try {
    const p = profileDir(profile) + '/package.json'
    if (!existsSync(p)) return null
    const snap = p + '.mkts-snapshot-' + Date.now() + '.json'
    writeFileSync(snap, readFileSync(p, 'utf8'))
    return snap
  } catch { return null }
}

/**
 * Source whitelist: only sources listed in the curated catalog are
 * installable, mirroring dsh-market's registry gate. `list` results (the
 * awesome-dsh-plugin.com catalog) are the whitelist. Unfetchable catalog or a
 * registry/link spec degrades to allow — the trial boot still guards boot
 * safety, and skipCheck bypasses this gate entirely.
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
async function whitelistSource(target, plugins) {
  const spec = String(target || '').trim()
  if (!spec || !/^github:/.test(spec)) return { allowed: true } // registry/link — not gated
  if (!Array.isArray(plugins) || plugins.length === 0) return { allowed: true } // no catalog — degrade open
  const normalized = (s) => String(s).replace(/^github:/i, '').replace(/\.git$/, '').toLowerCase()
  const needle = normalized(spec)
  const hit = plugins.some((p) => p.source && normalized(p.source) === needle)
  // 统一市场放宽：GitHub 生态源不再强制要求精选目录收录（目录外同样放行），
  // 真实安全闸门由后续的冲突预检 + 试装验证（实际启动判定）承担；
  // 目录内命中则照旧直接放行、无需试装。
  return { allowed: true, curated: hit }
}

function repoNameOf(url) {
  const t = String(url || '').replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  return i >= 0 ? t.slice(i + 1) : t
}

function repoOfValue(v) {
  const s = String(v || '').replace(/\/+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'))
  return s.slice(i + 1).replace(/\.git$/, '').replace(/#.*$/, '')
}

/**
 * Normalize a repository URL / homepage to `owner/repo` (lowercase, no
 * scheme/git-suffix) when it points at GitHub, else null. Mirrors how the
 * catalog builds a plugin's GitHub repo identity from its URL.
 */
function normalizeRepoUrl(u) {
  const s = String(u || '').trim()
  if (!s) return null
  const m = /github\.com[\/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?=[\/#?]|$)/.exec(s)
  if (!m) return null
  // Strip any /tree/<ref>/... path suffix (monorepo links) — only owner/repo matters.
  return m[1].toLowerCase()
}

/**
 * Read every installed plugin's real upstream repo (owner/repo) from its own
 * package.json (`repository.url`/`homepage`). The catalog identifies plugins
 * by repo URL while the profile records dependency keys (npm names) and
 * specs (github:/registry) — those rarely line up for scoped packages
 * (@scope/name), registry installs, or monorepo subpackages, which is why an
 * naı̈ve name match reports "only two installed". Returns { pkgName: repokey }.
 */
function readInstalledProvenance(profile) {
  const out = {}
  try {
    const manifest = JSON.parse(readFileSync(profileDir(profile) + '/package.json', 'utf8'))
    const names = []
    if (manifest.dependencies) names.push(...Object.keys(manifest.dependencies))
    if (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) {
      names.push(...manifest.dsh.profile.bundles)
    }
    const seen = new Set()
    for (const name of names) {
      if (!name || seen.has(name)) continue
      seen.add(name)
      try {
        const pkg = JSON.parse(readFileSync(join(profileDir(profile), 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
        const repoUrl = typeof pkg.repository === 'string'
          ? pkg.repository
          : (pkg.repository && pkg.repository.url) || ''
        out[name] = normalizeRepoUrl(repoUrl) || normalizeRepoUrl(pkg.homepage) || null
      } catch { out[name] = null }
    }
  } catch {}
  return out
}

/**
 * Canonical installed-state matcher: does the catalog plugin map to an
 * installed package? Returns the package name (dependency key or bundle entry)
 * or null. Matching is by owner/repo provenance first (the reliable signal,
 * since catalogs key on repo URL), then falls back to basename heuristics so
 * profiles written before provenance existed still resolve.
 */
function matchInstalledPackage(plugin, installedState) {
  if (!installedState) return null
  const prov = installedState.provenance || {}
  const target = normalizeRepoUrl(String(plugin.url || ''))
  const repo = repoNameOf(String(plugin.url || ''))
  const keys = []
  if (installedState.dependencies) keys.push(...Object.keys(installedState.dependencies))
  if (Array.isArray(installedState.bundles)) keys.push(...installedState.bundles)
  for (const pkg of keys) {
    if (target && prov[pkg] === target) return pkg
    if (!repo) continue
    const b = String(pkg || '')
    if (b === repo || b.endsWith('/' + repo) || b === 'github:' + repo) return pkg
  }
  // Fallback on dependency values (github:owner/repo specs) for older states.
  if (installedState.dependencies) {
    for (const [key, spec] of Object.entries(installedState.dependencies)) {
      if (repo && repoOfValue(spec) === repo) return key
    }
  }
  return null
}

/** The site's own JSON API — the canonical target data (stars, added, owner, bilingual desc). */
const REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
/** Static page fallback when the JSON API is unreachable. */
const CATALOG_PAGE_URL = 'https://awesome-dsh-plugin.com/zh/'

function pickLang(lang) {
  return lang === 'en' ? 'en' : 'zh'
}

/**
 * Map one plugins.json entry onto the catalog card shape, keeping the fields
 * the UI already understands and adding stars/added (null when unknown).
 */
function fromRegistryPlugin(p, lang) {
  const cc = parseCmd(p.install)
  const desc = (p.description && typeof p.description === 'object') ? p.description : {}
  return {
    cat: p.category,
    name: p.name,
    url: p.url,
    by: p.owner,
    desc: desc[lang] || desc.zh || desc.en || '',
    cmd: p.install,
    profile: cc ? cc.profile : 'web',
    source: cc ? cc.source : null,
    stars: typeof p.stars === 'number' ? p.stars : null,
    added: p.added || null,
  }
}

/** Derive the category chips (incl. the leading "all" chip) from the registry. */
function registryCats(data, lang) {
  const cats = []
  const labels = (data.categories && typeof data.categories === 'object') ? data.categories : {}
  cats.push({ id: 'all', label: lang === 'en' ? 'All' : '全部', count: Array.isArray(data.plugins) ? data.plugins.length : 0 })
  for (const id of Object.keys(labels)) {
    const l = labels[id]
    const label = (l && (l[lang] || l.zh || l.en)) || id
    const count = Array.isArray(data.plugins) ? data.plugins.filter((p) => p.category === id).length : 0
    cats.push({ id, label, count })
  }
  return cats
}

/** Map a parsed plugins.json document onto the catalog card shape. */
function registryToCatalog(data, lang) {
  const locale = pickLang(lang)
  return {
    plugins: Array.isArray(data.plugins) ? data.plugins.map((p) => fromRegistryPlugin(p, locale)) : [],
    cats: registryCats(data, locale),
  }
}

/**
 * Load the plugin catalog, mirroring dsh-market's registry + snapshot: the
 * site's own JSON API first (it carries stars/added), then the static page,
 * then the bundled snapshot as offline fallback. Cached briefly.
 * @returns {Promise<{plugins: any[], cats: any[], source: 'live'|'cache'|'snapshot'|'none'}>}
 */
async function loadCatalog(lang) {
  const now = Date.now()
  const locale = pickLang(lang)
  if (catalogCache && catalogCache.lang === locale && now - catalogCache.at < CATALOG_TTL_MS) {
    return { ...catalogCache.data, source: 'cache' }
  }
  // 1) The site's JSON API — the canonical target data.
  try {
    const r = await fetch(REGISTRY_URL, { redirect: 'follow', signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const data = await r.json()
    const parsed = registryToCatalog(data, locale)
    if (parsed.plugins.length === 0) throw new Error('empty registry')
    catalogCache = { at: now, lang: locale, data: parsed }
    return { ...parsed, source: 'live' }
  } catch {
    // 2) Static page fallback (same card shape).
    try {
      const r = await fetch(CATALOG_PAGE_URL, { redirect: 'follow', signal: AbortSignal.timeout(10000) })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const parsed = parseSite(await r.text())
      if (parsed.plugins.length === 0) throw new Error('empty catalog')
      catalogCache = { at: now, lang: locale, data: parsed }
      return { ...parsed, source: 'live' }
    } catch {
      // 3) Bundled offline snapshot.
      try {
        const snap = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog-snapshot.json'), 'utf8'))
        if (Array.isArray(snap.plugins) && snap.plugins.length > 0) return { ...snap, source: 'snapshot' }
      } catch {}
      return { plugins: [], cats: [], source: 'none' }
    }
  }
}

/** Catalog cache: 5 minutes; snapshot path is the offline fallback. */
let catalogCache = null
const CATALOG_TTL_MS = 5 * 60 * 1000

// ── hot mount (restart-free activation) ─────────────────────────────────────
// Mirrors dsh-market's approach: after a successful install, if the new
// package's patch is just plain id/name insert rows, mount it into the running
// composition through a market-owned Include subtree. Durable state stays in
// the profile's dsh.profile.bundles; the subtree exists only for this process
// and its inputs live under <profile>/.dsh-market/, wiped on every boot.

/** Parse a bundle patch that is ONLY plain `- id:`/`name:` insert rows. */
function parseSimplePatch(patchText) {
  const rows = []
  let pending = null
  for (const raw of String(patchText || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^-\s+insert:\s*$/.test(line)) continue
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      if (pending !== null) return null
      pending = id[1]
      continue
    }
    const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (name !== null && pending !== null) {
      rows.push({ id: pending, name: name[1] })
      pending = null
      continue
    }
    return null
  }
  if (pending !== null || rows.length === 0) return null
  return rows
}

/** The loader's Include class, built once; null when unavailable (older harness). */
let hotTreeClass = undefined

async function loadHotTreeClass() {
  if (hotTreeClass !== undefined) return hotTreeClass
  try {
    const mod = await import('@deepseek-ai/cordis-plugin-include')
    const Include = mod.Include
    if (Include === undefined) throw new Error('no Include export')
    class MarketHotTree extends Include {
      /** Runtime-only mount list; the bundle layer owns persistence. */
      write() {}
    }
    hotTreeClass = MarketHotTree
  } catch {
    hotTreeClass = null
  }
  return hotTreeClass
}

/** Wipe leftover hot-mount inputs; call when the market host starts. */
function cleanHotDir(profile) {
  try { rmSync(profileDir(profile) + '/.dsh-market', { force: true, recursive: true, maxRetries: 3 }) } catch {}
}

let hotSequence = 0

/** Live hot-mount handles keyed by package name, so uninstall can dispose them. */
const hotHandles = new Map()

/**
 * Mount a just-installed package into the running composition.
 * @returns {Promise<boolean>} true when live without restart; false → restart needed.
 */
async function hotMount(ctx, profile, packageName) {
  try {
    const HotTree = await loadHotTreeClass()
    if (HotTree === null) return false
    const patchText = readFileSync(join(profileDir(profile), 'node_modules', packageName, 'cordis.patch.yml'), 'utf8')
    const rows = parseSimplePatch(patchText)
    if (rows === null) return false
    const dir = join(profileDir(profile), '.dsh-market')
    mkdirSync(dir, { recursive: true })
    hotSequence += 1
    const file = join(dir, 'hot-' + String(hotSequence) + '.yml')
    const yml = rows.map((row) => `- id: mkt-${row.id}\n  name: '${row.name}'\n`).join('')
    writeFileSync(file, yml)
    // Include resolves config.path as a URL against ctx.baseUrl — pass the
    // file:// href, not a bare Windows path (a drive-letter `C:` would parse
    // as a URL scheme and fileURLToPath would reject it).
    const handle = ctx.plugin(HotTree, { path: pathToFileURL(file).href })
    await handle.await()
    hotHandles.set(packageName, handle)
    return true
  } catch (e) {
    console.warn('[dsh-market] hot mount of ' + packageName + ' failed, restart required: ' + String((e && e.message) || e))
    return false
  }
}

/**
 * Dispose a live hot mount. Uninstall removes the package from node_modules
 * but the mounted Include subtree would otherwise stay in the running
 * composition — client-modules would keep serving a bundle that no longer
 * exists and the next page reload would fail to import it.
 */
async function disposeHotMount(packageName) {
  const handle = hotHandles.get(packageName)
  if (!handle) return
  hotHandles.delete(packageName)
  try {
    await handle.dispose()
  } catch (e) {
    console.warn('[dsh-market] dispose of hot mount ' + packageName + ' failed: ' + String((e && e.message) || e))
  }
}

/**
 * Disable every live loader entry whose name matches the package, so
 * client-modules drops it from the boot graph immediately. This covers both
 * hot-mounted Include subtrees AND entries loaded as regular profile bundle
 * rows (which hotHandles never saw) — the "sometimes fails on reload" case:
 * `dsh plugin remove` only edits the persisted profile; the running Loader
 * still holds the row and keeps serving a bundle whose package is gone.
 * Mirrors the Loader's own handling of a self-disposed entry (disabled=true).
 */
async function disableLoaderEntry(packageName) {
  const loader = hotCtx && hotCtx.get('loader')
  if (!loader) return
  let disabled = false
  for (const entry of loader.entries()) {
    if (entry.options && entry.options.name === packageName && !entry.disabled) {
      try {
        await entry.update({ disabled: true })
        disabled = true
      } catch (e) {
        console.warn('[dsh-market] disable loader entry ' + packageName + ' failed: ' + String((e && e.message) || e))
      }
    }
  }
  if (disabled) {
    console.log('[dsh-market] disabled loader entry ' + packageName + ' (uninstall)')
  }
}

/** After a successful install op, try to hot-mount every newly added package. */
async function tryHotMountAll(ctx, profile, beforeDeps) {
  try {
    const after = readProfileDeps(profile)
    const added = Object.keys(after).filter((n) => beforeDeps[n] === undefined)
    if (added.length === 0) return false
    const results = await Promise.all(added.map((n) => hotMount(ctx, profile, n)))
    return results.every(Boolean)
  } catch { return false }
}

function readProfileDeps(profile) {
  try {
    const json = JSON.parse(readFileSync(profileDir(profile) + '/package.json', 'utf8'))
    return (json && json.dependencies) || {}
  } catch { return {} }
}

/**
 * Packages the desktop shell syncs into the profile on every boot (written by
 * the EAC main process as <profile>/.dsh-builtin-plugins.json). Installing a
 * catalog copy over one of these breaks the composition (duplicate loader
 * entry / module double-instance), so the market must refuse and the UI shows
 * a "built-in" badge instead of an install button.
 * @returns {string[]} builtin package names (may be empty).
 */
function readBuiltinPlugins(profile) {
  try {
    const marker = JSON.parse(readFileSync(join(profileDir(profile), '.dsh-builtin-plugins.json'), 'utf8'))
    return Array.isArray(marker.names) ? marker.names.filter((n) => typeof n === 'string') : []
  } catch { return [] }
}

/** Basename of a package name or install spec ('dsh-tool-vision', 'github:owner/dsh-pet' → 'dsh-pet'). */
function specBasename(v) {
  const s = String(v || '').replace(/\/+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'))
  return s.slice(i + 1).replace(/\.git$/, '').replace(/#.*$/, '')
}

/**
 * Does an install target collide with a builtin package? Matches the spec's
 * basename against builtin package basenames (scoped names included), so
 * `github:owner/dsh-tool-vision`, `dsh-tool-vision`, and registry versions of
 * a builtin all collide.
 */
function builtinCollision(target, builtin) {
  const base = specBasename(target)
  if (!base) return null
  const hit = builtin.find((name) => specBasename(name) === base)
  return hit || null
}

// ── V4.2 安装前冲突预检（scan 路由 + install 门卫）────────────────────

/**
 * 抓取候选插件的 { name, manifest, patchText }（只读，不装）。
 * github: → RAW_MIRRORS 抓 package.json + cordis.patch.yml；
 * registry → npm registry latest manifest（patch 未知 → ''，由试装验证兜底）；
 * link:/file: → 读本地包（相对 profile 目录或绝对路径）。
 * @returns {Promise<{name, manifest, patchText} | {error}>}
 */
async function fetchCandidateInfo(source) {
  const spec = String(source || '').trim()
  if (!spec) return { error: '缺少安装源' }
  const gh = /^github:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(spec)
  if (gh) {
    const [, owner, repo] = gh
    let manifest = null
    let patchText = ''
    for (const base of RAW_MIRRORS) {
      try {
        const r = await fetch(`${base}/${owner}/${repo}/HEAD/package.json`, {
          redirect: 'follow', signal: AbortSignal.timeout(10000),
        })
        if (!r.ok) continue
        manifest = await r.json()
        break
      } catch { /* next mirror */ }
    }
    if (manifest === null || typeof manifest !== 'object') return { error: '无法抓取候选插件清单（package.json）：' + spec }
    for (const base of RAW_MIRRORS) {
      try {
        const r = await fetch(`${base}/${owner}/${repo}/HEAD/cordis.patch.yml`, {
          redirect: 'follow', signal: AbortSignal.timeout(8000),
        })
        if (r.ok) { patchText = await r.text(); break }
      } catch { /* patch 缺失不致命 */ }
    }
    return { name: String(manifest.name || repo), manifest, patchText }
  }
  if (spec.startsWith('link:') || spec.startsWith('file:')) {
    const rel = spec.slice(spec.indexOf(':') + 1)
    const dir = rel.startsWith('~') ? (homedir() + rel.slice(1)) : rel
    const abs = dir.startsWith('.') ? join(profileDir(desktopProfile()), dir) : dir
    try {
      const manifest = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'))
      let patchText = ''
      try { patchText = readFileSync(join(abs, 'cordis.patch.yml'), 'utf8') } catch {}
      return { name: String(manifest.name || abs), manifest, patchText }
    } catch (err) {
      return { error: '本地源读取失败：' + String((err && err.message) || err) }
    }
  }
  // registry spec（包名 或 包名@range）
  const name = spec.replace(/@latest$/, '').split('@').filter(Boolean).join('@')
  if (!/^@?[A-Za-z0-9][A-Za-z0-9._@/+-]*$/.test(name)) return { error: '无法识别的安装源：' + spec }
  try {
    const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      redirect: 'follow', signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return { error: 'registry 抓取失败（HTTP ' + r.status + '）：' + name }
    const manifest = await r.json()
    return { name: String(manifest.name || name), manifest, patchText: '' }
  } catch (err) {
    return { error: 'registry 抓取失败：' + String((err && err.message) || err) }
  }
}

/** 冲突预检的完整流程：抓候选 → 读 profile 态 → scanCandidate。 */
async function conflictScan(profile, target) {
  const info = await fetchCandidateInfo(target)
  if (info.error) return { ok: false, error: info.error }
  const state = collectProfileState(profileDir(profile))
  const verdict = scanCandidate(info, state)
  return { ok: true, ...verdict, candidate: info.name }
}

// ── update detection (mirrors dsh-market's checkUpdates) ─────────────────────

/** Pinned commit per `owner/repo` from the profile lockfile's codeload tarball URLs. */
function readLockCommits(profile) {
  const commits = new Map()
  try {
    const lock = readFileSync(join(profileDir(profile), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
      commits.set(m[1].toLowerCase(), m[2])
    }
  } catch { /* no lockfile — no git installs to report */ }
  return commits
}

function readInstalledVersion(profile, name) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile), 'node_modules', name, 'package.json'), 'utf8'))
    return manifest.version ?? null
  } catch {
    return null
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** Per-plugin update status; a failed check reports no update rather than failing the listing. */

/** 本地链接/文件安装的插件：从它的 package.json 推断上游身份（GitHub repo 优先，
 *  其次 npm 包名）。读不到则返回 null（按「无上游」处理）。 */
async function resolveLinkedUpstream(profile, name) {
  try {
    const pkgDir = join(profileDir(profile), 'node_modules', ...name.split('/'))
    const meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const repoUrl = typeof meta.repository === 'string' ? meta.repository : ((meta.repository && meta.repository.url) || '')
    const ghM = /github\.com[\/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?=[\/#?]|$)/.exec(repoUrl)
    if (ghM) return { kind: 'github', id: ghM[1].toLowerCase() }
    const homeM = /github\.com[\/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?=[\/#?]|$)/.exec(String(meta.homepage || ''))
    if (homeM) return { kind: 'github', id: homeM[1].toLowerCase() }
    if (meta.name) return { kind: 'npm', id: meta.name }
  } catch { /* unreadable */ }
  return null
}

/**
 * npm 源最新版与发布时间：发布不足 24h（pnpm `minimumReleaseAge` 保护期）
 * 的版本不提示更新、也不作为更新目标，避免「可见不可装」。
 * npm registry 不提供独立 time 端点，取全量文档的 dist-tags.latest 与
 * time[latest]（文档较大，依赖 checkUpdates 的 10 分钟缓存摊薄开销）。
 */
async function npmLatestInfo(name) {
  try {
    const resp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-unified-market/0.1.0' },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) return { latest: null, fresh: false }
    const doc = await resp.json()
    const latest = doc && doc['dist-tags'] && typeof doc['dist-tags'].latest === 'string' ? doc['dist-tags'].latest : null
    let fresh = false
    if (latest && doc.time && doc.time[latest]) {
      try {
        fresh = Date.now() - new Date(doc.time[latest]).getTime() < 24 * 3600 * 1000
      } catch { /* bad date — treat as not fresh */ }
    }
    return { latest, fresh }
  } catch { return { latest: null, fresh: false } }
}

/** 取上游最新版本号：GitHub → HEAD 的 package.json.version（走镜像）；npm → latest。 */
async function fetchUpstreamVersion(src) {
  try {
    if (!src) return null
    if (src.kind === 'github') {
      const r = await ghFetch(`https://raw.githubusercontent.com/${src.id}/HEAD/package.json`, { raw: true, timeout: 12000 })
      if (r.status === 200 && typeof r.body === 'string') {
        try { return JSON.parse(r.body).version || null } catch { return null }
      }
      return null
    }
    if (src.kind === 'npm') {
      const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(src.id)}/latest`)
      return typeof meta.version === 'string' ? meta.version : null
    }
    return null
  } catch { return null }
}

/**
 * 用「插件名」去整个插件市场匹配上游：npm registry 精确名 → npm 检索同名 →
 * GitHub dsh-plugin 生态检索同名。命中返回 { kind, id }，未命中返回 null。
 */
async function findUpstreamByName(name) {
  const base = String(name.split('/').pop() || name).toLowerCase()
  if (!base) return null
  // 1) npm registry 精确包名
  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)
    if (meta && typeof meta.version === 'string') return { kind: 'npm', id: name }
  } catch { /* not on npm */ }
  // 2) npm search 按名找同名/同尾名
  try {
    const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(base)}&size=10`, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-unified-market/0.1.0' },
      signal: AbortSignal.timeout(12000),
    })
    if (res.ok) {
      const data = await res.json()
      const hit = (data.objects || []).map((o) => o.package).find((p) => {
        const pn = String(p && p.name || '').split('/').pop().toLowerCase()
        return pn === base
      })
      if (hit && hit.name) return { kind: 'npm', id: hit.name }
    }
  } catch { /* search failed */ }
  // 3) GitHub dsh-plugin 生态检索同名（含中文名/描述命中后取仓库）
  try {
    const g = await githubList(base, 1)
    const hit = (g.items || []).find((it) => it.name.toLowerCase() === base || (it.fullName || '').split('/').pop().toLowerCase() === base)
    if (hit && hit.fullName) return { kind: 'github', id: hit.fullName }
  } catch { /* search failed */ }
  return null
}

async function checkUpdates(profile) {
  const cached = updatesCache && updatesCache[profile]
  if (cached && Date.now() - cached.at < UPDATES_TTL_MS) return cached.data
  const installed = readProfileDeps(profile)
  const lockCommits = readLockCommits(profile)
  const builtinNames = new Set(readBuiltinPlugins(profile))
  const result = {}
  await Promise.all(Object.entries(installed).map(async ([name, spec]) => {
    // 内置插件由桌面壳官方插件更新机制维护，市场不检测/不更新（避免与 sync 冲突）。
    if (builtinNames.has(name)) {
      result[name] = { kind: 'builtin', version: readInstalledVersion(profile, name), current: null, latest: null, updateAvailable: false }
      return
    }
    const version = readInstalledVersion(profile, name)
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      // 本地链接/文件安装：同样尝试推断上游（GitHub repo 或 npm 名）并查最新版；
      // 推断不到、或取不到版本的，再用插件名去整个插件市场（npm + GitHub 生态）匹配。
      let src = await resolveLinkedUpstream(profile, name)
      let latest = null
      let fresh = false
      if (src && src.kind === 'npm') {
        const info = await npmLatestInfo(src.id)
        latest = info.latest
        fresh = info.fresh
      } else if (src) {
        latest = await fetchUpstreamVersion(src)
      }
      if (!src || !latest) {
        const byName = await findUpstreamByName(name)
        if (byName) {
          src = byName
          if (byName.kind === 'npm') {
            const info2 = await npmLatestInfo(byName.id)
            latest = info2.latest
            fresh = info2.fresh
          } else {
            latest = await fetchUpstreamVersion(byName)
          }
        }
      }
      if (src && latest) {
        result[name] = {
          kind: 'linked', version, current: version, latest,
          updateAvailable: version !== null && hasUpdateOfVersion(version, latest) && !fresh,
        }
      } else {
        // 确实查不到上游：不判定为有更新（面板不会显示「无上游」字样）。
        result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      }
      return
    }
    const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    try {
      if (spec.startsWith('github:') && gh !== null) {
        const current = lockCommits.get(gh[1].toLowerCase()) ?? null
        const head = await fetchJson(`https://api.github.com/repos/${gh[1]}/commits/HEAD`)
        const latest = typeof head.sha === 'string' ? head.sha : null
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: current !== null && latest !== null && current !== latest,
        }
      } else {
        const { latest, fresh } = await npmLatestInfo(name)
        result[name] = {
          kind: 'npm', version, current: version, latest,
          updateAvailable: version !== null && latest !== null && version !== latest && !fresh,
        }
      }
    } catch {
      result[name] = {
        kind: spec.startsWith('github:') ? 'github' : 'npm', version, current: null, latest: null,
        updateAvailable: false,
      }
    }
  }))
  updatesCache = { ...updatesCache, [profile]: { at: Date.now(), data: result } }
  return result
}

const UPDATES_TTL_MS = 10 * 60 * 1000
let updatesCache = {}
/** 「全部更新」后台任务的进度记录（updateAll → updateProgress 轮询）。 */
let updateAllProgress = null

// ─────────────────────────────────────────────────────────────────────────────
// 统一市场扩展：数据源 / 自动更新 / 一键检测修复 / 自更新（EAC 特化）
// ─────────────────────────────────────────────────────────────────────────────

/** 本市场自身版本（与 package.json 同步；自更新检查用）。 */
const SELF_NAME = 'dsh-unified-market'

/**
 * 市场自身的上游源。内置分发时不配置（null）：上游发布后应改在
 * main.js 的 PLUGIN_UPDATE_SOURCES 登记该 id，由官方引擎自动/手动更新；
 * 这里保留检查接口，配置后即可直接对比版本。
 */
const SELF_UPDATE_SOURCE = null // { npm: 'dsh-unified-market' } | { github: 'owner/repo' }

/** GitHub 直连/镜像抓取：直连 → gh-proxy.com → ghfast.top，任一 200 即返回。 */
async function ghFetch(url, opts = {}) {
  const mirrors = ['https://gh-proxy.com/', 'https://ghfast.top/']
  const attempts = [url, ...mirrors.map((m) => m + url)]
  let lastError = ''
  for (const u of attempts) {
    try {
      const res = await fetch(u, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-unified-market/0.1.0' },
        signal: AbortSignal.timeout(opts.timeout || GH_TIMEOUT_MS),
        ...(opts.method ? { method: opts.method } : {}),
      })
      if (res.status === 200) return { status: 200, body: opts.raw ? await res.text() : await res.json() }
      if (res.status >= 400 && res.status < 500) return { status: res.status, body: null } // 404/403 镜像也一样
      lastError = 'HTTP ' + res.status
    } catch (err) {
      lastError = String((err && err.message) || err)
    }
  }
  return { status: 0, body: null, error: lastError }
}

/** GitHub dsh-plugin 生态检索（zat 优势）：topic 检索 + star 排序 + 中文简介懒加载。 */
async function githubList(query, page) {
  const q = String(query || '').trim()
  const terms = ['topic:dsh-plugin']
  if (q) terms.push(q)
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(terms.join(' '))}&sort=stars&order=desc&per_page=30&page=${Math.max(1, Number(page) || 1)}`
  const r = await ghFetch(url, { timeout: 20000 })
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.items)) {
    return { ok: false, message: (r.error || 'GitHub 检索失败（可能已限流，稍后再试）'), items: [], total: 0, page: 1, hasMore: false }
  }
  const items = r.body.items.map((it) => ({
    source: 'github',
    fullName: String(it.full_name || ''),
    owner: String((it.owner && it.owner.login) || ''),
    name: String(it.name || ''),
    description: String(it.description || ''),
    zhIntro: '',
    needZh: false,
    stars: Number(it.stargazers_count || 0),
    forks: Number(it.forks_count || 0),
    language: String(it.language || ''),
    topics: Array.isArray(it.topics) ? it.topics : [],
    updatedAt: String(it.updated_at || ''),
    htmlUrl: String(it.html_url || ''),
    homepage: String(it.homepage || ''),
    kind: 'plugin',
  }))
  return {
    ok: true, items, source: 'github',
    total: Number(r.body.total_count || 0), page: Math.max(1, Number(page) || 1),
    hasMore: items.length >= 30,
  }
}

/** 抓取仓库 README.zh.md 的前几行作为中文简介（详情页用；失败返回空）。 */
async function readZhIntro(owner, repo) {
  try {
    const u = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.zh.md`
    const r = await ghFetch(u, { raw: true, timeout: 12000 })
    if (r.status !== 200 || typeof r.body !== 'string') return null
    return r.body.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8).join(' ').slice(0, 300)
  } catch { return null }
}

/** npm registry 检索（marketplace 优势）：keywords:dsh-plugin + 自由词。 */
async function npmSearch(query) {
  const q = String(query || '').trim()
  const text = q ? `keywords:dsh-plugin ${q}` : 'keywords:dsh-plugin'
  try {
    const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=25`, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-unified-market/0.1.0' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { ok: false, message: 'npm 检索失败（HTTP ' + res.status + '）', items: [], total: 0 }
    const data = await res.json()
    const items = (data.objects || []).map((o) => {
      const p = o.package || {}
      return {
        source: 'npm',
        fullName: p.name || '',
        owner: '',
        name: p.name || '',
        description: p.description || '',
        zhIntro: '',
        needZh: false,
        stars: 0,
        forks: 0,
        language: '',
        topics: [],
        updatedAt: p.date || '',
        htmlUrl: p.links && p.links.repository ? p.links.repository : '',
        homepage: p.links && p.links.homepage ? p.links.homepage : '',
        version: p.version || '',
        kind: 'npm',
      }
    })
    return { ok: true, items, source: 'npm', total: Number(data.total || 0), page: 1, hasMore: false }
  } catch (err) {
    return { ok: false, message: String((err && err.message) || err), items: [], total: 0 }
  }
}

// ── 自动更新状态（持久化到 <profile>/.dsh-unified-market.json）─────────────────

function autoStatePath(profile) {
  return join(profileDir(profile), '.dsh-unified-market.json')
}

function loadAutoState(profile) {
  try { return JSON.parse(readFileSync(autoStatePath(profile), 'utf8')) } catch { return {} }
}

function saveAutoState(profile, state) {
  try { writeFileSync(autoStatePath(profile), JSON.stringify(state, null, 2) + '\n') } catch {}
}

/** 自动更新开关读取/设置：{ autoUpdate: 'off' | 'notify' | 'auto' }。 */
function autoUpdateState(profile) {
  const s = loadAutoState(profile)
  return { ok: true, autoUpdate: String(s.autoUpdate || 'notify'), lastAutoCheckAt: s.lastAutoCheckAt || null, lastAutoCheckCount: s.lastAutoCheckCount || 0 }
}

function setAutoUpdate(profile, mode) {
  const m = ['off', 'notify', 'auto'].includes(String(mode)) ? String(mode) : 'notify'
  const s = loadAutoState(profile)
  s.autoUpdate = m
  saveAutoState(profile, s)
  return { ok: true, autoUpdate: m }
}

/** 后台自动检测：启动延迟后首检 + 每 6 小时一次（落盘节流 4h）。
 *  autoUpdate=notify → 只刷新 updates 缓存（UI 显示「有更新」徽章）；
 *  autoUpdate=auto    → 直接排队更新全部可更新项（失败单项跳过）。 */
let autoCheckTimer = null
let autoCheckRunning = false

async function autoCheckTick(profile, ctx) {
  if (autoCheckRunning || quittingRef()) return
  autoCheckRunning = true
  try {
    const st = loadAutoState(profile)
    if (st.lastAutoCheckAt && Date.now() - Number(st.lastAutoCheckAt) < AUTO_CHECK_MIN_GAP) return
    const updates = await checkUpdates(profile)
    const updatable = Object.entries(updates)
      .filter(([, u]) => u.updateAvailable)
      .map(([name, u]) => ({ name, target: u.kind === 'npm' ? name + '@latest' : (/* github spec kept as installed */ null), info: u }))
      .filter((u) => u.target !== null)
    const s = loadAutoState(profile)
    s.lastAutoCheckAt = Date.now()
    s.lastAutoCheckCount = updatable.length
    saveAutoState(profile, s)
    if (st.autoUpdate === 'auto' && updatable.length > 0 && !(activeOp && activeOp.status === 'running')) {
      // 逐项排队更新（一次一个，失败跳过），不阻塞。
      for (const u of updatable) {
        if (quittingRef()) break
        try {
          await startOpPromised(profile, 'update', u.target, u.name, dshBin() || '')
        } catch {}
      }
    }
  } finally {
    autoCheckRunning = false
  }
}

let quitting = false
function quittingRef() { return quitting }
function setQuitting(v) { quitting = v }

/** 包装 startOp 为 Promise（自动更新用）。 */
function startOpPromised(profile, kind, target, label, bin) {
  return new Promise((resolve) => {
    const started = startOp(kind, profile, target, label, bin, '（自动更新）' + label + '\n')
    if (!started.ok) return resolve(started)
    const iv = setInterval(() => {
      const op = opSnapshot()
      if (!op || op.id !== started.opId) { clearInterval(iv); return resolve({ ok: false, output: '任务状态丢失' }) }
      if (op.status === 'done') { clearInterval(iv); resolve({ ok: true }) }
      else if (op.status === 'failed' || op.status === 'killed' || op.status === 'timedout') { clearInterval(iv); resolve({ ok: false, output: op.output || '' }) }
    }, 1500)
  })
}

/**
 * 本地链接插件更新目标：优先 npm 源（发布包无需 prepare 构建、最快最稳），
 * 其次 GitHub 源（需 allowBuilds 放行构建脚本，自动重试）。返回 spec 或 null。
 */
async function linkedUpdateTarget(profile, name) {
  const src = await resolveLinkedUpstream(profile, name)
  const byName = src ? null : await findUpstreamByName(name)
  // 1) 优先 npm：只要有 npm 包名且 registry 有 latest，就用 npm@latest
  const npmNames = []
  if (src && src.kind === 'npm') npmNames.push(src.id)
  if (byName && byName.kind === 'npm' && !npmNames.includes(byName.id)) npmNames.push(byName.id)
  // 兜底：直接用当前插件名试 npm（name 本身可能就是 npm 包名）
  if (!npmNames.includes(name)) npmNames.push(name)
  for (const nm of npmNames) {
    const info = await npmLatestInfo(nm)
    if (info.latest) return nm + '@latest'
  }
  // 2) GitHub 源
  if (src && src.kind === 'github') return 'github:' + src.id
  if (byName && byName.kind === 'github') return 'github:' + byName.id
  return null
}

/** 更新 + pnpm allowBuilds 自动放行重试：git 源（github:）插件安装时 pnpm
 * 默认封锁其 prepare 构建脚本，导致命令失败。这里解析输出中被拦的 key，
 * 写入 profile 的 pnpm-workspace.yaml 的 allowBuilds 后自动重试一次。
 *
 * 本地链接（link:/file: 指向开发目录）切上游时，pnpm 替换 symlink 会报
 * ERR_PNPM_EPERM（Windows），先手动删除该包目录让 pnpm 全新安装；
 * 安装失败则尽力回滚（重新 add 原 spec 恢复本地链接）。
 * @returns {{ok:boolean, output?:string, allowBuilds?:string[]}}
 */
async function runUpdateWithAllowBuilds(profile, target, name, bin) {
  const deps = readProfileDeps(profile)
  const spec = deps[name] || ''
  const wasLinked = spec.startsWith('link:') || spec.startsWith('file:')
  if (wasLinked) {
    const pkgDir = join(profileDir(profile), 'node_modules', ...name.split('/'))
    if (existsSync(pkgDir)) {
      try {
        // rmSync 对目录 symlink/junction 删除链接本身（不动目标目录）。
        rmSync(pkgDir, { recursive: true, force: true, maxRetries: 3 })
      } catch { /* 删不掉（被占用）→ 交给 pnpm，失败会走 pending */ }
    }
  }
  const r = await startOpPromised(profile, 'update', target, name, bin)
  if (r && r.ok) return r
  if (!r.ok && wasLinked && spec) {
    // 安装失败：尽力回滚到原 link（恢复开发者本地链接）。
    try {
      await startOpPromised(profile, 'update', spec, name + '（回滚 link）', bin)
    } catch { /* rollback best-effort */ }
  }
  const keys = parseBlockedBuildKeys(String((r && (r.output || r.error)) || ''))
  if (keys && keys.length > 0) {
    try {
      const ws = join(profileDir(profile), 'pnpm-workspace.yaml')
      const res = ensureAllowBuilds(ws, keys)
      if (res && res.wrote) {
        const r2 = await startOpPromised(profile, 'update', target, name, bin)
        return Object.assign({}, r2, { allowBuilds: keys })
      }
    } catch { /* keep the original failure */ }
  }
  return r
}

// ── 自更新（市场自身）───────────────────────────────────────────────────────

async function selfUpdateCheck() {
  const source = SELF_UPDATE_SOURCE
  if (!source) {
    return {
      ok: true, configured: false, version: SELF_VERSION, hasUpdate: false, latestVersion: null,
      message: '本市场为 DSH Desktop 内置分发（v' + SELF_VERSION + '）：上游发布新版本后，由官方「内置插件更新」（设置 → 插件 → 更新，默认每 6 小时检测 + 可开自动更新）负责升级，无需在此单独更新。',
    }
  }
  try {
    let latest = null
    if (source.npm) {
      const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(source.npm)}/latest`)
      latest = typeof meta.version === 'string' ? meta.version : null
    } else if (source.github) {
      const pkg = await ghFetch(`https://raw.githubusercontent.com/${source.github}/HEAD/package.json`, { raw: true })
      if (pkg.status === 200 && pkg.body) {
        try { latest = JSON.parse(pkg.body).version || null } catch {}
      }
    }
    if (!latest) return { ok: true, configured: true, version: SELF_VERSION, hasUpdate: false, latestVersion: null, message: '无法获取上游最新版本。' }
    return {
      ok: true, configured: true, version: SELF_VERSION, hasUpdate: latest !== SELF_VERSION,
      latestVersion: latest,
      message: hasUpdateOfVersion(SELF_VERSION, latest) ? '市场自身有新版本 v' + latest : '市场自身已是最新（v' + SELF_VERSION + '）',
    }
  } catch (err) {
    return { ok: false, version: SELF_VERSION, message: String((err && err.message) || err) }
  }
}

function hasUpdateOfVersion(local, latest) {
  try {
    const lv = local.split('.').map(Number)
    const rv = latest.split('.').map(Number)
    for (let i = 0; i < Math.max(lv.length, rv.length); i++) {
      const a = lv[i] || 0
      const b = rv[i] || 0
      if (a !== b) return a < b
    }
    return false
  } catch { return local !== latest }
}

export { classifyPlugin, runProbe, whitelistSource, loadCatalog, parseSimplePatch, checkUpdates, parseSite, registryToCatalog, normalizeRepoUrl, readInstalledProvenance, matchInstalledPackage, resolveProfile, githubList, npmSearch, readZhIntro, selfUpdateCheck, autoUpdateState, setAutoUpdate, desktopProfile, resolveLinkedUpstream, fetchUpstreamVersion, findUpstreamByName, npmLatestInfo, linkedUpdateTarget } // test hooks; cordis only reads name/inject/apply

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-market] webServer service unavailable at apply; route not registered')
    return
  }
  // Allow install ops to hot-mount into this composition; wipe stale hot-mount
  // inputs so a crash can never collide with the bundle layer on next boot.
  hotCtx = ctx
  // EAC 修复：热挂载缓存目录跟随桌面专属 profile（DSH_DESKTOP_PROFILE），
  // 与本文件其余安装/读写路径的解析保持一致；独立安装仍为 web。
  cleanHotDir(desktopProfile())
  // 统一市场主路径；并兼容注册底座遗留的 /api/dsh-market（防旧引用）。
  // 客户端统一走 /api/dsh-unified-market。
  const routeHandler = async (req, res) => {
      try {
        const body = await readBody(req)
        const method = String(body.method || '')
        if (method === 'list') {
          // Site JSON API (plugins.json) with static-page + snapshot fallbacks.
          const catalog = await loadCatalog(String(body.lang || ''))
          if (catalog.source === 'none') {
            return sendJson(res, 502, { ok: false, error: 'catalog unavailable (site fetch failed and no snapshot)' })
          }
          return sendJson(res, 200, { ok: true, plugins: catalog.plugins, cats: catalog.cats, source: catalog.source })
        }
        if (method === 'probe') {
          // Validate a hand-filled CLI path instead of silently ignoring it.
          const explicit = String(body.binPath || '').trim()
          let binValid = null
          if (explicit) {
            try { binValid = existsSync(explicit) } catch { binValid = false }
          }
          return sendJson(res, 200, {
            ok: true,
            dshHome: dshHome(),
            node: process.execPath || null,
            cwd: process.cwd(),
            dshBin: dshBin(),
            binProvided: explicit || null,
            binValid,
          })
        }
        if (method === 'installed') {
          const profile = resolveProfile(body.profile)
          const p = profileDir(profile) + '/package.json'
          const builtin = readBuiltinPlugins(profile)
          if (!existsSync(p)) return sendJson(res, 200, { ok: true, profile, bundles: [], dependencies: {}, provenance: {}, builtin })
          const json = JSON.parse(readFileSync(p, 'utf8'))
          return sendJson(res, 200, {
            ok: true,
            profile,
            bundles: Array.isArray(json.dsh && json.dsh.profile && json.dsh.profile.bundles) ? json.dsh.profile.bundles : [],
            dependencies: json.dependencies || {},
            // owner/repo provenance per installed package, read from each
            // package.json — lets the UI match catalog repo URLs against
            // scoped/registry/monorepo installs whose package name differs.
            provenance: readInstalledProvenance(profile),
            // desktop-shell-synced packages: the UI badges them "built-in"
            // and hides the install/uninstall buttons.
            builtin,
          })
        }
        if (method === 'updates') {
          // Read-only update detection for installed plugins (no write op).
          const profile = resolveProfile(body.profile)
          const updates = await checkUpdates(profile)
          return sendJson(res, 200, { ok: true, profile, updates })
        }
        if (method === 'update') {
          // Re-resolve the installed spec to its latest and re-add as an op.
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          const profile = resolveProfile(body.profile)
          const name = String(body.name || '').trim()
          if (!name) return sendJson(res, 400, { ok: false, output: '缺少插件名' })
          const deps = readProfileDeps(profile)
          const spec = deps[name]
          if (spec === undefined) return sendJson(res, 200, { ok: false, output: '插件未安装：' + name })
          if (activeOp && activeOp.status === 'running') {
            return sendJson(res, 200, { ok: false, busy: true, output: '已有任务进行中：' + activeOp.label })
          }
          // 本地链接/文件安装：解析上游（GitHub repo / npm 名）后从上游接管更新
          // （解除本地目录链接，改用上游版本；本地源码保留）。
          let target = null
          if (spec.startsWith('link:') || spec.startsWith('file:')) {
            target = await linkedUpdateTarget(profile, name)
            if (!target) return sendJson(res, 200, { ok: false, output: '本地链接插件未能确定上游（' + name + '），无法从市场更新' })
            // pnpm 替换 link symlink 会 EPERM：先手动删除包目录，再让 dsh 全新安装。
            const pkgDir = join(profileDir(profile), 'node_modules', ...name.split('/'))
            if (existsSync(pkgDir)) {
              try { rmSync(pkgDir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
            }
          } else {
            target = spec.startsWith('github:') ? spec.replace(/#.*$/, '') : `${name}@latest`
          }
          const label = String(body.label || name)
          updatesCache = { ...updatesCache, [profile]: null } // force re-check after update
          const started = startOp('update', profile, target, label, String(body.binPath || '').trim(),
            (spec.startsWith('link:') || spec.startsWith('file:') ? '从上游接管更新 ' : '更新 ') + name + ' → ' + target + '\n')
          if (!started.ok) return sendJson(res, 200, started)
          return sendJson(res, 200, { ok: true, opId: started.opId, timeoutMs: DEFAULT_TIMEOUT })
        }
        if (method === 'op') {
          const wanted = String(body.opId || '')
          const op = opSnapshot()
          if (op === null) return sendJson(res, 200, { ok: true, op: null })
          if (wanted && op.id !== wanted) return sendJson(res, 200, { ok: true, op: null })
          return sendJson(res, 200, { ok: true, op })
        }
        if (method === 'kill') {
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          return sendJson(res, 200, killOp())
        }
        if (method === 'scan') {
          // V4.2：安装前轻量冲突预检（只读）：patch 行 / settings 命名
          // 空间 / 核心依赖版本冲突 → { ok, level, issues, candidate }。
          const profile = resolveProfile(body.profile)
          const target = String(body.source || '').trim()
          if (!target) return sendJson(res, 400, { ok: false, error: '缺少安装源' })
          const verdict = await conflictScan(profile, target)
          return sendJson(res, 200, verdict)
        }
        if (method === 'install' || method === 'uninstall') {
          // Write operations require a same-origin browser POST.
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          const profile = resolveProfile(body.profile)
          const target = String(method === 'install' ? (body.source || '') : (body.pkg || '')).trim()
          if (!target) return sendJson(res, 400, { ok: false, output: '缺少参数' })
          if (activeOp && activeOp.status === 'running') {
            return sendJson(res, 200, { ok: false, busy: true, output: '已有任务进行中：' + activeOp.label })
          }
          if (method === 'install') {
            // Builtin guard: the desktop shell re-syncs these packages on
            // every boot; a market install over one would be reverted and can
            // crash the loader (duplicate entry id). Refuse up front.
            const builtinHit = builtinCollision(target, readBuiltinPlugins(profile))
            if (builtinHit) {
              return sendJson(res, 200, {
                ok: false,
                builtin: true,
                output: '该插件已内置于客户端（' + builtinHit + '），无需也无法从市场重复安装；'
                  + '客户端每次启动都会同步内置版本，直接使用即可。',
              })
            }
          }
          if (method === 'install' && !body.skipCheck) {
            // V4.2：冲突预检（refuse 直接拒绝；warn 只提醒不拦）。
            // 与试装验证互补：这里是「会不会互相踩」，试装是「能不能启动」。
            const scan = await conflictScan(profile, target)
            if (scan.ok && scan.level === 'refuse') {
              return sendJson(res, 200, {
                ok: false,
                refused: true,
                output: '安装前冲突预检发现下列问题（真实 profile 未受影响）：\n\n'
                  + scan.issues.map((i) => '• ' + i.message).join('\n')
                  + '\n\n如需强制安装（风险自负），请勾选"跳过安全检查"。',
              })
            }
            // Source whitelist: curated catalog only (degrade open when the
            // catalog is unavailable; skipCheck bypasses).
            const catalog = await loadCatalog()
            const gate = await whitelistSource(target, catalog.plugins)
            if (!gate.allowed) {
              return sendJson(res, 200, {
                ok: false,
                refused: true,
                output: String(gate.reason || ''),
              })
            }
            const bin = String(body.binPath || '').trim() || dshBin()
            if (!bin) return sendJson(res, 200, { ok: false, error: 'dsh CLI 未定位（可在面板填写路径）' })
            // Fast path: a manifest declaring a web client half is certainly a
            // web plugin. Everything else must prove itself by trial boot.
            const cls = await classifyPlugin(target)
            if (!cls.webClient) {
              const verdict = await runProbe(bin, target)
              if (!verdict.ok) {
                const stage = verdict.stage === 'install'
                  ? '候选插件安装进试装环境失败'
                  : '试装启动验证失败：该插件装进 web profile 无法正常启动'
                return sendJson(res, 200, {
                  ok: false,
                  refused: true,
                  output: stage + '（真实 profile 未受影响，试装目录已清理）：\n\n' + String(verdict.output || '').slice(-8000)
                    + '\n\n如需强制安装（风险自负），请勾选"跳过试装验证"。',
                })
              }
            }
            // Real install with a snapshot for later rollback.
            const snap = snapshotProfile(profile)
            const label = String(body.label || target)
            const started = startOp(method, profile, target, label, bin,
              snap ? '已备份安装前状态：' + snap + '\n' : '')
            if (!started.ok) return sendJson(res, 200, started)
            return sendJson(res, 200, { ok: true, opId: started.opId, timeoutMs: DEFAULT_TIMEOUT })
          }
          const label = String(body.label || target)
          // V4.2：跳过安全检查的强制安装同样先备份安装前状态（与正常路径
          // 对齐），之后可从备份回滚。
          const snap = method === 'install' ? snapshotProfile(profile) : null
          // Uninstall: dispose the live hot mount FIRST, then disable any
          // loader entry under the same name. `dsh plugin remove` only edits
          // the persisted profile — the running Loader would otherwise keep
          // the row (hot-mounted subtree or regular bundle row) and
          // client-modules would keep serving a bundle that no longer exists,
          // failing the next page reload.
          if (method === 'uninstall') {
            await disposeHotMount(target)
            await disableLoaderEntry(target)
          }
          const started = startOp(method, profile, target, label, String(body.binPath || '').trim(),
            snap ? '已备份安装前状态：' + snap + '\n' : '')
          if (!started.ok) return sendJson(res, 200, started)
          return sendJson(res, 200, { ok: true, opId: started.opId, timeoutMs: DEFAULT_TIMEOUT })
        }
        // ── 统一市场扩展方法 ──────────────────────────────────────────────
        if (method === 'sources') {
          // 三源元信息 + 市场自身版本/自更新状态（getSources 级联）。
          const su = await selfUpdateCheck()
          return sendJson(res, 200, {
            ok: true,
            version: SELF_VERSION,
            profile: desktopProfile(),
            profileDir: profileDir(desktopProfile()),
            sources: ['catalog', 'github', 'npm'],
            self: su,
          })
        }
        if (method === 'github') {
          const r = await githubList(String(body.q || ''), Number(body.page || 1))
          if (!r.ok) return sendJson(res, 200, r)
          // 已装状态标注（同 profile 的依赖/bundles，命中即 installed）。
          const profile = resolveProfile(body.profile)
          const deps = readProfileDeps(profile)
          const builtin = readBuiltinPlugins(profile)
          for (const it of r.items) {
            const tail = it.name.toLowerCase()
            it.installed = false
            it.installedName = null
            for (const name of Object.keys(deps)) {
              const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
              if (base.toLowerCase() === tail || name.toLowerCase() === it.fullName.toLowerCase()) {
                it.installed = true
                it.installedName = name
                break
              }
            }
            it.builtin = builtin.some((b) => (b.includes('/') ? b.split('/').pop() : b).toLowerCase() === tail)
          }
          return sendJson(res, 200, r)
        }
        if (method === 'npm') {
          const r = await npmSearch(String(body.q || ''))
          if (!r.ok) return sendJson(res, 200, r)
          const profile = resolveProfile(body.profile)
          const deps = readProfileDeps(profile)
          for (const it of r.items) {
            it.installed = Object.prototype.hasOwnProperty.call(deps, it.fullName)
            it.installedName = it.installed ? it.fullName : null
            it.builtin = readBuiltinPlugins(profile).includes(it.fullName)
          }
          return sendJson(res, 200, r)
        }
        if (method === 'zhIntro') {
          const owner = String(body.owner || '').replace(/[^A-Za-z0-9_.-]/g, '')
          const repo = String(body.repo || '').replace(/[^A-Za-z0-9_.-]/g, '')
          if (!owner || !repo) return sendJson(res, 200, { ok: true, zhIntro: null })
          return sendJson(res, 200, { ok: true, zhIntro: await readZhIntro(owner, repo) })
        }
        if (method === 'autoState') {
          return sendJson(res, 200, autoUpdateState(resolveProfile(body.profile)))
        }
        if (method === 'setAutoUpdate') {
          if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          return sendJson(res, 200, setAutoUpdate(resolveProfile(body.profile), String(body.autoUpdate || '')))
        }
        if (method === 'checkNow') {
          // 手动触发一次更新检测（同源）。
          if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          const profile = resolveProfile(body.profile)
          updatesCache = { ...updatesCache, [profile]: null }
          const updates = await checkUpdates(profile)
          const updatable = Object.entries(updates).filter(([, u]) => u.updateAvailable).map(([name, u]) => ({ name, ...u }))
          return sendJson(res, 200, { ok: true, profile, updates, updatable, count: updatable.length })
        }
        if (method === 'updateAll') {
          // 一键全部更新：后台串行逐项（npm@latest / github HEAD re-resolve），
          // 立即返回，客户端轮询 updateProgress 显示进度窗口；单项失败不阻塞。
          if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          const profile = resolveProfile(body.profile)
          const bin = String(body.binPath || '').trim() || dshBin()
          if (!bin) return sendJson(res, 200, { ok: false, error: 'dsh CLI 未定位（可在面板填写路径）' })
          if (activeOp && activeOp.status === 'running') {
            return sendJson(res, 200, { ok: false, busy: true, output: '已有任务进行中：' + activeOp.label })
          }
          if (updateAllProgress && !updateAllProgress.finished) {
            return sendJson(res, 200, { ok: false, busy: true, output: '全部更新正在进行中，请稍候…' })
          }
          const updates = await checkUpdates(profile)
          const deps = readProfileDeps(profile)
          const builtinNames = new Set(readBuiltinPlugins(profile))
          // 组装待更新项：github/npm 直接解析目标；本地链接通过上游推断
          // （GitHub repo / npm 名）得到目标，查不到上游的跳过；内置插件跳过。
          const todos = []
          const beforeVersions = {}
          for (const [name, u] of Object.entries(updates)) {
            if (!u || !u.updateAvailable) continue
            if (builtinNames.has(name)) continue
            const spec = deps[name] || ''
            let target = null
            if (spec.startsWith('github:')) {
              target = spec.replace(/#.*$/, '')
            } else if (spec.startsWith('link:') || spec.startsWith('file:')) {
              target = await linkedUpdateTarget(profile, name)
            } else {
              target = name + '@latest'
            }
            if (!target) continue
            beforeVersions[name] = readInstalledVersion(profile, name)
            todos.push({ name, target, linked: spec.startsWith('link:') || spec.startsWith('file:') })
          }
          if (todos.length === 0) return sendJson(res, 200, { ok: true, done: [], failed: [], total: 0, message: '没有可更新的插件' })
          // 后台执行 + 进度记录
          updateAllProgress = {
            profile, startedAt: Date.now(), total: todos.length, idx: 0, current: null,
            done: [], skipped: [], pending: [], failed: [], finished: false, ok: false, output: '',
          }
          void (async () => {
            for (let i = 0; i < todos.length; i++) {
              const t = todos[i]
              updateAllProgress.idx = i + 1
              updateAllProgress.current = t.name
              updateAllProgress.output = updateAllProgress.output + `\n[${i + 1}/${todos.length}] 更新 ${t.name} → ${t.target}…`
              // 本地链接开发安装：从上游接管安装（解除本地目录链接，改用上游版本），
              // 本地开发目录原样保留。
              if (t.linked === true) {
                updateAllProgress.output += '\n  ℹ️ ' + t.name + '：本地链接将从上游接管安装（本地目录不再链接，源码保留在本地）'
              }
              // 先隔离预取：验证可装并把依赖拉到本地（不触碰真实 profile）。
              const st = await stageFetch(t.target, bin)
              if (!st.ok) {
                updateAllProgress.failed.push(t.name)
                updateAllProgress.output += '\n  ❌ ' + t.name + '：预取到本地失败（真实 profile 未受影响）：' + st.output
                continue
              }
              updateAllProgress.output += '\n  📥 ' + st.output
              const r = await runUpdateWithAllowBuilds(profile, t.target, t.name, bin)
              if (r && r.allowBuilds) {
                updateAllProgress.output += '\n  ℹ️ 已自动放行被拦截的构建脚本（' + r.allowBuilds.join(', ') + '）并重试'
              }
              const outTxt = String((r && (r.output || r.error)) || '')
              // Windows 文件锁排队：任务已写进 .dsh-market-pending.json，
              // 重启 Web 服务后自动完成 —— 不算失败。
              if (/\[pending\]|文件被运行中的服务占用|已排队|任务已排队/i.test(outTxt)) {
                updateAllProgress.pending.push(t.name)
                updateAllProgress.output += '\n  ⏳ ' + t.name + '：文件被运行中的服务占用，任务已排队；重启 Web 服务后自动完成，无需手动重试'
                continue
              }
              // 成功判定：命令成功 且 版本真的提升（minimumReleaseAge <24h 会让
              // 命令成功但版本不涨，此时要如实记失败并区分原因）。
              const afterV = readInstalledVersion(profile, t.name)
              const beforeV = beforeVersions[t.name]
              const progressed = afterV && beforeV && hasUpdateOfVersion(beforeV, afterV)
              if (r && r.ok && progressed) {
                updateAllProgress.done.push(t.name)
                updateAllProgress.output += '\n  ✅ ' + t.name + ' → v' + afterV + ' 已更新'
              } else {
                updateAllProgress.failed.push(t.name)
                const outTxt = String((r && (r.output || r.error)) || '')
                const ageBlock = /minimum\s*release\s*age|release age|24\s*h/i.test(outTxt)
                const tail = outTxt.split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(0, 240)
                const reason = !progressed
                  ? (ageBlock
                    ? '上游新版本发布不足 24h（pnpm 发布保护期），稍后再试'
                    : (tail || '版本未变化'))
                  : (tail || String((r && r.error) || '更新失败'))
                updateAllProgress.output += '\n  ❌ ' + t.name + '：' + reason
              }
            }
            updateAllProgress.current = null
            updateAllProgress.finished = true
            updateAllProgress.ok = updateAllProgress.failed.length === 0
            updateAllProgress.output += '\n完成：成功 ' + updateAllProgress.done.length + '，排队 ' + updateAllProgress.pending.length + '，失败 ' + updateAllProgress.failed.length
            updatesCache = { ...updatesCache, [profile]: null }
          })()
          return sendJson(res, 200, { ok: true, started: true, profile, total: todos.length })
        }
        if (method === 'updateProgress') {
          // 全部更新进度（进行中或最近一次完成结果）。
          return sendJson(res, 200, { ok: true, progress: updateAllProgress })
        }
        if (method === 'selfUpdate') {
          const r = await selfUpdateCheck()
          return sendJson(res, 200, r)
        }
        return sendJson(res, 404, { ok: false, error: 'unknown method ' + method })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
  // 统一市场主路径 + 底座兼容路径共用同一 handler。
  webServer.register({ kind: 'exact', path: '/api/dsh-unified-market', handler: routeHandler })
  webServer.register({ kind: 'exact', path: '/api/dsh-market', handler: routeHandler })

  // 后台自动更新检测（EAC 特化：只针对桌面壳真实生效的 profile）：
  // 启动 20 秒后首检，之后每 6 小时；autoUpdate=auto 时自动逐项升级。
  const autoProfile = desktopProfile()
  // 服务启动早期消费排队更新（重启服务即可完成之前因文件锁排队的更新）。
  void consumePendingUpdates(autoProfile)
  const firstDelay = setTimeout(() => { autoCheckTick(autoProfile, ctx) }, AUTO_CHECK_DELAY)
  autoCheckTimer = setInterval(() => { autoCheckTick(autoProfile, ctx) }, AUTO_CHECK_INTERVAL)
  ctx.on('dispose', () => {
    clearTimeout(firstDelay)
    if (autoCheckTimer) clearInterval(autoCheckTimer)
    autoCheckTimer = null
    setQuitting(true)
  })
}

// Browser half of the persistent plugin market. Loaded through the web
// plugin loader (window.__ModuleLoader__); React comes from the platform
// module table. Talks to the Host half over the /api/dsh-market HTTP route.
//
// Install/uninstall run as background ops on the Host: the panel submits, gets
// an op id, and polls. The op lives in a fixed modal overlay (never lost by
// scrolling), can be minimized to a status chip, and survives page refreshes.
window.__ModuleLoader__.load({ id: '@sanqi-normal/dsh-webui-market-plugin', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  const React = require('react')
  const { useState, useEffect, useRef } = React
  const h = React.createElement

  function api(method, params) {
    return fetch('/api/dsh-market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ method }, params || {})),
    }).then((r) => r.json())
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

  // Normalize a GitHub URL to `owner/repo` (lowercase) or null.
  function ownerRepoOf(url) {
    const s = String(url || '').replace(/\/+$/, '')
    const m = /github\.com[\/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?=[\/#?]|$)/.exec(s)
    return m ? m[1].toLowerCase() : null
  }

  // Installed state is keyed per profile (each plugin's install command may
  // target a different profile). Match is repo-identity first (the host now
  // reports each installed package's owner/repo provenance, so scoped npm
  // names / monorepo subpackages whose key ≠ repo basename still resolve —
  // issue #17), then basename heuristics as fallback.
  function installedPkgName(plugin, installed) {
    if (!installed) return null
    const repo = repoNameOf(plugin.url)
    const ownerRepo = ownerRepoOf(plugin.url)
    const prov = installed.provenance || {}
    const deps = installed.dependencies || {}
    const scan = (key) => {
      if (ownerRepo && prov[key] === ownerRepo) return true
      if (key === repo || key.endsWith('/' + repo) || key === 'github:' + repo) return true
      return repoOfValue(deps[key]) === repo
    }
    for (const key of Object.keys(deps)) {
      if (scan(key)) return key
    }
    for (const b of installed.bundles || []) {
      if (ownerRepo && prov[b] === ownerRepo) return b
      if (b === repo || b.endsWith('/' + repo) || b === 'github:' + repo) return b
    }
    return null
  }

  // installed is a { profile: state } map; a plugin is installed when the state
  // of its own target profile matches.
  function isInstalled(plugin, installedMap) {
    const state = installedMap && installedMap[plugin.profile || 'web']
    return installedPkgName(plugin, state) !== null
  }

  // Builtin (desktop-shell-synced) packages, reported per profile by the host
  // (state.builtin). Matching mirrors installedPkgName's repo-identity logic;
  // they render as "built-in" with install/uninstall hidden — a market install
  // over them would be reverted by the next sync and can crash the loader.
  function builtinPkgName(plugin, installedState) {
    if (!installedState || !Array.isArray(installedState.builtin)) return null
    const repo = repoNameOf(plugin.url)
    const ownerRepo = ownerRepoOf(plugin.url)
    const repoTail = ownerRepo ? ownerRepo.split('/')[1] : null
    const srcBase = plugin.source ? repoOfValue(plugin.source) : null
    for (const name of installedState.builtin) {
      const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
      if (repoTail && base === repoTail) return name
      if (repo && (base === repo || name === repo)) return name
      if (srcBase && base === srcBase) return name
    }
    return null
  }

  function isBuiltin(plugin, installedMap) {
    const state = installedMap && installedMap[plugin.profile || 'web']
    return builtinPkgName(plugin, state) !== null
  }

  let LOCALE = 'en'
  try {
    const nl = String(navigator.language || navigator.userLanguage || '')
    if (nl.toLowerCase().startsWith('zh')) LOCALE = 'zh'
  } catch (e) {}

  const STR = {
    zh: {
      search: '搜索插件…', all: '全部', instFilter: '已安装', detail: '详情', collapse: '收起',
      install: '安装', uninstall: '卸载', execute: '执行', cancel: '取消', close: '关闭',
      loading: '加载插件目录…', noMatch: '没有匹配的插件',
      binPlaceholder: 'dsh CLI 路径（自动探测失败时填写，已记住上次填写）', reprobe: '重新探测',
      installOk: '安装成功，下次重启 Web 服务后生效', uninstallOk: '卸载成功，下次重启 Web 服务后生效', opFailed: '操作失败',
      hotOk: '安装成功，已热挂载，即将自动刷新页面生效',
      updateOk: '更新成功，下次重启 Web 服务后生效', updateBtn: '更新', updating: '更新中…', upToDate: '已是最新',
      updateFail: '更新检测失败', updLocal: '本地链接',
      running: '执行中…（pnpm 安装可能需要一段时间）',
      cmdLabel: '安装命令（来自官网，含目标 profile）:', noCmd: '（无官方安装命令）',
      hint: '安装后需重启 Web 服务生效；GitHub 源会执行包内 prepare 脚本（pnpm allowBuilds 需放行）。安装进 web 前会做两层安全把关：① 只允许安装精选目录收录的源；② 试装验证——在临时环境实际启动一次，确认 web 能正常启动才写入真实 profile。验证失败会给出真实启动错误且不改动现有安装；简单插件装好后会自动热挂载（无需重启）。确实需要强制安装时可勾选"跳过安全检查"（风险自负）。',
      gh: 'GitHub ↗', envLine: '环境', parseFail: '解析失败', fetchFail: '抓取失败',
      submit: '提交任务…', probing: '试装验证中…（临时环境实际启动验证 web 可正常启动后才安装，约 1~6 分钟）', min: '最小化到后台', kill: '终止任务', back: '返回',
      stDone: '完成', stFailed: '失败', stKilled: '已终止', stTimeout: '超时终止',
      stBusy: '已有任务进行中', stRefused: '已拒绝', liveChip: '插件任务',
      elapsed: '已耗时 {s}s（超过 {t}s 自动终止）', newOp: '新任务',
      pendTitle: '已排队：文件被运行中的服务占用，重启服务后自动完成',
      pendHint: '无需重试：任务已记录，将在下次启动 Web 服务时（加载插件前、无文件锁）自动执行。点击下方按钮可立即重启完成。',
      restartNow: '立即重启并完成', restarting: '重启中，正在完成安装…',
      site: '插件目录来源',
      sortDefault: '默认', sortHot: '最热', sortNew: '最新',
      builtin: '已内置', builtinHint: '该插件已随客户端内置分发，每次启动自动同步，无需安装', stBuiltin: '内置插件',
      scanTitle: '安装前冲突预检', scanRun: '预检中…', scanWarn: '注意', scanRefuse: '已拒绝',
      scanForce: '勾选"跳过安全检查"可强制安装（风险自负）。',
      marketBanner: '两个插件市场并存：本页为精选目录（awesome-dsh-plugin.com）；另一个「Zat 可视化市场」（GitHub dsh-plugin 检索 + 中文简介）已内置，见 设置 → 插件 中的 Zat 标签页。',
    },
    en: {
      search: 'Search plugins…', all: 'All', instFilter: 'Installed', detail: 'Details', collapse: 'Collapse',
      install: 'Install', uninstall: 'Uninstall', execute: 'Run', cancel: 'Cancel', close: 'Close',
      loading: 'Loading plugin directory…', noMatch: 'No matching plugins',
      binPlaceholder: 'dsh CLI path (fill when auto-detection fails; remembered)', reprobe: 'Re-probe',
      installOk: 'Installed — restart the web server to activate', uninstallOk: 'Uninstalled — restart the web server to activate', opFailed: 'Operation failed',
      hotOk: 'Installed and hot-mounted — refreshing the page now',
      updateOk: 'Updated — restart the web server to activate', updateBtn: 'Update', updating: 'Updating…', upToDate: 'Up to date',
      updateFail: 'Update check failed', updLocal: 'linked (dev)',
      running: 'Running… (pnpm install may take a while)',
      cmdLabel: 'Install command (from the site, incl. target profile):', noCmd: '(no official install command)',
      hint: 'Restart the web server after install. GitHub sources run the package prepare script (pnpm allowBuilds). Installing into web is gated twice: ① only sources from the curated catalog are accepted; ② a trial boot installs the plugin into a throwaway environment and starts it once — only a clean boot (the dsh web: readiness line) allows the install, and on failure the real boot error is shown with nothing modified. Simple plugins are hot-mounted after install (no restart). To force-install anyway, tick "skip safety checks" (at your own risk).',
      gh: 'GitHub ↗', envLine: 'Env', parseFail: 'Parse failed', fetchFail: 'Fetch failed',
      submit: 'Submitting…', probing: 'Trial-boot verifying… (installing into a throwaway env and starting it once to prove web still boots; ~1-6 min)', min: 'Minimize to background', kill: 'Kill task', back: 'Back',
      stDone: 'Done', stFailed: 'Failed', stKilled: 'Killed', stTimeout: 'Timed out',
      stBusy: 'A task is already running', stRefused: 'Refused', liveChip: 'Plugin task',
      elapsed: '{s}s elapsed (auto-kill after {t}s)', newOp: 'New task',
      pendTitle: 'Queued: files are locked by the running service; completes automatically on restart',
      pendHint: 'No retry needed: the task is recorded and will run before the web service loads (no file locks). Click below to restart and finish now.',
      restartNow: 'Restart now & finish', restarting: 'Restarting, finishing install…',
      site: 'Plugin directory source',
      sortDefault: 'Default', sortHot: 'Top', sortNew: 'New',
      builtin: 'Built-in', builtinHint: 'Shipped with the client and re-synced on every launch — no install needed', stBuiltin: 'Built-in plugin',
      scanTitle: 'Pre-install conflict check', scanRun: 'Checking…', scanWarn: 'Note', scanRefuse: 'Refused',
      scanForce: 'Tick "skip safety checks" to force-install (at your own risk).',
      marketBanner: 'Two plugin markets coexist: this page is the curated catalog (awesome-dsh-plugin.com); the bundled "Zat" market (GitHub dsh-plugin search + bilingual intros) has its own tab under Settings → Plugins.',
    },
  }
  const t = (k) => { const m = STR[LOCALE]; return (m && m[k] !== undefined) ? m[k] : (STR.zh[k] !== undefined ? STR.zh[k] : k) }
  const fmt = (k, map) => String(t(k)).replace(/\{(\w+)\}/g, (_, n) => String(map[n] !== undefined ? map[n] : ''))

  const MARKET_CSS = `
.mkts{font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary);max-width:60rem}
.mkts-env{font-family:ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px;white-space:pre-wrap}
.mkts-env-bad{color:var(--dsw-alias-label-error)}
.mkts-bin-row{display:flex;gap:6px;align-items:center;margin-bottom:6px}
.mkts-bin-input{flex:1;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,monospace;font-size:12px;padding:5px 10px;caret-color:var(--dsw-alias-brand-primary)}
.mkts-bin-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.mkts-finder{position:sticky;top:0;z-index:5;background:var(--dsw-alias-bg-layer-2)}
.mkts-row1{display:flex;gap:10px;align-items:center;padding-block:10px}
.mkts-search{flex:1;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px;caret-color:var(--dsw-alias-brand-primary);min-width:0}
.mkts-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.mkts-count{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mkts-livechip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-static-deepseek-500);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;cursor:pointer;white-space:nowrap;background:var(--dsw-alias-bg-layer-3)}
.mkts-livechip:hover{border-color:var(--dsw-alias-label-dimmed)}
.mkts-livechip-done{color:var(--dsw-alias-state-success-primary)}
.mkts-livechip-err{color:var(--dsw-alias-label-error)}
.mkts-chips{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.mkts-chip{font-size:12px;color:var(--dsw-alias-label-secondary);background:none;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;cursor:pointer}
.mkts-chip small{color:var(--dsw-alias-label-tertiary);font-size:10px}
.mkts-chip:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}
.mkts-chip-on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.mkts-chip-on small{color:inherit;opacity:.8}
.mkts-sort{display:flex;gap:2px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:2px;margin-left:auto;flex-shrink:0}
.mkts-sort button{border:none;background:none;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.mkts-sort button.on{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);font-weight:600}
.mkts-sec{padding-block:14px 8px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:baseline;gap:8px}
.mkts-sec small{font-size:11px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.mkts-item{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,box-shadow .16s,transform .16s;align-items:flex-start}
.mkts-item:hover{border-color:var(--dsw-alias-label-dimmed);box-shadow:0 4px 18px rgba(0,0,0,.18)}
.mkts-avatar{flex:none;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;font-size:15px;font-weight:700;color:var(--dsw-alias-bg-layer-3);background:linear-gradient(135deg,var(--dsw-static-deepseek-500,#4f6bde),color-mix(in srgb,var(--dsw-static-deepseek-500,#4f6bde) 55%,#8a63d2));user-select:none}
.mkts-no{flex:none;font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);padding-top:3px;min-width:40px}
.mkts-main{flex:1;min-width:0}
.mkts-main h3{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.mkts-main h3 a{color:var(--dsw-alias-label-primary);text-decoration:none}
.mkts-main h3 a:hover{color:var(--dsw-static-deepseek-500)}
.mkts-by{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}
.mkts-stars{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}
.mkts-gh{margin-left:8px;font-size:11px;color:var(--dsw-static-deepseek-500);text-decoration:none}
.mkts-gh:hover{text-decoration:underline}
.mkts-desc{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12.5px;max-width:52em;overflow-wrap:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mkts-item .mkts-detail{display:block;-webkit-line-clamp:unset;overflow:visible}
.mkts-marketbanner{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);border:1px dashed color-mix(in srgb,var(--dsw-static-deepseek-500) 45%,transparent);border-radius:10px;padding:7px 12px;margin-bottom:10px;background:color-mix(in srgb,var(--dsw-static-deepseek-500) 7%,transparent)}
.mkts-actions{flex:none;display:flex;flex-direction:column;gap:4px;align-items:flex-end}
.mkts-cmdbtn{appearance:none;background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);padding:3px 12px;cursor:pointer;white-space:nowrap}
.mkts-cmdbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.mkts-cmdbtn-primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.mkts-cmdbtn-primary:hover:not(:disabled){opacity:.85;color:var(--dsw-alias-bg-layer-3)}
.mkts-cmdbtn-danger{color:var(--dsw-alias-label-error)}
.mkts-cmdbtn-danger:hover:not(:disabled){border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-error)}
.mkts-cmdbtn:disabled{opacity:.4;cursor:default}
.mkts-state{font-size:11px;padding:1px 8px;border-radius:999px;line-height:17px;font-weight:500;white-space:nowrap}
.mkts-state-on{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
.mkts-state-builtin{background:color-mix(in srgb, var(--dsw-static-deepseek-500) 16%, transparent);color:var(--dsw-static-deepseek-500);cursor:help}
.mkts-state-off{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.mkts-log{background:#1e1e1e;color:#d4d4d4;border-radius:8px;padding:8px 10px;margin-top:6px;white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:240px;overflow:auto}
.mkts-err{color:var(--dsw-alias-label-error);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-radius:8px;padding:6px 10px;margin-bottom:10px}
.mkts-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.mkts-detail{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.mkts-detail code{display:block;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;margin:6px 0;white-space:pre-wrap;word-break:break-all}
.mkts-modal-bg{position:fixed;inset:0;z-index:1000;background:color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent);display:flex;align-items:flex-start;justify-content:center;padding:9vh 16px 24px;overflow:auto}
.mkts-modal{width:min(780px,100%);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:16px 18px;box-shadow:0 16px 48px rgba(0,0,0,.35)}
.mkts-modal h4{margin:0 0 10px;font-size:15px;font-weight:600}
.mkts-cmdrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.mkts-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-static-deepseek-500);border-radius:50%;animation:mkts-spin .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes mkts-spin{to{transform:rotate(360deg)}}
.mkts-site{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.mkts-site a{color:var(--dsw-static-deepseek-500);text-decoration:none}
.mkts-site a:hover{text-decoration:underline}
.mkts-skipcheck{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px;cursor:pointer}
`

  function MarketPanel() {
    const [data, setData] = useState({ phase: 'loading', plugins: [], cats: [], installed: null, updates: null, error: null })
    const [envInfo, setEnvInfo] = useState(null)
    const [binPath, setBinPath] = useState((() => { try { return localStorage.getItem('mktsBin') || '' } catch (e) { return '' } })())
    const [query, setQuery] = useState('')
    const [cat, setCat] = useState('all')
    const [showInstalled, setShowInstalled] = useState(false)
    const [sortBy, setSortBy] = useState('default')
    const [open, setOpen] = useState(null)
    const [op, setOp] = useState(null)
    const pollStop = useRef(false)
    useEffect(() => () => { pollStop.current = true }, [])

    const changeBin = (v) => { setBinPath(v); try { localStorage.setItem('mktsBin', v) } catch (e) {} }

    const probe = () => {
      api('probe', { binPath }).then((r) => setEnvInfo(r)).catch(() => setEnvInfo({ error: 'probe failed' }))
    }

    const loadInstalled = (plugins) => {
      const list = plugins || data.plugins || []
      const profiles = [...new Set(list.map((p) => p.profile || 'web').concat('web'))]
      Promise.all(profiles.map((profile) => api('installed', { profile }).then((r) => [profile, r]).catch(() => [profile, null])))
        .then((entries) => setData((d) => ({ ...d, installed: Object.fromEntries(entries) })))
        .catch(() => setData((d) => ({ ...d, installed: null })))
      Promise.all(profiles.map((profile) => api('updates', { profile }).then((r) => [profile, r && r.ok ? (r.updates || {}) : {}]).catch(() => [profile, {}])))
        .then((entries) => setData((d) => ({ ...d, updates: Object.fromEntries(entries) })))
        .catch(() => setData((d) => ({ ...d, updates: null })))
    }

    useEffect(() => { probe() }, [])

    useEffect(() => {
      let alive = true
      setData((d) => ({ ...d, phase: 'loading', error: null }))
      const finish = (r) => {
        if (!alive || !r || !r.ok) throw new Error((r && r.error) || 'empty')
        setData((d) => ({ ...d, phase: 'ready', plugins: r.plugins || [], cats: r.cats || [] }))
        loadInstalled(r.plugins || [])
      }
      api('list', { lang: LOCALE }).then(finish).catch((e) => {
        if (!alive) return
        setData((d) => ({ ...d, phase: 'error', error: t('fetchFail') + ': ' + String((e && e.message) || e) }))
      })
      return () => { alive = false }
    }, [])

    // Resume a background op after a page refresh / tab switch.
    useEffect(() => {
      api('op', {}).then((r) => {
        if (!r || !r.ok || !r.op || r.op.status !== 'running') return
        const o = r.op
        setOp({
          kind: o.kind, target: o.target, label: o.label, profile: o.profile,
          phase: 'running', opId: o.id, output: o.output, status: 'running', exitCode: null, minimized: false,
          elapsedMs: o.elapsedMs, timeoutMs: o.timeoutMs,
        })
        pollOp(o.id)
      }).catch(() => {})
    }, [])

    function pollOp(opId) {
      const step = () => {
        if (pollStop.current) return
        api('op', { opId }).then((r) => {
          if (pollStop.current) return
          const o = r && r.ok ? r.op : null
          if (!o) return // op gone (replaced/restarted) — stop polling
          setOp((prev) => {
            if (!prev || prev.opId !== opId) return prev
            if (o.status === 'running') {
              return { ...prev, phase: 'running', output: o.output, elapsedMs: o.elapsedMs, timeoutMs: o.timeoutMs }
            }
            return {
              ...prev, phase: 'done', output: o.output, status: o.status,
              exitCode: o.exitCode, ok: o.status === 'done', hot: o.hot === true,
              pendingRestart: o.pendingRestart === true,
            }
          })
          if (o.status === 'running') {
            setTimeout(step, 2000)
          } else {
            loadInstalled() // terminal: profile deps/bundles changed — refresh badges
            // Hot-mounted installs are already live in this process: reload the
            // page so the new client half mounts, then the panel re-appears.
            if (o.status === 'done' && o.hot === true && op && op.kind === 'install' && !pollStop.current) {
              setTimeout(() => { try { location.reload() } catch (e) {} }, 1600)
            }
          }
        }).catch(() => { if (!pollStop.current) setTimeout(step, 3000) })
      }
      step()
    }

    const runOp = (kind, target, label, profile) => {
      setOp({ kind, target, label, profile: profile || 'web', phase: 'confirm', minimized: false, skipCheck: false, issues: null, scanDone: false, refuse: false })
    }

    // V4.2：打开安装确认弹窗时跑一次轻量冲突预检（只读），refuse 直接
    // 禁止执行（勾选 skipCheck 可强制），warn 红字列出提醒。预检失败
    // （网络/解析）不阻塞 —— 试装验证与后端门卫仍然兜底。
    useEffect(() => {
      if (!op || op.kind !== 'install' || op.phase !== 'confirm' || op.scanDone) return
      api('scan', { source: op.target, profile: op.profile }).then((r) => {
        setOp((prev) => prev ? {
          ...prev, scanDone: true,
          issues: (r && r.ok) ? (Array.isArray(r.issues) ? r.issues : []) : [],
          refuse: !!(r && r.ok && r.level === 'refuse'),
        } : prev)
      }).catch(() => setOp((prev) => prev ? { ...prev, scanDone: true, issues: [], refuse: false } : prev))
    }, [op])

    const executeOp = () => {
      if (!op) return
      // V4.2：冲突预检 refuse 且未勾选跳过 → 不发起安装，直接展示问题。
      if (op.refuse && !op.skipCheck) {
        setOp({
          ...op, phase: 'done', status: 'refused',
          output: t('scanTitle') + '：\n\n' + (op.issues || []).map((i) => '• ' + i.message).join('\n')
            + '\n\n' + t('scanForce'),
          ok: false,
        })
        return
      }
      setOp({ ...op, phase: 'starting', output: '' })
      const params = op.kind === 'install'
        ? { source: op.target, profile: op.profile, binPath, label: op.label, skipCheck: !!op.skipCheck }
        : op.kind === 'update'
          ? { name: op.target, profile: op.profile, binPath, label: op.label }
          : { pkg: op.target, profile: op.profile, binPath, label: op.label }
      api(op.kind === 'uninstall' ? 'uninstall' : (op.kind === 'update' ? 'update' : 'install'), params).then((r) => {
        if (!r || !r.ok) {
          setOp({
            ...op, phase: 'done', status: r && r.builtin ? 'builtin' : (r && r.busy ? 'busy' : (r && r.refused ? 'refused' : 'failed')),
            output: String((r && (r.output || r.error)) || t('opFailed')), ok: false,
          })
          return
        }
        setOp({ ...op, phase: 'running', opId: r.opId, output: '', status: 'running', elapsedMs: 0, timeoutMs: r.timeoutMs })
        pollOp(r.opId)
      }).catch((e) => {
        setOp({ ...op, phase: 'done', status: 'failed', output: String((e && e.message) || e), ok: false })
      })
    }

    const killCurrent = () => {
      api('kill').then((r) => {
        if (r && r.ok) {
          setOp((prev) => prev ? { ...prev, phase: 'done', status: 'killed', ok: false } : prev)
          loadInstalled() // the kill may have partially applied — resync state
        } else {
          setOp((prev) => prev ? { ...prev, phase: 'done', status: 'failed', output: String((r && r.output) || t('opFailed')), ok: false } : prev)
        }
      }).catch(() => {})
    }

    const minimizeOp = () => setOp((prev) => prev ? { ...prev, minimized: true } : prev)
    // 桌面壳的重启桥：排队任务（文件锁）在服务重启前的无锁窗口自动完成。
    const bridge = (typeof window !== 'undefined' && window.dshDesktop) || null
    const canRestart = !!(bridge && typeof bridge.restartService === 'function')
    const doRestart = () => {
      if (!canRestart) return
      setOp((prev) => prev ? { ...prev, restarting: true } : prev)
      Promise.resolve(bridge.restartService()).catch(() => {}).finally(() => { try { location.reload() } catch (e) {} })
    }
    const restoreOp = () => setOp((prev) => prev ? { ...prev, minimized: false } : prev)
    const closeOp = () => setOp(null)

    const filtered = (data.plugins || []).filter((p) => {
      if (cat !== 'all' && p.cat !== cat) return false
      if (showInstalled && !isInstalled(p, data.installed)) return false
      const q = query.trim().toLowerCase()
      if (q && !((p.name || '').toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q) || (p.by || '').toLowerCase().includes(q))) return false
      return true
    })

    const installedCount = (data.plugins || []).filter((p) => isInstalled(p, data.installed)).length

    // Sort, mirroring dsh-market: 最热 = stars desc (unknown stars last),
    // 最新 = added date desc; 默认 keeps the site's own order.
    const sorted = sortBy === 'hot'
      ? [...filtered].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
      : sortBy === 'new'
        ? [...filtered].sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')))
        : filtered

    let groups = []
    if (cat === 'all' && !showInstalled) {
      for (const c of data.cats || []) {
        if (c.id === 'all') continue
        const items = sorted.filter((p) => p.cat === c.id)
        if (items.length > 0) groups.push({ id: c.id, label: c.label, items })
      }
    } else {
      groups.push({ id: 'sel', label: null, items: sorted })
    }

    const binOk = envInfo && (envInfo.dshBin || (envInfo.binProvided && envInfo.binValid))
    const envReady = envInfo && binOk && envInfo.node && envInfo.dshHome

    const statusText = (s) => ({
      done: t('stDone'), failed: t('stFailed'), killed: t('stKilled'),
      timeout: t('stTimeout'), busy: t('stBusy'), refused: t('stRefused'), builtin: t('stBuiltin'),
    })[s] || t('opFailed')

    const opTitle = (op) => (op.kind === 'install' ? t('install') : op.kind === 'update' ? t('updateBtn') : t('uninstall')) + ' ' + op.label

    const modal = op && !op.minimized ? h('div', { className: 'mkts-modal-bg', onClick: () => { if (op.phase === 'running' || op.phase === 'starting') minimizeOp(); else closeOp() } },
      h('div', { className: 'mkts-modal', onClick: (e) => e.stopPropagation() },
        h('h4', null, opTitle(op)),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace,monospace' } },
          op.kind === 'uninstall'
            ? 'dsh plugin --profile ' + op.profile + ' remove ' + op.target
            : op.kind === 'update'
              ? 'dsh plugin --profile ' + op.profile + ' add <latest ' + op.target + '>'
              : 'dsh plugin --profile ' + op.profile + ' add ' + op.target),
        op.phase === 'confirm' ? h('div', null,
          op.issues && op.issues.length ? h('div', null,
            h('div', { style: { fontSize: 12, fontWeight: 600, margin: '10px 0 4px', color: op.refuse ? 'var(--dsw-alias-label-error)' : 'var(--dsw-static-deepseek-500)' } },
              t('scanTitle') + (op.refuse ? '（' + t('scanRefuse') + '）' : '')),
            h('div', { className: 'mkts-err', style: { margin: '4px 0 0' } },
              op.issues.map((i, n) => h('div', { key: n, style: { color: i.severity === 'refuse' ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-label-secondary)' } },
                (i.severity === 'refuse' ? '✗ ' : '△ ') + i.message))),
            op.refuse ? h('div', { className: 'mkts-hint' }, t('scanForce')) : null,
          ) : null,
          op.issues === null ? h('div', { className: 'mkts-hint', style: { marginTop: 8 } },
            h('span', { className: 'mkts-spin' }), t('scanRun')) : null,
          h('div', { className: 'mkts-cmdrow' },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '✓ ' + t('cmdLabel').replace(':', '') + ''),
            h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', disabled: !!(op.refuse && !op.skipCheck), onClick: executeOp }, t('execute')),
            h('button', { className: 'mkts-cmdbtn', onClick: closeOp }, t('cancel')),
          ),
          op.kind === 'install' ? h('label', { className: 'mkts-skipcheck' },
            h('input', { type: 'checkbox', checked: !!op.skipCheck, onChange: (e) => setOp((prev) => prev ? { ...prev, skipCheck: e.target.checked } : prev) }),
            h('span', null, LOCALE === 'zh' ? '跳过安全检查（冲突预检 + 来源白名单 + 试装验证，风险自负：可能装坏 web 启动）' : 'Skip safety checks (conflict preflight + source whitelist + trial boot; risky: may break web boot)'),
          ) : null,
        ) : null,
        op.phase === 'starting' ? h('div', { className: 'mkts-cmdrow' },
          h('span', { className: 'mkts-spin' }), h('span', { style: { fontSize: 12 } },
            (op.kind === 'install' && op.profile === 'web' && !op.skipCheck) ? t('probing') : t('submit')),
        ) : null,
        op.phase === 'running' ? h('div', null,
          h('div', { className: 'mkts-cmdrow' },
            h('span', { className: 'mkts-spin' }),
            h('span', { style: { fontSize: 12 } },
              t('running') + ' · ' + fmt('elapsed', { s: Math.round((op.elapsedMs || 0) / 1000), t: op.timeoutMs ? Math.round(op.timeoutMs / 1000) : 120 })),
            h('button', { className: 'mkts-cmdbtn', onClick: minimizeOp }, t('min')),
            h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', onClick: killCurrent }, t('kill')),
          ),
          op.output ? h('div', { className: 'mkts-log' }, op.output) : null,
        ) : null,
        op.phase === 'done' ? h('div', null,
          op.pendingRestart
            ? h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '⏳ ' + t('pendTitle'))
            : h('div', { style: { fontSize: 12, fontWeight: 600, color: op.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-error)' } },
              op.ok
                ? (op.kind === 'install'
                  ? (op.hot ? t('hotOk') : t('installOk'))
                  : op.kind === 'update'
                    ? t('updateOk')
                    : t('uninstallOk'))
                : statusText(op.status) + (op.exitCode !== null && op.exitCode !== undefined ? ' (exit ' + op.exitCode + ')' : '')),
          op.pendingRestart ? h('div', { className: 'mkts-hint', style: { margin: '6px 0 0' } }, t('pendHint')) : null,
          op.pendingRestart && canRestart ? h('div', { className: 'mkts-cmdrow' },
            h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', disabled: !!op.restarting, onClick: doRestart },
              op.restarting ? t('restarting') : t('restartNow')),
          ) : null,
          op.output ? h('div', { className: 'mkts-log' }, op.output) : null,
          h('div', { className: 'mkts-cmdrow' }, h('button', { className: 'mkts-cmdbtn', onClick: closeOp }, t('close'))),
        ) : null,
      )) : null

    const liveChip = op && op.minimized ? h('button', {
      className: 'mkts-livechip' + (op.phase === 'done' ? (op.ok ? ' mkts-livechip-done' : ' mkts-livechip-err') : ''),
      onClick: restoreOp,
      title: op.label,
    },
      op.phase === 'done' ? (op.ok ? t('stDone') : statusText(op.status)) : t('liveChip'),
      ' · ' + op.label,
    ) : null

    return h('div', { className: 'mkts' },
      envInfo ? h('div', { className: 'mkts-env' + (envReady ? '' : ' mkts-env-bad') },
        t('envLine') + ': DSH_HOME ' + (envInfo.dshHome ? '✓ ' + envInfo.dshHome : '✗') + ' · node ' + (envInfo.node ? '✓' : '✗') + ' · dsh ' + (binOk ? '✓' : '✗') +
        ((!envInfo.dshBin && !(envInfo.binProvided && envInfo.binValid)) ? ' — dsh CLI 未定位' : ''),
      ) : null,
      h('div', { className: 'mkts-bin-row' },
        h('input', { className: 'mkts-bin-input', placeholder: t('binPlaceholder'), value: binPath, onChange: (e) => changeBin(e.target.value) }),
        h('button', { className: 'mkts-cmdbtn', onClick: probe }, t('reprobe')),
      ),
      h('div', { className: 'mkts-site' },
        h('span', null, t('site') + ': '),
        h('a', { href: LOCALE === 'zh' ? 'https://awesome-dsh-plugin.com/zh/' : 'https://awesome-dsh-plugin.com/', target: '_blank', rel: 'noopener noreferrer' },
          LOCALE === 'zh' ? 'https://awesome-dsh-plugin.com/zh/' : 'https://awesome-dsh-plugin.com/'),
        h('span', null, ' ↗'),
      ),
      modal,
      h('div', { className: 'mkts-finder' },
        h('div', { className: 'mkts-row1' },
          h('input', { className: 'mkts-search', placeholder: t('search'), value: query, onChange: (e) => setQuery(e.target.value) }),
          liveChip,
          h('span', { className: 'mkts-count' }, filtered.length + ' / ' + (data.plugins || []).length),
        ),
        h('div', { className: 'mkts-chips' },
          (data.cats || []).map((c) => h('button', {
            key: c.id,
            className: 'mkts-chip' + (cat === c.id && !showInstalled ? ' mkts-chip-on' : ''),
            onClick: () => { setCat(c.id); setShowInstalled(false) },
          }, (c.id === 'all' ? t('all') : c.label), ' ', h('small', null, c.count))),
          h('button', {
            className: 'mkts-chip' + (showInstalled ? ' mkts-chip-on' : ''),
            onClick: () => { setShowInstalled(!showInstalled); setCat('all') },
          }, t('instFilter'), ' ', h('small', null, installedCount)),
          h('div', { className: 'mkts-sort' },
            [['default', t('sortDefault')], ['hot', t('sortHot')], ['new', t('sortNew')]].map(([key, label]) =>
              h('button', { key, className: sortBy === key ? 'on' : '', onClick: () => setSortBy(key) }, label))),
        ),
      ),
      data.phase === 'loading' ? h('div', null, t('loading')) : null,
      data.phase === 'error' ? h('div', { className: 'mkts-err' }, data.error) : null,
      data.phase === 'ready' ? h('div', { className: 'mkts-marketbanner' }, t('marketBanner')) : null,
      data.phase === 'ready' ? groups.map((g) => h('div', { key: g.id },
        g.label ? h('div', { className: 'mkts-sec' }, g.label, h('small', null, g.items.length)) : null,
        g.items.map((p, i) => {
          const inst = isInstalled(p, data.installed)
          const bltin = isBuiltin(p, data.installed)
          const isOpen = open === p.url
          return h('div', { key: p.url, className: 'mkts-item' },
            h('span', { className: 'mkts-avatar', 'aria-hidden': 'true' }, String(p.name || '?').trim().charAt(0).toUpperCase() || '?'),
            h('div', { className: 'mkts-main' },
              h('h3', null,
                h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, p.name),
                typeof p.stars === 'number' ? h('span', { className: 'mkts-stars' }, '★ ' + p.stars) : null,
                p.by ? h('span', { className: 'mkts-by' }, '@' + p.by) : null,
                h('a', { className: 'mkts-gh', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, t('gh')),
              ),
              p.desc ? h('p', { className: 'mkts-desc' }, p.desc) : null,
              isOpen ? h('div', { className: 'mkts-detail' },
                h('div', null, t('cmdLabel')),
                h('code', null, p.cmd || t('noCmd')),
                h('div', { className: 'mkts-hint' }, t('hint')),
              ) : null,
            ),
            h('div', { className: 'mkts-actions' },
              bltin
                ? h('span', { className: 'mkts-state mkts-state-builtin', title: t('builtinHint') }, t('builtin'))
                : h('span', { className: 'mkts-state ' + (inst ? 'mkts-state-on' : 'mkts-state-off') }, inst ? t('instFilter') : (LOCALE === 'zh' ? '未安装' : 'Not installed')),
              h('button', { className: 'mkts-cmdbtn', onClick: () => setOpen(isOpen ? null : p.url) }, isOpen ? t('collapse') : t('detail')),
              bltin ? null
                : inst
                  ? h(React.Fragment, null,
                      (() => {
                        const pkgName = installedPkgName(p, data.installed && data.installed[p.profile || 'web'])
                        const up = pkgName && data.updates && data.updates[p.profile || 'web'] && data.updates[p.profile || 'web'][pkgName]
                        const opActive = !!(op && op.phase !== 'done')
                        if (!up) {
                          // No update status yet (still loading or check failed) —
                          // render a neutral disabled chip so the card always
                          // communicates its update state.
                          return h('button', { className: 'mkts-cmdbtn', disabled: true, title: t('updateFail') }, t('upToDate'))
                        }
                        if (up.kind === 'linked') {
                          return h('span', { className: 'mkts-state mkts-state-off' }, t('updLocal'))
                        }
                        if (up.updateAvailable) {
                          return h('button', {
                            className: 'mkts-cmdbtn',
                            disabled: opActive,
                            onClick: () => runOp('update', pkgName, p.name, p.profile),
                          }, t('updateBtn') + (up.latest ? ' (' + String(up.latest).slice(0, 8) + ')' : ''))
                        }
                        return h('span', { className: 'mkts-state mkts-state-on' }, t('upToDate'))
                      })(),
                      h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', onClick: () => runOp('uninstall', installedPkgName(p, data.installed && data.installed[p.profile || 'web']) || p.name, p.name, p.profile) }, t('uninstall')))
                  : (p.source ? h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', onClick: () => runOp('install', p.source, p.name, p.profile) }, t('install')) : null),
            ),
          )
        }),
      )) : null,
      data.phase === 'ready' && filtered.length === 0 ? h('div', { className: 'mkts-hint' }, t('noMatch')) : null,
    )
  }

  const inject = ['slots']

  function apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => {
      const id = 'dsh-market-style'
      if (!document.getElementById(id)) {
        const s = document.createElement('style')
        s.id = id
        s.textContent = MARKET_CSS
        document.head.appendChild(s)
      }
      return () => { const el = document.getElementById(id); if (el) el.remove() }
    }, 'market-style')
    slots.inject('settings.plugins.tab', () => slots.register(
      { name: 'settings.plugins.tab', id: 'market', order: 5, label: () => (LOCALE === 'zh' ? '插件市场' : 'Plugin Market') },
      MarketPanel,
    ))
  }

  module.exports = { inject, apply }
  return module.exports;
} })

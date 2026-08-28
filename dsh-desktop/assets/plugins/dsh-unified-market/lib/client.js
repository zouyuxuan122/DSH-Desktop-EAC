// Browser half of the unified plugin market（DSH Desktop 内置，EAC 特化）。
// 三源：精选目录（awesome-dsh-plugin.com）/ GitHub dsh-plugin 生态 / npm registry。
// Loaded through the web plugin loader (window.__ModuleLoader__); React comes
// from the platform module table. Talks to the Host half over the
// /api/dsh-unified-market HTTP route.
//
// Install/uninstall run as background ops on the Host: the panel submits, gets
// an op id, and polls. The op lives in a fixed modal overlay (never lost by
// scrolling), can be minimized to a status chip, and survives page refreshes.
window.__ModuleLoader__.load({ id: 'dsh-unified-market', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  const React = require('react')
  const { useState, useEffect, useRef } = React
  const h = React.createElement

  function api(method, params) {
    return fetch('/api/dsh-unified-market', {
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
      hint: '安装后需重启 Web 服务生效；GitHub 源会执行包内 prepare 脚本（pnpm allowBuilds 自动放行）。安装进当前生效 profile（EAC 桌面壳为 web-desktop）前有多重把关：内置包拦截、冲突预检、以及试装验证——在临时环境实际启动一次，确认 web 能正常启动才写入真实 profile；验证失败会给出真实启动错误且不改动现有安装；简单插件装好后会自动热挂载（无需重启）。确实需要强制安装时可勾选"跳过安全检查"（风险自负）。',
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
      marketBanner: '统一插件市场（DSH Desktop 内置）：精选目录（awesome-dsh-plugin.com）+ GitHub dsh-plugin 生态 + npm 检索三源合一。安装走双保险（来源白名单 + 试装验证，可在「详情」查看说明）；「统一管理」提供 检查更新 / 自动更新开关（仅提示或自动升级）；市场自身随官方「内置插件更新」自更新。',
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
      marketBanner: 'Unified plugin market (bundled with DSH Desktop): curated catalog (awesome-dsh-plugin.com) + GitHub dsh-plugin ecosystem + npm registry in one place. Installs are double-gated (source whitelist + trial boot, see Details). The tool bar provides check updates / auto-update (notify or auto) / health scan / one-click repair. The market itself updates through the official built-in plugin updater.',
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
.mkts-chips{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center}
.mkts-catsel{appearance:auto;font:inherit;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 8px;max-width:220px}
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
.mkts-srcbar{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.mkts-toolbar{display:flex;gap:6px;align-items:center;margin:8px 0 12px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3)}
.mkts-tool-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-right:4px}
.mkts-autoswitch{display:inline-flex;gap:4px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.mkts-self{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:auto;cursor:help}
.mkts-health{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-3)}
.mkts-health-item{font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 0;line-height:1.5}
.mkts-hl-err{color:var(--dsw-alias-label-error)}
.mkts-hl-warn{color:var(--dsw-alias-label-warning)}
.mkts-hl-ok{color:var(--dsw-alias-state-success-primary)}
.mkts-more{margin-top:8px;text-align:center}
.mkts-updates{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px;margin:0 0 12px;background:var(--dsw-alias-bg-layer-3)}
.mkts-updates-msg{font-size:12px;color:var(--dsw-alias-state-success-primary);padding:4px 0 8px}
.mkts-update-row{margin-bottom:6px}
.mkts-progress{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;margin:0 0 12px;background:color-mix(in srgb,var(--dsw-static-deepseek-500) 8%,transparent)}
.mkts-progress.ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent)}
.mkts-progress-head{font-size:13px;font-weight:600;margin-bottom:6px}
.mkts-progress-close{appearance:none;background:none;border:none;color:var(--dsw-alias-label-tertiary);font-size:13px;cursor:pointer;float:right;padding:0 2px;line-height:1}
.mkts-progress-close:hover{color:var(--dsw-alias-label-primary)}
.mkts-progress-cur{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.mkts-progress-count{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.mkts-progress-out{background:#161616;color:#cfcfcf;border-radius:8px;padding:6px 8px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;margin:0}
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
    // ── 统一市场扩展状态（三源 + 自动更新 + 自更新）──
    const [srcMode, setSrcMode] = useState('catalog') // catalog | github | npm
    const [ghPage, setGhPage] = useState(1)
    const [ghData, setGhData] = useState(null)
    const [npmData, setNpmData] = useState(null)
    const [autoState, setAutoState] = useState(null)
    const [selfInfo, setSelfInfo] = useState(null)
    const [busyTool, setBusyTool] = useState('')
    const [updateMsg, setUpdateMsg] = useState('')
    const [updProgress, setUpdProgress] = useState(null)
    const updTimerRef = useRef(null)
    useEffect(() => () => { if (updTimerRef.current) clearInterval(updTimerRef.current) }, [])
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

    // ── 统一市场扩展：自助状态 + 三源数据加载 ──
    useEffect(() => {
      api('sources', {}).then((r) => { if (r && r.ok) setSelfInfo(r.self || null) }).catch(() => {})
      api('autoState', {}).then((r) => { if (r && r.ok) setAutoState(r) }).catch(() => {})
    }, [])
    useEffect(() => {
      if (srcMode !== 'github') return
      let alive = true
      api('github', { q: query, page: ghPage }).then((r) => {
        if (!alive) return
        setGhData((prev) => r && r.ok
          ? { ...r, items: (prev && prev.items && r.page > 1 ? prev.items.concat(r.items || []) : (r.items || [])) }
          : (r || { ok: false, items: [], total: 0, page: 1, hasMore: false, message: r && r.message ? r.message : 'GitHub 检索失败' }))
      }).catch(() => { if (alive) setGhData({ ok: false, items: [], total: 0, page: 1, hasMore: false, message: 'GitHub 检索失败' }) })
      return () => { alive = false }
    }, [srcMode, query, ghPage])
    useEffect(() => {
      if (srcMode !== 'npm') return
      let alive = true
      api('npm', { q: query }).then((r) => { if (alive) setNpmData(r && r.ok ? r : { ok: false, items: [], total: 0, message: 'npm 检索失败' }) })
        .catch(() => { if (alive) setNpmData({ ok: false, items: [], total: 0, message: 'npm 检索失败' }) })
      return () => { alive = false }
    }, [srcMode, query])

    const setAutoUpdateMode = (m) => {
      setBusyTool('auto')
      api('setAutoUpdate', { autoUpdate: m }).then((r) => {
        setAutoState(r && r.ok ? { autoUpdate: r.autoUpdate, lastAutoCheckAt: (autoState && autoState.lastAutoCheckAt) || null, lastAutoCheckCount: (autoState && autoState.lastAutoCheckCount) || 0 } : autoState)
        setBusyTool('')
      }).catch(() => setBusyTool(''))
    }
    const runCheckNow = () => {
      setBusyTool('check')
      api('checkNow', {}).then((r) => {
        setBusyTool('')
        if (r && r.ok) setData((d) => ({ ...d, updates: Object.assign({}, d.updates, { 'web': r.updates, [r.profile]: r.updates }) }))
      }).catch(() => setBusyTool(''))
    }
    // 一键全部更新：启动后台批量更新并轮询进度窗口，完成后自动重查并显示结果。
    const updateAllStart = () => {
      setBusyTool('')
      setUpdateMsg('')
      setUpdProgress({ phase: 'running', total: 0, done: 0, failed: 0, idx: 0, current: null, output: '', finished: false })
      if (updTimerRef.current) clearInterval(updTimerRef.current)
      updTimerRef.current = setInterval(() => {
        api('updateProgress', {}).then((r) => {
          if (!r || !r.ok || !r.progress) return
          const p = r.progress
          setUpdProgress(p)
          if (p.finished) {
            clearInterval(updTimerRef.current)
            updTimerRef.current = null
            api('checkNow', {}).then((r2) => {
              if (r2 && r2.ok) setData((d) => ({ ...d, updates: Object.assign({}, d.updates, { 'web': r2.updates, [r2.profile]: r2.updates }) }))
            }).catch(() => {})
            const hasFail = (p.failed && p.failed.length) > 0
            const hasPending = (p.pending && p.pending.length) > 0
            setUpdateMsg((p.ok && !hasFail ? '✅ ' : '⚠️ ') + (LOCALE === 'zh'
              ? '全部更新完成：成功 ' + (p.done || []).length + ' 个' + ((p.skipped && p.skipped.length) ? '，跳过 ' + p.skipped.length + '（本地链接）' : '') + (hasPending ? '，排队 ' + p.pending.length + '（重启服务后自动完成）' : '') + (hasFail ? '，失败 ' + p.failed.length + '：' + p.failed.join('、') : '')
              : 'Update all done: ' + (p.done || []).length + ' ok' + ((p.skipped && p.skipped.length) ? ', skipped ' + p.skipped.length + ' (local link)' : '') + (hasPending ? ', queued ' + p.pending.length + ' (finish on service restart)' : '') + (hasFail ? ', failed ' + p.failed.length + ': ' + p.failed.join(', ') : '')))
            // 失败/排队时保留进度窗展示错误原因，不自动关闭；全成功才自动收起。
            if (!hasFail && !hasPending) {
              setTimeout(() => setUpdProgress(null), 4000)
            }
          }
        }).catch(() => {})
      }, 900)
    }
    const runUpdateAll = () => {
      setBusyTool('updateAll')
      setUpdateMsg('')
      api('updateAll', {}).then((r) => {
        if (!r || !r.ok) {
          setBusyTool('')
          setUpdateMsg(String((r && (r.error || r.output)) || (LOCALE === 'zh' ? '更新失败' : 'update failed')).slice(0, 160))
          return
        }
        if (r.started) {
          updateAllStart()
        } else {
          setBusyTool('')
          setUpdateMsg(r.message || (r.busy ? (LOCALE === 'zh' ? '已有更新任务进行中' : 'update already running') : ''))
        }
      }).catch(() => setBusyTool(''))
    }

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

    // ── 统一市场扩展渲染函数（GitHub/npm 源列表、管理工具条、健康结果）──
    const renderGhList = () => {
      const d = ghData
      if (!d) return h('div', { className: 'mkts-hint' }, LOCALE === 'zh' ? '正在加载 GitHub 生态…' : 'Loading GitHub ecosystem…')
      if (!d.ok) return h('div', { className: 'mkts-err' }, d.message || 'error')
      if (d.items.length === 0) return h('div', { className: 'mkts-hint' }, t('noMatch'))
      return [
        d.items.map((it) => {
          const ghUrl = it.htmlUrl || ('https://github.com/' + it.fullName)
          return h('div', { key: it.fullName, className: 'mkts-item' },
            h('span', { className: 'mkts-avatar', 'aria-hidden': 'true' }, String(it.name || '?').trim().charAt(0).toUpperCase() || '?'),
            h('div', { className: 'mkts-main' },
              h('h3', null,
                h('a', { href: ghUrl, target: '_blank', rel: 'noopener noreferrer' }, it.fullName),
                h('span', { className: 'mkts-stars' }, '★ ' + (it.stars || 0)),
                h('span', { className: 'mkts-by' }, (it.language ? (it.language + ' · ') : '') + (it.updatedAt ? String(it.updatedAt).slice(0, 10) : '')),
                h('a', { className: 'mkts-gh', href: ghUrl, target: '_blank', rel: 'noopener noreferrer' }, t('gh')),
              ),
              it.description ? h('p', { className: 'mkts-desc' }, it.description) : null,
            ),
            h('div', { className: 'mkts-actions' },
              it.builtin
                ? h('span', { className: 'mkts-state mkts-state-builtin', title: t('builtinHint') }, t('builtin'))
                : (it.installed
                    ? h(React.Fragment, null,
                        h('span', { className: 'mkts-state mkts-state-on' }, t('instFilter')),
                        h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', onClick: () => runOp('uninstall', it.installedName || it.name, it.name, 'web') }, t('uninstall')))
                    : h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', onClick: () => runOp('install', 'github:' + it.fullName, it.name, 'web') }, t('install'))),
            ),
          )
        }),
        d.hasMore ? h('div', { className: 'mkts-more' },
          h('button', { className: 'mkts-cmdbtn', onClick: () => setGhPage((p) => p + 1) }, LOCALE === 'zh' ? '加载更多' : 'Load more')) : null,
      ]
    }

    const renderNpmList = () => {
      const d = npmData
      if (!d) return h('div', { className: 'mkts-hint' }, LOCALE === 'zh' ? '正在加载 npm 生态…' : 'Loading npm ecosystem…')
      if (!d.ok) return h('div', { className: 'mkts-err' }, d.message || 'error')
      if (d.items.length === 0) return h('div', { className: 'mkts-hint' }, t('noMatch'))
      return d.items.map((it) => h('div', { key: it.fullName, className: 'mkts-item' },
        h('div', { className: 'mkts-main' },
          h('h3', null,
            h('a', { href: it.htmlUrl || ('https://www.npmjs.com/package/' + it.fullName), target: '_blank', rel: 'noopener noreferrer' }, it.fullName),
            h('span', { className: 'mkts-stars' }, 'v' + (it.version || '?')),
          ),
          it.description ? h('p', { className: 'mkts-desc' }, it.description) : null,
        ),
        h('div', { className: 'mkts-actions' },
          it.builtin
            ? h('span', { className: 'mkts-state mkts-state-builtin', title: t('builtinHint') }, t('builtin'))
            : (it.installed
                ? h(React.Fragment, null,
                    h('span', { className: 'mkts-state mkts-state-on' }, t('instFilter')),
                    h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', onClick: () => runOp('uninstall', it.fullName, it.fullName, 'web') }, t('uninstall')))
                : h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', onClick: () => runOp('install', it.fullName, it.fullName, 'web') }, t('install'))),
        ),
      ))
    }

    const renderToolbar = () => {
      const mode = autoState && autoState.autoUpdate
      const btn = (key, label, handler) => h('button', { key, className: 'mkts-cmdbtn', disabled: busyTool !== '', onClick: handler }, (busyTool === key ? (LOCALE === 'zh' ? '处理中…' : '…') : label))
      const updMap = data.updates && data.updates['web'] ? data.updates['web'] : null
      const updCount = updMap ? Object.values(updMap).filter((u) => u && u.updateAvailable).length : 0
      const allBtn = updCount > 0
        ? h('button', { key: 'updateAll', className: 'mkts-cmdbtn mkts-cmdbtn-primary', disabled: busyTool !== '', onClick: runUpdateAll },
          busyTool === 'updateAll' ? (LOCALE === 'zh' ? '更新中…' : 'Updating…') : (LOCALE === 'zh' ? '⬆ 全部更新 (' + updCount + ')' : '⬆ Update all (' + updCount + ')'))
        : null
      return h('div', { className: 'mkts-toolbar' },
        h('span', { className: 'mkts-tool-label' }, LOCALE === 'zh' ? '⚙ 统一管理' : 'Manage'),
        btn('check', LOCALE === 'zh' ? '检查更新' : 'Check updates', runCheckNow),
        allBtn,
        h('span', { className: 'mkts-autoswitch' },
          (LOCALE === 'zh' ? '自动更新' : 'Auto-update') + ': ',
          [['off', LOCALE === 'zh' ? '关闭' : 'Off'], ['notify', LOCALE === 'zh' ? '仅提示' : 'Notify'], ['auto', LOCALE === 'zh' ? '自动升级' : 'Auto']].map(([m, label]) =>
            h('button', { key: m, className: 'mkts-chip' + (mode === m ? ' mkts-chip-on' : ''), onClick: () => setAutoUpdateMode(m) }, label)),
        ),
        selfInfo ? h('span', { className: 'mkts-self', title: selfInfo.message || '' }, (selfInfo.hasUpdate ? '↑ ' : '') + '市场 v' + (selfInfo.version || '?')) : null,
      )
    }

    // 已下载插件更新面板：列出本 profile 所有已装插件及更新状态，
    // 支持选择性逐个更新；「检查更新」后刷新。
    const renderUpdatesPanel = () => {
      const updMap = data.updates && data.updates['web'] ? data.updates['web'] : null
      if (!updMap) return null
      const entries = Object.entries(updMap).filter(([, u]) => u && u.updateAvailable)
      if (entries.length === 0) return null
      return h('div', { className: 'mkts-updates' },
        h('div', { className: 'mkts-sec' },
          (LOCALE === 'zh' ? '可更新插件' : 'Updatable plugins'),
          h('small', null, entries.length + (LOCALE === 'zh' ? ' 个' : '')),
        ),
        updateMsg ? h('div', { className: 'mkts-updates-msg' }, updateMsg) : null,
        entries.map(([name, u]) => {
          const uo = u || {}
          const verText = uo.kind === 'linked'
            ? (uo.version || '?') + ' → v' + String(uo.latest || '').slice(0, 14) + ' (本地链接)'
            : (uo.version || uo.current || '?') + ' → v' + String(uo.latest || '').slice(0, 14)
          return h('div', { key: name, className: 'mkts-item mkts-update-row' },
            h('div', { className: 'mkts-main' },
              h('h3', null, name, h('span', { className: 'mkts-stars' }, uo.kind === 'github' ? '🐙' : (uo.kind === 'linked' ? '🔗' : '📦'))),
              h('p', { className: 'mkts-desc' }, verText),
            ),
            h('div', { className: 'mkts-actions' },
              h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', title: (uo.kind === 'linked' ? (LOCALE === 'zh' ? '本地链接：更新后将切换为上游安装（本地目录与源码保留）' : 'Local link: updating will switch to upstream install (local dir kept)') : undefined),
                onClick: () => { setUpdateMsg(''); runOp('update', name, name, 'web') } },
                t('updateBtn') + (uo.latest ? ' (v' + String(uo.latest).slice(0, 8) + ')' : '')),
            ),
          )
        }),
      )
    }

    // 全部更新进度窗口：后台批量更新的实时进度（当前项 x/y、成功/失败/排队、最近输出）。
    // 失败或排队时窗口保留（不自动关闭），便于查看错误原因，可手动关闭。
    const renderProgressWindow = () => {
      if (!updProgress) return null
      const p = updProgress
      const running = !p.finished
      const hasFail = !running && (p.failed && p.failed.length) > 0
      const hasPending = !running && (p.pending && p.pending.length) > 0
      const title = running
        ? (LOCALE === 'zh' ? '⬆ 正在全部更新…' : 'Updating all…')
        : (hasFail ? (LOCALE === 'zh' ? '⚠️ 更新完成（有失败）' : 'Done with failures') : (LOCALE === 'zh' ? '全部更新完成' : 'Update all done'))
      return h('div', { className: 'mkts-progress' + (p.ok === true ? ' ok' : '') },
        h('div', { className: 'mkts-progress-head' },
          title,
          h('button', { className: 'mkts-progress-close', onClick: () => setUpdProgress(null), title: (LOCALE === 'zh' ? '关闭' : 'Close') }, '✕'),
        ),
        (running && p.current) ? h('div', { className: 'mkts-progress-cur' },
          (p.total ? (LOCALE === 'zh' ? '第 ' + (p.idx || 0) + '/' + p.total + ' 个：' : (p.idx || 0) + '/' + p.total + ': ') : '') + p.current) : null,
        h('div', { className: 'mkts-progress-count' },
          '✅ ' + (p.done || []).length + (LOCALE === 'zh' ? ' · ⏳ ' : ' · ⏳ ') + (p.pending || []).length + (LOCALE === 'zh' ? ' · ❌ ' : ' · ✗ ') + (p.failed || []).length),
        (p.output) ? h('pre', { className: 'mkts-progress-out' }, String(p.output).slice(-900)) : null,
      )
    }

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
      h('div', { className: 'mkts-srcbar' },
        [['catalog', LOCALE === 'zh' ? '🎯 精选目录' : 'Curated'], ['github', '🐙 GitHub'], ['npm', '📦 npm']].map(([m, label]) =>
          h('button', { key: m, className: 'mkts-chip' + (srcMode === m ? ' mkts-chip-on' : ''), onClick: () => { setSrcMode(m); setGhPage(1); setOpen(null) } }, label)),
      ),
      h('div', { className: 'mkts-finder' },
        h('div', { className: 'mkts-row1' },
          h('input', { className: 'mkts-search', placeholder: t('search'), value: query, onChange: (e) => setQuery(e.target.value) }),
          liveChip,
          h('span', { className: 'mkts-count' }, filtered.length + ' / ' + (data.plugins || []).length),
        ),
        h('div', { className: 'mkts-chips' },
          h('select', { className: 'mkts-catsel', value: showInstalled ? '__inst__' : (cat || 'all'), onChange: (e) => { const v = e.target.value; if (v === '__inst__') { setShowInstalled(true); setCat('all') } else { setShowInstalled(false); setCat(v) } } },
            h('option', { value: 'all', key: 'all' }, t('all')),
            h('option', { value: '__inst__', key: '__inst__' }, (LOCALE === 'zh' ? '已安装 (' : 'Installed (') + installedCount + ')'),
            (data.cats || []).filter((c) => c.id !== 'all').map((c) => h('option', { key: c.id, value: c.id }, c.label + ' (' + c.count + ')')),
          ),
          h('div', { className: 'mkts-sort' },
            [['default', t('sortDefault')], ['hot', t('sortHot')], ['new', t('sortNew')]].map(([key, label]) =>
              h('button', { key, className: sortBy === key ? 'on' : '', onClick: () => setSortBy(key) }, label))),
        ),
      ),
      data.phase === 'loading' ? h('div', null, t('loading')) : null,
      data.phase === 'error' ? h('div', { className: 'mkts-err' }, data.error) : null,
      renderToolbar(),
      renderProgressWindow(),
      renderUpdatesPanel(),
      data.phase === 'ready' && srcMode === 'catalog' ? groups.map((g) => h('div', { key: g.id },
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
      srcMode === 'github' ? renderGhList() : null,
      srcMode === 'npm' ? renderNpmList() : null,
      data.phase === 'ready' && srcMode === 'catalog' && filtered.length === 0 ? h('div', { className: 'mkts-hint' }, t('noMatch')) : null,
    )
  }

  // ─────────────────────────────────────────────────────────────────────
  // 功能包（Feature Pack）面板：交互编排层，核心逻辑在 L2 功能包 CLI。
  // host pack.* method ↔ CLI；本组件只做 UI 与 op 轮询。
  // ─────────────────────────────────────────────────────────────────────
  function FeaturePackPanel() {
    const [data, setData] = useState({ phase: 'loading', packs: [], kernel: null, error: null })
    const [market, setMarket] = useState({ packs: [], source: 'none', phase: 'idle' })
    const [op, setOp] = useState(null)
    const [msg, setMsg] = useState('')
    const fileRef = useRef(null)
    const updateTargetRef = useRef(null)

    const pollStop = useRef(false)
    useEffect(() => () => { pollStop.current = true }, [])

    const loadPacks = () => {
      api('pack.list').then((r) => {
        setData({ phase: 'ready', packs: (r && r.packs) || [], kernel: (r && r.kernel) || null, error: (r && r.error) || null })
      }).catch((err) => setData({ phase: 'ready', packs: [], kernel: null, error: String((err && err.message) || err) }))
    }
    const loadMarket = () => {
      api('pack.market').then((r) => {
        setMarket({ packs: (r && r.packs) || [], source: (r && r.source) || 'none', phase: 'ready' })
      }).catch(() => setMarket({ packs: [], source: 'none', phase: 'ready' }))
    }
    useEffect(() => { loadPacks(); loadMarket() }, [])

    const pollOp = (opId) => {
      const tick = () => {
        if (pollStop.current) return
        api('op', { opId }).then((r) => {
          const o = r && r.op
          if (!o) { setOp(null); return }
          if (o.status === 'done') { setOp(o); loadPacks(); return }
          setOp(o)
          if (o.status === 'running') setTimeout(tick, 1200)
        }).catch(() => setTimeout(tick, 1600))
      }
      tick()
    }

    const runOp = (method, params, label) => {
      if (op && op.status === 'running') { setMsg('已有任务进行中，请先等待完成'); return }
      setMsg('')
      api(method, params).then((r) => {
        if (!r || !r.ok) {
          setOp({ id: 'err', status: 'failed', output: (r && (r.error || r.output)) || '操作失败', label: label || '' })
          if (r && r.busy) setMsg('已有任务进行中')
          return
        }
        setOp({ id: r.opId, status: 'running', output: '', label: label || '' })
        pollOp(r.opId)
      }).catch((err) => setOp({ id: 'err', status: 'failed', output: String((err && err.message) || err), label: label || '' }))
    }
    const killOp = () => { api('kill', {}).catch(() => {}) }
    const closeOp = () => { setOp(null); loadPacks() }

    const pickFile = (mode, packId) => {
      updateTargetRef.current = mode === 'update' ? packId : null
      if (fileRef.current) fileRef.current.value = ''
      if (fileRef.current) fileRef.current.click()
    }
    const onFile = (e) => {
      const f = e.target.files && e.target.files[0]
      if (!f) return
      const reader = new FileReader()
      reader.onload = () => {
        const raw = String(reader.result || '')
        const b64 = raw.slice(raw.indexOf(',') + 1)
        if (updateTargetRef.current) {
          runOp('pack.update', { id: updateTargetRef.current, data: b64, label: f.name }, '更新功能包')
        } else {
          runOp('pack.install', { data: b64, label: f.name }, '安装功能包')
        }
      }
      reader.readAsDataURL(f)
    }

    const exportPack = (id) => {
      api('pack.export', { id }).then((r) => {
        setMsg(r && r.ok ? ('已导出到：' + (r.path || '')) : ((r && r.error) || '导出失败'))
      }).catch((err) => setMsg('导出失败：' + String((err && err.message) || err)))
    }

    const compatBanner = (data.packs || []).filter((p) => p.compatOk === false)
    const running = !!(op && op.status === 'running')

    return h('div', { className: 'mkts' },
      h('div', { className: 'mkts-sec' }, '📦 功能包',
        h('small', null, '把插件 + 预设 + 技能打包分发；声明官方内核兼容范围，官方版本升级后自动检出（思路借鉴 HMCL 整合包）。')),
      compatBanner.length > 0 ? h('div', { className: 'mkts-health' },
        h('div', { className: 'mkts-health-item mkts-hl-err' }, '官方内核 ' + (data.kernel || '未知') + ' 与以下功能包不兼容（迁移：安装兼容新版；回滚：恢复安装前状态）：'),
        compatBanner.map((p) => h('div', { className: 'mkts-update-row', key: p.id },
          h('span', null, p.name + '（v' + p.version + '）'), ' ',
          h('button', { className: 'mkts-cmdbtn', disabled: running, onClick: () => pickFile('update', p.id) }, '迁移（选新版 .dshpack）'), ' ',
          h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', disabled: running || !p.snapshotRef,
            onClick: () => { if (window.confirm('回滚到安装「' + p.name + '」之前的状态？')) runOp('pack.rollback', { id: p.id }, '回滚 ' + p.id) } }, '回滚'),
        )),
      ) : null,
      data.error ? h('div', { className: 'mkts-err' }, '功能包 CLI 不可用：' + data.error + '（请确认本客户端在桌面壳内运行）') : null,
      h('div', { className: 'mkts-sec' }, '已安装功能包', h('small', null, String((data.packs || []).length) + ' 个')),
      data.phase === 'ready' && (data.packs || []).length === 0
        ? h('div', { className: 'mkts-hint' }, '还没有安装功能包：在下方「导入 .dshpack」本地安装，或到「功能包市场」浏览安装。')
        : (data.packs || []).map((p) => h('div', { className: 'mkts-item', key: p.id },
            h('div', { className: 'mkts-avatar' }, (p.name || '?').slice(0, 1)),
            h('div', { className: 'mkts-main' },
              h('h3', null, p.name, h('span', { className: 'mkts-by' }, 'v' + p.version),
                p.compatOk === false
                  ? h('span', { className: 'mkts-state mkts-state-off' }, '⚠ 不兼容')
                  : h('span', { className: 'mkts-state mkts-state-on' }, p.state === 'active' ? '正常' : '已回滚')),
              h('p', { className: 'mkts-desc' }, '插件 ' + String((p.plugins || []).length) + ' · 预设 ' + String((p.presets || []).length) + ' · 技能 ' + String((p.skills || []).length)
                + (p.requires && p.requires.dsh ? ' · 内核要求 ' + p.requires.dsh : '')),
            ),
            h('div', { className: 'mkts-actions' },
              h('button', { className: 'mkts-cmdbtn', disabled: running, onClick: () => pickFile('update', p.id) }, '更新'),
              h('button', { className: 'mkts-cmdbtn', disabled: running, onClick: () => exportPack(p.id) }, '导出'),
              h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', disabled: running,
                onClick: () => { if (window.confirm('卸载功能包「' + p.name + '」？（仅移除该包装配的插件/预设/技能，其余数据不动）')) runOp('pack.uninstall', { id: p.id }, '卸载 ' + p.id) } }, '卸载'),
            ),
          )),
      h('div', { className: 'mkts-sec' }, '导入 / 安装'),
      h('div', { className: 'mkts-cmdrow' },
        h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', disabled: running, onClick: () => pickFile('install', null) }, '导入 .dshpack 安装'),
        h('input', { ref: fileRef, type: 'file', accept: '.dshpack,application/zip', style: { display: 'none' }, onChange: onFile }),
      ),
      h('div', { className: 'mkts-sec' }, '功能包市场', h('small', null, market.phase === 'ready' ? '来源：' + market.source : '加载中…')),
      market.phase === 'ready' && (market.packs || []).length === 0
        ? h('div', { className: 'mkts-hint' }, '市场索引为空：尚未配置远端仓库（可先用本地导入，或等待正式市场仓库上线）。')
        : (market.packs || []).map((p) => h('div', { className: 'mkts-item', key: p.id },
            h('div', { className: 'mkts-avatar' }, (p.name || '?').slice(0, 1)),
            h('div', { className: 'mkts-main' },
              h('h3', null, p.name, h('span', { className: 'mkts-by' }, 'v' + p.version + (p.author ? ' · ' + p.author : ''))),
              h('p', { className: 'mkts-desc' }, p.desc || ''),
              p.requires && p.requires.dsh ? h('div', { className: 'mkts-hint' }, '内核要求：' + p.requires.dsh) : null,
            ),
            h('div', { className: 'mkts-actions' },
              h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', disabled: running,
                onClick: () => runOp('pack.install', { target: p.url, sha256: p.sha256 || undefined, label: p.name }, '安装 ' + p.name) }, '安装'),
            ),
          )),
      msg ? h('div', { className: 'mkts-hint' }, msg) : null,
      op ? h('div', { className: 'mkts-modal-bg' },
        h('div', { className: 'mkts-modal' },
          h('h4', null, (op.label || '功能包任务') + (op.status === 'running' ? ' …' : ' [' + op.status + ']')),
          op.output ? h('pre', { className: 'mkts-log' }, op.output) : h('div', { className: 'mkts-hint' }, '任务进行中…（插件安装可能较长，可收起等待）'),
          h('div', { className: 'mkts-cmdrow' },
            op.status === 'running'
              ? h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', onClick: killOp }, '终止任务')
              : h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', onClick: closeOp }, op.status === 'failed' ? '关闭' : '完成并刷新'),
          ),
          op.status === 'done' ? h('div', { className: 'mkts-hint' }, '完成。若安装了新插件，可能需要在 ⋯ 菜单「重启 Web 服务」后生效。') : null,
          op.status === 'failed' ? h('div', { className: 'mkts-hint' }, '操作失败：请查看上方输出；文件锁类失败会自动排队，重启服务后完成。') : null,
        ),
      ) : null,
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
      { name: 'settings.plugins.tab', id: 'market', order: 5, label: () => (LOCALE === 'zh' ? '🛒 统一市场' : '🛒 Unified Market') },
      MarketPanel,
    ))
    slots.inject('settings.plugins.tab', () => slots.register(
      { name: 'settings.plugins.tab', id: 'feature-pack', order: 6, label: () => (LOCALE === 'zh' ? '📦 功能包' : '📦 Feature Packs') },
      FeaturePackPanel,
    ))
  }

  module.exports = { inject, apply }
  return module.exports;
} })

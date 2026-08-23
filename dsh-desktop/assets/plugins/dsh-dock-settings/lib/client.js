// Browser half of dsh-dock-settings — a "Skills & MCP" section in the Web UI
// settings page.
//
//   Skills tab: lists every discovered user skill (~/.dsh/skills,
//   ~/.agents/skills) with source badges (EAC-managed vs user-owned) and an
//   "open directory" action (through the desktop shell bridge when present).
//   MCP tab: table of @deepseek-ai/dsh-mcp-client rows in the profile patch
//   layer — add (stdio / streamable-http form), edit, toggle, delete; saving
//   rewrites only the MCP rows and offers a one-click service restart.
window.__ModuleLoader__.load({ id: 'dsh-dock-settings', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  const React = require('react')
  const h = React.createElement

  let LOCALE = 'zh'
  try {
    const nl = String(navigator.language || navigator.userLanguage || '')
    if (!nl.toLowerCase().startsWith('zh')) LOCALE = 'en'
  } catch (e) {}

  const STR = {
    zh: {
      nav: 'Skills 与 MCP',
      tabSkills: 'Skills', tabMcp: 'MCP 服务',
      skillsIntro: '技能按目录扫描：~/.dsh/skills 与 ~/.agents/skills 下的 <名称>/SKILL.md 或平铺 <名称>.md。项目级技能在 <项目>/.dsh/skills。修改即时生效（文件监听）。',
      noSkills: '（该目录暂无技能）',
      rootMissing: '（目录不存在）',
      managed: 'EAC 内置', user: '用户',
      openDir: '打开目录',
      refresh: '刷新',
      loading: '加载中…',
      mcpIntro: 'MCP 服务通过 profile 的 cordis.patch.yml 中 @deepseek-ai/dsh-mcp-client 行配置。保存后需重启 Web 服务生效。',
      name: '名称', transport: '类型', detail: '详情', state: '状态',
      enabled: '启用', disabled: '已停用',
      edit: '编辑', del: '删除', add: '新增服务',
      save: '保存', saved: '已保存', saving: '保存中…', saveFail: '保存失败',
      restartHint: '已保存。重启 Web 服务后生效。',
      restartNow: '立即重启生效', restarting: '重启中…',
      stdio: 'stdio（本地命令）', http: 'streamable-http（远程 URL）',
      serverName: '服务名（英文/数字/下划线/中划线）',
      command: '启动命令', args: '参数（JSON 数组或空格分隔）', env: '环境变量（每行 KEY=VALUE）',
      url: 'URL', headers: '请求头（每行 KEY: VALUE）',
      cancel: '取消', confirm: '确定',
      id: '行 ID（默认 mcp-<服务名>）',
      emptyMcp: '还没有 MCP 服务。点击「新增服务」添加。',
      badJson: '参数不是合法的 JSON 数组，已按空格拆分',
      importMcp: '从 Claude / Codex 导入',
      importIntro: '发现本机 Claude Code（~/.claude.json）与 Codex（~/.codex/config.toml）中的 MCP 服务器如下，勾选后导入（同名覆盖现有行）：',
      importOverwrite: '同名将覆盖',
      importConfirm: '导入选中项',
      importSelectAll: '全选',
      importUnselectAll: '取消全选',
      importNone: '未在本机找到 Claude Code / Codex 的 MCP 配置（~/.claude.json、~/.codex/config.toml）。',
    },
    en: {
      nav: 'Skills & MCP',
      tabSkills: 'Skills', tabMcp: 'MCP servers',
      skillsIntro: 'Skills are scanned by directory: <name>/SKILL.md or flat <name>.md under ~/.dsh/skills and ~/.agents/skills. Project skills live in <project>/.dsh/skills. Edits apply immediately (file watching).',
      noSkills: '(no skills in this root)',
      rootMissing: '(directory missing)',
      managed: 'EAC built-in', user: 'user',
      openDir: 'Open folder',
      refresh: 'Refresh',
      loading: 'Loading…',
      mcpIntro: 'MCP servers are @deepseek-ai/dsh-mcp-client rows in the profile cordis.patch.yml. Restart the web service after saving to apply.',
      name: 'Name', transport: 'Transport', detail: 'Detail', state: 'State',
      enabled: 'enabled', disabled: 'disabled',
      edit: 'Edit', del: 'Delete', add: 'Add server',
      save: 'Save', saved: 'Saved', saving: 'Saving…', saveFail: 'Save failed',
      restartHint: 'Saved. Restart the web service to apply.',
      restartNow: 'Restart now', restarting: 'Restarting…',
      stdio: 'stdio (local command)', http: 'streamable-http (remote URL)',
      serverName: 'server name (letters/digits/_/-)',
      command: 'Command', args: 'Args (JSON array or space separated)', env: 'Env (KEY=VALUE per line)',
      url: 'URL', headers: 'Headers (KEY: VALUE per line)',
      cancel: 'Cancel', confirm: 'OK',
      id: 'Row id (default mcp-<name>)',
      emptyMcp: 'No MCP servers yet. Click "Add server" to add one.',
      badJson: 'Args was not valid JSON — split on spaces instead',
      importMcp: 'Import from Claude / Codex',
      importIntro: 'MCP servers found in Claude Code (~/.claude.json) and Codex (~/.codex/config.toml) on this machine — pick the ones to import (same-name rows are overwritten):',
      importOverwrite: 'overwrites existing',
      importConfirm: 'Import selected',
      importSelectAll: 'Select all',
      importUnselectAll: 'Clear selection',
      importNone: 'No Claude Code / Codex MCP config found (~/.claude.json, ~/.codex/config.toml).',
    },
  }
  const t = (k) => (STR[LOCALE] && STR[LOCALE][k]) || STR.en[k] || k

  function api(method, params) {
    return fetch('/api/dsh-dock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ method }, params || {})),
    }).then((r) => r.json())
  }

  const bridge = (typeof window !== 'undefined' && window.dshDesktop) || null
  const canOpen = !!(bridge && typeof bridge.openPath === 'function')
  const canRestart = !!(bridge && typeof bridge.restartService === 'function')

  function openDir(path) {
    if (canOpen) { try { bridge.openPath(path) } catch (e) {} }
  }

  // ── Skills panel ────────────────────────────────────────────────────────

  function SkillsPanel() {
    const [data, setData] = React.useState(null)
    const [err, setErr] = React.useState(null)
    const load = () => {
      setData(null); setErr(null)
      api('skills.list').then((r) => {
        if (r && r.ok) setData(r.roots || [])
        else setErr(String((r && r.error) || 'failed'))
      }).catch((e) => setErr(String(e)))
    }
    React.useEffect(load, [])
    if (err) return h('div', { className: 'dkd-hint dkd-err' }, err)
    if (!data) return h('div', { className: 'dkd-hint' }, t('loading'))
    return h('div', { className: 'dkd-col' },
      h('p', { className: 'dkd-hint' }, t('skillsIntro')),
      h('div', null, h('button', { className: 'dkd-btn', onClick: load }, t('refresh'))),
      data.map((root) => h('div', { key: root.root, className: 'dkd-sroot' },
        h('div', { className: 'dkd-roothead' },
          h('span', { className: 'dkd-roottitle' }, root.label),
          root.exists ? null : h('span', { className: 'dkd-hint' }, ' ' + t('rootMissing')),
          canOpen && root.exists
            ? h('button', { className: 'dkd-btn dkd-mini', onClick: () => openDir(root.root) }, t('openDir'))
            : null,
        ),
        root.skills.length === 0 ? h('div', { className: 'dkd-hint' }, t('noSkills')) : root.skills.map((s) =>
          h('div', { key: root.root + '/' + s.dirName, className: 'dkd-skill' },
            h('div', { className: 'dkd-skillhead' },
              h('span', { className: 'dkd-skillname' }, s.name),
              h('span', { className: 'dkd-badge' + (s.managed ? ' dkd-badge-mgd' : '') }, s.managed ? t('managed') : t('user')),
            ),
            s.description ? h('div', { className: 'dkd-skilldesc' }, s.description) : null,
          )),
      )),
    )
  }

  // ── MCP panel ───────────────────────────────────────────────────────────

  function blankRow() {
    return { id: '', disabled: false, config: { transport: 'stdio', serverName: '', command: '', args: [], env: {} } }
  }

  function argsToText(args) {
    if (Array.isArray(args)) { try { return JSON.stringify(args) } catch (e) { return '' } }
    return String(args || '')
  }
  function textToArgs(text) {
    const s = String(text || '').trim()
    if (!s) return []
    try {
      const v = JSON.parse(s)
      if (Array.isArray(v)) return v.map(String)
    } catch (e) {}
    return s.split(/\s+/).filter(Boolean)
  }
  function mapToText(map) {
    if (!map || typeof map !== 'object') return ''
    return Object.entries(map).map(([k, v]) => k + '=' + v).join('\n')
  }
  function headersToText(map) {
    if (!map || typeof map !== 'object') return ''
    return Object.entries(map).map(([k, v]) => k + ': ' + v).join('\n')
  }
  function textToMap(text, sep) {
    const out = {}
    for (const line of String(text || '').split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      const i = sep === '=' ? s.indexOf('=') : s.indexOf(':')
      if (i <= 0) continue
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
    return out
  }

  function McpEditor({ row, onSave, onCancel }) {
    const [draft, setDraft] = React.useState(() => JSON.parse(JSON.stringify(row)))
    const cfg = draft.config
    const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
    const setC = (patch) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }))
    return h('div', { className: 'dkd-editor' },
      h('label', { className: 'dkd-field' }, t('serverName'),
        h('input', { className: 'dkd-input', value: cfg.serverName || '',
          onChange: (e) => setC({ serverName: e.target.value }) })),
      h('label', { className: 'dkd-field' }, t('id'),
        h('input', { className: 'dkd-input', value: draft.id || '', placeholder: 'mcp-' + (cfg.serverName || ''),
          onChange: (e) => set({ id: e.target.value }) })),
      h('label', { className: 'dkd-field' }, t('transport'),
        h('select', { className: 'dkd-input', value: cfg.transport || 'stdio',
          onChange: (e) => setC({ transport: e.target.value }) },
          h('option', { value: 'stdio' }, t('stdio')),
          h('option', { value: 'streamable-http' }, t('http')))),
      cfg.transport === 'stdio' ? h(React.Fragment, null,
        h('label', { className: 'dkd-field' }, t('command'),
          h('input', { className: 'dkd-input', value: cfg.command || '',
            onChange: (e) => setC({ command: e.target.value }) })),
        h('label', { className: 'dkd-field' }, t('args'),
          h('input', { className: 'dkd-input', value: argsToText(cfg.args), placeholder: '["-y","server.js"] 或 -y server.js',
            onChange: (e) => setC({ args: textToArgs(e.target.value) }) })),
        h('label', { className: 'dkd-field' }, t('env'),
          h('textarea', { className: 'dkd-input dkd-area', rows: 3, value: mapToText(cfg.env),
            onChange: (e) => setC({ env: textToMap(e.target.value, '=') }) })),
      ) : h(React.Fragment, null,
        h('label', { className: 'dkd-field' }, t('url'),
          h('input', { className: 'dkd-input', value: cfg.url || '', placeholder: 'https://example.com/mcp',
            onChange: (e) => setC({ url: e.target.value }) })),
        h('label', { className: 'dkd-field' }, t('headers'),
          h('textarea', { className: 'dkd-input dkd-area', rows: 3, value: headersToText(cfg.headers),
            onChange: (e) => setC({ headers: textToMap(e.target.value, ':') }) })),
      ),
      h('div', { className: 'dkd-actions' },
        h('button', { className: 'dkd-btn dkd-primary', onClick: () => onSave(draft) }, t('confirm')),
        h('button', { className: 'dkd-btn', onClick: onCancel }, t('cancel'))),
    )
  }

  function ImportReview({ candidates, existing, onConfirm, onCancel }) {
    const [picked, setPicked] = React.useState(() => candidates.map((c) => c.config.serverName))
    const toggle = (name) => setPicked((prev) => prev.includes(name) ? prev.filter((x) => x !== name) : prev.concat([name]))
    const allOn = picked.length === candidates.length
    return h('div', { className: 'dkd-col' },
      h('p', { className: 'dkd-hint' }, t('importIntro')),
      h('div', { className: 'dkd-actions' },
        h('button', { className: 'dkd-btn dkd-mini', onClick: () => setPicked(allOn ? [] : candidates.map((c) => c.config.serverName)) },
          allOn ? t('importUnselectAll') : t('importSelectAll'))),
      candidates.map((c) => h('label', { key: c.id, className: 'dkd-mcp' + (existing.has(c.config.serverName) ? ' dkd-mcp-off' : '') },
        h('input', { type: 'checkbox', checked: picked.includes(c.config.serverName), onChange: () => toggle(c.config.serverName) }),
        h('div', { className: 'dkd-mcpmain' },
          h('div', { className: 'dkd-mcphead' },
            h('span', { className: 'dkd-mcpname' }, c.config.serverName),
            h('span', { className: 'dkd-badge' }, c.config.transport || ''),
            existing.has(c.config.serverName) ? h('span', { className: 'dkd-badge' }, t('importOverwrite')) : null,
          ),
          h('div', { className: 'dkd-mcpdetail' },
            c.config.transport === 'stdio'
              ? [c.config.command, (c.config.args || []).join(' ')].filter(Boolean).join(' ')
              : (c.config.url || '')),
        ),
      )),
      h('div', { className: 'dkd-actions' },
        h('button', { className: 'dkd-btn dkd-primary', disabled: picked.length === 0,
          onClick: () => onConfirm(candidates.filter((c) => picked.includes(c.config.serverName))) },
          t('importConfirm') + '（' + picked.length + '）'),
        h('button', { className: 'dkd-btn', onClick: onCancel }, t('cancel'))),
    )
  }

  function McpPanel() {
    const [rows, setRows] = React.useState(null)
    const [err, setErr] = React.useState(null)
    const [editing, setEditing] = React.useState(null) // {index, row} | {index:-1, row}
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState(null)
    const [restarting, setRestarting] = React.useState(false)
    const [importing, setImporting] = React.useState(null) // null | {candidates, existing}

    const load = () => {
      setRows(null); setErr(null); setNotice(null)
      api('mcp.list').then((r) => {
        if (r && r.ok) setRows(r.rows || [])
        else setErr(String((r && r.error) || 'failed'))
      }).catch((e) => setErr(String(e)))
    }
    React.useEffect(load, [])

    const saveAll = (list) => {
      setBusy(true); setErr(null); setNotice(null)
      api('mcp.save', { rows: list }).then((r) => {
        setBusy(false)
        if (r && r.ok) { setRows(list); setNotice(t('restartHint')) }
        else setErr(String((r && r.error) || t('saveFail')))
      }).catch((e) => { setBusy(false); setErr(String(e)) })
    }

    const doRestart = () => {
      if (!canRestart || restarting) return
      setRestarting(true)
      Promise.resolve(bridge.restartService()).catch(() => {}).finally(() => {
        try { location.reload() } catch (e) {}
      })
    }

    const startImport = () => {
      setErr(null)
      api('mcp.import').then((r) => {
        if (!r || !r.ok) { setErr(String((r && r.error) || 'failed')); return }
        const candidates = (r.claude || []).concat(r.codex || [])
        if (candidates.length === 0) { setNotice(t('importNone')); return }
        const existing = new Set((rows || []).map((x) => x.config && x.config.serverName))
        setImporting({ candidates, existing })
      }).catch((e) => setErr(String(e)))
    }

    if (err && !rows) return h('div', { className: 'dkd-hint dkd-err' }, err)
    if (!rows) return h('div', { className: 'dkd-hint' }, t('loading'))

    if (importing) {
      return h(ImportReview, {
        candidates: importing.candidates,
        existing: importing.existing,
        onCancel: () => setImporting(null),
        onConfirm: (picked) => {
          // 按 serverName 合并：同名导入项覆盖现有行，其余保留。
          const byName = new Map((rows || []).map((x) => [(x.config && x.config.serverName) || x.id, x]))
          for (const row of picked) byName.set(row.config.serverName, row)
          const list = [...byName.values()]
          setImporting(null)
          saveAll(list)
        },
      })
    }

    return h('div', { className: 'dkd-col' },
      h('p', { className: 'dkd-hint' }, t('mcpIntro')),
      rows.length === 0 && !editing ? h('div', { className: 'dkd-hint' }, t('emptyMcp')) : null,
      rows.map((row, i) => h('div', { key: row.id, className: 'dkd-mcp' + (row.disabled ? ' dkd-mcp-off' : '') },
        h('div', { className: 'dkd-mcpmain' },
          h('div', { className: 'dkd-mcphead' },
            h('span', { className: 'dkd-mcpname' }, (row.config && row.config.serverName) || row.id),
            h('span', { className: 'dkd-badge' }, (row.config && row.config.transport) || ''),
            h('span', { className: 'dkd-badge' + (row.disabled ? '' : ' dkd-badge-on') },
              row.disabled ? t('disabled') : t('enabled')),
          ),
          h('div', { className: 'dkd-mcpdetail' },
            row.config && row.config.transport === 'stdio'
              ? [row.config.command, (row.config.args || []).join(' ')].filter(Boolean).join(' ')
              : (row.config && row.config.url) || ''),
        ),
        h('div', { className: 'dkd-mcpacts' },
          h('button', { className: 'dkd-btn dkd-mini', onClick: () => setEditing({ index: i, row: rows[i] }) }, t('edit')),
          h('button', { className: 'dkd-btn dkd-mini', onClick: () => {
            const list = rows.slice()
            list[i] = { ...list[i], disabled: !list[i].disabled }
            saveAll(list)
          } }, row.disabled ? t('enabled') : t('disabled')),
          h('button', { className: 'dkd-btn dkd-mini dkd-danger', onClick: () => {
            const list = rows.slice()
            list.splice(i, 1)
            saveAll(list)
          } }, t('del')),
        ),
      )),
      editing ? h(McpEditor, {
        row: editing.row,
        onCancel: () => setEditing(null),
        onSave: (draft) => {
          const final = {
            id: (draft.id || '').trim() || ('mcp-' + ((draft.config && draft.config.serverName) || '')).replace(/\s+/g, '-'),
            disabled: !!draft.disabled,
            config: draft.config,
          }
          const list = rows.slice()
          if (editing.index >= 0) list[editing.index] = final
          else list.push(final)
          setEditing(null)
          saveAll(list)
        },
      }) : null,
      !editing ? h('div', { className: 'dkd-actions' },
        h('button', { className: 'dkd-btn dkd-primary', onClick: () => setEditing({ index: -1, row: blankRow() }) }, t('add')),
        h('button', { className: 'dkd-btn', onClick: startImport }, t('importMcp')),
        busy ? h('span', { className: 'dkd-hint' }, t('saving')) : null,
        notice ? h('span', { className: 'dkd-ok' }, notice,
          canRestart ? h('button', { className: 'dkd-btn dkd-mini', disabled: restarting, onClick: doRestart },
            restarting ? t('restarting') : t('restartNow')) : null) : null,
        err ? h('span', { className: 'dkd-err' }, err) : null,
      ) : null,
    )
  }

  // ── section shell ───────────────────────────────────────────────────────

  function DockSection() {
    const [tab, setTab] = React.useState('skills')
    return h('div', { className: 'dkd-root' },
      h('div', { className: 'dkd-tabs' },
        h('button', { className: 'dkd-tab' + (tab === 'skills' ? ' dkd-tab-on' : ''), onClick: () => setTab('skills') }, t('tabSkills')),
        h('button', { className: 'dkd-tab' + (tab === 'mcp' ? ' dkd-tab-on' : ''), onClick: () => setTab('mcp') }, t('tabMcp'))),
      tab === 'skills' ? h(SkillsPanel) : h(McpPanel),
    )
  }

  const CSS = `
.dkd-root{max-width:44rem;display:flex;flex-direction:column;gap:12px;font-size:14px;color:var(--dsw-alias-label-primary)}
.dkd-tabs{display:flex;gap:6px}
.dkd-tab{border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 14px;font:inherit;font-size:13px;cursor:pointer}
.dkd-tab:hover{color:var(--dsw-alias-label-primary)}
.dkd-tab-on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);font-weight:600}
.dkd-col{display:flex;flex-direction:column;gap:10px}
.dkd-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}
.dkd-err{color:var(--dsw-alias-state-error-primary)}
.dkd-ok{font-size:12px;color:var(--dsw-alias-state-success-primary);display:inline-flex;gap:8px;align-items:center}
.dkd-sroot{display:flex;flex-direction:column;gap:6px}
.dkd-roothead{display:flex;align-items:center;gap:8px}
.dkd-roottitle{font-size:13px;font-weight:600}
.dkd-skill{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-3)}
.dkd-skillhead{display:flex;align-items:center;gap:8px}
.dkd-skillname{font-size:13px;font-weight:600;font-family:ui-monospace,monospace}
.dkd-skilldesc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dkd-badge{font-size:10.5px;line-height:16px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dkd-badge-mgd{color:var(--dsw-static-deepseek-500);border-color:color-mix(in srgb,var(--dsw-static-deepseek-500) 40%,transparent)}
.dkd-badge-on{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.dkd-btn{border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 12px;font:inherit;font-size:12.5px;cursor:pointer}
.dkd-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dkd-btn:disabled{opacity:.5;cursor:default}
.dkd-mini{padding:1px 8px;font-size:11.5px}
.dkd-primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);font-weight:500}
.dkd-primary:hover:not(:disabled){opacity:.85;color:var(--dsw-alias-bg-layer-3)}
.dkd-danger{color:var(--dsw-alias-state-error-primary)}
.dkd-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary)}
.dkd-mcp{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-3);display:flex;gap:10px;align-items:center}
.dkd-mcp-off{opacity:.6}
.dkd-mcpmain{flex:1;min-width:0}
.dkd-mcphead{display:flex;align-items:center;gap:8px}
.dkd-mcpname{font-size:13px;font-weight:600;font-family:ui-monospace,monospace}
.dkd-mcpdetail{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkd-mcpacts{display:flex;gap:6px;flex:none}
.dkd-editor{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px}
.dkd-field{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dkd-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 10px;font:inherit;font-size:13px}
.dkd-area{font-family:ui-monospace,monospace;font-size:12px;resize:vertical}
.dkd-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
`

  const inject = ['slots']

  function apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => {
      const id = 'dsh-dock-style'
      if (!document.getElementById(id)) {
        const s = document.createElement('style')
        s.id = id
        s.textContent = CSS
        document.head.appendChild(s)
      }
      return () => { const el = document.getElementById(id); if (el) el.remove() }
    }, 'dock-style')
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'dock', order: 22, label: () => (LOCALE === 'zh' ? 'Skills 与 MCP' : 'Skills & MCP') },
      DockSection,
    ))
  }

  module.exports = { inject, apply }
  return module.exports;
} })

// Host half of dsh-dock-settings. Registers one HTTP route (/api/dsh-dock):
//   skills.list — scan the dsh user skill roots (~/.dsh/skills, ~/.agents/skills),
//                 parse SKILL.md / flat *.md frontmatter, mark EAC-managed dirs.
//   mcp.list    — parse @deepseek-ai/dsh-mcp-client rows out of the profile's
//                 cordis.patch.yml.
//   mcp.save    — replace the whole MCP row set in that file (same-origin POST
//                 only); every other block is preserved verbatim. Takes effect
//                 after the next web service restart.
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dock-settings'

/** Hard dependency: the HTTP carrier must exist before the route registers. */
export const inject = ['webServer']

const MCP_PKG = '@deepseek-ai/dsh-mcp-client'

function dshHome() {
  return process.env.DSH_HOME || (homedir() + '/.dsh')
}

// Desktop shell runs its web UI on a dedicated profile (web-desktop) so
// installs never collide with the native CLI's 'web' profile; it exports the
// name through DSH_DESKTOP_PROFILE. Standalone (CLI) installs keep 'web'.
function desktopProfile() {
  const p = process.env.DSH_DESKTOP_PROFILE
  return p && /^[A-Za-z0-9_-]+$/.test(p) ? p : 'web'
}

function agentsHome() {
  return process.env.DSH_AGENTS_HOME || (homedir() + '/.agents')
}

function profileDir(profile) {
  return dshHome().replace(/[\\/]+$/, '') + '/profiles/' + profile
}

function validProfile(p) {
  return typeof p === 'string' && /^[A-Za-z0-9_-]+$/.test(p)
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

// ── skills listing ─────────────────────────────────────────────────────────

/** Parse the frontmatter of one SKILL.md / flat markdown file (best effort). */
function parseFrontmatter(text) {
  const out = { name: '', description: '', whenToUse: '' }
  if (typeof text !== 'string' || !text.startsWith('---')) return out
  const end = text.indexOf('\n---', 3)
  const block = end === -1 ? text.slice(3) : text.slice(3, end)
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    if (key === 'name' || key === 'description' || key === 'whenToUse') out[key] = value
  }
  return out
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function listRoot(root, label) {
  const skills = []
  if (!existsSync(root)) return { root, label, exists: false, skills }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillFile = join(root, entry.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const fm = parseFrontmatter(readFileSync(skillFile, 'utf8'))
      skills.push({
        kind: 'bundle',
        dirName: entry.name,
        name: fm.name || entry.name,
        description: fm.description,
        whenToUse: fm.whenToUse,
        managed: !!readJson(join(root, entry.name, '.eac-skill.json')),
      })
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
      const fm = parseFrontmatter(readFileSync(join(root, entry.name), 'utf8'))
      if (!fm.name) continue
      skills.push({
        kind: 'flat',
        dirName: entry.name,
        name: fm.name,
        description: fm.description,
        whenToUse: fm.whenToUse,
        managed: false,
      })
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { root, label, exists: true, skills }
}

// ── patch layer (MCP rows) ─────────────────────────────────────────────────

/**
 * Split a cordis.patch.yml document into a header (everything before the
 * first top-level `- insert:` block, kept verbatim) and blocks (line arrays).
 */
function splitBlocks(text) {
  const lines = String(text || '').split(/\r?\n/)
  const header = []
  const blocks = []
  let current = null
  for (const line of lines) {
    if (/^-\s*insert:/.test(line)) {
      current = [line]
      blocks.push(current)
      continue
    }
    if (current === null) header.push(line)
    else current.push(line)
  }
  return { header, blocks }
}

function blockField(block, key) {
  for (const line of block) {
    const m = new RegExp('^\\s*-?\\s*' + key + ':\\s*(.*?)\\s*$').exec(line)
    if (m) {
      let v = m[1]
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
      return v
    }
  }
  return undefined
}

/** Parse one YAML scalar-ish value: JSON first (configLinesFor emits JSON), raw string fallback. */
function parseValue(raw) {
  const s = String(raw).trim()
  if (s === '' ) return ''
  if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1)
  try { return JSON.parse(s) } catch { return s }
}

/**
 * Parse an MCP row block into { id, disabled, config }. Config values are
 * inline (JSON) or nested blocks (`args:` followed by deeper `- item` lines,
 * `env:` followed by `K: V` lines).
 */
function parseMcpBlock(block) {
  const id = blockField(block, 'id')
  if (!id) return null
  const config = {}
  let inConfig = false
  for (let i = 0; i < block.length; i += 1) {
    const line = block[i]
    if (/^\s*config:\s*$/.test(line)) { inConfig = true; continue }
    if (!inConfig) continue
    const kv = /^ {8}([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const raw = kv[2].trim()
    if (raw === '') {
      // Block value: list (`- x` lines) or map (`k: v` lines) at 10+ spaces.
      const listItems = []
      const mapEntries = {}
      let j = i + 1
      for (; j < block.length; j += 1) {
        const li = /^ {10,}-\s+(.*)$/.exec(block[j])
        const mi = /^ {10,}([\w.-]+):\s*(.*)$/.exec(block[j])
        if (li) { listItems.push(parseValue(li[1])); continue }
        if (mi) { mapEntries[mi[1]] = parseValue(mi[2]); continue }
        break
      }
      if (listItems.length) config[key] = listItems
      else if (Object.keys(mapEntries).length) config[key] = mapEntries
      else config[key] = {}
      i = j - 1
      continue
    }
    config[key] = parseValue(raw)
  }
  const disabled = block.some((l) => /^\s*disabled:\s*true\s*$/.test(l))
  return { id, disabled, config }
}

function readMcpRows(profile) {
  const file = join(profileDir(profile), 'cordis.patch.yml')
  if (!existsSync(file)) return { file, rows: [], header: '', otherBlocks: [] }
  const text = readFileSync(file, 'utf8')
  const { header, blocks } = splitBlocks(text)
  const rows = []
  const otherBlocks = []
  for (const block of blocks) {
    if (blockField(block, 'name') === MCP_PKG) {
      const parsed = parseMcpBlock(block)
      if (parsed) rows.push(parsed)
    } else {
      otherBlocks.push(block)
    }
  }
  return { file, rows, header: header.join('\n'), otherBlocks }
}

/** Serialize one MCP row exactly like the desktop sync pass does (JSON values). */
function emitMcpRow(row) {
  let out = '- insert:\n'
  out += `    - id: ${row.id}\n`
  out += `      name: '${MCP_PKG}'\n`
  if (row.disabled) out += '      disabled: true\n'
  const config = row.config || {}
  if (Object.keys(config).length) {
    out += '      config:\n'
    for (const [k, v] of Object.entries(config)) {
      out += `        ${k}: ${JSON.stringify(v)}\n`
    }
  }
  return out
}

/** Validate an MCP row before it is allowed anywhere near the patch file. */
function validateRow(row) {
  if (!row || typeof row !== 'object') return 'bad row'
  if (!/^[\w.-]+$/.test(String(row.id || ''))) return 'bad id'
  const config = row.config || {}
  const serverName = String(config.serverName || '')
  if (!/^[A-Za-z0-9_-]+$/.test(serverName)) return 'bad serverName'
  if (config.transport === 'stdio') {
    if (!String(config.command || '').trim()) return 'stdio requires command'
  } else if (config.transport === 'streamable-http') {
    let url = String(config.url || '')
    if (!/^https?:\/\//i.test(url)) return 'http requires an http(s) url'
  } else {
    return 'bad transport'
  }
  return null
}

// ── MCP import from Claude Code / Codex configs ────────────────────────────

/** Parse ~/.claude.json's global mcpServers into MCP rows (stdio + http). */
function importFromClaude(json) {
  const servers = json && typeof json === 'object' && json.mcpServers && typeof json.mcpServers === 'object'
    ? json.mcpServers : {}
  const rows = []
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    if (cfg.type === 'http' || cfg.type === 'sse' || (cfg.url && !cfg.command)) {
      if (!/^https?:\/\//i.test(String(cfg.url || ''))) continue
      rows.push({
        id: 'mcp-' + name.replace(/[^\w-]/g, '-'),
        disabled: false,
        config: { transport: 'streamable-http', serverName: name, url: String(cfg.url), headers: cfg.headers || {} },
      })
    } else if (cfg.command) {
      rows.push({
        id: 'mcp-' + name.replace(/[^\w-]/g, '-'),
        disabled: false,
        config: {
          transport: 'stdio', serverName: name, command: String(cfg.command),
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
          env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
        },
      })
    }
  }
  return rows
}

/**
 * Parse ~/.codex/config.toml's [mcp_servers.<name>] tables. Tiny targeted
 * TOML reader (strings / arrays / inline tables only — that is the whole
 * surface Codex MCP entries use).
 */
function importFromCodexToml(text) {
  const rows = []
  const lines = String(text || '').split(/\r?\n/)
  let current = null
  const parseValue = (raw) => {
    const s = String(raw).trim()
    if (s.startsWith('[') && s.endsWith(']')) {
      try { return JSON.parse(s.replace(/'/g, '"')) } catch { return s.slice(1, -1).split(',').map((x) => x.trim()) }
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const out = {}
      for (const part of s.slice(1, -1).split(',')) {
        const i = part.indexOf('=')
        if (i <= 0) continue
        const k = part.slice(0, i).trim()
        let v = part.slice(i + 1).trim()
        if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
        out[k] = v
      }
      return out
    }
    if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1)
    return s
  }
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const table = /^\[mcp_servers\.([\w-]+)\]$/.exec(t)
    if (table) {
      if (current) rows.push(current)
      current = {
        id: 'mcp-' + table[1],
        disabled: false,
        config: { transport: 'stdio', serverName: table[1], command: '', args: [], env: {} },
      }
      continue
    }
    if (t.startsWith('[')) { if (current) { rows.push(current); current = null } continue }
    if (!current) continue
    const kv = /^([\w-]+)\s*=\s*(.+)$/.exec(t)
    if (!kv) continue
    const key = kv[1]
    const value = parseValue(kv[2])
    if (key === 'command') current.config.command = String(value)
    else if (key === 'args') current.config.args = Array.isArray(value) ? value.map(String) : []
    else if (key === 'env') current.config.env = value && typeof value === 'object' ? value : {}
    else if (key === 'url') { current.config.transport = 'streamable-http'; current.config.url = String(value) }
  }
  if (current && current.config.command) rows.push(current)
  return rows.filter((r) => (r.config.transport === 'stdio' && r.config.command) || r.config.url)
}

export function apply(ctx) {  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-dock] webServer service unavailable at apply; route not registered')
    return
  }
  webServer.register({
    kind: 'exact',
    path: '/api/dsh-dock',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const method = String(body.method || '')
        if (method === 'skills.list') {
          const roots = [
            listRoot(join(dshHome(), 'skills'), '~/.dsh/skills（用户技能）'),
            listRoot(join(agentsHome(), 'skills'), '~/.agents/skills（Agents 共享技能）'),
          ]
          return sendJson(res, 200, { ok: true, roots })
        }
        if (method === 'mcp.list') {
          const profile = validProfile(body.profile) ? body.profile : desktopProfile()
          const { rows, file } = readMcpRows(profile)
          return sendJson(res, 200, { ok: true, profile, file, rows })
        }
        if (method === 'mcp.import') {
          // 扫描本机 Claude Code (~/.claude.json) 与 Codex (~/.codex/config.toml)
          // 的 MCP 配置，转成待导入行。只读不改；取舍由浏览器端确认后走
          // mcp.save。
          const found = { claude: [], codex: [], sources: [] }
          const claudeFile = join(homedir(), '.claude.json')
          if (existsSync(claudeFile)) {
            found.sources.push('~/.claude.json')
            try { found.claude = importFromClaude(readJson(claudeFile)) } catch { found.claude = [] }
          }
          const codexFile = join(homedir(), '.codex', 'config.toml')
          if (existsSync(codexFile)) {
            found.sources.push('~/.codex/config.toml')
            try { found.codex = importFromCodexToml(readFileSync(codexFile, 'utf8')) } catch { found.codex = [] }
          }
          return sendJson(res, 200, { ok: true, ...found })
        }
        if (method === 'mcp.save') {
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          const profile = validProfile(body.profile) ? body.profile : desktopProfile()
          if (!Array.isArray(body.rows)) {
            return sendJson(res, 400, { ok: false, error: 'rows must be an array' })
          }
          const seen = new Set()
          for (const row of body.rows) {
            const problem = validateRow(row)
            if (problem) return sendJson(res, 200, { ok: false, error: problem + ': ' + String(row && row.id) })
            if (seen.has(row.id)) return sendJson(res, 200, { ok: false, error: 'duplicate id: ' + row.id })
            seen.add(row.id)
          }
          const { file, header, otherBlocks } = readMcpRows(profile)
          // `[]` (empty patch) and an empty header are both replaced by the
          // blocks themselves; otherwise keep the original header verbatim.
          const headText = String(header || '').trim()
          let text = (headText === '[]' ? '' : headText + '\n')
          for (const block of otherBlocks) text += block.join('\n').replace(/\s*$/, '\n')
          for (const row of body.rows) text += emitMcpRow(row)
          text = text.replace(/\n{3,}/g, '\n\n')
          if (!text.endsWith('\n')) text += '\n'
          const tmp = file + '.dock-tmp'
          writeFileSync(tmp, text)
          renameSync(tmp, file)
          return sendJson(res, 200, { ok: true, profile, saved: body.rows.length })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown method ' + method })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })
}

// Test hooks (mirrors dsh-unified-market): cordis only reads name/inject/apply.
export { splitBlocks, blockField, parseMcpBlock, emitMcpRow, readMcpRows, validateRow, parseFrontmatter, importFromClaude, importFromCodexToml }

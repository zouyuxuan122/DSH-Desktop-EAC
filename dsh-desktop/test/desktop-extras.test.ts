// Tests for the three new companion plugins' client bundles:
//   · dsh-font-custom   — config sanitization + CSS generation
//   · dsh-auto-compact  — occupancy math + config clamping
//   · dsh-dock-settings — MCP import parsers (Claude JSON / Codex TOML)
//
// Client bundles load through window.__ModuleLoader__.load(); the test host
// provides a minimal loader + react stub, then exercises the exported
// __internals. The dock host half is real ESM and imports directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Load a client bundle's factory exports under a minimal ModuleLoader. */
function loadBundle(rel) {
  const captured = {};
  globalThis.window = {
    __ModuleLoader__: {
      load: (spec) => {
        const react = {
          createElement: () => null,
          useState: () => [null, () => {}],
          useEffect: () => {},
          useCallback: (fn) => fn,
          useMemo: (fn) => fn(),
        };
        captured.exports = spec.factory((id) => (id === 'react' ? react : {}));
      },
    },
    localStorage: {
      _s: new Map(),
      getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
      setItem(k, v) { this._s.set(k, String(v)); },
    },
  };
  // Evaluate the bundle as a script in this scope (it references `window`).
  const src = readFileSync(join(root, rel), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', src)(globalThis.window);
  return captured.exports;
}

// ── dsh-font-custom ─────────────────────────────────────────────────────────

test('font-custom: sanitize clamps sizes and strips unsafe font stacks', () => {
  const ex = loadBundle('assets/plugins/dsh-font-custom/lib/client.js').__internals;
  const out = ex.sanitize({
    uiFont: '"Good Font", sans-serif{}<script>',
    uiSize: 999,
    codeSize: 1,
    chatSize: '15',
    primaryColor: '#aabbcc',
    secondaryColor: 'javascript:alert(1)',
    accentColor: 'rgb(1, 2, 3)',
  });
  assert.equal(out.uiFont.includes('<script>'), false, 'unsafe chars must be stripped');
  assert.equal(out.uiSize, 22, 'ui size clamps to 22');
  assert.equal(out.codeSize, 10, 'code size clamps to 10');
  assert.equal(out.chatSize, 15, 'chat size parses numeric strings');
  assert.equal(out.primaryColor, '#aabbcc');
  assert.equal(out.secondaryColor, '', 'non-color values are dropped');
  assert.equal(out.accentColor, 'rgb(1, 2, 3)');
});

test('font-custom: buildCss emits variable overrides for configured fields only', () => {
  const ex = loadBundle('assets/plugins/dsh-font-custom/lib/client.js').__internals;
  const css = ex.buildCss(ex.sanitize({
    uiFont: '"Noto Sans SC", sans-serif',
    codeFont: 'Consolas, monospace',
    uiSize: 15,
    chatSize: 16,
    codeSize: 12,
    primaryColor: '#112233',
  }));
  assert.ok(css.includes('--dsw-font-family:"Noto Sans SC", sans-serif'));
  assert.ok(css.includes('--ds-font-family-code:Consolas, monospace'));
  assert.ok(css.includes('body{font-size:15px}'));
  assert.ok(css.includes('[data-chat-flow-kind]{font-size:16px}'));
  assert.ok(css.includes('pre,code,kbd,samp{font-size:12px}'));
  assert.ok(css.includes('--dsw-alias-label-primary:#112233'));
  const empty = ex.buildCss(ex.sanitize({}));
  assert.equal(empty, '', 'defaults emit no overrides');
});

// ── dsh-auto-compact ────────────────────────────────────────────────────────

test('auto-compact: occupancy follows the official ContextMeter formula', () => {
  const ex = loadBundle('assets/plugins/dsh-auto-compact/lib/client.js').__internals;
  const occ = ex.occupancyOf({ projectedTokens: 80_000, pressureTokens: 60_000, contextWindow: 100_000 });
  assert.equal(occ.percent, 80);
  // 无 projectedTokens 时回落到压力采样（与官方一致）。
  const occ2 = ex.occupancyOf({ pressureTokens: 50_000, contextWindow: 100_000 });
  assert.equal(occ2.percent, 50);
  // 缺口字段 → null（不触发）。
  assert.equal(ex.occupancyOf({ projectedTokens: 10 }), null);
  assert.equal(ex.occupancyOf(null), null);
  // 超上限按 100 计。
  assert.equal(ex.occupancyOf({ projectedTokens: 120_000, contextWindow: 100_000 }).percent, 100);
});

test('auto-compact: config clamps threshold into 60..95 and defaults to enabled', () => {
  const ex = loadBundle('assets/plugins/dsh-auto-compact/lib/client.js').__internals;
  assert.deepEqual(ex.sanitizeConfig({ threshold: 40 }), { enabled: true, threshold: 60 });
  assert.deepEqual(ex.sanitizeConfig({ threshold: 99 }), { enabled: true, threshold: 95 });
  assert.deepEqual(ex.sanitizeConfig({ enabled: false }), { enabled: false, threshold: 80 });
  assert.deepEqual(ex.sanitizeConfig({}), { enabled: true, threshold: 80 });
});

// ── dsh-dock-settings: MCP import parsers ───────────────────────────────────

test('mcp import: parses Claude Code mcpServers (stdio + http)', async () => {
  const host = await import(pathToFileURL(join(root, 'assets/plugins/dsh-dock-settings/lib/host.js')).href);
  const rows = host.importFromClaude({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { X: '1' } },
      remote: { type: 'http', url: 'https://mcp.example.com/sse' },
      broken: { type: 'http' }, // 无 URL → 跳过
    },
  });
  assert.equal(rows.length, 2);
  const fsrow = rows.find((r) => r.config.serverName === 'filesystem');
  assert.equal(fsrow.config.transport, 'stdio');
  assert.equal(fsrow.config.command, 'npx');
  assert.deepEqual(fsrow.config.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.deepEqual(fsrow.config.env, { X: '1' });
  assert.equal(fsrow.id, 'mcp-filesystem');
  const httpRow = rows.find((r) => r.config.serverName === 'remote');
  assert.equal(httpRow.config.transport, 'streamable-http');
  assert.equal(httpRow.config.url, 'https://mcp.example.com/sse');
});

test('mcp import: parses Codex config.toml mcp_servers tables', async () => {
  const host = await import(pathToFileURL(join(root, 'assets/plugins/dsh-dock-settings/lib/host.js')).href);
  const toml = [
    '[mcp_servers.weather]',
    'command = "uvx"',
    'args = ["mcp-server-weather", "--units", "celsius"]',
    'env = { API_KEY = "abc" }',
    '',
    '[mcp_servers.docs]',
    'command = "npx"',
    'args = ["-y", "docs-server"]',
    '',
    '[other_section]',
    'key = "value"',
    '',
  ].join('\n');
  const rows = host.importFromCodexToml(toml);
  assert.equal(rows.length, 2);
  const weather = rows.find((r) => r.config.serverName === 'weather');
  assert.equal(weather.config.command, 'uvx');
  assert.deepEqual(weather.config.args, ['mcp-server-weather', '--units', 'celsius']);
  assert.deepEqual(weather.config.env, { API_KEY: 'abc' });
  const docs = rows.find((r) => r.config.serverName === 'docs');
  assert.deepEqual(docs.config.args, ['-y', 'docs-server']);
});

test('mcp import: importFromClaude tolerates missing/odd shapes', async () => {
  const host = await import(pathToFileURL(join(root, 'assets/plugins/dsh-dock-settings/lib/host.js')).href);
  assert.deepEqual(host.importFromClaude(null), []);
  assert.deepEqual(host.importFromClaude({ mcpServers: null }), []);
  assert.deepEqual(host.importFromClaude({ mcpServers: { a: null, b: {} } }), []);
});

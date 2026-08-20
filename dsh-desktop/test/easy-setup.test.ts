// TDD tests for the dsh-easy-setup companion plugin's pure logic:
//   1. persona path resolution — which soul.md the persona editor edits
//   2. migration prompt generation — the instruction auto-sent to a fresh
//      session whose workspace is a Codex / Claude Code directory.
//
// User-facing contract (the "one-click takeover" feature):
//   Settings → 一键迁移 → pick the Codex/Claude folder → the folder becomes a
//   workspace, a new session opens there, and a ready-made migration prompt
//   tells the agent to copy skills into ~/.dsh/skills, append MCP servers to
//   the web profile's cordis.patch.yml, and fold CLAUDE.md/AGENTS.md memories
//   into soul.md — all visible in the conversation as normal tool calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersonaPath, buildMigrationPrompt } from '../assets/plugins/dsh-easy-setup/lib/logic.js';

const HOME = 'C:/Users/tester/.dsh';

// ── persona path resolution ─────────────────────────────────────────────

test('persona path: settings.yaml user override wins', () => {
  const settings = ['ui-theme:', '  preference: light', 'soul-md:', "  path: 'personas/cat.md'"].join('\n');
  const patch = ['- insert:', "    - id: soul-md", "      name: 'dsh-soul-md'", '      config:', "        path: 'soul.md'"].join('\n');
  assert.equal(resolvePersonaPath({ home: HOME, settingsText: settings, patchText: patch }), HOME + '/personas/cat.md');
});

test('persona path: falls back to the patch.yml composition layer', () => {
  const patch = ['- insert:', "    - id: soul-md", "      name: 'dsh-soul-md'", '      config:', "        path: 'cards/main.md'", '        watch: true'].join('\n');
  assert.equal(resolvePersonaPath({ home: HOME, settingsText: '', patchText: patch }), HOME + '/cards/main.md');
});

test('persona path: defaults to <home>/soul.md when nothing configures it', () => {
  assert.equal(resolvePersonaPath({ home: HOME, settingsText: '', patchText: '' }), HOME + '/soul.md');
});

test('persona path: absolute configured paths are kept as-is', () => {
  const settings = ['soul-md:', "  path: 'D:/cards/persona.md'"].join('\n');
  assert.equal(resolvePersonaPath({ home: HOME, settingsText: settings, patchText: '' }), 'D:/cards/persona.md');
});

test('persona path: soul-md block in patch.yml must not leak another row\'s path', () => {
  // A later row carries its own `path:` config; the resolver must scope the
  // lookup to the soul-md insert block only.
  const patch = [
    '- insert:',
    '    - id: soul-md',
    "      name: 'dsh-soul-md'",
    '- insert:',
    '    - id: other-plugin',
    "      name: 'dsh-other'",
    '      config:',
    "        path: 'wrong.md'",
  ].join('\n');
  assert.equal(resolvePersonaPath({ home: HOME, settingsText: '', patchText: patch }), HOME + '/soul.md');
});

// ── migration prompt ────────────────────────────────────────────────────

test('migration prompt: targets the dsh home skills dir, patch.yml and soul.md', () => {
  const prompt = buildMigrationPrompt({ home: HOME });
  assert.ok(prompt.includes(HOME + '/skills'), 'must name the global skills dir');
  assert.ok(prompt.includes(HOME + '/profiles/web/cordis.patch.yml'), 'must name the profile patch file');
  assert.ok(prompt.includes(HOME + '/soul.md'), 'must name soul.md');
});

test('migration prompt: covers Claude Code and Codex layouts', () => {
  const prompt = buildMigrationPrompt({ home: HOME });
  assert.ok(prompt.includes('.claude/skills'), 'Claude skills dir');
  assert.ok(prompt.includes('.codex'), 'Codex dir');
  assert.ok(prompt.includes('.mcp.json'), 'project MCP config');
  assert.ok(prompt.includes('CLAUDE.md') && prompt.includes('AGENTS.md'), 'memory files');
});

test('migration prompt: spells out the dsh-mcp-client row shape', () => {
  const prompt = buildMigrationPrompt({ home: HOME });
  assert.ok(prompt.includes("name: '@deepseek-ai/dsh-mcp-client'"), 'plugin name');
  assert.ok(prompt.includes('serverName'), 'serverName field');
  assert.ok(prompt.includes('stdio'), 'stdio transport');
  assert.ok(prompt.includes('streamable-http'), 'http transport');
});

test('migration prompt: forbids touching source files and demands a summary', () => {
  const prompt = buildMigrationPrompt({ home: HOME });
  assert.ok(/不要(修改|改动|覆盖).*(源|原)/.test(prompt) || /只读/.test(prompt), 'source files stay untouched');
  assert.ok(prompt.includes('汇总'), 'ends with a summary demand');
});

// ── migration prompt: the workspace may BE the tool's install dir ───────
// The user picks e.g. ~/.codex or ~/.claude itself as the workspace, so the
// agent must also scan layouts rooted at the workspace top level, not only
// the .claude/… / .codex/… sub-dirs of an ordinary project folder.

test('migration prompt: scans root-level skills when the workspace is the install dir', () => {
  const prompt = buildMigrationPrompt({ home: HOME });
  // `skills/` must appear as a path START (start of line or a CJK/whitespace
  // separator) — a mere `.claude/skills` mention must NOT satisfy this.
  assert.ok(/(^|[\s（(、,，])skills\/\*\/SKILL\.md/.test(prompt), 'root-level skills/*/SKILL.md must be scanned');
});

test('migration prompt: reads root-level config.toml and the parent .claude.json', () => {
  const prompt = buildMigrationPrompt({ home: HOME });
  assert.ok(/工作区根目录的 config\.toml|根目录下的 config\.toml|config\.toml/.test(prompt), 'root-level Codex config.toml');
  assert.ok(prompt.includes('.claude.json'), 'Claude global .claude.json (may sit in the parent of ~/.claude)');
});

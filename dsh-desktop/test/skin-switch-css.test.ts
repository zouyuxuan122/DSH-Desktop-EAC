// TDD regression tests for the dsh-skin-switch plugin's bundled client CSS.
//
// Bug reported: on the 皮肤 (skin) tab, the "应用此皮肤" (apply) button label
// was invisible under several bundled skins. Root cause: the `.sks_apply`
// rule colors its text with `var(--dsw-alias-bg-base)`, and skins override
// that token with a translucent color (e.g. dragon-heir sets
// `--dsw-alias-bg-base:#faf7f057`, ~34% opacity), so the label renders at
// ~34% opacity and is effectively unreadable — the button looks like it has
// no text and gives no visible feedback on click.
//
// The apply button should use the "text on primary" token with an opaque
// fallback, never the (possibly translucent) app background token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientFile = join(root, 'assets', 'plugins', 'dsh-skin-switch', 'lib', 'client.js');

/** The bundled skin-switch CSS, as a single string (from the injected style tag). */
function skinSwitchCss() {
  const src = readFileSync(clientFile, 'utf8');
  const m = src.match(/const css\s*=\s*"([\s\S]*?)";\s*\n\s*const tagId\s*=\s*"@deepseek-ai\/dsh-skin-switch\//);
  assert.ok(m, 'expected to find the skin-switch css block in ' + clientFile);
  // Unescape the JS string literal into plain CSS.
  return m[1]
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
    .replace(/\\(.)/g, '$1');
}

/** Extract the `.sks_apply` rule's declarations into a map. */
function applyRuleDeclarations(css) {
  const m = css.match(/\.sks_apply\{([^}]*)\}/);
  assert.ok(m, 'expected a `.sks_apply{...}` rule in the skin-switch css');
  const decls = {};
  for (const part of m[1].split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    decls[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return decls;
}

test('apply button text color does not use the (possibly translucent) app background token', () => {
  const decls = applyRuleDeclarations(skinSwitchCss());
  assert.ok(decls.color, 'expected `.sks_apply` to declare a color');
  assert.ok(
    !decls.color.includes('--dsw-alias-bg-base'),
    '`.sks_apply` must not color its label with `--dsw-alias-bg-base` ' +
      '(skins like dragon-heir make that token ~34% translucent, hiding the label)'
  );
});

test('apply button text color resolves opaque under the dragon-heir token set', () => {
  const decls = applyRuleDeclarations(skinSwitchCss());
  // dragon-heir overrides: --dsw-alias-bg-base:#faf7f057 (34% alpha).
  const tokens = {
    '--dsw-alias-bg-base': '#faf7f057',
    '--dsw-alias-state-business-primary': '#2e8e52',
    '--dsw-alias-label-primary-foreground': '#fff',
  };
  const resolve = (value) => {
    const m = value.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/);
    if (!m) return value.trim();
    const fallback = m[2] ? m[2].trim() : 'transparent';
    return tokens[m[1].trim()] ?? fallback;
  };
  const textColor = resolve(decls.color);
  const alpha = textColor.match(/rgba?\([^)]*,\s*([\d.]+)\)$/);
  if (alpha) {
    assert.ok(
      Number(alpha[1]) > 0.8,
      `apply label resolves to a translucent color (alpha ${alpha[1]}) under dragon-heir; it must stay opaque`
    );
  } else {
    assert.match(textColor, /^#[0-9a-fA-F]{3,8}$/, 'apply label should resolve to an opaque color');
  }
  // The text color must differ from the business-primary background (contrast exists).
  const bg = resolve(decls.background);
  assert.notEqual(textColor.toLowerCase(), bg.toLowerCase());
});

test('the reset button keeps a readable label color', () => {
  const css = skinSwitchCss();
  const m = css.match(/\.sks_reset\{([^}]*)\}/);
  assert.ok(m, 'expected a `.sks_reset{...}` rule');
  assert.match(m[1], /color:var\(--dsw-alias-label-primary\)/, '`.sks_reset` should use the primary label token');
});

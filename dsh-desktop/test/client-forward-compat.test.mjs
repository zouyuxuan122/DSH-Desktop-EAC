import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = [
  'dsh-compact',
  'dsh-conversation-tweaks',
  'dsh-openclaw-bridge',
  'dsh-prompt-custom',
  'dsh-session-manager',
  'dsh-third-party-thinking',
];

// dsh 0.1.1 stopped seeding these old shell modules in the browser module
// table. Companion plugins are fetched dynamically, so a synchronous require
// of either package fails before the plugin factory can run. Keep these small
// plugins on React/native controls so an agent overlay can move forward without
// waiting for a matching desktop release.
test('companion clients do not require legacy shell-only modules', () => {
  for (const name of plugins) {
    const client = readFileSync(join(root, 'assets', 'plugins', name, 'lib', 'client.js'), 'utf8');
    assert.doesNotMatch(
      client,
      /require\(["']@deepseek-ai\/dsh-client-(?:web-react|ui-primitives)["']\)/,
      `${name} synchronously requires a module absent from the dsh 0.1.1 module table`,
    );

    const pkg = JSON.parse(readFileSync(join(root, 'assets', 'plugins', name, 'package.json'), 'utf8'));
    const inject = pkg.dsh?.client?.inject || [];
    assert.equal(
      inject.some((id) => id === '@deepseek-ai/dsh-client-web-react' || id === '@deepseek-ai/dsh-client-ui-primitives'),
      false,
      `${name} injects a module absent from the dsh 0.1.1 module table`,
    );
  }
});

test('session manager only injects modules available in current and legacy agents', () => {
  const pkg = JSON.parse(readFileSync(
    join(root, 'assets', 'plugins', 'dsh-session-manager', 'package.json'),
    'utf8',
  ));
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-runtime']);
});

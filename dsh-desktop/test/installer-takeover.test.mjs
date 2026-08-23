// Static regression tests for the installer old-version takeover
// (issues #7/#8). NSIS itself can't run under node:test, so we lock in the
// critical invariants of build/installer.nsh:
//
//  1. The installer NEVER delegates to the OLD uninstaller anymore (it
//     aborts midway leaving empty package skeletons → issue #7, and fails
//     upgrades with exit code 2 → issue #8). It wipes the old install dir
//     itself (guarded) and clears the old uninstall registry values so
//     electron-builder's built-in "uninstall old version" step is skipped.
//  2. The wipe is guarded: only runs when the dir looks like OUR install
//     (resources\app + our exe/uninstaller present, dir name matches the
//     product, path long enough to not be a drive root) so a custom install
//     into a shared folder can never nuke unrelated files.
//  3. A long-path-safe fallback (robocopy mirror) exists for pre-v2.0.3
//     deep trees that RMDir /r cannot delete.
//  4. The process-kill and dialog-free wait behavior from v2.0.3 survives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const nsh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'installer.nsh'), 'utf8');

test('takes over old-version cleanup: wipes the old tree itself', () => {
  assert.match(nsh, /RMDir\s+\/r\s+"\$INSTDIR"/, 'must RMDir /r the old install dir');
});

test('clears old uninstall registry values so the built-in old-uninstall step is skipped', () => {
  assert.match(nsh, /DeleteRegValue\s+SHELL_CONTEXT\s+"\$\{UNINSTALL_REGISTRY_KEY\}"\s+UninstallString/);
  assert.match(nsh, /DeleteRegValue\s+SHELL_CONTEXT\s+"\$\{UNINSTALL_REGISTRY_KEY\}"\s+QuietUninstallString/);
});

test('wipe is guarded to our own install directories only', () => {
  // requires resources\app marker
  assert.match(nsh, /resources\\app/);
  // requires a product marker (product exe or uninstaller)
  assert.match(nsh, /Deepseek Harness EAC\.exe/);
  // requires the directory itself to be named like the product (never a
  // shared parent folder), accepting legacy versioned names
  assert.match(nsh, /Deepseek Harness EAC( v[0-9.]+)?/);
  // refuses short paths (drive roots / program-files roots)
  assert.match(nsh, /StrLen\s+\$\d\s+"\$INSTDIR"/);
});

test('long-path-safe fallback via robocopy mirror exists', () => {
  assert.match(nsh, /robocopy/i);
  assert.match(nsh, /\/MIR/i);
});

test('process termination + dialog-free wait behavior survives', () => {
  assert.match(nsh, /taskkill\s+\/F\s+\/T\s+\/IM\s+"Deepseek Harness EAC\.exe"/);
  assert.match(nsh, /customCheckAppRunning/);
});

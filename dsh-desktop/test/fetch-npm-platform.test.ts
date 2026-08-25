import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBundledNpm } from '../scripts/fetch-npm.js';

function npmFixture(root: string): void {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'npm-cli.js'), '');
}

test('findBundledNpm supports npm next to the Node executable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fetch-npm-adjacent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nodeExe = join(root, 'node.exe');
  writeFileSync(nodeExe, '');
  const npmRoot = join(root, 'node_modules', 'npm');
  npmFixture(npmRoot);

  assert.equal(findBundledNpm(nodeExe), npmRoot);
});

test('findBundledNpm supports the setup-node POSIX lib layout', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fetch-npm-posix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nodeExe = join(root, 'bin', 'node');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(nodeExe, '');
  const npmRoot = join(root, 'lib', 'node_modules', 'npm');
  npmFixture(npmRoot);

  assert.equal(findBundledNpm(nodeExe), npmRoot);
});

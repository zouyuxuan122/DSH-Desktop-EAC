// TDD tests for the release freshness guard (v2.0.3 incident).
//
// v2.0.3 was published from artifacts built BEFORE the last source changes
// (after-pack edits at 20:52, installer.nsh commit at 22:31, artifacts built
// at 20:35, uploaded 22:33+). Users received an installer with the OLD
// installer logic and untrimmed deep paths — the root cause of issue #7.
//
// verifyDistFresh compares every tracked source file's mtime against the
// packaged artifacts' mtime and refuses (exit 1 in CLI mode) when any source
// is newer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDistFresh } from '../scripts/verify-dist-fresh.js';

const T0 = new Date('2026-08-15T12:00:00Z');
const T1 = new Date('2026-08-15T13:00:00Z'); // artifact built
const T2 = new Date('2026-08-15T14:00:00Z'); // source edited after build

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fresh-'));
  const touch = (p, files, t) => {
    mkdirSync(join(root, p), { recursive: true });
    for (const f of files) {
      const fp = join(root, p, f);
      writeFileSync(fp, 'x');
      utimesSync(fp, t, t);
    }
  };
  touch('src', ['main.js'], T0);
  touch('build', ['installer.nsh'], T0);
  touch('dist', ['App-Setup-x64.exe', 'App-Portable-x64.exe'], T1);
  return root;
}

test('passes when artifacts are newer than every source file', () => {
  const root = makeRepo();
  try {
    const r = verifyDistFresh(root);
    assert.equal(r.ok, true);
    assert.deepEqual(r.offenders, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails and names the offending file when a source is newer than artifacts', () => {
  const root = makeRepo();
  try {
    utimesSync(join(root, 'build', 'installer.nsh'), T2, T2);
    const r = verifyDistFresh(root);
    assert.equal(r.ok, false);
    assert.ok(r.offenders.some((o) => o.includes('installer.nsh')), 'offender listed, got: ' + JSON.stringify(r.offenders));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores changes under dist/, node_modules/ and vendor/', () => {
  const root = makeRepo();
  try {
    utimesSync(join(root, 'dist', 'App-Setup-x64.exe'), T2, T2);
    mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true });
    const nm = join(root, 'node_modules', 'foo', 'index.js');
    writeFileSync(nm, 'x');
    utimesSync(nm, T2, T2);
    mkdirSync(join(root, 'vendor', 'npm'), { recursive: true });
    const v = join(root, 'vendor', 'npm', 'x.js');
    writeFileSync(v, 'x');
    utimesSync(v, T2, T2);
    const r = verifyDistFresh(root);
    assert.equal(r.ok, true, 'ignored paths must not count, offenders: ' + JSON.stringify(r.offenders));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when no artifacts exist in dist/', () => {
  const root = makeRepo();
  try {
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    const r = verifyDistFresh(root);
    assert.equal(r.ok, false);
    assert.ok(/no .*artifacts/i.test(r.error || ''), 'must report missing artifacts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

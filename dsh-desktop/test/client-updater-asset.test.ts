import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAsset } from '../client-updater.js';

const A = (name, size = 1000) => ({ name, size });

test('selectAsset picks version-less Setup artifact (v2.0.3+ naming)', () => {
  const rel = {
    version: '2.0.3',
    assets: [
      A('Deepseek-Harness-EAC-Setup-x64.exe'),
      A('Deepseek-Harness-EAC-Setup-x64.exe.blockmap'),
      A('Deepseek-Harness-EAC-Portable-x64.exe'),
    ],
  };
  const got = selectAsset(rel);
  assert.equal(got.name, 'Deepseek-Harness-EAC-Setup-x64.exe');
  assert.equal(got.parts.length, 1);
});

test('selectAsset picks versioned Setup artifact (Setup-v<ver>-x64.exe naming)', () => {
  const rel = {
    version: '4.4.1',
    assets: [
      A('Deepseek-Harness-EAC-Setup-v4.4.1-x64.exe'),
      A('Deepseek-Harness-EAC-Setup-v4.4.1-x64.exe.blockmap'),
      A('Deepseek-Harness-EAC-Portable-v4.4.1-x64.exe'),
    ],
  };
  const got = selectAsset(rel);
  assert.equal(got.name, 'Deepseek-Harness-EAC-Setup-v4.4.1-x64.exe');
  assert.equal(got.parts.length, 1);
});

test('selectAsset still picks legacy versioned Portable artifact (<=v2.0.2 naming)', () => {
  const rel = {
    version: '2.0.2',
    assets: [
      A('Deepseek-Harness-EAC-v2.0.2-Setup-x64.exe'),
      A('Deepseek-Harness-EAC-v2.0.2-Portable-x64.exe'),
      A('Deepseek-Harness-EAC-v2.0.2-Portable-x64.exe.blockmap'),
    ],
  };
  process.env.PORTABLE_EXECUTABLE_DIR = 'X:\\somewhere';
  try {
    const got = selectAsset(rel);
    assert.equal(got.name, 'Deepseek-Harness-EAC-v2.0.2-Portable-x64.exe');
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  }
});

test('selectAsset falls back to Gitee-split parts, version-less name first', () => {
  const rel = {
    version: '2.0.3',
    assets: [
      A('Deepseek-Harness-EAC-Setup-x64.exe.part1', 60),
      A('Deepseek-Harness-EAC-Setup-x64.exe.part2', 40),
      A('Deepseek-Harness-EAC-Portable-x64.exe.part1', 60),
      A('Deepseek-Harness-EAC-Portable-x64.exe.part2', 40),
    ],
  };
  const got = selectAsset(rel);
  assert.equal(got.name, 'Deepseek-Harness-EAC-Setup-x64.exe');
  assert.deepEqual(got.parts.map((p) => p.name), [
    'Deepseek-Harness-EAC-Setup-x64.exe.part1',
    'Deepseek-Harness-EAC-Setup-x64.exe.part2',
  ]);
  assert.equal(got.totalSize, 100);
});

test('selectAsset falls back to legacy versioned Gitee-split parts', () => {
  const rel = {
    version: '2.0.2',
    assets: [
      A('Deepseek-Harness-EAC-v2.0.2-Portable-x64.exe.part1', 60),
      A('Deepseek-Harness-EAC-v2.0.2-Portable-x64.exe.part2', 40),
    ],
  };
  process.env.PORTABLE_EXECUTABLE_DIR = 'X:\\somewhere';
  try {
    const got = selectAsset(rel);
    assert.equal(got.name, 'Deepseek-Harness-EAC-v2.0.2-Portable-x64.exe');
    assert.equal(got.parts.length, 2);
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  }
});

test('selectAsset throws when nothing matches', () => {
  assert.throws(() => selectAsset({ version: '9.9.9', assets: [A('totally-unrelated.zip')] }), /未找到匹配/);
});

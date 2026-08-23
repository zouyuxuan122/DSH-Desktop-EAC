import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  runKoffiPreflight,
  buildPickerOverlayContent,
  PICKER_BROWSE_OVERLAY_MARKER,
  enablePickerBrowseOverlay,
  clearAutoPickerBrowseOverlay,
} = require(join(root, 'koffi-preflight.js'));

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-koffi-'));
}

// --- runKoffiPreflight ------------------------------------------------------

test('runKoffiPreflight: 探针退出码 0 → 通过', () => {
  const logs = [];
  const ok = runKoffiPreflight({
    spawnSync: () => ({ status: 0, stdout: 'KOFFI_PREFLIGHT_OK pid=1\n', stderr: '' }),
    nodeExe: 'node.exe',
    script: 'C:/fake/koffi-preflight.cjs',
    existsSync: () => true,
    log: (m) => logs.push(m),
  });
  assert.equal(ok, true);
  assert.ok(logs.some((l) => l.includes('通过')));
});

test('runKoffiPreflight: 探针崩溃（非 0 退出码）→ 失败', () => {
  const logs = [];
  const ok = runKoffiPreflight({
    spawnSync: () => ({ status: 3221225477, stdout: '', stderr: '' }), // 0xC0000005
    nodeExe: 'node.exe',
    script: 'C:/fake/koffi-preflight.cjs',
    existsSync: () => true,
    log: (m) => logs.push(m),
  });
  assert.equal(ok, false);
  assert.ok(logs.some((l) => l.includes('0xc0000005')), '日志应包含十六进制退出码');
});

test('runKoffiPreflight: spawnSync 出错（无法执行）→ 失败', () => {
  const ok = runKoffiPreflight({
    spawnSync: () => ({ error: new Error('ENOENT'), status: null }),
    nodeExe: 'node.exe',
    script: 'C:/fake/koffi-preflight.cjs',
    existsSync: () => true,
    log: () => {},
  });
  assert.equal(ok, false);
});

test('runKoffiPreflight: 探针脚本不存在 → 跳过（视为通过）', () => {
  const logs = [];
  const ok = runKoffiPreflight({
    spawnSync: () => { throw new Error('不应执行'); },
    nodeExe: 'node.exe',
    script: 'C:/missing.cjs',
    existsSync: () => false,
    log: (m) => logs.push(m),
  });
  assert.equal(ok, true);
  assert.ok(logs.some((l) => l.includes('跳过')));
});

// --- overlay 内容 -----------------------------------------------------------

test('buildPickerOverlayContent: 禁用 native directory-picker 并插入 browse 插件', () => {
  const text = buildPickerOverlayContent();
  assert.ok(text.includes(PICKER_BROWSE_OVERLAY_MARKER), '应含自动生成 marker');
  assert.ok(text.includes("- id: directory-picker"), '应禁用 directory-picker');
  assert.ok(text.includes('disabled: true'));
  assert.ok(text.includes("'@deepseek-ai/dsh-host-directory-picker-browse'"), '应插入 host browse 插件');
  assert.ok(text.includes("'@deepseek-ai/dsh-client-ui-directory-picker-browse'"), '应插入 client browse 插件');
});

// --- overlay 文件管理 -------------------------------------------------------

test('enablePickerBrowseOverlay: 写入 overlay 文件且幂等', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'picker-browse.overlay.yml');
    const logs = [];
    let wrote = 0;
    const fakeFs = {
      readFileSync: (p, enc) => { if (!existsSync(p)) throw new Error('ENOENT'); return readFileSync(p, enc); },
      writeFileSync: (p, c) => { wrote += 1; writeFileSync(p, c); },
    };
    const r1 = enablePickerBrowseOverlay({ file, fs: fakeFs, log: (m) => logs.push(m) });
    assert.equal(r1, file);
    assert.ok(existsSync(file));
    assert.ok(readFileSync(file, 'utf8').includes(PICKER_BROWSE_OVERLAY_MARKER));
    assert.equal(wrote, 1);

    // 第二次调用内容相同 → 不重写（幂等）
    const r2 = enablePickerBrowseOverlay({ file, fs: fakeFs, log: () => {} });
    assert.equal(r2, file);
    assert.equal(wrote, 1, '内容相同不应重写');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearAutoPickerBrowseOverlay: 只删除自动生成的 overlay，不动用户文件', () => {
  const dir = tmp();
  try {
    // 自动 overlay → 删除
    const auto = join(dir, 'picker-browse.overlay.yml');
    writeFileSync(auto, buildPickerOverlayContent());
    const removed = clearAutoPickerBrowseOverlay({ file: auto, fs, log: () => {} });
    assert.equal(removed, true);
    assert.ok(!existsSync(auto));

    // 用户自建同路径文件（无 marker）→ 保留
    const user = join(dir, 'picker-browse.overlay.yml');
    writeFileSync(user, '# 用户手工维护的 overlay\n- id: something\n');
    const kept = clearAutoPickerBrowseOverlay({ file: user, fs, log: () => {} });
    assert.equal(kept, false);
    assert.ok(existsSync(user), '用户文件不应被删除');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearAutoPickerBrowseOverlay: 文件不存在时安全返回', () => {
  const dir = tmp();
  try {
    const r = clearAutoPickerBrowseOverlay({ file: join(dir, 'none.yml'), fs, log: () => {} });
    assert.equal(r, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

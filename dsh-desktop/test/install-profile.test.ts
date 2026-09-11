import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// 安装形态（v5.4 单发行版双形态）：精简版默认停用集合 + 标记文件读取。
// 约束见 lib/desktop/install-profile.ts 注释 —— 集合必须是配套插件子集，
// 不得命中核心组（核心组锁定停用路径）。

const require = createRequire(import.meta.url);
const { readInstallProfile, LITE_DEFAULT_DISABLED, PROFILE_MARKER_FILE } = require('../lib/desktop/install-profile.js');
const { COMPANION_PLUGINS } = require('../lib/desktop/companion-sync.js');
const { CORE_PLUGIN_IDS } = require('../scripts/onboarding.js');

test('安装形态标记：缺失/脏值回退 full，lite 正确识别', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-'));
  try {
    assert.equal(readInstallProfile(dir), 'full', '缺省 = full');
    writeFileSync(join(dir, PROFILE_MARKER_FILE), 'full\n');
    assert.equal(readInstallProfile(dir), 'full');
    writeFileSync(join(dir, PROFILE_MARKER_FILE), 'lite\n');
    assert.equal(readInstallProfile(dir), 'lite');
    writeFileSync(join(dir, PROFILE_MARKER_FILE), 'lite \n');
    assert.equal(readInstallProfile(dir), 'lite', '容忍尾随空白');
    writeFileSync(join(dir, PROFILE_MARKER_FILE), 'garbage');
    assert.equal(readInstallProfile(dir), 'full', '脏值回退 full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('精简版停用集合是配套插件子集', () => {
  const ids = new Set(COMPANION_PLUGINS.map((p) => p.id));
  for (const id of LITE_DEFAULT_DISABLED) {
    assert.ok(ids.has(id), `LITE_DEFAULT_DISABLED 含未知配套插件 id: ${id}`);
  }
});

test('精简版停用集合不命中核心插件组', () => {
  for (const id of LITE_DEFAULT_DISABLED) {
    assert.ok(!CORE_PLUGIN_IDS.has(id), `核心插件不可默认停用: ${id}`);
  }
});

test('精简版集合无重复且保持可读数量', () => {
  assert.equal(new Set(LITE_DEFAULT_DISABLED).size, LITE_DEFAULT_DISABLED.length, '集合无重复');
  // 精简 ≠ 砍光：默认停用不得超过配套插件的一半。
  assert.ok(
    LITE_DEFAULT_DISABLED.length <= COMPANION_PLUGINS.length / 2,
    `精简集过大：${LITE_DEFAULT_DISABLED.length}/${COMPANION_PLUGINS.length}`,
  );
});

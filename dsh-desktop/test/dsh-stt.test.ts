import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  COMPANION_PLUGINS,
  RETIRED_BUILTIN_PLUGINS,
} from '../lib/desktop/companion-sync.js';
import { pluginCapabilityDetails } from '../lib/desktop/platform.js';

const ROOT = join(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'assets', 'plugins', 'dsh-stt');
const REPO_ROOT = join(ROOT, '..');

function text(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

test('dsh-stt is registered disabled-by-default and removed from the retired list', () => {
  const entry = COMPANION_PLUGINS.find((p) => p.id === 'dsh-stt');
  assert.ok(entry, 'COMPANION_PLUGINS 必须注册 dsh-stt');
  assert.equal(entry.name, '@deepseek-ai/dsh-stt');
  assert.equal(entry.dir, 'dsh-stt');
  assert.equal(entry.disabled, true, '默认禁用：启用后才下载 SenseVoice 模型');

  assert.equal(
    RETIRED_BUILTIN_PLUGINS.some((p) => p.id === 'dsh-stt'),
    false,
    'dsh-stt 恢复内置后不得留在退役清单（启动清理会剥掉注册行与包副本）',
  );
});

test('dsh-stt ASR engine is available on all platforms (installed per-platform at build time)', () => {
  // 0.3.0 起引擎不再 vendored，CI 在各平台 runner 上 npm install 拉取对应
  // sherpa-onnx 原生包（win-x64 / darwin / linux），三平台发行。
  assert.equal(pluginCapabilityDetails('win32')['dsh-stt']?.status, 'supported');
  assert.equal(pluginCapabilityDetails('darwin')['dsh-stt']?.status, 'supported');
  assert.equal(pluginCapabilityDetails('linux')['dsh-stt']?.status, 'supported');
});

test('bundled dsh-stt keeps the host/client contract and the source-split layout', () => {
  const pkg = JSON.parse(text(PLUGIN, 'package.json'));
  assert.equal(pkg.name, '@deepseek-ai/dsh-stt');
  assert.equal(pkg.version, '0.3.0');
  assert.equal(pkg.main, 'src/index.js');
  assert.ok(existsSync(join(PLUGIN, 'src', 'index.js')), 'host 入口必须随包');
  assert.ok(existsSync(join(PLUGIN, 'client.js')), 'client 构建产物必须随包');

  // 源码拆分布局（上游 review 要求：入口组装 + 组件聚合 + 纯逻辑复用）
  assert.ok(existsSync(join(PLUGIN, 'client', 'entry.js')), 'client/entry.js（UI 注入入口）');
  assert.ok(existsSync(join(PLUGIN, 'client', 'components', 'MicButton.js')), 'UI 组件聚合目录');
  assert.ok(existsSync(join(PLUGIN, 'client', 'lib', 'session.js')), '会话编排模块');

  assert.match(text(PLUGIN, 'cordis.patch.yml'), /id:\s*dsh-stt/, 'bundle patch 行声明 dsh-stt');
});

test('engine is NOT vendored; it is installed per-platform via install:plugin-engines', () => {
  // 引擎（sherpa-onnx 原生二进制）不入库：依赖声明保留，node_modules 由
  // CI 在各平台构建时安装（node scripts/install-plugin-engines.mjs，位于
  // 测试/staging 之前，故测试运行时 node_modules 可能已存在——入库与否由
  // gitignore 决定，这里用 git check-ignore 验证引擎路径确实被忽略）。
  const pkg = JSON.parse(text(PLUGIN, 'package.json'));
  assert.equal(pkg.dependencies['sherpa-onnx-node'], '^1.13.6', '引擎运行时依赖声明');

  const probe = join('assets', 'plugins', 'dsh-stt', 'node_modules', 'sherpa-onnx-node', 'package.json');
  const { status: ignoredStatus } = spawnSync('git', ['check-ignore', '-q', probe.replace(/\\/g, '/')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(ignoredStatus, 0, `引擎路径必须被 gitignore 忽略（不入库）: ${probe}`);

  // CI 守护：每个构建 workflow 都必须在测试/staging 前安装引擎依赖
  const workflows = [
    join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
    join(REPO_ROOT, '.github', 'workflows', 'release-tauri.yml'),
    join(REPO_ROOT, '.github', 'workflows', 'release-macos.yml'),
  ];
  for (const wf of workflows) {
    assert.match(text(wf), /npm run install:plugin-engines/, `workflow 缺少引擎安装步骤: ${wf.split(/[\\/]/).pop()}`);
  }
});

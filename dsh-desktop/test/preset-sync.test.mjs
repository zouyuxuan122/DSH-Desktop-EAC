import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { syncBundledPresets, ensureDefaultAgentPreset } = require(join(root, 'preset-sync.js'));

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-preset-sync-'));
}

function fakeAssets(dir, names) {
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  for (const n of names) {
    mkdirSync(join(assets, n), { recursive: true });
    writeFileSync(join(assets, n, 'preset.yml'), 'name: ' + n + '\n');
    writeFileSync(join(assets, n, 'agent.cordis.yml'), '[]\n');
  }
  return assets;
}

// --- syncBundledPresets ------------------------------------------------------

test('syncBundledPresets: 安装全部内置 preset，二次运行全部 kept（幂等不覆盖）', () => {
  const dir = tmp();
  try {
    const assets = fakeAssets(dir, ['anchored-standard', 'router-standard']);
    const presetsRoot = join(dir, '.agent-presets');
    const first = syncBundledPresets(assets, presetsRoot);
    assert.deepEqual(first.installed.sort(), ['anchored-standard', 'router-standard']);
    assert.ok(existsSync(join(presetsRoot, 'anchored-standard', 'agent.cordis.yml')));
    // 用户改过的副本优先：预置一个已存在目录
    writeFileSync(join(presetsRoot, 'anchored-standard', 'user-edit.txt'), 'keep me');
    const second = syncBundledPresets(assets, presetsRoot);
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.kept.sort(), ['anchored-standard', 'router-standard']);
    assert.ok(existsSync(join(presetsRoot, 'anchored-standard', 'user-edit.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncBundledPresets: 没有 preset.yml 的目录不是 preset，被忽略', () => {
  const dir = tmp();
  try {
    const assets = join(dir, 'assets');
    mkdirSync(join(assets, 'not-a-preset'), { recursive: true });
    const r = syncBundledPresets(assets, join(dir, '.agent-presets'));
    assert.deepEqual(r.installed, []);
    assert.ok(!existsSync(join(dir, '.agent-presets', 'not-a-preset')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncBundledPresets: assets 目录不存在时安全返回', () => {
  const dir = tmp();
  try {
    const r = syncBundledPresets(join(dir, 'missing'), join(dir, '.agent-presets'));
    assert.deepEqual(r, { installed: [], kept: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncBundledPresets: _preset 共享目录随 preset 一起同步（whoami/zero-anchored 依赖 ../_preset/*.mjs）', () => {
  const dir = tmp();
  try {
    const assets = join(dir, 'assets');
    mkdirSync(join(assets, '_preset'), { recursive: true });
    writeFileSync(join(assets, '_preset', 'instruction-hint.mjs'), '// shared\n');
    mkdirSync(join(assets, 'whoami-standard'), { recursive: true });
    writeFileSync(join(assets, 'whoami-standard', 'preset.yml'), 'name: whoami\n');
    writeFileSync(join(assets, 'whoami-standard', 'agent.cordis.yml'), "name: ../_preset/instruction-hint.mjs\n");
    const presetsRoot = join(dir, '.agent-presets');
    syncBundledPresets(assets, presetsRoot);
    assert.ok(existsSync(join(presetsRoot, '_preset', 'instruction-hint.mjs')),
      '_preset shared dir must be installed next to presets');
    // 幂等：用户改过的 _preset 不被覆盖
    writeFileSync(join(presetsRoot, '_preset', 'user-note.txt'), 'keep');
    syncBundledPresets(assets, presetsRoot);
    assert.ok(existsSync(join(presetsRoot, '_preset', 'user-note.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- ensureDefaultAgentPreset ------------------------------------------------

function presetDir(home, id = 'anchored-standard') {
  mkdirSync(join(home, '.agent-presets', id), { recursive: true });
  writeFileSync(join(home, '.agent-presets', id, 'preset.yml'), 'name: x\n');
}

test('ensureDefaultAgentPreset: settings.yaml 缺失时追加顶层 section', () => {
  const dir = tmp();
  try {
    presetDir(dir);
    assert.equal(ensureDefaultAgentPreset(dir, 'anchored-standard'), 'set');
    const text = readFileSync(join(dir, 'settings.yaml'), 'utf8');
    assert.match(text, /agent-presets:\r?\n  default: anchored-standard/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDefaultAgentPreset: 已有块状 section 缺 default 时紧随插入', () => {
  const dir = tmp();
  try {
    presetDir(dir);
    writeFileSync(join(dir, 'settings.yaml'), 'llm:\n  provider: deepseek\nagent-presets:\n  order: [a]\nweb:\n  port: 1\n');
    assert.equal(ensureDefaultAgentPreset(dir, 'anchored-standard'), 'set');
    const lines = readFileSync(join(dir, 'settings.yaml'), 'utf8').split(/\r?\n/);
    const idx = lines.findIndex((l) => /^agent-presets:/.test(l));
    assert.match(lines[idx + 1], /^\s+default: anchored-standard/);
    // 后面的 section 不受影响
    assert.ok(lines.some((l) => /^web:/.test(l)));
    assert.ok(lines.some((l) => /^\s+order: \[a\]/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDefaultAgentPreset: 用户已写 default（任意值）一律保留', () => {
  const dir = tmp();
  try {
    presetDir(dir);
    const before = 'agent-presets:\n  default: minimal\n';
    writeFileSync(join(dir, 'settings.yaml'), before);
    assert.equal(ensureDefaultAgentPreset(dir, 'anchored-standard'), 'kept');
    assert.equal(readFileSync(join(dir, 'settings.yaml'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDefaultAgentPreset: 内联 flow / 指名的 preset 不存在 → skipped 不写文件', () => {
  const dir = tmp();
  try {
    const inline = 'agent-presets: { default: minimal }\n';
    writeFileSync(join(dir, 'settings.yaml'), inline);
    assert.equal(ensureDefaultAgentPreset(dir, 'anchored-standard'), 'skipped');
    assert.equal(readFileSync(join(dir, 'settings.yaml'), 'utf8'), inline);

    const dir2 = tmp();
    try {
      // 无 preset 目录
      assert.equal(ensureDefaultAgentPreset(dir2, 'anchored-standard'), 'skipped');
      assert.ok(!existsSync(join(dir2, 'settings.yaml')));
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDefaultAgentPreset: BOM 与 CRLF 被保留', () => {
  const dir = tmp();
  try {
    presetDir(dir);
    writeFileSync(join(dir, 'settings.yaml'), '\uFEFFllm:\r\n  provider: deepseek\r\n');
    assert.equal(ensureDefaultAgentPreset(dir, 'anchored-standard'), 'set');
    const text = readFileSync(join(dir, 'settings.yaml'), 'utf8');
    assert.equal(text.charCodeAt(0), 0xFEFF, 'BOM 保留');
    assert.ok(text.includes('\r\n'), 'CRLF 保留');
    assert.match(text, /agent-presets:\r\n  default: anchored-standard\r\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 打包完整性防回归 ---------------------------------------------------------

test('内置 preset 目录完整：三个 preset 均带 preset.yml 与组合文件', () => {
  const assetsRoot = join(root, 'assets', 'agent-presets');
  for (const name of ['anchored-standard', 'router-standard', 'minimal-gitbash']) {
    const dir = join(assetsRoot, name);
    assert.ok(existsSync(join(dir, 'preset.yml')), name + ' 缺 preset.yml');
    const yml = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8');
    assert.ok(yml.trim().length > 0, name + ' 的 agent.cordis.yml 为空');
  }
  // 组合文件引用的本地 .mjs 必须随包存在（loader 不容忍缺文件）
  for (const name of ['anchored-standard', 'router-standard', 'minimal-gitbash']) {
    const dir = join(assetsRoot, name);
    const yml = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8');
    for (const m of yml.matchAll(/name:\s*'(\.\/[^']+)'/g)) {
      assert.ok(existsSync(join(dir, m[1])), name + ' 引用的 ' + m[1] + ' 缺失');
    }
  }
});

test('上游新增 preset 完整：目录自包含或引用的 ../_preset 共享件随包存在', () => {
  const assetsRoot = join(root, 'assets', 'agent-presets');
  const upstream = ['minimal-win', 'whoami-standard', 'zero-anchored-standard', 'warmupbetter', 'warmupbetter-replay', 'v4-flash-godmode-opencode-go'];
  for (const name of upstream) {
    const dir = join(assetsRoot, name);
    assert.ok(existsSync(join(dir, 'preset.yml')), name + ' 缺 preset.yml（未从上游同步）');
    const yml = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8');
    for (const m of yml.matchAll(/name:\s*'([^']+)'/g)) {
      const ref = m[1];
      if (ref.startsWith('./')) {
        assert.ok(existsSync(join(dir, ref)), name + ' 引用的 ' + ref + ' 缺失');
      } else if (ref.startsWith('../_preset/')) {
        assert.ok(existsSync(join(assetsRoot, '_preset', ref.slice('../_preset/'.length))),
          name + ' 引用的共享件 ' + ref + ' 缺失（_preset 未同步）');
      }
    }
  }
});

test('electron-builder files 包含 preset-sync.js（否则新模块不进安装包）', () => {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /- preset-sync\.js/);
});

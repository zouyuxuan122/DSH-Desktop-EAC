import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { patchAgentPresetMenu } = require('../scripts/patch-deps.js');

// 模拟未补丁的 dsh-client-ui-agent-preset/lib/client.js：只保留补丁锚点结构
// （items 构建 + selectedId 行 + 词典键），缩进与真实编译产物一致（tab）。
const FAKE_UNPATCHED = [
  'const en = {',
  '\t\t\tpresetCordisName: "Creator mode",',
  '};',
  'const zh = {',
  '\t\t\tpresetCordisName: "创造模式",',
  '};',
  'function AgentPresetSeat() {',
  '  return {',
  '\t\t\t\titems: state.options.map((option) => {',
  '\t\t\t\t\tconst text = presetDisplayText(option, t);',
  '\t\t\t\t\treturn { id: option.id, label: text.name };',
  '\t\t\t\t}),',
  '\t\t\t\tselectedId: state.current,',
  '  };',
  '}',
  'function PresetMenu() {',
  '  return {',
  '\t\t\t\titems: options.map((option) => {',
  '\t\t\t\t\tconst name = presetDisplayText(option, t).name;',
  '\t\t\t\t\treturn { id: option.id, label: option.trust === "user" ? `${name} · ${t("userTrust")}` : name };',
  '\t\t\t\t}),',
  '\t\t\t\tselectedId,',
  '  };',
  '}',
].join('\n');

function withFakeFile(content = FAKE_UNPATCHED) {
  const dir = mkdtempSync(join(tmpdir(), 'preset-patch-'));
  const file = join(dir, 'client.js');
  writeFileSync(file, content);
  return { dir, file };
}

test('patchAgentPresetMenu 把 user trust 的 preset 收进「第三方模式」submenu', () => {
  const { dir, file } = withFakeFile();
  try {
    assert.equal(patchAgentPresetMenu(file), true);
    const src = readFileSync(file, 'utf8');
    assert.match(src, /dsh-desktop:third-party/, '幂等 marker 已写入');
    assert.match(src, /option\.trust !== "user"/, '主列表过滤掉自定义预设');
    assert.equal(src.match(/submenu:/g)?.length, 2, 'seat 与设置行各一个 submenu');
    assert.match(src, /"menu\.thirdPartyMode": "第三方模式"/, '中文词典注入');
    assert.match(src, /"menu\.thirdPartyMode": "Third-party modes"/, '英文词典注入');
    assert.match(src, /t\("menu\.thirdPartyMode"\)/, '菜单项引用新词典 key');
    // 设置行的第三方子项不再带「· 自定义」后缀（submenu 项直接 label: name）
    assert.match(src, /submenu: user\.map\(\(option\) => \{\s*\n\s*const name = presetDisplayText\(option, t\)\.name;\s*\n\s*return \{ id: option\.id, label: name \};/, 'submenu 项用纯 name');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patchAgentPresetMenu 幂等：二次应用跳过且内容不变', () => {
  const { dir, file } = withFakeFile();
  try {
    assert.equal(patchAgentPresetMenu(file), true);
    const once = readFileSync(file, 'utf8');
    assert.equal(patchAgentPresetMenu(file), true, '已应用后仍返回成功（跳过）');
    assert.equal(readFileSync(file, 'utf8'), once, '内容不被二次修改');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patchAgentPresetMenu 锚点失配时跳过且不改文件', () => {
  const { dir, file } = withFakeFile('// 上游大改版，没有 items 锚点\n');
  try {
    assert.equal(patchAgentPresetMenu(file), false);
    assert.equal(readFileSync(file, 'utf8'), '// 上游大改版，没有 items 锚点\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

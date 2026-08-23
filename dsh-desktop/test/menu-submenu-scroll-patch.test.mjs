import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { patchMenuSubmenuScroll } = require('../scripts/patch-deps.js');

// 模拟未补丁的 dsh-client-ui-primitives/lib/index.js：只保留 Menu submenu 容器
// 的锚点结构（submenu 类名行 + 紧随其后的 role 行，缩进与真实编译产物一致）。
const FAKE_UNPATCHED = [
  'function Menu() {',
  '  return {',
  '\t\t\t\tclassName: clsx(Menu_module_css_default.submenu, compact && Menu_module_css_default.compactList),',
  '\t\t\t\trole: "menu",',
  '\t\t\t\tchildren: entry.submenu.map((sub) => ...)',
  '  };',
  '}',
].join('\n');

function withFakeFile(content = FAKE_UNPATCHED) {
  const dir = mkdtempSync(join(tmpdir(), 'submenu-scroll-'));
  const file = join(dir, 'index.js');
  writeFileSync(file, content);
  return { dir, file };
}

test('patchMenuSubmenuScroll 给 submenu 容器注入 max-height + overflow-y', () => {
  const { dir, file } = withFakeFile();
  try {
    assert.equal(patchMenuSubmenuScroll(file), true);
    const src = readFileSync(file, 'utf8');
    assert.match(src, /dsh-desktop:menu-submenu-scroll/, '幂等 marker 已写入');
    assert.match(src, /style: \{ maxHeight: "min\(50vh, 24rem\)", overflowY: "auto" \},/, '内联滚动样式注入');
    // 注入行的缩进应与 role 行一致
    const roleLine = src.split('\n').find((l) => l.includes('role: "menu",'));
    const styleLine = src.split('\n').find((l) => l.includes('maxHeight'));
    assert.equal(styleLine.split('style')[0], roleLine.split('role')[0], '缩进与 role 行一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patchMenuSubmenuScroll 幂等：二次应用跳过且内容不变', () => {
  const { dir, file } = withFakeFile();
  try {
    assert.equal(patchMenuSubmenuScroll(file), true);
    const once = readFileSync(file, 'utf8');
    assert.equal(patchMenuSubmenuScroll(file), true, '已应用后仍返回成功（跳过）');
    assert.equal(readFileSync(file, 'utf8'), once, '内容不被二次修改');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patchMenuSubmenuScroll 锚点失配时跳过且不改文件', () => {
  const { dir, file } = withFakeFile('// 上游大改版，没有 submenu 锚点\n');
  try {
    assert.equal(patchMenuSubmenuScroll(file), false);
    assert.equal(readFileSync(file, 'utf8'), '// 上游大改版，没有 submenu 锚点\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

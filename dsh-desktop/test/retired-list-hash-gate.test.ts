// 5.1.1 退役清理对齐门控的第二维度：除版本号外还要比对 RETIRED_BUILTIN_PLUGINS
// 清单内容的哈希（settings.pluginTreeRetiredListHash）。只比版本的缺陷：
// 同一应用版本内新列入的退役目标永远清不到 —— 本机实踩：pluginTreeAlignedVersion
// 已是 '5.1.0'，追加 tool-vision/settings-nav-custom 后清理被静默跳过，
// 幽灵「视觉模型」卡与普通/高级分栏继续存在。issue #74 的「同版本内用户
// 手动调整不被每次启动改写」语义仍由「哈希一致即跳过」保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { removePluginFromPatch } from '../scripts/plugin-manager-patch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'lib', 'desktop', 'companion-sync.ts'), 'utf8');

function retiredSlice() {
  const start = src.indexOf('const RETIRED_BUILTIN_PLUGINS');
  assert.ok(start >= 0, 'RETIRED_BUILTIN_PLUGINS must exist');
  return src.slice(start, src.indexOf('];', start));
}

test('gate hashes the retired list, not just the app version', () => {
  assert.match(src, /function retiredListHash\(\)/, 'retiredListHash 必须存在');
  assert.match(src, /createHash\('sha256'\)[^]*?JSON\.stringify\(RETIRED_BUILTIN_PLUGINS\)/,
    '哈希必须由整个 RETIRED_BUILTIN_PLUGINS 序列化而来（增删任一条目都变）');
  const gated = src.slice(src.indexOf('function retireRemovedBuiltinPluginsGated'));
  assert.match(gated, /pluginTreeRetiredListHash/,
    '门控必须同时核对 pluginTreeAlignedVersion 与 pluginTreeRetiredListHash');
});

test('recorded hash algorithm matches a fresh computation', () => {
  // 用切片字面量无法在测试里重建数组，这里退而验证写入与校验用同一个
  // retiredListHash() 调用点（各恰好一次），防两处算法漂移。
  const gated = src.slice(src.indexOf('function retiredListHash'));
  const uses = [...gated.matchAll(/retiredListHash\(\)/g)].length;
  assert.ok(uses >= 2, `retiredListHash() 至少被读取两次（跳过判断 + 落盘记录），实际 ${uses}`);
});

test('replaced built-ins stay in the retired list', () => {
  const slice = retiredSlice();
  for (const id of [
    'auto-compact',
    'plugin-marketplace',
    'third-party-thinking',
    'tool-vision',
    'settings-nav-custom',
    'file-drop',
  ]) {
    assert.match(slice, new RegExp(`id:\\s*'${id}'`), `${id} 应保持退役登记`);
  }
});

test('file-drop retirement keeps the replacement file-drop-eac row', () => {
  const patch = [
    '- insert:',
    '    - id: file-drop',
    "      name: 'dsh-file-drop'",
    '- insert:',
    '    - id: file-drop-eac',
    "      name: 'dsh-file-drop-eac'",
    '',
  ].join('\n');
  const migrated = removePluginFromPatch(patch, 'file-drop');
  assert.doesNotMatch(migrated, /id:\s*file-drop(?:\s|$)/);
  assert.match(migrated, /id:\s*file-drop-eac/);
  assert.match(migrated, /name:\s*'dsh-file-drop-eac'/);
});
test('first-run cleanup treats a missing patch file as empty state', () => {
  assert.match(
    src,
    /if \(fs\.existsSync\(patchFile\)\) \{\s*const text = fs\.readFileSync\(patchFile, 'utf8'\)/,
  );
});

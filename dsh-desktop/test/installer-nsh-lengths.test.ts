import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 防呆（v3.0.0 升级弹窗 "Failed to uninstall old application files: 2" 根因）：
// installer.nsh 的 customInit 用「取路径尾部 N 字符再与字面量比较」判断
// $INSTDIR 是否以产品目录名结尾（dshTakeoverWipe / nested-dir heal）。
// "\Deepseek Harness EAC" 是 21 字符，而 StrCpy 用了 -22，取出的串多带
// 父目录名末字符，比较永不相等 → 接管清理从不触发 → 升级时仍执行旧
// 卸载器 → 旧卸载器 closeApp bug 弹 ": 2"。
// 本测试静态扫描所有 `StrCpy $R $INSTDIR "" -N` + 后续 `${If} $R == "..."}`
// 比较，断言每个参与比较的字面量长度恰好等于 N。

const nsh = fs.readFileSync(join(root, 'build', 'installer.nsh'), 'utf8');
const lines = nsh.split(/\r?\n/);

function checkTailCompareBlocks() {
  const problems = [];
  // 找到所有 StrCpy $X $INSTDIR "" -N，扫描其后 12 行内的 == 字面量比较
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/StrCpy\s+\$(\w+)\s+\$INSTDIR\s+""\s+-(\d+)/);
    if (!m) continue;
    const reg = '$' + m[1];
    const n = Number(m[2]);
    // 收集其后 12 行里与同一寄存器比较的字符串字面量
    let literals = [];
    for (let j = i + 1; j < Math.min(i + 13, lines.length); j++) {
      const cm = lines[j].match(new RegExp('\\$' + m[1] + '\\s+==\\s+"([^"]*)"'));
      if (cm) literals.push(cm[1]);
      // 遇到对同一寄存器的新 StrCpy 赋值则停止（上一个截取的比较块结束）
      if (new RegExp('StrCpy\\s+\\$' + m[1] + '\\b').test(lines[j])) break;
    }
    if (literals.length === 0) continue; // 非比较用途的 StrCpy，不检查
    for (const lit of literals) {
      if (lit.length !== n) {
        problems.push(
          `行 ${i + 1}: StrCpy ${reg} $INSTDIR "" -${n}，但比较字面量 "${lit}" 长度为 ${lit.length}（${lit.length > n ? '长于' : '短于'} N，比较永不匹配）`
        );
      }
    }
  }
  return problems;
}

test('installer.nsh：尾部截取长度 N 必须与所有比较字面量的长度一致', () => {
  const problems = checkTailCompareBlocks();
  assert.deepEqual(problems, [],
    '发现长度不匹配（升级接管逻辑会静默失效）:\n' + problems.join('\n'));
});

test('installer.nsh：产品主目录名 "\Deepseek Harness EAC" 的截取长度正确（21）', () => {
  // 直接验证主名分支存在且长度正确
  const hasMain = /StrCpy\s+\$(\w+)\s+\$INSTDIR\s+""\s+-21\b/.test(nsh);
  assert.ok(hasMain, '应存在 -21 截取（"\Deepseek Harness EAC" 共 21 字符）');
  const comp = nsh.match(/\$\w+\s+==\s+"\\Deepseek Harness EAC"/);
  assert.ok(comp, '应存在与 "\\Deepseek Harness EAC" 的比较');
});

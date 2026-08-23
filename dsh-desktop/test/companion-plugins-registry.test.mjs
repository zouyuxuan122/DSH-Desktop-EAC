// 锁死「assets/plugins 目录 ↔ main.js COMPANION_PLUGINS 注册」双向一致。
//
// 背景（Bug #58 排查中发现的两起同类事故）：
//   · dsh-settings-groups 注册行丢失 → 侧边栏「普通/高级」分组整条功能
//     静默失效（用户看到的是平铺列表，无「高级」可折叠）；
//   · dsh-plugin-marketplace 自 v2.0 被替换下架后未再登记，而 v4.3 又在其
//     上重建「内置插件上游更新」标签页（dsh:plugin-updates IPC 唯一消费
//     者）→ 更新链路静默死亡。
// 两者的包目录与功能代码都随包分发，唯独缺一行注册 —— 无任何报错，只能
// 靠用户感知。本测试让这类丢失在 CI 直接红。
//
// V4.6 架构现状：settings-groups 仍是活插件（V4.6.1 起只负责常规页页内
// 折叠，侧边栏归 nav-custom 单一写者），必须保持注册；plugin-marketplace
// 则已被 dsh-unified-market 取代并列入 RETIRED_BUILTIN_PLUGINS（启动时清
// 理残留）—— 守卫方向相反：它绝不能回到 COMPANION_PLUGINS，否则与统一市
// 场重复注册 /api/dsh-market，dsh web 直接以退出码 1 崩溃。
//
// 注意：匹配只看 COMPANION_PLUGINS 数组切片；RETIRED_BUILTIN_PLUGINS 等
// 其他清单里的同名行不算数（那正是 auto-compact 该待的地方）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// ADR 0002：COMPANION_PLUGINS / RETIRED_BUILTIN_PLUGINS 已迁至 L2 模块。
const main = readFileSync(join(root, 'lib', 'desktop', 'companion-sync.ts'), 'utf8');

function companionSlice() {
  const start = main.indexOf('const COMPANION_PLUGINS');
  assert.ok(start >= 0, 'COMPANION_PLUGINS must exist in lib/desktop/companion-sync.ts');
  const end = main.indexOf('];', start);
  assert.ok(end > start, 'COMPANION_PLUGINS array must be closed');
  return main.slice(start, end);
}

// 有 package.json 但明确不随 COMPANION_PLUGINS 分发的目录（退役等）。
const EXCEPTIONS = new Set([
  'dsh-auto-compact', // 已退役，见 RETIRED_BUILTIN_PLUGINS
]);

test('every vendored plugin dir is registered in COMPANION_PLUGINS', () => {
  const pluginsDir = join(root, 'assets', 'plugins');
  const dirs = readdirSync(pluginsDir)
    .filter((d) => existsSync(join(pluginsDir, d, 'package.json')))
    .sort();
  const slice = companionSlice();
  const missing = [];
  for (const d of dirs) {
    if (EXCEPTIONS.has(d)) continue;
    let name = d;
    try {
      name = JSON.parse(readFileSync(join(pluginsDir, d, 'package.json'), 'utf8')).name || d;
    } catch { /* 包损坏时退回目录名，仍参与检查 */ }
    const byDir = slice.includes(`dir: '${d}'`);
    const byName = slice.includes(`name: '${name}'`);
    if (!byDir && !byName) missing.push(`${d} (${name})`);
  }
  assert.deepEqual(missing, [], '未注册的插件目录 —— 补 COMPANION_PLUGINS 行或加入 EXCEPTIONS 并说明理由');
});

test('every registration row with dir points at a real vendored package', () => {
  const slice = companionSlice();
  const rows = [...slice.matchAll(/dir:\s*'([^']+)'/g)].map((m) => m[1]);
  const bad = rows.filter((d) => !existsSync(join(root, 'assets', 'plugins', d, 'package.json')));
  assert.deepEqual(bad, [], '注册行指向不存在的插件目录');
});

test('regression: settings-groups stays registered, retired marketplace never returns', () => {
  const slice = companionSlice();
  assert.match(slice, /id:\s*'settings-groups'/, '侧边栏普通/高级分组（Bug #58）—— V4.6.1 起负责常规页页内折叠');
  const retiredStart = main.indexOf('const RETIRED_BUILTIN_PLUGINS');
  assert.ok(retiredStart >= 0, 'RETIRED_BUILTIN_PLUGINS must exist in lib/desktop/companion-sync.ts');
  const retiredSlice = main.slice(retiredStart, main.indexOf('];', retiredStart));
  assert.match(retiredSlice, /id:\s*'plugin-marketplace'/,
    '旧插件市场必须保持退役 —— 复活会与 dsh-unified-market 重复注册 /api/dsh-market（dsh web 退出码 1）');
});

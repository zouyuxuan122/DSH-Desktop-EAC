// TDD acceptance tests for bundling the upstream dsh-better-sidebar plugin
// (VSCode-like right sidebar: explorer / editor / terminal / git views).
//
// Distribution model (same as dsh-tool-vision & friends):
//   - plugin package vendored under assets/plugins/dsh-better-sidebar
//     (prebuilt lib/, no TS sources needed at runtime)
//   - registered in COMPANION_PLUGINS so syncCompanionPlugins copies it into
//     the web profile node_modules and mounts it via the overlay patch row
//   - its only server-side dependency outside the app closure (schemastery)
//     must be declared in package.json so the fallback junctions can serve it

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PLUGIN = join(ROOT, 'assets', 'plugins', 'dsh-better-sidebar');

test('dsh-better-sidebar plugin package is vendored with prebuilt lib', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-better-sidebar');
  assert.ok(existsSync(join(PLUGIN, 'lib', 'index.js')), 'server entry lib/index.js missing');
  assert.ok(existsSync(join(PLUGIN, 'lib', 'client-registry.js')), 'client entry missing');
  assert.ok(existsSync(join(PLUGIN, 'LICENSE')), 'LICENSE must ship with the plugin');
});

test('dsh-better-sidebar server entry only requires deps available in the app closure', () => {
  const src = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
  const specs = [...src.matchAll(/from\s+["']([^"'.][^"']*)["']/g)].map((m) => m[1]);
  const external = specs.filter((s) => !s.startsWith('node:'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const closure = new Set([
    ...Object.keys(pkg.dependencies || {}),
    'ws', 'node-pty', 'clsx', // transitive deps already vendored in the closure
  ]);
  for (const s of external) {
    const ok = closure.has(s) || s.startsWith('@deepseek-ai/');
    assert.ok(ok, `lib/index.js imports "${s}" which is not in the app closure`);
  }
});

test('schemastery (the plugin\'s only missing server dep) is declared', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies && pkg.dependencies.schemastery,
    'schemastery must be in dependencies for fallback junction resolution');
});

test('desktop profile initialization resolves the DSH home before linking schemastery', () => {
  // ADR 0002：实现迁至 lib/desktop/profile（L2 业务服务层；Wave 1 起 .ts 为源）。
  const src = readFileSync(join(ROOT, 'lib', 'desktop', 'profile.ts'), 'utf8');
  const start = src.indexOf('function ensureDesktopProfileInit()');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  assert.match(body, /const home = ctx\.getDshHome\(\) \|\| path\.join\(os\.homedir\(\), '\.dsh'\)/,
    'ensureDesktopProfileInit must define home before path.join(home, ...)');
  assert.match(body, /path\.join\(home, 'profiles', 'node_modules'\)/);
});

// issue #14 / zcode 报告：app 层声明不足以让 fallback 闭包（BFS 起点是
// 捆绑的 dsh 包 package.json）包含 schemastery → 全新安装后
// profiles/node_modules 永远缺 junction → dsh web 启动即崩（退出码 1）。
// after-pack 必须把闭包外依赖注入 dsh 包声明，BFS 才能在每次启动时
// 幂等维护 junction。
test('after-pack injects closure-unreachable deps into the bundled dsh package', () => {
  const afterPack = readFileSync(join(ROOT, 'scripts', 'after-pack.js'), 'utf8');
  assert.match(afterPack, /injectDshClosureExtras/,
    'afterPack must call injectDshClosureExtras');
  assert.match(afterPack, /injectDshClosureExtras\(appOutDir\)/,
    'injectDshClosureExtras must run in the afterPack hook');
  assert.match(afterPack, /'schemastery'/,
    'schemastery must be in the injection list');
});

test('COMPANION_PLUGINS registers dsh-better-sidebar', () => {
  // ADR 0002：注册表迁至 lib/desktop/companion-sync.js。
  const mainSrc = readFileSync(join(ROOT, 'lib', 'desktop', 'companion-sync.ts'), 'utf8');
  assert.ok(/\{[^}]*id:\s*'better-sidebar'[^}]*name:\s*'dsh-better-sidebar'[^}]*\}/.test(mainSrc),
    'COMPANION_PLUGINS entry missing');
});

test('vendored plugin ships without TypeScript sources (installer size)', () => {
  assert.equal(existsSync(join(PLUGIN, 'src')), false, 'src/ must not ship in the installer');
});

test('lazy client chunks fall back to the plugin resolver when the legacy module global is absent', () => {
  for (const entry of ['client.js', 'client-registry.js']) {
    const src = readFileSync(join(PLUGIN, 'lib', entry), 'utf8');
    assert.match(src, /const globalModules = globalThis\.__DSH_MODULES__/,
      `${entry} must check the legacy module table first`);
    assert.match(src, /fallbackModuleSystem = \{\s*import: async \(specifier\) => require\(specifier\)/,
      `${entry} must reuse the plugin entry resolver as a fallback`);
    assert.match(src, /client module system unavailable/,
      `${entry} must retain an actionable error when neither resolver exists`);
  }
});

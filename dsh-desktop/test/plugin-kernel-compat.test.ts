// Tests for scripts/plugin-kernel-compat.mjs —— 内置插件 ↔ 内核导出兼容门禁。
//
// 事故背景（5.4.0）：内置 picturereader 3.3.2 顶层静态导入内核 0.1.3 已删除的
// settingsNamespace，ESM 链接期即报错
//   SyntaxError: The requested module '@deepseek-ai/dsh-settings'
//   does not provide an export named 'settingsNamespace'
// 失败冒泡到 cordis:include 组 → dsh web 退出码 1 → 保护中心记 boot-failed 事故 →
// 救援链进入安全模式（safeModePatch 只留核心行）→ 用户侧「一对话就报错 + 插件大范围消失」。
//
// 本测试同时守两件事：
//   ① 真实内置插件树 + 随包内核必须零命中（回归门禁，含「扫描未失效」的规模断言）；
//   ② 门禁自身必须真的能报出同类写法（用合成夹具复现 3.3.2 → 3.3.3 的修复谱系），
//      并且不得因「注释里的示例 import」「客户端 bundle」而误报。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

interface CompatHit {
  plugin: string;
  file: string;
  spec: string;
  pkg: string;
  symbol: string;
  type: string;
}
interface CompatResult {
  ok: boolean;
  hits: CompatHit[];
  skipped: { pkg: string; reason: string }[];
  stats: {
    pluginCount: number;
    fileCount: number;
    clientFileCount: number;
    referencedPackages: number;
    checkedPackages: number;
    refCount: number;
  };
}

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(desktopRoot, 'scripts', 'plugin-kernel-compat.mjs');
const kernelRoot = join(desktopRoot, 'node_modules', '@deepseek-ai');
const pluginsRoot = join(desktopRoot, 'assets', 'plugins');

const mod = (await import(pathToFileURL(script).href)) as {
  checkCompatibility(opts?: { kernelRoot?: string; pluginsRoot?: string }): CompatResult;
  scanPluginImports(root: string): { refs: unknown[]; pluginCount: number; fileCount: number; clientFileCount: number };
};

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

// 随包内核 0.1.3-alpha.1 的真实导出面（settingsNamespace 已被移除）
const KERNEL_PKG_JSON = JSON.stringify({
  name: '@deepseek-ai/dsh-settings',
  version: '0.1.3-alpha.1',
  type: 'module',
  main: 'lib/index.js',
}, null, 2) + '\n';
const KERNEL_INDEX = 'export { SettingsConflictError, SettingsProvider, SettingsProvider as default, redactSecrets };\n';

/** 合成夹具：假内核目录 + 单插件（文件按相对插件的路径写入）。 */
function makeFixture(t: test.TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kernel-compat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'kernel', 'dsh-settings', 'lib'), { recursive: true });
  writeFileSync(join(root, 'kernel', 'dsh-settings', 'package.json'), KERNEL_PKG_JSON);
  writeFileSync(join(root, 'kernel', 'dsh-settings', 'lib', 'index.js'), KERNEL_INDEX);
  mkdirSync(join(root, 'plugins', 'picturereader'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'picturereader', 'package.json'), JSON.stringify({
    name: 'picturereader',
    version: '3.3.2',
    type: 'module',
    exports: { '.': './src/index.js', './client': './client.js' },
  }, null, 2) + '\n');
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, 'plugins', 'picturereader', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { kernelRoot: join(root, 'kernel'), pluginsRoot: join(root, 'plugins') };
}

const needKernel = (t: test.TestContext) => {
  if (existsSync(kernelRoot)) return true;
  t.skip('内核未安装（node_modules/@deepseek-ai 缺失，先跑 npm run ci:install）');
  return false;
};

test('真实内置插件树 + 随包内核：零「导入内核不存在的导出」', (t) => {
  if (!needKernel(t)) return;
  const result = mod.checkCompatibility({ kernelRoot, pluginsRoot });
  assert.deepEqual(result.hits, [], '内置插件出现内核不存在的导出（ESM 链接期会拖垮整棵插件树）');
  assert.equal(result.ok, true);
  // 规模断言：防止「扫描路径写错 → 空扫描 → 静默通过」这类门禁失效
  assert.ok(result.stats.pluginCount >= 40, `内置插件数异常偏少：${result.stats.pluginCount}`);
  assert.ok(result.stats.fileCount > 0, '服务端源码扫描为 0，门禁形同虚设');
  assert.ok(result.stats.referencedPackages > 0, '未解析到任何内核包引用，门禁形同虚设');
});

test('CLI 契约：真实树上 --json 输出可解析且 ok=true，退出码 0', (t) => {
  if (!needKernel(t)) return;
  const r = run(['--json']);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout) as CompatResult;
  assert.equal(payload.ok, true);
  assert.equal(payload.hits.length, 0);
  assert.ok(payload.stats.pluginCount >= 40);
});

test('复现 5.4.0 事故写法：具名导入已删除的 settingsNamespace 必须命中', (t) => {
  const fx = makeFixture(t, {
    'src/index.js': [
      "import { settingsNamespace } from '@deepseek-ai/dsh-settings';",
      'export default {};',
    ].join('\n') + '\n',
  });
  const result = mod.checkCompatibility(fx);
  assert.equal(result.ok, false);
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0]!;
  assert.equal(hit.pkg, 'dsh-settings');
  assert.equal(hit.symbol, 'settingsNamespace');
  assert.equal(hit.type, 'missing-export');
  assert.equal(hit.plugin, 'picturereader');

  const r = run(['--kernel', fx.kernelRoot, '--plugins', fx.pluginsRoot]);
  assert.equal(r.status, 1, '命中不兼容必须以退出码 1 结束 CI');
  assert.match(r.stderr, /settingsNamespace/);
});

test('已修写法（settings.register 路径，不再静态导入品牌函数）通过；注释里的 import 不算', (t) => {
  const fx = makeFixture(t, {
    'src/index.js': [
      "// import { settingsNamespace } from '@deepseek-ai/dsh-settings';",
      "import { SettingsProvider } from '@deepseek-ai/dsh-settings';",
      'export default { apply(ctx) { ctx.settings.register(NS, Config, { base: {} }); } };',
    ].join('\n') + '\n',
  });
  const result = mod.checkCompatibility(fx);
  assert.deepEqual(result.hits, []);
  assert.equal(result.ok, true);
  assert.equal(run(['--kernel', fx.kernelRoot, '--plugins', fx.pluginsRoot]).status, 0);
});

test('`import { A as B }`：要求被导入方导出 A（绑定名不参与判定）', (t) => {
  const okFixture = makeFixture(t, {
    'src/index.js': "import { SettingsProvider as SP } from '@deepseek-ai/dsh-settings';\nexport default SP;\n",
  });
  assert.equal(mod.checkCompatibility(okFixture).ok, true, '本地别名不应被当作导入符号');

  const badFixture = makeFixture(t, {
    'src/index.js': "import { settingsNamespace as ns } from '@deepseek-ai/dsh-settings';\nexport default ns;\n",
  });
  const hits = mod.checkCompatibility(badFixture).hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.symbol, 'settingsNamespace');
});

test('重导出 `export { X } from 内核包` 同样纳入判定', (t) => {
  const fx = makeFixture(t, {
    'src/index.js': "export { settingsNamespace } from '@deepseek-ai/dsh-settings';\n",
  });
  const hits = mod.checkCompatibility(fx).hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.type, 'missing-export');
  assert.equal(hits[0]!.symbol, 'settingsNamespace');
});

test('引用内核里不存在的包 → missing-package', (t) => {
  const fx = makeFixture(t, {
    'src/index.js': "import { thing } from '@deepseek-ai/dsh-not-installed';\nexport default thing;\n",
  });
  const hits = mod.checkCompatibility(fx).hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.type, 'missing-package');
  assert.equal(hits[0]!.pkg, 'dsh-not-installed');
});

test('客户端（浏览器侧）bundle 排除：lib/client/** 与 client.js 不参与判定，服务端入口仍判', (t) => {
  const clientOnly = makeFixture(t, {
    'client.js': [
      "import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';",
      'export default IconBranchOutline16;',
    ].join('\n') + '\n',
    'lib/client/ActivityPanel.js': [
      "import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';",
      'export default IconChevronDownOutline14;',
    ].join('\n') + '\n',
  });
  const result = mod.checkCompatibility(clientOnly);
  assert.deepEqual(result.hits, [], '客户端 bundle 的浏览器侧导入不得判为服务端链接期失败');
  assert.ok(result.stats.clientFileCount >= 2, '客户端文件未被识别排除');
  assert.equal(result.stats.fileCount, 0, '客户端文件不应计入服务端扫描');

  // 同一处导入写在服务端入口就必须命中 —— 证明排除只作用于客户端路径
  const serverSide = makeFixture(t, {
    'src/index.js': [
      "import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';",
      'export default IconBranchOutline16;',
    ].join('\n') + '\n',
  });
  const server = mod.checkCompatibility(serverSide);
  assert.equal(server.hits.length, 1);
  assert.equal(server.hits[0]!.pkg, 'dsh-client-ui-primitives');
});

test('内核未安装时报明确错误（不静默通过）', (t) => {
  const fx = makeFixture(t, { 'src/index.js': 'export default {};\n' });
  const r = run(['--kernel', join(fx.kernelRoot, 'not-here'), '--plugins', fx.pluginsRoot]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /内核目录不存在/);
});

// 验证便携包：把 dist-portable/Deepseek-Harness-EAC 当作仓库根加载 desktop-core 并 syncAll
// 模拟目标电脑上插件运行时（不经环境变量，直接指向便携包根）
const { join } = require('node:path');
const { mkdtempSync } = require('node:fs');
const root = join(process.cwd(), 'dist-portable', 'Deepseek-Harness-EAC');
const nodeExe = join(root, 'vendor', 'node', 'node.exe');
const fs = require('node:fs');

console.log('便携包根:', root);
console.log('nodeExe 存在:', fs.existsSync(nodeExe));
console.log('dsh bin 存在:', fs.existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')));
console.log('根模块数:', fs.readdirSync(root).filter((f) => f.endsWith('.js')).length);

const coreFactory = require(join(root, 'desktop-core.js'));
const dshHome = mkdtempSync(join('D:\\vs code\\.test-tmp', 'portable-verify-'));
const core = coreFactory.createDesktopCore({
  appRoot: root,
  userDataDir: dshHome,
  logsDir: join(dshHome, 'logs'),
  dshHome,
  nodeExe: () => nodeExe,
  npmCli: () => join(root, 'vendor', 'npm', 'bin', 'npm-cli.js'),
  log: (t, m) => console.log(`[${t}] ${m}`),
  notify: () => {},
});

core.ensureDesktopProfileInit();
const r = core.syncAll();
console.log('syncAll ok:', r.ok);
const patch = fs.readFileSync(join(dshHome, 'profiles', 'web-desktop', 'cordis.patch.yml'), 'utf8');
const insertCount = (patch.match(/- insert:/g) || []).length;
const pluginCopied = fs.existsSync(join(dshHome, 'profiles', 'web-desktop', 'node_modules'));
console.log('cordis.patch.yml insert 条目:', insertCount);
console.log('内置插件复制进 profile:', pluginCopied);
console.log(r.ok && insertCount > 0 && pluginCopied ? '✅ 便携包验证通过' : '❌ 便携包验证失败');
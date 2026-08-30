// scripts/run-integration.mjs — 用 @vscode/test-electron 在真实 VS Code 中运行集成测试
//
// 流程：
//   1. 构建扩展（含集成测试编译产物）
//   2. 把精简扩展产物复制到无空格路径（D:\eac-vscode-test）——Windows 下 VS Code 经
//      @vscode/test-electron 的 shell:true 启动时，含空格的扩展路径（D:\vs code\...）
//      会被截断，导致扩展宿主加载失败
//   3. 创建临时 DSH_HOME / userData 目录（数据隔离，不污染真实 ~/.dsh-v4lite）
//   4. 下载 VS Code（@vscode/test-electron 缓存到 .vscode-test）
//   5. 启动 VS Code 加载扩展并运行 test/integration/extension.integration.js
//      扩展通过 DSH_EAC_REPO_ROOT 环境变量指向真实仓库根（desktop-core / assets / vendor）
import { runTests } from '@vscode/test-electron';
import { mkdtempSync, existsSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const extensionRoot = process.cwd();
// 便携包验证模式：DSH_EAC_PORTABLE=1 时用 dist-portable/Deepseek-Harness-EAC 作为仓库根
// （完全模拟目标电脑：插件 + 便携资产，而非开发仓库）
const repoRoot = process.env.DSH_EAC_PORTABLE
  ? join(extensionRoot, '..', 'dist-portable', 'Deepseek-Harness-EAC')
  : join(extensionRoot, '..');

// 无空格部署目录（Windows 扩展宿主加载路径截断问题的规避）
const DEPLOY_ROOT = 'D:\\eac-vscode-test';

// 集成测试编译产物必须存在（npm run compile 或本脚本内置构建）
if (!process.env.SKIP_BUILD) {
  console.log('[integration] 构建扩展与集成测试…');
  execSync('node scripts/build.mjs', { cwd: extensionRoot, stdio: 'inherit' });
}

// 复制精简扩展产物到无空格路径（扩展运行时依赖均为打包内联或 node: 内置，
// 仓库资产经 DSH_EAC_REPO_ROOT 访问，无需复制 node_modules）
rmSync(DEPLOY_ROOT, { recursive: true, force: true });
mkdirSync(DEPLOY_ROOT, { recursive: true });
for (const rel of ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'README.md', 'LICENSE', 'assets']) {
  const src = join(extensionRoot, rel);
  if (existsSync(src)) cpSync(src, join(DEPLOY_ROOT, rel), { recursive: true });
}
cpSync(join(extensionRoot, 'out'), join(DEPLOY_ROOT, 'out'), { recursive: true });
console.log('[integration] 扩展已部署到无空格路径:', DEPLOY_ROOT);

const testOut = join(DEPLOY_ROOT, 'out', 'test', 'integration', 'extension.integration.js');
if (!existsSync(testOut)) {
  console.error(`[integration] 集成测试产物不存在: ${testOut}`);
  console.error('[integration] 请先执行 npm run compile');
  process.exit(1);
}

// 临时目录（数据完全隔离；优先 D 盘——C 盘空间可能不足，syncAll 拷贝插件资产需数百 MB）
const testTmp = existsSync('D:\\vs code\\.test-tmp') ? 'D:\\vs code\\.test-tmp' : tmpdir();
const dshHome = mkdtempSync(join(testTmp, 'dsh-eac-it-home-'));
const userDataDir = mkdtempSync(join(testTmp, 'dsh-eac-it-userdata-'));

console.log('[integration] DSH_HOME     =', dshHome);
console.log('[integration] USER_DATA    =', userDataDir);
console.log('[integration] REPO_ROOT    =', repoRoot);
console.log('[integration] 下载并启动 VS Code…（首次需下载约 100MB+，请耐心等待）');

try {
  await runTests({
    extensionDevelopmentPath: DEPLOY_ROOT,
    extensionTestsPath: testOut,
    // 禁用其他扩展干扰；打开空白窗口
    launchArgs: ['--disable-extensions', '--new-window', `--user-data-dir=${userDataDir}`],
    // 注意：@vscode/test-electron 的参数名是 extensionTestsEnv（不是 env）
    extensionTestsEnv: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_EAC_USER_DATA: userDataDir,
      DSH_EAC_REPO_ROOT: repoRoot,
      DSH_EAC_TEST: '1',
    },
  });
  console.log('[integration] ✅ 集成测试全部通过');
} catch (err) {
  console.error('[integration] ❌ 集成测试失败:', err);
  process.exit(1);
}

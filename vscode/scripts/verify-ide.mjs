// vscode/scripts/verify-ide.cjs — 对构建出的「Deepseek Harness EAC IDE」做端到端验证
//
// 关键点（与 run-integration.mjs 的区别）：
//   - vscodeExecutablePath 指向 dist-ide 产物的可执行文件（而非官方下载的 VS Code）
//   - 不传 extensionDevelopmentPath —— 扩展必须作为「内置扩展」从底座 resources/app/extensions 加载
//   - 不设 DSH_EAC_REPO_ROOT —— 验证扩展从捆绑的 <extensionPath>/runtime 自解析（内置 IDE 模式）
//
// 流程：
//   1. 静态断言：内置扩展注入完整（package.json + out/extension.js + runtime/desktop-core.js）、
//      product.json 品牌正确、启动器存在
//   2. 复制 IDE 到无空格路径 D:\eac-ide-test（沿用 run-integration.mjs 对空格路径的规避）
//   3. @vscode/test-electron 启动 IDE，跑 test/integration/extension.integration.js 全部断言
//      （命令注册 → openPanel → cordis.patch.yml → __DSH_BOOT__ 就绪 → copyUrl → stop → restart）
//
// 用法：node scripts/verify-ide.cjs [ideDistDir]（在 vscode/ 下运行；默认 ../dist-ide/Deepseek-Harness-EAC-IDE）
import { runTests } from '@vscode/test-electron';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const extensionRoot = process.cwd();
const repoRoot = join(extensionRoot, '..');
const ideDist = process.argv[2] || join(repoRoot, 'dist-ide', 'Deepseek-Harness-EAC-IDE');
const DEPLOY_ROOT = 'D:\\eac-ide-test';

function findAppDir(dist) {
  const direct = join(dist, 'resources', 'app');
  if (existsSync(join(direct, 'product.json'))) return direct;
  for (const entry of readdirSync(dist)) {
    const cand = join(dist, entry, 'resources', 'app');
    if (existsSync(join(cand, 'product.json'))) return cand;
  }
  throw new Error(`未找到 resources/app/product.json：${dist}`);
}
function findExe(dist) {
  const exes = readdirSync(dist).filter((f) => /\.exe$/i.test(f) && !/unins/i.test(f));
  if (exes.length === 0) throw new Error(`dist 下无 exe：${dist}`);
  const pick = exes.find((f) => /deepseek/i.test(f)) || exes.find((f) => /dsh-eac-ide/i.test(f)) || exes.find((f) => /code/i.test(f)) || exes[0];
  return join(dist, pick);
}

if (!existsSync(ideDist)) {
  console.error(`IDE 目录不存在：${ideDist}`);
  console.error('请先在仓库根执行 node scripts/make-ide.cjs');
  process.exit(1);
}

// —— 1. 静态断言 ——
console.log('===== IDE 静态断言 =====');
const appDir = findAppDir(ideDist);
const extDir = join(appDir, 'extensions', 'dsh-eac-vscode');
for (const [label, p] of [
  ['内置扩展目录', extDir],
  ['扩展清单', join(extDir, 'package.json')],
  ['扩展主入口', join(extDir, 'out', 'extension.js')],
  ['捆绑运行时', join(extDir, 'runtime', 'desktop-core.js')],
  ['内置 Node', join(extDir, 'runtime', 'vendor', 'node', 'node.exe')],
  ['dsh 内核', join(extDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
]) {
  if (!existsSync(p)) {
    console.error(`❌ 缺失: ${label} → ${p}`);
    process.exit(1);
  }
  console.log(`✅ ${label}`);
}
const prod = JSON.parse(readFileSync(join(appDir, 'product.json'), 'utf8'));
const nameOk = /Deepseek Harness EAC IDE/.test(prod.nameShort) && /Deepseek Harness EAC IDE/.test(prod.nameLong);
console.log(nameOk ? `✅ 品牌名（nameShort/nameLong = ${prod.nameShort}）` : `❌ 品牌名错误: ${prod.nameShort}/${prod.nameLong}`);
if (!nameOk) process.exit(1);
const launcher = join(ideDist, 'Deepseek Harness EAC IDE.bat');
console.log(existsSync(launcher) ? '✅ 启动器' : '❌ 启动器缺失');
const exe = findExe(ideDist);
console.log('IDE 可执行文件:', exe);

// —— 2. 部署到无空格路径（robocopy /MIR + /NODCOPY，自带重试；NODCOPY 跳过属性复制，
//        规避前次半截拷贝遗留的源/目标状态不一致与 Defender 瞬时锁）——
console.log('===== 部署到无空格路径 =====');
console.log('部署目标:', DEPLOY_ROOT);
rmSync(DEPLOY_ROOT, { recursive: true, force: true });
try {
  execSync(`robocopy "${ideDist}" "${DEPLOY_ROOT}" /MIR /R:5 /W:2 /NODCOPY /NFL /NDL /NJH /NJS`, { stdio: 'inherit' });
} catch (err) {
  // robocopy 退出码 0-7 均算成功（1=有文件被复制）；>=8 才是失败
  const code = err.status ?? 0;
  if (code >= 8) throw err;
}
console.log('部署完成');

// —— 3. 集成测试 ——
const testOut = join(extensionRoot, 'out', 'test', 'integration', 'extension.integration.js');
if (!existsSync(testOut)) {
  console.error(`集成测试产物不存在: ${testOut}`);
  console.error('请先执行 npm run compile');
  process.exit(1);
}
// 集成测试产物路径含空格（D:\vs code\...）会被扩展宿主截断，同样复制到无空格路径
try {
  execSync(`robocopy "${join(extensionRoot, 'out', 'test', 'integration')}" "${DEPLOY_ROOT}\\integration-test" /R:5 /W:2 /NODCOPY /NFL /NDL /NJH /NJS`, { stdio: 'inherit' });
} catch (err) {
  const code = err.status ?? 0;
  if (code >= 8) throw err;
}
const testOutFinal = join(DEPLOY_ROOT, 'integration-test', 'extension.integration.js');
if (!existsSync(testOutFinal)) {
  console.error(`集成测试部署失败: ${testOutFinal}`);
  process.exit(1);
}
const testTmp = existsSync('D:\\vs code\\.test-tmp') ? 'D:\\vs code\\.test-tmp' : tmpdir();
const dshHome = mkdtempSync(join(testTmp, 'dsh-ide-home-'));
const userDataDir = mkdtempSync(join(testTmp, 'dsh-ide-userdata-'));
console.log('DSH_HOME  =', dshHome);
console.log('USER_DATA =', userDataDir);

console.log('===== 启动 IDE 跑集成断言 =====');
try {
  await runTests({
    vscodeExecutablePath: findExe(DEPLOY_ROOT),
    extensionTestsPath: testOutFinal,
    // 不传 extensionDevelopmentPath：内置扩展必须从底座加载
    // 不设 DSH_EAC_REPO_ROOT：捆绑 runtime 自解析
    launchArgs: ['--new-window', `--user-data-dir=${userDataDir}`],
    extensionTestsEnv: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_EAC_USER_DATA: userDataDir,
      DSH_EAC_TEST: '1',
    },
  });
  console.log('✅ IDE 端到端验证全部通过（内置扩展 + 捆绑运行时 + dsh 服务全链路）');
} catch (err) {
  console.error('❌ IDE 端到端验证失败:', err);
  process.exit(1);
}

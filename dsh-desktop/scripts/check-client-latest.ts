'use strict';

// 客户端自更新链路测试工具（在打包应用之外运行，便于排查上游发布源问题）：
//   node scripts/check-client-latest.js             # 只检查 latest release
//   node scripts/check-client-latest.js --download  # 选中资产并试下载（不安装）
// 可选环境变量：
//   DSH_DESKTOP_RELEASE_API   自定义 release API（镜像）
//   PORTABLE_EXECUTABLE_DIR   模拟便携版（资产选 *-portable-x64.exe）
//   DSH_DESKTOP_APP_VERSION   以指定版本作为“当前版本”比较（默认 0.0.0）

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as clientUpdater from '../client-updater.js';

const current = process.env.DSH_DESKTOP_APP_VERSION || '0.0.0';
const wantDownload = process.argv.includes('--download');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-check-client-'));
const ctx: clientUpdater.ClientUpdCtx = {
  userDataDir: tmp,
  // 客户端更新只消费 userDataDir 与 log；nodeExe/npmCli 是共用 ctx 工厂
  // 形状，给空实现即可。
  nodeExe: () => '',
  npmCli: () => '',
  log: (tag, msg) => console.log(`[${tag}] ${msg}`),
};

(async () => {
  console.log('当前版本（模拟）:', current);
  if (process.env.PORTABLE_EXECUTABLE_DIR) console.log('部署形态: 便携版'); else console.log('部署形态: 安装版');
  const release = await clientUpdater.checkLatest(ctx, current);
  console.log('\n=== latest release ===');
  console.log('来源:', release.source);
  console.log('版本:', release.version, release.isNewer ? '(新于当前)' : '(不新于当前)');
  console.log('标题:', release.name ?? '(无)');
  console.log('资产:');
  for (const a of release.assets) console.log(`  - ${a.name}  ${a.size ? Math.round(a.size / 1048576) + ' MB' : '(大小未知)'}  ${a.url}`);
  const sel = clientUpdater.selectAsset(release);
  console.log('\n选中资产:', sel.name, sel.parts.length > 1 ? `(分片 ×${sel.parts.length})` : '(单文件)');
  if (!wantDownload) return;
  console.log('\n开始试下载…');
  const res = await clientUpdater.downloadRelease(ctx, release, {
    onProgress: (r, t) => {
      const pct = t > 0 ? Math.round((r * 100) / t) : -1;
      process.stdout.write(`\r  ${Math.round(r / 1048576)} MB${pct >= 0 ? '（' + pct + '%）' : ''}  `);
    },
  });
  console.log('\n下载完成:', res.filePath, Math.round(res.size / 1048576), 'MB');
  console.log('（未安装；临时目录:', tmp, '）');
})().catch((err: Error) => {
  console.error('\n失败:', err.message);
  process.exit(1);
});

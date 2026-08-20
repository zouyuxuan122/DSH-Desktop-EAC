'use strict';

// 把随系统 Node 分发的 npm CLI 复制进 vendor/npm。打包应用经 vendored
// node.exe 使用它来检查并安装官方 @deepseek-ai/dsh 更新 —— npm 会按
// registry 发布意图精确解析依赖树、处理平台相关的 optional deps、并尊重
// 用户的 .npmrc（镜像、代理）。
//
// 用法（必须在系统 Node 下运行）：
//   npm run fetch-npm

import * as fs from 'node:fs';
import * as path from 'node:path';

const src = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
const dest = path.resolve(__dirname, '..', 'vendor', 'npm');

if (!fs.existsSync(path.join(src, 'bin', 'npm-cli.js'))) {
  console.error('找不到随 Node 分发的 npm：' + src);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const version = (JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')) as { version: string }).version;
console.log(`已复制 npm@${version}`);
console.log(`    ${src}`);
console.log(` -> ${dest}`);

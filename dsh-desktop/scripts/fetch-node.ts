'use strict';

// 把系统 Node 可执行文件复制进 vendor/node/node.exe。
//
// 原因：打包后的应用用真实 node.exe 拉起 dsh CLI，保证预编译原生模块
// （sharp / node-pty / koffi …）的 Node ABI 与编译时一致。Electron 内嵌
// Node 的 ABI 不同会拒绝加载它们；针对 Electron 重编译又会破坏纯 Node
// 场景。随包分发安装时使用的同一个 node.exe 是零配置的 ABI 匹配方案。
//
// 用法（必须在系统 Node 下运行，不能在 Electron 内）：
//   npm run fetch-node

import * as fs from 'node:fs';
import * as path from 'node:path';

const src = process.execPath;
const dest = path.resolve(__dirname, '..', 'vendor', 'node', 'node.exe');

if (!/node(\.exe)?$/i.test(path.basename(src))) {
  console.error('fetch-node 必须在系统 Node 下运行（npm run fetch-node），不能在 Electron 内运行。');
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`已复制 ${src}`);
console.log(`    -> ${dest}`);
console.log(`Node ${process.version} / ${process.platform}-${process.arch} / ${fs.statSync(dest).size} bytes`);

'use strict';

// Copies the system Node executable into vendor/node/node(.exe).
//
// Why: the packaged app boots the dsh CLI with a real Node executable so prebuilt
// native modules (sharp, node-pty, koffi, ...) keep the exact Node ABI they
// were compiled for. Electron's embedded Node has a different ABI and would
// refuse to load them; rebuilding against Electron would break them for
// plain node. Bundling the same Node used at install time is the
// zero-config way to guarantee a match.
//
// Usage (must run under system Node, not Electron):
//   npm run fetch-node

const fs = require('node:fs');
const path = require('node:path');

const src = process.execPath;
const executable = process.platform === 'win32' ? 'node.exe' : 'node';
const dest = path.resolve(__dirname, '..', 'vendor', 'node', executable);

if (!/node(\.exe)?$/i.test(path.basename(src))) {
  console.error('fetch-node 必须在系统 Node 下运行（npm run fetch-node），不能在 Electron 内运行。');
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
console.log(`已复制 ${src}`);
console.log(`    -> ${dest}`);
console.log(`Node ${process.version} / ${process.platform}-${process.arch} / ${fs.statSync(dest).size} bytes`);

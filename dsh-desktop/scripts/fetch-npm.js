'use strict';

// Copies the npm CLI bundled with the system Node into vendor/npm.
// The packaged app uses it (via the vendored Node executable) to check for and
// install official @deepseek-ai/dsh updates — npm resolves the dependency
// tree exactly as the registry publish intends, handles platform-specific
// optional deps, and respects the user's .npmrc (registry mirrors, proxies).
//
// Usage (must run under system Node):
//   npm run fetch-npm

const fs = require('node:fs');
const path = require('node:path');

const candidates = [
  path.join(path.dirname(process.execPath), 'node_modules', 'npm'),
  path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'),
];
const src = candidates.find((p) => fs.existsSync(path.join(p, 'bin', 'npm-cli.js'))) || candidates[0];
const dest = path.resolve(__dirname, '..', 'vendor', 'npm');

if (!fs.existsSync(path.join(src, 'bin', 'npm-cli.js'))) {
  console.error('找不到随 Node 分发的 npm，已检查：\n' + candidates.join('\n'));
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const version = require(path.join(dest, 'package.json')).version;
console.log(`已复制 npm@${version}`);
console.log(`    ${src}`);
console.log(` -> ${dest}`);

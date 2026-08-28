'use strict';

// Copies the npm CLI bundled with the system Node into vendor/npm.
// The packaged app uses it (via the vendored node.exe) to check for and
// install official @deepseek-ai/dsh updates — npm resolves the dependency
// tree exactly as the registry publish intends, handles platform-specific
// optional deps, and respects the user's .npmrc (registry mirrors, proxies).
//
// Usage (must run under system Node):
//   npm run fetch-npm

import fs = require('node:fs');
import path = require('node:path');

const dest = path.resolve(__dirname, '..', 'vendor', 'npm');

export function findBundledNpm(nodeExecPath: string): string | null {
  const nodeDir = path.dirname(nodeExecPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'bin', 'npm-cli.js'))) || null;
}

function main(): void {
  const src = findBundledNpm(process.execPath);
  if (!src) {
    console.error('找不到与当前 Node 配套的 npm：' + process.execPath);
    process.exit(1);
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const { version } = require(path.join(dest, 'package.json')) as { version: string };
  console.log(`已复制 npm@${version}`);
  console.log(`    ${src}`);
  console.log(` -> ${dest}`);
}

if (require.main === module) main();

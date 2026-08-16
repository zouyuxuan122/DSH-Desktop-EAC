'use strict';
// Dev utility: exercise the updater engine headlessly.
//   node scripts/check-latest.js [--apply <tempUserDataDir>]
const path = require('node:path');
const updater = require('../updater');

const ctx = {
  userDataDir: process.argv.includes('--apply') ? process.argv[process.argv.length - 1] : process.cwd(),
  nodeExe: () => path.resolve(__dirname, '..', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
  npmCli: () => path.resolve(__dirname, '..', 'vendor', 'npm', 'bin', 'npm-cli.js'),
  log: (tag, msg) => console.log('[log]', tag, msg),
};

(async () => {
  const latest = await updater.checkLatest(ctx);
  console.log('LATEST=' + latest);
  console.log('CURRENT=' + updater.activeVersion(ctx));
  console.log('CMP=' + updater.compareVersions(latest, updater.activeVersion(ctx)));
  if (process.argv.includes('--apply')) {
    console.log('applyUpdate ->', ctx.userDataDir);
    const res = await updater.applyUpdate(ctx, latest);
    console.log('APPLIED=' + JSON.stringify(res));
    console.log('ACTIVE_AFTER=' + updater.activeVersion(ctx));
    console.log('OVERLAY_BIN=' + updater.overlayBinPath(ctx));
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

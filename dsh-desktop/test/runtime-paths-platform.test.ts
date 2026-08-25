import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimePaths = require('../lib/desktop/runtime-paths.js') as {
  APP_ROOT: string;
  init(ctx: {
    log(tag: string, message: string): void;
    getUserDataDir(): string;
    isPackaged(): boolean;
    resourcesPath(): string;
    platform: NodeJS.Platform;
  }): void;
  nodeExe(): string;
};

test('runtime paths resolve the packaged Node executable for Linux', () => {
  runtimePaths.init({
    log: () => {},
    getUserDataDir: () => '/tmp/user-data',
    isPackaged: () => true,
    resourcesPath: () => '/opt/dsh',
    platform: 'linux',
  });

  assert.equal(runtimePaths.nodeExe(), path.join('/opt/dsh', 'node', 'node'));
});

test('runtime paths preserve packaged and development node.exe on Windows', () => {
  runtimePaths.init({
    log: () => {},
    getUserDataDir: () => 'C:\\tmp\\user-data',
    isPackaged: () => true,
    resourcesPath: () => 'C:\\Program Files\\DSH',
    platform: 'win32',
  });
  assert.equal(runtimePaths.nodeExe(), path.join('C:\\Program Files\\DSH', 'node', 'node.exe'));

  runtimePaths.init({
    log: () => {},
    getUserDataDir: () => 'C:\\tmp\\user-data',
    isPackaged: () => false,
    resourcesPath: () => '',
    platform: 'win32',
  });
  assert.equal(runtimePaths.nodeExe(), path.resolve(runtimePaths.APP_ROOT, 'vendor', 'node', 'node.exe'));
});

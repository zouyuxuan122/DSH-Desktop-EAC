import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDesktopPlatform,
  nodeExecutableName,
} from '../lib/desktop/platform.js';

test('Linux desktop platform uses XDG data and the POSIX Node runtime name', () => {
  const platform = createDesktopPlatform({
    platform: 'linux',
    env: { XDG_CONFIG_HOME: '/tmp/xdg' },
    homeDir: '/home/alice',
  });

  assert.equal(platform.userDataDir(), '/tmp/xdg/deepseek-harness-eac');
  assert.equal(platform.runtimeExecutableName(), 'node');
  assert.equal(nodeExecutableName('linux'), 'node');
  assert.equal(platform.capabilities().clientSelfUpdate, 'external-handoff');
  assert.equal(platform.capabilities().processFence, 'degraded');
  assert.deepEqual(platform.capabilities().plugins, {
    computerUser: 'unavailable',
    ocr: 'external-dependency',
    dafeiyu: 'unavailable',
  });
});

test('Linux desktop platform falls back to ~/.config when XDG_CONFIG_HOME is absent', () => {
  const platform = createDesktopPlatform({
    platform: 'linux',
    env: {},
    homeDir: '/home/alice',
  });

  assert.equal(platform.userDataDir(), '/home/alice/.config/deepseek-harness-eac');
});

test('Windows desktop platform preserves AppData and node.exe behavior', () => {
  const platform = createDesktopPlatform({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' },
    homeDir: 'C:\\Users\\Alice',
  });

  assert.equal(platform.userDataDir(), 'C:\\Users\\Alice\\AppData\\Roaming\\Deepseek Harness EAC');
  assert.equal(platform.runtimeExecutableName(), 'node.exe');
  assert.equal(nodeExecutableName('win32'), 'node.exe');
  assert.equal(platform.capabilities().clientSelfUpdate, 'supported');
  assert.deepEqual(platform.capabilities().plugins, {
    computerUser: 'supported',
    ocr: 'supported',
    dafeiyu: 'supported',
  });
});

test('Linux clipboard capability reports an external dependency when no backend exists', () => {
  const platform = createDesktopPlatform({
    platform: 'linux',
    env: {},
    homeDir: '/home/alice',
    commandExists: () => false,
  });

  assert.equal(platform.capabilities().clipboard, 'external-dependency');
});

test('Linux clipboard capability detects an installed L1 backend', () => {
  const platform = createDesktopPlatform({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    homeDir: '/home/alice',
    commandExists: (file) => file === 'wl-copy',
  });

  assert.equal(platform.capabilities().clipboard, 'supported');
});

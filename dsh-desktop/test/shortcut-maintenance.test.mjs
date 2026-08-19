import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  STANDARD_SHORTCUT_NAME,
  RUNTIME_SHORTCUT_DESCRIPTION,
  desktopShortcutDirs,
  classifyManagedShortcut,
  planDesktopShortcutMaintenance,
} = require(join(root, 'shortcut-maintenance.js'));

const target = String.raw`C:\Program Files\Deepseek Harness EAC\Deepseek Harness EAC.exe`;
const previousTarget = String.raw`E:\Deepseek Harness EAC\Deepseek Harness EAC.exe`;
const managedIcon = String.raw`C:\Users\Test\AppData\Roaming\Deepseek Harness EAC\icon.ico`;
const installerDescription = 'DeepSeek Harness (dsh) 开箱即用的 Windows 桌面客户端：内置 dsh CLI 与 Node 运行时，一键启动 Web UI';

function entry(scope, filePath, link) {
  return { scope, filePath, link: { args: '', ...link } };
}

function runtime(scope = 'user', overrides = {}) {
  const desktop = scope === 'public' ? String.raw`C:\Users\Public\Desktop` : String.raw`C:\Users\Test\Desktop`;
  return entry(scope, join(desktop, STANDARD_SHORTCUT_NAME), {
    target,
    description: RUNTIME_SHORTCUT_DESCRIPTION,
    icon: managedIcon,
    ...overrides,
  });
}

function installer(scope = 'public', overrides = {}) {
  const desktop = scope === 'public' ? String.raw`C:\Users\Public\Desktop` : String.raw`C:\Users\Test\Desktop`;
  return entry(scope, join(desktop, STANDARD_SHORTCUT_NAME), {
    target,
    description: installerDescription,
    icon: target,
    ...overrides,
  });
}

test('desktopShortcutDirs 同时返回个人桌面和公共桌面并去重', () => {
  assert.deepEqual(
    desktopShortcutDirs(String.raw`C:\Users\Test\Desktop`, String.raw`C:\Users\Public`),
    [
      { scope: 'user', dir: String.raw`C:\Users\Test\Desktop` },
      { scope: 'public', dir: String.raw`C:\Users\Public\Desktop` },
    ],
  );
  assert.equal(
    desktopShortcutDirs(String.raw`C:\Users\Public\Desktop`, String.raw`C:\Users\Public`).length,
    1,
  );
});

test('安装版运行时永不补建桌面快捷方式', () => {
  const plan = planDesktopShortcutMaintenance({
    entries: [],
    target,
    managedIcon,
    portable: false,
  });
  assert.equal(plan.create, false);
  assert.deepEqual(plan.removals, []);
});

test('便携版没有应用快捷方式时只创建一个', () => {
  const plan = planDesktopShortcutMaintenance({
    entries: [],
    target,
    managedIcon,
    portable: true,
  });
  assert.equal(plan.create, true);
});

test('便携版已有任意名称的用户快捷方式时不重复创建', () => {
  const custom = entry('user', String.raw`C:\Users\Test\Desktop\我的桌宠工具.lnk`, {
    target,
    description: '用户自己的说明',
    icon: String.raw`D:\Icons\custom.ico`,
  });
  const plan = planDesktopShortcutMaintenance({
    entries: [custom],
    target,
    managedIcon,
    portable: true,
  });
  assert.equal(plan.create, false);
  assert.deepEqual(plan.removals, []);
});

test('安装版同时存在安装器和运行时快捷方式时保留安装器项', () => {
  const installerLink = installer();
  const runtimeLink = runtime();
  const plan = planDesktopShortcutMaintenance({
    entries: [runtimeLink, installerLink],
    target,
    managedIcon,
    portable: false,
  });
  assert.equal(plan.create, false);
  assert.equal(plan.preferred, installerLink.filePath);
  assert.deepEqual(plan.removals, [runtimeLink.filePath]);
});

test('便携版重复项优先保留个人桌面的运行时快捷方式', () => {
  const userRuntime = runtime('user');
  const publicInstaller = installer('public');
  const plan = planDesktopShortcutMaintenance({
    entries: [publicInstaller, userRuntime],
    target,
    managedIcon,
    portable: true,
  });
  assert.equal(plan.preferred, userRuntime.filePath);
  assert.deepEqual(plan.removals, [publicInstaller.filePath]);
});

test('用户改名、换图标、加参数的快捷方式均不可自动删除', () => {
  const renamed = runtime('user', {});
  renamed.filePath = String.raw`C:\Users\Test\Desktop\我改过名字.lnk`;
  const reiconed = runtime('user', { icon: String.raw`D:\Icons\custom.ico` });
  const withArgs = runtime('user', { args: '--custom' });
  for (const row of [renamed, reiconed, withArgs]) {
    assert.equal(classifyManagedShortcut(row, { target, previousTarget, managedIcon }), null);
  }

  const official = installer();
  const plan = planDesktopShortcutMaintenance({
    entries: [renamed, reiconed, withArgs, official],
    target,
    previousTarget,
    managedIcon,
    portable: false,
  });
  assert.deepEqual(plan.removals, []);
});

test('用户复制的自定义名称快捷方式不参与官方重复清理', () => {
  const official = installer();
  const copied = installer('user');
  copied.filePath = String.raw`C:\Users\Test\Desktop\Deepseek Harness EAC - 副本.lnk`;
  const plan = planDesktopShortcutMaintenance({
    entries: [official, copied],
    target,
    managedIcon,
    portable: false,
  });
  assert.deepEqual(plan.removals, []);
});

test('两份相同生成器快捷方式来源不明确时不自动删除', () => {
  const publicInstaller = installer('public');
  const userCopy = installer('user');
  const plan = planDesktopShortcutMaintenance({
    entries: [publicInstaller, userCopy],
    target,
    managedIcon,
    portable: false,
  });
  assert.deepEqual(plan.removals, []);
});

test('旧目标的软件生成项可随当前安装器项一起去重', () => {
  const oldRuntime = runtime('user', { target: previousTarget });
  const currentInstaller = installer();
  const plan = planDesktopShortcutMaintenance({
    entries: [oldRuntime, currentInstaller],
    target,
    previousTarget,
    managedIcon,
    portable: false,
  });
  assert.deepEqual(plan.removals, [oldRuntime.filePath]);
});

test('创建者偏好不得覆盖当前有效目标', () => {
  const staleInstaller = installer('public', { target: previousTarget, icon: previousTarget });
  const currentRuntime = runtime('user');
  const plan = planDesktopShortcutMaintenance({
    entries: [staleInstaller, currentRuntime],
    target,
    previousTarget,
    managedIcon,
    portable: false,
  });
  assert.equal(plan.preferred, currentRuntime.filePath);
  assert.deepEqual(plan.removals, [staleInstaller.filePath]);
});

test('shortcutPolicy=never 时不创建也不清理', () => {
  const plan = planDesktopShortcutMaintenance({
    entries: [runtime(), installer()],
    target,
    managedIcon,
    portable: true,
    policy: 'never',
  });
  assert.equal(plan.create, false);
  assert.deepEqual(plan.removals, []);
});

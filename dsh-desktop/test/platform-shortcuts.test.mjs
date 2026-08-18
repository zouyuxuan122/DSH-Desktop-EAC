import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShortcutManager } from '../platform/shortcuts.js';

// 组件测试：Windows 快捷方式维护（platform/shortcuts.js）。
// app / shell 用桩注入；fs/path/os 真实（临时目录 + 仓库真实 assets 图标）。

function makeManager(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shortcuts-'));
  const userData = path.join(root, 'userData');
  const desktopDir = path.join(root, 'Desktop');
  const appData = path.join(root, 'AppData', 'Roaming');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const settings = {};
  const calls = { write: [], read: [], boxes: [] };
  const links = new Map(); // lnkPath -> { target, icon }

  const manager = createShortcutManager({
    app: {
      isPackaged: true,
      getPath: (name) => (name === 'desktop' ? desktopDir : path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')),
    },
    shell: {
      readShortcutLink: (p) => links.get(p) || null,
      writeShortcutLink: (p, mode, opts) => { calls.write.push({ p, mode, opts }); links.set(p, { target: opts.target, icon: opts.icon || null }); },
    },
    path, fs, os,
    isWin: true,
    getUserDataDir: () => userData,
    loadSettings: () => settings,
    saveSettings: (_c, s) => Object.assign(settings, s),
    updCtx: () => ({}),
    showBox: (opts) => { calls.boxes.push(opts); return Promise.resolve({ response: 0 }); },
    log: () => {},
    ...overrides,
  });
  return { manager, root, userData, desktopDir, settings, calls, links };
}

const startMenuPath = (m) => path.join(m.root, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Deepseek Harness EAC.lnk');
const desktopPath = (m) => path.join(m.desktopDir, 'Deepseek Harness EAC.lnk');

test('listLnkFiles：只返回 .lnk 文件', () => {
  const { manager, desktopDir } = makeManager();
  fs.writeFileSync(path.join(desktopDir, 'a.lnk'), 'x');
  fs.writeFileSync(path.join(desktopDir, 'b.txt'), 'x');
  const list = manager.listLnkFiles(desktopDir);
  assert.equal(list.length, 1);
  assert.ok(list[0].endsWith('a.lnk'));
  assert.deepEqual(manager.listLnkFiles(path.join(desktopDir, 'missing')), []);
});

test('lnkTargetsApp：target 精确匹配（大小写不敏感）', () => {
  const { manager, links } = makeManager();
  links.set('x.lnk', { target: 'C:\\APP\\dsh.exe' });
  assert.equal(manager.lnkTargetsApp('x.lnk', 'c:\\app\\dsh.exe'), true);
  assert.equal(manager.lnkTargetsApp('missing.lnk', 'c:\\app\\dsh.exe'), false);
  links.set('other.lnk', { target: 'C:\\windows\\notepad.exe' });
  assert.equal(manager.lnkTargetsApp('other.lnk', 'c:\\app\\dsh.exe'), false);
});

test('lnkUsesManagedIcon：无自定义图标视为可接管，自定义则否', () => {
  const { manager, links } = makeManager();
  links.set('managed.lnk', { target: 'x', icon: null });
  assert.equal(manager.lnkUsesManagedIcon('managed.lnk', 'c:\\ico.ico'), true);
  links.set('custom.lnk', { target: 'x', icon: 'C:\\Users\\me\\custom.ico' });
  assert.equal(manager.lnkUsesManagedIcon('custom.lnk', 'c:\\ico.ico'), false);
});

test('shortcutIconPath：把仓库图标复制到 userData 并返回稳定路径', () => {
  const { manager, userData } = makeManager();
  const ico = manager.shortcutIconPath();
  assert.ok(ico.endsWith('icon.ico'));
  assert.ok(ico.startsWith(userData), '应复制到 userData 稳定目录');
  assert.ok(fs.existsSync(ico), '图标文件应存在');
});

test('maintainShortcuts：首次运行创建开始菜单 + 桌面快捷方式并记录', () => {
  const { manager, calls, settings } = makeManager();
  manager.maintainShortcuts();
  const writes = calls.write.map((w) => w.mode);
  assert.ok(writes.includes('create'), '应创建快捷方式');
  assert.equal(settings.shortcutTarget, process.execPath);
  assert.equal(typeof settings.shortcutIcon, 'string');
});

test('maintainShortcuts：policy=never 不创建桌面快捷方式', () => {
  const { manager, calls } = makeManager({ loadSettings: () => ({ shortcutPolicy: 'never' }) });
  manager.maintainShortcuts();
  const desktopWrites = calls.write.filter((w) => w.p.endsWith('Deepseek Harness EAC.lnk') && !w.p.includes('Start Menu'));
  assert.equal(desktopWrites.length, 0, 'never 策略不应写桌面快捷方式');
});

test('maintainShortcuts：E2E 环境变量跳过', () => {
  const old = process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS;
  process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS = '1';
  try {
    const { manager, calls } = makeManager();
    manager.maintainShortcuts();
    assert.equal(calls.write.length, 0, 'E2E 模式不应写任何快捷方式');
  } finally {
    if (old === undefined) delete process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS;
    else process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS = old;
  }
});

test('maintainShortcuts：非 Windows 直接返回', () => {
  const { manager, calls } = makeManager({ isWin: false });
  manager.maintainShortcuts();
  assert.equal(calls.write.length, 0);
});

test('warnTempRun：便携版在临时目录运行时弹告警；非临时目录不弹', () => {
  const oldDir = process.env.PORTABLE_EXECUTABLE_DIR;
  process.env.PORTABLE_EXECUTABLE_DIR = os.tmpdir();
  try {
    const { manager, calls } = makeManager();
    manager.warnTempRun();
    assert.equal(calls.boxes.length, 1, '临时目录运行应弹告警');
  } finally {
    if (oldDir === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
    else process.env.PORTABLE_EXECUTABLE_DIR = oldDir;
  }
  const { manager: m2, calls: c2 } = makeManager();
  m2.warnTempRun(); // 无 PORTABLE_EXECUTABLE_DIR
  assert.equal(c2.boxes.length, 0);
});

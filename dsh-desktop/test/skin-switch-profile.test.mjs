// TDD regression tests for the dsh-skin-switch plugin's profile resolution.
//
// Bug reported: after the v4 desktop-exclusive profile switch, 皮肤切换失效 —
// applying a skin and restarting the service left the default skin active.
// Root cause: the plugin host half hardcodes PROFILE_NAME = 'web', so apply()
// rewrites <DSH_HOME>/profiles/web/cordis.patch.yml while the desktop shell
// boots dsh web on the dedicated profile (web-desktop, exported through the
// DSH_DESKTOP_PROFILE env var — the same convention dsh-dock-settings and
// dsh-webui-market host halves already follow). The user's choice lands in a
// patch file the running service never reads.
//
// Expected behavior (see dsh-dock-settings/lib/host.js:27-30):
//   · DSH_DESKTOP_PROFILE set + valid  → operate on that profile
//   · unset, empty, or invalid (path chars) → fall back to 'web'

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skinPkgName = '@linxin666/dsh-client-ui-skin-xp';
const otherPkgName = '@dsh-external/dsh-client-ui-skin-maid-atelier';

/** Materialize one skin package + a starter patch in a profile dir. */
function makeProfile(profileDir) {
  const xpDir = join(profileDir, 'node_modules', '@linxin666', 'dsh-client-ui-skin-xp');
  mkdirSync(xpDir, { recursive: true });
  writeFileSync(join(xpDir, 'package.json'), JSON.stringify({
    name: skinPkgName, version: '1.0.0', dsh: { client: { platform: 'web' } },
  }));
  writeFileSync(join(xpDir, 'skin.json'), JSON.stringify({
    id: 'xp', name: 'XP 柳林', wiring: { id: 'ui-skin-xp' }, order: 1,
  }));
  const maidDir = join(profileDir, 'node_modules', '@dsh-external', 'dsh-client-ui-skin-maid-atelier');
  mkdirSync(maidDir, { recursive: true });
  writeFileSync(join(maidDir, 'package.json'), JSON.stringify({
    name: otherPkgName, version: '1.0.0', dsh: { client: { platform: 'web' } },
  }));
  writeFileSync(join(maidDir, 'skin.json'), JSON.stringify({
    id: 'maid-atelier', name: '深海女仆', wiring: { id: 'ui-skin-maid-atelier' }, order: 2,
  }));
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: ui-skin-xp',
    "      name: '@linxin666/dsh-client-ui-skin-xp'",
    '      disabled: true',
    '    - id: ui-skin-maid-atelier',
    "      name: '@dsh-external/dsh-client-ui-skin-maid-atelier'",
    '      disabled: true',
    '',
  ].join('\n'));
}

/** Both profiles on disk: the active web-desktop one and the legacy 'web' one. */
function makeWorld() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-skin-test-'));
  makeProfile(join(home, 'profiles', 'web'));
  makeProfile(join(home, 'profiles', 'web-desktop'));
  return home;
}

let home;
let savedEnv = {};

beforeEach(() => {
  home = makeWorld();
  savedEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_DESKTOP_PROFILE: process.env.DSH_DESKTOP_PROFILE,
  };
  process.env.DSH_HOME = home;
  process.env.DSH_DESKTOP_PROFILE = 'web-desktop';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/** Load the plugin fresh so module-level state never leaks between cases. */
async function loadPlugin() {
  const mod = await import('../assets/plugins/dsh-skin-switch/lib/index.js');
  return { installedSkins: mod.installedSkins, readSkinStates: mod.readSkinStates, rewriteSkinRows: mod.rewriteSkinRows };
}

/** 一个皮肤行是否处于启用状态（id 行之后、下一个条目之前的区间内无 disabled: true）。 */
const enabled = (patchText, id) => {
  const lines = patchText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp('^\\s+- id: ' + id + '\\s*$').test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*-\s*(id|insert):/.test(lines[j])) break;
      if (/^\s+disabled:\s*true\s*$/.test(lines[j])) return false;
    }
    return true;
  }
  return false;
};

test('apply 读写桌面专属 profile（DSH_DESKTOP_PROFILE=web-desktop）', async () => {
  const { installedSkins, rewriteSkinRows, readSkinStates } = await loadPlugin();
  const skins = installedSkins();
  assert.equal(skins.length, 2, '皮肤应从 web-desktop profile 的 node_modules 列出');
  assert.equal(readSkinStates()['ui-skin-xp'], true, '初始状态：xp 在 web-desktop patch 中禁用');

  rewriteSkinRows(skins, 'ui-skin-xp');

  const desktopPatch = readFileSync(join(home, 'profiles', 'web-desktop', 'cordis.patch.yml'), 'utf8');
  assert.ok(enabled(desktopPatch, 'ui-skin-xp'), 'xp 必须在实际运行的 web-desktop patch 中启用');
  assert.ok(!enabled(desktopPatch, 'ui-skin-maid-atelier'), '互斥：maid-atelier 必须禁用');
});

test('apply 不得污染旧 web profile（历史 bug：写错文件导致重启后皮肤不变）', async () => {
  const { installedSkins, rewriteSkinRows } = await loadPlugin();
  rewriteSkinRows(installedSkins(), 'ui-skin-maid-atelier');

  const legacyPatch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  assert.ok(!enabled(legacyPatch, 'ui-skin-maid-atelier'),
    '旧 web profile 的 maid-atelier 应保持禁用（服务不读它，写它就是丢用户选择）');
  const desktopPatch = readFileSync(join(home, 'profiles', 'web-desktop', 'cordis.patch.yml'), 'utf8');
  assert.ok(enabled(desktopPatch, 'ui-skin-maid-atelier'), '选择必须落到 web-desktop');
});

test('未设置 DSH_DESKTOP_PROFILE 时回退到原生 web profile', async () => {
  delete process.env.DSH_DESKTOP_PROFILE;
  const { installedSkins, rewriteSkinRows } = await loadPlugin();
  const skins = installedSkins();
  assert.equal(skins.length, 2, '独立 CLI 场景：皮肤仍从 web profile 列出');
  rewriteSkinRows(skins, 'ui-skin-xp');
  const webPatch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  assert.ok(enabled(webPatch, 'ui-skin-xp'), '选择应写进 web profile');
});

test('非法 profile 名（路径穿越）回退到 web，不得越界写文件', async () => {
  process.env.DSH_DESKTOP_PROFILE = '../evil';
  const { installedSkins } = await loadPlugin();
  const skins = installedSkins();
  assert.equal(skins.length, 2, '非法名回退 web：皮肤仍可列出');
  assert.ok(!exists(join(home, 'evil')), '不得在 home 之外创建目录');
});

function exists(p) {
  try { return readFileSync(p).length >= 0; } catch { return false; }
}

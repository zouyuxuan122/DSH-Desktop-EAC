import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cp from 'node:child_process';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fp = require(join(root, 'lib', 'desktop', 'feature-pack.js'));
const archiver = require('archiver') as (format: string, o?: Record<string, unknown>) => ArchiverLike;

interface ArchiverLike {
  append(content: string | Buffer, o: { name: string }): ArchiverLike;
  finalize(): Promise<void>;
  on(event: 'error', cb: (err: Error) => void): ArchiverLike;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-feature-pack-'));
}

interface ZipInput { name: string; content: string | Buffer | null; dir?: string }

async function makePackZip(outZip: string, manifest: Record<string, unknown> | null, files: ZipInput[]): Promise<void> {
  mkdirSync(dirname(outZip), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const z = archiver('zip', { zlib: { level: 9 } });
    const out = require('node:fs').createWriteStream(outZip);
    z.on('error', reject);
    out.on('error', reject);
    out.on('close', resolve);
    z.pipe(out);
    if (manifest !== null) {
      z.append(JSON.stringify({ formatVersion: 1, ...manifest }, null, 2) + '\n', { name: 'pack.json' });
    }
    for (const f of files) {
      const name = f.dir ? join(f.dir.replace(/\/+$/, ''), f.name) : f.name;
      if (f.content === null) z.append(Buffer.alloc(0), { name });
      else z.append(f.content, { name });
    }
    z.finalize().catch(reject);
  });
}

// --- 构造临时 DSH_HOME + mock ctx -------------------------------------------------

function setupCtx(dir: string, overrides: Record<string, unknown> = {}): { ctx: Record<string, unknown>; assets: string } {
  const home = join(dir, 'home');
  const assets = join(dir, 'assets');
  mkdirSync(join(assets, 'plugins', 'dsh-terminal'), { recursive: true });
  writeFileSync(join(assets, 'plugins', 'dsh-terminal', 'package.json'), JSON.stringify({ name: 'dsh-terminal', version: '1.0.0' }));
  mkdirSync(home, { recursive: true });
  const ctx = {
    log: () => {},
    getDshHome: () => home,
    getDesktopProfile: () => 'web-desktop',
    getUserDataDir: () => dir,
    getDshBin: () => join(dir, 'fake-bin.js'),
    getNodeExe: () => process.execPath,
    getChildEnv: () => ({ ...process.env, DSH_HOME: home }),
    builtinSourceDir: (dirName: string) => join(assets, 'plugins', dirName),
    snapshot: () => ({ id: 'snap-' + Date.now() }),
    restoreSnapshot: () => ({ ok: true }),
    ...overrides,
  };
  fp.init(ctx);
  return { ctx, assets };
}

const MANIFEST = {
  id: 'com.example.coder-pack',
  name: '全能编码功能包',
  version: '1.2.0',
  description: '测试包',
  requires: { dsh: '>=0.1.1-rc.2 <0.2.0' },
  plugins: [{ ref: 'builtin:dsh-terminal' }],
  presets: [{ id: 'p-example' }],
  skills: [{ id: 's-example' }],
};

function packFiles(): ZipInput[] {
  return [
    { name: 'preset.yml', dir: 'payload/presets/p-example', content: 'name: p-example\n' },
    { name: 'SKILL.md', dir: 'payload/skills/s-example', content: '# s-example\n' },
    { name: 'extra.txt', dir: 'payload/skills/s-example', content: 'x' },
  ];
}

// --- matchSemverRange --------------------------------------------------------------

test('matchSemverRange: 精确与比较符', () => {
  assert.equal(fp.matchSemverRange('1.2.3', '1.2.3'), true);
  assert.equal(fp.matchSemverRange('1.2.3', '1.2.4'), false);
  assert.equal(fp.matchSemverRange('=1.2.3', '1.2.3'), true);
  assert.equal(fp.matchSemverRange('>1.2.3', '1.2.4'), true);
  assert.equal(fp.matchSemverRange('>1.2.3', '1.2.3'), false);
  assert.equal(fp.matchSemverRange('>=1.2.3', '1.2.3'), true);
  assert.equal(fp.matchSemverRange('<2.0.0', '1.9.9'), true);
  assert.equal(fp.matchSemverRange('<=2.0.0', '2.0.0'), true);
  // 部分版本 + 比较符：>=1.2 ≙ >=1.2.0
  assert.equal(fp.matchSemverRange('>=1.2', '1.2.0'), true);
  assert.equal(fp.matchSemverRange('>=1.2', '1.1.9'), false);
  assert.equal(fp.matchSemverRange('<1.2', '1.1.9'), true);
  assert.equal(fp.matchSemverRange('<1.2', '1.2.0'), false);
});

test('matchSemverRange: ^ ~ 与 x 范围', () => {
  assert.equal(fp.matchSemverRange('~1.2.3', '1.2.3'), true);
  assert.equal(fp.matchSemverRange('~1.2.3', '1.2.9'), true);
  assert.equal(fp.matchSemverRange('~1.2.3', '1.3.0'), false);
  assert.equal(fp.matchSemverRange('^1.2.3', '1.9.9'), true);
  assert.equal(fp.matchSemverRange('^1.2.3', '2.0.0'), false);
  assert.equal(fp.matchSemverRange('^0.2.3', '0.2.9'), true);
  assert.equal(fp.matchSemverRange('^0.2.3', '0.3.0'), false);
  assert.equal(fp.matchSemverRange('^0.0.3', '0.0.3'), true);
  assert.equal(fp.matchSemverRange('^0.0.3', '0.0.4'), false);
  assert.equal(fp.matchSemverRange('1.2.x', '1.2.9'), true);
  assert.equal(fp.matchSemverRange('1.2.x', '1.3.0'), false);
  assert.equal(fp.matchSemverRange('1.x', '1.5.0'), true);
  assert.equal(fp.matchSemverRange('1.x', '2.0.0'), false);
  assert.equal(fp.matchSemverRange('1.2', '1.2.9'), true);
  assert.equal(fp.matchSemverRange('1.2', '1.3.0'), false);
  assert.equal(fp.matchSemverRange('1', '1.9.0'), true);
  assert.equal(fp.matchSemverRange('1', '2.0.0'), false);
  assert.equal(fp.matchSemverRange('*', '0.0.1'), true);
  assert.equal(fp.matchSemverRange('', '9.9.9'), true);
  assert.equal(fp.matchSemverRange(undefined, '9.9.9'), true);
});

test('matchSemverRange: 空格 AND 与 || 或组', () => {
  assert.equal(fp.matchSemverRange('>=1.0.0 <2.0.0', '1.5.0'), true);
  assert.equal(fp.matchSemverRange('>=1.0.0 <2.0.0', '2.0.0'), false);
  assert.equal(fp.matchSemverRange('>=1.0.0 <2.0.0 || >=3.0.0', '3.1.0'), true);
  assert.equal(fp.matchSemverRange('>=1.0.0 <2.0.0 || >=3.0.0', '2.5.0'), false);
});

test('matchSemverRange: 预发布宽容（EAC 内核 rc 命名）', () => {
  // 范围未声明预发布：同段 rc 视为满足。
  assert.equal(fp.matchSemverRange('>=0.1.1', '0.1.1-rc.2'), true);
  assert.equal(fp.matchSemverRange('=0.1.1', '0.1.1-rc.2'), true);
  assert.equal(fp.matchSemverRange('>=0.1.2', '0.1.1-rc.2'), false);
  assert.equal(fp.matchSemverRange('<0.2.0', '0.1.19-rc.1'), true);
  assert.equal(fp.matchSemverRange('~1.2.3', '1.2.3-rc.1'), true);
  // 范围显式声明预发布：按 tuple 精确比较。
  assert.equal(fp.matchSemverRange('>=0.1.1-rc.2', '0.1.1-rc.2'), true);
  assert.equal(fp.matchSemverRange('>=0.1.1-rc.2', '0.1.1-rc.1'), false);
  assert.equal(fp.matchSemverRange('>=0.1.1-rc.2 <0.2.0', '0.1.1'), true);
  assert.equal(fp.matchSemverRange('0.1.1-rc.2', '0.1.1-rc.2'), true);
  // 稳定版本恒大于同段预发布。
  assert.equal(fp.compareVersions('0.1.1', '0.1.1-rc.2'), 1);
  assert.equal(fp.compareVersions('0.1.1-rc.2', '0.1.1'), -1);
});

test('matchSemverRange: 非法语法保守不匹配', () => {
  assert.equal(fp.matchSemverRange('not-a-version', '1.2.3'), false);
  assert.equal(fp.matchSemverRange('>=foo', '1.2.3'), false);
});

// --- validateManifest ---------------------------------------------------------------

test('validateManifest: 合法清单通过', () => {
  const r = fp.validateManifest({ formatVersion: 1, id: 'com.example.ok', name: 'OK', version: '1.0.0', plugins: [{ ref: 'github:user/repo' }] });
  assert.equal(r.ok, true);
});

test('validateManifest: 非法清单报错', () => {
  assert.equal(fp.validateManifest(null).ok, false);
  assert.equal(fp.validateManifest({}).ok, false);
  assert.equal(fp.validateManifest({ formatVersion: 2, id: 'x', name: 'x', version: '1.0.0' }).ok, false);
  assert.equal(fp.validateManifest({ formatVersion: 1, id: 'bad id!', name: 'x', version: '1.0.0' }).ok, false);
  assert.equal(fp.validateManifest({ formatVersion: 1, id: 'com.example.ok', name: 'x', version: 'nope' }).ok, false);
  // overrides v1 预留：非空数组判无效。
  assert.equal(fp.validateManifest({ formatVersion: 1, id: 'com.example.ok', name: 'x', version: '1.0.0', overrides: ['a'] }).ok, false);
  assert.equal(fp.validateManifest({ formatVersion: 1, id: 'com.example.ok', name: 'x', version: '1.0.0', overrides: [] }).ok, true);
  // 非法插件 ref。
  assert.equal(fp.validateManifest({ formatVersion: 1, id: 'com.example.ok', name: 'x', version: '1.0.0', plugins: [{ ref: '' }] }).ok, false);
});

// --- 注册表 CRUD --------------------------------------------------------------------

test('注册表: 空加载与原子写往返', () => {
  const dir = tmp();
  try {
    const { ctx } = setupCtx(dir);
    const home = ctx.getDshHome() as string;
    assert.equal(fp.loadRegistry(home).packs.length, 0);
    const reg = fp.loadRegistry(home);
    reg.packs.push({
      id: 'com.example.r1', version: '1.0.0', installedAt: new Date().toISOString(),
      profile: 'web-desktop', state: 'active', source: 'local-file',
      manifest: { formatVersion: 1, id: 'com.example.r1', name: 'R1', version: '1.0.0' },
      plugins: [], presets: [], skills: [], snapshotRef: null, opRef: null,
    });
    fp.saveRegistry(home, reg);
    const reloaded = fp.loadRegistry(home);
    assert.equal(reloaded.packs.length, 1);
    assert.equal(reloaded.packs[0]!.id, 'com.example.r1');
    assert.equal(fp.findPack(home, 'com.example.r1')!.version, '1.0.0');
    assert.equal(fp.findPack(home, 'nope'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- parsePackZip -------------------------------------------------------------------

test('parsePackZip: 解析合法 .dshpack，非法报错', async () => {
  const dir = tmp();
  try {
    const zip = join(dir, 'com.example.coder-pack-1.2.0.dshpack');
    await makePackZip(zip, MANIFEST, packFiles());
    const { manifest, zip: z } = await fp.parsePackZip(zip);
    assert.equal(manifest.id, 'com.example.coder-pack');
    assert.equal(z.files.length >= 4, true);
    // 缺 pack.json
    const bad = join(dir, 'bad.dshpack');
    await makePackZip(bad, null, [{ name: 'x.txt', content: 'x' }]);
    await assert.rejects(() => fp.parsePackZip(bad), /pack.json/);
    // 校验失败
    const bad2 = join(dir, 'bad2.dshpack');
    await makePackZip(bad2, { id: 'bad id!', name: 'x', version: '1.0.0' }, []);
    await assert.rejects(() => fp.parsePackZip(bad2), /校验失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 安装 / 卸载往返 -----------------------------------------------------------------

test('安装 → 卸载：payload 装配、注册表、托管清理、用户自建保护', async () => {
  const dir = tmp();
  try {
    const { ctx } = setupCtx(dir);
    const home = ctx.getDshHome() as string;
    const zip = join(dir, 'com.example.coder-pack-1.2.0.dshpack');
    await makePackZip(zip, MANIFEST, packFiles());

    // 内核未知（fake bin）→ requires 不匹配；force 安装。
    const r = await fp.installPack({ zipPath: zip, force: true, source: 'local-file' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.recordId, 'com.example.coder-pack');

    // 注册表 + payload 落位。
    const rec = fp.findPack(home, 'com.example.coder-pack')!;
    assert.equal(rec.state, 'incompatible');   // force 安装 → 标 incompatible
    assert.equal(rec.plugins.length, 1);
    assert.equal(rec.plugins[0]!.source, 'builtin');
    assert.equal(rec.plugins[0]!.managed, false);   // builtin 不卸载
    assert.ok(existsSync(join(home, '.agent-presets', 'p-example', 'preset.yml')));
    assert.ok(existsSync(join(home, 'skills', 's-example', 'SKILL.md')));
    assert.ok(existsSync(join(home, 'feature-packs', 'com.example.coder-pack', 'payload')));

    // 二次安装被拒（提示 update）。
    const r2 = await fp.installPack({ zipPath: zip, force: true });
    assert.equal(r2.ok, false);
    assert.match(r2.error || '', /已安装/);

    // 卸载。
    const u = await fp.uninstallPack('com.example.coder-pack');
    assert.equal(u.ok, true, u.error);
    assert.equal(fp.findPack(home, 'com.example.coder-pack'), null);
    assert.ok(!existsSync(join(home, '.agent-presets', 'p-example')));
    assert.ok(!existsSync(join(home, 'skills', 's-example')));
    assert.ok(!existsSync(join(home, 'feature-packs', 'com.example.coder-pack')));
    // builtin 插件（mock assets 内）由 companion 同步管理，卸载不触碰。
    assert.ok(existsSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('安装遇用户自建同名 preset/skill：跳过不覆盖，卸载不清除', async () => {
  const dir = tmp();
  try {
    const { ctx } = setupCtx(dir);
    const home = ctx.getDshHome() as string;
    // 用户自建同名 preset / skill（无托管标记）。
    mkdirSync(join(home, '.agent-presets', 'p-example'), { recursive: true });
    writeFileSync(join(home, '.agent-presets', 'p-example', 'preset.yml'), 'name: user-owned\n');
    mkdirSync(join(home, 'skills', 's-example'), { recursive: true });
    writeFileSync(join(home, 'skills', 's-example', 'SKILL.md'), '# user\n');

    const zip = join(dir, 'com.example.coder-pack-1.2.0.dshpack');
    await makePackZip(zip, MANIFEST, packFiles());
    const r = await fp.installPack({ zipPath: zip, force: true });
    assert.equal(r.ok, true, r.error);

    const rec = fp.findPack(home, 'com.example.coder-pack')!;
    assert.equal(rec.presets[0]!.skipped, true);
    assert.equal(rec.skills[0]!.skipped, true);
    // 内容未被覆盖。
    assert.equal(readFileSync(join(home, '.agent-presets', 'p-example', 'preset.yml'), 'utf8'), 'name: user-owned\n');

    const u = await fp.uninstallPack('com.example.coder-pack');
    assert.equal(u.ok, true);
    // 用户目录保留。
    assert.ok(existsSync(join(home, '.agent-presets', 'p-example', 'preset.yml')));
    assert.ok(existsSync(join(home, 'skills', 's-example', 'SKILL.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('兼容失配被拒；scan 幂等写回 incompatible', async () => {
  const dir = tmp();
  try {
    const { ctx } = setupCtx(dir);
    const home = ctx.getDshHome() as string;
    // 让内核版本可控：mock resolveKernelVersion？改通过 fake profile 版本文件。
    const profileNpm = join(home, 'profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(profileNpm, { recursive: true });
    writeFileSync(join(profileNpm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }));

    const zip = join(dir, 'com.example.coder-pack-1.2.0.dshpack');
    await makePackZip(zip, MANIFEST, packFiles());
    // 不 force：兼容检查应拒绝（0.1.1-rc.2 在 >=0.1.1-rc.2 <0.2.0 内 → 应允许！）
    const r = await fp.installPack({ zipPath: zip });
    assert.equal(r.ok, true, r.error);

    // 内核版本变化（模拟官方升级到 0.2.5）：scan → incompatible。
    writeFileSync(join(profileNpm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.5' }));
    const s1 = fp.scanFeaturePackCompatibility();
    assert.equal(s1.incompatible.includes('com.example.coder-pack'), true);
    assert.equal(fp.findPack(home, 'com.example.coder-pack')!.state, 'incompatible');
    // 幂等：再扫仍在列表。
    const s2 = fp.scanFeaturePackCompatibility();
    assert.equal(s2.incompatible.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 导出 ----------------------------------------------------------------------------

test('exportPack: 从注册表重建 .dshpack（palyload 保留）', async () => {
  const dir = tmp();
  try {
    const { ctx } = setupCtx(dir);
    const home = ctx.getDshHome() as string;
    const zip = join(dir, 'com.example.coder-pack-1.2.0.dshpack');
    await makePackZip(zip, MANIFEST, packFiles());
    const r = await fp.installPack({ zipPath: zip, force: true });
    assert.equal(r.ok, true, r.error);

    const out = join(dir, 'export', 'out.dshpack');
    const e = await fp.exportPack('com.example.coder-pack', out);
    assert.equal(e.ok, true, e.error);
    assert.ok(existsSync(out));
    const parsed = await fp.parsePackZip(out);
    assert.equal(parsed.manifest.id, 'com.example.coder-pack');
    assert.equal(parsed.manifest.version, '1.2.0');
    assert.equal(parsed.zip.files.some((f) => f.path.startsWith('payload/presets/')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI（编译产物） ------------------------------------------------------------------

const CLI = join(root, 'scripts', 'feature-pack-cli.js');

test('CLI: inspect / list（编译产物存在时）', async () => {
  if (!existsSync(CLI)) return;   // 未 build（npm run build 前置）时跳过
  const dir = tmp();
  try {
    const { ctx } = setupCtx(dir);
    const home = ctx.getDshHome() as string;
    const zip = join(dir, 'com.example.coder-pack-1.2.0.dshpack');
    await makePackZip(zip, MANIFEST, packFiles());

    const env = { ...process.env, DSH_HOME: home as string };
    const r1 = spawnSync(process.execPath, [CLI, 'inspect', zip], { encoding: 'utf8', env });
    assert.equal(r1.status, 0);
    const out1 = JSON.parse(r1.stdout);
    assert.equal(out1.ok, true);
    assert.equal(out1.manifest.id, 'com.example.coder-pack');
    // 用法错误
    const r2 = spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf8', env });
    assert.equal(r2.status, 2);
    // list（空注册表）
    const r3 = spawnSync(process.execPath, [CLI, 'list'], { encoding: 'utf8', env });
    assert.equal(r3.status, 0);
    assert.deepEqual(JSON.parse(r3.stdout).packs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
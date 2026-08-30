// healCredentialsVersion 单测（5.3.3 批次二补齐）：凭据版式自愈是
// 「升级后启动卡死」级功能，此前只有手动冒烟、零单测。
// 本仓库 vendored 内核 credentials-local【严格读数字 version 1】
// （parseCredentialsDocument: `fields["version"] !== 1` 即拒——字符串 "1"
// 一样死，PR #256 方向与本地内核相反，装机实测后改回）：
//   · 引号 version（"1"/'1'）→ 规整为数字 1；
//   · rc.2 扁平文件（顶层标量 + records:）→ 迁移为 version: 1/refs 包裹；
//   · 正常 version: 1 文件不动；
//   · 不认识的版式（奇异行）不动（宁可让内核报错也不要写坏凭据）。
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const boot = require(join(root, 'lib', 'desktop', 'boot-server.js')) as {
  init(d: unknown): void;
  healCredentialsVersion(): void;
};

function makeHome(): { home: string; credFile: string } {
  const home = mkdtempSync(join(tmpdir(), 'cred-heal-'));
  return { home, credFile: join(home, '.credentials.yaml') };
}

function initBoot(home: string): void {
  // healCredentialsVersion 经 childEnv().DSH_HOME 定位 home；childEnv 读
  // proc ctx 的 getDshHome。只需 proc 兼容的最小面。
  const proc = require(join(root, 'lib', 'desktop', 'proc.js')) as { init(d: unknown): void };
  proc.init({ log: () => {}, getDshHome: () => home, getDesktopProfile: () => 'web-desktop' });
  boot.init({
    log: () => {},
    getUserDataDir: () => home,
    getDesktopProfile: () => 'web-desktop',
    desktopProfileDir: () => join(home, 'profiles', 'web-desktop'),
    nodeExe: () => process.execPath,
    dshBin: () => join(home, 'bin.js'),
    loadSettings: () => ({}),
    saveSettings: () => {},
    isQuitting: () => false,
  });
}

test('quoted version is normalized to bare digit 1 (local kernel contract)', () => {
  const { home, credFile } = makeHome();
  try {
    writeFileSync(credFile, 'version: "1"\nrefs:\n  main: sk-a\nrecords:\n  - id: r1\n');
    initBoot(home);
    boot.healCredentialsVersion();
    const out = readFileSync(credFile, 'utf8');
    assert.match(out, /^version: 1$/m);
    assert.ok(!out.includes('"1"'), 'quoted version must be gone (kernel rejects string "1")');
    assert.match(out, /^  main: sk-a$/m, 'refs untouched');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('digit version: 1 file is left untouched', () => {
  const { home, credFile } = makeHome();
  try {
    const original = 'version: 1\nrefs:\n  main: sk-ok\nrecords:\n  - id: r1\n';
    writeFileSync(credFile, original);
    initBoot(home);
    boot.healCredentialsVersion();
    assert.equal(readFileSync(credFile, 'utf8'), original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('rc.2 flat layout migrates into version/refs envelope', () => {
  const { home, credFile } = makeHome();
  try {
    writeFileSync(credFile, 'main: sk-flat\nsecond: sk-two\nrecords:\n  - id: r1\n');
    initBoot(home);
    boot.healCredentialsVersion();
    const out = readFileSync(credFile, 'utf8');
    assert.match(out, /^version: 1$/m);
    assert.match(out, /^refs:\n  main: sk-flat\n  second: sk-two\n/m, 'scalars indented under refs');
    assert.match(out, /^records:\n  - id: r1\n/m, 'records block preserved');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('multi-char API key scalars are recognized in flat layout (user incident regression)', () => {
  // 用户实测事故：3 个真实 key 的扁平文件拒启——单字符 \S 时多字符 key
  // 不被识别为标量行，扁平迁移分支永不触发。
  const { home, credFile } = makeHome();
  try {
    writeFileSync(credFile, 'DEEPSEEK_API_KEY: sk-DUMMYDEEPSEEKKEY0123456789abcdef\nROUTER_API_KEY: sk-DUMMYROUTERKEY-w3u59m\nrecords:\n  - id: r1\n');
    initBoot(home);
    boot.healCredentialsVersion();
    const out = readFileSync(credFile, 'utf8');
    assert.match(out, /^version: 1$/m);
    assert.match(out, /^  DEEPSEEK_API_KEY: sk-DUMMYDEEPSEEKKEY0123456789abcdef$/m, 'multi-char scalar must migrate');
    assert.match(out, /^  ROUTER_API_KEY: sk-DUMMYROUTERKEY-w3u59m$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing credentials file is a no-op (no file created)', () => {
  const { home, credFile } = makeHome();
  try {
    initBoot(home);
    boot.healCredentialsVersion();
    assert.ok(!existsSync(credFile));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unrecognizable layout is left untouched (never corrupt credentials)', () => {
  const { home, credFile } = makeHome();
  try {
    const weird = '# comment\nsome random: [bracket\n  nested weirdness\n';
    writeFileSync(credFile, weird);
    initBoot(home);
    boot.healCredentialsVersion();
    assert.equal(readFileSync(credFile, 'utf8'), weird, 'unknown shape must not be rewritten');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// atomic-json 同毫秒并发写（tmp 随机后缀回归）：并发 writeJsonAtomic 同一
// 目标不得互相踩踏（任一 rename ENOENT → 误报失败）。
test('atomic-json concurrent writes to the same file all land', async () => {
  const { writeJsonAtomic } = require(join(root, 'lib', 'atomic-json.js')) as {
    writeJsonAtomic(file: string, value: unknown): void;
  };
  const dir = mkdtempSync(join(tmpdir(), 'atomic-json-conc-'));
  try {
    const target = join(dir, 'state.json');
    mkdirSync(dir, { recursive: true });
    const runs = Array.from({ length: 24 }, (_, i) => Promise.resolve().then(() => {
      writeJsonAtomic(target, { i });
    }));
    await Promise.all(runs);
    const final = JSON.parse(readFileSync(target, 'utf8')) as { i: number };
    assert.ok(Number.isInteger(final.i) && final.i >= 0 && final.i < 24, 'final state is one of the writers');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

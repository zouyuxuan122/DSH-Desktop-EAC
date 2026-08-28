import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// 防呆（v4.2，用户反馈问题 4）：插件装完 web 起不来时，错误弹窗只能
// 「回退到上一版本/内置版本」，对用户来说等于白装。本测试覆盖：
//   · attributeBootFailure —— 把报错文案里的包名/行 id 归因到 profile 里
//     可停用的插件（patch 行 id/name、bundle、dependency），归因失败返回 null；
//   · guardedBoot 的 preRetry 钩子 —— allowBuilds 等配置级修复只调用一次，
//     应用后与 repair() 一起重试，绝不无限循环。

const require = createRequire(import.meta.url);
const { createGuard } = require('../plugin-guard.js');

function makeHome(root) {
  const home = join(root, 'dsh-home');
  const profile = join(home, 'profiles', 'web-desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web-desktop',
    dependencies: { 'meow-memory': 'github:zhang-meow/meow-memory' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'api-gateway'] } },
  }, null, 2) + '\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: dsh-tool-vision',
    "  name: 'dsh-tool-vision'",
    "  config:",
    "    vision: true",
    '- insert:',
    '    - id: mkt-1',
    "      name: 'dsh-pet'",
    '',
  ].join('\n'));
  return { home, profile, guard: createGuard({ getHome: () => home, getProfile: () => 'web-desktop', dshBin: () => '', log: () => {} }) };
}

test('attributeBootFailure：命中 patch 行 id（duplicate loader entry）', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    const hit = guard.attributeBootFailure("duplicate loader entry 'dsh-tool-vision'");
    assert.deepEqual(hit, { name: 'dsh-tool-vision', kind: 'patchRow', rowId: 'dsh-tool-vision' });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('attributeBootFailure：命中 insert 内层行的 name（Cannot find module）', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    const hit = guard.attributeBootFailure('Cannot find module "dsh-pet"');
    assert.deepEqual(hit, { name: 'dsh-pet', kind: 'patchRow', rowId: 'mkt-1' });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('attributeBootFailure：命中 bundle（duplicate entry）', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    const hit = guard.attributeBootFailure('duplicate entry: api-gateway');
    assert.deepEqual(hit, { name: 'api-gateway', kind: 'bundle', rowId: null });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('attributeBootFailure：命中 dependencies 键', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    const hit = guard.attributeBootFailure('Failed to load plugin "meow-memory": exit code 1');
    assert.deepEqual(hit, { name: 'meow-memory', kind: 'dependency', rowId: null });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('attributeBootFailure：无关文案返回 null', () => {
  const t = mkdtempSync(join(tmpdir(), 'attr-'));
  try {
    const { guard } = makeHome(t);
    assert.equal(guard.attributeBootFailure('ERR_OSSL_EVP_UNSUPPORTED: legacy provider'), null);
    assert.equal(guard.attributeBootFailure(''), null);
    assert.equal(guard.attributeBootFailure(null), null);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('guardedBoot：preRetry 应用配置级修复后重试成功并标记良好', async () => {
  const t = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const { guard } = makeHome(t);
    let calls = 0;
    let preCalls = 0;
    const url = await guard.guardedBoot(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('Ignored build scripts: esbuild. Run "pnpm approve-builds"');
        return 'http://127.0.0.1:5821';
      },
      () => 'logs',
      {
        preRetry: async (errText) => {
          preCalls += 1;
          assert.match(errText, /esbuild/);
          return { applied: ['pnpm allowBuilds 自动放行: esbuild'] };
        },
      }
    );
    assert.equal(url, 'http://127.0.0.1:5821');
    assert.equal(calls, 2);
    assert.equal(preCalls, 1, 'preRetry 只调用一次');
    assert.equal(guard.lastGoodSnapshot() !== null, true, '成功拉起后应标记最后良好快照');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('guardedBoot：preRetry 返回 false 不打扰，走原失败链路', async () => {
  const t = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const { guard } = makeHome(t);
    let preCalls = 0;
    await assert.rejects(
      guard.guardedBoot(
        async () => { throw new Error('ERR_OSSL_EVP_UNSUPPORTED'); },
        () => 'logs',
        { preRetry: async () => { preCalls += 1; return false; } }
      ),
      /ERR_OSSL_EVP_UNSUPPORTED/
    );
    assert.equal(preCalls, 1);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('guardedBoot：preRetry 修复后重试仍失败 → 进入回滚流程并抛出', async () => {
  const t = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const { guard } = makeHome(t);
    let calls = 0;
    let preCalls = 0;
    await assert.rejects(
      guard.guardedBoot(
        async () => {
          calls += 1;
          throw new Error('Ignored build scripts: esbuild. attempt ' + calls);
        },
        () => 'logs',
        { preRetry: async () => { preCalls += 1; return { applied: ['allowBuilds: esbuild'] }; } }
      ),
      /attempt 2/
    );
    assert.equal(calls, 2, '修复后只重试一次');
    assert.equal(preCalls, 1, 'preRetry 不重复调用');
  } finally { rmSync(t, { recursive: true, force: true }); }
});
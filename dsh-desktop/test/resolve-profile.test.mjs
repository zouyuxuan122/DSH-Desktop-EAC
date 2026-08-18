import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile } from '../assets/plugins/dsh-webui-market/lib/host.js';

// 防呆（v4.2，用户反馈问题 6）：插件安装报
//   [error] spawn C:\Program Files\...\resources\node\node.exe ENOENT
// 根因：目录条目默认 profile 是 'web'，桌面壳跑在 web-desktop 上时
// profiles/web 不存在，spawn 以不存在的目录作 cwd → Node 把 ENOENT 记在
// 可执行文件头上。host 层必须把 'web' 归一化到桌面 profile。
// CLI 直连（无 DSH_DESKTOP_PROFILE）时映射恒等。

const ORIG = process.env.DSH_DESKTOP_PROFILE;

test('resolveProfile：桌面壳下 web → web-desktop，其他合法 profile 原样', () => {
  process.env.DSH_DESKTOP_PROFILE = 'web-desktop';
  try {
    assert.equal(resolveProfile('web'), 'web-desktop');
    assert.equal(resolveProfile(undefined), 'web-desktop');
    assert.equal(resolveProfile(null), 'web-desktop');
    assert.equal(resolveProfile(''), 'web-desktop');
    assert.equal(resolveProfile('mario'), 'mario');
    assert.equal(resolveProfile('custom-prof_1'), 'custom-prof_1');
  } finally {
    if (ORIG === undefined) delete process.env.DSH_DESKTOP_PROFILE;
    else process.env.DSH_DESKTOP_PROFILE = ORIG;
  }
});

test('resolveProfile：CLI 直连（无桌面 profile）时映射恒等', () => {
  delete process.env.DSH_DESKTOP_PROFILE;
  try {
    assert.equal(resolveProfile('web'), 'web');
    assert.equal(resolveProfile(undefined), 'web');
    assert.equal(resolveProfile('mario'), 'mario');
  } finally {
    if (ORIG === undefined) delete process.env.DSH_DESKTOP_PROFILE;
    else process.env.DSH_DESKTOP_PROFILE = ORIG;
  }
});

test('resolveProfile：非法 profile 一律回退桌面 profile（防路径注入）', () => {
  process.env.DSH_DESKTOP_PROFILE = 'web-desktop';
  try {
    assert.equal(resolveProfile('../evil'), 'web-desktop');
    assert.equal(resolveProfile('a b'), 'web-desktop');
    assert.equal(resolveProfile('web-desktop'), 'web-desktop');
  } finally {
    if (ORIG === undefined) delete process.env.DSH_DESKTOP_PROFILE;
    else process.env.DSH_DESKTOP_PROFILE = ORIG;
  }
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNoSpaceError } from '../client-updater.js';

// 回归背景：磁盘满（ENOSPC）时 downloadFile 会按断点续传语义重试 10 次 ×
// 最长 30s 退避，UI 进度条卡在 100% 近 5 分钟才报「更新失败」。
// 修复：ENOSPC 属不可恢复错误，必须立即终止重试并以中文明确提示用户。
// （真实的写盘 ENOSPC 无法在单测中伪造 —— 需要真的把磁盘写满；集成行为
// 由「本地 mock 发布源 + 填满系统盘」的手工冒烟验证，见 e2e 流程。）

test('isNoSpaceError: code === ENOSPC', () => {
  const e = new Error('write ENOSPC');
  e.code = 'ENOSPC';
  assert.equal(isNoSpaceError(e), true);
});

test('isNoSpaceError: message 匹配（大小写不敏感）', () => {
  assert.equal(isNoSpaceError(new Error('ENOSPC: no space left on device, write')), true);
  assert.equal(isNoSpaceError(new Error('No space left on device')), true);
  assert.equal(isNoSpaceError(new Error('NO SPACE LEFT ON DEVICE')), true);
});

test('isNoSpaceError: 其他错误不误判', () => {
  assert.equal(isNoSpaceError(new Error('连接中断')), false);
  assert.equal(isNoSpaceError(new Error('下载失败 HTTP 500')), false);
  assert.equal(isNoSpaceError(new Error('RESUME_INVALID')), false);
  assert.equal(isNoSpaceError(new Error('downloaded file size mismatch')), false);
  const r = new Error('socket hang up');
  r.code = 'ECONNRESET';
  assert.equal(isNoSpaceError(r), false);
});

test('isNoSpaceError: 空输入不抛异常', () => {
  assert.equal(isNoSpaceError(null), false);
  assert.equal(isNoSpaceError(undefined), false);
  assert.equal(isNoSpaceError({ message: 123 }), false);
});

// Tests for error-detail.js — the fatal/error dialog detail builder.
// The desktop shell shows error dialogs on boot failure / service death;
// users asked for a "copy the error log" one-click path, so the dialog
// detail must carry the full error text plus the log locations, and stay
// robust when no Error object or stack is available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorDetail } from '../error-detail.js';

test('buildErrorDetail includes message, stack and log directory', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at x (y:1:1)';
  const detail = buildErrorDetail(err, 'C:\\logs');
  assert.ok(detail.includes('错误：boom'), 'detail must carry the error message');
  assert.ok(detail.includes('Error: boom'), 'detail must carry the stack trace');
  assert.ok(detail.includes('日志目录：C:\\logs'), 'detail must carry the log directory');
});

test('buildErrorDetail tolerates a missing Error/stack', () => {
  const detail = buildErrorDetail(null, 'C:\\logs');
  assert.ok(detail.includes('未知错误'), 'missing err falls back to a readable message');
  assert.ok(detail.includes('日志目录：C:\\logs'));
  assert.ok(!detail.includes('undefined'), 'no undefined literals leak into the copy');
});

test('buildErrorDetail appends extra log files after the directory', () => {
  const detail = buildErrorDetail(new Error('x'), 'C:\\logs', ['dsh-web.log', 'desktop.log']);
  const dirPos = detail.indexOf('日志目录：C:\\logs');
  const webPos = detail.indexOf('dsh-web.log');
  const deskPos = detail.indexOf('desktop.log');
  assert.ok(dirPos >= 0 && webPos > dirPos && deskPos > webPos, 'log files follow the directory line');
});

test('buildErrorDetail always ends with newline-safe plain text', () => {
  const detail = buildErrorDetail(new Error('line1\nline2'), 'C:\\logs');
  assert.ok(detail.includes('line1\nline2'), 'multiline messages survive verbatim');
});
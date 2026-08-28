// darwin payload 裁剪纯函数测试（stage-resources.mjs 装配期使用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isMachO,
  pruneDarwinPayloads,
  pruneNonDarwinPrebuilds,
} from '../../tauri-shell/stage-platform-prune.mjs';

const MACHO64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00]);

test('isMachO 识别 64 位小端 Mach-O 魔数，缺失文件返回 false', () => {
  assert.equal(isMachO('/nonexistent-file'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const macho = path.join(dir, 'a.node');
  const elf = path.join(dir, 'b.node');
  fs.writeFileSync(macho, MACHO64);
  fs.writeFileSync(elf, ELF);
  assert.equal(isMachO(macho), true);
  assert.equal(isMachO(elf), false);
});

test('pruneDarwinPayloads 删除 exe/dll 与非 Mach-O .node，保留 Mach-O .node 和普通文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'empty-dir'));
  fs.writeFileSync(path.join(dir, 'keep.node'), MACHO64);
  fs.writeFileSync(path.join(dir, 'drop-elf.node'), ELF);
  fs.writeFileSync(path.join(dir, 'tool.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'lib.dll'), 'MZ');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'text');
  fs.writeFileSync(path.join(dir, 'nested', 'keep2.node'), MACHO64);
  pruneDarwinPayloads(dir);
  assert.equal(fs.existsSync(path.join(dir, 'keep.node')), true);
  assert.equal(fs.existsSync(path.join(dir, 'drop-elf.node')), false);
  assert.equal(fs.existsSync(path.join(dir, 'tool.exe')), false);
  assert.equal(fs.existsSync(path.join(dir, 'lib.dll')), false);
  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(dir, 'nested', 'keep2.node')), true);
  assert.equal(fs.existsSync(path.join(dir, 'empty-dir')), false);
});

test('pruneNonDarwinPrebuilds 只保留 darwin-arm64 目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilds-'));
  const pre = path.join(dir, 'node_modules', 'node-pty', 'prebuilds');
  fs.mkdirSync(pre, { recursive: true });
  for (const p of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
    fs.mkdirSync(path.join(pre, p), { recursive: true });
  }
  fs.writeFileSync(path.join(pre, 'darwin-arm64', 'pty.node'), MACHO64);
  pruneNonDarwinPrebuilds(path.join(dir, 'node_modules'));
  assert.deepEqual(fs.readdirSync(pre), ['darwin-arm64']);
});

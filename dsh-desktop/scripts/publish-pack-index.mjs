#!/usr/bin/env node
'use strict';

// 功能包市场索引生成器（包作者用，对应 docs/feature-pack-spec.md 附录 A）。
//
// 用法：
//   node scripts/publish-pack-index.mjs <pack 文件|目录> [--index packs-index.json] [--url-prefix https://…]
//
// 行为：
//   · 扫描给定 .dshpack 文件或目录；逐个读取 pack.json（unzipper），计算 SHA-256；
//   · 合并 `--index` 指向的既有索引（同 id 覆盖为新版本，保留原 url 与 added）；
//   · url 取 `--url-prefix` + <id>-<version>.dshpack（未提供前缀则置 null，需人工补）；
//   · 结果写回 `--index`（缺省 out/packs-index.json），stdout 打印摘要。
//
// 仅供包作者/维护者使用，不构成桌面端功能；桌面端索引获取见 host.js 的
// PACKS_INDEX_URLS 与 data/packs-snapshot.json（离线快照）。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unzipper = require('unzipper');

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function packMetaOf(file) {
  const zip = await unzipper.Open.file(file);
  const entry = zip.files.find((f) => f.path === 'pack.json');
  if (!entry) throw new Error(basename(file) + ': 缺少 pack.json，跳过');
  const raw = (await entry.buffer()).toString('utf8').replace(/^\uFEFF/, '');
  const manifest = JSON.parse(raw);
  const idOk = typeof manifest.id === 'string' && typeof manifest.version === 'string';
  if (!idOk) throw new Error(basename(file) + ': pack.json 缺 id/version，跳过');
  return { manifest, sha256: sha256Of(file) };
}

function usage() {
  console.error('用法: node scripts/publish-pack-index.mjs <pack|dir> [--index <json>] [--url-prefix <prefix>]');
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  if (!target) usage();
  const indexOf = (name) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const indexFile = indexOf('index') || 'out/packs-index.json';
  const urlPrefix = indexOf('url-prefix');

  const files = [];
  if (statSync(target).isDirectory()) {
    for (const name of readdirSync(target)) {
      if (/\.dshpack$/i.test(name)) files.push(join(target, name));
    }
  } else if (/\.dshpack$/i.test(target)) {
    files.push(target);
  } else {
    console.error('目标不是 .dshpack 文件或目录: ' + target);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error('没有找到 .dshpack 文件');
    process.exit(1);
  }

  // 既有索引（合并）。
  let existing = { updated: '', source: 'live', packs: [] };
  if (existsSync(indexFile)) {
    try { existing = JSON.parse(readFileSync(indexFile, 'utf8')); } catch (err) {
      console.error('既有索引解析失败: ' + err.message);
      process.exit(1);
    }
  }
  if (!existing.packs) existing.packs = [];

  const added = [];
  for (const file of files) {
    try {
      const { manifest, sha256 } = await packMetaOf(file);
      const prev = existing.packs.find((p) => p.id === manifest.id);
      const entry = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author || (prev && prev.author) || null,
        desc: manifest.description || (prev && prev.desc) || '',
        url: urlPrefix ? urlPrefix.replace(/\/+$/, '') + '/' + manifest.id + '-' + manifest.version + '.dshpack' : (prev && prev.url) || null,
        sha256,
        requires: manifest.requires || undefined,
        added: (prev && prev.added) || new Date().toISOString().slice(0, 10),
      };
      existing.packs = existing.packs.filter((p) => p.id !== manifest.id);
      existing.packs.push(entry);
      added.push(manifest.id + '@' + manifest.version);
      console.log('[publish-pack-index] ' + manifest.id + ' v' + manifest.version + ' → sha256 ' + sha256.slice(0, 16) + '…');
    } catch (err) {
      console.error('[publish-pack-index] 跳过 ' + basename(file) + ': ' + err.message);
    }
  }

  existing.updated = new Date().toISOString().slice(0, 10);
  mkdirSync(dirname(indexFile), { recursive: true });
  writeFileSync(indexFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  console.log('[publish-pack-index] 已更新 ' + indexFile + '（' + existing.packs.length + ' 个条目，本次 ' + added.join(', ') + '）');
}

main().catch((err) => {
  console.error('[publish-pack-index] 失败: ' + String((err && err.message) || err));
  process.exit(1);
});
#!/usr/bin/env node
'use strict';

// 生成 dist/SHA256SUMS.txt（V4）：为最终发布产物（Setup / Portable exe 及
// blockmap）计算 SHA-256，供 Release 页面公布；客户端自更新
// （client-updater.js）会自动取该文件做下载内容校验（Gitee 无 digest 字段
// 时的唯一校验来源）。发布时把 dist/SHA256SUMS.txt 一起作为 Release 资产
// 上传（保持原文件名）。
//
// Linux fork 扩展：除 Windows exe/blockmap 外也覆盖 Linux 包格式
// （.pacman / .deb / .rpm / .AppImage），dist:linux 链路同样产出校验清单。
//
// 用法：node scripts/make-release-hashes.js [distDir]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ARTIFACT_RE = /\.(exe|blockmap|pacman|deb|rpm|AppImage)$/i;

const distDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

(async () => {
  if (!fs.existsSync(distDir)) {
    console.error(`[release-hashes] dist 目录不存在: ${distDir}`);
    process.exit(1);
  }
  const targets = fs.readdirSync(distDir)
    .filter((n) => ARTIFACT_RE.test(n))
    .sort();
  if (targets.length === 0) {
    console.error('[release-hashes] dist 目录里没有可识别的发布产物');
    process.exit(1);
  }
  const lines = [];
  for (const name of targets) {
    const hex = await sha256(path.join(distDir, name));
    lines.push(`${hex}  ${name}`);
    console.log(`${hex}  ${name}`);
  }
  const out = path.join(distDir, 'SHA256SUMS.txt');
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log(`[release-hashes] 已生成 ${out}（${targets.length} 个产物）`);
})();

'use strict';
// darwin payload 裁剪（stage-resources.mjs 装配期使用）。
// 独立模块：stage-resources.mjs 无 main guard，import 即执行全量装配，
// 纯函数放这里供 node:test 直接导入。
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** 是否为 64 位小端 Mach-O（.node 在 macOS 上为 Mach-O dylib）。
 * 假设：npm 生态的 darwin-arm64 .node 均为 thin（单架构）dylib；若未来出现 FAT/universal 二进制会被误删，届时需扩展魔数识别。 */
export function isMachO(file) {
  try {
    const data = readFileSync(file);
    return data.length >= 4
      && data[0] === 0xcf && data[1] === 0xfa && data[2] === 0xed && data[3] === 0xfe;
  } catch {
    return false;
  }
}

export function pruneDarwinPayloads(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneDarwinPayloads(file);
      if (readdirSync(file).length === 0) rmSync(file, { recursive: true, force: true });
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(?:exe|dll)$/i.test(entry.name) || (/\.node$/i.test(entry.name) && !isMachO(file))) {
      rmSync(file, { force: true });
    }
  }
}

export function pruneNonDarwinPrebuilds(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (entry.name === 'prebuilds') {
      for (const platformDir of readdirSync(child, { withFileTypes: true })) {
        if (platformDir.isDirectory() && platformDir.name !== 'darwin-arm64') {
          rmSync(path.join(child, platformDir.name), { recursive: true, force: true });
        }
      }
    } else {
      pruneNonDarwinPrebuilds(child);
    }
  }
}

// 原子写 JSON/文本（tmp + rename）：先写同目录临时文件再改名替换，避免
// 写一半损坏目标文件；Windows 上 rename 可能因瞬时占用失败，先删旧文件
// 重试一次。目录自动创建。既有调用点（plugin-guard / supervisor registry /
// recovery-center register / extension-host sdk / sidecar rescue-integration /
// companion-sync patch）的落盘语义一致：`JSON.stringify(v, null, 2) + '\n'`。

import fs = require('node:fs');
import path = require('node:path');

export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + Date.now();
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, file); } catch {
    fs.rmSync(file, { force: true, maxRetries: 3 });
    fs.renameSync(tmp, file);
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}
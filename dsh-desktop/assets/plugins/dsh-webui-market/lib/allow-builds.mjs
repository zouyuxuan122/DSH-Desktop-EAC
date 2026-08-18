'use strict';

import fs from 'node:fs';

// pnpm 构建脚本封锁的自动放行（v4.2，用户反馈问题 2）。
// pnpm v10+ 默认封锁依赖的构建脚本（prepare/install/postinstall），
// GitHub 源插件安装必被拦：dsh 的 `plugin add github:X` 失败后只打印
// "allowBuilds 加白名单" 提示，安装链路全挂。
// 本模块被四处共用，保证同一套解析与写入逻辑：
//   · 市场 host 半边（startOp 失败重试 / runProbe 试装验证）
//   · 主进程排队任务（processPendingMarketOps）
//   · 守护启动失败链（guardedBoot 的 preRetry 钩子）
// 仅做 pnpm-workspace.yaml 的行级编辑，不引入 YAML 依赖。

const KEY_RE = /^@?[A-Za-z0-9][A-Za-z0-9._@/+-]*$/;

const STOPWORDS = new Set([
  'run', 'pnpm', 'approve-builds', 'approvebuilds', 'pick', 'which',
  'dependencies', 'should', 'be', 'allowed', 'to', 'the', 'exact', 'key',
  'printed', 'above', 'of', 'on', 'for', 'use', 'yarn', 'npm', 'then',
  'rerun', 'it', 'you', 'can', 'also', 'add', 'them', 'directly',
  'their', 'were', 'was', 'not', 'executed', 'blocked', 'and', 'failed',
  'these', 'are', 'none', 'run', 'in', 's',
]);

// 从 pnpm/dsh 输出里提取被封锁的包名列表。保守解析：宁少勿错 ——
// 只认明确的「包名」token，凑不出列表就返回空（上层决定是否重试）。
export function parseBlockedBuildKeys(output) {
  if (!output || typeof output !== 'string') return [];
  const text = output.replace(/\r/g, '');
  const keys = [];

  const pushKeys = (region) => {
    const cleaned = region
      .replace(/["']/g, '')
      .replace(/\.(?:$|\s)/g, ' ')
      .replace(/[;,](?:\s|$)/g, ' ');
    for (const tok of cleaned.split(/[,\s]+/)) {
      const key = tok.trim();
      if (!key) continue;
      if (!KEY_RE.test(key)) continue;
      if (STOPWORDS.has(key.toLowerCase())) continue;
      if (keys.includes(key)) continue;
      keys.push(key);
    }
  };

  // 1) `Ignored build scripts: a, b. Run ...` / `on: a, b` / `for: a, b`
  //    带 ERR_PNPM_IGNORED_BUILDS 前缀；列表可能被 80 列换行拆成缩进续行。
  const regions = [];
  for (const m of text.matchAll(/ignored build scripts[:\s][^\r\n]*/gi)) {
    let region = m[0];
    const startLine = text.slice(0, m.index).split('\n').length;
    const lines = text.split('\n');
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i];
      if (!l.startsWith(' ') && !l.startsWith('\t')) break;
      region += ' ' + l.trim();
    }
    // 只保留列表本身：去掉 "Ignored build scripts ... :" 前缀与 "Run ..." 建议
    const colonIdx = region.indexOf(':');
    region = colonIdx >= 0
      ? region.slice(colonIdx + 1)
      : region.replace(/^ignored build scripts\s*/i, '');
    regions.push(region);
  }
  // 2) `build scripts were blocked: a, b`（pnpm 9/10 onlyBuiltDependencies 措辞）
  for (const m of text.matchAll(/build scripts were blocked[:\s][^\r\n]*/gi)) {
    const region = m[0];
    const colonIdx = region.indexOf(':');
    regions.push(colonIdx >= 0 ? region.slice(colonIdx + 1) : region.replace(/^build scripts were blocked\s*/i, ''));
  }
  // 3) `prepare/install/postinstall script of "name"` 单名形态
  for (const m of text.matchAll(/(?:prepare|install|postinstall|uninstall) script of\s+["']?(@?[A-Za-z0-9][\w.@/-]*)["']?/gi)) {
    keys.push(m[1].replace(/[.,;:]+$/, ''));
  }
  for (const region of regions) pushKeys(region);
  return keys;
}

// 解析 pnpm-workspace.yaml 里 allowBuilds / onlyBuiltDependencies 的键。
export function readAllowBuilds(workspacePath) {
  let text;
  try {
    text = fs.readFileSync(workspacePath, 'utf8');
  } catch {
    return [];
  }
  return collectBlockKeys(text);
}

function collectBlockKeys(text) {
  const keys = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    const head = line.match(/^\s*(allowBuilds|onlyBuiltDependencies)\s*:(.*)$/);
    if (head) {
      inBlock = true;
      const inline = head[2].trim();
      if (inline.startsWith('[') && inline.endsWith(']')) {
        for (const tok of inline.slice(1, -1).split(',')) {
          const k = tok.trim().replace(/^["']|["']$/g, '');
          if (k && KEY_RE.test(k)) keys.push(k);
        }
      }
      continue;
    }
    if (inBlock) {
      const item = line.match(/^\s*-\s*(\S+)\s*$/);
      if (item) {
        const k = item[1].replace(/^["']|["']$/g, '').replace(/[.,;]+$/, '');
        if (KEY_RE.test(k)) keys.push(k);
      } else if (line.trim() && !line.trim().startsWith('#')) {
        inBlock = false; // 下一个顶层键
      }
    }
  }
  return keys;
}

// 确保 workspace 的 allowBuilds（兼容旧名 onlyBuiltDependencies）包含 keys。
// 返回 { path, keys, added, existed, wrote }；wrote 表示发生了写入。
export function ensureAllowBuilds(workspacePath, keys) {
  const wanted = Array.isArray(keys)
    ? [...new Set(keys.map(String).filter((k) => KEY_RE.test(k)))]
    : [];
  let text = '';
  let existed = false;
  try {
    text = fs.readFileSync(workspacePath, 'utf8');
    existed = true;
  } catch {}
  const existing = existed ? collectBlockKeys(text) : [];
  const added = wanted.filter((k) => !existing.includes(k));
  if (added.length === 0) {
    return { path: workspacePath, keys: [...new Set([...existing, ...wanted])], added: [], existed, wrote: false };
  }

  let lines = existed ? text.split(/\r?\n/) : [];
  let headerIdx = -1;
  let headerName = '';
  if (existed) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(allowBuilds|onlyBuiltDependencies)\s*:/);
      if (m) { headerIdx = i; headerName = m[1]; break; }
    }
  }
  if (!existed) {
    lines = ['# pnpm-workspace.yaml (dsh-desktop v4.2 自动放行构建脚本)', 'packages:', '  - ./*', ''];
  }
  if (headerIdx >= 0) {
    const header = lines[headerIdx];
    const inline = header.split(':').slice(1).join(':').trim();
    const inlineKeys = [];
    if (inline.startsWith('[') && inline.endsWith(']')) {
      for (const tok of inline.slice(1, -1).split(',')) {
        const k = tok.trim().replace(/^["']|["']$/g, '');
        if (k && KEY_RE.test(k) && !inlineKeys.includes(k)) inlineKeys.push(k);
      }
    }
    if (inlineKeys.length) {
      lines[headerIdx] = headerName + ':';
      // 清掉旧块序列行（若有），避免与重写的块重复
      let j = headerIdx + 1;
      while (j < lines.length && /^\s*-/.test(lines[j])) j++;
      lines = [...lines.slice(0, headerIdx + 1), ...lines.slice(j)];
      const all = [...inlineKeys, ...added];
      lines.splice(headerIdx + 1, 0, ...all.map((k) => '  - ' + k));
    } else {
      const tail = lines.slice(headerIdx + 1);
      let j = 0;
      while (j < tail.length && /^\s*-/.test(tail[j])) j++;
      lines = [...lines.slice(0, headerIdx + 1), ...tail.slice(j)];
      const all = [...existing, ...added];
      lines.splice(headerIdx + 1, 0, ...all.map((k) => '  - ' + k));
    }
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('allowBuilds:');
    lines.push(...added.map((k) => '  - ' + k));
  }
  let out = lines.join('\n');
  if (existed && !out.endsWith('\n')) out += '\n';
  fs.writeFileSync(workspacePath, out, 'utf8');
  return {
    path: workspacePath,
    keys: [...new Set([...existing, ...added])],
    added,
    existed,
    wrote: true,
  };
}
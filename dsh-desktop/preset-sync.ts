'use strict';

// Bundled agent-preset sync.
//
// Ships community presets (e.g. the experimental "anchored-standard": the
// first model request is anchored on the official Minimal tool pair, then the
// full Standard catalog opens after the first durable tool call / reply)
// inside assets/agent-presets/<name>/ and installs them into the user's
// preset root (${DSH_HOME:-~/.dsh}/.agent-presets) at boot.
//
// Presets are plain composition directories, NOT cordis plugin rows: they
// never enter the profile plugin tree, so a bad preset cannot reproduce the
// v2.0.0 "plugin tree failed to load" crash loop — the worst case is that one
// preset failing to mount for a session that explicitly selected it.
//
// Skip-if-exists: an existing target directory is never overwritten, matching
// the upstream install guidance — user edits and manually installed copies
// always win over the bundled copy.

import fs = require('node:fs');
import path = require('node:path');

function syncBundledPresets(assetsRoot: string, presetsRoot: string, log: (m: string) => void = () => {}) {
  const installed: string[] = [];
  const kept: string[] = [];
  let entries;
  try { entries = fs.readdirSync(assetsRoot, { withFileTypes: true }); } catch { return { installed, kept }; }
  fs.mkdirSync(presetsRoot, { recursive: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(assetsRoot, entry.name);
    // Shared resource directories (upstream `_preset/`): preset manifests
    // reference them as `../_preset/<file>.mjs`, so they must be installed
    // next to the presets. Same skip-if-exists semantics.
    if (entry.name.startsWith('_')) {
      const sharedDest = path.join(presetsRoot, entry.name);
      if (fs.existsSync(sharedDest)) continue;
      try {
        fs.cpSync(src, sharedDest, { recursive: true });
        log('installed bundled preset shared dir: ' + entry.name);
      } catch (err) {
        log('failed to install bundled preset shared dir ' + entry.name + ': ' + String(((err as Error) && (err as Error).message) || err));
      }
      continue;
    }
    // A preset directory must carry preset.yml; anything else in assets is
    // not a preset and is ignored.
    if (!fs.existsSync(path.join(src, 'preset.yml'))) continue;
    const dest = path.join(presetsRoot, entry.name);
    if (fs.existsSync(dest)) {
      kept.push(entry.name);
      continue;
    }
    try {
      fs.cpSync(src, dest, { recursive: true });
      installed.push(entry.name);
      log('installed bundled agent preset: ' + entry.name);
    } catch (err) {
      log('failed to install bundled agent preset ' + entry.name + ': ' + String(((err as Error) && (err as Error).message) || err));
    }
  }
  return { installed, kept };
}

/**
 * 把内置推荐 preset 设为新会话的默认（dsh 的 agent-presets settings 命名
 * 空间，落盘在 <home>/settings.yaml 的 `agent-presets.default` 字段，见
 * @deepseek-ai/dsh-agent-presets 的 SETTINGS_NAMESPACE）。
 *
 * 保守的文本级 YAML 编辑（不引 yaml 依赖）：
 *   · 用户已写过 `default:`（任意值）→ 一律保留（'kept'）；
 *   · 已有 `agent-presets:` 块状 section 但缺 default → 紧随头行插入；
 *   · 没有 section → 文件末尾追加；
 *   · 识别不了的结构（内联 flow、非顶层同名键）→ 跳过（'skipped'），
 *     宿主回落官方默认 preset，绝不破坏用户的 settings.yaml。
 * 指名的 preset 目录不存在时也跳过（默认值不能指向缺失的 preset）。
 */
function ensureDefaultAgentPreset(home: string, presetId: string, log: (m: string) => void = () => {}) {
  try {
    if (!fs.existsSync(path.join(home, '.agent-presets', presetId, 'preset.yml'))) return 'skipped';
    const file = path.join(home, 'settings.yaml');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
    let bom = false;
    if (text.charCodeAt(0) === 0xFEFF) { bom = true; text = text.slice(1); }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const blockHeader = /^agent-presets[ \t]*:[ \t]*(?:#.*)?$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^agent-presets[ \t]*:/.test(line)) continue;
      if (!blockHeader.test(line)) {
        // 内联 flow（agent-presets: {…}）等非块状结构：识别不了，不碰。
        log('settings.yaml 的 agent-presets section 不是块状结构，保持不动');
        return 'skipped';
      }
      // section 体：到下一个顶层键（或文件尾）为止。
      let end = i + 1;
      while (end < lines.length && !/^\S/.test(lines[end])) end++;
      for (let k = i + 1; k < end; k++) {
        if (/^[ \t]+default[ \t]*:/.test(lines[k])) return 'kept';
      }
      lines.splice(i + 1, 0, '  default: ' + presetId);
      fs.writeFileSync(file, (bom ? '\uFEFF' : '') + lines.join(eol));
      return 'set';
    }
    // 缩进出现的 agent-presets 键（嵌套在别的 section 里）不归我们管，
    // 直接追加顶层 section 不会与之冲突。
    const trailing = text === '' || text.endsWith(eol) ? '' : eol;
    fs.writeFileSync(file, (bom ? '\uFEFF' : '') + text + trailing + 'agent-presets:' + eol + '  default: ' + presetId + eol);
    return 'set';
  } catch (err) {
    log('设置默认 agent preset 失败: ' + String(((err as Error) && (err as Error).message) || err));
    return 'skipped';
  }
}

module.exports = { syncBundledPresets, ensureDefaultAgentPreset };

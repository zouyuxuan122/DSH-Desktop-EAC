/**
 * preset-sync.ts — 内置 agent-preset 同步（Task 7.1 自 preset-sync.js 迁 TS）。
 *
 * 把社区 preset（如实验性的 "anchored-standard"：首个模型请求锚定官方
 * Minimal 工具对，首次持久工具调用/回复后开放完整 Standard 目录）随
 * assets/agent-presets/<name>/ 分发，boot 时安装到用户的 preset 根
 * （${DSH_HOME:-~/.dsh}/.agent-presets）。
 *
 * preset 是纯组合目录，不是 cordis 插件行：永不进 profile 插件树，坏
 * preset 不可能复现 v2.0.0「插件树加载失败」崩溃循环 —— 最坏情况只是显式
 * 选择它的那个会话挂载失败。
 *
 * Skip-if-exists：已存在的目标目录绝不覆盖（与上游安装指引一致）—— 用户
 * 手改与手工安装的副本永远优先于内置副本。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** syncBundledPresets 的结果。 */
export interface PresetSyncResult {
  installed: string[];
  kept: string[];
}

/** 安装 assets/agent-presets 下的全部内置 preset（skip-if-exists）。 */
export function syncBundledPresets(
  assetsRoot: string,
  presetsRoot: string,
  log: (msg: string) => void = (): void => {},
): PresetSyncResult {
  const installed: string[] = [];
  const kept: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(assetsRoot, { withFileTypes: true });
  } catch {
    return { installed, kept };
  }
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
        log('failed to install bundled preset shared dir ' + entry.name + ': ' + String((err as Error).message));
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
      log('failed to install bundled agent preset ' + entry.name + ': ' + String((err as Error).message));
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
export function ensureDefaultAgentPreset(
  home: string,
  presetId: string,
  log: (msg: string) => void = (): void => {},
): 'set' | 'kept' | 'skipped' {
  try {
    if (!fs.existsSync(path.join(home, '.agent-presets', presetId, 'preset.yml'))) return 'skipped';
    const file = path.join(home, 'settings.yaml');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    let bom = false;
    if (text.charCodeAt(0) === 0xfeff) {
      bom = true;
      text = text.slice(1);
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const blockHeader = /^agent-presets[ \t]*:[ \t]*(?:#.*)?$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!/^agent-presets[ \t]*:/.test(line)) continue;
      if (!blockHeader.test(line)) {
        // 内联 flow（agent-presets: {…}）等非块状结构：识别不了，不碰。
        log('settings.yaml 的 agent-presets section 不是块状结构，保持不动');
        return 'skipped';
      }
      // section 体：到下一个顶层键（或文件尾）为止。
      let end = i + 1;
      while (end < lines.length && !/^\S/.test(lines[end] as string)) end++;
      for (let k = i + 1; k < end; k++) {
        if (/^[ \t]+default[ \t]*:/.test(lines[k] as string)) return 'kept';
      }
      lines.splice(i + 1, 0, '  default: ' + presetId);
      fs.writeFileSync(file, (bom ? '﻿' : '') + lines.join(eol));
      return 'set';
    }
    // 缩进出现的 agent-presets 键（嵌套在别的 section 里）不归我们管，
    // 直接追加顶层 section 不会与之冲突。
    const trailing = text === '' || text.endsWith(eol) ? '' : eol;
    fs.writeFileSync(file, (bom ? '﻿' : '') + text + trailing + 'agent-presets:' + eol + '  default: ' + presetId + eol);
    return 'set';
  } catch (err) {
    log('设置默认 agent preset 失败: ' + String((err as Error).message));
    return 'skipped';
  }
}

'use strict';

import fs = require('node:fs');
import path = require('node:path');
const yaml = require('js-yaml');

const OLD_ENGINE = '@deepseek-ai/dsh-compaction-basic';
const TRANSITION_ENGINE = 'dsh-compact/engine';
const NEW_AGENT = 'dsh-compact/agent';
const MANAGED_PRESETS = Object.freeze([
  'anchored-standard',
  'router-standard',
  'v4-flash-godmode-opencode-go',
  'warmupbetter',
  'warmupbetter-replay',
  'whoami-standard',
  'zero-anchored-standard',
]);

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: unknown): Record<string, unknown> => ({ __jsExpr: data }),
});
const DSH_YAML_SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr);

function parsePreset(text: string): unknown {
  return yaml.load(text, { schema: DSH_YAML_SCHEMA });
}

function readPrunerConfig(block: string): string[] {
  const lines = block.split('\n');
  const start = lines.findIndex((line: string) => /^\s*-\s*id:\s*tool-result-pruner\s*(?:#.*)?$/.test(line));
  if (start < 0) return [];
  const result: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:\s*/.test(lines[i]!)) break;
    const match = /^\s+(thresholdChars|headChars|tailChars):(\s*.+)$/.exec(lines[i]!);
    if (match) result.push(`    ${match[1]}:${match[2]}`);
  }
  return result;
}

function compactionSectionBodyStart(lines: string[], groupIndex: number): number {
  for (let i = groupIndex - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) {
      if (/^# ── compaction\b/.test(line)) return i + 1;
      continue;
    }
    break;
  }
  return groupIndex;
}

function replaceCompactionGroup(text: string): { text: string; changed: boolean } {
  if (typeof text !== 'string' || text === '') return { text, changed: false };
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (let i = 0; i < lines.length; i++) {
    if (!/^- id:\s*compaction\s*(?:#.*)?$/.test(lines[i]!)) continue;
    let end = i + 1;
    while (
      end < lines.length
      && !/^- id:\s*/.test(lines[end]!)
      && !/^# ── /.test(lines[end]!)
    ) end += 1;
    const block = lines.slice(i, end).join('\n');
    const hasEngine = block.includes(`name: '${OLD_ENGINE}'`)
      || block.includes(`name: "${OLD_ENGINE}"`)
      || block.includes(`name: '${TRANSITION_ENGINE}'`)
      || block.includes(`name: "${TRANSITION_ENGINE}"`);
    if (!hasEngine || !/\bid:\s*command-compact\b/.test(block) || !/\bid:\s*tool-result-pruner\b/.test(block)) {
      return { text, changed: false };
    }
    const replacement = [
      '- id: compact-agent',
      `  name: '${NEW_AGENT}'`,
      '  isolate:',
      '    compaction: true',
      '    toolResultPruner: true',
    ];
    const prunerConfig = readPrunerConfig(block);
    if (prunerConfig.length) replacement.push('  config:', ...prunerConfig);
    const start = compactionSectionBodyStart(lines, i);
    if (start < i) {
      replacement.unshift(
        '',
        '# `dsh-compact/agent` keeps the engine, `/compact` command, and tool-result',
        '# pruner in one agent-local realm while exposing a single product-level entry.',
      );
    }
    lines.splice(start, end - start, ...replacement);
    return { text: lines.join(eol), changed: true };
  }
  return { text, changed: false };
}

function migratePresetFile(file: string, log: (m: string) => void = () => {}) {
  let before;
  try { before = fs.readFileSync(file, 'utf8'); } catch { return { status: 'missing', file }; }
  try { parsePreset(before); } catch (error) {
    log(`跳过无法解析的 preset: ${file}: ${((error as Error) && (error as Error).message) || error}`);
    return { status: 'invalid', file, error: ((error as Error) && (error as Error).message) || error };
  }
  const replaced = replaceCompactionGroup(before);
  if (!replaced.changed) return { status: 'kept', file };
  try { parsePreset(replaced.text); } catch (error) {
    log(`跳过迁移后无法解析的 preset: ${file}: ${((error as Error) && (error as Error).message) || error}`);
    return { status: 'invalid-result', file, error: ((error as Error) && (error as Error).message) || error };
  }
  const backup = file + '.bak';
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    const temp = file + `.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, replaced.text, 'utf8');
    fs.renameSync(temp, file);
    return { status: 'migrated', file, backup };
  } catch (error) {
    log(`迁移 preset 失败: ${file}: ${((error as Error) && (error as Error).message) || error}`);
    return { status: 'failed', file, error: ((error as Error) && (error as Error).message) || error };
  }
}

function migrateManagedCompactPresets(presetsRoot: string, log: (m: string) => void = () => {}) {
  return MANAGED_PRESETS.map((name) => migratePresetFile(
    path.join(presetsRoot, name, 'agent.cordis.yml'),
    log,
  ));
}

export = {
  MANAGED_PRESETS,
  NEW_AGENT,
  OLD_ENGINE,
  TRANSITION_ENGINE,
  DSH_YAML_SCHEMA,
  migrateManagedCompactPresets,
  migratePresetFile,
  parsePreset,
  replaceCompactionGroup,
};

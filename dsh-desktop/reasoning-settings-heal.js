'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NATIVE_REASONING_PROVIDERS = new Set([
  'deepseek',
  'deepseek-official',
  'deepseek-vision',
]);

function yamlScalar(value) {
  const withoutComment = String(value || '').replace(/\s+#.*$/, '').trim();
  if (
    withoutComment.length >= 2 &&
    ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
      (withoutComment.startsWith("'") && withoutComment.endsWith("'")))
  ) {
    return withoutComment.slice(1, -1).trim();
  }
  return withoutComment;
}

function removeUnsupportedOffReasoning(input) {
  let text = String(input == null ? '' : input);
  const hasBom = text.charCodeAt(0) === 0xFEFF;
  if (hasBom) text = text.slice(1);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const header = /^agent-default-model[ \t]*:[ \t]*(?:#.*)?$/;

  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || /^[ \t]/.test(lines[end]))) end++;

    let provider = '';
    let reasoningIndex = -1;
    let reasoning = '';
    for (let j = i + 1; j < end; j++) {
      const providerMatch = lines[j].match(/^[ \t]+provider[ \t]*:[ \t]*(.*)$/);
      if (providerMatch) provider = yamlScalar(providerMatch[1]).toLowerCase();
      const reasoningMatch = lines[j].match(/^[ \t]+reasoningEffort[ \t]*:[ \t]*(.*)$/);
      if (reasoningMatch) {
        reasoningIndex = j;
        reasoning = yamlScalar(reasoningMatch[1]).toLowerCase();
      }
    }

    if (
      provider &&
      !NATIVE_REASONING_PROVIDERS.has(provider) &&
      reasoningIndex >= 0 &&
      reasoning === 'off'
    ) {
      lines.splice(reasoningIndex, 1);
      return { text: (hasBom ? '\uFEFF' : '') + lines.join(eol), changed: true, provider };
    }
    return { text: String(input == null ? '' : input), changed: false, provider };
  }

  return { text: String(input == null ? '' : input), changed: false, provider: '' };
}

function healUnsupportedOffReasoning(home, log = () => {}) {
  const file = path.join(home, 'settings.yaml');
  let before;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch {
    return 'missing';
  }

  const result = removeUnsupportedOffReasoning(before);
  if (!result.changed) return 'kept';

  try {
    const temp = file + '.reasoning-heal.tmp';
    fs.writeFileSync(temp, result.text, 'utf8');
    fs.renameSync(temp, file);
    log('已移除第三方 provider ' + result.provider + ' 不兼容的 reasoningEffort: off');
    return 'healed';
  } catch (error) {
    log('修复第三方模型 reasoningEffort 配置失败: ' + error.message);
    return 'failed';
  }
}

module.exports = {
  NATIVE_REASONING_PROVIDERS,
  removeUnsupportedOffReasoning,
  healUnsupportedOffReasoning,
};

// Reviewed WebUI 0.5.1 only. Owners verified at upstream c389f96 / alpha.2:
// SessionSnapshot lifecycle; ChatSnapshot.legacy timings/partial; InputState.
const oldFace = `const faceRef = (0, react.useRef)(props);
\t\t\tfaceRef.current = props;`;
const newFace = `const session = props.useSession((snapshot) => snapshot);
\t\t\tconst chat = props.useChat((snapshot) => snapshot);
\t\t\tconst input = props.useInput((snapshot) => snapshot);
\t\t\tconst face = {
\t\t\t\t...props,
\t\t\t\tsession: { ...session, chat, turnTimings: chat.legacy.turnTimings, partial: chat.legacy.partial },
\t\t\t\tinput
\t\t\t};
\t\t\tconst faceRef = (0, react.useRef)(face);
\t\t\tfaceRef.current = face;`;

const statsFallback = `\t\t\tconst formatStat = (key, values) => {
\t\t\t\tconst translated = t(key, values);
\t\t\t\tif (typeof translated === "string" && !translated.startsWith("stats.")) return translated;
\t\t\t\tconst fallback = {
\t\t\t\t\t"stats.counts": () => \`\${values.turns} 轮 · \${values.steps} 步\`,
\t\t\t\t\t"stats.llm": () => \`LLM \${values.duration}\`,
\t\t\t\t\t"stats.toolCall": () => \`工具调用 \${values.duration}\`,
\t\t\t\t\t"stats.ttftAverage": () => \`首 token 平均 \${values.duration}\`,
\t\t\t\t\t"stats.cacheHit": () => \`缓存命中 \${values.percent}%\`,
\t\t\t\t\t"stats.tokens": () => \`输入 \${values.input} tok · 输出 \${values.output} tok\`
\t\t\t\t}[key];
\t\t\t\treturn fallback === void 0 ? translated : fallback();
\t\t\t};`;

function replaceRegion(source, start, replacements) {
  const from = source.indexOf(start);
  const to = source.indexOf('//#endregion', from);
  if (from < 0 || to < from || source.indexOf(start, from + start.length) >= 0) {
    throw new Error(`Unrecognized WebUI continue/stats region: ${start}`);
  }
  const original = source.slice(from, to);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let region = original.replace(/\r\n/g, '\n');
  for (const [old, current] of replacements) {
    if (region.includes(current) && !region.includes(old)) continue;
    if (region.split(old).length !== 2) {
      throw new Error(`Unrecognized WebUI continue/stats boundary: ${old}`);
    }
    region = region.replace(old, current);
  }
  return source.slice(0, from) + region.replace(/\n/g, newline) + source.slice(to);
}

export function migrateWebuiContinue(source) {
  let output = replaceRegion(source, 'function ComposerContinueEnhancer(props)', [[oldFace, newFace]]);
  const statsReplacements = [
    ['StatsLineShadow({ useSession, useProjection, t })', 'StatsLineShadow({ useChat, useProjection, t })'],
    ['useSession((s) => s.chat.legacy.nodes)', 'useChat((s) => s.legacy.nodes)'],
    ['groups.push(t("stats.counts",', 'groups.push(formatStat("stats.counts",'],
    ['durations.push(t("stats.llm",', 'durations.push(formatStat("stats.llm",'],
    ['durations.push(t("stats.toolCall",', 'durations.push(formatStat("stats.toolCall",'],
    ['speeds.push(t("stats.ttftAverage",', 'speeds.push(formatStat("stats.ttftAverage",'],
    ['groups.push(t("stats.cacheHit",', 'groups.push(formatStat("stats.cacheHit",'],
    ['groups.push(t("stats.tokens",', 'groups.push(formatStat("stats.tokens",'],
    ['\t\t\t\tif (stats.decodeMs > 0) speeds.push(t("stats.tokensPerSecond", { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) }));\n', ''],
    ['\t\t\t\tif (stats.decodeMs > 0) speeds.push(formatStat("stats.tokensPerSecond", { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) }));\n', ''],
  ];
  if (!output.includes('const formatStat = (key, values) => {')) {
    statsReplacements.unshift(['\t\t\tconst groups = [];', `${statsFallback}\n\t\t\tconst groups = [];`]);
  }
  output = replaceRegion(output, 'const StatsLineShadow = ', statsReplacements);
  return output;
}

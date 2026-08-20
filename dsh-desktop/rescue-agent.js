'use strict';

// rescue-agent.js — 崩溃救援代理（纯函数核心，零 electron 依赖）
//
// 背景：dsh web 服务器把插件跑在同一个进程里，插件崩溃 = 整个 agent 停摆。
// 桌面壳（Electron 主进程）永远存活，是唯一能在「服务器死后」继续工作的
// 位置。本模块为壳层提供救援能力：
//
//   · collectDiagnosis —— 聚合事故报告 / 日志尾部 / profile 配置面 / 快照 /
//     插件清单，产出「发送内容清单」（用户确认）与发给 AI 的诊断 payload；
//   · buildDiagnosisPrompt / parseAiResponse / validateSuggestion —— 只读
//     诊断链：提示词约束 AI 只输出动作白名单建议，解析容错（非 JSON / 畸形
//     结构一律丢弃，绝不执行）；
//   · applySuggestion 分发 —— 白名单动作（restore / disable / remove /
//     repair / safe-mode / retry），副作用经注入的 exec 完成；
//   · safeModePatch —— 壳层安全模式：把 cordis.patch.yml 改成只含核心插件
//     的裸启动配置（复用 scripts/plugin-manager-patch 的纯文本手术）；
//   · recordBootFailure / shouldEnterRescue —— 跨会话崩溃循环计数：连续多次
//     启动失败不再无限自动重试，直接进救援页。
//
// 存活原则（对齐 plugin-guard / renderer-recovery）：
//   · 本模块所有函数绝不在意外抛错：读取失败按空/缺省处理，解析失败返回
//     { ok:false, error } 而不是 throw；
//   · 日志尾部读取走 seek 只读（大文件不整读、不常驻内存）；
//   · 网络调用带连接+响应双超时与响应大小上限，失败降级为手动模式；
//   · 一切修复动作由 main.js 注入执行器完成，本模块只做校验与分发。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { removePluginFromPatch } = require('./scripts/plugin-manager-patch');

const DEFAULT_OPTS = {
  // 每个日志文件最多读尾部这么多字节（大日志文件不整读）。
  LOG_TAIL_BYTES: 48 * 1024,
  // profile 配置面（package.json / cordis.patch.yml 等）单文件读取上限。
  PROFILE_TEXT_MAX: 32 * 1024,
  // 单个事故报告读取上限。
  INCIDENT_MAX: 30 * 1024,
  // 发送给 AI 的诊断 payload 总上限（超限裁剪，先裁旧事故报告再裁日志）。
  DIAG_TOTAL_MAX: 384 * 1024,
  // AI 建议数量上限（防刷屏/防注入大量假动作）。
  MAX_SUGGESTIONS: 10,
  // AI 调用：连接超时 + 响应体大小上限。
  AI_TIMEOUT_MS: 60 * 1000,
  AI_RESPONSE_MAX: 1024 * 1024,
  // 诊断用模型：便宜快速的档位足够（官方 v4-flash）。
  MODEL: 'deepseek-v4-flash',
  // 崩溃循环窗口与阈值：窗口内连续 N 次启动失败 → 进救援页。
  BOOT_FAILURE_WINDOW_MS: 30 * 60 * 1000,
  BOOT_FAILURE_THRESHOLD: 3,
};

// ── 尾部读取（大文件安全）────────────────────────────────────────────
// open + fstat + seek 到末尾附近再读，绝不对大文件 readFileSync 全量加载。
function readTail(file, maxBytes) {
  try {
    if (!maxBytes || maxBytes <= 0) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (st.size <= 0) return '';
      const want = Math.min(Number(maxBytes), st.size);
      const buf = Buffer.alloc(want);
      const read = fs.readSync(fd, buf, 0, want, st.size - want);
      let text = buf.slice(0, read).toString('utf8');
      // 从第二个换行开始截断，避免把半行截断（首行可能被切一半）。
      if (want < st.size) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      return text;
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  } catch {
    return '';
  }
}

// ── 诊断收集（collectDiagnosis）────────────────────────────────────────
// ctx 注入：
//   dshHome / profileDir / logsDir / userDataDir —— 路径
//   versions: { app, dsh, source }                        —— 版本
//   plugins: () => Array                                   —— 插件行（含 core/removed）
//   snapshots: () => Array                                 —— 快照列表
//   lastGood: () => object|null                            —— 最后良好快照
//   incidents: () => Array                                 —— 事故列表
//   readIncident: (id) => string|null                      —— 事故全文
//   health: () => Array                                    —— 体检 findings
//   attribution: () => object|null                         —— 启动失败归因
//   lastErrText: () => string|null                         —— 最近一次启动失败文案
// 单项失败按空处理，绝不抛错。返回 { ok:true, sendManifest, payload, totalBytes }。
function collectDiagnosis(ctx, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const profileDir = String(ctx.profileDir || '');
  const logsDir = String(ctx.logsDir || '');
  const home = String(ctx.dshHome || '');

  const readProfileFile = (name, max) => {
    if (!profileDir) return '';
    return readTail(path.join(profileDir, name), max || o.PROFILE_TEXT_MAX);
  };

  // 事故报告：优先最近的，总量控制在裁剪预算内。
  const incidentList = safe(() => ctx.incidents(), []);
  const incidents = [];
  let incBytes = 0;
  for (const inc of incidentList.slice(0, 6)) {
    const content = safe(() => ctx.readIncident(inc.id), null);
    if (!content) continue;
    const body = String(content).slice(0, o.INCIDENT_MAX);
    incBytes += body.length;
    if (incBytes > o.DIAG_TOTAL_MAX / 2) break;
    incidents.push({ id: inc.id, title: inc.title || inc.id, body });
  }

  const snapshots = safe(() => ctx.snapshots(), []);
  const lastGood = safe(() => ctx.lastGood(), null);
  const plugins = safe(() => ctx.plugins(), []);
  const health = safe(() => ctx.health(), []);
  const attribution = safe(() => ctx.attribution(), null);
  const lastErr = String(safe(() => ctx.lastErrText(), '') || '').slice(0, 8000);

  const profile = {
    patchText: readProfileFile('cordis.patch.yml'),
    packageJson: readProfileFile('package.json'),
    workspaceYaml: readProfileFile('pnpm-workspace.yaml'),
    builtinList: readProfileFile('.dsh-builtin-plugins.json'),
  };
  const logs = {
    'dsh-web.log': readTail(path.join(logsDir, 'dsh-web.log'), o.LOG_TAIL_BYTES),
    'desktop.log': readTail(path.join(logsDir, 'desktop.log'), o.LOG_TAIL_BYTES),
  };

  const payload = {
    env: {
      at: new Date().toISOString(),
      appVersion: String(ctx.versions && ctx.versions.app || ''),
      dshVersion: String(ctx.versions && ctx.versions.dsh || ''),
      agentSource: String(ctx.versions && ctx.versions.source || ''),
      profile: String(ctx.profile || ''),
      dshHome: home || '(dsh 默认)',
      platform: process.platform,
    },
    lastBootError: lastErr || null,
    attribution,
    healthFindings: Array.isArray(health) ? health : [],
    plugins: Array.isArray(plugins) ? plugins.map((p) => ({
      id: p.id, name: p.name, enabled: p.enabled === true, core: p.core === true,
      toggleable: p.toggleable === true, removed: p.removed === true, group: p.group || '',
    })) : [],
    snapshots: Array.isArray(snapshots) ? snapshots.map((s) => ({
      id: s.id, reason: s.reason || '', at: s.at || '',
    })) : [],
    lastGood: lastGood ? { id: lastGood.id, reason: lastGood.reason || '' } : null,
    incidents,
    profile,
    logs,
  };

  const sendManifest = [
    { kind: '版本环境', name: '版本与目录摘要', size: JSON.stringify(payload.env).length },
    ...(lastErr ? [{ kind: '启动失败', name: '最近启动错误文案', size: lastErr.length }] : []),
    ...(health.length ? [{ kind: '体检', name: `规则体检发现 ${health.length} 项`, size: JSON.stringify(health).length }] : []),
    ...(plugins.length ? [{ kind: '插件清单', name: `${plugins.length} 个插件（含启停状态）`, size: JSON.stringify(plugins).length }] : []),
    ...(snapshots.length ? [{ kind: '快照', name: `${snapshots.length} 份快照（含最后良好）`, size: JSON.stringify(snapshots).length }] : []),
    ...incidents.map((i) => ({ kind: '事故报告', name: i.title, size: i.body.length })),
    ...Object.entries(profile).filter(([, v]) => v).map(([k, v]) => ({ kind: '配置面', name: k, size: v.length })),
    ...Object.entries(logs).filter(([, v]) => v).map(([k, v]) => ({ kind: '日志尾部', name: k, size: v.length })),
  ];

  return {
    ok: true,
    totalBytes: JSON.stringify(payload).length,
    sendManifest,
    payload,
  };
}

// ── 发送裁剪（filterDiagnosisPayload）─────────────────────────────────
// 用户确认清单里取消勾选的项不发送。selectedNames 为 sendManifest 中被勾选
// 的 name 列表（空数组 = 全部发送）。env（版本环境）不可取消，始终保留。
function filterDiagnosisPayload(payload, manifest, selectedNames) {
  if (!Array.isArray(selectedNames) || selectedNames.length === 0) return payload;
  const sel = new Set(selectedNames.map(String));
  const kinds = new Set(manifest.filter((m) => sel.has(m.name)).map((m) => m.kind));
  const out = {
    ...payload,
    env: payload.env,
    incidents: kinds.has('事故报告') ? payload.incidents : [],
    plugins: kinds.has('插件清单') ? payload.plugins : [],
    snapshots: kinds.has('快照') ? payload.snapshots : [],
    lastGood: kinds.has('快照') ? payload.lastGood : null,
    healthFindings: kinds.has('体检') ? payload.healthFindings : [],
    lastBootError: kinds.has('启动失败') ? payload.lastBootError : null,
  };
  out.logs = {};
  if (kinds.has('日志尾部')) {
    for (const [k, v] of Object.entries(payload.logs || {})) {
      if (manifest.some((m) => m.kind === '日志尾部' && m.name === k && sel.has(m.name))) out.logs[k] = v;
    }
  }
  out.profile = {};
  if (kinds.has('配置面')) {
    for (const [k, v] of Object.entries(payload.profile || {})) {
      if (manifest.some((m) => m.kind === '配置面' && m.name === k && sel.has(m.name))) out.profile[k] = v;
    }
  }
  return out;
}

// ── 提示词构建（buildDiagnosisPrompt）──────────────────────────────────
// 系统提示词约束：只诊断、只输出动作白名单内的 JSON 建议、绝不虚构文件内容。
const ACTION_SPEC = [
  { action: 'restore', params: { snapshotId: '快照 id（来自诊断上下文 snapshots 列表）' }, desc: '回滚 profile 配置到指定快照' },
  { action: 'disable', params: { pluginId: '插件 id（来自 plugins 列表）' }, desc: '停用某个插件（写盘停用，重启不还原）' },
  { action: 'remove', params: { pluginId: '插件 id' }, desc: '卸载某个内置插件（清 patch 行与包副本）' },
  { action: 'repair', params: {}, desc: '执行规则体检修复（patch 行 / 模块遮蔽 / junction）' },
  { action: 'safe-mode', params: { on: 'true=开启安全模式（只留核心插件裸启动），false=恢复' }, desc: '壳层安全模式开关' },
  { action: 'retry', params: {}, desc: '重新启动 Web 服务（走守护启动全链路）' },
  { action: 'export', params: {}, desc: '建议用户导出诊断 zip（不自动执行）' },
];

function buildDiagnosisPrompt(diag) {
  const o = Object.assign({}, DEFAULT_OPTS);
  const spec = ACTION_SPEC.map((a) => (
    `  - action: "${a.action}"\n` +
    `    params: ${JSON.stringify(a.params)}\n` +
    `    desc: ${a.desc}`
  )).join('\n');
  return [
    '你是 DeepSeek Harness 桌面客户端的救援诊断助手。你的任务是根据下方诊断上下文判断客户端无法工作的原因。',
    '',
    '规则：',
    '1. 只做只读诊断，绝不臆造文件内容或日志中不存在的事实。',
    '2. 输出必须是且仅是一个合法 JSON 对象（不要 Markdown、不要解释文字）：',
    '   {',
    '     "analysis": "对根因的分析（中文，300 字内）",',
    '     "suggestions": [',
    '       { "action": "<动作>", "params": {...}, "reason": "为什么这么做（中文）", "risk": "low|medium|high" }',
    '     ]',
    '   }',
    '3. suggestions 只能从以下动作白名单中选择，params 必须与规格一致：',
    spec,
    '4. 若无法确定根因，analysis 说明疑点，suggestions 只给最保守的项（如 retry 或 export）。',
    '5. 最多给出 4 条建议，按实施顺序排列。',
    '',
    '=== 诊断上下文（JSON） ===',
    JSON.stringify(diag, null, 2),
  ].join('\n');
}

// ── AI 响应解析（parseAiResponse，容错但不迁就）────────────────────────
// 接受：裸 JSON、```json 包裹、前后有说明文字。解析失败 / 结构不符 /
// 动作不在白名单 → 丢弃并返回错误描述，绝不执行。
function parseAiResponse(text, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'AI 返回为空' };
  let json = null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) {
    try { json = JSON.parse(fence[1].trim()); } catch { json = null; }
  }
  if (json === null) {
    try { json = JSON.parse(raw); } catch { json = null; }
  }
  if (json === null) {
    // 最后尝试：截取首个 { 到末个 }（容忍模型输出的前后缀文字）。
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try { json = JSON.parse(raw.slice(s, e + 1)); } catch { json = null; }
    }
  }
  if (json === null || typeof json !== 'object') {
    return { ok: false, error: 'AI 返回不是合法 JSON' };
  }
  const analysis = typeof json.analysis === 'string' ? json.analysis.slice(0, 2000) : '';
  const rawList = Array.isArray(json.suggestions) ? json.suggestions : [];
  const suggestions = [];
  const invalid = [];
  for (const item of rawList.slice(0, o.MAX_SUGGESTIONS)) {
    const v = validateSuggestion(item);
    if (v.ok) suggestions.push(v.suggestion);
    else invalid.push(v.error);
  }
  return {
    ok: true,
    analysis: analysis || '（AI 未给出分析）',
    suggestions,
    invalid,
  };
}

// ── 建议校验（validateSuggestion）─────────────────────────────────────
const SUGGESTION_ACTIONS = new Set(['restore', 'disable', 'remove', 'repair', 'safe-mode', 'retry', 'export']);
const ID_RE = /^[A-Za-z0-9_.-]+$/;
const SNAPSHOT_ID_RE = /^[\w.-]+$/;

function validateSuggestion(item) {
  if (!item || typeof item !== 'object') return { ok: false, error: '建议项不是对象' };
  const action = String(item.action || '');
  if (!SUGGESTION_ACTIONS.has(action)) return { ok: false, error: '未知动作: ' + action };
  const params = item.params && typeof item.params === 'object' ? item.params : {};
  const risk = ['low', 'medium', 'high'].includes(item.risk) ? item.risk : 'low';
  const reason = typeof item.reason === 'string' ? item.reason.slice(0, 1000) : '';
  const out = { action, params: {}, risk, reason };

  if (action === 'restore') {
    const id = String(params.snapshotId || '');
    if (!SNAPSHOT_ID_RE.test(id)) return { ok: false, error: 'restore 缺少合法 snapshotId' };
    out.params.snapshotId = id;
  } else if (action === 'disable' || action === 'remove') {
    const id = String(params.pluginId || '');
    if (!ID_RE.test(id)) return { ok: false, error: action + ' 缺少合法 pluginId' };
    out.params.pluginId = id;
  } else if (action === 'safe-mode') {
    out.params.on = params.on === true;
  }
  return { ok: true, suggestion: out };
}

// ── 白名单分发（applySuggestion，副作用经 exec 注入）──────────────────
// exec(suggestion) 由 main.js 提供，返回 { ok, result?, error?, restartRequired? }。
async function applySuggestion(suggestion, exec, log = () => {}) {
  const v = validateSuggestion(suggestion);
  if (!v.ok) return { ok: false, error: v.error };
  try {
    const res = await exec(v.suggestion);
    return { ok: true, ...(res || {}) };
  } catch (err) {
    const msg = String((err && err.message) || err);
    log('rescue', '救援动作执行失败: ' + msg);
    return { ok: false, error: msg };
  }
}

// ── 壳层安全模式 patch（safeModePatch）────────────────────────────────
// 只保留 keepIds（核心插件）的登记点，其余 id 的行全部移除（复用
// removePluginFromPatch 的纯文本手术，保留文件格式与注释）。
function safeModePatch(patchText, keepIds) {
  const text = String(patchText || '');
  const keep = new Set(Array.isArray(keepIds) ? keepIds : []);
  const ids = new Set();
  const re = /^[ \t]*- id:\s*([A-Za-z0-9_.-]+)/gm;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  let patch = text;
  const removed = [];
  for (const id of ids) {
    if (keep.has(id)) continue;
    const next = removePluginFromPatch(patch, id);
    if (next !== patch) {
      patch = next;
      removed.push(id);
    }
  }
  return { patch, removed };
}

// ── 崩溃循环计数（纯函数）────────────────────────────────────────────
// state: { bootFailures, windowStart, lastAt }；now 为毫秒时间戳（可注入便于测试）。
function recordBootFailure(state, now = Date.now(), opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const s = state && typeof state === 'object' ? { ...state } : {};
  if (!s.windowStart || now - s.windowStart > o.BOOT_FAILURE_WINDOW_MS) {
    s.windowStart = now;
    s.bootFailures = 1;
  } else {
    s.bootFailures = Number(s.bootFailures || 0) + 1;
  }
  s.lastAt = now;
  return s;
}

function shouldEnterRescue(state, now = Date.now(), opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const s = state || {};
  if (!s.windowStart || now - s.windowStart > o.BOOT_FAILURE_WINDOW_MS) return false;
  return Number(s.bootFailures || 0) >= o.BOOT_FAILURE_THRESHOLD;
}

// ── AI 调用（chatCompletions，httpFn 可注入便于测试）──────────────────
// 默认走 node:https POST /chat/completions；超时与响应大小双上限。
function chatCompletions({ apiKey, model, messages, timeoutMs, baseUrl, httpFn } = {}) {
  const key = String(apiKey || '');
  if (!key) return Promise.resolve({ ok: false, error: 'no-key' });
  const base = String(baseUrl || process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = JSON.stringify({
    model: model || DEFAULT_OPTS.MODEL,
    messages: Array.isArray(messages) ? messages : [],
    max_tokens: 2000,
    temperature: 0.2,
  });
  const timeout = timeoutMs || DEFAULT_OPTS.AI_TIMEOUT_MS;
  const doFetch = typeof httpFn === 'function'
    ? httpFn
    : (url2, reqBody, headers) => new Promise((resolve, reject) => {
      const req = https.request(url2, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
          'User-Agent': 'DSH-Desktop/Rescue',
          ...(headers || {}),
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
          if (data.length > DEFAULT_OPTS.AI_RESPONSE_MAX) {
            req.destroy(new Error('AI 响应过大'));
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return resolve({ error: 'HTTP ' + res.statusCode + '：' + data.slice(0, 200).trim() });
          }
          resolve({ data });
        });
      });
      req.setTimeout(timeout, () => req.destroy(new Error('AI 请求超时')));
      req.on('error', (err) => reject(err));
      req.write(reqBody);
      req.end();
    });

  return Promise.resolve()
    .then(() => doFetch(url, body, { Authorization: 'Bearer ' + key }))
    .then((res) => {
      if (!res) return { ok: false, error: 'AI 无响应' };
      if (res.error) return { ok: false, error: String(res.error) };
      let parsed = null;
      try { parsed = JSON.parse(String(res.data || '{}')); } catch { return { ok: false, error: 'AI 响应 JSON 解析失败' }; }
      const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
      if (!content || typeof content.content !== 'string') return { ok: false, error: 'AI 响应缺少内容' };
      return { ok: true, content: content.content };
    })
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
}

module.exports = {
  DEFAULT_OPTS,
  ACTION_SPEC,
  readTail,
  collectDiagnosis,
  filterDiagnosisPayload,
  buildDiagnosisPrompt,
  parseAiResponse,
  validateSuggestion,
  applySuggestion,
  safeModePatch,
  recordBootFailure,
  shouldEnterRescue,
  chatCompletions,
};

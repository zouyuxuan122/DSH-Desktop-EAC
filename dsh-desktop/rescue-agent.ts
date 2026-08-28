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

import fs = require('node:fs');
import path = require('node:path');
import http = require('node:http');
import https = require('node:https');
const yaml = require('js-yaml') as { load(text: string): unknown };
const { removePluginFromPatch } = require('./scripts/plugin-manager-patch') as { removePluginFromPatch(patch: string, id: string): string };

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
function readTail(file: string, maxBytes: number): string {
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
interface RescueCtx {
  profileDir?: string | null;
  logsDir?: string | null;
  dshHome?: string | null;
  profile?: string | null;
  versions?: { app?: string; dsh?: string; source?: string } | null;
  plugins?: () => any[];
  snapshots?: () => any[];
  lastGood?: () => any | null;
  incidents?: () => any[];
  readIncident?: (id: string) => string | null;
  health?: () => any[];
  attribution?: () => any | null;
  lastErrText?: () => string | null;
}

interface DiagnosisPayload {
  env: { at: string; appVersion: string; dshVersion: string; agentSource: string; profile: string; dshHome: string; platform: NodeJS.Platform };
  lastBootError: string | null;
  attribution: unknown;
  healthFindings: any[];
  plugins: { id: unknown; name: unknown; enabled: boolean; core: boolean; toggleable: boolean; removed: boolean; group: string }[];
  snapshots: { id: unknown; reason: string; at: string }[];
  lastGood: { id: unknown; reason: string } | null;
  incidents: { id: string; title: string; body: string }[];
  profile: Record<string, string>;
  settingsYaml: string;
  logs: Record<string, string>;
}

interface SendManifestEntry {
  kind: string;
  name: string;
  size: number;
}

function collectDiagnosis(ctx: RescueCtx, opts: Partial<typeof DEFAULT_OPTS> = {}): { ok: true; sendManifest: SendManifestEntry[]; payload: DiagnosisPayload; totalBytes: number } {
  const o = { ...DEFAULT_OPTS, ...opts };
  const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const profileDir = String(ctx.profileDir || '');
  const logsDir = String(ctx.logsDir || '');
  const home = String(ctx.dshHome || '');

  const readProfileFile = (name: string, max?: number): string => {
    if (!profileDir) return '';
    return readTail(path.join(profileDir, name), max || o.PROFILE_TEXT_MAX);
  };

  // 事故报告：优先最近的，总量控制在裁剪预算内。
  const incidentList = safe(() => ctx.incidents!(), []);
  const incidents: { id: string; title: string; body: string }[] = [];
  let incBytes = 0;
  for (const inc of incidentList.slice(0, 6)) {
    const content = safe(() => ctx.readIncident!(inc.id), null);
    if (!content) continue;
    const body = String(content).slice(0, o.INCIDENT_MAX);
    incBytes += body.length;
    if (incBytes > o.DIAG_TOTAL_MAX / 2) break;
    incidents.push({ id: inc.id, title: inc.title || inc.id, body });
  }

  const snapshots = safe(() => ctx.snapshots!(), []);
  const lastGood = safe(() => ctx.lastGood!(), null);
  const plugins = safe(() => ctx.plugins!(), []);
  const health = safe(() => ctx.health!(), []);
  const attribution = safe(() => ctx.attribution!(), null);
  const lastErr = String(safe(() => ctx.lastErrText!(), '') || '').slice(0, 8000);

  const profile: Record<string, string> = {
    patchText: readProfileFile('cordis.patch.yml'),
    packageJson: readProfileFile('package.json'),
    workspaceYaml: readProfileFile('pnpm-workspace.yaml'),
    builtinList: readProfileFile('.dsh-builtin-plugins.json'),
  };
  // 全局 settings.yaml（快照不覆盖、规则体检不扫的配置面 —— AI 主动修复的
  // 主要作战对象之一），限长读取，损坏字节不影响收集。
  const settingsYaml = home ? readTail(path.join(home, 'settings.yaml'), o.PROFILE_TEXT_MAX) : '';
  const logs: Record<string, string> = {
    'dsh-web.log': readTail(path.join(logsDir, 'dsh-web.log'), o.LOG_TAIL_BYTES),
    'desktop.log': readTail(path.join(logsDir, 'desktop.log'), o.LOG_TAIL_BYTES),
  };

  const payload: DiagnosisPayload = {
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
    settingsYaml,
    logs,
  };

  const sendManifest: SendManifestEntry[] = [
    { kind: '版本环境', name: '版本与目录摘要', size: JSON.stringify(payload.env).length },
    ...(lastErr ? [{ kind: '启动失败', name: '最近启动错误文案', size: lastErr.length }] : []),
    ...(health.length ? [{ kind: '体检', name: `规则体检发现 ${health.length} 项`, size: JSON.stringify(health).length }] : []),
    ...(plugins.length ? [{ kind: '插件清单', name: `${plugins.length} 个插件（含启停状态）`, size: JSON.stringify(plugins).length }] : []),
    ...(snapshots.length ? [{ kind: '快照', name: `${snapshots.length} 份快照（含最后良好）`, size: JSON.stringify(snapshots).length }] : []),
    ...incidents.map((i) => ({ kind: '事故报告', name: i.title, size: i.body.length })),
    ...Object.entries(profile).filter(([, v]) => v).map(([k, v]) => ({ kind: '配置面', name: k, size: v.length })),
    ...(settingsYaml ? [{ kind: '配置面', name: 'settings.yaml', size: settingsYaml.length }] : []),
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
function filterDiagnosisPayload(payload: DiagnosisPayload, manifest: SendManifestEntry[], selectedNames: unknown): DiagnosisPayload {
  if (!Array.isArray(selectedNames) || selectedNames.length === 0) return payload;
  const sel = new Set(selectedNames.map(String));
  const kinds = new Set(manifest.filter((m) => sel.has(m.name)).map((m) => m.kind));
  const out: DiagnosisPayload = {
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
  out.settingsYaml = kinds.has('配置面') && sel.has('settings.yaml') ? payload.settingsYaml : '';
  return out;
}

// ── 提示词构建（buildDiagnosisPrompt）──────────────────────────────────
// 系统提示词约束：只诊断、只输出动作白名单内的 JSON 建议、绝不虚构文件内容。
interface ActionSpec {
  action: string;
  params: Record<string, unknown>;
  desc: string;
}
const ACTION_SPEC: ActionSpec[] = [
  { action: 'restore', params: { snapshotId: '快照 id（来自诊断上下文 snapshots 列表）' }, desc: '回滚 profile 配置到指定快照（高风险，最后手段）' },
  { action: 'disable', params: { pluginId: '插件 id（来自 plugins 列表）' }, desc: '停用某个插件（写盘停用，重启不还原）' },
  { action: 'remove', params: { pluginId: '插件 id' }, desc: '卸载某个内置插件（高风险，清 patch 行与包副本）' },
  { action: 'repair', params: {}, desc: '执行规则体检修复（patch 行 / 模块遮蔽 / junction）' },
  { action: 'resync', params: {}, desc: '重装/修复 profile 模块树（node_modules 损坏时使用）' },
  { action: 'edit-file', params: { file: '白名单文件名（settings.yaml 或 profile 的 package.json / pnpm-lock.yaml / pnpm-workspace.yaml / cordis.patch.yml / .dsh-builtin-plugins.json）', ops: '[{op:"replace-line"|"delete-line"|"insert-after", anchor:"现有行锚点", with:"替换/插入内容（可选）"}] 或 newContent:"整体替换内容"' }, desc: '直接编辑白名单配置文件修复根因（写前快照、写后校验可解析）' },
  { action: 'safe-mode', params: { on: 'true=开启安全模式（只留核心插件裸启动），false=恢复' }, desc: '壳层安全模式开关' },
  { action: 'retry', params: {}, desc: '重新启动 Web 服务（走守护启动全链路）' },
  { action: 'export', params: {}, desc: '建议用户导出诊断 zip（不自动执行）' },
];

function buildDiagnosisPrompt(diag: unknown): string {
  const spec = ACTION_SPEC.map((a) => (
    `  - action: "${a.action}"\n` +
    `    params: ${JSON.stringify(a.params)}\n` +
    `    desc: ${a.desc}`
  )).join('\n');
  return [
    '你是 DeepSeek Harness 桌面客户端的救援修复助手。你的任务是根据下方诊断上下文判断客户端无法工作的原因，并给出可自动执行的修复方案。',
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
    '4. 优先主动修复根因：先考虑 edit-file / resync / repair（低/中风险，会被自动执行），',
    '   不要一上来就 disable 或 restore；restore / remove 风险高，只在规则链与编辑都无法修复时给出。',
    '5. edit-file 纪律：只编辑白名单文件；用最小改动（优先 replace-line / delete-line，避免整文件重写）；',
    '   anchor 必须取诊断上下文里真实存在的行内容；改后文件必须仍是合法 YAML/JSON；',
    '   若无法给出精确编辑，宁可不给 edit-file。',
    '6. 若无法确定根因，analysis 说明疑点，suggestions 只给最保守的项（如 retry 或 export）。',
    '7. 最多给出 4 条建议，按实施顺序排列。',
    '',
    '=== 诊断上下文（JSON） ===',
    JSON.stringify(diag, null, 2),
  ].join('\n');
}

// ── AI 响应解析（parseAiResponse，容错但不迁就）────────────────────────
// 接受：裸 JSON、```json 包裹、前后有说明文字。解析失败 / 结构不符 /
// 动作不在白名单 → 丢弃并返回错误描述，绝不执行。
function parseAiResponse(text: unknown, opts: Partial<typeof DEFAULT_OPTS> = {}): { ok: boolean; analysis?: string; suggestions?: ValidSuggestion[]; invalid?: string[]; error?: string } {
  const o = { ...DEFAULT_OPTS, ...opts };
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'AI 返回为空' };
  let json: any = null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) {
    try { json = JSON.parse(fence[1]!.trim()); } catch { json = null; }
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
  const suggestions: ValidSuggestion[] = [];
  const invalid: string[] = [];
  for (const item of rawList.slice(0, o.MAX_SUGGESTIONS)) {
    const v = validateSuggestion(item);
    if (v.ok) suggestions.push(v.suggestion!);
    else invalid.push(v.error!);
  }
  return {
    ok: true,
    analysis: analysis || '（AI 未给出分析）',
    suggestions,
    invalid,
  };
}

// ── 建议校验（validateSuggestion）─────────────────────────────────────
const SUGGESTION_ACTIONS = new Set(['restore', 'disable', 'remove', 'repair', 'resync', 'edit-file', 'safe-mode', 'retry', 'export']);
const ID_RE = /^[A-Za-z0-9_.-]+$/;
const SNAPSHOT_ID_RE = /^[\w.-]+$/;
const EDIT_OPS = new Set(['replace-line', 'delete-line', 'insert-after']);

interface ValidSuggestion {
  action: string;
  params: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
  reason: string;
}
interface SuggestionResult {
  ok: boolean;
  suggestion?: ValidSuggestion;
  error?: string;
}

function validateSuggestion(item: any): SuggestionResult {
  if (!item || typeof item !== 'object') return { ok: false, error: '建议项不是对象' };
  const action = String(item.action || '');
  if (!SUGGESTION_ACTIONS.has(action)) return { ok: false, error: '未知动作: ' + action };
  const params = item.params && typeof item.params === 'object' ? item.params : {};
  const risk = ['low', 'medium', 'high'].includes(item.risk) ? item.risk : 'low';
  const reason = typeof item.reason === 'string' ? item.reason.slice(0, 1000) : '';
  const out: ValidSuggestion = { action, params: {}, risk, reason };

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
  } else if (action === 'edit-file') {
    // AI 主动修复：只接受白名单文件名 + 结构化行编辑（ops）或整体替换
    // （newContent）。文件名不得含路径分隔符 / .. / :，杜绝越权与路径穿越。
    const file = String(params.file || '');
    if (!file || file.includes('\\') || file.includes('/') || file.includes('..') || file.includes(':')) {
      return { ok: false, error: 'edit-file 缺少合法 file（只允许白名单文件名本身）' };
    }
    if (!EDITABLE_PROFILE_FILES.includes(file) && !EDITABLE_HOME_FILES.includes(file)) {
      return { ok: false, error: 'edit-file 文件不在可编辑白名单内: ' + file };
    }
    const ops = Array.isArray(params.ops) ? params.ops : null;
    const newContent = typeof params.newContent === 'string' ? params.newContent : null;
    if (!ops && newContent === null) return { ok: false, error: 'edit-file 缺少 ops 或 newContent' };
    if (ops) {
      if (!ops.length) return { ok: false, error: 'edit-file ops 不能为空' };
      const clean: { op: string; anchor: string; with?: string }[] = [];
      for (const op of ops) {
        if (!op || typeof op !== 'object') return { ok: false, error: 'edit-file 操作项必须是对象' };
        const kind = String(op.op || '');
        if (!EDIT_OPS.has(kind)) return { ok: false, error: '未知编辑操作: ' + kind };
        const anchor = String(op.anchor || '');
        if (!anchor) return { ok: false, error: '编辑操作缺少 anchor' };
        if ((kind === 'replace-line' || kind === 'insert-after') && typeof op.with !== 'string') {
          return { ok: false, error: kind + ' 缺少 with' };
        }
        clean.push({ op: kind, anchor, ...(typeof op.with === 'string' ? { with: op.with } : {}) });
      }
      out.params = { file, ops: clean };
    } else {
      out.params = { file, newContent };
    }
  }
  return { ok: true, suggestion: out };
}

// ── 可编辑文件白名单（AI 主动修复的唯一落笔范围）────────────────────
const EDITABLE_PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', '.dsh-builtin-plugins.json'];
const EDITABLE_HOME_FILES = ['settings.yaml'];

type EditTargetResult =
  | { ok: true; abs: string; kind: 'profile' | 'home'; ext: string }
  | { ok: false; error: string };

// 校验编辑目标：文件名必须本身在白名单内，解析后落在 profileDir / home 根下。
function validateEditTarget(file: unknown, ctx: { profileDir?: string; home?: string } = {}): EditTargetResult {
  const name = String(file || '');
  if (!name || name.includes('\\') || name.includes('/') || name.includes('..') || name.includes(':')) {
    return { ok: false, error: '越权路径：只允许编辑白名单文件本身' };
  }
  const ext = path.extname(name).toLowerCase();
  if (EDITABLE_PROFILE_FILES.includes(name)) {
    const profileDir = String(ctx.profileDir || '');
    if (!profileDir) return { ok: false, error: 'profileDir 缺失' };
    return { ok: true, abs: path.join(profileDir, name), kind: 'profile', ext };
  }
  if (EDITABLE_HOME_FILES.includes(name)) {
    const home = String(ctx.home || '');
    if (!home) return { ok: false, error: 'home 缺失' };
    return { ok: true, abs: path.join(home, name), kind: 'home', ext };
  }
  return { ok: false, error: '文件不在可编辑白名单内' };
}

function lineMatches(line: unknown, anchor: string): boolean {
  const t = String(line).trim();
  return t === anchor || t.startsWith(anchor + ':') || t.startsWith(anchor + ' ');
}

function applyEditOp(text: string | null | undefined, op: any): { ok: boolean; text?: string; error?: string } {
  const kind = String(op && op.op || '');
  const anchor = String(op && op.anchor || '');
  if (!anchor) return { ok: false, error: '行编辑缺少 anchor' };
  const lines = String(text || '').split('\n');
  const idx = lines.findIndex((l) => lineMatches(l, anchor));
  if (idx < 0) return { ok: false, error: '锚点未找到: ' + anchor };
  if (kind === 'replace-line') {
    if (typeof op.with !== 'string') return { ok: false, error: 'replace-line 缺少 with' };
    lines[idx] = op.with;
    return { ok: true, text: lines.join('\n') };
  }
  if (kind === 'delete-line') {
    lines.splice(idx, 1);
    return { ok: true, text: lines.join('\n') };
  }
  if (kind === 'insert-after') {
    if (typeof op.with !== 'string') return { ok: false, error: 'insert-after 缺少 with' };
    lines.splice(idx + 1, 0, op.with);
    return { ok: true, text: lines.join('\n') };
  }
  return { ok: false, error: '未知编辑操作: ' + kind };
}

function verifyContentParses(ext: string, text: string): string | null {
  try {
    if (ext === '.json') {
      JSON.parse(text);
      return null;
    }
    if (ext === '.yaml' || ext === '.yml') {
      yaml.load(text);
      return null;
    }
    return null;
  } catch (err) {
    return '编辑后内容无法解析（' + (ext === '.json' ? 'JSON' : 'YAML') + '）: ' + String(((err as Error) && (err as Error).message) || err);
  }
}

// 应用一次白名单文件编辑。副作用（备份/写盘）经 ctx 注入，核心纯逻辑可测。
// 顺序：目标校验 → 行编辑 → 可解析校验 → 备份 → 写盘。
function applyProfileEdit(edit: any, ctx: any = {}): { ok: boolean; error?: string; file?: unknown; opsApplied?: number; backupTaken?: boolean } {
  const target = validateEditTarget(edit && edit.file, ctx);
  if (!target.ok) return { ok: false, error: target.error };
  const ops = Array.isArray(edit && edit.ops) ? edit.ops : null;
  const newContent = typeof (edit && edit.newContent) === 'string' ? edit.newContent : null;
  if (!ops && newContent === null) return { ok: false, error: '缺少编辑内容（ops 或 newContent）' };

  let raw: string | null = null;
  try { raw = typeof ctx.readFile === 'function' ? ctx.readFile(target.abs) : null; } catch { raw = null; }
  if (raw === null && newContent === null) {
    return { ok: false, error: '目标文件不存在，无法做行级编辑（可改用 newContent 重建）' };
  }
  if (raw === null) raw = '';

  let result = raw;
  let applied = 0;
  if (ops) {
    for (const op of ops) {
      const step = applyEditOp(result, op);
      if (!step.ok) return { ok: false, error: step.error! };
      result = step.text!;
      applied += 1;
    }
  } else {
    result = newContent!;
    applied = 1;
  }

  const parseErr = verifyContentParses(target.ext, result);
  if (parseErr) return { ok: false, error: parseErr };

  try {
    if (typeof ctx.backup === 'function') ctx.backup(target.abs);
    if (typeof ctx.writeFile === 'function') ctx.writeFile(target.abs, result);
  } catch (err) {
    return { ok: false, error: '写入失败: ' + String(((err as Error) && (err as Error).message) || err) };
  }
  return { ok: true, file: edit.file, opsApplied: applied, backupTaken: true };
}

// ── 一键 AI 自动修复循环（runAutoRepair）──────────────────────────────
// 所有副作用注入：diagnose（收集上下文）、analyze（调 AI 返回建议）、
// execute（执行单条白名单建议）、retry（重启 Web 服务）、fallback（兜底
// 回滚+安全模式）。自动跳过 risk=high 的动作；无进展不重试；超过轮次
// 或修复后仍无法启动 → 兜底并返回完整轮次记录。
interface AutoRepairOpts {
  diagnose: () => Promise<any>;
  analyze: (payload: DiagnosisPayload) => Promise<any>;
  execute: (suggestion: ValidSuggestion) => Promise<any>;
  retry: () => Promise<any>;
  fallback: () => Promise<any>;
  maxRounds?: number;
  log?: (section: string, message: string) => void;
}
interface AutoRepairRound {
  round: number;
  analysis: string;
  applied: { action: unknown; ok?: boolean; result?: unknown; error?: unknown; skipped?: string }[];
  retryOk?: boolean;
  retryResult?: unknown;
}
async function runAutoRepair({ diagnose, analyze, execute, retry, fallback, maxRounds = 2, log = () => {} }: Partial<AutoRepairOpts> = {}): Promise<{ ok: boolean; rounds: AutoRepairRound[]; error?: string; fallback?: unknown }> {
  const safe = (fn: () => unknown) => Promise.resolve().then(fn).catch((err) => ({ ok: false, error: String(((err as Error) && (err as Error).message) || err) }));
  const rounds: AutoRepairRound[] = [];
  const max = Math.max(1, Number(maxRounds) || 2);
  for (let round = 0; round < max; round++) {
    const diag = await safe(diagnose!);
    if (!diag || !(diag as any).ok) return { ok: false, error: ((diag as any) && (diag as any).error) || '诊断上下文收集失败', rounds };
    const ai = await safe(() => analyze!((diag as any).payload));
    if (!ai || !(ai as any).ok) return { ok: false, error: ((ai as any) && (ai as any).error) || 'AI 诊断失败', rounds };
    const suggestions = Array.isArray((ai as any).suggestions) ? (ai as any).suggestions : [];
    const applied: AutoRepairRound['applied'] = [];
    for (const s of suggestions) {
      if (s && s.risk === 'high') {
        applied.push({ action: s.action, skipped: 'high-risk' });
        continue;
      }
      const r = await safe(() => execute!(s));
      applied.push({ action: s && s.action, ok: !!(r && (r as any).ok), result: r && (r as any).result, error: r && (r as any).error });
    }
    const progressed = applied.some((a) => a.ok);
    const roundRec: AutoRepairRound = { round, analysis: (ai as any).analysis || '', applied };
    if (!progressed) {
      rounds.push(roundRec);
      return { ok: false, rounds, error: 'AI 未给出可自动执行的修复', fallback: await safe(fallback!) };
    }
    const retryRes = await safe(retry!);
    roundRec.retryOk = !!(retryRes && (retryRes as any).ok);
    roundRec.retryResult = retryRes && (retryRes as any).result;
    rounds.push(roundRec);
    if (roundRec.retryOk) return { ok: true, rounds };
    log('rescue', `AI 自动修复第 ${round + 1} 轮已应用但启动仍失败，进入下一轮`);
  }
  return { ok: false, rounds, error: '多轮 AI 修复后仍未启动成功', fallback: await safe(fallback!) };
}

// ── 白名单分发（applySuggestion，副作用经 exec 注入）──────────────────
// exec(suggestion) 由 main.js 提供，返回 { ok, result?, error?, restartRequired? }。
async function applySuggestion(suggestion: any, exec: (s: ValidSuggestion) => Promise<any>, log: (section: string, message: string) => void = () => {}): Promise<{ ok: boolean; error?: string; result?: unknown; restartRequired?: boolean }> {
  const v = validateSuggestion(suggestion);
  if (!v.ok) return { ok: false, error: v.error! };
  try {
    const res = await exec(v.suggestion!);
    return { ok: true, ...(res || {}) };
  } catch (err) {
    const msg = String(((err as Error) && (err as Error).message) || err);
    log('rescue', '救援动作执行失败: ' + msg);
    return { ok: false, error: msg };
  }
}

// ── 壳层安全模式 patch（safeModePatch）────────────────────────────────
// 只保留 keepIds（核心插件）的登记点，其余 id 的行全部移除（复用
// removePluginFromPatch 的纯文本手术，保留文件格式与注释）。
function safeModePatch(patchText: string | null | undefined, keepIds: unknown): { patch: string; removed: string[] } {
  const text = String(patchText || '');
  const keep = new Set<any>(Array.isArray(keepIds) ? keepIds : []);
  const ids = new Set<string>();
  const re = /^[ \t]*- id:\s*([A-Za-z0-9_.-]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.add(m[1]!);
  let patch = text;
  const removed: string[] = [];
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
interface BootFailureState {
  windowStart?: number;
  bootFailures?: number;
  lastAt?: number;
}
function recordBootFailure(state: BootFailureState | null | undefined, now: number = Date.now(), opts: Partial<typeof DEFAULT_OPTS> = {}): BootFailureState {
  const o = { ...DEFAULT_OPTS, ...opts };
  const s: BootFailureState = state && typeof state === 'object' ? { ...state } : {};
  if (!s.windowStart || now - s.windowStart > o.BOOT_FAILURE_WINDOW_MS) {
    s.windowStart = now;
    s.bootFailures = 1;
  } else {
    s.bootFailures = Number(s.bootFailures || 0) + 1;
  }
  s.lastAt = now;
  return s;
}

function shouldEnterRescue(state: BootFailureState | null | undefined, now: number = Date.now(), opts: Partial<typeof DEFAULT_OPTS> = {}): boolean {
  const o = { ...DEFAULT_OPTS, ...opts };
  const s = state || {};
  if (!s.windowStart || now - s.windowStart > o.BOOT_FAILURE_WINDOW_MS) return false;
  return Number(s.bootFailures || 0) >= o.BOOT_FAILURE_THRESHOLD;
}

// ── AI 调用（chatCompletions，httpFn 可注入便于测试）──────────────────
// 默认走 node:https POST /chat/completions；超时与响应大小双上限。
interface ChatCompletionsOpts {
  apiKey?: string;
  model?: string;
  messages?: unknown[];
  timeoutMs?: number;
  baseUrl?: string;
  httpFn?: (url: string, body: string, headers: Record<string, string>) => Promise<{ data?: string; error?: string }>;
}
function chatCompletions({ apiKey, model, messages, timeoutMs, baseUrl, httpFn }: ChatCompletionsOpts = {}): Promise<{ ok: boolean; content?: string; error?: string }> {
  const key = String(apiKey || '');
  if (!key) return Promise.resolve({ ok: false, error: 'no-key' });
  const base = String(baseUrl || process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = JSON.stringify({
    model: model || process.env.DSH_RESCUE_MODEL || DEFAULT_OPTS.MODEL,
    messages: Array.isArray(messages) ? messages : [],
    max_tokens: Number(process.env.DSH_RESCUE_MAX_TOKENS) || 8192,
    temperature: 0.2,
    // 显式非流式：部分本地路由网关（如 9router）未指定 stream 时默认返回
    // SSE 流式响应，JSON.parse 会失败。
    stream: false,
  });
  const timeout = timeoutMs || DEFAULT_OPTS.AI_TIMEOUT_MS;
  // 兼容本地 http 网关（LLM 路由/聚合端点常为 http://localhost:port）。
  const transport = (base.startsWith('http://') ? http : https) as unknown as typeof http;
  const doFetch = typeof httpFn === 'function'
    ? httpFn
    : (url2: string, reqBody: string, headers?: Record<string, string>) => new Promise<{ data?: string; error?: string }>((resolve, reject) => {
      const req = transport.request(url2, {
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
      let parsed: any = null;
      try { parsed = JSON.parse(String(res.data || '{}')); } catch { return { ok: false, error: 'AI 响应 JSON 解析失败' }; }
      const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
      if (!content || typeof content.content !== 'string') return { ok: false, error: 'AI 响应缺少内容' };
      return { ok: true, content: content.content };
    })
    .catch((err) => ({ ok: false, error: String(((err as Error) && (err as Error).message) || err) }));
}

export = {
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
  validateEditTarget,
  applyProfileEdit,
  runAutoRepair,
};

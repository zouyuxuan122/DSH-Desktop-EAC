'use strict';

// 对话删除 / 归档管理运行时补丁（幂等、锚点不匹配时跳过且绝不损坏文件）。
//
// 背景：dsh 只有归档（workspace 域 archivedSessionIds）没有删除。本补丁在
// 官方包上做外科手术式扩展，打通「删除按钮 + 设置内归档管理面板」所需的
// 全链路（宿主 RPC + 客户端桥 + 会话行菜单）：
//
//   1. @deepseek-ai/dsh-workspace        —— WorkspaceRegistry 增加
//      unarchiveSession(sessionId)（幂等地从归档集合移除并持久化）。
//   2. @deepseek-ai/dsh-host-apiproxy    —— 新增两个 RPC：
//        · workspace.unarchiveSession    恢复归档（域变更自动广播
//          host/archived-sessions-changed，客户端实时恢复显示）；
//        · workspace.deleteSession       删除：拒绝运行中会话 → 按 jsonl
//          布局移除会话目录 → 清理归档集合 → 广播 session/disposed
//          （各监听者按 session 对象身份做 Map 操作，合成 {id} 事件安全，
//          客户端实时收到 host/session-removed 移除行）。
//   3. @deepseek-ai/dsh-client-connection —— workspace API 面 + unary 响应
//      schema 增加两个方法（否则 callUnary 在 schema 表里找不到会抛错）。
//   4. @deepseek-ai/dsh-client-ui-workspace —— 会话行 ⋯ 菜单在「归档会话」
//      下方增加「删除对话」（当前会话行不显示），点击走
//      window.__dshSessionManager（由配套插件 dsh-session-manager 提供：
//      确认框 + RPC + 错误提示）。
//
// 用法：
//   node scripts/patch-session-manage.js [<node_modules 根目录>]
// 同时导出 patchSessionManage(nmRoot, log) 供启动补丁与 after-pack.js
// 打包补丁复用（覆盖内置副本 / profile fallback / agent overlay / dev）。

import * as fs from 'node:fs';
import * as path from 'node:path';

export const MARKER = 'dsh-desktop patch (session manage)';

// ---------------------------------------------------------------------------
// 1. dsh-workspace：unarchiveSession
// ---------------------------------------------------------------------------
const WS_ANCHOR = 'archivedSessionIds: [...state.archivedSessionIds, sessionId]\n\t\t\t});\n\t\t});\n\t}';
const WS_INSERT = '\t/**\n\t* dsh-desktop patch (session manage): 从归档集合移除一个会话（恢复）。\n\t* 幂等：不在归档集合中是 no-op；不校验 sessionKnown —— 已删除会话的\n\t* 陈旧归档项也应能清掉。恢复后会话沿用原有 workspace 槽位与显示顺序。\n\t* @param sessionId - 要恢复的会话 id。\n\t*/\n\tunarchiveSession(sessionId) {\n\t\treturn this.enqueueOperation(async () => {\n\t\t\tconst state = this.requireState();\n\t\t\tif (!state.archivedSessionIds.includes(sessionId)) return;\n\t\t\tawait this.setState({\n\t\t\t\t...state,\n\t\t\t\tarchivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)\n\t\t\t});\n\t\t});\n\t}';

// ---------------------------------------------------------------------------
// 1b. dsh-session：Sessions 服务增加 remove(id) —— 删除前从 live 注册表摘除
// （detachEntered：优雅 flush + 释放持久化状态 + 广播 session/disposed）。
// ---------------------------------------------------------------------------
const SESSION_ANCHOR = 'list() {\n\t\treturn [...this.store.values()].map((entry) => entry.session);\n\t}';
const SESSION_INSERT = 'list() {\n\t\treturn [...this.store.values()].map((entry) => entry.session);\n\t}\n\t/**\n\t* dsh-desktop patch (session manage): 从 live 注册表摘除一个会话并广播\n\t* session/disposed（优雅 flush 后释放持久化状态）。删除前调用：摘除后\n\t* 写路径不再拥有该会话，目录可安全移除；正在运行的会话由调用方先行拒绝。\n\t* @param id - 要摘除的会话 id。\n\t* @returns 是否确实摘除了一个 live 会话。\n\t*/\n\tremove(id) {\n\t\tconst entry = this.store.get(id);\n\t\tif (entry === void 0) return false;\n\t\tthis.detachEntered(entry);\n\t\treturn true;\n\t}';

// ---------------------------------------------------------------------------
// 2. dsh-host-apiproxy：两个 RPC（impl / schemas / handler map / imports）
// ---------------------------------------------------------------------------
const HOST_IMPORT_ANCHOR = 'import { mkdir, stat } from "node:fs/promises";';
const HOST_IMPORT_NEW = 'import { mkdir, readdir, rm, stat } from "node:fs/promises";\nimport { dshHomePath } from "@deepseek-ai/dsh-home-paths";';
// 注意：node:path 的 join 通过单独锚点追加到既有 import 行（避免重复声明）。

const HOST_IMPORT_JOIN_ANCHOR = 'import { dirname, extname } from "node:path";';
const HOST_IMPORT_JOIN_NEW = 'import { dirname, extname, join } from "node:path";';

const HOST_API_ANCHOR = 'return ok(request, { archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds] });\n\t\t\t}';
const HOST_API_INSERT = 'return ok(request, { archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds] });\n\t\t\t},\n\t\t\tasync unarchiveSession(request) {\n\t\t\t\tconst { sessionId } = request.payload;\n\t\t\t\tawait ctx.workspaceRegistry.unarchiveSession(sessionId);\n\t\t\t\treturn ok(request, { archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds] });\n\t\t\t},\n\t\t\tasync deleteSession(request) {\n\t\t\t\tconst { sessionId } = request.payload;\n\t\t\t\t// 拒绝「正在运行」的会话（agent 活跃时写路径会重建目录，删除不安全）。\n\t\t\t\tif (dshSessionRunningState.get(sessionId) === true) {\n\t\t\t\t\treturn err(request, {\n\t\t\t\t\t\tcode: "session-running",\n\t\t\t\t\t\tmessage: "cannot delete a running session: stop it first",\n\t\t\t\t\t\t\tdetails: { sessionId }\n\t\t\t\t\t});\n\t\t\t\t}\n\t\t\t\ttry {\n\t\t\t\t\t// 会话目录布局（dsh-session-persistence-jsonl 约定，注入时同步复制）：\n\t\t\t\t\t// <sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>/ 。\n\t\t\t\t\tconst headers = await ctx.get("sessionPersistence").list();\n\t\t\t\t\tconst header = headers.find((entry) => entry && entry.id === sessionId);\n\t\t\t\t\tif (header !== void 0) {\n\t\t\t\t\t\tconst encodeSeg = (raw) => {\n\t\t\t\t\t\t\tif (raw === ".") return "~002E";\n\t\t\t\t\t\t\tif (raw === "..") return "~002E~002E";\n\t\t\t\t\t\t\tlet out = "";\n\t\t\t\t\t\t\tfor (let i = 0; i < raw.length; i++) {\n\t\t\t\t\t\t\t\tconst code = raw.charCodeAt(i);\n\t\t\t\t\t\t\t\tconst ch = String.fromCharCode(code);\n\t\t\t\t\t\t\t\tif (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;\n\t\t\t\t\t\t\t\telse out += "~" + code.toString(16).toUpperCase().padStart(4, "0");\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\treturn out;\n\t\t\t\t\t\t};\n\t\t\t\t\t\tconst projectKeyOf = (cwd) => {\n\t\t\t\t\t\t\tlet readable = "";\n\t\t\t\t\t\t\tlet separatorRun = false;\n\t\t\t\t\t\t\tfor (let i = 0; i < cwd.length; i++) {\n\t\t\t\t\t\t\t\tconst code = cwd.charCodeAt(i);\n\t\t\t\t\t\t\t\tconst ch = String.fromCharCode(code);\n\t\t\t\t\t\t\t\tif (ch === "/" || ch === "\\\\" || ch === ":") {\n\t\t\t\t\t\t\t\t\tif (!separatorRun) readable += "-";\n\t\t\t\t\t\t\t\t\tseparatorRun = true;\n\t\t\t\t\t\t\t\t} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {\n\t\t\t\t\t\t\t\t\treadable += ch;\n\t\t\t\t\t\t\t\t\tseparatorRun = false;\n\t\t\t\t\t\t\t\t} else {\n\t\t\t\t\t\t\t\t\treadable += "~" + code.toString(16).toUpperCase().padStart(4, "0");\n\t\t\t\t\t\t\t\t\tseparatorRun = false;\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\treturn `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;\n\t\t\t\t\t\t};\n\t\t\t\t\t\tconst root = dshHomePath("sessions");\n\t\t\t\t\t\tconst dir = join(root, header.cwd === void 0 ? "_no-cwd" : projectKeyOf(header.cwd), encodeSeg(sessionId));\n\t\t\t\t\t\tawait rm(dir, { recursive: true, force: true });\n\t\t\t\t\t}\n\t\t\t\t} catch (error) {\n\t\t\t\t\tif (!(error instanceof WorkspaceUnknownSessionError)) throw error;\n\t\t\t\t}\n\t\t\t\t// 摘除 live 注册表（优雅 flush + 释放持久化状态 + session/disposed\n\t\t\t\t// 广播 → 客户端实时收到 session-removed）；非 live 则广播合成移除帧。\n\t\t\t\tconst removed = ctx.sessions.remove(sessionId);\n\t\t\t\tif (!removed) ctx.emit("session/disposed", { id: sessionId });\n\t\t\t\t// 清理归档集合（含陈旧归档项）。\n\t\t\t\tawait ctx.workspaceRegistry.unarchiveSession(sessionId);\n\t\t\t\treturn ok(request, { deleted: true });\n\t\t\t}';

// 模块级：每会话最近一次 agent 运行状态（删除守卫用；agent/status 事件维护）。
const HOST_MAP_ANCHOR = 'import { release } from "node:os";';
const HOST_MAP_INSERT = 'import { release } from "node:os";\n// dsh-desktop patch (session manage): 每会话最近一次 agent 运行状态（删除守卫用）。\nconst dshSessionRunningState = /* @__PURE__ */ new Map();';

// host 流里的 agent/status 监听器：同步维护运行状态表。
const HOST_STATUS_ANCHOR = 'ctx.on("agent/status", ({ agent, status }) => {\n\t\t\t\t\t\tqueue.push(frame({\n\t\t\t\t\t\t\ttype: "host/session-status",\n\t\t\t\t\t\t\tsessionId: agent.id,\n\t\t\t\t\t\t\trunning: status === "running"\n\t\t\t\t\t\t}));\n\t\t\t\t\t}),';
const HOST_STATUS_INSERT = 'ctx.on("agent/status", ({ agent, status }) => {\n\t\t\t\t\t\tif (agent && agent.id) dshSessionRunningState.set(agent.id, status === "running");\n\t\t\t\t\t\tqueue.push(frame({\n\t\t\t\t\t\t\ttype: "host/session-status",\n\t\t\t\t\t\t\tsessionId: agent.id,\n\t\t\t\t\t\t\trunning: status === "running"\n\t\t\t\t\t\t}));\n\t\t\t\t\t}),';

const HOST_SCHEMA_ANCHOR = 'const workspaceArchiveSessionValueSchema = z$1.object({ archivedSessionIds: z$1.array(sessionIdSchema) });';
const HOST_SCHEMA_INSERT = 'const workspaceArchiveSessionValueSchema = z$1.object({ archivedSessionIds: z$1.array(sessionIdSchema) });\n/** workspace.unarchiveSession request payload. */\nconst workspaceUnarchiveSessionRequestSchema = z$1.object({ sessionId: sessionIdSchema });\n/** workspace.unarchiveSession response value: the full updated archive set. */\nconst workspaceUnarchiveSessionValueSchema = z$1.object({ archivedSessionIds: z$1.array(sessionIdSchema) });\n/** workspace.deleteSession request payload. */\nconst workspaceDeleteSessionRequestSchema = z$1.object({ sessionId: sessionIdSchema });\n/** workspace.deleteSession response value. */\nconst workspaceDeleteSessionValueSchema = z$1.object({ deleted: z$1.boolean() });';

const HOST_HANDLER_ANCHOR = '"workspace.archiveSession": {\n\t\tschema: workspaceArchiveSessionRequestSchema,\n\t\tinvoke: (api, r) => api.workspace.archiveSession(r)\n\t},';
const HOST_HANDLER_INSERT = '"workspace.archiveSession": {\n\t\tschema: workspaceArchiveSessionRequestSchema,\n\t\tinvoke: (api, r) => api.workspace.archiveSession(r)\n\t},\n\t"workspace.unarchiveSession": {\n\t\tschema: workspaceUnarchiveSessionRequestSchema,\n\t\tinvoke: (api, r) => api.workspace.unarchiveSession(r)\n\t},\n\t"workspace.deleteSession": {\n\t\tschema: workspaceDeleteSessionRequestSchema,\n\t\tinvoke: (api, r) => api.workspace.deleteSession(r)\n\t},';

// ---------------------------------------------------------------------------
// 3. dsh-client-connection：workspace API 面 + unary 响应 schema
// ---------------------------------------------------------------------------
const CONN_SCHEMA_ANCHOR = 'const workspaceArchiveSessionValueSchema = object({ archivedSessionIds: array(sessionIdSchema) });';
const CONN_SCHEMA_INSERT = 'const workspaceArchiveSessionValueSchema = object({ archivedSessionIds: array(sessionIdSchema) });\n\t\tconst workspaceUnarchiveSessionValueSchema = object({ archivedSessionIds: array(sessionIdSchema) });\n\t\tconst workspaceDeleteSessionValueSchema = object({ deleted: boolean() });';

const CONN_UNARY_ANCHOR = '"workspace.archiveSession": workspaceArchiveSessionValueSchema,';
const CONN_UNARY_INSERT = '"workspace.archiveSession": workspaceArchiveSessionValueSchema,\n"workspace.unarchiveSession": workspaceUnarchiveSessionValueSchema,\n"workspace.deleteSession": workspaceDeleteSessionValueSchema,';

const CONN_FACADE_ANCHOR = 'archiveSession: (payload, signal) => this.callUnary("workspace.archiveSession", payload, signal)';
const CONN_FACADE_INSERT = 'archiveSession: (payload, signal) => this.callUnary("workspace.archiveSession", payload, signal),\n\t\t\t\tunarchiveSession: (payload, signal) => this.callUnary("workspace.unarchiveSession", payload, signal),\n\t\t\t\tdeleteSession: (payload, signal) => this.callUnary("workspace.deleteSession", payload, signal)';

// ---------------------------------------------------------------------------
// 4. dsh-client-ui-workspace：会话行菜单「删除对话」+ 翻译
// ---------------------------------------------------------------------------
const UI_MENU_ANCHOR = '{\n\t\t\t\t\tid: "archive",\n\t\t\t\t\tlabel: t("menu.archiveSession"),\n\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })\n\t\t\t\t}\n\t\t\t];';
const UI_MENU_INSERT = '{\n\t\t\t\t\tid: "archive",\n\t\t\t\t\tlabel: t("menu.archiveSession"),\n\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })\n\t\t\t\t},\n\t\t\t\t// dsh-desktop patch (session manage): 归档下方增加删除。\n\t\t\t\t{\n\t\t\t\t\tid: "delete",\n\t\t\t\t\tlabel: t("menu.deleteSession")\n\t\t\t\t}\n\t\t\t];';
// 旧版补丁（v1：当前会话行不显示删除）→ 升级为无条件显示（用户反馈当前会话
// 行的 ⋯ 菜单里看不到删除按钮）。
const UI_MENU_UPGRADE_ANCHOR = '...(node.id !== currentId ? [{\n\t\t\t\t\tid: "delete",\n\t\t\t\t\tlabel: t("menu.deleteSession")\n\t\t\t\t}] : [])';
const UI_MENU_UPGRADE_INSERT = '{\n\t\t\t\t\tid: "delete",\n\t\t\t\t\tlabel: t("menu.deleteSession")\n\t\t\t\t}';

const UI_SELECT_ANCHOR = 'if (id === "archive") onArchive(node.id);';
const UI_SELECT_INSERT = 'if (id === "archive") onArchive(node.id);\n\t\t\t\t\t\t\t\t\tif (id === "delete") window.__dshSessionManager?.deleteSession(node.id);';

const UI_ZH_ANCHOR = '"menu.archiveSession": "归档会话",';
const UI_ZH_INSERT = '"menu.archiveSession": "归档会话",\n\t\t\t"menu.deleteSession": "删除对话",';
const UI_EN_ANCHOR = '"menu.archiveSession": "Archive session",';
const UI_EN_INSERT = '"menu.archiveSession": "Archive session",\n\t\t\t"menu.deleteSession": "Delete conversation",';

// ---------------------------------------------------------------------------
// 工具：在文件中做「锚点必须存在 + 标记幂等」的替换
// ---------------------------------------------------------------------------
interface Replacement {
  anchor: string;
  insert: string;
}

interface PatchTarget {
  file: string;
  replacements: Replacement[];
  upgradeRules?: Replacement[];
}

function applyReplacements(file: string, replacements: Replacement[], upgradeRules: Replacement[], log: (msg: string) => void): boolean {
  let src: string;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('session-manage 补丁: 读取失败 ' + file + ': ' + String((err as Error).message));
    return false;
  }
  if (src.includes(MARKER)) {
    // 已应用：仍执行「升级替换」（旧版补丁 → 新版语义，幂等），
    // 例如 v1「当前会话行不显示删除」→ v2「所有会话行显示删除」。
    let upgraded = false;
    for (const { anchor, insert } of upgradeRules) {
      if (src.includes(anchor)) {
        src = src.replace(anchor, insert);
        upgraded = true;
      }
    }
    if (upgraded) {
      try {
        fs.writeFileSync(file, src, 'utf8');
        log('session-manage 补丁: 已升级 ' + file);
        return true;
      } catch (err) {
        log('session-manage 补丁: 升级写入失败 ' + file + ': ' + String((err as Error).message));
        return false;
      }
    }
    log('session-manage 补丁: 已应用，跳过 ' + file);
    return false;
  }
  for (const { anchor, insert } of replacements) {
    if (!src.includes(anchor)) {
      log('session-manage 补丁: 锚点未匹配（dsh 版本可能已变化），跳过 ' + file + ' :: ' + anchor.slice(0, 60));
      return false;
    }
    src = src.replace(anchor, insert);
  }
  src = '// ' + MARKER + ': 对话删除/归档管理运行时补丁\n' + src;
  try {
    fs.writeFileSync(file, src, 'utf8');
    log('session-manage 补丁: 已应用 ' + file);
    return true;
  } catch (err) {
    log('session-manage 补丁: 写入失败 ' + file + ': ' + String((err as Error).message));
    return false;
  }
}

/**
 * 对某个 node_modules 根目录应用对话删除/归档管理补丁（幂等）。
 * @param nmRoot node_modules 根目录
 * @param log    日志回调（缺省静默）
 * @returns 实际发生修改的文件数
 */
export function patchSessionManage(nmRoot: string, log: (msg: string) => void = () => {}): number {
  const targets: PatchTarget[] = [
    {
      file: path.join(nmRoot, '@deepseek-ai', 'dsh-workspace', 'lib', 'index.js'),
      replacements: [{ anchor: WS_ANCHOR, insert: WS_ANCHOR + '\n' + WS_INSERT }],
    },
    {
      file: path.join(nmRoot, '@deepseek-ai', 'dsh-session', 'lib', 'index.js'),
      replacements: [{ anchor: SESSION_ANCHOR, insert: SESSION_INSERT }],
    },
    {
      file: path.join(nmRoot, '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'),
      replacements: [
        { anchor: HOST_IMPORT_ANCHOR, insert: HOST_IMPORT_NEW },
        { anchor: HOST_IMPORT_JOIN_ANCHOR, insert: HOST_IMPORT_JOIN_NEW },
        { anchor: HOST_MAP_ANCHOR, insert: HOST_MAP_INSERT },
        { anchor: HOST_API_ANCHOR, insert: HOST_API_INSERT },
        { anchor: HOST_SCHEMA_ANCHOR, insert: HOST_SCHEMA_INSERT },
        { anchor: HOST_HANDLER_ANCHOR, insert: HOST_HANDLER_INSERT },
        { anchor: HOST_STATUS_ANCHOR, insert: HOST_STATUS_INSERT },
      ],
    },
    {
      file: path.join(nmRoot, '@deepseek-ai', 'dsh-client-connection', 'lib', 'client.js'),
      replacements: [
        { anchor: CONN_SCHEMA_ANCHOR, insert: CONN_SCHEMA_INSERT },
        { anchor: CONN_UNARY_ANCHOR, insert: CONN_UNARY_INSERT },
        { anchor: CONN_FACADE_ANCHOR, insert: CONN_FACADE_INSERT },
      ],
    },
    {
      file: path.join(nmRoot, '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'),
      replacements: [
        { anchor: UI_MENU_ANCHOR, insert: UI_MENU_INSERT },
        { anchor: UI_SELECT_ANCHOR, insert: UI_SELECT_INSERT },
        { anchor: UI_ZH_ANCHOR, insert: UI_ZH_INSERT },
        { anchor: UI_EN_ANCHOR, insert: UI_EN_INSERT },
      ],
      upgradeRules: [
        { anchor: UI_MENU_UPGRADE_ANCHOR, insert: UI_MENU_UPGRADE_INSERT },
      ],
    },
  ];
  let changed = 0;
  for (const t of targets) {
    if (!fs.existsSync(t.file)) continue;
    if (applyReplacements(t.file, t.replacements, t.upgradeRules ?? [], log)) changed += 1;
  }
  return changed;
}

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'node_modules');
  const n = patchSessionManage(root, (m) => console.log(m));
  console.log(n > 0 ? `patched ${n} file(s) — restart DSH Desktop to pick it up` : 'nothing to patch (already up to date)');
}

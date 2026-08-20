/**
 * lib/plugin-guard/ctx.ts — 插件保护中心的共享上下文与工具（Task 6.3 自
 * plugin-guard.js 提取）。
 *
 * 职责：承载 createGuard 注入的路径/日志依赖（GuardCtx），派生全部工作
 * 目录（profile / guard / rollbacks / incidents），并提供 JSON 原子读写、
 * 链接安全操作与 patch 行 id 提取等共享工具。
 *
 * 原则（对齐 healthcheck 的 HARD RULE）：只动插件层与配置层
 * （cordis.patch.yml / package.json / node_modules 里的遮蔽拷贝），
 * 绝不修改 harness 内核或用户会话数据。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** 快照覆盖的 profile 配置面：插件树的全部「声明性」状态。 */
export const GUARD_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'];

/** 客户端保留的快照份数上限。 */
export const MAX_SNAPSHOTS = 10;

/** createGuard 的注入依赖。 */
export interface GuardDeps {
  /** () => 有效的 DSH_HOME。 */
  getHome(): string;
  /** () => 桌面端使用的 profile 名。 */
  getProfile(): string;
  /** () => 当前生效的 dsh bin（内置或 overlay）。 */
  dshBin(): string;
  /** 日志通道（缺省为 no-op）。 */
  log?(tag: string, msg: string): void;
}

/** 派生路径与共享工具的上下文（各域模块的唯一依赖）。 */
export interface GuardCtx extends GuardDeps {
  home(): string;
  profileDir(): string;
  guardDir(): string;
  rollbacksDir(): string;
  stateFile(): string;
  incidentsDir(): string;
  log(tag: string, msg: string): void;
}

/** 从注入依赖构建上下文（路径函数保持惰性：每次调用现取）。 */
export function buildCtx(deps: GuardDeps): GuardCtx {
  const log = deps.log ?? ((): void => {});
  const ctx: GuardCtx = {
    ...deps,
    log,
    home(): string {
      return deps.getHome() || path.join(os.homedir(), '.dsh');
    },
    profileDir(): string {
      return path.join(this.home(), 'profiles', deps.getProfile());
    },
    guardDir(): string {
      return path.join(this.home(), 'guard');
    },
    rollbacksDir(): string {
      return path.join(this.home(), 'rollbacks', deps.getProfile());
    },
    stateFile(): string {
      return path.join(this.guardDir(), 'state.json');
    },
    incidentsDir(): string {
      return path.join(this.guardDir(), 'incidents');
    },
  };
  return ctx;
}

/** 快照元数据。 */
export interface SnapshotMeta {
  id: string;
  reason: string;
  at: string;
  files: string[];
  pluginRows: string[];
}

/** 体检发现项。 */
export interface Finding {
  code: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  fixable: boolean;
}

/** 体检结果。 */
export interface HealthReport {
  at: string;
  profile: string;
  findings: Finding[];
}

/** 读 JSON（失败返回 fallback，绝不抛出）。 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 原子写 JSON（tmp + rename；Windows 目标被占用时先删再换）。 */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true, maxRetries: 3 });
    fs.renameSync(tmp, file);
  }
}

/** 读链接目标（失败返回 null）。 */
export function safeReadlink(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * 删除链接节点：Windows 上 rmSync(force) 对 junction 抛 ERR_FS_EISDIR，
 * 删链接必须走 unlink（只摘链接本身，绝不递归目标）。
 */
export function removeLink(p: string): void {
  try {
    fs.unlinkSync(p);
    return;
  } catch {
    /* fall through */
  }
  fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 });
}

/** realpath（失败返回 null）。 */
export function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** 路径归一比较（反斜杠 + 小写）。 */
export function normPath(p: string): string {
  return String(p).replace(/\//g, '\\').toLowerCase();
}

/** 从 cordis.patch.yml 文本提取全部顶层行 id。 */
export function patchRowIds(patch: string | null | undefined): string[] {
  const ids: string[] = [];
  const re = /^\s*-\s*id:\s*([\w.-]+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(patch || ''))) !== null) {
    if (m[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

/**
 * 枚举 <home>/profiles/node_modules（共享模块 fallback）里的全部包名。
 * 兼容「顶层符号链接」「scope 目录 / 子链接或子目录」两种 pnpm 布局。
 */
export function fallbackPackages(fallbackDir: string): Array<{ full: string; rel: string }> {
  const names: Array<{ full: string; rel: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fallbackDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      names.push({ full: entry.name, rel: entry.name });
    } else if (entry.isDirectory()) {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.isSymbolicLink() || child.isDirectory()) {
          names.push({ full: entry.name + '/' + child.name, rel: path.join(entry.name, child.name) });
        }
      }
    }
  }
  return names;
}

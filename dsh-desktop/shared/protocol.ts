/**
 * shared/protocol.ts — VNext 插件隔离架构的「单点类型源」。
 *
 * 职责：RPC 消息、扩展注册表、SDK API 面、权限模型等跨边界结构的类型定义。
 * 主进程（Supervisor）、Extension Host（host-bootstrap）、Core Bridge 与 preload
 * 全部从这里导入类型，保证三方的协议视图编译期一致。
 *
 * 注意：本文件遵守 erasableSyntaxOnly（仅类型/接口，无运行时语句），
 * 因此既可被 tsc 编译，也可被 Node ≥ 23.6 的 type-stripping 直接执行。
 */

/** 扩展（插件）类型：隔离 SDK 插件 / Legacy Cordis 直注入插件。 */
export type ExtensionKind = 'isolated' | 'legacy';

/** 插件来源。 */
export type ExtensionSource = 'builtin' | 'market' | 'manual';

/** 风险等级（恢复中心展示 + 注册表归档）。 */
export type ExtensionRisk = 'trusted-core' | 'legacy-cordis' | 'isolated-sdk';

/** 故障状态机（架构文档 §8）。 */
export type ExtensionState =
  | 'installed'
  | 'disabled'
  | 'starting'
  | 'running'
  | 'retrying'
  | 'failed'
  | 'quarantined'
  | 'uninstalled';

/** 插件能力权限声明（deny-by-default：未声明即不可见）。 */
export interface ExtensionPermissions {
  /** 允许访问的网络主机白名单（如 ['api.github.com']）。 */
  readonly net?: readonly string[];
  /** 允许读写的目录白名单（插件 data 目录始终可见）。 */
  readonly fs?: readonly string[];
  /** 是否允许派生子进程（默认 false）。 */
  readonly shell?: boolean;
  /** 是否允许读取环境变量（默认 false）。 */
  readonly env?: boolean;
}

/** 注册表中单个插件条目的静态档案（动态字段见 ExtensionRuntimeState）。 */
export interface ExtensionRecord {
  readonly id: string;
  readonly version: string;
  readonly source: ExtensionSource;
  readonly risk: ExtensionRisk;
  readonly kind: ExtensionKind;
  /** 安装包内容 SHA-256（原子安装校验 + 完整性锁定）。 */
  readonly packageSha256: string;
  readonly installedAt: string;
  readonly permissions: ExtensionPermissions;
  /** 可回滚的历史版本（新版本在前）。 */
  readonly rollbackVersions: readonly { version: string; packageSha256: string }[];
}

/** 注册表中单个插件条目的动态状态（Supervisor 运行期可变字段）。 */
export interface ExtensionRuntimeState {
  state: ExtensionState;
  enabled: boolean;
  /** 连续崩溃次数（成功运行达到稳定期后清零）。 */
  crashStreak: number;
  /** 最近一次错误摘要（恢复中心展示）。 */
  lastError?: string;
  lastErrorAt?: string;
  lastHealthyAt?: string;
  /** 退避重试的下次允许启动时间（ISO 时间戳）。 */
  nextRetryAt?: string;
}

/** 注册表整体结构（<DSH_HOME>/extensions/registry.json）。 */
export interface ExtensionRegistry {
  readonly schemaVersion: 1;
  readonly plugins: Record<string, ExtensionRecord & ExtensionRuntimeState>;
}

/** 状态机转移结果。 */
export interface TransitionResult {
  readonly from: ExtensionState;
  readonly to: ExtensionState;
  /** 是否产生了需要落盘的变化。 */
  readonly changed: boolean;
  /** 转移原因（写事故记录）。 */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Extension Host RPC（长度前缀帧 + JSON-RPC 风格消息，§5/§9 Phase 2）
// ---------------------------------------------------------------------------

/** 帧上限（4MB）：超限视为恶意/故障流，立即断开 Host。 */
export const RPC_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** 请求（Supervisor → Host 或 Host → Supervisor 双向）。 */
export interface RpcRequest {
  kind: 'req';
  id: string;
  method: string;
  params?: unknown;
}

/** 响应（ok=true 携 result；ok=false 携 error 文本）。 */
export interface RpcResponse {
  kind: 'res';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 通知（单向，无需应答：事件推送/心跳）。 */
export interface RpcNotification {
  kind: 'notify';
  method: string;
  params?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

/** Supervisor → Host 心跳探测参数。 */
export interface PingParams {
  /** 发出时间戳（Host 原样回带，供 RTT 测量）。 */
  t: number;
}

/** Supervisor → Host 初始化参数（host-bootstrap 收到后才加载插件代码）。 */
export interface HostInitParams {
  pluginId: string;
  /** 插件入口绝对路径（extensions/<id>/package/<main>）。 */
  entryPath: string;
  /** 插件私有数据目录（extensions/<id>/data）。 */
  dataDir: string;
  /** deny-by-default 权限（来自注册表档案）。 */
  permissions: ExtensionPermissions;
}

/** SDK 工具元数据（Core Bridge 据此向 Agent 注册工具）。 */
export interface HostToolMeta {
  name: string;
  description?: string;
  /** dsh 风格参数描述符（{key: {type, required?, description?}}）。 */
  parameters?: Record<string, { type?: string; required?: boolean; description?: string }>;
}

/** Host init 应答：插件声明的工具元数据列表（Core Bridge 桥接用）。 */
export interface HostInitResult {
  tools: HostToolMeta[];
}

/** Supervisor → Host 工具调用参数。 */
export interface HostInvokeParams {
  tool: string;
  args?: unknown;
}

/** Host → Supervisor 日志通知参数。 */
export interface HostLogParams {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
}

/** Supervisor → Host 事件通知参数（只读事件订阅，SDK ctx.on 分发）。 */
export interface SdkEventParams {
  name: string;
  payload?: unknown;
}

/** Supervisor → Host 上下文收集请求（system-prompt/assemble 前触发）。 */
export interface CollectContextParams {
  sessionId: string;
}

/** 上下文贡献（assembly.contexts 追加项）。 */
export interface ContextContribution {
  name: string;
  order: number;
  text: string;
}

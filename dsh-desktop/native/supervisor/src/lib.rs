//! dsh-supervisor-native — DSH Desktop Supervisor 的 OS 级进程围栏（VNext Phase 2）。
//!
//! 职责（spec F1.1）：
//!   1. Win32 Job Object 管理：`KILL_ON_JOB_CLOSE`（Supervisor 崩溃时 OS 自动
//!      回收全部 Host，杜绝孤儿插件进程）+ `PROCESS_MEMORY` 每插件内存硬上限
//!      + `CPU_RATE` 配额结构预留；
//!   2. assign_to_job：Node 侧 spawn 后立即把 pid 绑入 Job（OpenProcess +
//!      AssignProcessToJobObject）。Node 26 libuv 已不用 CRT fd 表，原生侧
//!      自建管道无法交还 Node 流，故 stdio 归 Node、围栏归 Rust；spawn 与
//!      assign 的毫秒级窗口由协议层闭合（host-bootstrap 收到 init 前不跑
//!      插件代码），详见 job.rs 模块头注释；
//!   3. 流式 SHA-256（64KB 分块，供 installer 的 hashTree 复用）。
//!
//! 非 Windows 平台：Job 相关调用返回错误（TS 侧 job-fence 优雅降级为
//! taskkill 树回收）；SHA-256 跨平台可用。

#![deny(clippy::unwrap_used)]

mod job;
mod sha256;

pub use job::*;
pub use sha256::*;

//! dsh-snapshot-native — DSH Desktop 快照管理器引擎。
//!
//! 职责（git 同构的最小增量备份）：
//!   1. 内容寻址对象库：每个文件按 SHA-256 入库 `objects/<hash[..2]>/<hash>`，
//!      哈希相同（二进制校验一致）绝不重复存储；
//!   2. mtime+size 索引缓存（`index.json`）：未变更的文件跳过哈希计算，
//!      重复备份退化为元数据遍历；
//!   3. 快照树：每次备份写 `snapshots/<id>.json`（parent 指向上一次快照），
//!      分支 = `branches/<name>.json` 命名指针，与 git commit/branch 同构；
//!   4. 恢复：按快照文件清单把对象写回源目录，并删除清单之外的增量文件
//!      （排除列表内的目录永不触碰），恢复前可自动创建安全快照；
//!   5. 配置（`config.json`）：默认排除 `skills` / `sessions` / `.agent-presets`
//!      / `memories` / `node_modules`（junction 闭包由 dsh-app-boot 重建，按文件
//!      复制反而会实体化），用户可自定义；定时备份计划一并持久化。
//!
//! 存储布局（与被备份的 .dsh 分离，避免自引用）：
//! ```text
//! <store>/
//!   config.json     排除列表 + 定时计划 + 当前分支
//!   index.json      路径 → {mtime, size, hash} 哈希缓存
//!   objects/ab/…    内容寻址对象（不可变）
//!   snapshots/…     快照元数据（parent 链 = 备份树）
//!   branches/…      分支指针（head → 快照 id）
//! ```

#![deny(clippy::unwrap_used)]

mod engine;
mod exclude;
mod fsutil;
mod store;
mod types;

pub use engine::*;
pub use exclude::*;
pub use fsutil::*;
pub use store::*;
pub use types::*;

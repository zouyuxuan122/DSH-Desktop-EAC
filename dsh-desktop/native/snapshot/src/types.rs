//! types.rs — 磁盘格式（serde）与 napi 导出对象（camelCase）及互转。
//!
//! 磁盘结构只依赖 serde（版本演进空间）；napi 对象是 TS 侧的契约面，
//! 时间戳/尺寸统一 f64（JS number 安全整数域内，无 BigInt 摩擦）。

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// 磁盘结构（serde）
// ---------------------------------------------------------------------------

/** 单文件条目：相对路径 + 内容哈希 + 尺寸。 */
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiskFileEntry {
    pub path: String,
    pub hash: String,
    pub size: u64,
}

/** 快照统计。 */
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DiskStats {
    pub files_total: u64,
    pub files_new: u64,
    pub bytes_new: u64,
    pub files_skipped: u64,
}

/** 快照元数据（snapshots/<id>.json）。parent 链构成备份树。 */
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiskSnapshot {
    pub id: String,
    pub parent: Option<String>,
    pub branch: String,
    pub message: String,
    pub created_at_ms: u64,
    pub trigger: String,
    pub files: Vec<DiskFileEntry>,
    pub stats: DiskStats,
}

/** 分支指针（branches/<name>.json）。head 为空串 = 未落首个快照。 */
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiskBranch {
    pub name: String,
    pub head: String,
    pub created_at_ms: u64,
}

/** 存储配置（config.json）。 */
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DiskConfig {
    pub version: u32,
    pub exclusions: Vec<String>,
    pub schedule_enabled: bool,
    pub schedule_mode: String,
    pub interval_minutes: u64,
    pub daily_time: String,
    pub current_branch: String,
}

/** 哈希缓存条目（index.json）。m = mtime 毫秒，s = 尺寸，h = SHA-256。 */
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiskIndexEntry {
    pub m: i64,
    pub s: u64,
    pub h: String,
}

/** 哈希缓存（index.json）。按相对路径索引。 */
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DiskIndex {
    pub version: u32,
    pub entries: BTreeMap<String, DiskIndexEntry>,
}

// ---------------------------------------------------------------------------
// napi 导出对象（TS 契约面）
// ---------------------------------------------------------------------------

/** 快照摘要（列表/树用；文件清单见 SnapshotDetail）。 */
#[napi(object)]
pub struct SnapshotSummary {
    pub id: String,
    pub parent: Option<String>,
    pub branch: String,
    pub message: String,
    /// 创建时间（Unix 毫秒）。
    pub created_at_ms: f64,
    /// manual | scheduled | restore-point。
    pub trigger: String,
    pub files_total: f64,
    pub files_new: f64,
    pub bytes_new: f64,
    pub files_skipped: f64,
}

/** 快照详情（含完整文件清单）。 */
#[napi(object)]
pub struct SnapshotFile {
    pub path: String,
    pub hash: String,
    pub size: f64,
}

/** 快照详情（含完整文件清单）。 */
#[napi(object)]
pub struct SnapshotDetail {
    pub id: String,
    pub parent: Option<String>,
    pub branch: String,
    pub message: String,
    pub created_at_ms: f64,
    pub trigger: String,
    pub files: Vec<SnapshotFile>,
}

/** 分支信息。 */
#[napi(object)]
pub struct BranchInfo {
    pub name: String,
    /// 当前 head 快照 id（空串 = 尚无快照）。
    pub head: String,
    pub created_at_ms: f64,
    pub is_current: bool,
}

/** 存储配置（TS 侧可读写的完整面）。 */
#[napi(object)]
#[derive(Clone)]
pub struct SnapshotConfigInfo {
    pub exclusions: Vec<String>,
    pub schedule_enabled: bool,
    /// interval | daily。
    pub schedule_mode: String,
    pub interval_minutes: f64,
    /// HH:MM（24 小时制）。
    pub daily_time: String,
    pub current_branch: String,
}

/** 创建快照选项。 */
#[napi(object)]
pub struct CreateSnapshotOpts {
    pub store_dir: String,
    pub source_dir: String,
    pub message: Option<String>,
    /// manual | scheduled | restore-point（缺省 manual）。
    pub trigger: Option<String>,
    /// 目标分支（缺省 = 配置里的当前分支）。
    pub branch: Option<String>,
}

/** 恢复选项。 */
#[napi(object)]
pub struct RestoreOpts {
    pub store_dir: String,
    pub snapshot_id: String,
    pub target_dir: String,
    /// 恢复前自动创建安全快照（缺省 true）。
    pub safety_snapshot: Option<bool>,
}

/** 恢复结果。 */
#[napi(object)]
pub struct RestoreResult {
    pub restored_files: f64,
    pub deleted_files: f64,
    /// 恢复前安全快照 id（创建失败/关闭时为 None）。
    pub safety_snapshot_id: Option<String>,
}

/** GC 结果。 */
#[napi(object)]
pub struct GcResult {
    pub removed_objects: f64,
    pub bytes_freed: f64,
}

// ---------------------------------------------------------------------------
// 互转
// ---------------------------------------------------------------------------

impl From<&DiskSnapshot> for SnapshotSummary {
    fn from(s: &DiskSnapshot) -> Self {
        SnapshotSummary {
            id: s.id.clone(),
            parent: s.parent.clone(),
            branch: s.branch.clone(),
            message: s.message.clone(),
            created_at_ms: s.created_at_ms as f64,
            trigger: s.trigger.clone(),
            files_total: s.stats.files_total as f64,
            files_new: s.stats.files_new as f64,
            bytes_new: s.stats.bytes_new as f64,
            files_skipped: s.stats.files_skipped as f64,
        }
    }
}

impl From<&DiskSnapshot> for SnapshotDetail {
    fn from(s: &DiskSnapshot) -> Self {
        SnapshotDetail {
            id: s.id.clone(),
            parent: s.parent.clone(),
            branch: s.branch.clone(),
            message: s.message.clone(),
            created_at_ms: s.created_at_ms as f64,
            trigger: s.trigger.clone(),
            files: s
                .files
                .iter()
                .map(|f| SnapshotFile {
                    path: f.path.clone(),
                    hash: f.hash.clone(),
                    size: f.size as f64,
                })
                .collect(),
        }
    }
}

impl From<&DiskBranch> for BranchInfo {
    fn from(b: &DiskBranch) -> Self {
        BranchInfo {
            name: b.name.clone(),
            head: b.head.clone(),
            created_at_ms: b.created_at_ms as f64,
            is_current: false,
        }
    }
}

impl From<&DiskConfig> for SnapshotConfigInfo {
    fn from(c: &DiskConfig) -> Self {
        SnapshotConfigInfo {
            exclusions: c.exclusions.clone(),
            schedule_enabled: c.schedule_enabled,
            schedule_mode: c.schedule_mode.clone(),
            interval_minutes: c.interval_minutes as f64,
            daily_time: c.daily_time.clone(),
            current_branch: c.current_branch.clone(),
        }
    }
}

//! engine.rs — 快照引擎编排：创建（增量去重）/ 列表 / 分支 / 恢复 / 删除 / GC。
//!
//! 全部 napi 函数无状态（store/source 路径显式传参），TS 侧负责调度与
//! 服务编排；本模块只对磁盘事实负责，错误信息中文定位。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use napi::{Error, Result, Status};
use napi_derive::napi;

use crate::fsutil::{
    atomic_copy, gen_snapshot_id, hash_file, now_ms, remove_empty_dirs, walk_files,
};
use crate::store::{
    Store, valid_branch_name, valid_daily_time, DEFAULT_EXCLUSIONS,
};
use crate::types::{
    BranchInfo, CreateSnapshotOpts, DiskBranch, DiskConfig, DiskFileEntry, DiskIndex,
    DiskIndexEntry, DiskSnapshot, DiskStats, GcResult, RestoreOpts, RestoreResult,
    SnapshotConfigInfo, SnapshotDetail, SnapshotSummary,
};

fn err(msg: String) -> Error {
    Error::new(Status::GenericFailure, msg)
}

// ---------------------------------------------------------------------------
// 创建快照（增量 + 内容寻址去重）
// ---------------------------------------------------------------------------

/// 创建快照：遍历源目录（应用排除列表）→ 命中 mtime+size 缓存的文件直接
/// 复用哈希 → 新内容写入对象库 → 快照元数据 parent 指向目标分支当前 head。
/// files_new = 与父快照哈希不同的文件数（真正的增量）。
#[napi]
pub fn snapshot_create(opts: CreateSnapshotOpts) -> Result<SnapshotSummary> {
    let store = Store::open(&opts.store_dir);
    store
        .ensure_layout()
        .map_err(|e| err(format!("初始化存储失败: {e}")))?;
    let config = store.load_config();

    let branch = opts.branch.clone().unwrap_or_else(|| config.current_branch.clone());
    if !valid_branch_name(&branch) {
        return Err(err(format!("非法分支名: {branch}")));
    }
    let trigger = opts.trigger.clone().unwrap_or_else(|| "manual".to_string());
    let message = opts
        .message
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default_message(&trigger));

    // 1. 遍历（排除列表来自配置；排除目录永不入库）
    let walk = walk_files(opts.source_dir.as_ref(), &config.exclusions)
        .map_err(|e| err(format!("遍历源目录失败 {}: {e}", opts.source_dir)))?;

    // 2. 父快照（目标分支 head）→ 增量比较基线
    let branches = store.load_branches();
    let parent_id = branches.get(&branch).map(|b| b.head.clone()).filter(|h| !h.is_empty());
    let parent_files: BTreeMap<String, String> = parent_id
        .as_ref()
        .and_then(|id| store.load_snapshot(id).ok())
        .map(|s| s.files.iter().map(|f| (f.path.clone(), f.hash.clone())).collect())
        .unwrap_or_default();

    // 3. 逐文件：缓存命中 → 复用哈希；否则哈希并入库（对象已存在则跳过复制）
    let index = store.load_index();
    let mut new_index = DiskIndex {
        version: 1,
        entries: BTreeMap::new(),
    };
    let mut files: Vec<DiskFileEntry> = Vec::with_capacity(walk.files.len());
    let mut files_new: u64 = 0;
    let mut bytes_new: u64 = 0;

    for wf in &walk.files {
        let cached = index.entries.get(&wf.rel);
        let hash = match cached.filter(|c| c.m == wf.mtime_ns && c.s == wf.size) {
            Some(c) => c.h.clone(),
            None => {
                let h = hash_file(&wf.abs)
                    .map_err(|e| err(format!("哈希失败 {}: {e}", wf.rel)))?;
                // 入对象库（哈希相同 → 对象已存在 → 不重复备份）
                let obj = store.object_path(&h);
                if !obj.exists() {
                    atomic_copy(&wf.abs, &obj)
                        .map_err(|e| err(format!("写对象失败 {}: {e}", wf.rel)))?;
                }
                h
            }
        };
        let is_new = parent_files.get(&wf.rel).map(|h| h != &hash).unwrap_or(true);
        if is_new {
            files_new += 1;
            bytes_new += wf.size;
        }
        new_index.entries.insert(
            wf.rel.clone(),
            DiskIndexEntry {
                m: wf.mtime_ns,
                s: wf.size,
                h: hash.clone(),
            },
        );
        files.push(DiskFileEntry {
            path: wf.rel.clone(),
            hash,
            size: wf.size,
        });
    }

    // 4. 落快照元数据 + 分支指针 + 索引（全部原子写，崩溃不留半态）
    let ms = now_ms();
    let snap = DiskSnapshot {
        id: gen_snapshot_id(ms),
        parent: parent_id,
        branch: branch.clone(),
        message,
        created_at_ms: ms,
        trigger,
        files,
        stats: DiskStats {
            files_total: new_index.entries.len() as u64,
            files_new,
            bytes_new,
            files_skipped: walk.skipped,
        },
    };
    store
        .save_snapshot(&snap)
        .map_err(|e| err(format!("保存快照失败: {e}")))?;
    store
        .save_branch(&DiskBranch {
            name: branch.clone(),
            head: snap.id.clone(),
            created_at_ms: branches
                .get(&branch)
                .map(|b| b.created_at_ms)
                .unwrap_or(ms),
        })
        .map_err(|e| err(format!("更新分支失败: {e}")))?;
    store
        .save_index(&new_index)
        .map_err(|e| err(format!("保存索引失败: {e}")))?;

    Ok(SnapshotSummary::from(&snap))
}

fn default_message(trigger: &str) -> String {
    match trigger {
        "scheduled" => "定时备份".to_string(),
        "restore-point" => "恢复前自动快照".to_string(),
        _ => "手动备份".to_string(),
    }
}

// ---------------------------------------------------------------------------
// 列表 / 详情
// ---------------------------------------------------------------------------

/// 全部快照摘要（旧→新；树渲染由 TS 完成）。
#[napi]
pub fn snapshot_list(store_dir: String) -> Result<Vec<SnapshotSummary>> {
    let store = Store::open(&store_dir);
    Ok(store.list_snapshots().iter().map(SnapshotSummary::from).collect())
}

/// 单个快照详情（含完整文件清单）。
#[napi]
pub fn snapshot_detail(store_dir: String, snapshot_id: String) -> Result<SnapshotDetail> {
    let store = Store::open(&store_dir);
    let s = store.load_snapshot(&snapshot_id).map_err(err)?;
    Ok(SnapshotDetail::from(&s))
}

// ---------------------------------------------------------------------------
// 分支
// ---------------------------------------------------------------------------

/// 全部分支（is_current 标记当前分支）。
#[napi]
pub fn snapshot_branches(store_dir: String) -> Result<Vec<BranchInfo>> {
    let store = Store::open(&store_dir);
    let config = store.load_config();
    let mut out: Vec<BranchInfo> = store
        .load_branches()
        .values()
        .map(|b| {
            let mut info = BranchInfo::from(b);
            info.is_current = b.name == config.current_branch;
            info
        })
        .collect();
    // 空库时 branches/ 尚无 main 文件 —— 补一个未出生分支让 UI 可选
    if !out.iter().any(|b| b.name == config.current_branch) {
        out.push(BranchInfo {
            name: config.current_branch.clone(),
            head: String::new(),
            created_at_ms: 0.0,
            is_current: true,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 创建分支：from_id 缺省 = 当前分支 head（空库则未出生）。
#[napi]
pub fn snapshot_create_branch(
    store_dir: String,
    name: String,
    from_id: Option<String>,
) -> Result<BranchInfo> {
    if !valid_branch_name(&name) {
        return Err(err(format!(
            "分支名须为字母数字开头、1-64 位 [A-Za-z0-9._-]: {name}"
        )));
    }
    let store = Store::open(&store_dir);
    store
        .ensure_layout()
        .map_err(|e| err(format!("初始化存储失败: {e}")))?;
    let branches = store.load_branches();
    if branches.contains_key(&name) {
        return Err(err(format!("分支已存在: {name}")));
    }
    let config = store.load_config();
    let head = match from_id {
        Some(id) => {
            store.load_snapshot(&id).map_err(err)?; // 校验存在
            id
        }
        None => branches
            .get(&config.current_branch)
            .map(|b| b.head.clone())
            .unwrap_or_default(),
    };
    let b = DiskBranch {
        name: name.clone(),
        head,
        created_at_ms: now_ms(),
    };
    store
        .save_branch(&b)
        .map_err(|e| err(format!("保存分支失败: {e}")))?;
    let mut info = BranchInfo::from(&b);
    info.is_current = b.name == config.current_branch;
    Ok(info)
}

/// 删除分支（当前分支不可删；快照本体保留，仅移除指针）。
#[napi]
pub fn snapshot_delete_branch(store_dir: String, name: String) -> Result<()> {
    let store = Store::open(&store_dir);
    let config = store.load_config();
    if name == config.current_branch {
        return Err(err(format!("不能删除当前分支: {name}")));
    }
    if !store.load_branches().contains_key(&name) {
        return Err(err(format!("分支不存在: {name}")));
    }
    store
        .delete_branch_file(&name)
        .map_err(|e| err(format!("删除分支失败: {e}")))
}

/// 切换当前分支（后续手动/定时备份落在新分支上）。
#[napi]
pub fn snapshot_set_current_branch(store_dir: String, name: String) -> Result<()> {
    let store = Store::open(&store_dir);
    let mut config = store.load_config();
    let branches = store.load_branches();
    // main 允许未出生（空库默认分支）；其余必须已存在
    if !branches.contains_key(&name) && name != "main" {
        return Err(err(format!("分支不存在: {name}")));
    }
    config.current_branch = name;
    store
        .save_config(&config)
        .map_err(|e| err(format!("保存配置失败: {e}")))
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/// 恢复到指定快照：可选先建安全快照 → 校验对象齐备 → 全量写回 → 删除
/// 清单之外的增量文件（排除目录内文件永不触碰）→ 清理空目录。
#[napi]
pub fn snapshot_restore(opts: RestoreOpts) -> Result<RestoreResult> {
    let store = Store::open(&opts.store_dir);
    store
        .ensure_layout()
        .map_err(|e| err(format!("初始化存储失败: {e}")))?;
    let config = store.load_config();
    let snap = store.load_snapshot(&opts.snapshot_id).map_err(err)?;
    let target = std::path::Path::new(&opts.target_dir);

    // 1. 安全快照（best-effort：源目录已损坏时也不阻断恢复）
    let safety_id: Option<String> = if opts.safety_snapshot.unwrap_or(true) {
        snapshot_create(CreateSnapshotOpts {
            store_dir: opts.store_dir.clone(),
            source_dir: opts.target_dir.clone(),
            message: Some("恢复前自动快照".to_string()),
            trigger: Some("restore-point".to_string()),
            branch: None,
        })
        .ok()
        .map(|s| s.id)
    } else {
        None
    };

    // 2. 对象齐备性预检（半恢复比不恢复更糟）
    for f in &snap.files {
        if !store.object_path(&f.hash).exists() {
            return Err(err(format!(
                "对象缺失（存储损坏）: {} → {}",
                f.path, f.hash
            )));
        }
    }

    // 3. 写回（原子复制）
    let want: BTreeSet<&str> = snap.files.iter().map(|f| f.path.as_str()).collect();
    let mut restored = 0u64;
    for f in &snap.files {
        let dst = target.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        atomic_copy(&store.object_path(&f.hash), &dst)
            .map_err(|e| err(format!("写回失败 {}: {e}", f.path)))?;
        restored += 1;
    }

    // 4. 删除清单之外的增量文件（同一套排除列表圈定作用域）
    let walk = walk_files(target, &config.exclusions)
        .map_err(|e| err(format!("遍历目标目录失败: {e}")))?;
    let mut deleted = 0u64;
    let mut dirs: Vec<String> = Vec::new();
    for wf in &walk.files {
        if !want.contains(wf.rel.as_str()) {
            if let Err(e) = fs::remove_file(&wf.abs) {
                return Err(err(format!("删除增量文件失败 {}: {e}", wf.rel)));
            }
            deleted += 1;
        }
    }
    // 收集全部目录（相对路径），交给自底向上空目录清理
    collect_dirs(target, "", &config.exclusions, &mut dirs);
    remove_empty_dirs(target, &dirs);

    Ok(RestoreResult {
        restored_files: restored as f64,
        deleted_files: deleted as f64,
        safety_snapshot_id: safety_id,
    })
}

fn collect_dirs(root: &std::path::Path, rel: &str, exclusions: &[String], out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(root) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if crate::exclude::is_excluded(&child_rel, exclusions) {
            continue;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() && !ft.is_symlink() {
            out.push(child_rel.clone());
            collect_dirs(&entry.path(), &child_rel, exclusions, out);
        }
    }
}

// ---------------------------------------------------------------------------
// 删除 / GC
// ---------------------------------------------------------------------------

/// 删除快照（任何分支 head 指向的快照不可删；对象留给 GC 回收）。
#[napi]
pub fn snapshot_delete(store_dir: String, snapshot_id: String) -> Result<()> {
    let store = Store::open(&store_dir);
    store.load_snapshot(&snapshot_id).map_err(err)?;
    let heads: Vec<String> = store
        .load_branches()
        .values()
        .filter(|b| b.head == snapshot_id)
        .map(|b| b.name.clone())
        .collect();
    if !heads.is_empty() {
        return Err(err(format!(
            "该快照是分支 {} 的 head，不可删除",
            heads.join(", ")
        )));
    }
    store
        .delete_snapshot_file(&snapshot_id)
        .map_err(|e| err(format!("删除快照失败: {e}")))
}

/// 回收无引用对象（删除快照后释放空间）。
#[napi]
pub fn snapshot_gc(store_dir: String) -> Result<GcResult> {
    let store = Store::open(&store_dir);
    let referenced: BTreeSet<String> = store
        .list_snapshots()
        .iter()
        .flat_map(|s| s.files.iter().map(|f| f.hash.clone()))
        .collect();
    let mut removed = 0u64;
    let mut freed = 0u64;
    for (hash, path) in store.iter_objects() {
        if referenced.contains(&hash) {
            continue;
        }
        if let Ok(md) = fs::metadata(&path) {
            freed += md.len();
        }
        if fs::remove_file(&path).is_ok() {
            removed += 1;
            // 顺手清空目录（失败=非空，忽略）
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
    Ok(GcResult {
        removed_objects: removed as f64,
        bytes_freed: freed as f64,
    })
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/// 读配置（存储不存在时返回默认值，不落盘）。
#[napi]
pub fn snapshot_config_load(store_dir: String) -> Result<SnapshotConfigInfo> {
    let store = Store::open(&store_dir);
    Ok(SnapshotConfigInfo::from(&store.load_config()))
}

/// 校验并保存配置（normalize 后返回定型值）。
#[napi]
pub fn snapshot_config_save(
    store_dir: String,
    config: SnapshotConfigInfo,
) -> Result<SnapshotConfigInfo> {
    let store = Store::open(&store_dir);
    store
        .ensure_layout()
        .map_err(|e| err(format!("初始化存储失败: {e}")))?;
    // 前置校验（比 normalize 静默纠正更诚实的错误面）
    if config.schedule_mode != "interval" && config.schedule_mode != "daily" {
        return Err(err("schedule_mode 须为 interval 或 daily".to_string()));
    }
    if !valid_daily_time(&config.daily_time) {
        return Err(err(format!("daily_time 须为 HH:MM（24 小时制）: {}", config.daily_time)));
    }
    if config.interval_minutes < 1.0 || config.interval_minutes > 525_600.0 {
        return Err(err("interval_minutes 须在 1-525600 之间".to_string()));
    }
    if !valid_branch_name(&config.current_branch) {
        return Err(err(format!("非法分支名: {}", config.current_branch)));
    }
    for e in &config.exclusions {
        if e.len() > 256 {
            return Err(err(format!("排除项过长（>256 字符）: {e}")));
        }
    }
    let disk = DiskConfig {
        version: 1,
        exclusions: config.exclusions.clone(),
        schedule_enabled: config.schedule_enabled,
        schedule_mode: config.schedule_mode.clone(),
        interval_minutes: config.interval_minutes as u64,
        daily_time: config.daily_time.clone(),
        current_branch: config.current_branch.clone(),
    };
    store
        .save_config(&disk)
        .map_err(|e| err(format!("保存配置失败: {e}")))?;
    Ok(SnapshotConfigInfo::from(&store.load_config()))
}

/// 默认排除列表（UI「恢复默认」按钮用）。
#[napi]
pub fn snapshot_default_exclusions() -> Vec<String> {
    DEFAULT_EXCLUSIONS.iter().map(|s| s.to_string()).collect()
}

// ---------------------------------------------------------------------------
// 测试（真实文件系统上的引擎级端到端）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::testutil::*;

    struct Ctx {
        store: std::path::PathBuf,
        src: std::path::PathBuf,
    }

    impl Drop for Ctx {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.store);
            let _ = fs::remove_dir_all(&self.src);
        }
    }

    fn setup(tag: &str) -> Ctx {
        let base = test_temp_dir(tag);
        let store = base.join("store");
        let src = base.join("dsh");
        fs::create_dir_all(&store).expect("store");
        fs::create_dir_all(&src).expect("src");
        Ctx { store, src }
    }

    fn create(store: &str, src: &str, message: &str) -> SnapshotSummary {
        snapshot_create(CreateSnapshotOpts {
            store_dir: store.to_string(),
            source_dir: src.to_string(),
            message: Some(message.to_string()),
            trigger: Some("manual".to_string()),
            branch: None,
        })
        .expect("create")
    }

    #[test]
    fn create_dedup_and_increment() {
        let c = setup("dedup");
        write_file(&c.src, "settings.yaml", "v1");
        write_file(&c.src, "profiles/web/cordis.patch.yml", "patch");
        write_file(&c.src, "skills/big.md", "x"); // 默认排除

        let s = create(c.store.to_str().unwrap(), c.src.to_str().unwrap(), "第一次");
        assert_eq!(s.files_total, 2.0);
        assert_eq!(s.files_new, 2.0);
        assert_eq!(s.trigger, "manual");

        // 无变化：全部命中缓存，零增量
        let s2 = create(c.store.to_str().unwrap(), c.src.to_str().unwrap(), "第二次");
        assert_eq!(s2.files_total, 2.0);
        assert_eq!(s2.files_new, 0.0);
        assert_eq!(s2.parent.as_deref(), Some(s.id.as_str()));

        // 改一个文件：仅该文件计入增量
        write_file(&c.src, "settings.yaml", "v2");
        let s3 = create(c.store.to_str().unwrap(), c.src.to_str().unwrap(), "第三次");
        assert_eq!(s3.files_total, 2.0);
        assert_eq!(s3.files_new, 1.0);
        assert_eq!(s3.bytes_new, 2.0);
    }

    #[test]
    fn object_store_is_content_addressed() {
        let c = setup("ca");
        write_file(&c.src, "a.txt", "same-content");
        create(c.store.to_str().unwrap(), c.src.to_str().unwrap(), "1");
        write_file(&c.src, "a.txt", "same-content"); // 内容相同
        write_file(&c.src, "b.txt", "same-content"); // 不同路径同内容 → 同一对象
        let s2 = create(c.store.to_str().unwrap(), c.src.to_str().unwrap(), "2");
        // 对象库只有 1 个对象（同内容去重）
        let store = Store::open(c.store.to_str().unwrap());
        assert_eq!(store.iter_objects().len(), 1);
        assert_eq!(s2.files_new, 1.0); // b.txt 对父快照是新文件
    }

    #[test]
    fn branch_lifecycle() {
        let c = setup("branch");
        write_file(&c.src, "a.txt", "1");
        let s1 = create(c.store.to_str().unwrap(), c.src.to_str().unwrap(), "main-1");
        let st = c.store.to_str().unwrap();

        let b = snapshot_create_branch(st.to_string(), "experiment".to_string(), None)
            .expect("branch");
        assert_eq!(b.head, s1.id);

        // 切到 experiment 再备份 → parent = 同一 head，形成分叉
        snapshot_set_current_branch(st.to_string(), "experiment".to_string()).expect("set");
        write_file(&c.src, "a.txt", "2-exp");
        let s2 = create(st, c.src.to_str().unwrap(), "exp-1");
        assert_eq!(s2.branch, "experiment");
        assert_eq!(s2.parent.as_deref(), Some(s1.id.as_str()));

        // 分支列表：两个分支各自 head
        let bs = snapshot_branches(st.to_string()).expect("branches");
        assert_eq!(bs.len(), 2);
        let exp = bs.iter().find(|b| b.name == "experiment").expect("exp");
        assert_eq!(exp.head, s2.id);
        assert!(exp.is_current);

        // 当前分支不可删；main 可删（非当前）
        assert!(snapshot_delete_branch(st.to_string(), "experiment".to_string()).is_err());
        assert!(snapshot_delete_branch(st.to_string(), "main".to_string()).is_ok());
    }

    #[test]
    fn restore_roundtrip_with_safety() {
        let c = setup("restore");
        let st = c.store.to_str().unwrap();
        let src = c.src.to_str().unwrap();

        write_file(&c.src, "settings.yaml", "good-v1");
        write_file(&c.src, "extra.txt", "will-vanish-later");
        let s1 = create(st, src, "基线");

        // 演进：改 settings、删 extra、加新文件
        write_file(&c.src, "settings.yaml", "broken-v2");
        fs::remove_file(c.src.join("extra.txt")).expect("rm");
        write_file(&c.src, "new.txt", "new-file");
        // 恢复前先做一个"当前坏状态"快照，验证安全快照挂在主链上
        create(st, src, "坏状态");

        let r = snapshot_restore(RestoreOpts {
            store_dir: st.to_string(),
            snapshot_id: s1.id.clone(),
            target_dir: src.to_string(),
            safety_snapshot: Some(true),
        })
        .expect("restore");

        // 内容回到基线；清单外的新文件被删；安全快照已创建
        assert_eq!(read_file(&c.src, "settings.yaml"), "good-v1");
        assert_eq!(read_file(&c.src, "extra.txt"), "will-vanish-later");
        assert!(!c.src.join("new.txt").exists());
        assert!(r.restored_files >= 2.0);
        assert!(r.deleted_files >= 1.0);
        assert!(r.safety_snapshot_id.is_some());

        // 安全快照把坏状态完整留档（可再次恢复回去）
        let snaps = snapshot_list(st.to_string()).expect("list");
        assert!(snaps.len() >= 3);
        let safety = r.safety_snapshot_id.expect("safety id");
        let detail = snapshot_detail(st.to_string(), safety).expect("detail");
        assert_eq!(detail.trigger, "restore-point");
        assert!(detail.files.iter().any(|f| f.path == "new.txt"));
    }

    #[test]
    fn restore_never_touches_excluded_dirs() {
        let c = setup("excl");
        let st = c.store.to_str().unwrap();
        let src = c.src.to_str().unwrap();
        write_file(&c.src, "settings.yaml", "v1");
        write_file(&c.src, "sessions/live.json", "live");
        let s1 = create(st, src, "1");

        // 快照不含 sessions；往里塞新文件后恢复 —— sessions 必须原样保留
        write_file(&c.src, "sessions/new.json", "new");
        write_file(&c.src, "settings.yaml", "v2");
        snapshot_restore(RestoreOpts {
            store_dir: st.to_string(),
            snapshot_id: s1.id,
            target_dir: src.to_string(),
            safety_snapshot: Some(false),
        })
        .expect("restore");
        assert_eq!(read_file(&c.src, "sessions/live.json"), "live");
        assert!(c.src.join("sessions/new.json").exists());
        assert_eq!(read_file(&c.src, "settings.yaml"), "v1");
    }

    #[test]
    fn delete_and_gc() {
        let c = setup("gc");
        let st = c.store.to_str().unwrap();
        let src = c.src.to_str().unwrap();
        write_file(&c.src, "a.txt", "v1");
        let s1 = create(st, src, "1");
        // 使用不同长度，避免 Linux runner 的粗粒度 mtime 让哈希缓存误判为未变化；
        // 本用例只验证删除中间快照后孤儿对象会被 GC 回收。
        write_file(&c.src, "a.txt", "v2x");
        let s2 = create(st, src, "2");

        // head 不可删
        assert!(snapshot_delete(st.to_string(), s2.id.clone()).is_err());
        // 中间快照可删；GC 后 v1 对象被回收
        snapshot_delete(st.to_string(), s1.id.clone()).expect("delete");
        let g = snapshot_gc(st.to_string()).expect("gc");
        assert_eq!(g.removed_objects, 1.0);
        let store = Store::open(st);
        assert_eq!(store.iter_objects().len(), 1);
    }

    #[test]
    fn config_flow() {
        let c = setup("cfg");
        let st = c.store.to_str().unwrap();
        let def = snapshot_config_load(st.to_string()).expect("load");
        assert_eq!(def.exclusions.len(), 5);
        assert!(def.schedule_enabled);

        let mut cfg = def.clone();
        cfg.exclusions = vec!["skills".into(), "*.bak".into()];
        cfg.schedule_mode = "interval".to_string();
        cfg.interval_minutes = 30.0;
        cfg.schedule_enabled = false;
        let saved = snapshot_config_save(st.to_string(), cfg).expect("save");
        assert_eq!(saved.exclusions, vec!["skills".to_string(), "*.bak".to_string()]);
        assert!(!saved.schedule_enabled);
        assert_eq!(saved.interval_minutes, 30.0);

        // 非法输入被拒绝
        let mut bad = saved.clone();
        bad.daily_time = "99:00".to_string();
        assert!(snapshot_config_save(st.to_string(), bad).is_err());

        // 排除列表生效：自定义排除 *.bak 的文件不入库
        write_file(&c.src, "keep.txt", "k");
        write_file(&c.src, "junk.bak", "j");
        let s = create(st, c.src.to_str().unwrap(), "1");
        assert_eq!(s.files_total, 1.0);
    }
}

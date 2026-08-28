//! store.rs — 存储持久层：config / index / snapshots / branches 的读写与校验。

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::fsutil::atomic_write;
use crate::types::{DiskBranch, DiskConfig, DiskIndex, DiskSnapshot};

/// 默认排除列表：用户指定的四个高 churn/大体量目录 + node_modules
/// （profiles 的 node_modules 是 dsh-app-boot 维护的 junction 闭包，
/// 每次启动幂等重建；按文件复制会实体化 junction，必须排除）。
pub const DEFAULT_EXCLUSIONS: [&str; 5] =
    ["skills", "sessions", ".agent-presets", "memories", "node_modules"];

const CONFIG_VERSION: u32 = 1;

/// 快照存储库句柄（路径容器，全部操作按需 IO）。
pub struct Store {
    pub root: PathBuf,
}

impl Store {
    pub fn open(dir: &str) -> Store {
        Store {
            root: PathBuf::from(dir),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.json")
    }
    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }
    fn snapshots_dir(&self) -> PathBuf {
        self.root.join("snapshots")
    }
    fn branches_dir(&self) -> PathBuf {
        self.root.join("branches")
    }
    fn objects_dir(&self) -> PathBuf {
        self.root.join("objects")
    }

    /// 对象文件路径（内容寻址：<hash[..2]>/<hash>）。
    pub fn object_path(&self, hash: &str) -> PathBuf {
        let prefix = &hash[..2.min(hash.len())];
        self.objects_dir().join(prefix).join(hash)
    }

    /// 确保目录布局存在（幂等）。
    pub fn ensure_layout(&self) -> std::io::Result<()> {
        fs::create_dir_all(self.snapshots_dir())?;
        fs::create_dir_all(self.branches_dir())?;
        fs::create_dir_all(self.objects_dir())?;
        Ok(())
    }

    // -- config -----------------------------------------------------------

    /// 读配置；缺失/损坏时返回默认值（不落盘，由首次 save 定型）。
    pub fn load_config(&self) -> DiskConfig {
        let fallback = DiskConfig::default_config();
        let Ok(text) = fs::read_to_string(self.config_path()) else {
            return fallback;
        };
        match serde_json::from_str::<DiskConfig>(&text) {
            Ok(c) => normalize_config(c, &fallback),
            Err(_) => fallback,
        }
    }

    /// 校验并保存配置。
    pub fn save_config(&self, cfg: &DiskConfig) -> Result<(), String> {
        let norm = normalize_config(cfg.clone(), &DiskConfig::default_config());
        let bytes = serde_json::to_vec_pretty(&norm).map_err(|e| format!("序列化失败: {e}"))?;
        atomic_write(&self.config_path(), &bytes).map_err(|e| format!("写 config 失败: {e}"))
    }

    // -- index ------------------------------------------------------------

    pub fn load_index(&self) -> DiskIndex {
        let Ok(text) = fs::read_to_string(self.index_path()) else {
            return DiskIndex::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    pub fn save_index(&self, idx: &DiskIndex) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(idx).map_err(|e| format!("序列化失败: {e}"))?;
        atomic_write(&self.index_path(), &bytes).map_err(|e| format!("写 index 失败: {e}"))
    }

    // -- snapshots ----------------------------------------------------------

    pub fn load_snapshot(&self, id: &str) -> Result<DiskSnapshot, String> {
        let p = self.snapshots_dir().join(format!("{id}.json"));
        let text = fs::read_to_string(&p).map_err(|_| format!("快照不存在: {id}"))?;
        serde_json::from_str(&text).map_err(|e| format!("快照损坏 {id}: {e}"))
    }

    /// 全部快照（旧→新按创建时间排序；损坏文件跳过）。
    pub fn list_snapshots(&self) -> Vec<DiskSnapshot> {
        let mut out = Vec::new();
        let Ok(rd) = fs::read_dir(self.snapshots_dir()) else {
            return out;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&p) {
                if let Ok(s) = serde_json::from_str::<DiskSnapshot>(&text) {
                    out.push(s);
                }
            }
        }
        out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then(a.id.cmp(&b.id)));
        out
    }

    pub fn save_snapshot(&self, snap: &DiskSnapshot) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(snap).map_err(|e| format!("序列化失败: {e}"))?;
        let p = self.snapshots_dir().join(format!("{}.json", snap.id));
        atomic_write(&p, &bytes).map_err(|e| format!("写快照失败: {e}"))
    }

    pub fn delete_snapshot_file(&self, id: &str) -> Result<(), String> {
        let p = self.snapshots_dir().join(format!("{id}.json"));
        fs::remove_file(&p).map_err(|e| format!("删除快照失败: {e}"))
    }

    // -- branches -----------------------------------------------------------

    pub fn load_branches(&self) -> BTreeMap<String, DiskBranch> {
        let mut out = BTreeMap::new();
        let Ok(rd) = fs::read_dir(self.branches_dir()) else {
            return out;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&p) {
                if let Ok(b) = serde_json::from_str::<DiskBranch>(&text) {
                    out.insert(b.name.clone(), b);
                }
            }
        }
        out
    }

    pub fn save_branch(&self, b: &DiskBranch) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(b).map_err(|e| format!("序列化失败: {e}"))?;
        let p = self.branches_dir().join(format!("{}.json", b.name));
        atomic_write(&p, &bytes).map_err(|e| format!("写分支失败: {e}"))
    }

    pub fn delete_branch_file(&self, name: &str) -> Result<(), String> {
        let p = self.branches_dir().join(format!("{name}.json"));
        fs::remove_file(&p).map_err(|e| format!("删除分支失败: {e}"))
    }

    /// 遍历全部对象文件（GC 用；返回 (hash, path)）。
    pub fn iter_objects(&self) -> Vec<(String, PathBuf)> {
        let mut out = Vec::new();
        let Ok(prefixes) = fs::read_dir(self.objects_dir()) else {
            return out;
        };
        for pdir in prefixes.flatten() {
            let Ok(files) = fs::read_dir(pdir.path()) else {
                continue;
            };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if name.len() == 64 {
                    out.push((name, f.path()));
                }
            }
        }
        out
    }
}

impl DiskConfig {
    /// 默认配置：定时备份开启（每天 03:00）、当前分支 main、默认排除列表。
    pub fn default_config() -> DiskConfig {
        DiskConfig {
            version: CONFIG_VERSION,
            exclusions: DEFAULT_EXCLUSIONS.iter().map(|s| s.to_string()).collect(),
            schedule_enabled: true,
            schedule_mode: "daily".to_string(),
            interval_minutes: 1440,
            daily_time: "03:00".to_string(),
            current_branch: "main".to_string(),
        }
    }
}

/// 分支名合法性：字母数字开头，1-64 位 [A-Za-z0-9._-]（防路径穿越）。
pub fn valid_branch_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().expect("checked non-empty");
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// HH:MM 合法性。
pub fn valid_daily_time(s: &str) -> bool {
    match parse_daily_time(s) {
        Some((h, m)) => h < 24 && m < 60,
        None => false,
    }
}

/// 解析 HH:MM → (时, 分)；格式非法返回 None。
pub fn parse_daily_time(s: &str) -> Option<(u32, u32)> {
    let bytes = s.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let h = s[0..2].parse::<u32>().ok()?;
    let m = s[3..5].parse::<u32>().ok()?;
    Some((h, m))
}

/// 配置规范化：去空/去重排除项、修正非法计划字段、current_branch 合法化。
fn normalize_config(mut c: DiskConfig, fallback: &DiskConfig) -> DiskConfig {
    // 排除项：trim、去空、去重（保序）
    let mut seen = std::collections::BTreeSet::new();
    c.exclusions = c
        .exclusions
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect();
    // 注：用户显式删掉默认排除项是合法诉求，normalize 不补回默认列表。
    if c.schedule_mode != "interval" && c.schedule_mode != "daily" {
        c.schedule_mode = fallback.schedule_mode.clone();
    }
    if c.interval_minutes == 0 || c.interval_minutes > 525_600 {
        c.interval_minutes = fallback.interval_minutes;
    }
    if !valid_daily_time(&c.daily_time) {
        c.daily_time = fallback.daily_time.clone();
    }
    if !valid_branch_name(&c.current_branch) {
        c.current_branch = fallback.current_branch.clone();
    }
    c.version = CONFIG_VERSION;
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::testutil::*;

    #[test]
    fn config_roundtrip_and_normalize() {
        let dir = test_temp_dir("cfg");
        let store = Store::open(dir.to_str().expect("path"));
        store.ensure_layout().expect("layout");

        let def = store.load_config();
        assert_eq!(def.exclusions, DEFAULT_EXCLUSIONS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(def.schedule_enabled);
        assert_eq!(def.daily_time, "03:00");
        assert_eq!(def.current_branch, "main");

        let mut c = def.clone();
        c.exclusions = vec!["  skills ".into(), "skills".into(), "".into(), "*.bak".into()];
        c.schedule_mode = "weekly".into();
        c.daily_time = "25:99".into();
        c.interval_minutes = 0;
        c.current_branch = "../evil".into();
        store.save_config(&c).expect("save");

        let n = store.load_config();
        assert_eq!(n.exclusions, vec!["skills".to_string(), "*.bak".to_string()]);
        assert_eq!(n.schedule_mode, "daily");
        assert_eq!(n.daily_time, "03:00");
        assert_eq!(n.interval_minutes, 1440);
        assert_eq!(n.current_branch, "main");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn branch_name_validation() {
        assert!(valid_branch_name("main"));
        assert!(valid_branch_name("experiment-2"));
        assert!(valid_branch_name("v1.0_rc"));
        assert!(!valid_branch_name(""));
        assert!(!valid_branch_name("../evil"));
        assert!(!valid_branch_name("a/b"));
        assert!(!valid_branch_name("-lead"));
        assert!(!valid_branch_name(&"x".repeat(65)));
    }

    #[test]
    fn daily_time_validation() {
        assert!(valid_daily_time("03:00"));
        assert!(valid_daily_time("23:59"));
        assert!(!valid_daily_time("24:00"));
        assert!(!valid_daily_time("12:60"));
        assert!(!valid_daily_time("3:00"));
        assert!(!valid_daily_time("0300"));
    }
}

//! fsutil.rs — 文件系统原语：受控遍历 / 流式 SHA-256 / 原子写 / id 生成。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// 当前 Unix 毫秒时间戳。
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 快照 id：`snap-<ms>-<counter>`（ms 单调可排序，counter 防同毫秒碰撞）。
pub fn gen_snapshot_id(ms: u64) -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("snap-{ms}-{c:04x}")
}

/// 流式 SHA-256（64KB 分块，与 supervisor 模块同款策略）。
pub fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = read_full(&mut f, &mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_full(f: &mut fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;
    let mut filled = 0usize;
    while filled < buf.len() {
        match f.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

/// 原子写：先写同目录临时文件再 rename 覆盖（崩溃只会留下可清理的 .tmp 残件）。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "tmp{}-{}",
        std::process::id(),
        now_ms() & 0xffff
    ));
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// 原子复制：临时文件 + rename（对象库/恢复目标同样不可留半成品）。
pub fn atomic_copy(src: &Path, dst: &Path) -> std::io::Result<()> {
    let tmp = dst.with_extension(format!(
        "tmp{}-{}",
        std::process::id(),
        now_ms() & 0xffff
    ));
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, &tmp)?;
    match fs::rename(&tmp, dst) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// 遍历到的文件（rel 为 `/` 分隔相对路径）。
pub struct WalkedFile {
    pub rel: String,
    pub abs: PathBuf,
    /// 修改时间纳秒（哈希缓存键；同毫秒同大小的改写也必须重新哈希）。
    pub mtime_ns: i64,
    pub size: u64,
}

/// 遍历结果。
pub struct WalkResult {
    /// 相对路径升序（快照清单的稳定序）。
    pub files: Vec<WalkedFile>,
    /// 跳过的符号链接/junction 数（复制会实体化 junction，必须跳过）。
    pub skipped: u64,
}

/// 受控遍历：应用排除列表、跳过符号链接、按相对路径排序。
pub fn walk_files(root: &Path, exclusions: &[String]) -> std::io::Result<WalkResult> {
    let mut files = Vec::new();
    let mut skipped = 0u64;
    if !root.exists() {
        return Ok(WalkResult { files, skipped });
    }
    walk_rec(root, "", exclusions, &mut files, &mut skipped)?;
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(WalkResult { files, skipped })
}

fn walk_rec(
    dir: &Path,
    rel: &str,
    exclusions: &[String],
    out: &mut Vec<WalkedFile>,
    skipped: &mut u64,
) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_s = name.to_string_lossy().to_string();
        let child_rel = if rel.is_empty() {
            name_s.clone()
        } else {
            format!("{rel}/{name_s}")
        };
        if crate::exclude::is_excluded(&child_rel, exclusions) {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            *skipped += 1;
            continue;
        }
        let abs = entry.path();
        if ft.is_dir() {
            walk_rec(&abs, &child_rel, exclusions, out, skipped)?;
        } else if ft.is_file() {
            let md = entry.metadata()?;
            let mtime_ns = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as i64)
                .unwrap_or(0);
            out.push(WalkedFile {
                rel: child_rel,
                abs,
                mtime_ns,
                size: md.len(),
            });
        }
        // 其他类型（设备/套接字等）忽略
    }
    Ok(())
}

/// 收集目录内全部空目录并自底向上删除（恢复清理增量文件后使用；
/// remove_dir 对非空目录失败即自然保留，无需预先判空）。
pub fn remove_empty_dirs(root: &Path, rel_dirs: &[String]) {
    let mut dirs: Vec<&String> = rel_dirs.iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.split('/').count()));
    for rel in dirs {
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if abs == root {
            continue;
        }
        let _ = fs::remove_dir(&abs);
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// 唯一临时目录（测试用；调用方负责清理）。
    pub fn test_temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dsh-snap-test-{}-{}-{}",
            tag,
            std::process::id(),
            n
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// 写测试文件（自动建父目录）。
    pub fn write_file(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        fs::write(p, content).expect("write");
    }

    pub fn read_file(root: &Path, rel: &str) -> String {
        fs::read_to_string(root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))
            .expect("read")
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn walk_applies_exclusions_and_sorts() {
        let dir = test_temp_dir("walk");
        write_file(&dir, "settings.yaml", "a");
        write_file(&dir, "b.txt", "b");
        write_file(&dir, "a.txt", "a");
        write_file(&dir, "skills/x.md", "x");
        write_file(&dir, "profiles/web/cordis.patch.yml", "p");
        write_file(&dir, "profiles/web/node_modules/dep/index.js", "d");

        let r = walk_files(&dir, &["skills".to_string(), "node_modules".to_string()]).expect("walk");
        let rels: Vec<&str> = r.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["a.txt", "b.txt", "profiles/web/cordis.patch.yml", "settings.yaml"]);
        assert_eq!(r.skipped, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_is_unique_and_monotonic() {
        let a = gen_snapshot_id(1000);
        let b = gen_snapshot_id(1000);
        assert_ne!(a, b);
        assert!(a.starts_with("snap-1000-"));
    }
}

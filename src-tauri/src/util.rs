// 通用工具：ID、路径清洗、目录体积、进程存活检测。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn gen_id() -> String {
    let t = now_ms();
    let r: u32 = rand_u32();
    format!("{:x}{:06x}", t, r & 0xFFFFFF)
}

fn rand_u32() -> u32 {
    // 简单熵源：地址 + 时间戳抖动，实例 ID 场景足够
    let a = &now_ms as *const _ as u64;
    let b = now_ms() ^ std::time::Instant::now().elapsed().as_nanos() as u64;
    (a.wrapping_mul(0x9E3779B97F4A7C15) ^ b.wrapping_mul(0xBF58476D1CE4E5B9)) as u32
}

/// 清洗为安全的目录/文件名片段
pub fn sanitize_name(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        let bad = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || (ch as u32) < 0x20;
        if bad {
            out.push('-');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_matches('.').trim();
    let s: String = trimmed.chars().take(48).collect();
    if s.is_empty() { "instance".to_string() } else { s }
}

/// 递归计算目录字节数（跟随符号链接不做，忽略错误项）
pub fn dir_size(p: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_file() {
                total += meta.len();
            } else if meta.is_dir() {
                total += dir_size(&e.path());
            }
        }
    }
    total
}

pub fn remove_dir_all_force(p: &Path) -> Result<(), String> {
    if !p.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(p).map_err(|e| format!("删除目录失败 {p:?}: {e}"))
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 进程是否存活（tasklist 查询）
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match out {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                // 无匹配时 tasklist 输出 "INFO: ..." 而非 CSV 行
                s.contains(&format!("\"{pid}\"")) || s.contains(&format!(",{pid},"))
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

/// 结束主程序位于指定目录下的全部进程（覆盖脱离进程树的同 exe 辅助进程）
pub fn kill_by_exe_dir(app_dir: &Path) -> Result<u32, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let root = app_dir
            .display()
            .to_string()
            .trim_end_matches(['\\', '/'])
            .to_string();
        let pat = format!("{}*", root.replace("'", "''"));
        let script = format!(
            "$ps = Get-Process | Where-Object {{ $_.Path -and ($_.Path -like '{}') }}; $n = ($ps | Measure-Object).Count; if ($n -gt 0) {{ $ps | Stop-Process -Force }}; Write-Output $n",
            pat
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("powershell 启动失败: {e}"))?;
        let n = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u32>()
            .unwrap_or(0);
        Ok(n)
    }
    #[cfg(not(windows))]
    {
        let _ = app_dir;
        Ok(0)
    }
}

/// 结束进程树
pub fn kill_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let st = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        match st {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("taskkill 退出码 {:?}", s.code())),
            Err(e) => Err(format!("taskkill 启动失败: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err("仅支持 Windows".into())
    }
}

/// 在目录顶层寻找主程序 exe（排除卸载器/崩溃报告类）
pub fn find_main_exe(dir: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let rd = std::fs::read_dir(dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name()?.to_string_lossy().to_lowercase();
        if name.ends_with(".exe") && !name.contains("uninstall") && !name.contains("crash") {
            candidates.push(p);
        }
    }
    if candidates.is_empty() {
        return None;
    }
    let score = |p: &PathBuf| -> u64 {
        let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        let mut s = 0u64;
        if n.contains("shell") {
            s += 100;
        }
        if n.contains("eac") {
            s += 80;
        }
        if n.contains("desktop") {
            s += 40;
        }
        if n.contains("lite") {
            s += 20;
        }
        s
    };
    candidates.sort_by_key(|p| std::cmp::Reverse(score(p)));
    candidates.first().cloned()
}

/// 解压 zip 到目标目录。规范化反斜杠/正斜杠混合的条目名（上游 zip 存在
/// `dir\\sub\\` 形式条目），显式拒绝绝对路径与 `..` 组件（防 zip-slip）。
pub fn unzip_to(
    zip_path: &Path,
    dest: &Path,
    mut on_entry: impl FnMut(u64, u64),
) -> Result<(u64, u64), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开压缩包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("读取压缩包失败: {e}"))?;
    let total = archive.len() as u64;
    let mut done = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取条目失败: {e}"))?;
        let raw = entry.name().to_string();
        let norm = raw.replace('\\', "/");
        // 条目名守卫：拒绝绝对路径、盘符、.. 组件
        if norm.starts_with('/') || norm.contains(':') || norm.split('/').any(|p| p == "..") {
            return Err(format!("压缩包含非法路径: {raw:?}"));
        }
        let parts: Vec<&str> = norm
            .split('/')
            .filter(|p| !p.is_empty() && *p != ".")
            .collect();
        let is_dir = norm.ends_with('/') || parts.is_empty();
        let rel: PathBuf = parts.iter().collect();
        let out_path = dest.join(&rel);
        if entry.is_dir() || is_dir {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {e}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            let mut wf =
                std::fs::File::create(&out_path).map_err(|e| format!("写入文件失败 {rel:?}: {e}"))?;
            std::io::copy(&mut entry, &mut wf).map_err(|e| format!("解压写入失败 {rel:?}: {e}"))?;
        }
        done += 1;
        on_entry(done, total);
    }
    Ok((done, total))
}

/// v5.x 便携包解出的根即实例 app 目录；老包可能带单层根目录，展开一层
pub fn collapse_single_root_dir(dir: &Path) -> PathBuf {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return dir.to_path_buf(),
    };
    let entries: Vec<_> = rd.flatten().collect();
    let dirs: Vec<_> = entries.iter().filter(|e| e.path().is_dir()).collect();
    let files: Vec<_> = entries.iter().filter(|e| e.path().is_file()).collect();
    if dirs.len() == 1 && files.is_empty() {
        let inner = dirs[0].path();
        if find_main_exe(&inner).is_some() || inner.join("dsh-desktop").is_dir() {
            // 把 inner 的内容上移一层
            if copy_dir_contents(&inner, dir).is_ok() {
                let _ = std::fs::remove_dir_all(&inner);
                return dir.to_path_buf();
            }
        }
    }
    dir.to_path_buf()
}

pub fn copy_dir_contents(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let rd = std::fs::read_dir(from).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let src = e.path();
        let dst = to.join(e.file_name());
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("复制 {src:?} 失败: {e}"))?;
        }
    }
    Ok(())
}

pub fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let rd = std::fs::read_dir(from).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let src = e.path();
        let dst = to.join(e.file_name());
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("复制 {src:?} 失败: {e}"))?;
        }
    }
    Ok(())
}

pub fn format_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} {}", UNITS[0])
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 内存构造一个含反斜杠分隔条目的 zip（模拟上游产物）
    fn make_zip(path: &Path) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opt =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        // 反斜杠目录条目（zip crate 会把 `\` 视为文件名字符）
        w.start_file("dsh-desktop\\native\\", opt).unwrap();
        w.write_all(b"").unwrap();
        w.start_file("dsh-desktop\\dir\\nested\\a.txt", opt).unwrap();
        w.write_all(b"hello").unwrap();
        w.start_file("dsh-eac-shell.exe", opt).unwrap();
        w.write_all(b"MZ").unwrap();
        w.start_file(".dsh-portable", opt).unwrap();
        w.write_all(b"").unwrap();
        w.finish().unwrap();
    }

    #[test]
    fn unzip_handles_backslash_entries() {
        let tmp = std::env::temp_dir().join(format!("eac-unzip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let zip_path = tmp.join("t.zip");
        make_zip(&zip_path);
        let dest = tmp.join("app");
        std::fs::create_dir_all(&dest).unwrap();
        let (done, _total) = unzip_to(&zip_path, &dest, |_, _| {}).unwrap();
        assert_eq!(done, 4);
        assert!(dest.join("dsh-desktop").join("native").is_dir());
        assert!(dest.join("dsh-desktop").join("dir").join("nested").join("a.txt").is_file());
        assert_eq!(
            std::fs::read_to_string(dest.join("dsh-desktop").join("dir").join("nested").join("a.txt")).unwrap(),
            "hello"
        );
        assert!(dest.join("dsh-eac-shell.exe").is_file());
        assert!(find_main_exe(&dest).is_some());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unzip_rejects_zip_slip() {
        let tmp = std::env::temp_dir().join(format!("eac-zip-slip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let zip_path = tmp.join("evil.zip");
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opt =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        w.start_file("../evil.txt", opt).unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();
        let dest = tmp.join("app");
        std::fs::create_dir_all(&dest).unwrap();
        assert!(unzip_to(&zip_path, &dest, |_, _| {}).is_err());
        assert!(!tmp.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

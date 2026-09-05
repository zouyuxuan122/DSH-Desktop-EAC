// 网络层：HTTP 客户端（native-tls，兼容本机加速器）、GitHub API、版本目录解析。

use crate::model::{EditionAsset, EditionInfo};
use serde_json::Value;
use std::time::Duration;

pub const REPO: &str = "zouyuxuan122/DSH-Desktop-EAC";
pub const MARKET_URLS: &[&str] = &[
    "https://dsh-plug.in/api/plugins.json",
    "https://raw.githubusercontent.com/dsh-plugins/dsh-plugin-market/HEAD/plugins.json",
];

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("dsh-eac-launcher/1.0 (+https://github.com/zouyuxuan122/DSH-Desktop-EAC)")
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

/// 无整体超时的客户端（下载大文件用，仅限制连接超时）
pub fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("dsh-eac-launcher/1.0")
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

/// 镜像改写：mirror_prefix 非空时拼在原始 URL 前
pub fn apply_mirror(url: &str, mirror_prefix: &str) -> String {
    let p = mirror_prefix.trim();
    if p.is_empty() {
        return url.to_string();
    }
    if url.starts_with(p) {
        return url.to_string();
    }
    format!("{}{}", p.trim_end_matches('/'), url)
}

pub async fn fetch_json(url: &str, max_bytes: usize) -> Result<Value, String> {
    let client = http_client()?;
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("请求失败 {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} 来自 {url}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("响应超过大小上限 ({})", url));
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("JSON 解析失败来自 {url}: {e}"))
}

/// 依次尝试多个源
pub async fn fetch_json_any(urls: &[&str], max_bytes: usize) -> Result<(String, Value), String> {
    let mut last = String::new();
    for url in urls {
        match fetch_json(url, max_bytes).await {
            Ok(v) => return Ok((url.to_string(), v)),
            Err(e) => {
                eprintln!("[net] 源不可用 {url}: {e}");
                last = e;
            }
        }
    }
    Err(format!("所有源均不可用，最后错误：{last}"))
}

/// 带镜像回退的 JSON 抓取：直连失败后尝试镜像改写
pub async fn fetch_json_with_mirror(url: &str, mirror: &str, max: usize) -> Result<Value, String> {
    match fetch_json(url, max).await {
        Ok(v) => Ok(v),
        Err(direct_err) if !mirror.trim().is_empty() => {
            let m = apply_mirror(url, mirror);
            fetch_json(&m, max)
                .await
                .map_err(|mirror_err| format!("直连失败（{direct_err}），镜像亦失败（{mirror_err}）"))
        }
        Err(e) => Err(e),
    }
}

fn is_windows_lite_asset(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with("-setup.exe") && (n.contains("lite") || n.contains("v4lite"))
}

/// 便携 zip 产物识别：排除 AIO 套装与 linux/macos 产物。
/// AIO（DSHEAC-AIO-*）是另一种发行线，不能被当成完整版实例化产物。
fn is_full_portable_zip(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".zip")
        && n.contains("portable")
        && !n.contains("aio")
        && !n.contains("macos")
        && !n.contains("linux")
}

/// 从 release 资产里挑 SHA256SUMS 文件：优先 windows-x64 专版，
/// 其次任意 SHA256SUMS*.txt（上游各版本命名不统一）。
fn pick_sha_url(assets: &[Value]) -> Option<String> {
    let mut fallback: Option<String> = None;
    for a in assets {
        let an = a["name"].as_str().unwrap_or("");
        let al = an.to_ascii_lowercase();
        let url = a["browser_download_url"].as_str().map(|s| s.to_string());
        let Some(url) = url else { continue };
        if al == "sha256sums.txt" {
            fallback = Some(url.clone());
        }
        if al.starts_with("sha256sums") && al.contains("windows") {
            return Some(url);
        }
    }
    fallback
}

/// 解析某个版本的「Windows 完整版便携包」与「Lite 安装包」最新产物。
/// 完整版优先 portable.zip（实例隔离友好），其次 Portable exe / setup.exe。
pub async fn resolve_editions(mirror: &str) -> Result<Vec<EditionInfo>, String> {
    resolve_editions_inner(mirror, false).await
}

/// 解析全部历史版本（新→旧），供版本选择 / 升级 / 降级。
pub async fn resolve_editions_history(mirror: &str) -> Result<Vec<EditionInfo>, String> {
    resolve_editions_inner(mirror, true).await
}

#[allow(clippy::too_many_arguments)]
fn edition_of(
    edition: &str,
    label: &str,
    tag: &str,
    name: &str,
    published: &str,
    body_excerpt: &str,
    asset: EditionAsset,
    sha_url: Option<String>,
) -> EditionInfo {
    EditionInfo {
        edition: edition.into(),
        label: label.into(),
        tag: tag.into(),
        release_name: name.into(),
        published_at: published.into(),
        body_excerpt: body_excerpt.into(),
        asset,
        sha_url,
    }
}

async fn resolve_editions_inner(mirror: &str, history: bool) -> Result<Vec<EditionInfo>, String> {
    let api = format!("https://api.github.com/repos/{REPO}/releases?per_page=40");
    let releases = fetch_json_with_mirror(&api, mirror, 4 * 1024 * 1024).await?;
    let arr = releases
        .as_array()
        .ok_or_else(|| "GitHub Releases 响应格式异常".to_string())?;

    let mut full: Vec<EditionInfo> = Vec::new();
    let mut lite: Vec<EditionInfo> = Vec::new();

    for rel in arr {
        let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
        let name = rel["name"].as_str().unwrap_or("").to_string();
        let published = rel["published_at"].as_str().unwrap_or("").to_string();
        let body = rel["body"].as_str().unwrap_or("").to_string();
        let body_excerpt: String = body
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim_start_matches('#')
            .trim()
            .chars()
            .take(160)
            .collect();
        let tag_l = tag.to_ascii_lowercase();
        let name_l = name.to_ascii_lowercase();
        let is_lite_rel = tag_l.contains("lite") || name_l.contains("lite");
        let is_ide_rel = tag_l.contains("ide") || name_l.contains("ide");
        let is_aio_rel = tag_l.contains("aio") || name_l.contains("aio");

        let assets = rel["assets"].as_array().cloned().unwrap_or_default();
        let sha_url = pick_sha_url(&assets);

        // 完整版产物：只接受 zip 便携包（可静默解压进实例目录）
        if !is_lite_rel && !is_ide_rel && !is_aio_rel {
            for a in &assets {
                let an = a["name"].as_str().unwrap_or("");
                let url = match a["browser_download_url"].as_str() {
                    Some(u) => u.to_string(),
                    None => continue,
                };
                let size = a["size"].as_u64().unwrap_or(0);
                if is_full_portable_zip(an) {
                    full.push(edition_of(
                        "full",
                        "完整版 · 全功能桌面客户端",
                        &tag,
                        &name,
                        &published,
                        &body_excerpt,
                        EditionAsset { name: an.to_string(), size, url },
                        sha_url.clone(),
                    ));
                    break;
                }
            }
        }
        // Lite 版产物：lite 线 Release 中的 *Lite*-setup.exe
        if is_lite_rel {
            for a in &assets {
                let an = a["name"].as_str().unwrap_or("");
                if let (true, Some(url)) = (is_windows_lite_asset(an), a["browser_download_url"].as_str()) {
                    lite.push(edition_of(
                        "lite",
                        "Lite · Tauri 轻量壳",
                        &tag,
                        &name,
                        &published,
                        &body_excerpt,
                        EditionAsset {
                            name: an.to_string(),
                            size: a["size"].as_u64().unwrap_or(0),
                            url: url.to_string(),
                        },
                        sha_url.clone(),
                    ));
                    break;
                }
            }
        }
        if !history && !full.is_empty() && !lite.is_empty() {
            break;
        }
    }

    if history {
        full.extend(lite);
        if full.is_empty() {
            return Err("未在上游 Release 中找到可用的 Windows 产物".into());
        }
        return Ok(full);
    }
    let mut out = Vec::new();
    if let Some(f) = full.first() {
        out.push(f.clone());
    }
    if let Some(l) = lite.first() {
        out.push(l.clone());
    }
    if out.is_empty() {
        return Err("未在上游 Release 中找到可用的 Windows 产物".into());
    }
    Ok(out)
}

/// tag → (major, minor, patch)，无法解析的段记 0
pub fn version_key(tag: &str) -> (u64, u64, u64) {
    let t = tag.trim().trim_start_matches(['v', 'V']);
    let core = t.split(['-', '+', ' ']).next().unwrap_or("");
    let mut it = core.split('.');
    let m = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let n = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let p = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (m, n, p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_key_orders_semver_tags() {
        assert_eq!(version_key("v5.3.6"), (5, 3, 6));
        assert_eq!(version_key("5.10.0"), (5, 10, 0));
        assert!(version_key("v5.3.6") > version_key("v5.1.0"));
        assert!(version_key("v5.10.0") > version_key("v5.9.9"));
        assert!(version_key("v4.6-lite") < version_key("v5.0.0"));
        assert_eq!(version_key("v5.3.6-aio"), (5, 3, 6), "预发布尾巴不影响核心版本");
        assert_eq!(version_key("garbage"), (0, 0, 0));
    }

    #[test]
    fn full_portable_zip_excludes_aio() {
        assert!(is_full_portable_zip("Deepseek-Harness-EAC-5.3.6-portable.zip"));
        assert!(is_full_portable_zip("Deepseek-Harness-EAC-5.1.0-portable.zip"));
        assert!(!is_full_portable_zip("DSHEAC-AIO-v1-Portable-x64.zip"));
        assert!(!is_full_portable_zip("Deepseek-Harness-EAC-5.3.6-portable.zip.exe"));
        assert!(!is_full_portable_zip("something-linux-portable.zip"));
    }
}

/// 抓取并解析 SHA256SUMS.txt，返回 文件名 -> sha256
pub async fn fetch_sha256sums(url: &str, mirror: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let real = apply_mirror(url, mirror);
    let client = http_client()?;
    let resp = client
        .get(&real)
        .send()
        .await
        .map_err(|e| format!("获取校验文件失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("获取校验文件失败: HTTP {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.splitn(2, char::is_whitespace);
        if let (Some(hash), Some(name)) = (it.next(), it.next()) {
            let name = name
                .trim()
                .trim_start_matches('*')
                .trim()
                .rsplit('/')
                .next()
                .unwrap_or("");
            if hash.len() == 64 {
                map.insert(name.to_string(), hash.to_ascii_lowercase());
            }
        }
    }
    Ok(map)
}

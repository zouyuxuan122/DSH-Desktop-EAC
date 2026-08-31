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

/// 解析某个版本的「Windows 完整版便携包」与「Lite 安装包」最新产物。
/// 完整版优先 portable.zip（实例隔离友好），其次 Portable exe / setup.exe。
pub async fn resolve_editions(mirror: &str) -> Result<Vec<EditionInfo>, String> {
    let api = format!("https://api.github.com/repos/{REPO}/releases?per_page=40");
    let releases = fetch_json_with_mirror(&api, mirror, 4 * 1024 * 1024).await?;
    let arr = releases
        .as_array()
        .ok_or_else(|| "GitHub Releases 响应格式异常".to_string())?;

    let mut full: Option<EditionInfo> = None;
    let mut lite: Option<EditionInfo> = None;

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

        let assets = rel["assets"].as_array().cloned().unwrap_or_default();
        let mut sha_url: Option<String> = None;

        for a in &assets {
            let an = a["name"].as_str().unwrap_or("");
            if an.eq_ignore_ascii_case("SHA256SUMS.txt") {
                sha_url = a["browser_download_url"].as_str().map(|s| s.to_string());
            }
        }
        // 完整版产物选择：只接受 zip 便携包（可静默解压进实例目录）。
        // Portable 自解压 exe 无法无头落地，忽略。
        if full.is_none() && !is_lite_rel && !is_ide_rel {
            let candidates: Vec<EditionAsset> = assets
                .iter()
                .filter_map(|a| {
                    let an = a["name"].as_str()?;
                    let url = a["browser_download_url"].as_str()?.to_string();
                    let size = a["size"].as_u64()?;
                    let n = an.to_ascii_lowercase();
                    if n.ends_with(".zip") && n.contains("portable") && !n.contains("macos") && !n.contains("linux") {
                        Some(EditionAsset { name: an.to_string(), size, url })
                    } else {
                        None
                    }
                })
                .collect();
            if let Some(asset) = candidates.first() {
                full = Some(EditionInfo {
                    edition: "full".into(),
                    label: "完整版 · 全功能桌面客户端".into(),
                    tag: tag.clone(),
                    release_name: name.clone(),
                    published_at: published.clone(),
                    body_excerpt: body_excerpt.clone(),
                    asset: asset.clone(),
                    sha_url: sha_url.clone(),
                });
            }
        }
        // Lite 版产物：lite 线 Release 中的 *Lite*-setup.exe
        if lite.is_none() && is_lite_rel {
            for a in &assets {
                let an = a["name"].as_str().unwrap_or("");
                if let (true, Some(url)) = (is_windows_lite_asset(an), a["browser_download_url"].as_str()) {
                    lite = Some(EditionInfo {
                        edition: "lite".into(),
                        label: "Lite · Tauri 轻量壳".into(),
                        tag: tag.clone(),
                        release_name: name.clone(),
                        published_at: published.clone(),
                        body_excerpt: body_excerpt.clone(),
                        asset: EditionAsset {
                            name: an.to_string(),
                            size: a["size"].as_u64().unwrap_or(0),
                            url: url.to_string(),
                        },
                        sha_url: sha_url.clone(),
                    });
                    break;
                }
            }
        }
        if full.is_some() && lite.is_some() {
            break;
        }
    }

    let mut out = Vec::new();
    if let Some(f) = full {
        out.push(f);
    }
    if let Some(l) = lite {
        out.push(l);
    }
    if out.is_empty() {
        return Err("未在上游 Release 中找到可用的 Windows 产物".into());
    }
    Ok(out)
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

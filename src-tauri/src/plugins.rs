// 插件管理：dsh profile 协议（package.json + pnpm-workspace.yaml + cordis.patch.yml）、
// 包管理器探测、安装/卸载/停用、市场目录抓取。
// 协议对齐上游 dsh CLI `plugin add`（pnpm 转发器 + dsh.profile.bundles 对账）。

use crate::instance;
use crate::model::{InstalledPlugin, MarketPlugin};
use crate::net;
use crate::store::App;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn profile_dir(inst: &crate::model::InstanceMeta) -> PathBuf {
    inst.dsh_home.join("profiles").join("web-desktop")
}

/// EAC web-desktop profile 的基础 bundles：dsh-base / dsh-web-app 是 webServer
/// 等核心服务的提供者，manifest 缺失即 dsh web 启动崩溃（退出码 1）。
/// EAC v4Lite 的退出流程会把 bundles 清空且下次启动不会重建，必须由启动器兜底。
pub const BASE_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/// 首次初始化 profile（与 EAC/dsh 的模板一致）
pub fn ensure_profile(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建 profile 目录失败: {e}"))?;
    let pkg = dir.join("package.json");
    if !pkg.exists() {
        let manifest = json!({
            "name": "dsh-profile-web-desktop",
            "version": "0.0.0",
            "private": true,
            "dsh": { "profile": { "bundles": BASE_BUNDLES } }
        });
        std::fs::write(&pkg, serde_json::to_string_pretty(&manifest).unwrap())
            .map_err(|e| format!("写入 profile 清单失败: {e}"))?;
    }
    let ws = dir.join("pnpm-workspace.yaml");
    if !ws.exists() {
        std::fs::write(&ws, "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n")
            .map_err(|e| format!("写入 workspace 失败: {e}"))?;
    }
    let patch = dir.join("cordis.patch.yml");
    if !patch.exists() {
        std::fs::write(&patch, "[]\n").map_err(|e| format!("写入 patch 失败: {e}"))?;
    }
    Ok(())
}

pub struct Pm {
    pub program: String, // "bundled-npm" | "pnpm" | "npm" | "none"
    pub node: Option<PathBuf>,
    pub npm_cli: Option<PathBuf>,
    pub extra_path: Option<PathBuf>,
}

pub fn detect_pm(inst: &crate::model::InstanceMeta) -> Pm {
    // 1) 实例自带的 node + npm（便携包内置运行时）
    let vendor_node = inst
        .app_dir
        .join("dsh-desktop")
        .join("vendor")
        .join("node")
        .join("node.exe");
    let vendor_npm_cli = inst
        .app_dir
        .join("dsh-desktop")
        .join("vendor")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    if vendor_node.exists() && vendor_npm_cli.exists() {
        return Pm {
            program: "bundled-npm".into(),
            node: Some(vendor_node.clone()),
            npm_cli: Some(vendor_npm_cli),
            extra_path: vendor_node.parent().map(|p| p.to_path_buf()),
        };
    }
    // 2) PATH 上的 pnpm（dsh CLI 官方路径）
    if which("pnpm.cmd") || which("pnpm") {
        return Pm { program: "pnpm".into(), node: None, npm_cli: None, extra_path: None };
    }
    // 3) PATH 上的 npm
    if which("npm.cmd") || which("npm") {
        return Pm { program: "npm".into(), node: None, npm_cli: None, extra_path: None };
    }
    Pm { program: "none".into(), node: None, npm_cli: None, extra_path: None }
}

fn which(name: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("where")
            .arg(name)
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("which")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// 从 npm spec 提取包名（去掉 @version 尾巴；兼容 @scope/name@1.2.3）
pub fn pkg_name_of_spec(spec: &str) -> String {
    let s = spec.trim();
    if let Some(rest) = s.strip_prefix('@') {
        if let Some(slash) = rest.find('/') {
            let after = &rest[slash + 1..];
            return match after.find('@') {
                Some(at) => format!("@{}", &rest[..slash + 1 + at]),
                None => s.to_string(),
            };
        }
    }
    match s.rfind('@') {
        Some(at) if at > 0 => s[..at].to_string(),
        _ => s.to_string(),
    }
}

fn run_pm(pm: &Pm, profile: &Path, verb: &str, spec: &str, registry: &str) -> Result<(), String> {
    let mut cmd = match pm.program.as_str() {
        "bundled-npm" => {
            let node = pm.node.as_ref().unwrap();
            let cli = pm.npm_cli.as_ref().unwrap();
            let mut c = std::process::Command::new(node);
            c.arg(cli).arg(verb);
            // spec 为空 = `npm install`（按清单重装），不传空参数
            if !spec.trim().is_empty() {
                c.arg(spec);
            }
            c
        }
        "pnpm" => {
            let mut c = std::process::Command::new("pnpm.cmd");
            c.arg(verb);
            if !spec.trim().is_empty() {
                c.arg(spec);
            }
            c
        }
        "npm" => {
            let mut c = std::process::Command::new("npm.cmd");
            c.arg(verb);
            if !spec.trim().is_empty() {
                c.arg(spec);
            }
            c
        }
        _ => return Err("本机未找到可用的包管理器（pnpm / npm），且实例未内置 Node 运行时".into()),
    };
    cmd.current_dir(profile);
    // registry 经环境变量传递：pnpm remove 不接受 --registry CLI 选项，
    // 而 npm / pnpm / 内置 npm 均识别 npm_config_registry。
    cmd.env("npm_config_registry", registry);
    if let Some(p) = &pm.extra_path {
        // 让安装脚本里的 node 命中内置运行时
        let cur = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{};{}", p.display(), cur));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("包管理器启动失败: {e}"))?;
    if !out.status.success() {
        let mut tail = String::from_utf8_lossy(&out.stderr).to_string();
        if tail.trim().is_empty() {
            tail = String::from_utf8_lossy(&out.stdout).to_string();
        }
        let tail: Vec<&str> = tail
            .lines()
            .filter(|l| !l.trim().is_empty())
            .rev()
            .take(10)
            .collect();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("包管理器执行失败（{}）:\n{}", pm.program, tail));
    }
    Ok(())
}

/// 增量对账：把刚安装的包加入 dsh.profile.bundles（声明了 dsh.bundle 才加入）。
/// 绝不重算整个数组——数组里还有 EAC 写入的基础 bundles（dsh-base / dsh-web-app，
/// 提供 webServer 等服务）与内置伴生 bundles，重算会清掉它们导致 dsh web 启动失败。
fn bundle_add(profile: &Path, pkg: &str) -> Result<(), String> {
    let is_bundle = read_dep_manifest(profile, pkg)
        .map(|m| m.pointer("/dsh/bundle/patch").is_some())
        .unwrap_or(false);
    if !is_bundle {
        return Ok(());
    }
    let pkg_path = profile.join("package.json");
    let text =
        std::fs::read_to_string(&pkg_path).map_err(|e| format!("读取 profile 清单失败: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("profile 清单损坏: {e}"))?;
    let bundles = manifest["dsh"]["profile"]["bundles"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let already = bundles
        .iter()
        .any(|v| v.as_str() == Some(pkg));
    if already {
        return Ok(());
    }
    let mut next = bundles;
    next.push(json!(pkg));
    manifest["dsh"]["profile"]["bundles"] = Value::Array(next);
    std::fs::write(&pkg_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("写回 profile 清单失败: {e}"))?;
    Ok(())
}

/// 增量对账：仅把被卸载的包从 dsh.profile.bundles 移除，其余成员原样保留。
fn bundle_remove(profile: &Path, pkg: &str) -> Result<(), String> {
    let pkg_path = profile.join("package.json");
    let Ok(text) = std::fs::read_to_string(&pkg_path) else {
        return Ok(());
    };
    let mut manifest: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let Some(bundles) = manifest["dsh"]["profile"]["bundles"].as_array() else {
        return Ok(());
    };
    let next: Vec<Value> = bundles
        .iter()
        .filter(|v| v.as_str() != Some(pkg))
        .cloned()
        .collect();
    if next.len() == bundles.len() {
        return Ok(());
    }
    manifest["dsh"]["profile"]["bundles"] = Value::Array(next);
    std::fs::write(&pkg_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("写回 profile 清单失败: {e}"))?;
    Ok(())
}

/// 幽灵包保护：EAC 会把内置伴生插件直接拷进 profile 的 node_modules（不在
/// dependencies 清单里）。pnpm/npm 装卸时会按清单重算目录、清掉这些幽灵包，
/// 导致 dsh web 启动失败。故装卸前把「清单之外」的顶层包移入备份目录，
/// 装卸后原样恢复（同名跳过，保留包管理器刚装的版本）。
fn stash_ghost_packages(profile: &Path, backup: &Path) -> Result<usize, String> {
    let nm = profile.join("node_modules");
    if !nm.is_dir() {
        return Ok(0);
    }
    let pkg_path = profile.join("package.json");
    let deps: Vec<String> = if let Ok(text) = std::fs::read_to_string(&pkg_path) {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|m| {
                m["dependencies"].as_object().map(|d| {
                    d.keys().cloned().collect::<Vec<String>>()
                })
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    std::fs::create_dir_all(backup).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let mut moved = 0usize;
    let rd = std::fs::read_dir(&nm).map_err(|e| format!("读取 node_modules 失败: {e}"))?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // .pnpm / .bin / .modules.yaml 等包管理器内部项
        }
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        if name.starts_with('@') {
            // scope 目录：逐个子包判断
            let Ok(sub) = std::fs::read_dir(&p) else { continue };
            for se in sub.flatten() {
                let full = format!("{name}/{}", se.file_name().to_string_lossy());
                if deps.iter().any(|d| d == &full) {
                    continue;
                }
                if !se.path().is_dir() {
                    continue;
                }
                let dest = backup.join(&name).join(se.file_name());
                std::fs::create_dir_all(backup.join(&name))
                    .map_err(|err| format!("创建 scope 备份失败: {err}"))?;
                std::fs::rename(se.path(), &dest).map_err(|err| {
                    format!("备份幽灵包 {full} 失败: {err}")
                })?;
                moved += 1;
            }
            continue;
        }
        if deps.iter().any(|d| d == &name) {
            continue;
        }
        std::fs::rename(&p, backup.join(&name))
            .map_err(|err| format!("备份幽灵包 {name} 失败: {err}"))?;
        moved += 1;
    }
    Ok(moved)
}

/// 恢复幽灵包：同名已存在（包管理器刚装的传递依赖）则跳过，保留新版本。
fn restore_ghost_packages(backup: &Path, profile: &Path) {
    let nm = profile.join("node_modules");
    if !backup.is_dir() {
        return;
    }
    let Ok(rd) = std::fs::read_dir(backup) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('@') {
            let Ok(sub) = std::fs::read_dir(e.path()) else { continue };
            for se in sub.flatten() {
                let dest = nm.join(&name).join(se.file_name());
                let _ = std::fs::create_dir_all(nm.join(&name));
                if !dest.exists() {
                    let _ = std::fs::rename(se.path(), &dest);
                }
            }
            continue;
        }
        let dest = nm.join(&name);
        if !dest.exists() {
            let _ = std::fs::rename(e.path(), &dest);
        }
    }
    let _ = std::fs::remove_dir_all(backup);
}

fn read_dep_manifest(profile: &Path, name: &str) -> Option<Value> {
    let p = profile.join("node_modules").join(name).join("package.json");
    let text = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn cordis_id_of(pkg: &str) -> String {
    pkg.rsplit('/').next().unwrap_or(pkg).to_string()
}

// ---------- cordis.patch.yml 条目操作（与 EAC plugin-manager-patch.js 的方言兼容） ----------

/// 匹配 `- id: <id>` 行（值必须整体等于 id），返回缩进
fn id_entry_indent(line: &str, id: &str) -> Option<usize> {
    let t = line.trim_start();
    let ind = line.len() - t.len();
    let rest = t.strip_prefix("- id:")?;
    let val = rest.trim_start();
    let end = val.find(char::is_whitespace).unwrap_or(val.len());
    if &val[..end] == id {
        Some(ind)
    } else {
        None
    }
}

/// 条目块 = `- id:` 行 + 其后所有缩进更深的属性行（空行跟随）
fn find_entry_block(lines: &[String], id: &str) -> Option<(usize, usize)> {
    for (i, line) in lines.iter().enumerate() {
        if let Some(entry_indent) = id_entry_indent(line, id) {
            let mut end = i + 1;
            while end < lines.len() {
                let l = &lines[end];
                if l.trim().is_empty() {
                    end += 1;
                    continue;
                }
                if indent_of(l) > entry_indent {
                    end += 1;
                } else {
                    break;
                }
            }
            return Some((i, end));
        }
    }
    None
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn is_disabled_prop(line: &str) -> bool {
    line.trim().starts_with("disabled:")
}

#[allow(dead_code)]
pub fn patch_has_entry(text: &str, id: &str) -> bool {
    let lines: Vec<String> = text.lines().map(String::from).collect();
    find_entry_block(&lines, id).is_some()
}

pub fn patch_is_disabled(text: &str, id: &str) -> bool {
    let lines: Vec<String> = text.lines().map(String::from).collect();
    match find_entry_block(&lines, id) {
        Some((s, e)) => (s..e)
            .any(|i| is_disabled_prop(&lines[i]) && lines[i].contains("true")),
        None => false,
    }
}

pub fn patch_set_disabled(text: &str, id: &str, pkg: &str, disabled: bool) -> String {
    // 空文件或空列表占位符（`[]`）不能与块列表共存（会产生非法 YAML）：
    // 首次写入条目时整体替换为块列表。
    let base: Vec<String> = if text.trim().is_empty() || text.trim() == "[]" {
        Vec::new()
    } else {
        text.lines().map(String::from).collect()
    };
    let mut lines = base;
    match find_entry_block(&lines, id) {
        Some((s, e)) => {
            if disabled {
                let has = (s..e).any(|i| is_disabled_prop(&lines[i]));
                if !has {
                    let ind = indent_of(&lines[s]);
                    lines.insert(s + 1, format!("{}disabled: true", " ".repeat(ind + 2)));
                }
            } else {
                for i in (s..e).rev() {
                    if is_disabled_prop(&lines[i]) {
                        lines.remove(i);
                    }
                }
            }
        }
        None => {
            if disabled {
                if lines.last().map(|l| !l.trim().is_empty()).unwrap_or(false) {
                    lines.push(String::new());
                }
                lines.push(format!("- id: {}", id));
                lines.push(format!("  name: {}", pkg));
                lines.push("  disabled: true".into());
            }
        }
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

pub fn patch_remove_entry(text: &str, id: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    if let Some((s, e)) = find_entry_block(&lines, id) {
        lines.drain(s..e);
    }
    // 条目清空后还原为空列表，保持 YAML 合法
    if !lines.iter().any(|l| l.trim_start().starts_with("- id:")) {
        return "[]\n".into();
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

// ---------- 面向前端的操作 ----------

pub fn list_installed(state: &App, inst_id: &str) -> Result<Vec<InstalledPlugin>, String> {
    let inst = instance::find_instance(state, inst_id)?;
    let profile = profile_dir(&inst);
    let pkg_path = profile.join("package.json");
    if !pkg_path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&pkg_path).map_err(|e| format!("读取清单失败: {e}"))?;
    let manifest: Value = serde_json::from_str(&text).map_err(|e| format!("清单损坏: {e}"))?;
    let patch_text =
        std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap_or_default();
    let mut out = Vec::new();
    if let Some(deps) = manifest["dependencies"].as_object() {
        for (name, spec) in deps {
            if name.starts_with("@deepseek-ai/") {
                continue; // 内核及官方运行件不视为第三方插件
            }
            let m = read_dep_manifest(&profile, name);
            let version = m
                .as_ref()
                .and_then(|m| m["version"].as_str())
                .unwrap_or("")
                .to_string();
            let is_bundle = m
                .as_ref()
                .map(|m| m.pointer("/dsh/bundle/patch").is_some())
                .unwrap_or(false);
            let cid = cordis_id_of(name);
            out.push(InstalledPlugin {
                name: name.clone(),
                id: cid.clone(),
                version,
                is_bundle,
                disabled: patch_is_disabled(&patch_text, &cid),
                is_core: false,
            });
            let _ = spec;
        }
    }
    Ok(out)
}

pub fn install_sync(
    state: &App,
    inst_id: &str,
    spec: &str,
    mut on_stage: impl FnMut(&str),
) -> Result<String, String> {
    let inst = instance::find_instance(state, inst_id)?;
    if inst.status != crate::model::InstanceStatus::Ready {
        return Err("实例尚未就绪".into());
    }
    if instance::is_running(state, inst_id) {
        return Err("实例运行中，请先停止再安装插件".into());
    }
    let registry = state.cfg.lock().unwrap().settings.npm_registry.clone();
    let profile = profile_dir(&inst);
    ensure_profile(&profile)?;
    // 操作前自动快照（可回滚）
    let _ = snapshot_profile(&inst, &format!("安装 {spec} 前自动快照"));
    let pm = detect_pm(&inst);
    if pm.program == "none" {
        return Err(
            "未找到包管理器：实例未内置 Node 运行时，且本机没有 pnpm / npm".into(),
        );
    }
    on_stage(&format!("解析 {} · 包管理器 {}", spec, pm.program));
    let pkg = pkg_name_of_spec(spec);
    // 幽灵包保护：装卸前备份 EAC 拷入的伴生插件，装卸后原样恢复
    let ghost_backup =
        profile.join(format!(".ghost-bak-{}", &crate::util::gen_id()[..8]));
    stash_ghost_packages(&profile, &ghost_backup).map_err(|e| {
        let _ = std::fs::remove_dir_all(&ghost_backup);
        format!("无法安全备份内置插件（已中止安装）: {e}")
    })?;
    let pm_result = run_pm(&pm, &profile, "add", spec, &registry);
    restore_ghost_packages(&ghost_backup, &profile);
    pm_result?;
    on_stage("对账插件层 dsh.profile.bundles");
    bundle_add(&profile, &pkg)?;
    let manifest_text =
        std::fs::read_to_string(profile.join("package.json")).map_err(|e| e.to_string())?;
    let manifest: Value = serde_json::from_str(&manifest_text).map_err(|e| e.to_string())?;
    let ver = manifest["dependencies"]
        .as_object()
        .and_then(|d| d.get(&pkg))
        .cloned()
        .map(|v| match &v {
            Value::String(s) => format!("{pkg}@{s}"),
            other => format!("{pkg}@{other}"),
        })
        .unwrap_or_else(|| pkg.clone());
    Ok(ver)
}

pub fn uninstall_sync(state: &App, inst_id: &str, pkg: &str) -> Result<(), String> {
    let inst = instance::find_instance(state, inst_id)?;
    if instance::is_running(state, inst_id) {
        return Err("实例运行中，请先停止再卸载插件".into());
    }
    let profile = profile_dir(&inst);
    let pkg_path = profile.join("package.json");
    if !pkg_path.exists() {
        return Err("该实例没有安装任何插件".into());
    }
    let _ = snapshot_profile(&inst, &format!("卸载 {pkg} 前自动快照"));
    let registry = state.cfg.lock().unwrap().settings.npm_registry.clone();
    let pm = detect_pm(&inst);
    if pm.program == "none" {
        return Err("未找到包管理器（pnpm / npm）".into());
    }
    let ghost_backup =
        profile.join(format!(".ghost-bak-{}", &crate::util::gen_id()[..8]));
    stash_ghost_packages(&profile, &ghost_backup).map_err(|e| {
        let _ = std::fs::remove_dir_all(&ghost_backup);
        format!("无法安全备份内置插件（已中止卸载）: {e}")
    })?;
    let pm_result = run_pm(&pm, &profile, "remove", pkg, &registry);
    restore_ghost_packages(&ghost_backup, &profile);
    pm_result?;
    bundle_remove(&profile, pkg)?;
    let cid = cordis_id_of(pkg);
    let patch_path = profile.join("cordis.patch.yml");
    if patch_path.exists() {
        let text = std::fs::read_to_string(&patch_path).unwrap_or_default();
        let cleaned = patch_remove_entry(&text, &cid);
        std::fs::write(&patch_path, cleaned).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn toggle_plugin(state: &App, inst_id: &str, pkg: &str, disabled: bool) -> Result<(), String> {
    let inst = instance::find_instance(state, inst_id)?;
    if instance::is_running(state, inst_id) {
        return Err("实例运行中，请先停止再修改插件".into());
    }
    let profile = profile_dir(&inst);
    ensure_profile(&profile)?;
    let _ = snapshot_profile(&inst, &format!("{} {pkg} 前自动快照", if disabled { "停用" } else { "启用" }));
    let cid = cordis_id_of(pkg);
    let patch_path = profile.join("cordis.patch.yml");
    let text =
        std::fs::read_to_string(&patch_path).unwrap_or_else(|_| "[]\n".into());
    let next = patch_set_disabled(&text, &cid, pkg, disabled);
    std::fs::write(&patch_path, next).map_err(|e| format!("写入 patch 失败: {e}"))?;
    Ok(())
}

/// 读取 profile 清单里的 dsh.profile.bundles；清单缺失/损坏返回空
fn read_profile_bundles(pkg_path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(pkg_path) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    manifest["dsh"]["profile"]["bundles"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// 把 bundles 写回 profile 清单（自动补齐 dsh.profile 层级；只改数组，不动其它字段）
fn write_profile_bundles(pkg_path: &Path, manifest: &mut Value, bundles: Vec<String>) -> Result<(), String> {
    if !manifest.is_object() {
        *manifest = json!({});
    }
    if !manifest["dsh"].is_object() {
        manifest["dsh"] = json!({});
    }
    if !manifest["dsh"]["profile"].is_object() {
        manifest["dsh"]["profile"] = json!({});
    }
    manifest["dsh"]["profile"]["bundles"] = json!(bundles);
    std::fs::write(pkg_path, serde_json::to_string_pretty(manifest).unwrap())
        .map_err(|e| format!("写回 profile 清单失败: {e}"))
}

/// 立即采集 bundles 快照到实例元数据。返回是否发生了更新。
/// 供两处调用：stop() 杀进程前（EAC 退出流程会清空 bundles，这是最后机会）、
/// 启动后 watcher 确认实例存活时。
pub fn snapshot_bundles_now(state: &App, inst_id: &str) -> bool {
    let Ok(inst) = instance::find_instance(state, inst_id) else {
        return false;
    };
    let bundles = read_profile_bundles(&profile_dir(&inst).join("package.json"));
    if bundles.is_empty() || bundles == inst.last_good_bundles {
        return false;
    }
    {
        let mut cfg = state.cfg.lock().unwrap();
        if let Some(r) = cfg.instances.iter_mut().find(|r| r.id == inst_id) {
            r.last_good_bundles = bundles;
        } else {
            return false;
        }
    }
    let _ = state.persist();
    if let Ok(snapshot) = instance::find_instance(state, inst_id) {
        crate::store::write_instance_manifest(&snapshot);
    }
    true
}

/// 启动后异步采集健康 bundles 快照。EAC 在启动过程中会把 bundles 写回
/// manifest，因此不能在 spawn 后立即读（读到的是上次退出后被清空的状态）：
/// 轮询等待 manifest 出现非空 bundles，再静置一段时间让启动流程走完
/// （若 dsh web 随后崩溃则实例已不在运行态，放弃采集）。
pub fn spawn_bundle_snapshot(state: &std::sync::Arc<App>, inst_id: &str) {
    let state = std::sync::Arc::clone(state);
    let inst_id = inst_id.to_string();
    std::thread::spawn(move || {
        let pkg_path = match instance::find_instance(&state, &inst_id) {
            Ok(inst) => profile_dir(&inst).join("package.json"),
            Err(_) => return,
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        let mut seen_non_empty = false;
        while std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if !instance::is_running(&state, &inst_id) {
                return; // 实例已退出（启动失败或用户秒退），不采集
            }
            if !read_profile_bundles(&pkg_path).is_empty() {
                seen_non_empty = true;
                break;
            }
        }
        if !seen_non_empty {
            return;
        }
        // 静置：等 EAC 写全（伴生 bundles 同步），也避开 dsh web 启动即崩的窗口
        std::thread::sleep(std::time::Duration::from_secs(15));
        if instance::is_running(&state, &inst_id) {
            snapshot_bundles_now(&state, &inst_id);
        }
    });
}

/// 启动前守卫：把 manifest 缺失的 bundles 补回（增量并集，绝不重算整个数组）。
/// EAC 的退出流程在部分版本上会把 bundles 清空，导致下次启动 webServer 缺失、
/// 全部插件 pending（退出码 1）。补回来源按可靠性排序：
/// 1. 基础 bundles 兜底（dsh-base / dsh-web-app，核心服务提供者，无条件补回）
/// 2. dependencies 中声明了 dsh.bundle 的已装插件（dsh-loader 等第三方）
/// 3. 历史健康快照（EAC 内置伴生 bundles 等无法从清单推导的条目）
///
/// 清单缺失/损坏时重建最小模板，其余状态由 EAC 首启自愈。
pub fn repair_bundles_before_launch(inst: &crate::model::InstanceMeta) {
    let profile = profile_dir(inst);
    let pkg_path = profile.join("package.json");
    // 首次启动前 profile 目录尚不存在（EAC 首启自建）——补建目录再写守卫结果
    let _ = std::fs::create_dir_all(&profile);
    let mut manifest: Value = match std::fs::read_to_string(&pkg_path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    };
    let bundles = read_profile_bundles(&pkg_path);
    let mut next = bundles;
    let before = next.len();
    for b in BASE_BUNDLES {
        if !next.iter().any(|x| x == b) {
            eprintln!("[launch-guard] 兜底补回基础 bundle: {b}");
            next.push(b.to_string());
        }
    }
    // dependencies 里声明了 dsh.bundle 且已安装的插件包，补回 bundle 声明
    if let Some(deps) = manifest.get("dependencies").and_then(|d| d.as_object()) {
        for name in deps.keys() {
            if next.iter().any(|x| x == name) {
                continue;
            }
            let is_bundle = read_dep_manifest(&profile, name)
                .map(|m| m.pointer("/dsh/bundle/patch").is_some())
                .unwrap_or(false);
            if is_bundle {
                eprintln!("[launch-guard] 恢复丢失的插件 bundle: {name}");
                next.push(name.clone());
            }
        }
    }
    for b in &inst.last_good_bundles {
        if !next.iter().any(|x| x == b) {
            eprintln!("[launch-guard] 按健康快照恢复 bundle: {b}");
            next.push(b.clone());
        }
    }
    if next.len() == before {
        return;
    }
    if let Err(e) = write_profile_bundles(&pkg_path, &mut manifest, next) {
        eprintln!("[launch-guard] 写回修复结果失败: {e}");
    }
}

// ---------- 插件安全体系：profile 快照 / 回滚 / 隔离区 ----------

/// profile 元数据快照目录（package.json + cordis.patch.yml + lock）
fn backups_root(inst: &crate::model::InstanceMeta) -> PathBuf {
    inst.dsh_home.join("launcher-backups")
}

/// 隔离区根目录
fn quarantine_root(inst: &crate::model::InstanceMeta) -> PathBuf {
    inst.dsh_home.join("launcher-quarantine")
}

/// 把 profile 元数据（package.json / cordis.patch.yml / package-lock.json）
/// 快照到 <dsh_home>/launcher-backups/snap-<ts>/。全部插件操作前自动调用。
/// 保留最近 20 份，超出删除最旧的。
pub fn snapshot_profile(inst: &crate::model::InstanceMeta, reason: &str) -> Result<u64, String> {
    let profile = profile_dir(inst);
    let ts = crate::util::now_ms();
    let snap = backups_root(inst).join(format!("snap-{ts}"));
    std::fs::create_dir_all(&snap).map_err(|e| format!("创建快照目录失败: {e}"))?;
    for f in ["package.json", "cordis.patch.yml", "package-lock.json"] {
        let src = profile.join(f);
        if src.exists() {
            std::fs::copy(&src, snap.join(f)).map_err(|e| format!("快照 {f} 失败: {e}"))?;
        }
    }
    let meta = json!({ "ts": ts, "reason": reason });
    std::fs::write(snap.join("snapshot.json"), serde_json::to_string_pretty(&meta).unwrap())
        .map_err(|e| format!("写快照元数据失败: {e}"))?;
    prune_snapshots(inst, 20);
    Ok(ts)
}

fn prune_snapshots(inst: &crate::model::InstanceMeta, keep: usize) {
    let Ok(rd) = std::fs::read_dir(backups_root(inst)) else { return };
    let mut snaps: Vec<(u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_prefix("snap-").and_then(|t| t.parse::<u64>().ok()).map(|t| (t, e.path()))
        })
        .collect();
    snaps.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    for (_, p) in snaps.into_iter().skip(keep) {
        let _ = std::fs::remove_dir_all(p);
    }
}

/// 列出全部快照（新→旧）
pub fn list_snapshots(state: &App, inst_id: &str) -> Result<Vec<crate::model::PluginSnapshot>, String> {
    let inst = instance::find_instance(state, inst_id)?;
    let root = backups_root(&inst);
    let Ok(rd) = std::fs::read_dir(&root) else { return Ok(vec![]) };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(ts) = name.strip_prefix("snap-").and_then(|t| t.parse::<u64>().ok()) else { continue };
        let reason = std::fs::read_to_string(e.path().join("snapshot.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|m| m["reason"].as_str().map(String::from))
            .unwrap_or_default();
        let deps = std::fs::read_to_string(e.path().join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|m| m["dependencies"].as_object().map(|d| d.len()))
            .unwrap_or(0);
        out.push(crate::model::PluginSnapshot { ts, reason, deps });
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.ts));
    Ok(out)
}

/// 回滚 profile 到指定快照：恢复三个元数据文件后按清单重装依赖
/// （npm install 会把 node_modules 对齐到快照的 dependencies），最后跑启动守卫补 bundles。
pub fn restore_snapshot_sync(
    state: &App,
    inst_id: &str,
    ts: u64,
    on_stage: impl FnMut(&str),
) -> Result<(), String> {
    let mut on_stage = on_stage;
    let inst = instance::find_instance(state, inst_id)?;
    if instance::is_running(state, inst_id) {
        return Err("实例运行中，请先停止再回滚".into());
    }
    let snap = backups_root(&inst).join(format!("snap-{ts}"));
    let pkg_src = snap.join("package.json");
    if !pkg_src.exists() {
        return Err("快照不存在或已损坏".into());
    }
    on_stage("恢复 profile 清单");
    let profile = profile_dir(&inst);
    ensure_profile(&profile)?;
    for f in ["package.json", "cordis.patch.yml", "package-lock.json"] {
        let src = snap.join(f);
        if src.exists() {
            std::fs::copy(&src, profile.join(f)).map_err(|e| format!("恢复 {f} 失败: {e}"))?;
        }
    }
    // 按恢复后的清单重装依赖（含幽灵包保护）
    on_stage("按快照清单重装依赖");
    reinstall_deps_sync(state, &inst, on_stage)?;
    Ok(())
}

/// 按当前 profile 清单重装依赖（node_modules 对齐 package.json）。
/// 前后做幽灵包保护；完成后跑启动守卫兜底 bundles。
pub fn reinstall_deps_sync(
    state: &App,
    inst: &crate::model::InstanceMeta,
    mut on_stage: impl FnMut(&str),
) -> Result<(), String> {
    if instance::is_running(state, &inst.id) {
        return Err("实例运行中，请先停止再操作".into());
    }
    let profile = profile_dir(inst);
    ensure_profile(&profile)?;
    let registry = registry_of(state);
    let pm = detect_pm(inst);
    if pm.program == "none" {
        return Err("未找到包管理器（pnpm / npm）".into());
    }
    let ghost_backup = profile.join(format!(".ghost-bak-{}", &crate::util::gen_id()[..8]));
    stash_ghost_packages(&profile, &ghost_backup).map_err(|e| {
        let _ = std::fs::remove_dir_all(&ghost_backup);
        format!("无法安全备份内置插件（已中止）: {e}")
    })?;
    on_stage(&format!("npm install · {}", pm.program));
    let pm_result = run_pm(&pm, &profile, "install", "", &registry);
    restore_ghost_packages(&ghost_backup, &profile);
    pm_result.map_err(|e| format!("依赖重装失败: {e}"))?;
    on_stage("启动守卫补回基础 bundles");
    repair_bundles_before_launch(inst);
    Ok(())
}

fn registry_of(state: &App) -> String {
    state.cfg.lock().unwrap().settings.npm_registry.clone()
}

/// 隔离单个第三方插件：移出 node_modules + 清 dependencies/bundles/patch 条目。
/// 纯文件移动，不跑包管理器，随时可恢复。
pub fn quarantine_plugin(
    state: &App,
    inst_id: &str,
    pkg: &str,
    reason: &str,
) -> Result<crate::model::QuarantinedPlugin, String> {
    let mut inst = instance::find_instance(state, inst_id)?;
    if instance::is_running(state, inst_id) {
        return Err("实例运行中，请先停止再隔离插件".into());
    }
    let profile = profile_dir(&inst);
    let pkg_path = profile.join("package.json");
    let text = std::fs::read_to_string(&pkg_path).map_err(|e| format!("读取清单失败: {e}"))?;
    let mut manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("清单损坏: {e}"))?;
    let spec = manifest["dependencies"]
        .get(pkg)
        .cloned()
        .ok_or_else(|| format!("{pkg} 不在该实例的 dependencies 中"))?;
    let spec_s = match &spec {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let version = read_dep_manifest(&profile, pkg)
        .and_then(|m| m["version"].as_str().map(String::from))
        .unwrap_or_default();

    // 移出 node_modules（scope 感知）
    let nm = profile.join("node_modules");
    let src = nm.join(pkg.replace('/', std::path::MAIN_SEPARATOR_STR));
    let qroot = quarantine_root(&inst);
    let dest = qroot.join(format!(
        "{}-{}",
        pkg.replace(['/', '\\'], "__"),
        &crate::util::gen_id()[..6]
    ));
    if src.exists() {
        std::fs::create_dir_all(&qroot).map_err(|e| format!("创建隔离区失败: {e}"))?;
        std::fs::rename(&src, &dest).map_err(|e| format!("移出 {pkg} 失败: {e}"))?;
        // 清掉空的 scope 目录
        if pkg.contains('/') {
            if let Some(scope) = pkg.split('/').next() {
                let scope_dir = nm.join(scope);
                if scope_dir.is_dir() {
                    let _ = std::fs::remove_dir(&scope_dir); // 空才删得掉
                }
            }
        }
    }

    // 清 dependencies
    if let Some(deps) = manifest["dependencies"].as_object_mut() {
        deps.remove(pkg);
    }
    std::fs::write(&pkg_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("写回清单失败: {e}"))?;
    // 清 bundles 与 patch 条目
    let _ = bundle_remove(&profile, pkg);
    let cid = cordis_id_of(pkg);
    let patch_path = profile.join("cordis.patch.yml");
    if patch_path.exists() {
        let pt = std::fs::read_to_string(&patch_path).unwrap_or_default();
        let _ = std::fs::write(&patch_path, patch_remove_entry(&pt, &cid));
    }

    let item = crate::model::QuarantinedPlugin {
        name: pkg.to_string(),
        id: cid,
        version,
        spec: spec_s,
        reason: reason.to_string(),
        at: crate::util::now_ms(),
    };
    {
        let mut cfg = state.cfg.lock().unwrap();
        if let Some(r) = cfg.instances.iter_mut().find(|r| r.id == inst_id) {
            r.quarantine.retain(|q| q.name != pkg);
            r.quarantine.push(item.clone());
        }
    }
    state.persist()?;
    inst.quarantine = {
        let cfg = state.cfg.lock().unwrap();
        cfg.instances
            .iter()
            .find(|r| r.id == inst_id)
            .map(|r| r.quarantine.clone())
            .unwrap_or_default()
    };
    Ok(item)
}

/// 隔离全部第三方插件（crash-guard 自动恢复 / 安全启动共用）。返回隔离数量。
pub fn quarantine_all_third_party(
    state: &App,
    inst_id: &str,
    reason: &str,
) -> Result<usize, String> {
    let plugins = list_installed(state, inst_id)?;
    let mut n = 0usize;
    for p in &plugins {
        if p.disabled {
            // 已停用的插件同样隔离，保证安全启动完全干净
        }
        match quarantine_plugin(state, inst_id, &p.name, reason) {
            Ok(_) => n += 1,
            Err(e) => eprintln!("[quarantine] 跳过 {}: {e}", p.name),
        }
    }
    Ok(n)
}

/// 从隔离区恢复插件：移回 node_modules + 写回 dependencies + 必要时补 bundle
pub fn quarantine_restore(state: &App, inst_id: &str, pkg: &str) -> Result<(), String> {
    let inst = instance::find_instance(state, inst_id)?;
    if instance::is_running(state, inst_id) {
        return Err("实例运行中，请先停止再恢复插件".into());
    }
    let item = {
        let cfg = state.cfg.lock().unwrap();
        cfg.instances
            .iter()
            .find(|r| r.id == inst_id)
            .and_then(|r| r.quarantine.iter().find(|q| q.name == pkg))
            .cloned()
            .ok_or_else(|| "该插件不在隔离区".to_string())?
    };
    // 隔离目录（唯一以 <pkg>__ 开头且属于该包的最近目录）
    let qroot = quarantine_root(&inst);
    let prefix = format!("{}-", pkg.replace(['/', '\\'], "__"));
    let mut found: Option<PathBuf> = None;
    if let Ok(rd) = std::fs::read_dir(&qroot) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with(&prefix) && e.path().is_dir() {
                found = Some(e.path()); // 取最后一个（目录名含时间与随机段）
            }
        }
    }
    let profile = profile_dir(&inst);
    let nm = profile.join("node_modules");
    let dest = nm.join(pkg.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(src) = found {
        if dest.exists() {
            return Err(format!("node_modules 中已存在 {pkg}，无法恢复"));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::rename(&src, &dest).map_err(|e| format!("移回 {pkg} 失败: {e}"))?;
    } else if !dest.exists() {
        eprintln!("[quarantine] {pkg} 无隔离文件，仅恢复清单条目");
    }
    // 写回 dependencies + bundle 声明
    let pkg_path = profile.join("package.json");
    let text = std::fs::read_to_string(&pkg_path).unwrap_or_else(|_| "{}".into());
    let mut manifest: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    if !manifest["dependencies"].is_object() {
        manifest["dependencies"] = json!({});
    }
    manifest["dependencies"][pkg] = json!(item.spec);
    std::fs::write(&pkg_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("写回清单失败: {e}"))?;
    let _ = bundle_add(&profile, pkg);
    // 移除隔离记录
    {
        let mut cfg = state.cfg.lock().unwrap();
        if let Some(r) = cfg.instances.iter_mut().find(|r| r.id == inst_id) {
            r.quarantine.retain(|q| q.name != pkg);
        }
    }
    state.persist()?;
    Ok(())
}

/// 彻底删除隔离区中的插件文件与记录
pub fn quarantine_purge(state: &App, inst_id: &str, pkg: &str) -> Result<(), String> {
    let inst = instance::find_instance(state, inst_id)?;
    let qroot = quarantine_root(&inst);
    let prefix = format!("{}-", pkg.replace(['/', '\\'], "__"));
    if let Ok(rd) = std::fs::read_dir(&qroot) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    {
        let mut cfg = state.cfg.lock().unwrap();
        if let Some(r) = cfg.instances.iter_mut().find(|r| r.id == inst_id) {
            r.quarantine.retain(|q| q.name != pkg);
        }
    }
    state.persist()?;
    Ok(())
}

// ---------- 市场 ----------

fn map_market(raw: Vec<crate::model::MarketRaw>) -> Vec<MarketPlugin> {
    raw.into_iter()
        .map(|r| {
            let zh = r
                .description
                .iter()
                .find(|d| d.language.starts_with("zh"))
                .map(|d| d.content.clone());
            let en = r
                .description
                .iter()
                .find(|d| d.language.starts_with("en"))
                .map(|d| d.content.clone());
            MarketPlugin {
                id: r.id,
                name: r.name,
                desc_zh: zh.clone().unwrap_or_default(),
                desc_en: en.or(zh).unwrap_or_default(),
                support_versions: r.support_versions,
                homepage: r.urls.homepage.clone(),
                repository: r.urls.repository.clone(),
            }
        })
        .collect()
}

pub async fn fetch_market(state: &App, force: bool) -> Result<Vec<MarketPlugin>, String> {
    // 磁盘缓存 1 小时（force = 手动刷新时绕过）
    let cache = state.data_dir.join("market.json");
    if !force {
        if let Ok(meta) = std::fs::metadata(&cache) {
            if let Ok(modified) = meta.modified() {
                if modified.elapsed().map(|e| e.as_secs() < 3600).unwrap_or(false) {
                    if let Ok(text) = std::fs::read_to_string(&cache) {
                        if let Ok(list) = serde_json::from_str::<Vec<MarketPlugin>>(&text) {
                            return Ok(list);
                        }
                    }
                }
            }
        }
    }
    let (url, value) = net::fetch_json_any(net::MARKET_URLS, 4 * 1024 * 1024).await?;
    let raw: Vec<crate::model::MarketRaw> = if value.is_array() {
        serde_json::from_value(value).map_err(|e| format!("市场数据解析失败: {e}"))?
    } else {
        return Err(format!("市场数据格式异常（{url}）"));
    };
    let list = map_market(raw);
    let _ = std::fs::write(&cache, serde_json::to_string(&list).unwrap_or_default());
    Ok(list)
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    use crate::model::InstanceMeta;
    use std::fs;
    use std::path::PathBuf;

    fn fake_instance(tag: &str) -> InstanceMeta {
        let dir = std::env::temp_dir().join(format!("eac-safety-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let inst = InstanceMeta {
            id: format!("t-{tag}"),
            dsh_home: dir.join("dsh-home"),
            ..Default::default()
        };
        let profile = profile_dir(&inst);
        fs::create_dir_all(&profile).unwrap();
        fs::write(
            profile.join("package.json"),
            r#"{"dependencies":{"@dsh-plugin/dsh-loader":"^1.3.3"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@dsh-plugin/dsh-loader"]}}}"#,
        )
        .unwrap();
        fs::write(profile.join("cordis.patch.yml"), "[]\n").unwrap();
        inst
    }

    /// 快照：三个元数据文件落盘、可枚举、超量裁剪
    #[test]
    fn snapshot_profile_roundtrip_and_prune() {
        let inst = fake_instance("snap");
        for _ in 0..23 {
            snapshot_profile(&inst, "测试快照").unwrap();
        }
        let root = backups_root(&inst);
        let snaps: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("snap-"))
            .collect();
        assert_eq!(snaps.len(), 20, "快照数量应裁剪到 20");
        let newest = snaps
            .iter()
            .map(|e| e.path())
            .max_by_key(|p| p.file_name().unwrap_or_default().to_string_lossy().to_string())
            .unwrap();
        assert!(newest.join("package.json").is_file());
        assert!(newest.join("cordis.patch.yml").is_file());
        assert!(newest.join("snapshot.json").is_file());
        let _ = fs::remove_dir_all(inst.dsh_home.parent().unwrap());
    }

    /// 隔离/恢复的文件系统语义：quarantine_plugin 需要 state，这里直接验证
    /// 隔离目录命名与恢复路径推导（prefix 规则）保持一致
    #[test]
    fn quarantine_naming_roundtrip() {
        let pkg = "@dsh-plugin/dsh-loader";
        let prefix = format!("{}-", pkg.replace(['/', '\\'], "__"));
        assert_eq!(prefix, "@dsh-plugin__dsh-loader-");
        let dir = PathBuf::from(format!("{prefix}abc123"));
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with(&prefix), "恢复时按 prefix 找回隔离目录");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cordis_id() {
        assert_eq!(cordis_id_of("@dsh-plugin/dsh-auxiliary"), "dsh-auxiliary");
        assert_eq!(cordis_id_of("dsh-better-sidebar"), "dsh-better-sidebar");
    }

    #[test]
    fn spec_pkg_name() {
        assert_eq!(pkg_name_of_spec("@dsh-plugin/dsh-loader"), "@dsh-plugin/dsh-loader");
        assert_eq!(pkg_name_of_spec("@dsh-plugin/dsh-loader@1.3.3"), "@dsh-plugin/dsh-loader");
        assert_eq!(pkg_name_of_spec("foo@1.0.0"), "foo");
        assert_eq!(pkg_name_of_spec("foo"), "foo");
    }

    #[test]
    fn patch_roundtrip() {
        let text = "[]\n";
        let d = patch_set_disabled(text, "dsh-auxiliary", "@dsh-plugin/dsh-auxiliary", true);
        // 空列表占位符必须被替换，不得残留 `[]` 与块列表共存（非法 YAML）
        assert!(!d.contains("[]"), "placeholder removed: {d}");
        assert!(patch_is_disabled(&d, "dsh-auxiliary"));
        assert!(!patch_is_disabled(&d, "dsh-other"));
        let e = patch_set_disabled(&d, "dsh-auxiliary", "@x", false);
        assert!(!patch_is_disabled(&e, "dsh-auxiliary"));
        let r = patch_remove_entry(&e, "dsh-auxiliary");
        assert!(!patch_has_entry(&r, "dsh-auxiliary"));
        assert_eq!(r.trim(), "[]", "empty again after removal: {r}");
    }

    #[test]
    fn patch_keeps_siblings() {
        let text = "- id: dsh-loader\n  name: '@dsh-plugin/dsh-loader'\n- id: dsh-auxiliary\n  name: '@dsh-plugin/dsh-auxiliary'\n  disabled: true\n";
        let d = patch_set_disabled(text, "dsh-loader", "@dsh-plugin/dsh-loader", true);
        assert!(patch_is_disabled(&d, "dsh-loader"));
        assert!(patch_is_disabled(&d, "dsh-auxiliary"), "兄弟条目不受影响");
        let r = patch_remove_entry(&d, "dsh-auxiliary");
        assert!(patch_is_disabled(&r, "dsh-loader"));
        assert!(!patch_has_entry(&r, "dsh-auxiliary"));
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;
    use std::fs;

    fn tmp_profile(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eac-guard-{}-{}", tag, std::process::id()));
        let p = dir.join("profiles").join("web-desktop");
        fs::create_dir_all(&p).unwrap();
        fs::write(
            p.join("package.json"),
            r#"{"name":"t","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}"#,
        ).unwrap();
        dir
    }

    #[test]
    fn bundle_add_preserves_eac_base_bundles() {
        let dir = tmp_profile("add");
        let profile = dir.join("profiles").join("web-desktop");
        // 模拟 pnpm add 后 deps 已写入
        let mp = profile.join("package.json");
        let mut m: Value = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        m["dependencies"] = json!({"@dsh-plugin/dsh-loader":"^1.3.3"});
        fs::write(&mp, serde_json::to_string_pretty(&m).unwrap()).unwrap();
        // 建一个声明 dsh.bundle 的插件包
        let pkg_dir = profile.join("node_modules").join("@dsh-plugin").join("dsh-loader");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(pkg_dir.join("package.json"), r#"{"name":"@dsh-plugin/dsh-loader","version":"1.3.3","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}"#).unwrap();

        bundle_add(&profile, "@dsh-plugin/dsh-loader").unwrap();
        let m: Value = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(
            m["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-plugin/dsh-loader"]),
            "EAC 基础 bundles 必须保留"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_remove_only_drops_target() {
        let dir = tmp_profile("rm");
        let profile = dir.join("profiles").join("web-desktop");
        let mp = profile.join("package.json");
        fs::write(&mp, r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@dsh-plugin/dsh-loader"]}}}"#).unwrap();
        bundle_remove(&profile, "@dsh-plugin/dsh-loader").unwrap();
        let m: Value = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(
            m["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn repair_restores_poisoned_bundles() {
        let dir = tmp_profile("repair");
        let profile = dir.join("profiles").join("web-desktop");
        let mp = profile.join("package.json");
        // 模拟 EAC 退出流程清空
        fs::write(&mp, r#"{"dsh":{"profile":{"bundles":[]}}}"#).unwrap();
        let inst = crate::model::InstanceMeta {
            dsh_home: dir.clone(),
            last_good_bundles: vec![
                "@deepseek-ai/dsh-base".into(),
                "@deepseek-ai/dsh-web-app".into(),
                "@dsh-plugin/dsh-loader".into(),
            ],
            ..Default::default()
        };
        repair_bundles_before_launch(&inst);
        let m: Value = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(
            m["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-plugin/dsh-loader"])
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 本次事故的回归测试：快照为空（从未采集成功）时守卫不得空转，
    /// 基础 bundles 必须被无条件兜底补回，否则 dsh web 启动即崩（退出码 1）。
    #[test]
    fn repair_floors_base_bundles_with_empty_snapshot() {
        let dir = tmp_profile("floor");
        let profile = dir.join("profiles").join("web-desktop");
        let mp = profile.join("package.json");
        fs::write(&mp, r#"{"dependencies":{"@dsh-plugin/dsh-loader":"^1.3.3"},"dsh":{"profile":{"bundles":[]}}}"#).unwrap();
        let inst = crate::model::InstanceMeta {
            dsh_home: dir.clone(),
            last_good_bundles: Vec::new(),
            ..Default::default()
        };
        repair_bundles_before_launch(&inst);
        let m: Value = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(
            m["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]),
            "空快照时基础 bundles 也必须兜底"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// dependencies 里声明了 dsh.bundle 的已装插件（dsh-loader 等）应被恢复
    #[test]
    fn repair_recovers_dependency_bundles() {
        let dir = tmp_profile("deps");
        let profile = dir.join("profiles").join("web-desktop");
        let mp = profile.join("package.json");
        fs::write(&mp, r#"{"dependencies":{"@dsh-plugin/dsh-loader":"^1.3.3"},"dsh":{"profile":{"bundles":[]}}}"#).unwrap();
        let pkg_dir = profile.join("node_modules").join("@dsh-plugin").join("dsh-loader");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(pkg_dir.join("package.json"), r#"{"name":"@dsh-plugin/dsh-loader","version":"1.3.3","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}"#).unwrap();
        let inst = crate::model::InstanceMeta {
            dsh_home: dir.clone(),
            last_good_bundles: Vec::new(),
            ..Default::default()
        };
        repair_bundles_before_launch(&inst);
        let m: Value = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(
            m["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-plugin/dsh-loader"])
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 清单缺失时重建最小模板（bundles 兜底），EAC 首启自愈其余状态
    #[test]
    fn repair_rebuilds_missing_manifest() {
        let dir = std::env::temp_dir().join(format!("eac-guard-missing-{}", std::process::id()));
        let profile = dir.join("profiles").join("web-desktop");
        fs::create_dir_all(&profile).unwrap();
        let inst = crate::model::InstanceMeta {
            dsh_home: dir.clone(),
            ..Default::default()
        };
        repair_bundles_before_launch(&inst);
        let mp = profile.join("package.json");
        assert!(mp.exists(), "缺失的清单应被重建");
        let m: Value = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(
            m["dsh"]["profile"]["bundles"],
            json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 健康（含 EAC 内置伴生 bundle 等未知条目）时不得改写，也不能删除任何条目
    #[test]
    fn repair_noop_when_healthy_and_preserves_entries() {
        let dir = tmp_profile("noop");
        let profile = dir.join("profiles").join("web-desktop");
        let mp = profile.join("package.json");
        let healthy = r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","eac-companion-bundle"]}}}"#;
        fs::write(&mp, healthy).unwrap();
        let inst = crate::model::InstanceMeta {
            dsh_home: dir.clone(),
            last_good_bundles: vec!["@deepseek-ai/dsh-base".into(), "@deepseek-ai/dsh-web-app".into()],
            ..Default::default()
        };
        repair_bundles_before_launch(&inst);
        assert_eq!(
            fs::read_to_string(&mp).unwrap(),
            healthy,
            "健康 bundles 不得被改写"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 真机手动验证：DSH_EAC_VERIFY_HOME=<实例 dsh-home> cargo test -- --ignored
    /// repair_bundles_before_launch
    /// 对真实实例目录执行生产 repair 函数，断言基础 bundles 被补回。
    #[test]
    #[ignore]
    fn repair_real_instance_manual() {
        let Ok(home) = std::env::var("DSH_EAC_VERIFY_HOME") else {
            eprintln!("跳过：未设置 DSH_EAC_VERIFY_HOME");
            return;
        };
        let dir = PathBuf::from(home);
        let inst = crate::model::InstanceMeta {
            dsh_home: dir.clone(),
            ..Default::default()
        };
        let mp = profile_dir(&inst).join("package.json");
        let before = read_profile_bundles(&mp);
        eprintln!("repair 前 bundles: {before:?}");
        repair_bundles_before_launch(&inst);
        let after = read_profile_bundles(&mp);
        eprintln!("repair 后 bundles: {after:?}");
        for b in BASE_BUNDLES {
            assert!(after.iter().any(|x| x == b), "基础 bundle {b} 必须在列");
        }
    }
}

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

/// 首次初始化 profile（与 EAC/dsh 的模板一致）
pub fn ensure_profile(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建 profile 目录失败: {e}"))?;
    let pkg = dir.join("package.json");
    if !pkg.exists() {
        let manifest = json!({
            "name": "dsh-profile-web-desktop",
            "version": "0.0.0",
            "private": true,
            "dsh": { "profile": { "bundles": [] } }
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
            c.arg(cli).arg(verb).arg(spec);
            c
        }
        "pnpm" => {
            let mut c = std::process::Command::new("pnpm.cmd");
            c.arg(verb).arg(spec);
            c
        }
        "npm" => {
            let mut c = std::process::Command::new("npm.cmd");
            c.arg(verb).arg(spec);
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
    let cid = cordis_id_of(pkg);
    let patch_path = profile.join("cordis.patch.yml");
    let text =
        std::fs::read_to_string(&patch_path).unwrap_or_else(|_| "[]\n".into());
    let next = patch_set_disabled(&text, &cid, pkg, disabled);
    std::fs::write(&patch_path, next).map_err(|e| format!("写入 patch 失败: {e}"))?;
    Ok(())
}

/// 采集当前健康的 dsh.profile.bundles（实例运行中/正常退出后调用）
pub fn capture_good_bundles(state: &App, inst_id: &str) -> Result<Vec<String>, String> {
    let inst = instance::find_instance(state, inst_id)?;
    let pkg_path = profile_dir(&inst).join("package.json");
    let Ok(text) = std::fs::read_to_string(&pkg_path) else {
        return Ok(Vec::new());
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
        return Ok(Vec::new());
    };
    let bundles = manifest["dsh"]["profile"]["bundles"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    Ok(bundles)
}

/// 启动前守卫：manifest bundles 若丢失了上次健康快照中的内置条目，自动补回。
/// EAC 的退出流程在部分版本上会把 bundles 清空，导致下次启动 webServer 缺失、
/// 全部插件 pending（退出码 1）。此守卫保证启动时基础 bundles 完整。
pub fn repair_bundles_before_launch(inst: &crate::model::InstanceMeta) {
    if inst.last_good_bundles.is_empty() {
        return;
    }
    let pkg_path = profile_dir(inst).join("package.json");
    let Ok(text) = std::fs::read_to_string(&pkg_path) else { return };
    let Ok(mut manifest) = serde_json::from_str::<Value>(&text) else { return };
    let bundles: Vec<String> = manifest["dsh"]["profile"]["bundles"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let missing: Vec<&String> = inst
        .last_good_bundles
        .iter()
        .filter(|b| !bundles.contains(b))
        .collect();
    if missing.is_empty() {
        return;
    }
    let mut next = bundles;
    for m in missing {
        eprintln!("[launch-guard] 恢复丢失的 bundle: {m}");
        next.push(m.clone());
    }
    manifest["dsh"]["profile"]["bundles"] = json!(next);
    let _ = std::fs::write(&pkg_path, serde_json::to_string_pretty(&manifest).unwrap());
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
}

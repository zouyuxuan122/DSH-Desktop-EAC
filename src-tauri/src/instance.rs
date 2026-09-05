// 实例生命周期：启动 / 停止 / 运行状态 / 删除 / 重命名 / 体积统计。

use crate::model::{InstanceMeta, InstanceStatus};
use crate::store::{write_instance_manifest, App};
use crate::util;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub fn find_instance(state: &App, id: &str) -> Result<InstanceMeta, String> {
    state
        .cfg
        .lock()
        .unwrap()
        .instances
        .iter()
        .find(|i| i.id == id)
        .cloned()
        .ok_or_else(|| "实例不存在".into())
}

pub fn is_running(state: &App, id: &str) -> bool {
    // 以 pid 存活为准（子进程句柄仅用于会话内 reap）
    let pid = {
        let cfg = state.cfg.lock().unwrap();
        cfg.instances
            .iter()
            .find(|i| i.id == id)
            .and_then(|i| i.last_pid)
    };
    match pid {
        Some(p) => util::pid_alive(p),
        None => false,
    }
}

/// 清理已退出的子进程记录并同步 running 状态
pub fn reap(state: &App) {
    let mut children = state.children.lock().unwrap();
    let mut exited: Vec<String> = Vec::new();
    for (id, child) in children.iter_mut() {
        if let Ok(Some(_)) = child.try_wait() {
            exited.push(id.clone());
        }
    }
    for id in exited {
        children.remove(&id);
        let mut cfg = state.cfg.lock().unwrap();
        if let Some(r) = cfg.instances.iter_mut().find(|i| i.id == id) {
            r.last_pid = None;
        }
    }
}

/// 启动实例。safe = 安全启动：先把全部第三方插件移入隔离区（可恢复）再拉起，
/// 用于插件疑似导致后端崩溃时的排障与自救。
pub fn launch_opts(
    state: &std::sync::Arc<App>,
    app: Option<tauri::AppHandle>,
    id: &str,
    safe: bool,
) -> Result<u32, String> {
    reap(state);
    if is_running(state, id) {
        return Err("实例已在运行中".into());
    }
    let mut inst = find_instance(state, id)?;
    if inst.status != InstanceStatus::Ready {
        return Err("实例尚未就绪".into());
    }
    let exe = inst
        .exe_path
        .clone()
        .filter(|p| p.exists())
        .or_else(|| util::find_main_exe(&inst.app_dir))
        .ok_or_else(|| "未找到主程序 exe，请尝试重新安装该实例".to_string())?;
    inst.exe_path = Some(exe.clone());

    std::fs::create_dir_all(&inst.dsh_home).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let workdir = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| inst.app_dir.clone());

    // 安全启动：隔离全部第三方插件（crash-guard 与手动安全模式共用）
    if safe {
        match crate::plugins::quarantine_all_third_party(state, id, "safe-launch") {
            Ok(n) if n > 0 => eprintln!("[safe-launch] 已隔离 {n} 个第三方插件"),
            Ok(_) => {}
            Err(e) => eprintln!("[safe-launch] 隔离失败（继续启动）: {e}"),
        }
    }

    // 启动前守卫：修复被 EAC 退出流程清空的基础 bundles
    crate::plugins::repair_bundles_before_launch(&inst);

    let shell_log = inst.dir.join("launcher-shell.log");
    let log_out = std::fs::File::create(&shell_log).ok();
    let log_err = log_out.as_ref().and_then(|f| f.try_clone().ok());

    let mut cmd = std::process::Command::new(&exe);
    cmd.current_dir(&workdir)
        .env("DSH_HOME", &inst.dsh_home)
        // 上游 v5.1.x 壳不会给 sidecar 传资源根，sidecar 内 rescue-integration.js
        // 按开发态相对路径找 dsh-desktop，便携布局下必崩（sidecar 秒退 → 壳 180s 超时）。
        // 主动补设：server.js / rescue-integration.js 都优先读该变量。新版壳会自行覆盖。
        .env("DSH_RESOURCE_ROOT", &inst.app_dir)
        .stdout(log_out.map(std::process::Stdio::from).unwrap_or(std::process::Stdio::null()))
        .stderr(log_err.map(std::process::Stdio::from).unwrap_or(std::process::Stdio::null()));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
    let pid = child.id();
    state.children.lock().unwrap().insert(id.to_string(), child);

    let mut cfg = state.cfg.lock().unwrap();
    if let Some(r) = cfg.instances.iter_mut().find(|i| i.id == id) {
        r.last_pid = Some(pid);
        r.last_launched_at = Some(util::now_ms());
        r.launch_count += 1;
        r.exe_path = Some(exe);
    }
    drop(cfg);
    state.persist().ok();
    // 健康快照异步采集：EAC 启动时才把 bundles 写回 manifest，spawn 后立刻读
    // 只能读到上次退出后被清空的旧状态（v4Lite 退出清空缺陷），必须等待写回。
    crate::plugins::spawn_bundle_snapshot(state, id);
    // 快速失败看门狗：25s 内进程退出 = 启动失败，记诊断与连败计数；
    // 存活过 25s 视为启动成功，清零连败。
    spawn_fail_watchdog(Arc::clone(state), app, id.to_string(), pid);
    let snapshot = find_instance(state, id)?;
    write_instance_manifest(&snapshot);
    Ok(pid)
}

/// 启动失败看门狗 + 连败自动恢复（crash-guard）：
/// 连续 3 次快速失败 → 自动隔离全部第三方插件（可从隔离区恢复）+ 修复 bundles，
/// 并发 instance:recovered 事件通知前端。
fn spawn_fail_watchdog(
    state: std::sync::Arc<App>,
    app: Option<tauri::AppHandle>,
    id: String,
    pid: u32,
) {
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let mut exit_info: Option<(i32, u64)> = None;
        while started.elapsed() < std::time::Duration::from_secs(25) {
            std::thread::sleep(std::time::Duration::from_secs(1));
            // Option<Option<i32>>：外层 None = 句柄查询失败，内层 None = 仍在运行
            let probed: Option<Option<i32>> = {
                let mut children = state.children.lock().unwrap();
                match children.get_mut(&id) {
                    Some(c) => c.try_wait().ok().map(|st| st.map(|s| s.code().unwrap_or(-1))),
                    None => Some(if util::pid_alive(pid) { None } else { Some(-1) }),
                }
            };
            match probed {
                None | Some(None) => continue, // 仍在运行
                Some(Some(code)) => {
                    let secs = started.elapsed().as_secs();
                    exit_info = Some((code, secs));
                    break;
                }
            }
        }
        let Some((code, secs)) = exit_info else {
            // 存活过 25s：清零连败，清空诊断
            let changed = {
                let mut cfg = state.cfg.lock().unwrap();
                match cfg.instances.iter_mut().find(|r| r.id == id) {
                    Some(r) if r.fail_streak != 0 || r.last_fail_reason.is_some() => {
                        r.fail_streak = 0;
                        r.last_fail_reason = None;
                        true
                    }
                    _ => false,
                }
            };
            if changed {
                state.persist().ok();
            }
            return;
        };
        // 快速失败：记录诊断
        let inst = match find_instance(&state, &id) {
            Ok(i) => i,
            Err(_) => return,
        };
        let reason = diagnose_failure(&inst, code, secs);
        eprintln!("[fail-watchdog] {id} 启动失败（{secs}s, exit {code}）: {reason}");
        let mut streak = 0u32;
        {
            let mut cfg = state.cfg.lock().unwrap();
            if let Some(r) = cfg.instances.iter_mut().find(|r| r.id == id) {
                r.fail_streak += 1;
                r.last_pid = None;
                r.last_fail_reason = Some(reason.clone());
                streak = r.fail_streak;
            }
        }
        // 移除已退出的子进程句柄并回收
        if let Some(mut c) = state.children.lock().unwrap().remove(&id) {
            let _ = c.wait();
        }
        state.persist().ok();
        // 连败 ≥3：crash-guard 自动恢复（隔离第三方插件 + 修 bundles），可逆操作
        if streak >= 3 {
            match crate::plugins::quarantine_all_third_party(&state, &id, "crash-guard") {
                Ok(n) => {
                    eprintln!("[crash-guard] 已自动隔离 {n} 个第三方插件");
                    let final_reason = format!(
                        "{reason}\n已连续 {streak} 次启动失败，crash-guard 已自动隔离全部第三方插件（可在安全中心恢复或回滚）。"
                    );
                    if let Ok(mut inst2) = find_instance(&state, &id) {
                        crate::plugins::repair_bundles_before_launch(&inst2);
                        inst2.last_fail_reason = Some(final_reason.clone());
                        write_instance_manifest(&inst2);
                    }
                    // 把最终诊断写回注册表
                    {
                        let mut cfg = state.cfg.lock().unwrap();
                        if let Some(r) = cfg.instances.iter_mut().find(|r| r.id == id) {
                            r.last_fail_reason = Some(final_reason);
                        }
                    }
                    state.persist().ok();
                    if let Some(a) = &app {
                        use tauri::Emitter;
                        let _ = a.emit("instance:recovered", id.clone());
                    }
                }
                Err(e) => eprintln!("[crash-guard] 自动隔离失败: {e}"),
            }
        }
    });
}

/// 启动失败诊断：从 launcher-shell.log（我们捕获的壳输出）与共享 dsh-web.log
/// 找已知故障签名，产出人类可读的结论与建议。
/// 共享日志只在「尾部包含本实例路径」时才参与归因——它被同机所有 EAC 实例共写，
/// 否则别的实例的旧崩溃记录会被错认成本实例死因。
fn diagnose_failure(inst: &InstanceMeta, code: i32, secs: u64) -> String {
    let mut text = String::new();
    // 我们捕获的壳/sidecar 输出
    if let Ok(t) = std::fs::read_to_string(inst.dir.join("launcher-shell.log")) {
        let tail: String = t.chars().rev().take(12000).collect::<Vec<_>>().into_iter().rev().collect();
        text.push_str(&tail);
    }
    // 共享 dsh-web.log（完整版 / Lite 各有固定位置）
    let log_candidates = if inst.edition == "lite" {
        vec![
            dirs::config_dir().map(|d| d.join("com.deepseek.dsh.desktop.lite/logs/dsh-web.log")),
            dirs::config_dir().map(|d| d.join("Deepseek Harness EAC/logs/dsh-web.log")),
        ]
    } else {
        vec![
            dirs::config_dir().map(|d| d.join("Deepseek Harness EAC/logs/dsh-web.log")),
            dirs::config_dir().map(|d| d.join("com.deepseek.dsh.desktop.lite/logs/dsh-web.log")),
        ]
    };
    for p in log_candidates.into_iter().flatten() {
        if let Ok(meta) = std::fs::metadata(&p) {
            // 只看最近写入的日志（3 小时内视为本次相关）
            if meta.modified().ok().and_then(|m| m.elapsed().ok()).map(|e| e.as_secs() < 3 * 3600).unwrap_or(false) {
                if let Ok(t) = std::fs::read_to_string(&p) {
                    // 按行过滤：共享日志被同机所有 EAC 实例共写，只保留
                    // 明确包含本实例目录的行，杜绝别的实例的旧崩溃记录被误归因
                    let dir_norm = inst.dir.display().to_string().replace('/', "\\");
                    let mine: Vec<&str> = t
                        .lines()
                        .filter(|l| l.replace('/', "\\").contains(&dir_norm))
                        .collect();
                    if !mine.is_empty() {
                        text.push_str("\n--dsh-web--\n");
                        text.push_str(&mine.join("\n"));
                    }
                }
            }
        }
    }

    let hint: Option<String> = if text.contains("Cannot find module") || text.contains("MODULE_NOT_FOUND") {
        let missing = text
            .lines()
            .find(|l| l.contains("Cannot find module"))
            .map(|l| l.trim().trim_start_matches("Error: ").to_string())
            .unwrap_or_default();
        Some(format!("程序文件树缺少模块（{missing}）。程序目录可能损坏，建议升级/重装该实例。"))
    } else if text.contains("fs_ext.node") {
        Some("fs-ext 原生模块缺失（上游便携包未携带编译产物，session 持久化入口加载失败）。可在安全中心一键修复。".into())
    } else if text.contains("did not activate") || text.contains("waiting for service") {
        Some("插件加载 pending（webServer 等服务缺失），疑似插件或 bundles 损坏。建议「安全启动」或一键安全恢复。".into())
    } else if text.contains("EADDRINUSE") {
        Some("端口被占用：可能有另一个实例/进程占用了端口，稍后重试或重启机器。".into())
    } else {
        None
    };

    let base = format!("实例进程在启动后 {secs}s 内退出（exit {code}）");
    match hint {
        Some(h) => format!("{base}。诊断：{h}"),
        None => {
            // 壳走得多远（sidecar ready = 布局修复生效；tray ready = 后半程）
            let stage = if text.contains("sidecar ready") {
                if text.contains("tray ready") || text.contains("serve /loading") {
                    "壳已拉起 sidecar 并进入加载阶段"
                } else {
                    "壳已拉起 sidecar"
                }
            } else {
                "壳尚未拉起 sidecar"
            };
            let av = if secs <= 8 {
                "。若为本实例安装后首次执行，也可能是安全软件扫描拦截，重试一次通常即可"
            } else {
                ""
            };
            format!(
                "{base}。已确认到 {stage}，未捕获到已知错误签名{av}；可查看 launcher-shell.log 与实例日志目录排查。"
            )
        }
    }
}

pub fn stop(state: &App, id: &str) -> Result<(), String> {
    let inst = find_instance(state, id)?;
    let pid = inst.last_pid;
    // EAC 的退出流程会把 manifest bundles 清空（v4Lite 缺陷），杀进程前是
    // 快照运行期（健康）bundles 的最后机会，供下次启动守卫补回。
    crate::plugins::snapshot_bundles_now(state, id);
    if let Some(child) = state.children.lock().unwrap().remove(id) {
        let mut child = child;
        let _ = child.kill();
    }
    if let Some(p) = pid {
        if util::pid_alive(p) {
            util::kill_tree(p)?;
        }
    }
    // 兜底：部分运行时（如 Tauri 多进程）的辅助进程会脱离主进程树，
    // 按可执行文件路径前缀清理，确保实例完全停止。
    util::kill_by_exe_dir(&inst.app_dir)?;
    let mut cfg = state.cfg.lock().unwrap();
    if let Some(r) = cfg.instances.iter_mut().find(|i| i.id == id) {
        r.last_pid = None;
    }
    drop(cfg);
    let snapshot = find_instance(state, id)?;
    write_instance_manifest(&snapshot);
    Ok(())
}

pub fn delete(state: &App, id: &str) -> Result<(), String> {
    if is_running(state, id) {
        return Err("实例正在运行，请先停止".into());
    }
    let inst = find_instance(state, id)?;
    if inst.origin == "imported" {
        return Err("导入的实例由启动器接管，不会删除你的文件；请使用「移除记录」".into());
    }
    util::remove_dir_all_force(&inst.dir)?;
    let mut cfg = state.cfg.lock().unwrap();
    cfg.instances.retain(|i| i.id != id);
    drop(cfg);
    state.persist()
}

pub fn rename(state: &App, id: &str, name: &str) -> Result<(), String> {
    let clean = util::sanitize_name(name);
    let mut cfg = state.cfg.lock().unwrap();
    if let Some(r) = cfg.instances.iter_mut().find(|i| i.id == id) {
        r.name = clean;
    }
    drop(cfg);
    let inst = find_instance(state, id)?;
    write_instance_manifest(&inst);
    state.persist()
}

pub fn instance_size(state: &App, id: &str) -> Result<u64, String> {
    let inst = find_instance(state, id)?;
    Ok(util::dir_size(&inst.dir))
}

/// 重建缺失的实例记录（launcher.json 自描述恢复）
pub fn adopt_orphan_manifests(state: &App) {
    let root = state.cfg.lock().unwrap().settings.instance_root.clone();
    let Ok(rd) = std::fs::read_dir(&root) else { return };
    let mut known: Vec<PathBuf> = {
        let cfg = state.cfg.lock().unwrap();
        cfg.instances.iter().map(|i| i.dir.clone()).collect()
    };
    let mut changed = false;
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let mf = p.join("launcher.json");
        if !mf.exists() {
            continue;
        }
        if known.contains(&p) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&mf) {
            if let Ok(mut inst) = serde_json::from_str::<InstanceMeta>(&text) {
                if inst.dir != p {
                    // 目录被移动过：重算内部路径
                    inst.dir = p.clone();
                    inst.app_dir = p.join("app");
                    inst.dsh_home = p.join("dsh-home");
                    inst.exe_path = util::find_main_exe(&inst.app_dir);
                }
                inst.status = InstanceStatus::Ready;
                known.push(p);
                state.cfg.lock().unwrap().instances.push(inst);
                changed = true;
            }
        }
    }
    if changed {
        let _ = state.persist();
    }
}

// ---------- 本地实例导入 ----------

/// 导入探针结果：前端选择目录后先探测再确认
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProbe {
    pub ok: bool,
    pub reason: String,
    pub dir: PathBuf,
    pub exe: Option<PathBuf>,
    /// full / lite / unknown
    pub edition: String,
    pub version: String,
    pub suggested_name: String,
    pub dsh_home_exists: bool,
}

/// 探测一个目录（或 exe 文件）是否可作为可导入的 EAC 实例
pub fn probe_import(path: &str) -> ImportProbe {
    let mut p = PathBuf::from(path);
    if p.is_file() {
        p = p.parent().map(|x| x.to_path_buf()).unwrap_or(p);
    }
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "导入实例".into());
    let mut probe = ImportProbe {
        ok: false,
        reason: String::new(),
        dir: p.clone(),
        exe: None,
        edition: "unknown".into(),
        version: String::new(),
        suggested_name: name,
        dsh_home_exists: p.join("dsh-home").is_dir(),
    };
    let Some(exe) = util::find_main_exe(&p) else {
        probe.reason = "目录顶层未找到可执行文件（需为 EAC 壳 exe 所在目录）".into();
        return probe;
    };
    let exe_l = exe.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    let is_lite = exe_l.contains("lite") || p.join("resources").join("app").is_dir();
    let is_full = p.join("dsh-desktop").is_dir() || p.join(".dsh-portable").exists();
    if !is_lite && !is_full {
        probe.reason = "未识别出 EAC 布局（缺少 dsh-desktop/ 或 resources/app/）".into();
        return probe;
    }
    let edition = if is_lite { "lite" } else { "full" };
    let version = read_layout_version(&p, edition).unwrap_or_default();
    probe.ok = true;
    probe.exe = Some(exe);
    probe.edition = edition.into();
    probe.version = version;
    probe.reason = "可以导入".into();
    probe
}

/// 读取布局内的版本号：full → dsh-desktop/package.json；lite → resources/app/package.json
fn read_layout_version(dir: &Path, edition: &str) -> Option<String> {
    let rel = if edition == "lite" {
        PathBuf::from("resources").join("app").join("package.json")
    } else {
        PathBuf::from("dsh-desktop").join("package.json")
    };
    let text = std::fs::read_to_string(dir.join(&rel)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["version"].as_str().map(String::from)
}

/// 导入本地实例：原地接管，不移动、不复制、不改用户文件（launcher.json 写入实例目录）。
/// dsh_home 默认 <dir>/dsh-home（已存在则沿用，绝不初始化覆盖）。
pub fn import_instance(state: &App, path: &str, name: Option<String>) -> Result<InstanceMeta, String> {
    let probe = probe_import(path);
    if !probe.ok {
        return Err(probe.reason);
    }
    let dir = probe.dir.clone();
    let dup = {
        let cfg = state.cfg.lock().unwrap();
        cfg.instances.iter().any(|i| i.dir == dir)
    };
    if dup {
        return Err("该目录已被注册为实例".into());
    }
    let id = util::gen_id()[..10].to_string();
    let display = match name {
        Some(n) if !util::sanitize_name(&n).is_empty() => util::sanitize_name(&n),
        _ => util::sanitize_name(&probe.suggested_name),
    };
    let inst = InstanceMeta {
        id: id.clone(),
        name: display,
        edition: probe.edition.clone(),
        version: probe.version.clone(),
        tag: if probe.version.is_empty() {
            "本地导入".into()
        } else {
            format!("v{}", probe.version)
        },
        dir: dir.clone(),
        app_dir: dir.clone(),
        dsh_home: dir.join("dsh-home"),
        exe_path: probe.exe.clone(),
        status: InstanceStatus::Ready,
        error_message: None,
        created_at: util::now_ms(),
        last_launched_at: None,
        launch_count: 0,
        last_pid: None,
        last_good_bundles: Vec::new(),
        origin: "imported".into(),
        fail_streak: 0,
        last_fail_reason: None,
        update_available: None,
        quarantine: Vec::new(),
    };
    std::fs::create_dir_all(&inst.dsh_home).map_err(|e| format!("创建数据目录失败: {e}"))?;
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.instances.insert(0, inst.clone());
    }
    state.persist()?;
    write_instance_manifest(&inst);
    Ok(inst)
}

/// 移除导入实例的记录（绝不删除用户文件），同时清掉目录里的 launcher.json 防止再被收养
pub fn unregister_instance(state: &App, id: &str) -> Result<(), String> {
    let inst = find_instance(state, id)?;
    if is_running(state, id) {
        return Err("实例正在运行，请先停止".into());
    }
    let _ = std::fs::remove_file(inst.dir.join("launcher.json"));
    let mut cfg = state.cfg.lock().unwrap();
    cfg.instances.retain(|i| i.id != id);
    drop(cfg);
    state.persist()
}

#[cfg(test)]
mod import_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 构造一个完整版便携布局：exe + dsh-desktop/package.json + sidecar 脚本
    fn fake_full_layout(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eac-import-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("dsh-desktop")).unwrap();
        fs::create_dir_all(dir.join("sidecar")).unwrap();
        fs::write(dir.join("dsh-eac-shell.exe"), b"MZ").unwrap();
        fs::write(
            dir.join("dsh-desktop").join("package.json"),
            r#"{"name":"dsh-desktop","version":"5.3.6"}"#,
        )
        .unwrap();
        fs::write(dir.join("sidecar").join("server.js"), b"").unwrap();
        fs::write(dir.join("sidecar").join("rescue-integration.js"), b"").unwrap();
        dir
    }

    #[test]
    fn probe_recognizes_full_portable_layout() {
        let dir = fake_full_layout("probe");
        let p = probe_import(dir.to_str().unwrap());
        assert!(p.ok, "便携布局应可导入: {}", p.reason);
        assert_eq!(p.edition, "full");
        assert_eq!(p.version, "5.3.6");
        assert!(p.exe.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_rejects_unrelated_directory() {
        let dir = std::env::temp_dir().join(format!("eac-import-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("readme.txt"), b"not an eac").unwrap();
        let p = probe_import(dir.to_str().unwrap());
        assert!(!p.ok);
        let _ = fs::remove_dir_all(&dir);
    }

    /// exe 文件路径（而非目录）也能探测
    #[test]
    fn probe_accepts_exe_file_path() {
        let dir = fake_full_layout("exefile");
        let exe = dir.join("dsh-eac-shell.exe");
        let p = probe_import(exe.to_str().unwrap());
        assert!(p.ok, "exe 文件路径应可导入: {}", p.reason);
        assert_eq!(p.dir, dir);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod launch_tests {
    use crate::store::App;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    /// 真机手动验证：DSH_EAC_VERIFY_HOME=<实例 dsh-home> cargo test -- --ignored
    /// launch_stop_real_instance_manual -- --nocapture
    /// 走真实 launch()（启动守卫 + 后台快照线程）与 stop()（停前快照），
    /// 断言健康快照在启动后被采集落盘。
    #[test]
    #[ignore]
    fn launch_stop_real_instance_manual() {
        let Ok(home) = std::env::var("DSH_EAC_VERIFY_HOME") else {
            eprintln!("跳过：未设置 DSH_EAC_VERIFY_HOME");
            return;
        };
        let state = Arc::new(App::new().expect("初始化状态失败"));
        let inst = {
            let cfg = state.cfg.lock().unwrap();
            cfg.instances
                .iter()
                .find(|i| i.dsh_home == PathBuf::from(&home))
                .cloned()
                .expect("未在启动器配置中找到该实例")
        };
        let pid = crate::instance::launch_opts(&state, None, &inst.id, false).expect("launch 失败");
        eprintln!("launch pid={pid}");

        // 等后台快照线程采集（manifest 已非空 → 见非空后静置 15s 落盘）
        let mut captured = Vec::new();
        for _ in 0..30 {
            std::thread::sleep(Duration::from_secs(3));
            captured = {
                let cfg = state.cfg.lock().unwrap();
                cfg.instances
                    .iter()
                    .find(|i| i.id == inst.id)
                    .map(|i| i.last_good_bundles.clone())
                    .unwrap_or_default()
            };
            if !captured.is_empty() {
                break;
            }
        }
        eprintln!("last_good_bundles = {captured:?}");
        assert!(
            captured.contains(&"@deepseek-ai/dsh-base".to_string()),
            "健康快照必须包含基础 bundles"
        );

        crate::instance::stop(&state, &inst.id).expect("stop 失败");
        assert!(!crate::instance::is_running(&state, &inst.id), "实例应已停止");
        eprintln!("stop 完成，循环验证通过");
    }
}

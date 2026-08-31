// 实例生命周期：启动 / 停止 / 运行状态 / 删除 / 重命名 / 体积统计。

use crate::model::{InstanceMeta, InstanceStatus};
use crate::store::{write_instance_manifest, App};
use crate::util;
use std::path::PathBuf;

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

pub fn launch(state: &App, id: &str) -> Result<u32, String> {
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

    // 启动前守卫：修复被 EAC 退出流程清空的基础 bundles
    crate::plugins::repair_bundles_before_launch(&inst);

    let mut cmd = std::process::Command::new(&exe);
    cmd.current_dir(&workdir).env("DSH_HOME", &inst.dsh_home);
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
    // 采集本次健康 bundles 快照（dsh web 已随实例拉起）
    if let Ok(bundles) = crate::plugins::capture_good_bundles(state, id) {
        if !bundles.is_empty() {
            let mut cfg = state.cfg.lock().unwrap();
            if let Some(r) = cfg.instances.iter_mut().find(|r| r.id == id) {
                r.last_good_bundles = bundles;
            }
            drop(cfg);
            let _ = state.persist();
        }
    }
    let snapshot = find_instance(state, id)?;
    write_instance_manifest(&snapshot);
    let _ = state.persist();
    Ok(pid)
}

pub fn stop(state: &App, id: &str) -> Result<(), String> {
    let inst = find_instance(state, id)?;
    let pid = inst.last_pid;
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

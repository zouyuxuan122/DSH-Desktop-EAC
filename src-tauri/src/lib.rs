// Tauri 命令层：把后端各模块暴露给前端。

mod install;
mod instance;
mod model;
mod net;
mod plugins;
mod store;
mod util;

use install::spawn_install_pipeline;
use model::{Config, EditionInfo, InstanceMeta, InstanceStatus, Settings, TaskInfo};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use store::App;
use tauri::{AppHandle, Manager, State};

type St<'a> = State<'a, Arc<App>>;

/// 该实例是否有进行中的任务（下载/插件），防重复触发与竞态删除
fn has_active_task(state: &App, instance_id: &str) -> bool {
    state
        .tasks
        .lock()
        .unwrap()
        .values()
        .any(|t| t.info.lock().unwrap().instance_id.as_deref() == Some(instance_id)
            && t.info.lock().unwrap().state == "active")
}

#[tauri::command]
fn get_state(state: St) -> Result<Config, String> {
    instance::reap(&state);
    Ok(state.cfg.lock().unwrap().clone())
}

#[tauri::command]
fn set_settings(state: St, settings: Settings) -> Result<(), String> {
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.settings = settings;
    }
    state.persist()
}

#[tauri::command]
async fn resolve_editions(state: St<'_>) -> Result<Vec<EditionInfo>, String> {
    let mirror = state.cfg.lock().unwrap().settings.mirror_prefix.clone();
    // 缓存 10 分钟
    {
        let cache = state.edition_cache.lock().unwrap();
        if let Some((at, list)) = cache.as_ref() {
            if util::now_ms().saturating_sub(*at) < 10 * 60 * 1000 && !list.is_empty() {
                return Ok(list.clone());
            }
        }
    }
    let list = net::resolve_editions(&mirror).await?;
    *state.edition_cache.lock().unwrap() = Some((util::now_ms(), list.clone()));
    Ok(list)
}

#[tauri::command]
fn create_instance(
    app: AppHandle,
    state: St,
    name: String,
    edition: String,
    info: EditionInfo,
) -> Result<InstanceMeta, String> {
    let clean = util::sanitize_name(&name);
    if clean.is_empty() {
        return Err("实例名称不能为空".into());
    }
    let (root, mirror_prefix_check) = {
        let cfg = state.cfg.lock().unwrap();
        (cfg.settings.instance_root.clone(), cfg.settings.mirror_prefix.is_empty())
    };
    let _ = mirror_prefix_check;

    let id = util::gen_id()[..10].to_string();
    // 目录名用纯 ASCII：EAC 内部进程对含中文的 DSH_HOME 存在 GBK 误解析（上游缺陷），
    // ASCII 目录名可彻底规避；显示名不受影响。
    let dir = root.join(format!("eac-instance-{id}"));
    if dir.exists() {
        return Err("目标目录已存在，请换个名字".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建实例目录失败: {e}"))?;

    let meta = InstanceMeta {
        id: id.clone(),
        name: clean,
        edition: edition.clone(),
        version: info
            .tag
            .trim_start_matches('v')
            .trim_end_matches("-lite")
            .to_string(),
        tag: info.tag.clone(),
        dir: dir.clone(),
        app_dir: dir.join("app"),
        dsh_home: dir.join("dsh-home"),
        exe_path: None,
        status: InstanceStatus::Installing,
        error_message: None,
        created_at: util::now_ms(),
        last_launched_at: None,
        launch_count: 0,
        last_pid: None,
        last_good_bundles: Vec::new(),
    };
    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.instances.insert(0, meta.clone());
    }
    state.persist()?;
    spawn_install_pipeline(
        app,
        Arc::clone(&state),
        meta.clone(),
        info.asset.url.clone(),
        info.asset.name.clone(),
        info.asset.size,
        info.sha_url.clone(),
    );
    Ok(meta)
}

#[tauri::command]
async fn retry_instance_install(app: AppHandle, state: St<'_>, id: String) -> Result<(), String> {
    if has_active_task(&state, &id) {
        return Err("该实例已有进行中的任务，请稍候".into());
    }
    let inst = instance::find_instance(&state, &id)?;
    let mirror = state.cfg.lock().unwrap().settings.mirror_prefix.clone();
    // 优先用缓存目录；缓存为空则实时解析
    let info = {
        let cache = state.edition_cache.lock().unwrap();
        cache
            .as_ref()
            .and_then(|(_, list)| list.iter().find(|e| e.edition == inst.edition).cloned())
    };
    let info = match info {
        Some(i) => i,
        None => {
            let list = net::resolve_editions(&mirror).await?;
            list.into_iter()
                .find(|e| e.edition == inst.edition)
                .ok_or_else(|| "上游未找到该版本的可用产物".to_string())?
        }
    };
    install::retry_install(
        app,
        Arc::clone(&state),
        &inst,
        (info.asset.url.clone(), info.asset.name.clone(), info.asset.size),
        info.sha_url.clone(),
    );
    Ok(())
}

#[tauri::command]
fn get_tasks(state: St) -> Vec<TaskInfo> {
    state
        .tasks
        .lock()
        .unwrap()
        .values()
        .map(|t| t.info.lock().unwrap().clone())
        .collect()
}

#[tauri::command]
fn cancel_task(state: St, id: String) -> Result<(), String> {
    if let Some(t) = state.tasks.lock().unwrap().get(&id) {
        t.cancel.store(true, Ordering::Relaxed);
        Ok(())
    } else {
        Err("任务不存在".into())
    }
}

#[tauri::command]
fn clear_task(state: St, id: String) -> Result<(), String> {
    let mut tasks = state.tasks.lock().unwrap();
    if let Some(t) = tasks.get(&id) {
        if t.info.lock().unwrap().state == "active" {
            return Err("任务进行中，无法移除".into());
        }
    }
    tasks.remove(&id);
    Ok(())
}

#[tauri::command]
fn launch_instance(state: St, id: String) -> Result<u32, String> {
    instance::launch(&state, &id)
}

#[tauri::command]
fn stop_instance(state: St, id: String) -> Result<(), String> {
    instance::stop(&state, &id)
}

#[tauri::command]
fn is_instance_running(state: St, id: String) -> Result<bool, String> {
    Ok(instance::is_running(&state, &id))
}

#[tauri::command]
fn delete_instance(state: St, id: String) -> Result<(), String> {
    if has_active_task(&state, &id) {
        return Err("实例任务进行中，请先取消任务再删除".into());
    }
    instance::delete(&state, &id)
}

#[tauri::command]
fn rename_instance(state: St, id: String, name: String) -> Result<(), String> {
    instance::rename(&state, &id, &name)?;
    Ok(())
}

#[tauri::command]
fn instance_size(state: St, id: String) -> Result<u64, String> {
    instance::instance_size(&state, &id)
}

#[tauri::command]
fn list_plugins(state: St, id: String) -> Result<Vec<model::InstalledPlugin>, String> {
    plugins::list_installed(&state, &id)
}

#[tauri::command]
async fn fetch_market(state: St<'_>, force: Option<bool>) -> Result<Vec<model::MarketPlugin>, String> {
    plugins::fetch_market(&state, force.unwrap_or(false)).await
}

#[tauri::command]
fn install_plugin(app: AppHandle, state: St, id: String, spec: String) -> Result<String, String> {
    if has_active_task(&state, &id) {
        return Err("该实例已有进行中的任务，请稍候".into());
    }
    let task_id = format!("plug-{}-{}", id, &util::gen_id()[..8]);
    let label = format!("安装 {spec}");
    let info = install::new_task_info(&task_id, "plugin", &label, Some(id.clone()));
    {
        let mut tasks = state.tasks.lock().unwrap();
        tasks.insert(
            task_id.clone(),
            Arc::new(store::Task {
                cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                info: std::sync::Mutex::new(info),
            }),
        );
    }
    let state2 = Arc::clone(&state);
    let task_id2 = task_id.clone();
    let id2 = id.clone();
    let spec2 = spec.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = plugins::install_sync(&state2, &id2, &spec2, |stage| {
            state2.update_task(&app, &task_id2, |t| {
                t.message = stage.to_string();
            });
        });
        let (st, msg) = match &result {
            Ok(v) => ("done", format!("安装完成 · {v}")),
            Err(e) => ("error", e.clone()),
        };
        state2.update_task(&app, &task_id2, |t| {
            t.state = st.into();
            t.message = msg.clone();
        });
    });
    Ok(task_id)
}

#[tauri::command]
fn uninstall_plugin(app: AppHandle, state: St, id: String, pkg: String) -> Result<String, String> {
    if has_active_task(&state, &id) {
        return Err("该实例已有进行中的任务，请稍候".into());
    }
    let task_id = format!("plug-{}-{}", id, &util::gen_id()[..8]);
    let label = format!("卸载 {pkg}");
    let info = install::new_task_info(&task_id, "plugin", &label, Some(id.clone()));
    {
        let mut tasks = state.tasks.lock().unwrap();
        tasks.insert(
            task_id.clone(),
            Arc::new(store::Task {
                cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                info: std::sync::Mutex::new(info),
            }),
        );
    }
    let state2 = Arc::clone(&state);
    let task_id2 = task_id.clone();
    let id2 = id.clone();
    let pkg2 = pkg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = plugins::uninstall_sync(&state2, &id2, &pkg2);
        let (st, msg) = match &result {
            Ok(_) => ("done", "卸载完成".to_string()),
            Err(e) => ("error", e.clone()),
        };
        state2.update_task(&app, &task_id2, |t| {
            t.state = st.into();
            t.message = msg.clone();
        });
    });
    Ok(task_id)
}

#[tauri::command]
fn toggle_plugin(state: St, id: String, pkg: String, disabled: bool) -> Result<(), String> {
    plugins::toggle_plugin(&state, &id, &pkg, disabled)
}

#[tauri::command]
fn app_dirs(state: St) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "dataDir": state.data_dir,
        "cacheDir": state.cache_dir,
    }))
}

pub fn run() {
    let app_state = match App::new() {
        Ok(a) => Arc::new(a),
        Err(e) => {
            eprintln!("初始化失败: {e}");
            std::process::exit(1);
        }
    };
    let for_single = Arc::clone(&app_state);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = &for_single;
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_settings,
            resolve_editions,
            create_instance,
            retry_instance_install,
            get_tasks,
            cancel_task,
            clear_task,
            launch_instance,
            stop_instance,
            is_instance_running,
            delete_instance,
            rename_instance,
            instance_size,
            list_plugins,
            fetch_market,
            install_plugin,
            uninstall_plugin,
            toggle_plugin,
            app_dirs,
        ])
        .setup(|app| {
            let state = app.state::<Arc<App>>();
            instance::adopt_orphan_manifests(&state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 运行失败");
}

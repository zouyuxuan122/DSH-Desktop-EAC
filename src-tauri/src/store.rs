// 运行时状态：配置持久化、任务表、运行中的子进程。

use crate::model::{Config, InstanceMeta, TaskInfo};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct Task {
    pub cancel: Arc<AtomicBool>,
    pub info: Mutex<TaskInfo>,
}

pub struct App {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub cfg: Mutex<Config>,
    pub tasks: Mutex<HashMap<String, Arc<Task>>>,
    /// 实例 id -> 启动时的子进程
    pub children: Mutex<HashMap<String, std::process::Child>>,
    /// 版本目录缓存（10 分钟）
    pub edition_cache: std::sync::Mutex<Option<(u64, Vec<crate::model::EditionInfo>)>>,
}

impl App {
    pub fn new() -> Result<Self, String> {
        let data_dir = dirs::config_dir()
            .ok_or("无法定位应用数据目录")?
            .join("dsh-eac-launcher");
        let cache_dir = data_dir.join("cache");
        std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
        let cfg = load_config(&data_dir)?;
        Ok(Self {
            data_dir,
            cache_dir,
            cfg: Mutex::new(cfg),
            tasks: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            edition_cache: std::sync::Mutex::new(None),
        })
    }

    pub fn save_config(&self, cfg: &Config) -> Result<(), String> {
        let path = self.data_dir.join("config.json");
        let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("写入配置失败: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("提交配置失败: {e}"))?;
        Ok(())
    }

    pub fn persist(&self) -> Result<(), String> {
        let cfg = self.cfg.lock().unwrap().clone();
        self.save_config(&cfg)
    }

    pub fn emit_task(&self, app: &AppHandle, info: &TaskInfo) {
        let _ = app.emit("task:update", info);
    }

    pub fn update_task<F: FnOnce(&mut TaskInfo)>(&self, app: &AppHandle, id: &str, f: F) {
        let tasks = self.tasks.lock().unwrap();
        if let Some(task) = tasks.get(id) {
            let mut info = task.info.lock().unwrap();
            f(&mut info);
            let snapshot = info.clone();
            drop(info);
            drop(tasks);
            self.emit_task(app, &snapshot);
        }
    }
}

fn load_config(data_dir: &std::path::Path) -> Result<Config, String> {
    let path = data_dir.join("config.json");
    if !path.exists() {
        return Ok(Config::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    match serde_json::from_str::<Config>(&text) {
        Ok(cfg) => Ok(cfg),
        Err(e) => {
            // 备份坏配置，避免一条脏数据毁掉整个启动器
            let _ = std::fs::copy(&path, path.with_extension("json.bak"));
            eprintln!("配置解析失败已备份: {e}");
            Ok(Config::default())
        }
    }
}

/// 实例元数据落盘到实例目录（自描述，注册表损坏时仍可恢复）
pub fn write_instance_manifest(inst: &InstanceMeta) {
    let path = inst.dir.join("launcher.json");
    if let Ok(json) = serde_json::to_string_pretty(inst) {
        let _ = std::fs::write(path, json);
    }
}

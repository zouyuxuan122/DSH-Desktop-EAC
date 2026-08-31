// 实例创建流水线：下载（断点续传/SHA256 校验/取消）→ 解压或静默安装 → 就绪。

use crate::model::{InstanceMeta, InstanceStatus, TaskInfo};
use crate::net;
use crate::store::{write_instance_manifest, App, Task};
use crate::util;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const CHUNK: usize = 256 * 1024;

pub fn new_task_info(id: &str, kind: &str, label: &str, instance_id: Option<String>) -> TaskInfo {
    TaskInfo {
        id: id.into(),
        kind: kind.into(),
        label: label.into(),
        state: "active".into(),
        received: 0,
        total: 0,
        speed_bps: 0,
        message: "准备中".into(),
        instance_id,
        stage: "download".into(),
    }
}

/// 下载单个文件（支持 .part 续传与取消）。返回 sha256（下载内容）。
async fn download_file(
    app: &AppHandle,
    state: &App,
    task_id: &str,
    url: &str,
    dest: &Path,
    expected_total: u64,
) -> Result<String, String> {
    let client = net::download_client()?;
    let part = dest.with_extension("part");
    // 最终文件已存在且大小一致：直接复用缓存
    if dest.exists() {
        let len = dest.metadata().map(|m| m.len()).unwrap_or(0);
        if expected_total == 0 || len == expected_total {
            state.update_task(app, task_id, |t| {
                t.total = expected_total.max(len);
                t.received = expected_total.max(len);
                t.message = "命中本地缓存，跳过下载".into();
            });
            return hash_file(dest);
        }
        let _ = std::fs::remove_file(dest);
    }
    let mut offset: u64 = 0;
    if part.exists() {
        offset = part.metadata().map(|m| m.len()).unwrap_or(0);
        if expected_total > 0 && offset >= expected_total && expected_total > 1024 {
            // 已有完整缓存
            std::fs::rename(&part, dest).map_err(|e| format!("使用缓存失败: {e}"))?;
            return hash_file(dest);
        }
    }

    let mut req = client.get(url);
    if offset > 0 {
        req = req.header("Range", format!("bytes={offset}-"));
    }
    let resp = req.send().await.map_err(|e| format!("下载请求失败: {e}"))?;
    if !(resp.status().is_success() || resp.status().as_u16() == 206) {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }
    let resumed = resp.status().as_u16() == 206 && offset > 0;
    let total = resp
        .content_length()
        .map(|l| if resumed { l + offset } else { l })
        .unwrap_or(expected_total);
    state.update_task(app, task_id, |t| {
        t.total = total;
        t.message = if resumed {
            format!("续传 {} / {}", util::format_bytes(offset), util::format_bytes(total))
        } else {
            format!("下载 {}", util::format_bytes(total))
        };
    });

    let mut out = if resumed {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|e| format!("打开续传文件失败: {e}"))?
    } else {
        std::fs::File::create(&part).map_err(|e| format!("创建下载文件失败: {e}"))?
    };
    let mut received = if resumed { offset } else { 0 };
    let mut hasher = Sha256::new();
    // 续传时哈希需含已有部分
    if resumed {
        let mut f = std::fs::File::open(&part).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }

    let cancel = {
        let tasks = state.tasks.lock().unwrap();
        tasks.get(task_id).map(|t| t.cancel.clone())
    };
    let Some(cancel) = cancel else {
        return Err("任务已取消".into());
    };

    let mut stream = resp.bytes_stream();
    let mut last_tick = std::time::Instant::now();
    let mut last_received = received;
    #[allow(unused_assignments)]
    let mut speed = 0u64;
    while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
        if cancel.load(Ordering::Relaxed) {
            return Err("__CANCELLED__".into());
        }
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        hasher.update(&chunk);
        out.write_all(&chunk).map_err(|e| format!("写盘失败: {e}"))?;
        received += chunk.len() as u64;
        let now = std::time::Instant::now();
        if now.duration_since(last_tick).as_millis() >= 400 {
            let dt = now.duration_since(last_tick).as_secs_f64();
            speed = ((received - last_received) as f64 / dt.max(0.001)) as u64;
            last_tick = now;
            last_received = received;
            let rec = received;
            state.update_task(app, task_id, |t| {
                t.received = rec;
                t.total = total;
                t.speed_bps = speed;
                t.message = format!(
                    "{} / {} · {}/s",
                    util::format_bytes(rec),
                    util::format_bytes(total),
                    util::format_bytes(speed)
                );
            });
        }
    }
    out.sync_all().ok();
    let rec = received;
    state.update_task(app, task_id, |t| {
        t.received = rec;
        t.total = total.max(rec);
    });
    std::fs::rename(&part, dest).map_err(|e| format!("完成下载失败: {e}"))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 创建实例任务（异步流水线）。调用前已在注册表中登记 installing 状态的实例。
#[allow(clippy::too_many_arguments)]
pub fn spawn_install_pipeline(app: AppHandle, state: Arc<App>, inst: InstanceMeta, asset_url: String, asset_name: String, asset_size: u64, sha_url: Option<String>) {
    let task_id = format!("inst-{}", inst.id);
    let info = new_task_info(&task_id, "instance", &format!("安装 {name} · {v}", name = inst.name, v = inst.version), Some(inst.id.clone()));
    {
        let mut tasks = state.tasks.lock().unwrap();
        tasks.insert(
            task_id.clone(),
            Arc::new(Task {
                cancel: Arc::new(AtomicBool::new(false)),
                info: std::sync::Mutex::new(info),
            }),
        );
    }
    tauri::async_runtime::spawn(async move {
        let result = run_pipeline(&app, &state, &inst, &task_id, &asset_url, &asset_name, asset_size, sha_url.as_deref()).await;
        let state_str = match &result {
            Ok(_) => "done",
            Err(e) if e == "__CANCELLED__" => "cancelled",
            Err(_) => "error",
        };
        let msg = match &result {
            Ok(_) => "安装完成".to_string(),
            Err(e) if e == "__CANCELLED__" => "已取消".to_string(),
            Err(e) => e.clone(),
        };
        state.update_task(&app, &task_id, |t| {
            t.state = state_str.into();
            t.message = msg.clone();
            t.speed_bps = 0;
        });

        // 更新注册表
        let mut cfg = state.cfg.lock().unwrap().clone();
        if let Some(rec) = cfg.instances.iter_mut().find(|i| i.id == inst.id) {
            match &result {
                Ok(_) => {
                    rec.status = InstanceStatus::Ready;
                    rec.error_message = None;
                    rec.exe_path = crate::util::find_main_exe(&rec.app_dir);
                }
                Err(e) if e != "__CANCELLED__" => {
                    rec.status = InstanceStatus::Error;
                    rec.error_message = Some(e.clone());
                }
                _ => {}
            }
        }
        if let Err(e) = state.save_config(&cfg) {
            eprintln!("保存注册表失败: {e}");
        }
        if let Some(rec) = state.cfg.lock().unwrap().instances.iter().find(|i| i.id == inst.id) {
            write_instance_manifest(rec);
            if rec.status == InstanceStatus::Ready {
                let _ = app.emit("instance:ready", rec.id.clone());
            } else if rec.status == InstanceStatus::Error {
                let _ = app.emit("instance:error", rec.id.clone());
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
async fn run_pipeline(
    app: &AppHandle,
    state: &App,
    inst: &InstanceMeta,
    task_id: &str,
    asset_url: &str,
    asset_name: &str,
    asset_size: u64,
    sha_url: Option<&str>,
) -> Result<(), String> {
    let mirror = state.cfg.lock().unwrap().settings.mirror_prefix.clone();
    std::fs::create_dir_all(&inst.dir).map_err(|e| format!("创建实例目录失败: {e}"))?;
    std::fs::create_dir_all(&inst.dsh_home).map_err(|e| format!("创建数据目录失败: {e}"))?;
    write_instance_manifest(inst);

    // ---- 下载 ----
    state.update_task(app, task_id, |t| {
        t.stage = "download".into();
        t.message = "连接上游".into();
    });
    let cache_path = state.cache_dir.join(asset_name);
    let mut expected: Option<String> = None;
    if let Some(sha_url) = sha_url {
        match net::fetch_sha256sums(sha_url, &mirror).await {
            Ok(map) => {
                expected = map.get(asset_name).cloned();
            }
            Err(e) => eprintln!("[install] 校验文件获取失败（跳过校验）: {e}"),
        }
    }
    let final_url = net::apply_mirror(asset_url, &mirror);
    let hash = download_file(app, state, task_id, &final_url, &cache_path, asset_size).await?;
    if let Some(exp) = &expected {
        if exp != &hash {
            let _ = std::fs::remove_file(&cache_path);
            return Err(format!(
                "SHA256 校验失败：期望 {}，实际 {}（已删除损坏文件，可重试）",
                &exp[..16],
                &hash[..16]
            ));
        }
        state.update_task(app, task_id, |t| {
            t.message = "SHA256 校验通过".into();
        });
    }

    // ---- 安装 ----
    let name_l = asset_name.to_ascii_lowercase();
    let app_dir = inst.app_dir.clone();
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("创建程序目录失败: {e}"))?;
    if name_l.ends_with(".zip") {
        state.update_task(app, task_id, |t| {
            t.stage = "extract".into();
            t.message = "解压便携包".into();
        });
        let (zip_path, dest, task_id_s) = (cache_path.clone(), app_dir.clone(), task_id.to_string());
        let app2 = app.clone();
        let res = tauri::async_runtime::spawn_blocking(move || {
            util::unzip_to(&zip_path, &dest, |done, total| {
                if done % 500 == 0 || done == total {
                    state_update_extract(&app2, &task_id_s, done, total);
                }
            })
        })
        .await
        .map_err(|e| format!("解压任务失败: {e}"))?;
        res?;
        util::collapse_single_root_dir(&app_dir);
    } else if name_l.ends_with(".exe") {
        // NSIS 静默安装（Lite 等安装包）：
        // NSIS 的 /D= 不接受引号，Rust 对含空格/非 ASCII 路径会自动加引号导致
        // 参数失效，故先安装到 ASCII 无空格暂存目录，再把文件移入实例目录。
        state.update_task(app, task_id, |t| {
            t.stage = "install".into();
            t.message = "运行静默安装（/S）".into();
        });
        wait_nsis(&cache_path, &app_dir).await?;
    } else {
        return Err(format!("不认识的产物类型: {asset_name}"));
    }

    // ---- 发现主程序 ----
    let exe = util::find_main_exe(&app_dir)
        .ok_or_else(|| "安装完成但未找到主程序 exe".to_string())?;
    let _ = std::fs::remove_file(&cache_path);
    state.update_task(app, task_id, |t| {
        t.stage = "done".into();
        t.message = format!("就绪 · {}", exe.file_name().unwrap_or_default().to_string_lossy());
    });
    Ok(())
}

fn state_update_extract(app: &AppHandle, task_id: &str, done: u64, total: u64) {
    let state = app.state::<Arc<App>>();
    state.update_task(app, task_id, |t| {
        t.stage = "extract".into();
        t.received = done;
        t.total = total;
        t.message = format!("解压 {done}/{total} 文件");
    });
}

/// 选一个 ASCII 且无空格的暂存根目录（NSIS /D= 兼容）
fn nsis_staging_root() -> Result<PathBuf, String> {
    let candidates = [
        std::env::temp_dir().join("eac-nsis"),
        PathBuf::from(r"C:\Users\Public\eac-nsis"),
    ];
    for c in candidates {
        if c.to_string_lossy().is_ascii() && !c.to_string_lossy().contains(' ') {
            return Ok(c);
        }
    }
    Err("找不到可用的 ASCII 暂存目录".into())
}

async fn wait_nsis(setup: &Path, dest: &Path) -> Result<(), String> {
    let staging_root = nsis_staging_root()?;
    let staging = staging_root.join(format!("stage-{}", &util::gen_id()[..8]));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("创建暂存目录失败: {e}"))?;

    let dest_s = staging.to_string_lossy().to_string();
    let setup_p = setup.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let st = std::process::Command::new(&setup_p)
            // 无空格 → Rust 不加引号 → NSIS /D= 正常解析
            .args(["/S", &format!("/D={dest_s}")])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        match st {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("安装程序退出码 {:?}", s.code())),
            Err(e) => Err(format!("安装程序启动失败: {e}")),
        }
    })
    .await
    .map_err(|e| format!("安装任务失败: {e}"))??;

    // 移交到实例 app 目录（可能跨卷，退化为复制）；失败时清理暂存
    let copy_result = (|| -> Result<(), String> {
        let entries = std::fs::read_dir(&staging).map_err(|e| e.to_string())?;
        if entries.count() == 0 {
            return Err("安装程序未产出任何文件（可能被安全软件拦截）".into());
        }
        std::fs::create_dir_all(dest).map_err(|e| format!("创建程序目录失败: {e}"))?;
        util::copy_dir_contents(&staging, dest)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    copy_result
}

/// 重新尝试失败/取消的实例安装
pub fn retry_install(app: AppHandle, state: Arc<App>, inst: &InstanceMeta, asset: (String, String, u64), sha_url: Option<String>) {
    let mut inst2 = inst.clone();
    inst2.status = InstanceStatus::Installing;
    inst2.error_message = None;
    {
        let mut cfg = state.cfg.lock().unwrap();
        if let Some(r) = cfg.instances.iter_mut().find(|i| i.id == inst2.id) {
            r.status = InstanceStatus::Installing;
            r.error_message = None;
        }
    }
    let _ = state.persist();
    spawn_install_pipeline(app, state, inst2, asset.0, asset.1, asset.2, sha_url);
}

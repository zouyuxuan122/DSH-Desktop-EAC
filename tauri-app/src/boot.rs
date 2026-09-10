//! 启动编排（main.js boot() 链路移植）+ 守护启动（plugin-guard guardedBoot
//! 的 Rust 循环半边：重试/回滚决策在 Rust，体检/修复/快照原子操作在 sidecar）
//! + 启动失败对话框链（handleBootFailure）+ 余额轮询与插件更新定时器。

use crate::dialog::{DialogIcon, DialogSpec};
use crate::ipc::agent_version_info;
use crate::service::ServiceEvent;
use crate::sidecar::SidecarEvent;
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 创建主窗：无边框、立即显示加载本地 loading 页（提供秒开反馈，随后导航到
/// Web UI），注入 chrome 脚本，挂导航锁定与页面加载跟踪。
pub fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let state: Arc<AppState> = app.state::<Arc<AppState>>().inner().clone();
    let state_for_load = state.clone();
    // V-E：Electron 版 localStorage 迁移脚本（首启一次性注入；幂等 stamp 在
    // ve_migrate 内部维护）。about:blank 阶段 origin 为 null 时脚本内部
    // try/catch 静默跳过，导航到 Web UI origin 后才真正写入。
    let ve_script = crate::ve_migrate::load_migration_script(&state.paths, &state.log);
    let mut builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App(std::path::PathBuf::from("loading.html")),
    )
    .title("DSHEAC AIO")
    .inner_size(1400.0, 900.0)
    .min_inner_size(960.0, 640.0)
    .visible(true)
    .decorations(false);
    builder = builder.initialization_script(include_str!("inject/chrome.js"));
    if let Some(script) = ve_script {
        builder = builder.initialization_script(script);
    }
    builder = builder
        .on_navigation(move |url| {
            // H1 修复语义：origin 精确比较（host+port）；异域 http(s) 一律拦截
            // 并转系统浏览器；本地应用页与内部 scheme 放行。
            let scheme = url.scheme();
            if scheme == "http" || scheme == "https" {
                let web = state.web_url.lock().unwrap().clone();
                let allowed = match &web {
                    Some(w) => same_origin(url.as_str(), w),
                    None => {
                        let host = url.host_str().unwrap_or("");
                        // Before the child process emits its ready URL, only the
                        // built-in Tauri page is trusted. Arbitrary loopback
                        // origins must not gain a navigation/capability window.
                        host == "tauri.localhost"
                    }
                };
                if allowed {
                    return true;
                }
                let target = url.to_string();
                std::thread::spawn(move || {
                    crate::ipc::open_url_external(&target);
                });
                return false;
            }
            true
        })
        .on_page_load(move |win, payload| {
            use tauri::webview::PageLoadEvent::*;
            let state = &state_for_load;
            if matches!(payload.event(), Finished) {
                if let Ok(u) = win.url() {
                    let is_web = state
                        .web_url
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|w| same_origin(u.as_str(), w))
                        .unwrap_or(false);
                    if is_web {
                        state.recovery.note_web_loaded();
                    } else {
                        state.recovery.note_local_page();
                    }
                }
            }
        });
    builder.build()
}

/// origin 精确比较（scheme+host+port）。两端都是本应用产生的 URL，
/// 归一化 authority 字符串即可（含 IPv6 兜底）。
pub fn same_origin(a: &str, b: &str) -> bool {
    fn authority(s: &str) -> Option<String> {
        let (scheme, rest) = s.split_once("://")?;
        let auth = rest.split(['/', '?', '#']).next()?;
        let default_port = if scheme.eq_ignore_ascii_case("https") {
            "443"
        } else {
            "80"
        };
        // 去 userinfo
        let auth = auth.rsplit('@').next().unwrap_or(auth);
        // IPv6 [..]:port
        if let Some(close) = auth.rfind(']') {
            let (h, p) = auth.split_at(close + 1);
            let port = p.strip_prefix(':').unwrap_or(default_port);
            return Some(format!("{}|{}", h.to_lowercase(), port));
        }
        match auth.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => {
                Some(format!("{}|{}", h.to_lowercase(), p))
            }
            _ => Some(format!("{}|{}", auth.to_lowercase(), default_port)),
        }
    }
    match (authority(a), authority(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// 把主窗导航到 Web UI（加载页 → dsh web）并显示。
pub fn navigate_main_to_web(app: &AppHandle, state: &AppState) {
    let url = state.web_url.lock().unwrap().clone();
    let Some(url) = url else { return };
    if let Some(win) = app.get_webview_window("main") {
        // A browser-initiated navigation lets the new kernel's Strict auth
        // cookie survive its initial redirect from the Tauri loading origin.
        match url.parse() {
            Ok(target) => {
                if win.navigate(target).is_err() {
                    state.log.log("boot", "Web UI navigation failed");
                }
            }
            Err(_) => state.log.log("boot", "Invalid Web UI URL"),
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 主窗导航到本地页（loading/recovery）。
pub fn navigate_main_to_local(app: &AppHandle, page: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let js = format!("window.location.replace('/{}');", page);
        let _ = win.eval(&js);
    }
}

/// 统一「重新加载」入口：恢复页走恢复流程，否则普通 reload。菜单与 Ctrl+R 共用。
pub fn reload_main_window(app: &AppHandle) {
    let state: Arc<AppState> = app.state::<Arc<AppState>>().inner().clone();
    if state.recovery.state_of().gave_up {
        state.log.log("recovery", "用户在恢复页触发重新加载");
        state.recovery.retry_now();
        navigate_main_to_web(app, &state);
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("window.location.reload();");
    }
}

// ---------------------------------------------------------------------------
// 服务启动（startAndShow）
// ---------------------------------------------------------------------------

/// 合并 koffi 降级 overlay 与调用方 overlays，拉起服务并把窗口导航过去。
pub fn start_and_show(state: &Arc<AppState>, overlays: &[String]) -> Result<String, String> {
    state.sidecar()?.call("profile.upgradePreflight", json!({}))?;
    let mut merged: Vec<String> = Vec::new();
    if let Some(po) = state.picker_overlay.lock().unwrap().clone() {
        if std::path::Path::new(&po).exists() {
            merged.push(po);
        }
    }
    for p in overlays {
        if !p.is_empty() && std::path::Path::new(p).exists() && !merged.contains(p) {
            merged.push(p.clone());
        }
    }
    let (tx, rx) = mpsc::channel::<ServiceEvent>();
    let (outcome, rx) = crate::service::start_server(&state.paths, &state.log, &merged, 4, tx, rx)?;
    // waitUntilUp：最终确认（JS 版 120s 上限）。
    let port = crate::port::extract_port(&outcome.url);
    crate::service::wait_until_up(port, Duration::from_secs(120))?;
    *state.web_url.lock().unwrap() = Some(outcome.url.clone());
    *state.service.lock().unwrap() = Some(outcome.handle.clone());
    // A user-writable agent overlay may have been rejected and replaced with
    // the bundled kernel by the sidecar health gate. Only the sidecar knows
    // whether this successful boot actually ran the verified overlay, so it
    // conditionally clears agent-previous itself.
    if let Ok(sidecar) = state.sidecar() {
        let _ = sidecar.call("updater.confirmHealthy", json!({}));
    }
    state
        .log
        .log("boot", &format!("Web UI 就绪: {}", outcome.url.split('?').next().unwrap_or("")));
    // startAndShow 的「show」半边：导航主窗到 Web UI 并显示。
    // （移植缺失导致窗口停留在隐藏的 about:blank —— 真机验证发现。）
    if let Some(app) = state.app_handle() {
        navigate_main_to_web(&app, state);
    }
    // 服务意外退出监视：曾就绪且非主动重启 → 「DSH 服务已停止」对话框。
    {
        let st = state.clone();
        let handle = outcome.handle.clone();
        std::thread::spawn(move || loop {
            match rx.recv() {
                Ok(ServiceEvent::Exited(code, signal)) => {
                    if handle.intentional.load(Ordering::SeqCst)
                        || st.quitting.load(Ordering::SeqCst)
                        || !handle.was_ready.load(Ordering::SeqCst)
                    {
                        return;
                    }
                    on_service_died(&st, code, &signal);
                    return;
                }
                Ok(_) => {}
                Err(_) => return,
            }
        });
    }
    Ok(outcome.url)
}

fn on_service_died(state: &Arc<AppState>, code: Option<i32>, signal: &str) {
    state.log.log(
        "dsh",
        &format!(
            "dsh web 进程退出 code={} signal={}",
            code.map(|c| c.to_string()).unwrap_or_default(),
            signal
        ),
    );
    let detail = crate::ipc::error_detail(
        state,
        &format!(
            "dsh web 进程退出（code={} signal={}）",
            code.map(|c| c.to_string()).unwrap_or_default(),
            signal
        ),
        &["dsh-web.log"],
    );
    let st = state.clone();
    let detail_for_cb = detail.clone();
    show_dialog_on_main(
        state,
        DialogSpec {
            title: "DSH 服务已停止".into(),
            message: "DeepSeek Harness 服务意外退出。".into(),
            detail,
            buttons: vec!["复制日志".into(), "重新启动".into(), "退出".into()],
            default_index: 0,
            checkbox: None,
            icon: DialogIcon::Error,
            cancellable: true,
        },
        Arc::new(move |st, index, _| {
            match index {
                0 => {
                    if let Some(app) = st.app_handle() {
                        use tauri_plugin_clipboard_manager::ClipboardExt;
                        let _ = app.clipboard().write_text(detail_for_cb.clone());
                    }
                }
                1 => {
                    let s2 = st.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = guarded_start(&s2) {
                            handle_boot_failure(&s2, &e);
                        }
                    });
                }
                _ => {
                    st.force_quit.store(true, Ordering::SeqCst);
                    if let Some(app) = st.app_handle() {
                        app.exit(0);
                    }
                }
            }
            let _ = st;
        }),
    );
}

// ---------------------------------------------------------------------------
// 守护启动（guardedBoot 移植：Rust 循环 + sidecar 原子操作）
// ---------------------------------------------------------------------------

pub fn guarded_start(state: &Arc<AppState>) -> Result<String, String> {
    let sc = state.sidecar()?;
    sc.call("profile.upgradePreflight", json!({}))?;
    let snap = sc.call("guard.snapshot", json!({"reason": "boot"})).ok();
    match start_and_show(state, &[]) {
        Ok(url) => {
            if let Some(meta) = snap.filter(|m| m.get("id").is_some()) {
                let _ = sc.call("guard.markGood", json!({"id": meta["id"]}));
            }
            Ok(url)
        }
        Err(first_err) => {
            state
                .log
                .log("guard", "守护启动：首次拉起失败，进入体检修复流程");
            let findings = sc.call("guard.healthCheck", json!({})).unwrap_or(json!({}));
            if let Some(list) = findings.get("findings").and_then(|f| f.as_array()) {
                for f in list {
                    state.log.log(
                        "guard",
                        &format!(
                            "[体检] {}({}): {}",
                            f.get("code").and_then(|v| v.as_str()).unwrap_or("?"),
                            f.get("severity").and_then(|v| v.as_str()).unwrap_or("?"),
                            f.get("message").and_then(|v| v.as_str()).unwrap_or("")
                        ),
                    );
                }
            }
            let fixable = findings
                .get("findings")
                .and_then(|f| f.as_array())
                .map(|a| {
                    a.iter()
                        .filter(|f| f.get("fixable").and_then(|v| v.as_bool()).unwrap_or(false))
                        .count()
                })
                .unwrap_or(0);
            // V4.2：pnpm allowBuilds 配置级修复钩子（只调用一次）。
            let mut pre_applied: Vec<String> = Vec::new();
            if let Ok(r) = sc.call("guard.allowBuildsPreRetry", json!({"errText": first_err})) {
                if let Some(arr) = r.get("applied").and_then(|v| v.as_array()) {
                    pre_applied = arr
                        .iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect();
                } else if !r.get("applied").is_none() {
                    pre_applied.push("配置级修复钩子已应用".into());
                }
            }
            let mut all: Vec<String> = Vec::new();
            if fixable > 0 || !pre_applied.is_empty() {
                if let Ok(r) = sc.call("guard.repair", json!({"findings": findings})) {
                    if let Some(arr) = r.get("applied").and_then(|v| v.as_array()) {
                        all.extend(arr.iter().filter_map(|x| x.as_str().map(String::from)));
                    }
                }
                all.extend(pre_applied);
                if !all.is_empty() {
                    state
                        .log
                        .log("guard", &format!("已应用修复: {}", all.join("；")));
                    match start_and_show(state, &[]) {
                        Ok(url) => {
                            if let Some(meta) = snap.filter(|m| m.get("id").is_some()) {
                                let _ = sc.call("guard.markGood", json!({"id": meta["id"]}));
                            }
                            let _ = sc.call(
                                "guard.reportIncident",
                                json!({
                                    "title": "boot-recovered",
                                    "detail": format!("首次启动失败，自动修复后恢复。\n修复项：\n- {}\n\n原始错误：\n{}", all.join("\n- "), first_err)
                                }),
                            );
                            return Ok(url);
                        }
                        Err(second_err) => {
                            state.log.log("guard", "修复后重试仍失败，进入回滚流程");
                            return rollback_path(state, &second_err, snap.as_ref());
                        }
                    }
                }
            }
            rollback_path(state, &first_err, snap.as_ref())
        }
    }
}

fn rollback_path(
    state: &Arc<AppState>,
    err: &str,
    boot_snap: Option<&Value>,
) -> Result<String, String> {
    let sc = state.sidecar()?;
    let good = sc
        .call("guard.lastGood", json!({}))
        .ok()
        .filter(|m| m.get("id").is_some());
    let different = match (&good, boot_snap) {
        (Some(g), Some(b)) => g["id"] != b["id"],
        (Some(_), None) => true,
        _ => false,
    };
    if let (Some(g), true) = (&good, different) {
        state.log.log(
            "guard",
            &format!(
                "回滚到最后良好快照 {}（{}）",
                g["id"].as_str().unwrap_or(""),
                g["reason"].as_str().unwrap_or("")
            ),
        );
        let restored = sc
            .call("guard.restore", json!({"id": g["id"]}))
            .map(|r| r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
            .unwrap_or(false);
        if restored {
            // 回滚后再清一次遮蔽（pnpm 可能刚 hoist 过）。
            if let Ok(f) = sc.call("guard.healthCheck", json!({})) {
                let _ = sc.call("guard.repair", json!({"findings": f}));
            }
            // rollbackLift：拉起成功后把最新一份（pre-restore 快照）标记为良好。
            return match start_and_show(state, &[]) {
                Ok(url) => {
                    if let Ok(snaps) = sc.call("guard.listSnapshots", json!({})) {
                        if let Some(first) = snaps.as_array().and_then(|a| a.first()) {
                            if let Some(id) = first.get("id") {
                                let _ = sc.call("guard.markGood", json!({"id": id}));
                            }
                        }
                    }
                    Ok(url)
                }
                Err(final_err) => {
                    let _ = sc.call(
                        "guard.reportIncident",
                        json!({
                            "title": "rollback-failed",
                            "detail": format!("回滚到快照 {} 后仍无法启动。\n\n最终错误：\n{}", g["id"].as_str().unwrap_or(""), final_err)
                        }),
                    );
                    Err(final_err)
                }
            };
        }
    }
    let _ = sc.call(
        "guard.reportIncident",
        json!({
            "title": "boot-failed",
            "detail": format!("启动失败且无可回滚快照。\n\n错误：\n{}\n\n日志文件：{}", err, state.paths.logs_dir.join("dsh-web.log").display())
        }),
    );
    Err(err.to_string())
}

// ---------------------------------------------------------------------------
// 原地重启（restartWebServiceCore）
// ---------------------------------------------------------------------------

pub fn restart_service_core(state: &Arc<AppState>) -> Value {
    {
        let guard = state.service.lock().unwrap();
        if guard.is_none() || state.restarting.load(Ordering::SeqCst) {
            return json!({"ok": false, "error": "not-running"});
        }
    }
    state.log.log("service", "请求重启 dsh web 服务");
    state.restarting.store(true, Ordering::SeqCst);
    let result: Result<String, String> = (|| {
        let old = state.service.lock().unwrap().take();
        if let Some(h) = &old {
            h.intentional.store(true, Ordering::SeqCst);
            crate::service::kill_handle(h);
        }
        drop(old);
        // 等旧进程真正退出（DLL 文件锁释放），再同步内置插件并重启。
        wait_service_gone(state, Duration::from_secs(20));
        let sc = state.sidecar()?;
        // 重建配套插件副本 + 清理遮蔽（顺序不能反）。
        if let Err(e) = sc.call("profile.syncAll", json!({})) {
            state.log.log("boot", &format!("重启间隙同步失败: {}", e));
            return Err(e);
        }
        guarded_start(state)
    })();
    state.restarting.store(false, Ordering::SeqCst);
    match result {
        Ok(url) => {
            state
                .log
                .log("service", &format!("dsh web 服务已重启: {}", url));
            json!({"ok": true, "url": url})
        }
        Err(e) => {
            state.log.log("service", &format!("重启失败: {}", e));
            json!({"ok": false, "error": e})
        }
    }
}

fn wait_service_gone(state: &AppState, timeout: Duration) {
    let started = std::time::Instant::now();
    loop {
        let gone = match state.service.lock() {
            Ok(g) => match g.as_ref() {
                Some(h) => h.exited.load(Ordering::SeqCst),
                None => true,
            },
            Err(_) => true,
        };
        if gone || started.elapsed() > timeout {
            if !gone {
                state.log.log("service", "等待旧服务进程退出超时，继续");
            }
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// ---------------------------------------------------------------------------
// 对话框辅助（主线程弹原生模态框，自带消息泵不阻塞事件循环；
// action 在对话框返回后的主线程回调执行）
// ---------------------------------------------------------------------------

pub type DialogAction = Arc<dyn Fn(&Arc<AppState>, usize, bool) + Send + Sync>;

/// 弹对话框并在结束后执行 action(state, index, checked)。不阻塞调用线程。
/// 必须走主线程：TSF 注入物（WeType/CrashRpt）的窗口 hook 会在后台线程
/// 创建模态框时触发 AV（bug #11）。
pub fn show_dialog_on_main(state: &Arc<AppState>, spec: DialogSpec, action: DialogAction) {
    let Some(app) = state.app_handle() else {
        return;
    };
    let st = state.clone();
    let _ = app.run_on_main_thread(move || {
        let r = crate::dialog::show(0, &spec);
        action(&st, r.index, r.checked);
    });
}

/// 无回调版（纯告知型对话框）。
pub fn show_dialog_simple(state: &Arc<AppState>, spec: DialogSpec) {
    show_dialog_on_main(state, spec, Arc::new(|_, _, _| {}));
}

// ---------------------------------------------------------------------------
// 余额轮询（dsh-balance 插件数据源）
// ---------------------------------------------------------------------------

pub fn refresh_balance_blocking(state: &AppState) -> Value {
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e, "balances": []}),
    };
    let result = match sc.call_timeout("balance.refresh", json!({}), Duration::from_secs(60)) {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e, "balances": []}),
    };
    *state.balance_cache.lock().unwrap() = Some(result.clone());
    if let Some(app) = state.app_handle() {
        let _ = app.emit_to("main", "dsh:balance", result.clone());
    }
    result
}

pub fn start_balance_loop(state: Arc<AppState>) {
    std::thread::spawn(move || {
        refresh_balance_blocking(&state);
        loop {
            std::thread::sleep(Duration::from_secs(15 * 60));
            refresh_balance_blocking(&state);
        }
    });
}

// ---------------------------------------------------------------------------
// 内置插件更新定时检查（默认仅提示；自动更新在 sidecar 内完成）
// ---------------------------------------------------------------------------

pub fn start_plugin_update_loop(state: Arc<AppState>) {
    if std::env::var("DSH_DESKTOP_SKIP_PLUGIN_UPDATE").is_ok() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        run_plugin_update_check(&state, false);
        loop {
            std::thread::sleep(Duration::from_secs(6 * 3600));
            run_plugin_update_check(&state, false);
        }
    });
}

fn run_plugin_update_check(state: &Arc<AppState>, manual: bool) {
    if state.quitting.load(Ordering::SeqCst) {
        return;
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(_) => return,
    };
    let r = match sc.call_timeout(
        "updates.check",
        json!({"manual": manual}),
        Duration::from_secs(30 * 60),
    ) {
        Ok(v) => v,
        Err(e) => {
            state
                .log
                .log("plugin-update", &format!("内置插件更新检查失败: {}", e));
            return;
        }
    };
    // 仅提示模式：sidecar 返回 updatable 列表 → 系统通知（自动更新默认关闭）。
    if let Some(updatable) = r.get("notifyUpdatable").and_then(|v| v.as_array()) {
        if updatable.is_empty() {
            return;
        }
        let names: Vec<String> = updatable
            .iter()
            .take(5)
            .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect();
        let _ = state.notify(
            "plugin-update",
            &format!("有 {} 个内置插件可更新", updatable.len()),
            &format!(
                "{}{} 已发布新版本。打开「设置 → 插件 → 更新」查看并更新（自动更新默认关闭，仅提示）。",
                names.join("、"),
                if updatable.len() > 5 { " 等" } else { "" }
            ),
        );
        return;
    }
    // 自动更新模式：done/failed → 弹窗 + 可选立即重启。
    if let Some(done) = r.get("done").and_then(|v| v.as_array()) {
        if done.is_empty() {
            return;
        }
        let names: Vec<String> = done
            .iter()
            .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect();
        let failed: Vec<String> = r
            .get("failed")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let detail = format!(
            "更新已写入用户目录，重启 Web 服务后生效（无需重启应用）。{}",
            if failed.is_empty() {
                String::new()
            } else {
                format!(
                    "\n\n失败 {} 个：{}（可在「设置 → 插件 → 更新」重试）",
                    failed.len(),
                    failed.join("、")
                )
            }
        );
        show_dialog_on_main(
            state,
            DialogSpec {
                title: "内置插件已更新".into(),
                message: format!("已更新内置插件：{}", names.join("、")),
                detail,
                buttons: vec!["立即重启服务".into(), "稍后".into()],
                default_index: 0,
                checkbox: None,
                icon: DialogIcon::Info,
                cancellable: true,
            },
            Arc::new(move |st, index, _| {
                if index == 0 {
                    let s = st.clone();
                    std::thread::spawn(move || {
                        restart_service_core(&s);
                    });
                }
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// 启动失败对话框链（handleBootFailure / fatal）
// ---------------------------------------------------------------------------

pub fn handle_boot_failure(state: &Arc<AppState>, err: &str) {
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(_) => return fatal(state, "Deepseek Harness 启动失败", err),
    };
    let overlay_bin = state
        .paths
        .user_data
        .join("agent")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if !overlay_bin.exists() {
        return fatal(state, "Deepseek Harness 启动失败", err);
    }
    // 归因到具体插件（V4.2）→「停用插件并重试」；最后良好快照 →「回滚重试」；
    // 更新备份可用 → 版本级回退。按钮顺序与 JS 版一致。
    let blame = sc
        .call("guard.attributeBootFailure", json!({"errText": err}))
        .ok()
        .filter(|b| b.get("name").is_some());
    let blame_row = blame.as_ref().and_then(|b| {
        let rows = sc.call("plugin.list", json!({})).ok()?;
        rows.as_array()?
            .iter()
            .find(|r| {
                r.get("id").and_then(|v| v.as_str()) == b.get("rowId").and_then(|v| v.as_str())
            })
            .cloned()
    });
    let last_good = sc
        .call("guard.lastGood", json!({}))
        .ok()
        .filter(|m| m.get("id").is_some());
    let prev = sc
        .call("updater.previousAgentInfo", json!({}))
        .ok()
        .filter(|p| p.get("version").is_some());

    let toggleable = blame_row
        .as_ref()
        .map(|r| {
            r.get("toggleable")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let blame_name = blame_row
        .as_ref()
        .and_then(|r| r.get("name").and_then(|v| v.as_str()))
        .or_else(|| {
            blame
                .as_ref()
                .and_then(|b| b.get("name").and_then(|v| v.as_str()))
        })
        .unwrap_or("")
        .to_string();
    let btn_disable = if toggleable {
        Some(format!("停用插件 {} 并重试", blame_name))
    } else {
        None
    };
    let btn_rollback = last_good
        .as_ref()
        .map(|_| "回滚到最后良好快照并重试".to_string());
    let has_prev = prev.is_some();

    let mut buttons: Vec<String> = Vec::new();
    if let Some(b) = &btn_disable {
        buttons.push(b.clone());
    }
    if let Some(b) = &btn_rollback {
        buttons.push(b.clone());
    }
    let (idx_prev, idx_builtin, idx_retry, idx_quit);
    if has_prev {
        buttons.extend([
            "回退到上一版本并重试".into(),
            "回退到内置版本".into(),
            "重试".into(),
            "退出".into(),
        ]);
        idx_prev = Some(buttons.len() - 4);
        idx_builtin = buttons.len() - 3;
        idx_retry = buttons.len() - 2;
        idx_quit = buttons.len() - 1;
    } else {
        buttons.extend(["回退到内置版本并重试".into(), "重试".into(), "退出".into()]);
        idx_prev = None;
        idx_builtin = buttons.len() - 3;
        idx_retry = buttons.len() - 2;
        idx_quit = buttons.len() - 1;
    }
    let idx_disable: Option<usize> = btn_disable.as_ref().map(|_| 0);
    let idx_rollback: Option<usize> =
        btn_rollback
            .as_ref()
            .map(|_| if idx_disable.is_some() { 1 } else { 0 });

    let mut detail_lines = vec![err.to_string()];
    if blame.is_some() {
        detail_lines.push(String::new());
        detail_lines.push(format!(
            "报错指向插件「{}」（{}），可先停用该插件后重试。",
            blame_name,
            match blame
                .as_ref()
                .and_then(|b| b.get("kind").and_then(|v| v.as_str()))
            {
                Some("patchRow") => format!(
                    "patch 行 {}",
                    blame
                        .as_ref()
                        .and_then(|b| b.get("rowId").and_then(|v| v.as_str()))
                        .unwrap_or("")
                ),
                k => k.unwrap_or("").to_string(),
            }
        ));
    }
    if let Some(lg) = &last_good {
        detail_lines.push(format!(
            "存在最后良好快照（{}），可一键回滚后重试。",
            lg.get("reason")
                .and_then(|v| v.as_str())
                .or_else(|| lg.get("id").and_then(|v| v.as_str()))
                .unwrap_or("")
        ));
    }
    detail_lines.push(String::new());
    if let Some(p) = &prev {
        detail_lines.push(format!(
            "可回退到上一版本（v{}）或内置版本继续使用。",
            p["version"].as_str().unwrap_or("")
        ));
    } else {
        detail_lines.push("可回退到内置版本继续使用。".into());
    }

    let spec = DialogSpec {
        title: "Deepseek Harness 启动失败".into(),
        message: if has_prev {
            "更新后的 agent 无法启动。".into()
        } else {
            "Deepseek Harness 无法启动。".into()
        },
        detail: detail_lines.join("\n"),
        buttons,
        default_index: 0,
        checkbox: None,
        icon: DialogIcon::Error,
        cancellable: true,
    };
    show_dialog_on_main(
        state,
        spec,
        Arc::new(move |st, index, _| {
            let retry = |st: &Arc<AppState>| {
                let s = st.clone();
                std::thread::spawn(move || {
                    if let Err(e) = guarded_start(&s) {
                        handle_boot_failure(&s, &e);
                    }
                });
            };
            if Some(index) == idx_disable {
                if let Some(row) = &blame_row {
                    if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                        if let Ok(sc2) = st.sidecar() {
                            let _ =
                                sc2.call("plugin.setEnabled", json!({"id": id, "enabled": false}));
                            st.log
                                .log("plugin-manager", &format!("启动失败后停用插件: {}", id));
                        }
                    }
                }
                retry(st);
                return;
            }
            if Some(index) == idx_rollback {
                if let (Ok(sc2), Some(lg)) = (st.sidecar(), &last_good) {
                    if let Err(e) = sc2.call("guard.restore", json!({"id": lg["id"]})) {
                        st.log.log("guard", &format!("回滚快照失败: {}", e));
                    }
                }
                retry(st);
                return;
            }
            if Some(index) == idx_prev {
                if let Ok(sc2) = st.sidecar() {
                    let _ = sc2.call("updater.rollbackToPrevious", json!({}));
                }
                retry(st);
                return;
            }
            if index == idx_builtin {
                if let Ok(sc2) = st.sidecar() {
                    let _ = sc2.call("updater.rollback", json!({}));
                }
                retry(st);
                return;
            }
            if index == idx_retry {
                retry(st);
                return;
            }
            if index == idx_quit {
                st.force_quit.store(true, Ordering::SeqCst);
                let _ = crate::watchdog::mark_clean_exit(&st.paths.run_state_file());
                if let Some(app) = st.app_handle() {
                    app.exit(1);
                }
            }
        }),
    );
}

fn fatal(state: &Arc<AppState>, title: &str, err: &str) {
    state.log.log("fatal", &format!("{}: {}", title, err));
    let detail = crate::ipc::error_detail(state, err, &["dsh-web.log", "desktop.log"]);
    show_dialog_on_main(
        state,
        DialogSpec {
            title: title.into(),
            message: title.into(),
            detail: detail.clone(),
            buttons: vec!["复制日志".into(), "重试".into(), "退出".into()],
            default_index: 0,
            checkbox: None,
            icon: DialogIcon::Error,
            cancellable: true,
        },
        Arc::new(move |st, index, _| {
            match index {
                0 => {
                    if let Some(app) = st.app_handle() {
                        use tauri_plugin_clipboard_manager::ClipboardExt;
                        let _ = app.clipboard().write_text(detail.clone());
                    }
                }
                1 => {
                    let s = st.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = guarded_start(&s) {
                            handle_boot_failure(&s, &e);
                        }
                    });
                }
                _ => {
                    st.force_quit.store(true, Ordering::SeqCst);
                    // 启动失败属已知退出：避免看门狗反复拉起反复失败。
                    let _ = crate::watchdog::mark_clean_exit(&st.paths.run_state_file());
                    if let Some(app) = st.app_handle() {
                        app.exit(1);
                    }
                }
            }
        }),
    );
}

// ---------------------------------------------------------------------------
// boot() 主链路
// ---------------------------------------------------------------------------

/// 孤儿运行时清扫：上一实例异常退出后（如 Job 兜底未触发的强杀场景），残留的
/// dsh web / sidecar node 进程会占住 web 端口并持有旧 profile 句柄。启动早期按
/// 「命令行属于本应用运行时 且 父进程已死」识别孤儿并回收。单实例设计下不会误伤。
fn sweep_orphaned_runtime(state: &Arc<AppState>) {
    let paths = &state.paths;
    let bin = paths.dsh_bin().to_string_lossy().to_string();
    let host = paths
        .app_root
        .join("sidecar")
        .join("dist")
        .join("shell-host.js")
        .to_string_lossy()
        .to_string();
    let script = format!(
        "$p1='*{}*';$p2='*{}*';Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {{ if ($_.CommandLine -like $p1 -or $_.CommandLine -like $p2) {{ \"$($_.ProcessId)`t$($_.ParentProcessId)\" }} }}",
        bin.replace('\'', "''"),
        host.replace('\'', "''")
    );
    let mut sweep = std::process::Command::new("powershell");
    sweep.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    // GUI 子系统 spawn 控制台程序默认闪黑窗；补 NO_WINDOW。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        sweep.creation_flags(0x0800_0000);
    }
    let Ok(out) = sweep.output() else {
        state
            .log
            .log("boot", "孤儿清扫: PowerShell 探测不可用，跳过");
        return;
    };
    if !out.status.success() {
        state.log.log(
            "boot",
            &format!("孤儿清扫: 探测失败（退出码 {:?}），跳过", out.status.code()),
        );
        return;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut swept = 0usize;
    for line in text.lines() {
        let Some((pid_s, ppid_s)) = line.trim().split_once('\t') else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid_s.trim().parse::<u32>(), ppid_s.trim().parse::<u32>())
        else {
            continue;
        };
        if pid == std::process::id() || ppid == std::process::id() {
            continue;
        }
        // 父进程仍存活 → 不是孤儿（可能是用户另开的 CLI 直连等），不动。
        if crate::procwin::alive(ppid) {
            continue;
        }
        state.log.log(
            "boot",
            &format!(
                "发现上一实例残留的运行时进程 pid={}（父 {} 已退出），回收",
                pid, ppid
            ),
        );
        crate::procwin::kill_pid_tree_and_wait(
            pid,
            Duration::from_millis(crate::procwin::GRACE_MS),
            Duration::from_millis(crate::procwin::HARD_MS),
        );
        swept += 1;
    }
    if swept > 0 {
        state
            .log
            .log("boot", &format!("孤儿清扫完成，回收 {} 个残留进程", swept));
    }
}

pub fn run_boot(app: AppHandle) {
    let state: Arc<AppState> = app.state::<Arc<AppState>>().inner().clone();
    std::thread::spawn(move || {
        boot_chain(&state);
    });
}

fn boot_chain(state: &Arc<AppState>) {
    let paths = &state.paths;
    let _ = std::fs::create_dir_all(&paths.logs_dir);
    let _ = std::fs::create_dir_all(&paths.dsh_home);
    let (av, asrc) = agent_version_info(state);
    state.log.log(
        "boot",
        &format!(
            "DSHEAC AIO {}  userData={}  dshHome={}  agent={}({})",
            crate::DISPLAY_RELEASE,
            paths.user_data.display(),
            paths.dsh_home.display(),
            av,
            asrc
        ),
    );

    // 看门狗 + 运行状态标记（安装版）：意外崩溃后自动拉起并告知用户。
    // 先读上次运行状态（write_run_state 会覆盖 pid/cleanExit，必须先读），
    // 据此决定是否清扫孤儿进程。
    let unclean_prev =
        crate::watchdog::detect_unclean_previous_run(&paths.run_state_file(), std::process::id());
    crate::watchdog::write_run_state(
        &paths.run_state_file(),
        std::process::id(),
        &paths.version,
        None,
    );
    start_watchdog(state);
    if let Some(prev) = &unclean_prev {
        let started = prev
            .get("startedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("上次")
            .replace('T', " ");
        let started = &started[..started.len().min(19)];
        let _ = state.notify(
            "crash",
            "DSHEAC AIO 已自动恢复",
            &format!(
                "检测到应用在 {} 前后未正常退出，看门狗已重新启动应用。",
                started
            ),
        );
    }

    // sidecar：插件生态编排（复用全部现有 JS 模块）。
    // 孤儿清扫仅在「上次非正常退出」时执行：正常退出已回收 dsh web/sidecar，
    // 无孤儿可清；此处省掉每次启动的 PowerShell CIM 查询（约 2s+）。
    if unclean_prev.is_some() {
        sweep_orphaned_runtime(state);
    }
    let sc = match crate::sidecar::Sidecar::spawn(paths, &state.log) {
        Ok((s, rx)) => {
            let _ = state.sidecar.set(s.clone());
            // sidecar 事件泵：日志汇入 desktop.log；通知/余额转发。
            let st = state.clone();
            std::thread::spawn(move || {
                for ev in rx {
                    match ev {
                        SidecarEvent::Log(tag, msg) => st.log.log(&tag, &msg),
                        SidecarEvent::Notify(title, body) => {
                            let _ = st.notify("sidecar", &title, &body);
                        }
                        SidecarEvent::Balance(data) => {
                            *st.balance_cache.lock().unwrap() = Some(data.clone());
                            if let Some(app) = st.app_handle() {
                                let _ = app.emit_to("main", "dsh:balance", data);
                            }
                        }
                        SidecarEvent::Exited => {
                            st.log.log("sidecar", "shell-host 进程已退出");
                        }
                    }
                }
            });
            s
        }
        Err(e) => {
            state.log.log("boot", &format!("sidecar 启动失败: {}", e));
            return handle_boot_failure(state, &format!("sidecar 启动失败: {}", e));
        }
    };

    // 一次性迁移 + 配套插件同步 + 模块遮蔽清理（幂等，sidecar 内实现）。
    if let Err(e) = sc.call_timeout(
        "profile.migrateAndSync",
        json!({}),
        Duration::from_secs(10 * 60),
    ) {
        state
            .log
            .log("boot", &format!("profile 迁移/同步失败: {}", e));
        // A version-gate failure must not fall through to repairs or launch.
        show_dialog_simple(state, DialogSpec {
            title: "Profile startup paused".into(),
            message: "Profile migration or synchronization did not complete.".into(),
            detail: "Startup is blocked. Older profiles require an offline dependency upgrade; automatic activation is not available in this build.".into(),
            buttons: vec!["OK".into()],
            default_index: 0,
            checkbox: None,
            icon: DialogIcon::Warning,
            cancellable: true,
        });
        return;
    }

    // koffi FFI 预检：失败则注入目录选择器降级 overlay（start_and_show 以
    // --patch 交给 dsh web）。
    match sc.call_timeout("koffi.preflight", json!({}), Duration::from_secs(60)) {
        Ok(v) => {
            let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(true);
            if let Some(p) = v.get("overlayPath").and_then(|x| x.as_str()) {
                *state.picker_overlay.lock().unwrap() = if ok { None } else { Some(p.to_string()) };
            } else if !ok {
                *state.picker_overlay.lock().unwrap() = None;
            }
            state.log.log(
                "preflight",
                if ok {
                    "koffi 预检: 通过"
                } else {
                    "koffi 预检: 失败（已注入降级 overlay）"
                },
            );
        }
        Err(e) => state
            .log
            .log("preflight", &format!("koffi 预检执行失败（忽略）: {}", e)),
    }

    // junction 归属守卫：首次纠偏 + 周期巡检（5 分钟）都放后台线程，
    // 不阻塞主启动链路（内部 PowerShell 探测约 0.3s+）。
    {
        let st = state.clone();
        std::thread::spawn(move || {
            junction_tick(&st);
            loop {
                std::thread::sleep(Duration::from_secs(5 * 60));
                junction_tick(&st);
            }
        });
    }

    // 捆绑依赖完整性校验（issue #7，安装版）。
    if !verify_bundled_modules(state) {
        return; // 用户选择退出
    }

    // 守护启动。
    if let Err(e) = guarded_start(state) {
        return handle_boot_failure(state, &e);
    }

    // 启动成功收尾。
    match paths.commit_distribution_profile_seed() {
        Ok(true) => state.log.log("boot", "新版 profile 已通过启动验收，旧插件备份已清理"),
        Ok(false) => {}
        Err(e) => state.log.log("boot", &format!("profile 升级收尾失败: {e}")),
    }
    let _ = sc.call("updater.confirmHealthy", json!({}));
    crate::shortcuts::maintain_shortcuts(paths, &state.log);
    start_balance_loop(state.clone());
    start_plugin_update_loop(state.clone());
    state.log.log("boot", "启动链路完成");
}

fn junction_tick(state: &AppState) {
    if state.quitting.load(Ordering::SeqCst) || state.restarting.load(Ordering::SeqCst) {
        return;
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(_) => return,
    };
    let Ok(r) = sc.call_timeout("guard.junctionTick", json!({}), Duration::from_secs(120)) else {
        return;
    };
    if r.get("externalRunning")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        state
            .log
            .log("guard", "共享模块被外部 dsh 接管，待其退出后自动修复");
        return;
    }
    let repaired: Vec<String> = r
        .get("repaired")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if !repaired.is_empty() && !state.junction_notified.swap(true, Ordering::SeqCst) {
        let _ = state.notify(
            "guard",
            "已自动修复共享模块指向",
            "检测到原生 dsh 改写了共享模块目录，桌面端已恢复指向自身版本。原生 CLI 如有异常，重启它即可。",
        );
    }
}

/// issue #7：安装版启动前校验捆绑 node_modules。返回 false = 用户选择退出。
fn verify_bundled_modules(state: &Arc<AppState>) -> bool {
    if !state.paths.packaged {
        return true;
    }
    let manifest_path = state.paths.app_root.join("bundle-manifest.json");
    let Ok(text) = std::fs::read_to_string(&manifest_path) else {
        return true;
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
        return true;
    };
    // 缓存：manifest 内容未变（仅首次/重装/升级会变）则跳过全量遍历，
    // 避免每次启动都递归数 600+ 个包的 node_modules。
    let hash = format!("{:016x}", crate::integrity::fnv1a64(text.as_bytes()));
    let cache_path = state.paths.user_data.join("bundle-verified.json");
    if let Some(prev) = std::fs::read_to_string(&cache_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        if prev.get("hash").and_then(|v| v.as_str()) == Some(hash.as_str()) {
            return true;
        }
    }
    let r = crate::integrity::verify_bundle(
        &state.paths.app_root.join("node_modules"),
        Some(&manifest),
    );
    if r.skipped || r.ok {
        // 校验通过才写缓存；受损或跳过不写，下次仍会重检。
        let _ = std::fs::write(&cache_path, serde_json::json!({ "hash": hash }).to_string());
        return true;
    }
    let sample: Vec<String> = r
        .damaged
        .iter()
        .take(5)
        .map(|d| format!("{}（{}）", d.name, d.reason))
        .collect();
    state.log.log(
        "boot",
        &format!(
            "捆绑依赖完整性校验失败（{} 个包受损）: {}{}",
            r.damaged.len(),
            sample.join("、"),
            if r.damaged.len() > 5 { " 等" } else { "" }
        ),
    );
    let (tx, rx) = mpsc::channel::<bool>();
    let tx = Arc::new(tx);
    show_dialog_on_main(
        state,
        DialogSpec {
            title: "程序文件受损".into(),
            message: format!("检测到 {} 个捆绑依赖包文件缺失，可能是升级中断或安全软件清理所致。", r.damaged.len()),
            detail: format!(
                "受损包: {}{}\n\n建议重新下载安装包覆盖安装（GitHub Releases 最新版）。\n选择「仍然启动」大概率无法正常运行。",
                sample.join("、"),
                if r.damaged.len() > 5 { format!("（共 {} 个）", r.damaged.len()) } else { String::new() }
            ),
            buttons: vec!["仍然启动".into(), "退出".into()],
            default_index: 0,
            checkbox: None,
            icon: DialogIcon::Error,
            cancellable: true,
        },
        Arc::new(move |st, index, _| {
            if index != 0 {
                st.force_quit.store(true, Ordering::SeqCst);
                let _ = crate::watchdog::mark_clean_exit(&st.paths.run_state_file());
                if let Some(app) = st.app_handle() {
                    app.exit(1);
                }
            }
            let _ = tx.send(index == 0);
        }),
    );
    rx.recv().unwrap_or(false)
}

fn start_watchdog(state: &AppState) {
    // 仅安装版启用：开发模式下重启会与调试流程互相干扰。
    if !state.paths.packaged {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let args = vec![
        "--dsh-watchdog=1".to_string(),
        format!("--pid={}", std::process::id()),
        format!("--exe={}", exe.to_string_lossy()),
        format!("--state={}", state.paths.run_state_file().display()),
        format!(
            "--log={}",
            state.paths.logs_dir.join("watchdog.log").display()
        ),
    ];
    let cwd = exe.parent().map(|p| p.to_path_buf());
    match crate::procwin::spawn_detached(&exe.to_string_lossy(), &args, cwd.as_deref()) {
        Ok(()) => state.log.log("watchdog", "看门狗已启动"),
        Err(e) => state.log.log("watchdog", &format!("看门狗启动失败: {}", e)),
    }
}

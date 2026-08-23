// release 构建隐藏控制台：release 的 exe 为 windows 子系统，双击启动不再弹出
// 标题为 exe 路径的命令行窗口（debug 保留控制台便于看 eprintln 诊断）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Deepseek Harness EAC — Tauri ShellHost（ADR 0002 L1；P2 GUI 主链路）
//
// 运行模式：
//   dsh-eac-shell               → 窗口 + 托盘 + sidecar 常驻 + WS 桥 + boot.start
//   dsh-eac-shell --bridge-test → 无 GUI，stdio JSON-RPC 驱动 server.js 冒烟
//
// 架构对应（docs/adr/0002）：
//   Rust 本体    = L1（窗口/托盘/WS 回环桥/生命周期/导航编排/壳层方法拦截）
//   Node sidecar = L2（tauri-shell/sidecar/server.js + bridge.js：挂载
//                  lib/desktop/* 全部模块 + boot-server 服务编排 + 桥方法面）
//   dsh 内核     = L3（零改动）
//
// 启动序列：
//   1. spawn sidecar（stdio JSON-RPC）+ 绑定 127.0.0.1:19873（WS + HTTP 同端口）
//   2. 主窗先加载壳层加载页 /loading（即起即见，initialization_script 注入桥）
//   3. boot.start → sidecar 拉起 dsh web（稳定端口 + 受限端口重试 + 探针竞争）
//   4. webUrl 回传 → 主窗导航到真实 Web UI
//   5. boot.web-ready（原地重启）→ 重新导航；boot.server-died → /died 页
//
// WS 桥（127.0.0.1:19873）方法分流：
//   壳层本地拦截（本文件 handle_shell_method）：
//     win.minimize / win.toggle-maximize / win.close / win.is-maximized /
//     win.start-dragging（send）/ win.maximized（通知推送）
//     float.open（per-webview data_directory 隔离 = 硬门槛①）/ float.close
//     menu.action 的纯壳动作（reload / devtools / fullscreen / quit / open-browser）
//     shell.open-external（http(s) 校验后系统打开）
//     log.renderer-heartbeat / log.page-error（send，壳层记录）
//   其余 → sidecar（chrome.init / service.restart / boot.* / P3 渐进收编面）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as ABufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use std::process::Stdio;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex as AMutex};
use tokio_tungstenite::tungstenite::Message;

const BRIDGE_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/sidecar/bridge.js"));
const WS_PORT: u16 = 19873;

/// 打包态与开发态（CARGO_MANIFEST_DIR 布局）的资源根。
/// 实测（R6 Stage 1）：Tauri v2 resources map 目标相对安装根，NSIS 装出
/// exe 同级 sidecar/ + dsh-desktop/ 兄弟目录；exe 同级直认优先，
/// 兼容保留 resources/ 子目录布局探测，最后回退开发布局。
fn resource_root() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent().map(|p| p.to_path_buf()) {
            if dir.join("sidecar").join("server.js").exists() {
                return dir;
            }
            let res = dir.join("resources");
            if res.join("sidecar").join("server.js").exists() {
                return res;
            }
        }
    }
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/..")).canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/..")))
}

fn sidecar_script() -> std::path::PathBuf {
    resource_root().join("sidecar").join("server.js")
}

fn dsh_desktop_dir() -> String {
    resource_root().join("dsh-desktop").to_string_lossy().replace('\u{5C}', "/")
}

static SHELL_NOTIFY: OnceLock<broadcast::Sender<Value>> = OnceLock::new();
static WEB_URL: OnceLock<RwLock<String>> = OnceLock::new();
static LAST_MAXIMIZED: AtomicBool = AtomicBool::new(false);

fn shell_notify() -> broadcast::Sender<Value> {
    SHELL_NOTIFY
        .get_or_init(|| broadcast::channel::<Value>(64).0)
        .clone()
}

fn current_web_url() -> Option<String> {
    WEB_URL
        .get_or_init(|| RwLock::new(String::new()))
        .read()
        .ok()
        .map(|g| g.clone())
        .filter(|s| !s.is_empty())
}

fn set_current_web_url(url: &str) {
    if let Ok(mut g) = WEB_URL
        .get_or_init(|| RwLock::new(String::new()))
        .write()
    {
        *g = url.to_string();
    }
}

/// 解析 Node 运行时：优先内置 vendor/node（与 Electron 壳共用一份），回退 PATH。
fn resolve_node() -> String {
    if let Ok(p) = std::env::var("DSH_NODE_EXE") {
        if !p.is_empty() {
            return p;
        }
    }
    let vendored = format!("{}/vendor/node/node.exe", dsh_desktop_dir());
    if std::path::Path::new(&vendored).exists() {
        return vendored;
    }
    "node.exe".to_string()
}

/// L1 ↔ L2 sidecar 异步客户端：行分隔 JSON-RPC over stdio。
struct Sidecar {
    child: Child,
    writer: Arc<AMutex<ChildStdin>>,
    next_id: Arc<AtomicU64>,
    pending: Arc<AMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    notify_tx: broadcast::Sender<Value>,
}

impl Sidecar {
    async fn spawn() -> Result<Self, String> {
        let node = resolve_node();
        let mut cmd = Command::new(&node);
        cmd.arg(sidecar_script())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // 开发期诊断直通终端；release 无控制台，显式丢弃（inherit 在
            // windows 子系统下无有效句柄）。
            .stderr(if cfg!(debug_assertions) { Stdio::inherit() } else { Stdio::null() });
        // node.exe 是控制台子系统程序：GUI 父进程派生时若不加
        // CREATE_NO_WINDOW 会自建控制台窗口（0x08000000）。
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        if let Ok(exe) = std::env::current_exe() {
            // 壳层 exe 与资源根（client-update 的 installDir 判定 / 打包态定位）。
            cmd.env("DSH_SHELL_EXE", &exe);
        }
        // 壳进程 PID：便携自更新助手的等待目标（等待壳退出后做目录树交换）。
        cmd.env("DSH_SHELL_PID", std::process::id().to_string());
        cmd.env("DSH_RESOURCE_ROOT", resource_root());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn node({}) failed: {}", node, e))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (notify_tx, _rx) = broadcast::channel::<Value>(64);
        let sc = Sidecar {
            child,
            writer: Arc::new(AMutex::new(stdin)),
            next_id: Arc::new(AtomicU64::new(0)),
            pending: Arc::new(AMutex::new(HashMap::new())),
            notify_tx,
        };
        sc.spawn_reader(ABufReader::new(stdout));
        Ok(sc)
    }

    fn spawn_reader(&self, mut reader: ABufReader<ChildStdout>) {
        let pending = self.pending.clone();
        let notify_tx = self.notify_tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // stdout closed
                    Ok(_) => {}
                    Err(_) => break,
                }
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                let v: Value = match serde_json::from_str(text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                    if let Some(tx) = pending.lock().await.remove(&id) {
                        let payload = if let Some(err) = v.get("error") {
                            Err(format!("rpc error: {}", err))
                        } else {
                            Ok(v.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = tx.send(payload);
                    }
                } else if v.get("method").is_some() {
                    // 通知帧：广播给所有 WS 连接。
                    let _ = notify_tx.send(v);
                }
            }
        });
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let req = serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let mut w = self.writer.lock().await;
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');
        w.write_all(line.as_bytes()).await.map_err(|e| format!("write rpc: {}", e))?;
        w.flush().await.map_err(|e| format!("flush rpc: {}", e))?;
        drop(w);
        match tokio::time::timeout(std::time::Duration::from_secs(180), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("sidecar dropped reply channel".into()),
            Err(_) => Err("sidecar call timeout (180s)".into()),
        }
    }

    async fn kill(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

/// 每连接共享态：sidecar 句柄。
#[derive(Clone)]
struct BridgeState {
    sidecar: Arc<AMutex<Option<Arc<Sidecar>>>>,
}

/// 同端口上的极简 HTTP + WebSocket 服务：
///   GET /loading            → 加载页（主窗首屏；内联桥脚本）
///   GET /died               → 服务中断页（boot.server-died 后导航）
///   GET /bootstrap          → 探针页（P2 冒烟遗留）
///   GET /inject/bridge.js   → 桥脚本
///   其余（Upgrade: websocket）→ JSON-RPC 中继（壳层拦截 + sidecar 转发）
async fn serve_ws(state: BridgeState, app: tauri::AppHandle) {
    let listener = match TcpListener::bind(("127.0.0.1", WS_PORT)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[ws] bind {} failed: {}", WS_PORT, e);
            return;
        }
    };
    println!("[ws] bridge listening on http://127.0.0.1:{}/bootstrap", WS_PORT);
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let state = BridgeState {
            sidecar: state.sidecar.clone(),
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = handle_conn(stream, state, app).await;
        });
    }
}

/// 退出策略（= main.js getExitAction/askExitAction）：
/// minimize → 隐藏到托盘；quit → 优雅退出；ask → 弹出独立退出选择窗口。
async fn apply_exit_policy(app: &tauri::AppHandle, allow_ask: bool) {
    use tauri::Manager;
    let action = sidecar_exit_action(app).await.unwrap_or_else(|| "ask".to_string());
    match action.as_str() {
        "minimize" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        "quit" => app.exit(0),
        _ => {
            if allow_ask {
                open_exit_dialog(app);
            } else {
                // 非用户主动路径（防误触兜底）：隐藏。
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
        }
    }
}

const EXIT_DIALOG_LABEL: &str = "exit-dialog";

/// 打开独立退出选择弹窗（主窗保持不动）。
fn open_exit_dialog(app: &tauri::AppHandle) {
    use tauri::Manager;
    // 已存在 → 显示并聚焦
    if let Some(w) = app.get_webview_window(EXIT_DIALOG_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let href = format!("http://127.0.0.1:{}/exit", WS_PORT);
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(url) = tauri::Url::parse(&href) else { return };
        let init = BRIDGE_JS.to_string();
        let _ = tauri::webview::WebviewWindowBuilder::new(&app2, EXIT_DIALOG_LABEL, tauri::WebviewUrl::External(url))
            .title("退出 Deepseek Harness")
            .inner_size(480.0, 380.0)
            .min_inner_size(400.0, 300.0)
            .decorations(false)
            .resizable(false)
            .center()
            .initialization_script(&init)
            .build();
    });
}

/// 从 sidecar 的 chrome.init 读 exitAction（settings 同源）。
async fn sidecar_exit_action(_app: &tauri::AppHandle) -> Option<String> {
    let state = BRIDGE.get_or_init(|| BridgeState {
        sidecar: Arc::new(AMutex::new(None)),
    });
    let sc = state.sidecar.lock().await.clone()?;
    let r = sc.call("chrome.init", serde_json::json!({})).await.ok()?;
    r.get("exitAction").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// 壳层方法拦截：返回 Some(reply) = 已处理并给出 JSON-RPC 完整回复；
/// None = 已消费（send 型，无回复）；Err(()) = 非壳层方法 → 转发 sidecar。
async fn handle_shell_method(
    app: &tauri::AppHandle,
    method: &str,
    params: &Value,
    id: &Value,
) -> Result<Option<String>, ()> {
    use tauri::Manager;
    let reply = |result: Value| {
        serde_json::json!({"jsonrpc":"2.0","id":id,"result":result}).to_string()
    };
    match method {
        "win.minimize" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.minimize();
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.toggle-maximize" => {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.close" => {
            // 退出策略（= Electron exitAction）：minimize→隐藏；quit→退出；
            // ask→弹出独立退出选择窗口。
            apply_exit_policy(app, true).await;
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.close-dialog" => {
            // 关闭退出选择弹窗（独立窗口，不影响主窗）。
            if let Some(w) = app.get_webview_window(EXIT_DIALOG_LABEL) {
                let _ = w.close();
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.close-force" => {
            app.exit(0);
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.hide-and-close-dialog" => {
            // 最小化到后台：隐藏主窗 + 关闭退出弹窗。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            if let Some(d) = app.get_webview_window(EXIT_DIALOG_LABEL) {
                let _ = d.close();
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.is-maximized" => {
            let m = app
                .get_webview_window("main")
                .map(|w| w.is_maximized().unwrap_or(false))
                .unwrap_or(false);
            Ok(Some(reply(serde_json::json!({"maximized":m}))))
        }
        "win.start-dragging" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.start_dragging();
            }
            Ok(None) // send 型
        }
        "float.open" => {
            let session = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let r = open_float_window(app, session);
            let ok = matches!(r, Ok(true));
            Ok(Some(reply(serde_json::json!({"ok":ok}))))
        }
        "float.close" => {
            let label = params.get("win").and_then(|v| v.as_str()).unwrap_or("");
            if !label.is_empty() {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.close();
                }
            }
            Ok(None) // send 型
        }
        "float.ready" => {
            // 浮窗页面桥就绪信号 → 广播给所有 WS 连接（主窗/冒烟可观测）。
            let _ = shell_notify().send(serde_json::json!({
                "method": "float.ready",
                "params": { "win": params.get("win").cloned().unwrap_or(Value::Null) }
            }));
            Ok(None)
        }
        "menu.action" => {
            let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("");
            match action {
                "reload" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.eval("location.reload()");
                    }
                    Ok(Some(reply(Value::Null)))
                }
                "devtools" => {
                    if let Some(w) = app.get_webview_window("main") {
                        if w.is_devtools_open() {
                            let _ = w.close_devtools();
                        } else {
                            let _ = w.open_devtools();
                        }
                    }
                    Ok(Some(reply(Value::Null)))
                }
                "fullscreen" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let fs = w.is_fullscreen().unwrap_or(false);
                        let _ = w.set_fullscreen(!fs);
                    }
                    Ok(Some(reply(Value::Null)))
                }
                "quit" => {
                    app.exit(0);
                    Ok(Some(reply(Value::Null)))
                }
                "open-browser" => {
                    if let Some(url) = current_web_url() {
                        open_external(&url);
                    }
                    Ok(Some(reply(Value::Null)))
                }
                "feedback" => {
                    open_external("https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues");
                    Ok(Some(reply(Value::Null)))
                }
                _ => Err(()), // 其余菜单动作（更新/开关/导出/关于…）→ sidecar
            }
        }
        "shell.open-external" => {
            let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let ok = is_safe_external_url(url);
            if ok {
                open_external(url);
            }
            Ok(Some(reply(serde_json::json!({"ok":ok}))))
        }
        "log.renderer-heartbeat" => Ok(None), // P3 恢复状态机消费；P2 吞掉不转发
        "log.page-error" => {
            let msg = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
            eprintln!("[page-error] {}", msg);
            Ok(None)
        }
        "shell.exit-dismiss" => {
            // 不再需要（弹窗已改为独立窗口）
            Ok(None)
        }
        "recovery.restart" => {
            // 整应用重启（= Electron app.relaunch+exit）。
            app.restart();
        }
        _ => Err(()),
    }
}

/// 仅放行 http(s)（对齐 Electron 侧 will-navigate/openExternal 的外链纪律）。
fn is_safe_external_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

fn open_external(url: &str) {
    if !is_safe_external_url(url) {
        return;
    }
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", url])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn();
}

/// 窗口标签字符集（tauri 限制：字母数字与 - / : _）。
fn sanitize_label(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '/' || c == ':' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "float".to_string()
    } else {
        cleaned
    }
}

/// 会话浮窗（硬门槛①）：第二个 WebviewWindow + 独立 data_directory
/// （= Electron 的 persist:dsh-float 分区），与主窗 localStorage 隔离。
/// 同一会话复用同一标签 → 单浮窗；返回 false 表示已存在（show+focus）。
fn open_float_window(app: &tauri::AppHandle, session_id: &str) -> Result<bool, String> {
    use tauri::Manager;
    let label = format!("float-{}", sanitize_label(session_id));
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(false);
    }
    let Some(url_str) = current_web_url() else {
        return Err("web url not ready".into());
    };
    let url = tauri::Url::parse(&url_str).map_err(|e| e.to_string())?;
    let init = format!(
        "window.__DSH_FLOAT__={{sessionId:{:?},win:{:?}}};{}\n\
         window.dshDesktop._onReady(function(){{\
           window.dshDesktop._send('float.ready',{{win:{:?}}});\
         }});",
        session_id, label, BRIDGE_JS, label
    );
    let data_dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("float-webview");
    let mut builder = tauri::webview::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
        .title("DSH 会话")
        .inner_size(900.0, 640.0)
        .min_inner_size(480.0, 360.0)
        .decorations(false)
        .data_directory(data_dir)
        .initialization_script(&init);
    // 独立 data_directory = 独立 WebView2 环境（独立浏览器进程），不继承主窗
    // 的调试参数 —— 显式透传（保持 Tauri 默认禁用项不变；无该环境变量时零差异）。
    if let Ok(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        if !extra.is_empty() {
            builder = builder.additional_browser_args(&format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection {}",
                extra
            ));
        }
    }
    builder
        .build()
        .map_err(|e| e.to_string())?;
    println!("[shell] float window {} created", label);
    Ok(true)
}

async fn handle_conn(stream: TcpStream, state: BridgeState, app: tauri::AppHandle) -> std::io::Result<()> {
    // 先窥探请求头：决定 WS 升级还是极简 HTTP。（peek 取 &self，不消耗流）
    let (req_path, wants_upgrade) = {
        let mut buf = [0u8; 2048];
        let n = stream.peek(&mut buf).await?;
        let head = String::from_utf8_lossy(&buf[..n]).to_string();
        let first = head.lines().next().unwrap_or("");
        let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
        (path, head.to_lowercase().contains("upgrade: websocket"))
    };

    if !wants_upgrade {
        return http_serve(stream, &req_path).await;
    }

    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let (mut sink, mut source) = ws.split();

    // 单一写任务：回复与通知统一经 out_tx 出站（SplitSink 不可克隆）。
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    tauri::async_runtime::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            let _ = sink.send(m).await;
        }
    });

    // sidecar 通知 + 壳层通知 → 出站。
    {
        let mut rx = shell_notify().subscribe();
        let tx = out_tx.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(v) => {
                        let _ = tx.send(Message::Text(v.to_string()));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(sc) = state.sidecar.lock().await.clone() {
        let mut rx = sc.notify_tx.subscribe();
        let tx = out_tx.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(v) => {
                        let _ = tx.send(Message::Text(v.to_string()));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
    }

    while let Some(msg) = source.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        if let Message::Text(txt) = msg {
            let Ok(req) = serde_json::from_str::<Value>(&txt) else { continue };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
            let params = req.get("params").cloned().unwrap_or(Value::Null);
            // 1) 壳层域：本地拦截（窗口/浮窗/菜单壳动作/日志 send 帧）。
            match handle_shell_method(&app, &method, &params, &id).await {
                Ok(Some(reply)) => {
                    let _ = out_tx.send(Message::Text(reply));
                    continue;
                }
                Ok(None) => continue,
                Err(()) => {}
            }
            // 2) 其余 → sidecar。
            let sc = state.sidecar.lock().await.clone();
            let reply = match sc {
                Some(sc) => match sc.call(&method, params).await {
                    Ok(result) => serde_json::json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err(e) => serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":e}}),
                },
                None => serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"sidecar not running"}}),
            };
            let _ = out_tx.send(Message::Text(reply.to_string()));
        }
    }
    Ok(())
}

fn loading_page() -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>Deepseek Harness EAC</title>\
         <body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#0b1220;\
         color:#dfe6ff;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif\">\
         <div style=\"text-align:center\">\
         <div style=\"font-size:20px;font-weight:600;margin-bottom:14px\">Deepseek Harness EAC</div>\
         <div style=\"font-size:13px;color:#8b9ac4\">正在启动服务…</div>\
         <div style=\"margin-top:18px;width:34px;height:34px;margin-left:auto;margin-right:auto;\
         border:3px solid rgba(255,255,255,.12);border-top-color:#5b8cff;border-radius:50%;\
         animation:dshspin 1s linear infinite\"></div></div>\
         <style>@keyframes dshspin{{to{{transform:rotate(360deg)}}}}</style>\
         <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';{}</script>",
        WS_PORT, BRIDGE_JS
    )
}

fn died_page(log_path: &str, code: &str) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        "<!doctype html><meta charset=utf-8><title>服务已停止</title>\
         <body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#0b1220;\
         color:#dfe6ff;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif\">\
         <div style=\"text-align:center;max-width:560px\">\
         <div style=\"font-size:20px;font-weight:600;margin-bottom:10px\">DSH 服务已停止</div>\
         <div style=\"font-size:13px;color:#8b9ac4;margin-bottom:6px\">退出码 {}</div>\
         <div style=\"font-size:12px;color:#5f6f9c;font-family:Consolas,monospace;margin-bottom:20px\">{}</div>\
         <div style=\"display:flex;gap:10px;justify-content:center\">\
         <button onclick=\"retry()\" style=\"padding:8px 22px;border:1px solid rgba(255,255,255,.18);\
         border-radius:9px;background:rgba(91,140,255,.15);color:#dfe6ff;font-size:13px;cursor:pointer\">重新启动</button>\
         <button onclick=\"safeMode()\" style=\"padding:8px 22px;border:1px solid rgba(255,200,120,.25);\
         border-radius:9px;background:rgba(255,180,80,.10);color:#ffd9a3;font-size:13px;cursor:pointer\">安全模式重启</button>\
         </div>\
         </div>\
         <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';{}\
         function retry(){{\
           var b=document.querySelector('button');b.textContent='正在重启…';b.disabled=true;\
           window.dshDesktop._call('boot.start',{{}}).then(function(){{location.reload();}})\
             .catch(function(e){{b.textContent='重启失败，请重试';b.disabled=false;}});\
         }}\
         function safeMode(){{\
           var b=event.target;b.textContent='进入安全模式…';b.disabled=true;\
           window.dshDesktop._call('rescue.safe-mode',{{on:true}}).then(function(){{\
             return window.dshDesktop._call('boot.start',{{}});\
           }}).then(function(){{location.reload();}})\
             .catch(function(e){{b.textContent='失败（服务可能仍在运行）';b.disabled=false;}});\
         }}</script></body>",
        esc(code),
        esc(log_path),
        WS_PORT,
        BRIDGE_JS
    )
}

/// 退出选择页（= Electron askExitAction 弹窗的三选 + 记住选择）。
fn exit_page() -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>退出 Deepseek Harness</title>\
         <body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#0b1220;\
         color:#dfe6ff;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif\">\
         <div style=\"text-align:center;max-width:420px;padding:28px 32px;border:1px solid rgba(255,255,255,.08);\
         border-radius:16px;background:color-mix(in srgb,#0b1220 92%,white)\">\
         <div style=\"font-size:19px;font-weight:600;margin-bottom:8px\">退出 Deepseek Harness</div>\
         <div style=\"font-size:12.5px;color:#8b9ac4;margin-bottom:20px\">后台运行时窗口会隐藏到系统托盘，任务完成后会发通知。</div>\
         <div style=\"display:flex;flex-direction:column;gap:10px\">\
         <button data-v=\"minimize\" style=\"padding:10px;border:1px solid rgba(255,255,255,.14);border-radius:10px;\
           background:rgba(91,140,255,.14);color:#dfe6ff;font-size:13.5px;cursor:pointer\">最小化到后台</button>\
         <button data-v=\"quit\" style=\"padding:10px;border:1px solid rgba(255,120,133,.25);border-radius:10px;\
           background:rgba(232,17,35,.10);color:#ffb3ba;font-size:13.5px;cursor:pointer\">退出程序</button>\
         <button data-v=\"cancel\" style=\"padding:8px;border:none;border-radius:10px;background:transparent;\
           color:#8b9ac4;font-size:12.5px;cursor:pointer\">取消</button>\
         </div>\
         <label style=\"display:flex;align-items:center;justify-content:center;gap:6px;margin-top:16px;\
           font-size:12px;color:#8b9ac4;cursor:pointer\">\
           <input type=\"checkbox\" id=\"remember\" /> 记住我的选择，不再询问</label>\
         </div>\
         <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';{}\
         document.querySelectorAll('button[data-v]').forEach(function(b){{\
           b.addEventListener('click',function(){{\
             var v=b.getAttribute('data-v');\
             var remember=document.getElementById('remember').checked;\
              if (v==='cancel') {{ window.dshDesktop._call('win.close-dialog',{{}}); return; }}\
              var fin=function(){{ window.dshDesktop._call(v==='quit'?'win.close-force':'win.hide-and-close-dialog',{{}}); }};\
             if (remember) {{ window.dshDesktop.menu.action('set-exit-action',{{value:v}}).then(fin).catch(fin); }}\
             else fin();\
           }});\
         }});</script></body>",
        WS_PORT, BRIDGE_JS
    )
}

/// 主窗导航助手（壳页打开/返回共用；show + navigate 原子化到主线程）。
fn navigate_main(app: &tauri::AppHandle, href: String) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri::Manager;
        if let Some(win) = app2.get_webview_window("main") {
            let _ = win.show();
            if let Ok(parsed) = tauri::Url::parse(&href) {
                let _ = win.navigate(parsed);
            }
        }
    });
}

/// back 查询参数编码（与 /died 的 log 参数同规则；页面侧 URLSearchParams 解码）。
fn encode_back(url: &str) -> String {
    url.replace('\\', "%5C").replace(':', "%3A").replace('/', "%2F").replace(' ', "+")
}

/// 更新进度页（client-update.show / agent 更新共用；进度经 _onNotify 渲染）。
fn update_page(version: &str, kind: &str) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        "<!doctype html><meta charset=utf-8><title>正在更新</title>\
         <body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#0b1220;\
         color:#dfe6ff;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif\">\
         <div style=\"text-align:center;max-width:520px;width:82%\">\
         <div style=\"font-size:19px;font-weight:600;margin-bottom:8px\">正在更新 {0}</div>\
         <div style=\"font-size:12.5px;color:#8b9ac4;margin-bottom:22px\">v{3} · 更新完成后应用会自动重启；插件、皮肤与会话全部保留。</div>\
         <div style=\"height:8px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden\">\
         <div id=fill style=\"height:100%;width:0%;border-radius:6px;background:#5b8cff;transition:width .3s\"></div></div>\
         <div id=status style=\"margin-top:14px;font-size:12.5px;color:#8b9ac4;font-family:Consolas,monospace\">准备中…</div>\
         </div>\
         <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{1}/ws';{2}\
         var BACK=new URLSearchParams(location.search).get('back')||'';\
         window.dshDesktop._onNotify(function(m,p){{\
           if (m==='client-update.progress'){{\
             if (p && p.channel==='client' && p.total>0){{\
               var pct=Math.max(0,Math.min(100,Math.round(p.received*100/p.total)));\
               document.getElementById('fill').style.width=pct+'%';\
               var extra='';\
               if (p.speedMBps) extra=' · '+p.speedMBps.toFixed(1)+' MB/s';\
               if (p.etaSec && isFinite(p.etaSec) && p.etaSec>0){{var s=Math.round(p.etaSec);extra+=' · 剩余 '+(s>=60?Math.floor(s/60)+' 分 '+(s%60)+' 秒':s+' 秒');}}\
               document.getElementById('status').textContent='正在下载 '+pct+'%'+extra;\
             }} else if (p && p.stage){{\
               document.getElementById('status').textContent=p.stage;\
             }}\
           }} else if (m==='client-update.hide'){{\
             if (BACK) location.replace(BACK);\
           }}\
         }});</script></body>",
        if kind == "agent" { "dsh 内核" } else { "Deepseek Harness EAC" },
        WS_PORT,
        BRIDGE_JS,
        esc(version),
    )
}

/// 关于页（menu.action 'about'；版本经 chrome.init 动态读取）。
fn about_page() -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>关于</title>\
         <body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#0b1220;\
         color:#dfe6ff;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif\">\
         <div style=\"text-align:center;max-width:460px;padding:30px 38px;border:1px solid rgba(255,255,255,.08);\
         border-radius:16px;background:color-mix(in srgb,#0b1220 92%,white)\">\
         <div style=\"font-size:20px;font-weight:600;margin-bottom:6px\">Deepseek Harness EAC</div>\
         <div id=ver style=\"font-size:13px;color:#8b9ac4;margin-bottom:14px\">读取版本中…</div>\
         <div style=\"font-size:12px;color:#5f6f9c;line-height:1.8\">Tauri 壳（Rust L1）· Node sidecar（L2）· dsh 内核零改动（L3）<br/>\
         本项目为社区增强封装，与官方 DeepSeek 无隶属关系。</div>\
         <button onclick=\"if(BACK)location.replace(BACK)\" style=\"margin-top:20px;padding:8px 26px;border:1px solid rgba(255,255,255,.18);\
         border-radius:9px;background:rgba(91,140,255,.15);color:#dfe6ff;font-size:13px;cursor:pointer\">返回</button>\
         </div>\
         <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';{}\
         var BACK=new URLSearchParams(location.search).get('back')||'';\
         window.dshDesktop._call('chrome.init',{{}}).then(function(i){{\
           document.getElementById('ver').textContent='封装 v'+i.appVersion+' · dsh 内核 '+i.agentVersion+'（'+(i.agentSource||'bundled')+'）';\
         }}).catch(function(){{document.getElementById('ver').textContent='版本信息暂不可用';}});</script></body>",
        WS_PORT, BRIDGE_JS
    )
}

/// 向导页：serve 真实 assets/onboarding.html，注入桥 + window.onboarding shim
/// （对齐 onboarding-preload.js 的 list/submit/close 三键），并隐藏页面自绘标题栏
/// （窗口控制由桥的 36px 玻璃栏承担）。
fn wizard_page() -> String {
    let file = resource_root().join("dsh-desktop").join("assets").join("onboarding.html");
    let html = std::fs::read_to_string(&file).unwrap_or_else(|_| {
        "<!doctype html><meta charset=utf-8><title>向导</title><body style=\"background:#0b1220;color:#dfe6ff;font-family:sans-serif;display:grid;place-items:center;height:100vh\">向导资源缺失（assets/onboarding.html）</body>".to_string()
    });
    let injection = format!(
        "<script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';{};\
         window.onboarding={{\
           list:function(){{return window.dshDesktop._call('onboard.list',{{}});}},\
           submit:function(ids){{return window.dshDesktop._call('onboard.submit',{{ids:ids}});}},\
           close:function(){{window.dshDesktop._call('onboard.close',{{}});}}\
         }};</script>\
         <style>.bar{{display:none!important}}</style>",
        WS_PORT, BRIDGE_JS
    );
    let marker = "<meta charset=\"utf-8\" />";
    if html.contains(marker) {
        html.replacen(marker, &format!("{}{}", marker, injection), 1)
    } else {
        format!("{}{}", injection, html)
    }
}

async fn http_serve(mut stream: TcpStream, path: &str) -> std::io::Result<()> {
    eprintln!("[http] serve {}", path);
    // 真正消费请求头（读到空行）：未读数据残留会让连接以 RST 而非 FIN 收尾，
    // WebView2 视为响应中断并反复重试（/exit 加载卡死的根因）。
    {
        use tokio::io::AsyncReadExt;
        let mut consumed = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        loop {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            if consumed.len() + n > 64 * 1024 {
                break; // 头部异常超长，防御性放行
            }
            consumed.extend_from_slice(&chunk[..n]);
            if consumed.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
    }
    let (body, ctype) = if path.starts_with("/inject/bridge.js") {
        (BRIDGE_JS.to_string(), "application/javascript")
    } else if path.starts_with("/loading") {
        (loading_page(), "text/html; charset=utf-8")
    } else if path.starts_with("/exit") {
        (exit_page(), "text/html; charset=utf-8")
    } else if path.starts_with("/update") {
        // /update?v=..&kind=..（client-update.show 通知方拼好）
        let mut version = String::new();
        let mut kind = "client".to_string();
        if let Some(q) = path.split_once('?') {
            for kv in q.1.split('&') {
                if let Some((k, v)) = kv.split_once('=') {
                    let v = v.replace("%3A", ":").replace("%5C", "\\").replace("%2F", "/").replace('+', " ");
                    if k == "v" {
                        version = v;
                    } else if k == "kind" {
                        kind = v;
                    }
                }
            }
        }
        (update_page(&version, &kind), "text/html; charset=utf-8")
    } else if path.starts_with("/about") {
        (about_page(), "text/html; charset=utf-8")
    } else if path.starts_with("/wizard") {
        (wizard_page(), "text/html; charset=utf-8")
    } else if path.starts_with("/died") {
        // /died?code=..&log=..（查询参数由 boot.server-died 处理方拼好）
        let mut code = "unknown".to_string();
        let mut log = "".to_string();
        if let Some(q) = path.split_once('?') {
            for kv in q.1.split('&') {
                if let Some((k, v)) = kv.split_once('=') {
                    let v = v.replace("%3A", ":").replace("%5C", "\\").replace("%2F", "/").replace('+', " ");
                    if k == "code" {
                        code = v;
                    } else if k == "log" {
                        log = v;
                    }
                }
            }
        }
        (died_page(&log, &code), "text/html; charset=utf-8")
    } else {
        let page = format!(
            "<!doctype html><meta charset=utf-8><title>DSH EAC Shell</title>\
             <body style=\"font-family:Consolas,monospace;background:#0b1220;color:#dfe6ff\">\
             <h3>DSH EAC — Tauri ShellHost</h3><pre id=out>connecting…</pre>\
             <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';{}</script>",
            WS_PORT, BRIDGE_JS
        );
        (page, "text/html; charset=utf-8")
    };
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        ctype,
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

fn run_bridge_test() -> i32 {
    println!("[bridge] node = {}", resolve_node());
    println!("[bridge] sidecar = {}", sidecar_script().display());
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let code = rt.block_on(async move {
        let mut sc = match Sidecar::spawn().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[bridge] FAIL spawn: {}", e);
                return 1;
            }
        };
        let checks: Vec<(&str, Value, Box<dyn Fn(&Value) -> bool>)> = vec![
            ("ping", serde_json::json!({}), Box::new(|r: &Value| r.get("pong") == Some(&serde_json::json!(true)))),
            (
                "shell.info",
                serde_json::json!({}),
                Box::new(|r: &Value| r.get("sidecar") == Some(&serde_json::json!("server.ts"))),
            ),
            (
                "profile.name",
                serde_json::json!({}),
                Box::new(|r: &Value| r.get("name") == Some(&serde_json::json!("web-desktop"))),
            ),
            (
                "plugins.removedIds",
                serde_json::json!({}),
                Box::new(|r: &Value| r.get("ids").map(|v| v.is_object()).unwrap_or(false)),
            ),
        ];
        let mut ok = 0;
        for (name, params, check) in &checks {
            match sc.call(name, params.clone()).await {
                Ok(r) => {
                    println!("[bridge] {:<20} -> {}", name, r);
                    if check(&r) {
                        ok += 1;
                    } else {
                        eprintln!("[bridge] {} CHECK-FAIL", name);
                    }
                }
                Err(e) => eprintln!("[bridge] {} FAIL: {}", name, e),
            }
        }
        let _ = sc.call("shutdown", serde_json::json!({})).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        sc.kill().await;
        println!("[bridge] {}/{} checks passed", ok, checks.len());
        if ok == checks.len() {
            0
        } else {
            1
        }
    });
    code
}

#[tauri::command]
fn shell_ping() -> serde_json::Value {
    serde_json::json!({ "pong": true, "shell": "tauri", "pid": std::process::id() })
}

#[tauri::command]
async fn sidecar_call(method: String, params: Value) -> Result<Value, String> {
    let state = BRIDGE.get_or_init(|| BridgeState {
        sidecar: Arc::new(AMutex::new(None)),
    });
    let sc = state.sidecar.lock().await.clone();
    match sc {
        Some(sc) => sc.call(&method, params).await,
        None => Err("sidecar not running".into()),
    }
}

static BRIDGE_ONCE: std::sync::Once = std::sync::Once::new();
static BRIDGE: std::sync::OnceLock<BridgeState> = std::sync::OnceLock::new();

/// sidecar 通知 → 壳层响应（主线程执行窗口操作）。
fn handle_sidecar_notify(app: &tauri::AppHandle, v: &Value) {
    let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "boot.web-ready" => {
            if let Some(url) = params.get("webUrl").and_then(|u| u.as_str()) {
                set_current_web_url(url);
                println!("[shell] web-ready → navigate: {}", url);
                let url = url.to_string();
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    use tauri::Manager;
                    if let Some(win) = app2.get_webview_window("main") {
                        if let Ok(parsed) = tauri::Url::parse(&url) {
                            let _ = win.navigate(parsed);
                        }
                    }
                });
            }
        }
        "boot.server-died" => {
            let code = params.get("code").map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
            let log = params.get("logPath").and_then(|l| l.as_str()).unwrap_or("").to_string();
            println!("[shell] server-died code={} log={}", code, log);
            let href = format!(
                "http://127.0.0.1:{}/died?code={}&log={}",
                WS_PORT,
                code,
                log.replace('\\', "%5C").replace(':', "%3A").replace('/', "%2F").replace(' ', "+")
            );
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(win) = app2.get_webview_window("main") {
                    let _ = win.show();
                    if let Ok(parsed) = tauri::Url::parse(&href) {
                        let _ = win.navigate(parsed);
                    }
                }
            });
        }
        // ---- P4：更新链 / 关于页 / 向导（sidecar 通知 → 壳导航） ----
        "client-update.show" => {
            let version = params.get("version").and_then(|v| v.as_str()).unwrap_or("");
            let kind = params.get("kind").and_then(|k| k.as_str()).unwrap_or("client");
            println!("[shell] update window show v={} kind={}", version, kind);
            let back = current_web_url().map(|u| encode_back(&u)).unwrap_or_default();
            navigate_main(app, format!("http://127.0.0.1:{}/update?v={}&kind={}&back={}", WS_PORT, encode_back(version), encode_back(kind), back));
        }
        "client-update.hide" => {
            if let Some(url) = current_web_url() {
                navigate_main(app, url);
            }
        }
        "shell.about" => {
            let back = current_web_url().map(|u| encode_back(&u)).unwrap_or_default();
            navigate_main(app, format!("http://127.0.0.1:{}/about?back={}", WS_PORT, back));
        }
        "wizard.show" => {
            println!("[shell] wizard show mode={:?}", params.get("mode"));
            let back = current_web_url().map(|u| encode_back(&u)).unwrap_or_default();
            navigate_main(app, format!("http://127.0.0.1:{}/wizard?back={}", WS_PORT, back));
        }
        "wizard.close" => {
            if let Some(url) = current_web_url() {
                navigate_main(app, url);
            }
        }
        "shell.relaunch" => {
            // agent 更新完成后整壳重启（Tauri restart 会退出并重新拉起自身）。
            println!("[shell] relaunch requested (agent update)");
            app.restart();
        }
        "shell.quit-for-update" => {
            // 客户端更新交接：更新助手已 detached，壳整体优雅退出
            // （ExitRequested 钩子会同步有界关停 sidecar/dsh web）。
            println!("[shell] quit requested (client update handoff)");
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                app2.exit(0);
            });
        }
        _ => {}
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--bridge-test") {
        std::process::exit(run_bridge_test());
    }

    let state = BRIDGE.get_or_init(|| BridgeState {
        sidecar: Arc::new(AMutex::new(None)),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：聚焦已有主窗（= Electron second-instance 行为）。
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            // 关闭可能残留的退出弹窗
            if let Some(d) = app.get_webview_window(EXIT_DIALOG_LABEL) {
                let _ = d.close();
            }
        }))
        .invoke_handler(tauri::generate_handler![shell_ping, sidecar_call])
        .setup(move |app| {
            use tauri::Manager;

            BRIDGE_ONCE.call_once(|| {
                let st = BridgeState {
                    sidecar: state.sidecar.clone(),
                };
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match Sidecar::spawn().await {
                        Ok(sc) => {
                            let mut notify = sc.notify_tx.subscribe();
                            *st.sidecar.lock().await = Some(Arc::new(sc));
                            println!("[shell] sidecar ready");

                            // sidecar 通知 → 壳层（导航/恢复页）
                            let app_notify = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                loop {
                                    match notify.recv().await {
                                        Ok(v) => handle_sidecar_notify(&app_notify, &v),
                                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                                        Err(_) => break,
                                    }
                                }
                            });

                            // 主窗：先加载壳层 /loading 页（即起即见）。
                            let app_win = app_handle.clone();
                            let app_win_inner = app_win.clone();
                            let _ = app_win.run_on_main_thread(move || {
                                let app_win = app_win_inner;
                                let loading = format!("http://127.0.0.1:{}/loading", WS_PORT);
                                if let Ok(url) = tauri::Url::parse(&loading) {
                                    let built = tauri::webview::WebviewWindowBuilder::new(
                                        &app_win,
                                        "main",
                                        tauri::WebviewUrl::External(url),
                                    )
                                    .title("Deepseek Harness EAC")
                                    .inner_size(1400.0, 900.0)
                                    .min_inner_size(960.0, 640.0)
                                    .decorations(false)
                                    .initialization_script(BRIDGE_JS);
                                    if let Err(e) = built.build() {
                                        eprintln!("[shell] main window build failed: {}", e);
                                    }
                                }
                            });

                            // boot.start：拉起 dsh web → webUrl（通知处理器负责导航；
                            // 这里显式再导航一次，兜底通知竞态）。
                            let st2 = BridgeState { sidecar: st.sidecar.clone() };
                            let app_nav = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                let sc = st2.sidecar.lock().await.clone();
                                let Some(sc) = sc else { return };
                                match sc.call("boot.start", serde_json::json!({})).await {
                                    Ok(r) => {
                                        let url = r.get("webUrl").and_then(|u| u.as_str()).unwrap_or("").to_string();
                                        println!("[shell] boot.start ok: {}", url);
                                        if !url.is_empty() {
                                            set_current_web_url(&url);
                                            let app3 = app_nav.clone();
                                            let _ = app_nav.run_on_main_thread(move || {
                                                use tauri::Manager;
                                                if let Some(win) = app3.get_webview_window("main") {
                                                    if let Ok(parsed) = tauri::Url::parse(&url) {
                                                        let _ = win.navigate(parsed);
                                                    }
                                                }
                                            });
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[shell] boot.start failed: {}", e);
                                        let msg = e.replace('"', "'").replace('\n', " ");
                                        let href = format!(
                                            "http://127.0.0.1:{}/died?code=boot&log={}",
                                            WS_PORT, msg
                                        );
                                        let app3 = app_nav.clone();
                                        let _ = app_nav.run_on_main_thread(move || {
                                            use tauri::Manager;
                                            if let Some(win) = app3.get_webview_window("main") {
                                                let _ = win.show();
                                                if let Ok(parsed) = tauri::Url::parse(&href) {
                                                    let _ = win.navigate(parsed);
                                                }
                                            }
                                        });
                                    }
                                }
                            });

                            serve_ws(st, app_handle).await;
                        }
                        Err(e) => eprintln!("[shell] sidecar spawn failed: {}", e),
                    }
                });
            });

            // 托盘（L1）：对齐 Electron 托盘全项（显示/隐藏、重启服务、反馈、退出）。
            let app_handle = app.handle().clone();
            let show = tauri::menu::MenuItem::with_id(app, "show", "显示 / 隐藏窗口", true, None::<&str>)?;
            let restart = tauri::menu::MenuItem::with_id(app, "restart", "重启 Web 服务", true, None::<&str>)?;
            let feedback = tauri::menu::MenuItem::with_id(app, "feedback", "反馈建议", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &sep1, &restart, &sep2, &feedback, &quit])?;
            let mut tray = tauri::tray::TrayIconBuilder::new()
                .tooltip("Deepseek Harness EAC")
                .menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(move |app, event| match event.id.as_ref() {
                "show" => {
                    if let Some(win) = app.get_webview_window("main") {
                        if win.is_visible().unwrap_or(true) {
                            let _ = win.hide();
                            // 联动隐藏退出弹窗
                            if let Some(d) = app.get_webview_window(EXIT_DIALOG_LABEL) {
                                let _ = d.hide();
                            }
                        } else {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                }
                "restart" => {
                    let st = BridgeState {
                        sidecar: BRIDGE.get_or_init(|| BridgeState {
                            sidecar: Arc::new(AMutex::new(None)),
                        })
                        .sidecar
                        .clone(),
                    };
                    tauri::async_runtime::spawn(async move {
                        let sc = st.sidecar.lock().await.clone();
                        if let Some(sc) = sc {
                            match sc.call("boot.restart", serde_json::json!({})).await {
                                Ok(r) => println!("[tray] restart: {}", r),
                                Err(e) => eprintln!("[tray] restart failed: {}", e),
                            }
                        }
                    });
                }
                "feedback" => {
                    open_external("https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues");
                }
                "quit" => app_handle.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                // 单击切换窗口可见性（= Electron tray.on('click')）。
                if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                    let app = tray.app_handle().clone();
                    if let Some(win) = app.get_webview_window("main") {
                        if win.is_visible().unwrap_or(true) && win.is_focused().unwrap_or(false) {
                            let _ = win.hide();
                            // 联动隐藏退出弹窗
                            if let Some(d) = app.get_webview_window(EXIT_DIALOG_LABEL) {
                                let _ = d.hide();
                            }
                        } else {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                }
            })
            .build(app)?;
            println!("[shell] tray ready");
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // 主窗关闭 → exitAction 策略（minimize/quit/ask 选择页）；浮窗真关闭。
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        use tauri::Manager;
                        let app = window.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            apply_exit_policy(&app, true).await;
                        });
                    }
                    // exit-dialog 窗口：默认行为直接关闭
                }
                // 最大化状态变化 → win.maximized 通知（桥 onMaximizeChange 消费）。
                tauri::WindowEvent::Resized(_) => {
                    if window.label() == "main" {
                        let m = window.is_maximized().unwrap_or(false);
                        if LAST_MAXIMIZED.swap(m, Ordering::SeqCst) != m {
                            let _ = shell_notify().send(serde_json::json!({
                                "method": "win.maximized",
                                "params": { "maximized": m }
                            }));
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // 优雅退出（同步有界，事件循环内完成，杜绝「调度后进程先退」的孤儿）：
                // shutdown RPC → sidecar 有界回收 dsh web 进程树 → 兜底 kill。
                let state = BRIDGE.get_or_init(|| BridgeState {
                    sidecar: Arc::new(AMutex::new(None)),
                });
                let st = BridgeState { sidecar: state.sidecar.clone() };
                let _ = tauri::async_runtime::block_on(async move {
                    let sc = st.sidecar.lock().await.clone();
                    if let Some(sc) = sc {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            sc.call("shutdown", serde_json::json!({})),
                        )
                        .await;
                        // gracefulExit 内含 stopServer（grace 1.2s + hard 4s 有界）。
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        if let Some(mut owned) = Arc::into_inner(sc) {
                            owned.kill().await;
                        }
                    }
                });
                println!("[shell] sidecar reaped; exiting");
            }
        });
}

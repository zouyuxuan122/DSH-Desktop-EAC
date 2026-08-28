use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();
    // 窗口桥单源打包：把 WS 回环客户端（assets/ws-jsonrpc-client.js，与
    // 恢复中心窗同源）拼到 tsc 产物 sidecar/bridge.js 之前，产出
    // OUT_DIR/bridge-bundle.js 供 main.rs include_str! 统一注入 —— 所有
    // 注入点（主窗/浮窗/壳层页/HTTP /inject/bridge.js）一次带上客户端，
    // 保证 window.__DSH_WS_RPC__ 先于桥胶水就位。
    println!("cargo:rerun-if-changed=sidecar/bridge.js");
    println!("cargo:rerun-if-changed=../dsh-desktop/assets/ws-jsonrpc-client.js");
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let ws = fs::read_to_string(manifest.join("..").join("dsh-desktop").join("assets").join("ws-jsonrpc-client.js"))
        .expect("assets/ws-jsonrpc-client.js missing（单源 WS 客户端）");
    let bridge = fs::read_to_string(manifest.join("sidecar").join("bridge.js"))
        .expect("sidecar/bridge.js missing（先跑 dsh-desktop 的 npm run build）");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("bridge-bundle.js");
    fs::write(&out, format!("{}\n{}\n", ws, bridge)).expect("write bridge-bundle.js");
}
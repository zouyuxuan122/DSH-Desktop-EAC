fn main() {
    tauri_build::build();
    // tauri-build 只给 bin 目标内嵌 Common-Controls v6 manifest；lib 单测 harness
    // 没有 manifest 时 comctl32 解析到 v5，缺 TaskDialogIndirect 导入，
    // 测试二进制直接 STATUS_ENTRYPOINT_NOT_FOUND 起不来。对全部链接目标补
    // manifest 依赖声明（bin 已有内嵌 manifest，此声明与之共存无冲突）。
    println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='Win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' publicKeyToken='6595b64144ccf1df' language='*' processorArchitecture='*'");
}

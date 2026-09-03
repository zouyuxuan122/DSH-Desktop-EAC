# 构建 DSHEAC AIO v1

## 支持范围

- Windows 10/11 x64
- PowerShell 5.1+
- Node.js / npm（仅构建机）
- Rust stable + MSVC x64 工具链
- Windows SDK 与 Visual Studio C++ Build Tools
- 可访问 npm、Cargo 与 Tauri/NSIS/WebView2 构建资源的网络环境；依赖已缓存时可部分离线

版型为 `AIO`（All-in-One），用户可见版本为 `v1`，当前内部 SemVer 为 `1.1.0`。

## 一键发布构建

```powershell
npm ci
npm --prefix tauri-app ci
$env:DSH_PROFILE_SEED_DIR = 'D:\reviewed\profile-seed'
npm run dist
```

主要步骤：

1. 校验 `SOURCE_BASELINE.txt` 或 Git commit；
2. 结构化脱敏 `distribution/profile-seed`；
3. `npm ci` 安装锁定的 Tauri JS 工具链；
4. sidecar TypeScript 类型检查与编译；
5. staging 生产依赖、Node/npm、assets 与 profile seed；
6. 在 staging 中裁剪 `.map`、`.pdb`、`win32-arm64`、`win10-arm64`；
7. 串行运行全部重构版 JavaScript 测试；
8. `cargo test --locked`；
9. Tauri/NSIS 打包；
10. 生成便携归档和 SHA-256 清单并复核。

## 产物

```text
dist/
├── DSHEAC-AIO-v1-Setup-x64.exe
├── portable/
│   ├── DSHEAC-AIO-v1-Portable-x64.zip
│   └── SHA256SUMS.txt
└── SHA256SUMS.txt
```

便携归档不包含构建期文件，例如：

- `.git`；
- `tauri-app/target`；
- `tauri-app/resources` staging；
- 本地插件 `dist` 目录中的预构建安装器；
- 本地插件 source map。

这些排除项不属于运行时，能显著降低便携包体积和解压时间。

## 安装 E2E

```powershell
powershell -NoProfile -File .\scripts\verify-aio-installer.ps1
```

可调超时：

```powershell
.\scripts\verify-aio-installer.ps1 `
  -InstallTimeoutSeconds 300 `
  -StartupTimeoutSeconds 240 `
  -UninstallTimeoutSeconds 180
```

验证报告无论 PASS/FAIL 都会写入 `verification/verification-*.json`。

## 手工开发检查

```powershell
npm.cmd --prefix .\tauri-app ci
npm.cmd --prefix .\tauri-app run sidecar:check
npm.cmd --prefix .\tauri-app run sidecar:build
node --test --test-concurrency=1 .\test\*.test.mjs
cargo test --locked --manifest-path .\tauri-app\Cargo.toml
node .\boot-smoke.js
node .\gui-smoke.js
node .\update-smoke.js
node .\tauri-shell\make-portable.mjs
```

## 可复现性边界

依赖版本由 npm lockfile 与 Cargo.lock 约束，但以下输入仍可能导致字节级安装包不同：

- Rust/LLVM/MSVC/Windows SDK 版本；
- Tauri 下载的 NSIS 与 WebView2 离线安装器版本；
- PE/NSIS 时间戳；
- 未固定哈希的预置 Node/npm/profile seed 二进制树。

因此当前目标是“功能与 payload 可重建”，不是尚未证明的字节级 reproducible build。发布者应记录工具链版本，并在独立目录重复构建后比较 staging manifest。

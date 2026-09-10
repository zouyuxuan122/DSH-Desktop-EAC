# DSHEAC AIO v1

`DSHEAC AIO`（**All-in-One**）是基于 DSH-Desktop-EAC `v4.5-lite` 源码基线重构的 Windows x64 一体化桌面发行版。AIO 指安装包整合 Tauri 原生壳、Node.js、npm、`@deepseek-ai/dsh`、当前配套插件和经脱敏的首次运行 profile，目标机器无需预装 Node.js。

> **版型：AIO（All-in-One）**
>
> **用户可见版本：EAC 9.6.3**
>
> 机器内部 SemVer：`9.6.3`
>
> DSH 内核：`@deepseek-ai/dsh` `0.1.5-rc.2`

本分支是 AIO-v1 的可审计发行线，吸收主仓库已验证的启动保护、插件治理和皮肤系统；它不是把主仓库全部历史插件重新打包。

AIO 不表示包含上游项目所有历史功能；实际功能以本仓库打包的运行时、插件和 profile 清单为准。

## 状态

本仓库面向可审计、可重建和隔离验证，不宣称由 DeepSeek 官方发布或背书。`DeepSeek`、`DSH` 及相关名称和标识归其权利人所有。

发布前必须同时通过：

1. 全部 AIO JavaScript 测试；
2. sidecar TypeScript 类型检查；
3. Rust `cargo test --locked`；
4. Tauri/NSIS 构建；
5. 安装、首启、profile 脱敏、共存、卸载及残留验证。

## 功能边界

- Windows 10/11 x64；
- Tauri 2 / WRY / WebView2 原生窗口；
- 内置 Node.js、npm CLI 和 DSH 生产依赖闭包；
- 内置当前插件与技能 profile seed；
- 内置主仓库皮肤切换基础设施和 9 套首启可选皮肤（`maid-atelier` 资产保留但暂不自动注册）；
- 内置 Community `dsh-plugin.json` v0.15 清单，插件与皮肤入口按 `dsh-ecosystem-spec` 校验；
- 插件更新支持 npm/GitHub 来源、版本门槛、保护快照和失败回退，自动更新默认关闭；
- 离线 WebView2 安装器；
- 独立产品标识 `com.deepseek.dsh.desktop.aio`；
- 独立应用数据和 DSH_HOME，不修改原 v4Lite、旧 EAC、5.x 或 CLI 数据；
- 旧版数据导入默认关闭，只有显式设置 `DSH_AIO_IMPORT_LEGACY=1` 才启用；
- 正式发布入口仅为 Tauri；Electron 命令保留在 `legacy:electron:*` 命名空间，不用于 AIO Release。

## 安装

发布产物（EAC 9.6.3）：

- `dist/DSHEAC-AIO-v1-Setup-x64.exe`
- `dist/portable/DSHEAC-AIO-v1-Portable-x64.zip`
- `dist/SHA256SUMS.txt`

安装包目前未签名。Windows SmartScreen 可能提示未知发布者；运行前请核对 SHA-256。

### 从 EAC 5.3.6 更新

安装器沿用同一产品标识和安装根目录。首次启动 9.6.3 时，Tauri 会在同一
磁盘内原子接管 `%APPDATA%/com.deepseek.dsh.desktop.aio/releases/5.3.6`
到 `releases/9.6.3`，再按新的内核与 profile seed 重建桌面插件层；会话、附件、
provider 凭据和用户设置保留，旧插件行不会直接带入。若旧目录被占用，程序会
暂时使用旧数据根继续启动，不会静默创建空白用户环境。

## 从源码构建

详见 [BUILDING.md](BUILDING.md)。标准命令：

```powershell
$env:DSH_PROFILE_SEED_DIR = 'D:\reviewed\profile-seed'
npm run dist
```

## 安装验证

```powershell
powershell -NoProfile -File .\scripts\verify-aio-installer.ps1
```

验证会安装到包含中文和空格的独立目录，使用隔离数据启动，确认服务端口属于本轮应用进程树，检查插件/技能 seed 与隐私排除，然后静默卸载并检查进程、端口和安装目录残留。

## 隐私边界

发行 seed 明确排除凭据、会话、记忆、附件、浏览器 profile、日志、usage 数据，以及原用户模型/provider/权限和个人 preset 选择。个人化状态文案已替换为中性公共默认值；构建时 `sanitize-public-seed.mjs` 会删除含本机绝对路径的包管理器状态文件，并全树扫描原工作区、用户目录、`.dsh-v4lite` 与 pnpm store 痕迹。上传前仍需人工复核。

## 本轮工程改进

- 产品名统一为 `DSHEAC AIO`，发行版本统一为 `9.6.3`，内核统一为 `0.1.5-rc.2`；
- 清理重复的市场/皮肤注册路径：皮肤只由 `dsh-skin-switch` companion-sync 管理，皮肤行默认禁用并保持互斥；
- 保留 AIO 的 Tauri/sidecar 隔离边界，不接入主仓库 Electron 客户端自更新；应用自更新仍走受控发行安装包流程；
- 修复损坏 agent overlay 启动前探测、隔离和健康确认，避免坏覆盖层永久阻断内核；
- 安全模式使用 profile-local marker，重启期间不会把完整插件集偷偷重新写回；
- profile 升级接受内核生成的共享依赖链接，同时拒绝越界、错误名称、悬空和循环链接；
- 所有内置插件与皮肤带协议 manifest，更新源与实际可更新插件保持一致；
- 修复 Node `fs.cpSync` 在当前中文长路径工作区中以 `0xC0000409` 崩溃；
- staging 仅对发布树裁剪 `.map`、`.pdb` 和 ARM64 预编译件；
- 停用可读取任意绝对路径、且无调用方的壳层预览端口；
- DSH Web UI 只在刚启动子进程输出 ready URL 后建立可信 origin；
- Tauri IPC 统一执行“main 窗口 + 运行时受信 origin”校验；
- 外链不再拼接 PowerShell 命令；
- 发布构建不再排除关键测试，并加入产物新鲜度与哈希复核；
- 安装验证增加 Unicode 路径、耗时、进程树端口归属、卸载与残留检查。

## 性能说明

AIO profile seed 包含大量小文件，安装时仍会受到磁盘和杀毒软件逐文件扫描影响。当前干净 sidecar 测试中的 profile 初始化约为 0.9 秒；staging 发布裁剪减少了 6797 个调试/source map 文件和 73.1 MiB 未压缩体积。最终安装速度仍以本机正式安装包 E2E 计时为准。

## 文档

- [BUILDING.md](BUILDING.md)
- [SECURITY.md](SECURITY.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [AUDIT.md](AUDIT.md)
- [AIO 插件审计与修复记录](docs/aio-v1-plugin-audit-20260910.md)

## 许可证

项目基线沿用 MIT License，见 [LICENSE](LICENSE)。第三方运行时、依赖、插件、皮肤和资源各自适用其原许可证；MIT 不自动覆盖第三方内容。

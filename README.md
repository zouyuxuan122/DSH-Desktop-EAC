# EAC LAUNCHER — DSH EAC 多实例启动器

黑白极简 · 多实例隔离 · 插件市场一体的 [Deepseek Harness EAC（揽尽万象）](https://github.com/zouyuxuan122/DSH-Desktop-EAC) 桌面启动器。

Tauri 2 + TypeScript（vanilla，无 UI 框架）构建，安装包约 8 MB。

## 特性

- **多实例隔离**：每个实例拥有独立的程序目录与 `DSH_HOME` 数据目录，会话、API Key、插件互不干扰，可并排运行。
- **两种版本产物**：
  - **完整版（FULL）**：上游 Release 的便携 zip，SHA256 校验后静默解压进实例目录；
  - **Lite 版（LITE）**：Tauri 轻量壳 NSIS 安装包，静默安装至 ASCII 暂存目录后移入实例（规避 NSIS `/D=` 引号怪癖与上游对中文路径的编码缺陷）。
- **本地实例导入**：选择 EAC 壳 exe 所在目录即可原地接管已有安装（自动识别完整版/Lite 布局与版本，不移动、不修改文件）；导入实例删除时仅移除记录。
- **版本管理**：向导可选历史版本（降级）；实例详情一键升级 / 降级（只换程序目录，`DSH_HOME` 数据与插件保留，旧版本自动存为 `app.bak-*`）与对称回退；启动时后台检查上游新版本并提示。
- **插件市场**：集成 [dsh-plugin-market](https://github.com/dsh-plugins/dsh-plugin-market) 社区目录，一键把 npm 插件装入指定实例的 `web-desktop` profile——安装后自动对账 `dsh.profile.bundles`，与 EAC / dsh CLI 的插件协议完全兼容；支持停用/启用（`cordis.patch.yml` 方言）与卸载。
- **安全中心**：
  - **健康体检**：主程序 / sidecar 启动链 / 运行时 / profile 基础 bundles / fs-ext 原生模块 / 上游新版本逐项检查，可一键修复；
  - **崩溃守卫（crash-guard）**：启动后 25 秒内退出记为快速失败并自动归因诊断；连续 3 次失败自动隔离全部第三方插件并修复 bundles（全部可逆），恢复正常启动后计数清零；
  - **安全启动**：先把第三方插件全部移入隔离区再拉起实例，用于确认"插件导致后端崩溃"类问题；
  - **插件快照回滚**：安装 / 卸载 / 停用前自动快照 profile 清单（保留最近 20 份），一键回滚到任意快照；
  - **隔离区**：被隔离插件可随时恢复或彻底删除。
- **实例管理**：启动 / 停止（进程树）/ 重命名 / 删除（含确认）、磁盘占用统计、运行状态轮询、孤儿实例清单自愈、启动失败自动诊断（捕获壳输出 + 日志签名归因）。
- **传输中心**：下载/插件任务的进度、速率、阶段与历史，支持取消与断点续传。
- **界面**：黑白「墨 / 纸」双主题、非线性缓动动效系统、数据驱动的 VITALS 脉冲线、自定义无边框窗口，可减弱动效。

## 实例目录结构

```
<实例根>/
└─ eac-instance-<id>/     # 目录名纯 ASCII（规避上游编码缺陷）
   ├─ app/                # EAC 程序（解压或静默安装产物）
   ├─ dsh-home/           # DSH_HOME（会话/密钥/插件 profile）
   │  └─ profiles/web-desktop/
   └─ launcher.json       # 实例元数据（自描述，可恢复）
```

## 开发

```bash
npm install          # 或 pnpm install
npm run tauri dev    # 开发态（Vite :14200）
npm run tauri build  # NSIS 安装包 → src-tauri/target/release/bundle/nsis/
cargo test           # Rust 单元测试（在 src-tauri/ 下）
```

构建工具链：Node 20+、Rust 1.77+（MSVC）、WebView2。字体（Archivo Variable / IBM Plex Mono / Instrument Serif）经 Fontsource 本地打包，无运行时外部依赖。

## 设计语言「墨与纸」

- 颜色只有墨（近黑）与纸（暖白）两极，发丝线分隔，仅错误状态允许一丝红。
- Archivo Variable（可变字重/字宽）做大标题，Instrument Serif 斜体做幽灵序号，IBM Plex Mono 承载数据。
- 全站非线性缓动（expo / spring / anticipate），视图擦除切换、交错入场、按钮底幕扫入。
- 主页 VITALS 脉冲线是一条数据驱动的心电图：振幅随聚合下载速率与运行实例数呼吸。

## 免责声明

本启动器仅作为上游项目的实例管理器，所有版本产物均从上游 GitHub Releases 下载并校验，本仓库不分发任何上游二进制。

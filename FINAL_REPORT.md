# DSHEAC AIO v1 — 最终交付报告

完成时间：2026-09-03

版型：AIO（All-in-One）

用户版本：v1

机器 SemVer：1.1.0

上游溯源：DSH-Desktop-EAC `v4.5-lite` / `de55ef6d5319eacc24ce60309acc261b9fb78b6c`

## 最终产物

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `DSHEAC-AIO-v1-Setup-x64.exe` | 347,988,148 bytes | `1d3aa772a8ef2a8f07f7ade28cbd33ae5b4d9f82b51dd9ce19d02d22075deab4` |
| `DSHEAC-AIO-v1-Portable-x64.zip` | 128,618,722 bytes | `cb275e8819734cb0e72e05e241d3d72b7b0b7d2a63aa91c334717405f9ab1663` |

## 测试结果

- JavaScript：291/291 PASS
- Rust：15/15 PASS
- sidecar RPC：PASS
- NSIS 静态契约：PASS
- staging bundle-manifest：435 个包，自检 PASS
- 5.x/AIO 双布局 Skill validator：ready；script tests/official validator/PowerShell 5.1 PASS
- boot、GUI、update smoke：PASS；GUI 截图已随分支提交
- portable 真实启动与 `.dsh-aio-data` 隔离：PASS
- profile seed 机器路径扫描：PASS
- 安装 E2E：PASS

最终 E2E 报告：

`verification/verification-20260903-181940-440-70592-fa3389e5.json`（本机生成，不提交临时日志目录）

### E2E 指标

- 静默安装：45.706 秒，退出码 0
- 安装路径：包含中文和空格
- 安装 payload：19,002 文件，311,578,440 bytes
- 首启至 HTTP 200：11.541 秒
- HTTP 端口：2173
- 监听 PID 属于本轮应用进程树：是
- profile 必需插件/技能缺失：0
- 私密设置标记：0
- 本机 pnpm 元数据残留：0
- 静默卸载完整清理：73.026 秒，退出码 0
- 安装目录残留：无
- AIO 进程残留：无
- 监听端口残留：无
- 外部隔离用户数据：按默认策略保留
- 卸载注册表：仅 `DSHEAC AIO`，InstallLocation 指向本轮 AIO 安装根；卸载后无注册表残留

## 安装与首启优化

- staging 从早期 225.3 MiB 降至 131.5 MiB；
- 复制时过滤 17,926 个非运行时文件和 20 个重复/异构目录；
- 未压缩资源减少约 104.1 MiB；
- 过滤 source map、PDB、TypeScript 声明、ARM64 预编译件；
- OpenTelemetry 仅保留 Node 实际使用的 CommonJS `build/src`，去除重复 `build/esm` / `build/esnext`；
- 最长 staging 路径降至 259 字符；
- 安装器拒绝超过 120 字符的安装根，避免 NSIS 静默漏文件；
- 卸载器为深层 node_modules 增加 robocopy 空镜像清理。

## 安全与隐私修复

- 停用无令牌、可读取任意绝对路径的壳层预览服务；
- 仅接受刚启动 DSH 子进程 stdout 的 ready URL 建立受信 origin；
- Tauri IPC 统一校验 main 窗口和运行时受信 origin；
- 外链使用参数化 `explorer.exe`，不拼接 PowerShell/cmd；
- profile seed 删除 `.modules.yaml`、`.pnpm-workspace-state-v1.json`、`.pnpm/lock.yaml`；
- 个人化 status rotator 文案替换为中性公共默认值；
- 构建时全树扫描原工作区、用户目录、`.dsh-v4lite` 和 pnpm store 痕迹；
- 外部审核 seed 与实际打包输入现在使用同一 `DSH_PROFILE_SEED_DIR`，避免扫描错目录；
- npm 完整与生产依赖审计均为 0，已锁定修复 `fast-uri`、`qs` 与 `@xmldom/xmldom` 公告；
- 发布哈希使用 .NET SHA-256，不依赖 PowerShell 模块自动加载；
- AIO identifier、进程名、快捷方式 TargetPath、安装数据、DSH_HOME、portable data、NSIS 和卸载注册表均与其他版本隔离；
- legacy localStorage 导入默认关闭，仅在 `DSH_AIO_IMPORT_LEGACY=1` 时显式启用。

## 仍未闭合的公开发布风险

技术安装与卸载已在本机验收通过，但以下事项仍不满足稳定版发布标准；本次只适合作为明确标注风险的预发布：

1. 安装包未 Authenticode 签名；
2. 第三方依赖、Node/npm、Rust crates、WebView2、插件和素材尚无完整 SBOM/notice bundle；
3. 部分本地插件或素材的许可证/权利人证据不足；
4. 当前图标与 `com.deepseek.*` identifier 存在品牌关联风险；
5. 插件更新依赖 npm/GitHub HTTPS，尚无应用级签名 manifest 或固定内容摘要；
6. `csp: null` 与全局 Tauri API 仍需兼容性验证后进一步收紧。

因此结论应区分：

- **本机技术可安装性：PASS**
- **无条件公开再分发授权：未证明**

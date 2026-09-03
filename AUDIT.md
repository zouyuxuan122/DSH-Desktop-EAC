# DSHEAC AIO v1 — Code and Release Audit

日期：2026-09-03

范围：Tauri 2/Rust 壳、Node sidecar、NSIS、构建/验证脚本、profile seed 与发布资源。

## 增量审计：Composer Dynamic Island 2.1.0

来源固定为 `says693/dsh-composer-dynamic-island` tag `v2.1.0`、commit
`2ccd12ff807c3bc983defd2177e15be1a416106f`。原始 Web 适配器 SHA-256 为
`22ea2dff2002dfd012d54aec8fd3c91d1d62544d5f54c10de755bdb05fc20f78`；AIO
修补后摘要记录在插件目录的 `EAC-VENDOR.json`，并由测试重新计算核对。

确认的安全边界：

- Community v0.15 manifest 不声明权限、合同、订阅或命令；host 入口无 DOM 副作用；
- Web adapter 未使用网络、文件系统、剪贴板、媒体、定位、Cookie、IndexedDB、
  `eval` 或 HTML 字符串注入；
- 唯一持久化键为 `dsh-composer-dynamic-island-config-v1`，只保存配置标志和哈希化
  控件 id，不读取或保存对话、模型配置、API key 或凭据；
- 插件与 DSH Web 同进程同源运行，不构成沙箱，仍受宿主 CSP 与全局 API 风险边界影响。

本次复现并修复：

1. pointerleave 定时器未检查 `:focus-within`，会隐藏仍持有键盘焦点的控件；
2. item click/初始布局排队的 RAF 未被记录，插件卸载后可重新写入属性和内联样式；
3. 触发器 `aria-controls` 指向空视觉背景，错误表达 DOM ownership；
4. 设置页把“已选择”直接表述为“岛内”，在小视口放不下回退原位时不准确；
5. 兼容文档仍写旧的 `lib/host.js`，与实际 `lib/types/index.js` 不符。

残余风险与验证边界：

- `lib/client.js` 没有对应的可重建浏览器源码链；本次按 vendored artifact 逐行审计并
  锁定摘要，但仍不能证明其由仓库源码确定性生成；
- 全局 `MutationObserver` 监听 `document.body` 的 childList/subtree，复杂页面上的性能
  与第三方插件组合仍需真实 DSH Web 回归；
- 控件保持原 React 父节点，键盘/读屏顺序遵循原 DOM 而非视觉排列；小视口放不下的
  已选控件会留在原工具栏；Team/Browser 子弹层仍需多尺寸交互验证；
- 上游没有 npm lockfile，`npm audit` 无法执行；`pnpm audit` 又受本机代理协议错误
  阻断，因此未把上游文档中的“0 漏洞”当作此次实时结论。

## 已确认并修复

### 1. staging 在当前中文路径崩溃

原 `fs.cpSync(..., recursive: true)` 在工作区路径下以 Windows 异常 `0xC0000409` 终止，无 JavaScript 异常可捕获。改为显式递归复制后，完整 staging 成功。

基线实测：

- staging：50.2 秒；
- 发布树裁剪：6797 个 `.map`/`.pdb` 文件与 2 个 ARM64 目录；
- 未压缩体积减少：73.1 MiB；
- 裁剪后 staging：app 225.3 MiB、Node 85.7 MiB、npm 11.5 MiB。

该数字不是最终安装包或安装耗时收益，仍需打包 A/B 验证。

### 2. 壳层绝对路径静态预览服务

原 Tauri 壳在随机回环端口提供任意绝对文件路径读取，无允许根目录和访问令牌；`staticPort` 没有确认到实际消费方。已停用该壳层服务，保留 `dsh-better-sidebar` 自己的受控预览 API。

### 3. 回环端口身份混淆

原服务启动逻辑允许任意本机 HTTP `<500` 响应独立触发 `ReadyProbe`，随后把该端口写入 `state.web_url` 并作为 IPC 可信 origin。已改为：

- 只有刚启动子进程 stdout 中的 ready URL 能建立候选 origin；
- HTTP 只用于后续可用性复核；
- 在 ready URL 出现前，仅允许内置 `tauri.localhost` 页面导航；
- 主要 IPC 全部执行 main 窗口 + 当前受信 origin 检查。

### 4. 外链命令拼接

原实现拼接 PowerShell `Start-Process` 脚本。已改为严格解析 `http/https` URL，拒绝 userinfo 和内部 Tauri URL，并以参数方式传给 `explorer.exe`。

### 5. 发布测试与产物新鲜度

原构建排除 Tauri 安装器、manifest 和 sidecar RPC 测试，可能让失配测试长期失效。现改为 sidecar 编译后串行运行全部重构版 JS 测试，并执行锁定 Rust 测试；构建前清空 `dist`，检查 installer 时间，哈希清单排除自身并立即复核。

### 6. 安装验证不足

原验证无卸载、残留、Unicode 路径、绝对 deadline、失败报告与端口进程归属检查；还会在原 v4Lite 未运行时误报失败。现已补齐这些场景，并验证 NSIS 异步自删除完成后安装根、进程和端口均无残留。

### 7. Profile seed 本机路径与个人化设置

已删除 `.modules.yaml`、`.pnpm-workspace-state-v1.json`、`.pnpm/lock.yaml` 等会记录 `H:/CODEX`、原 Windows 用户目录、pnpm store 和 `.dsh-v4lite` 的机器状态；个人化 status-rotator 文案已替换为中性公共默认值。`Set-PublicSeed` 现在会执行全树路径扫描，命中则阻断构建。

### 8. 外部 seed 审计目标错误

发布脚本允许通过 `DSH_PROFILE_SEED_DIR` 注入审核后的完整离线 seed，但脱敏脚本此前始终扫描仓库内占位目录，实际打包输入可能绕过检查。现已统一读取同一环境变量，并增加外部 seed、CRLF 保持和本机路径阻断回归测试。

### 9. 依赖公告与发布哈希兼容性

发布前 npm 审计发现 `fast-uri` 高危、`qs` 与 `@xmldom/xmldom` 中危公告，现通过 overrides 锁定修复版本，完整与生产依赖审计均为 0。发布哈希改用 .NET SHA-256，避免 Windows PowerShell 未自动加载 `Microsoft.PowerShell.Utility` 时在流水线末尾失败。

## AIO v1 命名与版本

- 版型：AIO（All-in-One）
- 用户可见版本：v1
- 机器内部 SemVer：1.1.0
- 上游 `v4.5-lite` 只作为源码溯源，不是当前产品版本。

## 仍未完全解决

### 高优先级

1. **插件更新真实性**：npm/GitHub 下载尚无应用级签名清单或固定内容摘要；自动更新应保持默认关闭。
2. **第三方许可证**：插件、皮肤、素材和二进制尚未完成逐项 SBOM/notice；这是公开发布阻塞项。
3. **代码签名**：安装包未签名，SmartScreen 和发布者身份验证未解决。
4. **CSP/全局 Tauri API**：`csp: null`、`withGlobalTauri: true` 仍扩大 XSS 影响，需先做 DSH Web 兼容性测试再收紧。

### 中优先级

1. WebView2 离线安装器增加体积，但为离线/无预装目标机提供确定性，暂不移除。
2. profile seed 文件数较多，首次 seed 与杀毒扫描可能仍是首启瓶颈；归档 seed 可进一步优化，但需新增原子解包、版本迁移与失败回滚。
3. 预置根 `node_modules`、vendor Node/npm 和 profile seed 尚无完整输入哈希 manifest。
4. NSIS 进程结束失败后仍可能继续覆盖；应增加最终探测并在同产品进程仍存活时中止安装。

## 验收标准

本机最终技术验证结果：JavaScript 291/291、Rust 15/15，安装/首启/共存/卸载 E2E 已 PASS。该结论不替代第三方授权、代码签名或商标审查。

发布前必须看到：

- 全部 JS 测试通过；
- `cargo test --locked` 通过；
- Tauri/NSIS 构建成功；
- `Verify-Installer.ps1` PASS；
- 安装目录、进程和端口无残留；
- 原 v4Lite（若运行）未被中断；
- `SHA256SUMS.txt` 复核通过；
- 第三方 license/notice 门禁完成；
- 安装包签名策略明确。

## 结论边界

静态审计和本机测试只能证明已覆盖场景。不能据此绝对保证所有 Windows 环境、杀毒软件、企业代理、权限策略和损坏磁盘上都能安装。最终发布结论应表述为“在记录的环境和验收矩阵中通过”，而不是无条件保证。

# Security Policy

## 支持范围

当前仅审计和支持 `DSHEAC AIO`（All-in-One，用户可见版本 `v1`，内部 SemVer `1.1.0`）的 Windows x64 Tauri 构建。

## 信任边界

- 原生壳只信任内置 `tauri.localhost` 页面和本轮 DSH 子进程输出的 ready origin；
- Tauri IPC 需要同时满足 main 窗口标签与运行时 origin；
- DSH Web、插件和技能运行在用户权限下，不是安全沙箱；
- 插件安装或更新等价于执行第三方代码，必须只使用可信来源；
- 本项目未提供代码签名，SHA-256 只能验证文件一致性，不能证明发布者身份；
- API Key 与 provider 凭据不应进入源码、profile seed、日志或问题报告。

## 已采取的措施

- 停用无访问令牌且支持任意绝对路径的壳层静态预览服务；
- 不再以任意回环 HTTP 响应建立受信 Web UI origin；
- 主要 IPC 全部执行 origin 复核；
- 外链参数不经过 PowerShell/cmd 拼接；
- profile seed 构建前执行结构化脱敏；
- 安装验证使用隔离数据目录和最小 PATH；
- 发布测试验证端口监听者属于本轮应用进程树。

## 未决风险

- 内置插件更新依赖 npm/GitHub HTTPS，尚无应用级签名清单或固定内容摘要；自动更新默认应保持关闭；
- Tauri capability 因动态端口仍需声明回环通配，安全性依赖命令内部 origin 校验；新增命令时必须同步执行同等校验；
- `csp: null` 与 `withGlobalTauri: true` 扩大了 Web UI XSS 后的影响；收紧前需先验证 DSH Web 前端兼容性；
- 发布产物未签名，SmartScreen 和供应链身份验证仍是发布阻塞项；
- 第三方插件、皮肤、字体、音频、视频和二进制资源需要逐项确认再分发权。

## 报告漏洞

请勿在公开 issue 中粘贴 API Key、会话、日志原文、用户目录或完整配置。报告至少应包含：

- AIO v1 版本和 SHA-256；
- Windows 版本；
- 最小复现步骤；
- 影响范围与是否需要本机同用户权限；
- 已脱敏日志片段；
- 若涉及端口或进程，提供 PID/端口关系，不要提供凭据。

在没有明确私密报告渠道前，涉及可利用漏洞时应先联系仓库维护者建立私密渠道，再发送完整细节。

# 微信 ClawBot → DSH 直连桥接插件（openclaw-dsh-bridge）

微信官方 ClawBot 插件**直连** DSH 会话，不经 OpenClaw 网关。开源、MIT 许可证、
不包含任何微信非官方协议代码。

## 架构（两条可选链路，同一 DSH 侧端点）

```
微信 App（安卓，官方 ClawBot 插件）
   │
   ├─ 链路 A（默认/推荐）：官方插件直连自定义后端（免 OpenClaw，协议见
  │   [wechat-clawbot-dsh-report.md](wechat-clawbot-dsh-report.md)）
   │      │  OpenAI 兼容协议 /chat/completions（或官方插件要求的协议）
   │      ▼
   │  本插件（运行在 DSH webServer 内，127.0.0.1 路由 + token 鉴权）
   │      │  agents.create + agent.followup + session 事件流
   │      ▼
   │  DSH Agent 会话（独立工作区、按 model 名映射持久会话）
   │
   └─ 链路 B（兼容）：微信 ClawBot → OpenClaw 网关 → 本插件（OpenAI 兼容 provider 配置）
          （供已有 OpenClaw 的用户使用，见 docs/openclaw-config.md）
```

## 微信 iLink 直连渠道（v0.3，不经 OpenClaw）

依据腾讯官方 npm 包 @tencent-weixin/openclaw-weixin 公开的 Backend API Protocol
（完整调研：[wechat-clawbot-dsh-report.md](wechat-clawbot-dsh-report.md)）：

- `lib/wechat.js`：纯出站 HTTP 客户端——`get_bot_qrcode`/`get_qrcode_status`
  扫码登录、`getupdates` 长轮询收、`sendmessage` 发；token 持久化到
  `~/.dsh/openclaw-bridge/wechat-session.json`，24h 过期自动回到待扫码状态；
  启动时若会话仍有效则自动恢复轮询；
- 控制路由（仅回环）：`/openclaw-bridge/wechat/{status,login,verify,logout}`，
  设置页 ClawBot 栏的"微信连接"面板驱动扫码/配对码/断开；
- 会话映射：`wx-<sanitized(from_user_id)>` → 独立 DSH agent + 独立工作区；
- 请求头含 `AuthorizationType: ilink_bot_token`、`X-WECHAT-UIN`（随机）、
  `iLink-App-Id: bot`、`iLink-App-ClientVersion`；发送消息带全
  `from_user_id/client_id/message_type/message_state/context_token`（缺字段会
  静默不投递——社区实测坑）；
- 网络：无需公网/穿透，仅需出站 HTTPS 到 `ilinkai.weixin.qq.com`；
- 测试：mock 腾讯 iLink 云 + mock agent 跑通 扫码→确认→收消息→回合→回传 全链路
  （21 项微信链路断言）；集成测试验证真实 dsh web 启动带微信路由不破坏原有功能。

## DSH 设置里的 ClawBot 配置栏

宿主插件通过 `installSettingsSection(ctx, "openclaw-bridge", Config, ...)` 注册设置节；
客户端卡片注册到 `settings.section` 槽位（schema-form 渲染 Config 表单）。

- 可配置项（v0.5，7 个字段）：
  - `model`：接收模型，形如 `provider/model` 或 `model`（缺省沿用 DSH 默认模型）；
  - `token`：桥接 Bearer token（留空 = 环境变量 / 自动生成文件 token）；
  - `workspace`：微信会话工作目录（远程办公，绝对路径；留空 = 隔离工作区）；
  - `allowlist`：微信用户白名单（逗号分隔）；
  - `customBaseURL` / `customApiKey` / `customModel`：第三方 OpenAI 兼容端点
    （baseURL 非空即启用 `openclaw-custom` provider，保留完整工具/流式能力）。
- 配置经 settings 服务持久化（settings.yaml）并在保存后热生效；新映射会话使用新模型，
  已有会话保持连续性。

## 关键设计决策

1. **协议：OpenAI 兼容**。OpenClaw 支持自定义 provider（openai-compatible，baseURL 指向本插件）。
   本插件暴露 `POST /openclaw-bridge/v1/chat/completions`（支持 stream 与一次性返回）。
2. **会话映射：model 名 → DSH session**。OpenClaw 每个 agent 可配置 model（如
   `dsh-bridge/main`），本插件用 model 名做 key，每 key 一个常驻 DSH Agent，
   保证跨轮记忆、工具状态（文件/工作区）连续。
3. **DSH 侧注入 API**（已从 dsh-headless 源码确认）：
   - `ctx.get("agents")` / `ctx.get("sessions")` / `ctx.get("agentDefaultModel")`
   - `agents.create({ sessionId, meta: { cwd }, agentOptions, setup })`
   - `agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }))`
   - `await agent.whenIdle()`；事件流 `agent.session.events`（seq + turn/start | assistant/message | turn/end）
   - 依赖包：`@deepseek-ai/dsh-llm`（createUserMessage）、`@deepseek-ai/dsh-session`（SessionId）、
     `@deepseek-ai/dsh-agent`（installModelSelection）
4. **隔离与安全**：
   - 每个映射会话默认工作目录：`~/.dsh/openclaw-bridge/workspace/<key>`（不碰用户桌面）
   - 插件路由默认仅 127.0.0.1；token 必填（环境变量 `OPENCLAW_BRIDGE_TOKEN` 或配置）
   - 请求体大小、并发轮数、每轮超时均设上限
5. **安装方式**（沿用 DSH Desktop 现有机制）：
   - 插件包放入 `DSH Desktop/resources/app/assets/plugins/dsh-openclaw-bridge/`
     （package.json + lib/index.js）
   - DSH Desktop 启动时自动复制到 `~/.dsh/profiles/web/node_modules/@deepseek-ai/`
     并追加 `~/.dsh/profiles/web/cordis.patch.yml` 的 insert 条目

## 设置栏落地要点

- 宿主：`installSettingsSection(ctx, "openclaw-bridge", Config, config, { setSource, onChange })`
  注册设置节；配置经 settings 服务三层合成（schema 默认值 + composition base + 用户文档），
  `scope.watch` 驱动 onChange 热生效；
- 客户端：`ctx.settingsScope.bind({ namespace })` 得到现成控制器（load/set/unset +
  `settings.mutate` 乐观并发），`bindSnapshotSelector(scope)` 订阅快照，
  卡片注册到 `settings.section` 槽位；
- **白名单硬门槛**：`dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 决定哪些命名空间
  对设置页可见（否则 `settings-not-exposed`）。插件自身无法绕过，install.ps1 会幂等打补丁
  （上游注释标明这是待重构的 deferred work，将来版本可能改为 `settings.register()` 自带暴露）。

## 已实测验证（2026-08 本地环境）

- 插件在真实 dsh web 实例中随 profile 补丁正常装载，`cordis.patch.yml` 的 insert 条目
  格式与 DSH Desktop 的 `syncCompanionPlugins` 完全同构；
- 注意：`~/.dsh/profiles/web` 是 npm 托管的 profile，未在 profile package.json 声明的
  插件目录可能被 npm 修剪——升级/重装后务必重跑 `install.ps1`（幂等），
  DSH Desktop 更新同样会清掉 apiproxy 白名单补丁与 assets/plugins 副本；
- 真实链路打通过：`curl POST /openclaw-bridge/v1/chat/completions`
  → `agents.create` → `agent.followup` → 真实模型回合 → 返回 assistant 文本
  （集成测试 `scripts/integration-test.ps1`，stream 模式以 `data: [DONE]` 收尾）；
- `profiles/node_modules` 由 DSH 的 `healProfilesModuleFallback` 在每次启动时
  用 junction 重建；插件包在 `profiles/web/node_modules/@deepseek-ai/` 的副本是
  **非持久资产**（profile 为 npm 托管，可能被修剪），以 install.ps1 的幂等重同步为准；
- 52 项单元测试断言全过（`scripts/test.ps1`：协议 20 + 微信 iLink 21 +
  自定义端点/适配器 11）；
- 设置闭环实测：`settings.describe` 暴露 openclaw-bridge 命名空间 →
  `settings.mutate` 写入 model → 宿主热生效（health 端点立即反映新模型）；
- 集成测试实测：真实 dsh web 实例中，agent 循环经 `openclaw-custom` 适配器
  调用 mock 第三方端点并成功回复（`scripts/integration-test.ps1`）。

## 合规边界（README 必须写明）

- 仅使用微信官方 ClawBot 插件通道；仓库不含任何微信协议/hook/逆向代码
- 桥接插件自身 MIT 许可证；依赖的 DSH 核心包均为 MIT
- 免责声明：与腾讯/DeepSeek 无隶属关系；使用者自担账号与数据风险

## 目录结构

```
openclaw-dsh-bridge/
├── package.json            # @deepseek-ai/dsh-openclaw-bridge，type: module
├── lib/
│   └── index.js            # Cordis 插件：路由 + agent 池 + 协议转换
├── LICENSE                 # MIT
├── README.md               # 架构、安装、OpenClaw 配置、微信端配置、合规说明
├── docs/
│   └── openclaw-config.md  # OpenClaw provider/agent 配置样例
└── scripts/
    └── install.ps1         # 复制到 DSH Desktop assets/plugins 并提示
```

# V4 Flash 神模式 (opencode-go)

> 让 **opencode-go 的 DeepSeek V4 Flash** 从「鬼模式」切换到「神模式」的 dsh agent preset。

## 这是什么

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 agent preset。它把 [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) 研究里为 **Flash** 标定的最优引导（w7 persona + 深度思考锚）适配到 **opencode-go provider 的 `deepseek-v4-flash`** 上。

**核心问题**：Flash 在默认（无引导）条件下会进入「鬼模式」——思考浅、草草动手、质量差。这不是 Flash 能力不行，而是**引导条件不对**。补上正确的引导（分类 + 回顾 + 反跑题 + 深度思考 + 决策闭环），Flash 就能进入「神模式」——深度规划、高质量交付、自测零错误。

## 实测效果（同一任务、同一 Flash 模型）

四冲程柴油机 3D 仿真任务：

| | 鬼模式（无引导） | 神模式（本 preset） |
|---|---|---|
| 规划深度 | 2.9 万字 | **37.5 万字** |
| 齿轮啮合几何验证 | 无 | ✅ 数值验证 |
| 交付形态 | 单文件依赖 CDN | 多文件 + 合并单文件（离线可用） |
| 数值仿真自测 | 无 | ✅ 四冲程相位 / 气门正时 / 喷油正时 |
| 无头浏览器自测 | 无 | ✅ SELFTEST 零错误（236 网格 / 49 零件） |

## 跨平台支持

本 preset **三平台通用**，dsh 会自动选择 shell 工具：

| 系统 | shell | 状态 |
|---|---|---|
| Linux | bash | ✅ 实测 |
| macOS | bash | ✅ 自动适配 |
| Windows | pwsh（PowerShell） | ✅ 自动适配 |

> 说明：`agent.cordis.yml` 内已有 `process.platform === 'win32'` 判断，Windows 自动禁用 bash、启用 pwsh。核心路由逻辑（persona / 引导 / 模型识别）与操作系统无关。

## 依赖

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）rc.6+
- opencode-go provider 的 `deepseek-v4-flash` 模型（`https://opencode.ai/zen/go/v1`）

## 安装

### 方式一：一键脚本

```bash
git clone https://github.com/SheberDavid/v4-flash-godmode-opencode-go.git
cd v4-flash-godmode-opencode-go
./install.sh
```

### 方式二：手动

```bash
# 1. 复制 preset 到 dsh 用户目录
mkdir -p ~/.dsh/.agent-presets
cp -r preset ~/.dsh/.agent-presets/router-flash

# 2. 编辑 ~/.dsh/settings.yaml，确认包含：
#    agent-default-model:
#      provider: opencode-go
#      model: deepseek-v4-flash
#      reasoningEffort: max
#    agent-presets:
#      default: router-flash

# 3. 重启 dsh
```

## 使用

1. 安装后重启 dsh，新会话会自动使用 `router-flash` preset + `deepseek-v4-flash` 模型。
2. 直接提交任务即可。persona 会自动注入「分类 + 回顾 + 反跑题 + 深度思考 + 决策闭环」五个锚。
3. 会话启动后，模型的 system prompt 应包含：
   ```
   You are a helpful assistant.
   Before acting, decide the task type (build or fix)...
   Before acting, briefly review what you have already done...
   Do not run environment checks (echo, whoami, uname...)...
   Think deeply about the architecture, edge cases...
   Produce when your information is complete...
   ```

## 适配了什么（与原版 dsh-router-standard 的区别）

原版依赖三个在你的 dsh 版本上会失效的机制，本 preset 已修复：

1. `ctx.on('session/event')` 注入 —— dsh rc.6 中 session/event 是 session-scoped，agent-plane preset 收不到。
2. `target.inbox.append` —— agent 对象没有 `.inbox` 属性。
3. assemble 时 `session.events` 里还没有 user/message —— 时序问题。

**修复方式**：把引导静态合并进 `WEAK_FLASH` persona，避免依赖任何动态注入机制。对固定任务同样有效，且更简单可靠。

## 适用范围

- ✅ 本 preset 专为 **Flash** 设计：命中 `isFlashModel` 后一律走 weak 模式（作者实测 w7 最优解）。
- ✅ 非 Flash 模型（如 pro）不受影响，走原版关键词分类逻辑。
- ✅ 复杂构建任务（如大型工程、从零开发）尤其受益于深度思考锚。

## 致谢

基于 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) / [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) 的研究与代码（MIT）。

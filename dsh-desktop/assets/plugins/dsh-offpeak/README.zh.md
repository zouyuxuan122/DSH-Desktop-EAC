<div align="center">

# OffPeak · dsh-offpeak

**DeepSeek API 峰谷定价的高峰时段拦截提醒插件**

高峰时段在你按下发送前把消息拦下来——排到低价时段再自动执行。

[![npm version](https://img.shields.io/npm/v/dsh-offpeak)](https://www.npmjs.com/package/dsh-offpeak)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-4c8dff)](#)

*English version: [README.md](README.md)*

</div>

---

## 为什么做这个

DeepSeek 自 **2026-08-17**（北京时间）起实行**峰谷定价**：

| 时段 | 时间（北京时间） | 相对调价前 |
|---|---|---|
| **高峰** | 09:00–12:00、14:00–18:00 | 最高 **4.5 倍** |
| **闲时** | 其余时间 | 高峰的一半 |

调价后价目表（元 / 百万 tokens）：

| 模型 | 计费项 | 高峰 | 闲时 |
|---|---|---|---|
| **V4 Flash** | 输入（缓存未命中） | 3 | 1.5 |
| | 输出 | 9 | 4.5 |
| | 输入（缓存命中） | 0.1 | 0.05 |
| **V4 Pro** | 输入（缓存未命中） | 9 | 4.5 |
| | 输出 | 27 | 13.5 |
| | 输入（缓存命中） | 0.3 | 0.15 |

如果你经常用 DeepSeek V4 Flash 跑长任务：上午 10 点发出去的账单，比晚上 7 点发出去贵 **3 倍**。OffPeak 负责让你在按下发送**之前**就意识到这一点。

## 功能

当前模型为 DeepSeek V4 Flash / Pro、且北京时间处于高峰窗口内时，在输入框按 **Enter**（或点发送按钮）会**在消息发出前拦截**——文字留在输入框，弹出对话框：

- **价目表**：当前模型高峰/闲时每百万 tokens 单价
- **继续执行**：立即按正常路径发送（草稿清理、排队、提示等行为与原生一致）
- **定时执行**：小时轮只含低价时段（**0–8 点、18–23 点**），已过去的时间移除，23 之后滚到次日 0–8 点；分钟 **00–59** 逐分钟可选。服务端记录命令文本与时间，**到点自动把命令提交给原会话执行**——那时浏览器不在线也能跑
- **今日不再提醒**：当天（北京时间）不再拦截/弹窗
- **✕**：不发送，消息保留在输入框

> 执行中的命令**绝不会被打断**：任务跨进高峰边界时不会弹窗，提醒只在你高峰时段内的下一条命令出现。

## 演示

![Demo](docs/demo.png)

*截图占位——替换成你自己的截图。*

## 安装

需要 **web profile**（`dsh web`）。

```sh
dsh plugin --profile web add dsh-offpeak
```

**手动安装**（无需 pnpm）：

1. 把包复制到共享插件目录：
   - Windows：`%USERPROFILE%\.dsh\profiles\node_modules\dsh-offpeak`
   - macOS / Linux：`~/.dsh/profiles/node_modules/dsh-offpeak`
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: offpeak
         name: 'dsh-offpeak'
         config:
           effectiveFrom: '2026-08-17'
           debug: false
   ```

3. 重启 `dsh web`。

> 插件在 `effectiveFrom`（2026-08-17，峰谷定价生效日）之前**休眠**。想提前试用，把它改成今天。

## 工作原理

```
高峰时段（北京时间 09:00–12:00 / 14:00–18:00），模型 = V4 Flash/Pro
        │
按 Enter / 点发送 ──► 客户端拦截 ──► 消息保留在输入框
        │
   ┌─ 弹窗 ────────────────────────┐
   │ 价目表 · 命令预览              │
   │ [继续执行]        [定时执行]   │
   │ ☐ 今日不再提醒                │
   └───────────────────────────────┘
        │                              │
   继续执行                      定时执行
        │                              │
        ▼                              ▼
 原生 composer 提交               POST /ds-offpeak/schedule
 （消息正常发出）                 { text, atMs, sessionId }
                                    清空输入框
                                           │
                                 服务端定时器到点
                                           ▼
                              session.prompt → 原会话
                             （浏览器不在线也能执行）
```

- **拦截在客户端**：捕获阶段监听 composer 输入框的 Enter 与发送按钮的点击，用本地计算的北京时间 + 服务端最新状态（高峰窗口、模型、今日不再提醒）做判定
- **输入法安全**：中文/日文输入法组合态（`isComposing`）下的回车永不拦截
- **服务端兜底**：高峰时段消息若经未拦截路径到达宿主，会话事件监听会弹非阻塞提醒
- 高峰判定使用 `Asia/Shanghai` 时区，与机器时区无关

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `effectiveFrom` | `"2026-08-17"` | 峰谷定价生效日（北京时间）；此前插件休眠 |
| `debug` | `false` | 忽略生效日期；开放 `/ds-offpeak/debug-remind` |
| `peakWindows` | `09:00–12:00、14:00–18:00` | 高峰窗口（分钟数 `{ start, end }`），可覆盖 |
| `profile` | 自动（`web`） | 状态文件所属 profile |

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/ds-offpeak/state` | 状态：是否高峰、模型、价目表、待提醒、小时轮选项、任务 |
| POST | `/ds-offpeak/ack` | 确认兜底提醒 |
| POST | `/ds-offpeak/dismiss` | 今日不再提醒 |
| POST | `/ds-offpeak/schedule` | `{ text, atMs, sessionId }` 登记定时任务 |
| POST | `/ds-offpeak/cancel` | `{ id }` 取消任务 |
| POST | `/ds-offpeak/execute` | `{ id }` 立即执行 |
| POST | `/ds-offpeak/debug-remind` | 模拟高峰命令（仅 debug） |

所有写操作仅接受**同源 POST**；状态与任务持久化在 `$DSH_HOME/profiles/<profile>/offpeak.json`。

## 安全与隐私

- 拦截完全发生在**本地浏览器**；消息只在你点「继续执行」后走正常 composer 路径发出
- 定时命令**本地存储**，由本地服务端到点后重新提交给**原会话**
- 价目表按官方公告硬编码；**不联网、无遥测**

## 常见问题

**小时轮为什么跳过 12–14 点？** 12:00–14:00 名义上是闲时，但它夹在两个高峰窗口中间。OffPeak 只提供明确安全的时段（0–8、18–23）。

**会拦截子代理/排队消息吗？** 不会——只拦截 composer 自身的发送动作。

**关闭弹窗会怎样？** 什么都不发，消息留在输入框。

**多个标签页？** 各自独立拦截；「今日不再提醒」在服务端共享。

## 开发

```
src/index.js     服务端——高峰检测、兜底提醒、定时调度、持久化
client/client.js 浏览器端——拦截、弹窗、时间轮（零依赖原生 DOM）
```

```sh
node --check src/index.js && node --check client/client.js
```

## 许可

[MIT](LICENSE) © christophersmith2737

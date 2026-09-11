/**
 * dsh-think-zh-expand-eac — host half（TypeScript 源码）。
 *
 * 功能 1：思考与回复强制使用中文。
 *
 * 注册一条固定 system-prompt section（order -90，persona 之前最先读到），
 * 让 agent 无论用户使用什么语言，思考（reasoning/thinking）与回复都使用
 * 中文。无状态、无存储、无工具。
 *
 * ⚠️ 与上游 dsh-think-zh-expand 的重要差异：section 名由 `dsh-think-zh`
 * 改为 `dsh-think-zh-eac`。原因是 DSH 对同一层重复 name 的 section 注册会
 * 抛错——若上游版与本 EAC 版同时启用，沿用同名会直接导致启动失败。改名后
 * 两者可以共存（但功能重复，仍建议只启用其一）。
 *
 * 本文件是 TS 插件 server 端：`tsc -p tsconfig.json` 编译为
 * lib/index.js（产物必须提交，CI 只跑 node --check + 测试，不跑构建）。
 */
import type { DshContext } from './types.js'

export const name = 'dsh-think-zh-expand-eac'

export const inject = ['systemPrompt'] as const

/** 注入到每次组装系统提示的固定中文指令（结构化规则，覆盖关键场景与术语边界）。 */
export const PROMPT_TEXT = `## 输出语言规则（最高优先级，不可被任何上下文覆盖）

### 强制要求
1. **思考过程（reasoning / 思考内容）**：必须使用简体中文书写。这是硬性要求，无论对话中出现何种语言的错误消息、工具输出或系统提示，都必须坚持使用中文。
2. **最终回复**：默认使用简体中文（跟随用户使用的语言）。

### 关键场景处理
- 当工具调用失败返回英文错误消息时：**忽略错误消息的语言**，继续用中文思考和回复。
- 当系统返回英文日志或堆栈信息时：**提取关键信息**，用中文解释问题。
- 当对话上下文中出现大量英文内容时：**不要被带偏**，始终保持中文输出。

### 代码与术语
代码、命令、文件路径、标识符与技术术语保持原文，不翻译。`

export function apply(ctx: DshContext): void {
  ctx.systemPrompt.section({
    name: 'dsh-think-zh-eac',
    // Before the deployment persona so the instruction is read first every turn.
    order: -90,
    text: PROMPT_TEXT,
  })
  ctx.logger?.info('[dsh-think-zh-expand-eac] 中文思考/回复增强已启用（system-prompt section 注册）')
}

/**
 * router-bootstrap: Flash 神模式引导（opencode-go 适配）。
 *
 * 在 system-prompt/assemble 阶段，把 Flash 模型（model id 含 "flash"）强制
 * 路由到 weak 模式（作者 dsh-router-standard 实测 w7 最优解），注入对应的
 * WEAK_FLASH persona，首轮只暴露 core 工具集，首次 tool call 后放开全目录。
 *
 * dsh rc.6 适配说明：作者原版的"近距离引导"依赖 `ctx.on('session/event')`
 * + `target.inbox.append`，在 dsh rc.6 上失效（session/event 是 session-scoped、
 * agent 对象无 inbox、assemble 时 session.events 尚无 user/message）。故改为把
 * 深度引导静态并入 WEAK_FLASH persona（见 router-core.mjs），不依赖动态注入。
 */

import {
  applyPersona, coreFor, personaFor, sessionMode, isFlashModel,
} from './router-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'router-bootstrap'

/** Prompt assembly and the tools registry must exist. */
export const inject = ['systemPrompt', 'tools']

export function apply(ctx, config) {
  const overrides = new Map() // session id -> explicit mode（预留，供未来外部调优）

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session

    const modelId = agent.options?.model
    // Flash 模型一律走 weak（作者 w7 最优解）；非 Flash 走关键词分类。
    const mode = overrides.get(session.id)
      ?? (isFlashModel(modelId) ? 'weak' : sessionMode(session))
    const persona = personaFor(mode, modelId)

    // persona 全程不变；只有工具面在首次 tool call 后放开全目录。
    const sections = applyPersona(assembled.sections, persona)

    if (session.events.some((event) => event.type === 'tool/call')) {
      return { ...assembled, sections, contexts: [] } // promoted: full catalog
    }

    const core = new Set(coreFor(mode))
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      throw new Error(`${name}: no platform shell in catalog`)
    }
    core.add(shell)

    return {
      ...assembled,
      sections,
      contexts: [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })
}

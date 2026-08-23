/**
 * router-core: reasoning-mode routing logic (zero dependencies).
 *
 * 理论基础（dsh-router-standard 作者实测）：
 * - 模型行为沿 react↔spec 轴坍塌为三个稳定带，不是连续谱：spec [0,0.15]、
 *   transition [0.2,0.45]（不稳定，回避）、react [0.5,1.0]。
 * - 第四个模式 weak（内部路由）：让模型自己按任务选方向，是最强的弱 persona 域。
 * - weak 的最优 persona 依模型而不同（P11）：
 *     pro:   spec 句 + few-shot 路由指令（w6）
 *     flash: neutral + 显式分类指令 + 回顾/收敛/反跑题锚（w7）
 *
 * 本文件只保留 Flash 神模式引导所需的最小核心。
 */

const SPEC_PERSONA = 'You are a helpful software engineer assistant.'

const MIXED_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work directly: prefer writing or editing code over describing plans. '
  + 'Verify your changes by reading and running them.'

const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight — produce, verify, fix — and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

/** Weak (internal-routing) personas — model-specific optimum (P11/P24).
 *  pro:   spec sentence + classify instruction（w6c）；few-shot/回顾/收敛锚对 Pro 有害。
 *  flash: neutral + classify + recall/converge/anti-runaway anchors（w7）。
 */
const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply about the architecture, edge cases, and integration points before writing. Do not spend reasoning on the environment or tooling. Produce when your information is complete, and end each reasoning block with a decision or an information need.'

/** True when the routed model id is a Flash-family model. */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0))
}

/** Quantize a mode to one of the measured behavior bands. */
export function bandOf(mode) {
  if (mode === 'weak') return 'weak'
  const m = clamp01(mode)
  if (m < 0.2) return 'spec'
  if (m < 0.5) return 'transition'
  return 'react'
}

/** Persona for a mode; weak picks the model-specific internal-routing text. */
export function personaFor(mode, modelId) {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_PERSONA
    case 'transition': return MIXED_PERSONA
    case 'weak': return isFlashModel(modelId) ? WEAK_FLASH : WEAK_PRO
    default: return REACT_PERSONA
  }
}

/** First-turn core tools (shell added dynamically by the plugin). */
export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep']
    case 'transition': return ['read', 'edit', 'write', 'glob', 'grep']
    default: return ['read', 'write', 'edit']
  }
}

const REACT_RE = /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

function countHits(regex, text) {
  return [...text.matchAll(regex)].length
}

/** Classify a task text into a mode: react(1) / spec(0) / weak（无倾向）。 */
export function classifyTask(text) {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return 1
  if (spec > react) return 0
  return 'weak'
}

export function extractText(data) {
  if (!data) return ''
  const content = Array.isArray(data.content) ? data.content : []
  return content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join(' ')
}

/** Per-session mode derived from the first user message（非 Flash 走这里）。 */
export function sessionMode(session) {
  const events = session.events
  const userMsg = events.find((e) => e.type === 'user/message')
  return classifyTask(extractText(userMsg?.data))
}

/** Replace only the persona section, keeping everything else（plan-mode 等）。 */
export function applyPersona(sections, personaText) {
  const rest = (sections || []).filter(
    (section) => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'router-persona', text: personaText, order: 0 }]
}

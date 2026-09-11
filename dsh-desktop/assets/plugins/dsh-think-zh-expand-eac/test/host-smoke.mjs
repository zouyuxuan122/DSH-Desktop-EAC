/**
 * dsh-think-zh-expand-eac — host 半冒烟测试。
 *
 * 用 mock context 挂载插件，断言 system-prompt section 注册正确。
 * client 半是浏览器专用；其语法由 `node --check lib/client.js` 校验。
 *
 * 使用 Node 内置 test runner（无需额外依赖）：
 *   node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, PROMPT_TEXT, inject, name } from '../lib/index.js'

/** 构造 mock context 并运行 apply，返回注册的 section 与日志。 */
function boot() {
  const sections = []
  const logs = []
  const ctx = {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  }
  apply(ctx)
  return { sections, logs }
}

test('插件名与上游区分（独立包名）', () => {
  assert.equal(name, 'dsh-think-zh-expand-eac', '导出 name 为 EAC 版包名')
})

test('注册且仅注册一条 system-prompt section', () => {
  const { sections } = boot()
  assert.equal(sections.length, 1, '恰好注册一条 section')
})

test('section 使用 EAC 专名，避免与上游同名冲突', () => {
  const { sections } = boot()
  const section = sections[0]
  assert.equal(section.name, 'dsh-think-zh-eac', 'section 名为 dsh-think-zh-eac（上游为 dsh-think-zh）')
  assert.equal(section.order, -90, 'order 为 -90（persona 之前最先读到）')
  assert.equal(typeof section.text, 'string', 'section text 为字符串')
})

test('注入的中文指令覆盖关键场景', () => {
  const { sections } = boot()
  const text = sections[0].text
  assert.ok(text.includes('思考'), '覆盖思考')
  assert.ok(text.includes('中文'), '强制中文')
  assert.ok(text.includes('回复'), '覆盖回复')
  assert.ok(text.includes('错误消息'), '覆盖英文错误消息场景')
  assert.ok(text.includes('日志'), '覆盖英文日志/堆栈场景')
  assert.ok(text.includes('不翻译'), '代码/命令/路径不翻译')
  assert.ok(text.includes('最高优先级'), '声明最高优先级')
  assert.equal(text, PROMPT_TEXT, 'PROMPT_TEXT 常量与注入文本一致')
})

test('inject 声明 systemPrompt 硬依赖', () => {
  assert.ok(Array.isArray(inject), 'inject 是数组')
  assert.ok(inject.includes('systemPrompt'), '声明 systemPrompt 硬依赖')
})

test('apply 输出带 EAC 前缀的启用日志', () => {
  const { logs } = boot()
  assert.ok(logs.length >= 1, '至少一条日志')
  assert.ok(logs[0].startsWith('[dsh-think-zh-expand-eac]'), '日志带 EAC 前缀')
  assert.ok(logs[0].includes('已启用'), '日志描述已启用行为')
})

test('缺少 logger 时仍能注册（可选链容错）', () => {
  const sections = []
  const ctx = { systemPrompt: { section: (section) => sections.push(section) } }
  apply(ctx)
  assert.equal(sections.length, 1, '无 logger 也注册成功')
})

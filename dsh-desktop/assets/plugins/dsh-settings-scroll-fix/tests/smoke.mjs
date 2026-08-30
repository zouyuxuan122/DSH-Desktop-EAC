import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import vm from 'node:vm'

class FakeElement {
  constructor({ text = '', role = '', width = 640, height = 480, clientHeight = height, scrollHeight = height, ariaModal = '', dataSlot = '' } = {}) {
    this.nodeType = 1
    this.textContent = text
    this.parentElement = null
    this.children = []
    this.attributes = new Map()
    if (role !== '') this.attributes.set('role', role)
    if (ariaModal !== '') this.attributes.set('aria-modal', ariaModal)
    if (dataSlot !== '') this.attributes.set('data-slot', dataSlot)
    this.dataset = {}
    this.clientHeight = clientHeight
    this.scrollHeight = scrollHeight
    this.scrollTop = 0
    this.rect = { top: 0, left: 0, right: width, bottom: height, width, height }
    this.removed = false
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
  }

  contains(candidate) {
    if (candidate === this) return true
    return this.children.some(child => child.contains(candidate))
  }

  getBoundingClientRect() { return this.rect }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  setAttribute(name, value) { this.attributes.set(name, value) }
  removeAttribute(name) { this.attributes.delete(name) }
  matches(selector) {
    if (selector === '[role="dialog"]') return this.getAttribute('role') === 'dialog'
    return /input|textarea|select|pre|code|contenteditable/.test(selector) ? false : false
  }
  querySelector(selector) {
    if (selector.startsWith('[data-slot^="settings."]')) {
      if (this.getAttribute('data-slot')?.startsWith('settings.')) return this
      for (const child of this.children) {
        const found = child.querySelector(selector)
        if (found) return found
      }
      return null
    }
    return null
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]) }
  remove() { this.removed = true }
}

const root = new FakeElement({ text: '设置 通用 模型 插件', role: 'dialog', ariaModal: 'true', width: 900, height: 620 })
const settingsChild = new FakeElement({ dataSlot: 'settings.section' })
root.append(settingsChild)
const scrollable = new FakeElement({ width: 620, height: 320, clientHeight: 320, scrollHeight: 900 })
settingsChild.append(scrollable)
const styleElement = new FakeElement()
const listeners = new Map()

const document = {
  body: new FakeElement(),
  documentElement: new FakeElement(),
  head: { appendChild(element) { assert.equal(element, styleElement) } },
  querySelector(selector) { return selector.startsWith('style[') && !styleElement.removed ? null : null },
  querySelectorAll(selector) {
    if (selector.includes('data-dsh-settings-root')) return [root]
    if (selector.includes('[role="dialog"][aria-modal="true"]')) return [root]
    if (selector.startsWith('[data-slot^="settings."]')) {
      const results = []
      const walk = (el) => {
        if (el.getAttribute('data-slot')?.startsWith('settings.')) results.push(el)
        for (const child of el.children) walk(child)
      }
      walk(root)
      return results
    }
    return []
  },
  createElement(name) { assert.equal(name, 'style'); return styleElement },
  addEventListener(name, handler) { listeners.set(name, handler) },
  removeEventListener(name) { listeners.delete(name) },
}
const window = {
  innerHeight: 900,
  __ModuleLoader__: { load(definition) { window.definition = definition } },
  getComputedStyle() { return { display: 'flex', visibility: 'visible', overflowY: 'hidden' } },
  requestAnimationFrame(callback) { callback(); return 1 },
  cancelAnimationFrame() {},
  addEventListener(name, handler) { listeners.set(`window:${name}`, handler) },
  removeEventListener(name) { listeners.delete(`window:${name}`) },
}
class MutationObserver {
  constructor(callback) { this.callback = callback }
  observe() {}
  disconnect() { this.disconnected = true }
}

const source = await readFile(resolve(import.meta.dirname, '../lib/client.js'), 'utf8')
vm.runInNewContext(source, { window, document, MutationObserver, console, Symbol, Set, Map, Math })
assert.equal(window.definition.id, 'dsh-settings-scroll-fix')
const plugin = window.definition.factory()
assert.equal(typeof plugin.apply, 'function')
const dispose = plugin.apply()
assert.equal(scrollable.getAttribute('data-dssf-scrollable'), 'true')
assert.equal(listeners.has('wheel'), true)
dispose()
assert.equal(scrollable.getAttribute('data-dssf-scrollable'), null)
assert.equal(listeners.has('wheel'), false)
assert.equal(styleElement.removed, true)
console.log('Lifecycle, candidate marking, and cleanup: OK')

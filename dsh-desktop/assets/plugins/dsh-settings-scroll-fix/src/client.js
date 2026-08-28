window.__ModuleLoader__.load({
  id: 'dsh-settings-scroll-fix',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const PLUGIN_ID = 'dsh-settings-scroll-fix'
    const STYLE_ID = 'dsh-settings-scroll-fix/styles.css'
    const STATE_KEY = '__dshSettingsScrollFixV2'
    const ROOT_ATTR = 'data-dssf-settings-root'
    const SCROLL_ATTR = 'data-dssf-scrollable'
    const FLEX_ATTR = 'data-dssf-flex-min-height'
    const SETTINGS_LABELS = [
      '设置', '基础', '通用', '模型', '供应商', '插件', '外观',
      'settings', 'general', 'models', 'providers', 'plugins', 'appearance',
    ]

    const STYLE_TEXT = [
      `[${SCROLL_ATTR}="true"] {`,
      '  min-height: 0 !important;',
      '  overflow-y: auto !important;',
      '  overscroll-behavior: contain;',
      '  scrollbar-width: thin;',
      '}',
      `[${FLEX_ATTR}="true"] {`,
      '  min-height: 0 !important;',
      '}',
      `[${SCROLL_ATTR}="true"]::-webkit-scrollbar {`,
      '  width: 8px;',
      '}',
    ].join('\n')

    function isElement(value) {
      return value !== null && typeof value === 'object' && value.nodeType === 1
    }

    function rectOf(element) {
      try {
        return element.getBoundingClientRect()
      } catch {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
      }
    }

    function isVisible(element) {
      if (!isElement(element)) return false
      const rect = rectOf(element)
      if (rect.width < 1 || rect.height < 1) return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }

    function normalizedText(element) {
      return String(element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
    }

    function settingsSignalCount(element) {
      const text = normalizedText(element)
      let count = 0
      for (const label of SETTINGS_LABELS) {
        if (text.includes(label)) count += 1
      }
      return count
    }

    // 会话列骨架的稳定契约（内核 data-* 属性，非构建哈希）：设置弹层是
    // portal 到 body 的浮层，绝不会包含会话树；候选"设置根"一旦包含
    // 这些节点，说明种子匹配失真（如侧栏"设置"按钮把公共祖先爬到整页
    // 框架），必须整条丢弃 —— 否则修复器会把对话区大盒子当滚动容器打标。
    // 只收 [data-conversation-scroll] / [data-composer-seat] 两个会话骨架
    // 独占属性：[data-phase] 不是会话专属（设置弹层的 plugin-inventory
    // 分区条目同样挂 data-phase），纳入判定会把设置浮层自己误判成"含
    // 会话树"而整条拒绝，令修复在 role=dialog 缺失的形态下整体失效。
    const CONVERSATION_GUARD_SELECTOR = '[data-conversation-scroll], [data-composer-seat]'

    function containsConversationTree(element) {
      try {
        return element.querySelector(CONVERSATION_GUARD_SELECTOR) !== null
      } catch {
        return false
      }
    }

    function promoteToSettingsRoot(seed) {
      let current = seed
      for (let depth = 0; isElement(current) && depth < 9; depth += 1) {
        if (current === document.body || current === document.documentElement) break
        const rect = rectOf(current)
        const role = String(current.getAttribute('role') || '').toLowerCase()
        // dialog 分支同样要求不含会话树：浮层形态的"设置根"绝不含
        // 会话骨架，含之即为种子失真（与下方 250x180 分支同一判定）。
        if (role === 'dialog' && rect.width >= 200 && rect.height >= 150 && settingsSignalCount(current) >= 1 && !containsConversationTree(current)) return current
        if (rect.width >= 250 && rect.height >= 180 && settingsSignalCount(current) >= 2) {
          // 含会话树的大框（整页框架/中心列）不是设置浮层：hero 首页的
          // "设置"按钮等词表命中会把公共祖先爬到这里，误标会话区。
          if (!containsConversationTree(current)) return current
        }
        current = current.parentElement
      }
      return null
    }

    function commonAncestor(elements) {
      if (elements.length === 0) return null
      let candidate = elements[0]
      while (isElement(candidate)) {
        if (elements.every(element => candidate.contains(element))) return candidate
        candidate = candidate.parentElement
      }
      return null
    }

    function discoverSettingsRoots() {
      const seeds = []
      const selectors = [
        '[data-dsh-settings-root]',
        '[data-slot^="settings."]',
        '[aria-label*="设置"]',
        '[aria-label*="Settings"]',
        '[role="dialog"]',
      ]
      for (const selector of selectors) {
        try {
          seeds.push(...document.querySelectorAll(selector))
        } catch {
          // Ignore unsupported selectors in older Chromium builds.
        }
      }

      const navigationSignals = []
      for (const element of document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], nav a, nav button')) {
        const text = normalizedText(element)
        if (text.length <= 32 && SETTINGS_LABELS.some(label => text.includes(label)) && isVisible(element)) {
          navigationSignals.push(element)
        }
      }
      if (navigationSignals.length >= 1) {
        const ancestor = commonAncestor(navigationSignals)
        if (ancestor !== null) seeds.push(ancestor)
      }

      const roots = []
      for (const seed of seeds) {
        if (!isVisible(seed)) continue
        const root = promoteToSettingsRoot(seed)
        if (root === null || roots.includes(root)) continue
        roots.push(root)
      }
      return roots
    }

    function isExcludedScrollable(element) {
      try {
        return element.matches('input, textarea, select, pre, code, [contenteditable="true"]')
      } catch {
        return false
      }
    }

    function scoreCandidate(element, root) {
      if (!isVisible(element) || isExcludedScrollable(element)) return -1
      // 会话区契约元素与其内部一律不打标（纵深兜底）：hero 阶段的
      // composerStack 因发光背景 svg 天然 scrollHeight > clientHeight，
      // 曾经以此得分被打上滚动容器标记，overflow-y:auto 连带 overflow-x
      // 变 auto，横竖双滚动条 + 输入卡底部裁切（2026-08-28 事故）。
      // 排除列表与"设置根"守卫同一套会话骨架契约（不含 [data-phase]，
      // 理由见 CONVERSATION_GUARD_SELECTOR），[class*="composer"] 对
      // 内核 CSS-module 哈希类名（*_composer*）作纵深兜底。
      try {
        if (element.matches('[data-conversation-scroll], [data-composer-seat], [data-composer-card], [class*="composer"]')) return -1
        if (element.closest('[data-conversation-scroll]') !== null) return -1
      } catch {
        // 选择器不受支持时按不排除处理，保持旧行为。
      }
      const clientHeight = Number(element.clientHeight || 0)
      const scrollHeight = Number(element.scrollHeight || 0)
      if (clientHeight < 24 || scrollHeight <= clientHeight + 1) return -1

      const rect = rectOf(element)
      const rootRect = rectOf(root)
      if (rect.width < 50 || rect.height < 40) return -1

      const style = window.getComputedStyle(element)
      let score = Math.min(scrollHeight - clientHeight, 2000)
      if (style.overflowY === 'hidden' || style.overflowY === 'clip') score += 600
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') score += 300
      const role = String(element.getAttribute('role') || '').toLowerCase()
      if (role === 'navigation' || role === 'tablist') score += 400
      if (element.tagName === 'NAV') score += 500
      if (rootRect.width > 0 && rect.width < rootRect.width * 0.45) score += 120
      score += Math.min(rect.width * rect.height / 1000, 300)
      return score
    }

    function collectScrollableCandidates(root) {
      const all = [root, ...root.querySelectorAll('*')]
      // Also include nav elements within the root
      const navElements = root.querySelectorAll('nav')
      const combined = [...new Set([...all, ...navElements])]
      return combined
        .map(element => ({ element, score: scoreCandidate(element, root) }))
        .filter(entry => entry.score >= 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 8)
        .map(entry => entry.element)
    }

    function install() {
      if (typeof document === 'undefined' || document.documentElement === null) return () => {}

      const previous = window[STATE_KEY]
      if (previous !== undefined && typeof previous.dispose === 'function') previous.dispose()

      let style = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
      if (style === null) {
        style = document.createElement('style')
        style.dataset.plugin = PLUGIN_ID
        style.dataset.pluginCss = STYLE_ID
        style.textContent = STYLE_TEXT
        document.head.appendChild(style)
      }

      let markedRoots = new Set()
      let markedScrollables = new Set()
      let markedFlexItems = new Set()
      let animationFrame = 0
      let disposed = false

      const syncMarks = (previousSet, nextSet, attribute) => {
        for (const element of previousSet) {
          if (!nextSet.has(element)) element.removeAttribute(attribute)
        }
        for (const element of nextSet) element.setAttribute(attribute, 'true')
      }

      const repair = () => {
        animationFrame = 0
        if (disposed) return

        const nextRoots = new Set(discoverSettingsRoots())
        const nextScrollables = new Set()
        const nextFlexItems = new Set()
        for (const root of nextRoots) {
          for (const candidate of collectScrollableCandidates(root)) {
            nextScrollables.add(candidate)
            let parent = candidate.parentElement
            while (isElement(parent) && parent !== root) {
              const display = window.getComputedStyle(parent).display
              if (display === 'flex' || display === 'grid') nextFlexItems.add(parent)
              parent = parent.parentElement
            }
          }
        }

        syncMarks(markedRoots, nextRoots, ROOT_ATTR)
        syncMarks(markedScrollables, nextScrollables, SCROLL_ATTR)
        syncMarks(markedFlexItems, nextFlexItems, FLEX_ATTR)
        markedRoots = nextRoots
        markedScrollables = nextScrollables
        markedFlexItems = nextFlexItems
      }

      const scheduleRepair = () => {
        if (disposed || animationFrame !== 0) return
        animationFrame = window.requestAnimationFrame(repair)
      }

      const canScroll = (element, delta) => {
        if (element.scrollHeight <= element.clientHeight) return false
        if (delta < 0) return element.scrollTop > 0
        return element.scrollTop + element.clientHeight < element.scrollHeight
      }

      const wheelDeltaPixels = event => {
        if (event.deltaMode === 1) return event.deltaY * 16
        if (event.deltaMode === 2) return event.deltaY * window.innerHeight
        return event.deltaY
      }

      const onWheel = event => {
        if (event.defaultPrevented || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
        const root = [...markedRoots].find(candidate => path.some(node => isElement(node) && candidate.contains(node)))
        if (root === undefined) return

        const delta = wheelDeltaPixels(event)
        let target = path.find(node => isElement(node) && markedScrollables.has(node) && canScroll(node, delta))
        if (target === undefined) {
          target = [...markedScrollables].find(node => root.contains(node) && canScroll(node, delta))
        }
        if (target === undefined) return

        event.preventDefault()
        target.scrollTop += delta
      }

      const observer = new MutationObserver(scheduleRepair)
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
      })
      document.addEventListener('wheel', onWheel, { capture: true, passive: false })
      window.addEventListener('resize', scheduleRepair)
      scheduleRepair()

      const dispose = () => {
        if (disposed) return
        disposed = true
        observer.disconnect()
        document.removeEventListener('wheel', onWheel, true)
        window.removeEventListener('resize', scheduleRepair)
        if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame)
        for (const element of markedRoots) element.removeAttribute(ROOT_ATTR)
        for (const element of markedScrollables) element.removeAttribute(SCROLL_ATTR)
        for (const element of markedFlexItems) element.removeAttribute(FLEX_ATTR)
        style.remove()
        if (window[STATE_KEY] !== undefined && window[STATE_KEY].dispose === dispose) {
          delete window[STATE_KEY]
        }
      }

      window[STATE_KEY] = { dispose, repair: scheduleRepair }
      return dispose
    }

    exports.apply = install
    exports.inject = []
    return module.exports
  },
})

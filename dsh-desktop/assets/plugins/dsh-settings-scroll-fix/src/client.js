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
    const SETTINGS_SLOT_PREFIX = 'settings.'

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

    function isSettingsDialog(element) {
      if (!isElement(element)) return false
      const role = String(element.getAttribute('role') || '').toLowerCase()
      if (role !== 'dialog') return false
      const ariaModal = String(element.getAttribute('aria-modal') || '').toLowerCase()
      if (ariaModal !== 'true') return false
      return element.querySelector(`[data-slot^="${SETTINGS_SLOT_PREFIX}"]`) !== null
    }

    function hasSettingsSlotDescendant(element) {
      if (!isElement(element)) return false
      try {
        return element.querySelector(`[data-slot^="${SETTINGS_SLOT_PREFIX}"]`) !== null
      } catch {
        return false
      }
    }

    function promoteToSettingsRoot(seed) {
      let current = seed
      for (let depth = 0; isElement(current) && depth < 9; depth += 1) {
        if (current === document.body || current === document.documentElement) break
        if (isSettingsDialog(current)) return current
        const rect = rectOf(current)
        if (rect.width >= 250 && rect.height >= 180 && hasSettingsSlotDescendant(current)) return current
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
      const seen = new Set()

      const tryPush = (elements) => {
        for (const el of elements) {
          if (!seen.has(el)) {
            seen.add(el)
            seeds.push(el)
          }
        }
      }

      // Layer 1: Plugin custom marks (backward compat)
      try { tryPush(document.querySelectorAll('[data-dsh-settings-root]')) } catch {}

      // Layer 2: DSH official settings slot containers
      try { tryPush(document.querySelectorAll(`[data-slot^="${SETTINGS_SLOT_PREFIX}"]`)) } catch {}

      // Layer 3: Settings dialog (role + aria-modal + must contain settings slot descendant)
      try {
        for (const el of document.querySelectorAll('div[role="dialog"][aria-modal="true"]')) {
          if (hasSettingsSlotDescendant(el)) tryPush([el])
        }
      } catch {}

      // Layer 4: Settings trigger button region (fallback)
      try {
        for (const btn of document.querySelectorAll('button[aria-haspopup="dialog"]')) {
          try {
            const slotAncestor = btn.closest(`[data-slot^="${SETTINGS_SLOT_PREFIX}"]`)
              || btn.closest('[data-slot="sidebar.settings"]')
            if (slotAncestor) tryPush([slotAncestor])
          } catch {}
        }
      } catch {}

      // Layer 5: aria-label fallback
      try { tryPush(document.querySelectorAll('[aria-label*="设置"]')) } catch {}
      try { tryPush(document.querySelectorAll('[aria-label*="Settings"]')) } catch {}

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

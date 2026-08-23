// Browser half of dsh-message-rewind — Trae-style "edit a sent message and
// regenerate from there".
//
// Architecture (all client-side, public services only):
//   1. An invisible occupant in the "conversation.composer.dock" list slot
//      mounts once per session. Its standard props carry sessionId +
//      inputActions (setDraft/addImages/submit), and the useSession hook
//      yields the chat-node snapshot — we distill it into { userMessages,
//      turnEndSeqs } and remember the latest per session.
//   2. A MutationObserver decorates every user message row
//      ([data-chat-flow-kind="user"]) with a hover "edit & rewind" button.
//   3. On confirm: sessions.fork({ sessionId, atSeq: previousTurnEndSeq })
//      forks the log at the completed-turn boundary BEFORE the target message
//      (fork cuts at "the first turn/end at or after atSeq", so anchoring on
//      the previous turn's end excludes the message being rewritten), the
//      child is opened, and once its composer mounts we setDraft(edited) +
//      re-add images + submit(). If the child composer never surfaces, the
//      edited text falls back to the clipboard with a toast.
window.__ModuleLoader__.load({ id: 'dsh-message-rewind', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  const React = require('react')
  const h = React.createElement

  let LOCALE = 'zh'
  try {
    const nl = String(navigator.language || navigator.userLanguage || '')
    if (!nl.toLowerCase().startsWith('zh')) LOCALE = 'en'
  } catch (e) {}

  const STR = {
    zh: {
      edit: '编辑并回退',
      title: '编辑并回退',
      hint: '从这条消息之前分叉出新会话，并以编辑后的内容重新发送；原会话保留不动。',
      firstMsg: '首条消息不支持回退（前面没有完整回合），请新建会话后重新发送。',
      cancel: '取消',
      go: '回退并重发',
      forking: '正在分叉会话…',
      forkFail: '回退失败',
      okResent: '已回退并重新发送',
      fallbackCopied: '新会话输入框未能就绪，编辑后的内容已复制到剪贴板，请粘贴发送。',
      imagesKept: '将随消息重新附加 {n} 张图片',
      busy: '当前回合仍在进行，等它结束后再回退。',
    },
    en: {
      edit: 'Edit & rewind',
      title: 'Edit & rewind',
      hint: 'Forks a new session from just before this message and resends it edited; the original session is kept untouched.',
      firstMsg: 'The first message cannot be rewound (no completed turn before it) — start a new session instead.',
      cancel: 'Cancel',
      go: 'Rewind & resend',
      forking: 'Forking session…',
      forkFail: 'Rewind failed',
      okResent: 'Rewound and resent',
      fallbackCopied: 'The new session composer did not surface; the edited text was copied to the clipboard — paste and send.',
      imagesKept: '{n} image(s) will be re-attached',
      busy: 'A turn is still running — wait for it to finish before rewinding.',
    },
  }
  const t = (key, vars) => {
    let s = (STR[LOCALE] && STR[LOCALE][key]) || STR.en[key] || key
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]))
    return s
  }

  // ── per-session capture ─────────────────────────────────────────────────
  // sessionId -> { inputActions, users: [{key,seq,text,imageIds}], turnEnds: [seq] }
  const captures = new Map()
  let currentSessionId = null

  function blockText(content) {
    const parts = []
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
    return parts.join('\n')
  }

  function blockImages(content) {
    const ids = []
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'image' && b.attachment) {
          const id = b.attachment.id || b.attachment.attachmentId
          if (id) ids.push(id)
        }
      }
    }
    return ids
  }

  // Nodes whose anchorSeq is a valid completed-turn boundary for
  // sessions.fork (turn-tail / terminal turn states). Compaction rows sit
  // BETWEEN turns, so their seq must never be used as an anchor: fork cuts at
  // "the first turn/end at or after atSeq", and a compaction seq would resolve
  // to the NEXT turn's end (wrong prefix).
  const TURN_END_KINDS = new Set(['turn-tail', 'turn-error', 'turn-max-tokens'])

  function selector(snapshot) {
    try {
      const nodes = snapshot && snapshot.chat && snapshot.chat.nodes
      if (!nodes || typeof nodes.values !== 'function') return ''
      const users = []
      const turnEnds = []
      for (const node of nodes.values()) {
        if (!node) continue
        if (node.kind === 'user') {
          const d = node.data || {}
          users.push({
            key: node.key,
            seq: node.anchorSeq,
            text: blockText(d.content),
            imageIds: blockImages(d.content),
          })
        } else if (TURN_END_KINDS.has(node.kind)) {
          turnEnds.push(node.anchorSeq)
        }
      }
      users.sort((a, b) => a.seq - b.seq)
      turnEnds.sort((a, b) => a.seq - b.seq)
      return JSON.stringify({ users, turnEnds })
    } catch (e) {
      return ''
    }
  }

  // Invisible dock occupant: receives sessionId + inputActions as standard
  // props and mirrors the distilled snapshot. Renders null forever.
  function RewindCapture({ sessionId, useSession, inputActions }) {
    let summary = ''
    try {
      if (typeof useSession === 'function') summary = useSession(selector) || ''
    } catch (e) { summary = '' }
    try {
      let cap = captures.get(sessionId)
      if (!cap) { cap = { inputActions: null, users: [], turnEnds: [] }; captures.set(sessionId, cap) }
      cap.inputActions = inputActions || cap.inputActions
      if (summary) {
        const parsed = JSON.parse(summary)
        cap.users = parsed.users || []
        cap.turnEnds = parsed.turnEnds || []
      }
      currentSessionId = sessionId
    } catch (e) { /* capture is best-effort */ }
    return null
  }

  // ── DOM decoration ──────────────────────────────────────────────────────

  const PENCIL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>'

  function findUserByKey(cap, key) {
    if (!cap) return null
    return cap.users.find((u) => u.key === key) || null
  }

  function onEditClick(rowEl) {
    const key = rowEl.getAttribute('data-chat-anchor-key')
    // Snapshot the session id at click time: the modal stays open across
    // session switches, and the rewind must target the session the message
    // belongs to, not whatever is current when the user confirms.
    const sid = currentSessionId
    const cap = sid ? captures.get(sid) || null : null
    const user = findUserByKey(cap, key)
    if (!user) { toast(t('forkFail') + ': message context unavailable'); return }
    openModal(user, cap, sid)
  }

  function decorate(root) {
    const rows = root.querySelectorAll('[data-chat-flow-kind="user"]')
    for (const row of rows) {
      if (row.dataset.dshRwDecorated) continue
      row.dataset.dshRwDecorated = '1'
      row.classList.add('dshrw-userrow')
      const btn = document.createElement('button')
      btn.className = 'dshrw-editbtn'
      btn.type = 'button'
      btn.title = t('edit')
      btn.setAttribute('aria-label', t('edit'))
      btn.innerHTML = PENCIL_SVG + '<span>' + t('edit') + '</span>'
      btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); onEditClick(row) })
      row.appendChild(btn)
    }
  }

  function watchDom() {
    const scan = () => { try { decorate(document) } catch (e) { /* ignore */ } }
    scan()
    const mo = new MutationObserver(scan)
    mo.observe(document.body, { childList: true, subtree: true })
    // Belt-and-braces: MutationObserver covers structural changes, the slow
    // interval covers attribute-only rewrites (row reuse on session switch).
    setInterval(scan, 1500)
  }

  // ── modal ───────────────────────────────────────────────────────────────

  let modalEl = null

  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null }
  }

  function toast(text, ms) {
    const el = document.createElement('div')
    el.className = 'dshrw-toast'
    el.textContent = text
    document.body.appendChild(el)
    requestAnimationFrame(() => el.classList.add('dshrw-toast-on'))
    setTimeout(() => {
      el.classList.remove('dshrw-toast-on')
      setTimeout(() => el.remove(), 300)
    }, ms || 3200)
  }

  function openModal(user, cap, sessionId) {
    closeModal()
    const anchorSeq = anchorFor(user, cap)
    const overlay = document.createElement('div')
    overlay.className = 'dshrw-overlay'
    overlay.innerHTML =
      '<div class="dshrw-modal" role="dialog" aria-modal="true">' +
        '<div class="dshrw-title">' + escapeHtml(t('title')) + '</div>' +
        '<div class="dshrw-hint">' + escapeHtml(t('hint')) + '</div>' +
        (user.imageIds && user.imageIds.length
          ? '<div class="dshrw-imghint">' + escapeHtml(t('imagesKept', { n: user.imageIds.length })) + '</div>'
          : '') +
        '<textarea class="dshrw-textarea" rows="7"></textarea>' +
        '<div class="dshrw-foot">' +
          '<button type="button" class="dshrw-btn dshrw-cancel">' + escapeHtml(t('cancel')) + '</button>' +
          '<button type="button" class="dshrw-btn dshrw-go">' + escapeHtml(t('go')) + '</button>' +
        '</div>' +
      '</div>'
    const ta = overlay.querySelector('.dshrw-textarea')
    ta.value = user.text || ''
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal() })
    overlay.querySelector('.dshrw-cancel').addEventListener('click', closeModal)
    overlay.querySelector('.dshrw-go').addEventListener('click', () => {
      const edited = ta.value
      const btnGo = overlay.querySelector('.dshrw-go')
      btnGo.disabled = true
      btnGo.textContent = t('forking')
      performRewind(user, cap, edited, sessionId).then((ok) => {
        if (ok) closeModal()
        else { btnGo.disabled = false; btnGo.textContent = t('go') }
      })
    })
    document.body.appendChild(overlay)
    modalEl = overlay
    setTimeout(() => { try { ta.focus() } catch (e) {} }, 30)
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }

  // The fork anchor: the last completed-turn boundary strictly before this
  // user message. fork cuts at "the first turn/end at or after atSeq", so the
  // previous turn's end yields a prefix WITHOUT the message being rewritten.
  function anchorFor(user, cap) {
    if (!cap) return null
    let best = null
    for (const seq of cap.turnEnds) {
      if (seq < user.seq && (best === null || seq > best)) best = seq
    }
    return best
  }

  function waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const tick = () => {
        let v = null
        try { v = predicate() } catch (e) { v = null }
        if (v) return resolve(v)
        if (Date.now() - startedAt >= timeoutMs) return resolve(null)
        setTimeout(tick, 120)
      }
      tick()
    })
  }

  let sessionsFace = null

  async function performRewind(user, cap, editedText, sessionId) {
    if (!sessionId || !sessionsFace) { toast(t('forkFail') + ': session context unavailable'); return false }
    const anchorSeq = anchorFor(user, cap)
    if (anchorSeq === null) { toast(t('firstMsg')); return false }
    try {
      const childId = await sessionsFace.fork({ sessionId, atSeq: anchorSeq, increaseTitle: true })
      sessionsFace.open(childId)
      const cap2 = await waitFor(() => {
        const c = captures.get(childId)
        return c && c.inputActions ? c : null
      }, 8000)
      if (!cap2) {
        copyText(editedText)
        toast(t('fallbackCopied'), 5000)
        return true // modal closes; session switch already happened
      }
      const send = () => {
        try {
          cap2.inputActions.setDraft(editedText)
          try { if (user.imageIds && user.imageIds.length) cap2.inputActions.addImages(user.imageIds) } catch (e) { /* best-effort */ }
          cap2.inputActions.submit()
          toast(t('okResent'))
        } catch (e) {
          copyText(editedText)
          toast(t('fallbackCopied'), 5000)
        }
      }
      // Give the freshly-opened child a beat to mount its input machine
      // before submitting (draft mirror + busy state settle synchronously,
      // but a frame avoids racing the composer render).
      setTimeout(send, 220)
      return true
    } catch (e) {
      toast(t('forkFail') + ': ' + String((e && e.message) || e))
      return false
    }
  }

  function copyText(text) {
    try { navigator.clipboard.writeText(text) } catch (e) { /* best-effort */ }
  }

  // ── styles ──────────────────────────────────────────────────────────────

  const REWIND_CSS = `
.dshrw-userrow{position:relative}
.dshrw-editbtn{position:absolute;top:-4px;right:2px;display:inline-flex;align-items:center;gap:4px;
  height:22px;padding:0 8px;border:none;border-radius:999px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2,#1a2337);color:var(--dsw-alias-label-secondary,#b8c5ea);
  font:500 11px/1 var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif);
  opacity:0;transition:opacity .12s ease;box-shadow:0 1px 6px rgba(0,0,0,.3)}
.dshrw-userrow:hover .dshrw-editbtn,.dshrw-editbtn:focus-visible{opacity:1}
.dshrw-editbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#eef2ff)}
.dshrw-overlay{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;
  background:rgba(4,8,18,.55);backdrop-filter:blur(4px)}
.dshrw-modal{width:min(640px,calc(100vw - 48px));max-height:calc(100vh - 96px);display:flex;flex-direction:column;gap:10px;
  padding:18px 20px;border-radius:14px;box-sizing:border-box;
  background:var(--dsw-alias-bg-layer-2,#111a2e);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));
  box-shadow:0 18px 60px rgba(0,0,0,.5);color:var(--dsw-alias-label-primary,#e6ecff);
  font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif)}
.dshrw-title{font-size:15px;font-weight:600}
.dshrw-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b9ac4)}
.dshrw-imghint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a9b8de)}
.dshrw-textarea{width:100%;min-height:140px;resize:vertical;box-sizing:border-box;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-1,#0b1220);
  color:var(--dsw-alias-label-primary,#e6ecff);font:13px/1.6 var(--ds-font-family-code,Consolas,monospace);outline:none}
.dshrw-textarea:focus{border-color:var(--dsw-alias-button-info-fill,#6187d8)}
.dshrw-foot{display:flex;justify-content:flex-end;gap:8px}
.dshrw-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:transparent;color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;font-size:13px}
.dshrw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dshrw-go{background:var(--dsw-alias-button-info-fill,#2e5cdf);border-color:transparent;color:#fff;font-weight:500}
.dshrw-go:hover{filter:brightness(1.1)}
.dshrw-go:disabled{opacity:.6;cursor:default}
.dshrw-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%) translateY(8px);z-index:2147483300;
  max-width:min(520px,calc(100vw - 40px));padding:9px 16px;border-radius:10px;font-size:13px;
  background:var(--dsw-alias-bg-layer-2,#1a2337);color:var(--dsw-alias-label-primary,#e6ecff);
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 8px 30px rgba(0,0,0,.45);
  opacity:0;transition:opacity .25s ease,transform .25s ease;pointer-events:none}
.dshrw-toast-on{opacity:1;transform:translateX(-50%) translateY(0)}
`

  const inject = ['slots', 'sessions']

  function apply(ctx) {
    const slots = ctx.get('slots')
    sessionsFace = ctx.get('sessions')
    if (slots === undefined) return
    ctx.effect(() => {
      const id = 'dsh-rewind-style'
      if (!document.getElementById(id)) {
        const s = document.createElement('style')
        s.id = id
        s.textContent = REWIND_CSS
        document.head.appendChild(s)
      }
      return () => { const el = document.getElementById(id); if (el) el.remove() }
    }, 'rewind-style')
    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: 'rewind-capture', order: 90 },
      RewindCapture,
    ))
    try { watchDom() } catch (e) { /* decoration is best-effort */ }
  }

  module.exports = { inject, apply }
  return module.exports;
} })

(function () {
  'use strict'
  // 退出确认 overlay：叠加到主窗，不新建窗口、不替换页面。
  // 按钮颜色：蓝=最小化到托盘、红=退出应用、灰=取消。
  var CSS = [
    '#dsh-exit-overlay{position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(5,10,24,.65);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}',
    '#dsh-exit-card{background:#1e1e2e;border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:28px 32px 22px;width:380px;box-shadow:0 12px 48px rgba(0,0,0,.6);user-select:none}',
    '#dsh-exit-card .hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}',
    '#dsh-exit-card .title{font-size:17px;font-weight:600;color:#dfe6ff}',
    '#dsh-exit-card .sub{font-size:12px;color:#8b9ac4;margin-bottom:20px;line-height:1.5}',
    '#dsh-exit-card .btns{display:flex;flex-direction:column;gap:9px}',
    '#dsh-exit-card .btn-min{padding:10px;border:1px solid rgba(91,140,255,.35);border-radius:10px;background:rgba(91,140,255,.12);color:#a8c4ff;font-size:13.5px;cursor:pointer;text-align:center;transition:background .15s}',
    '#dsh-exit-card .btn-min:hover{background:rgba(91,140,255,.22)}',
    '#dsh-exit-card .btn-quit{padding:10px;border:1px solid rgba(232,50,70,.30);border-radius:10px;background:rgba(232,50,70,.10);color:#ff8a94;font-size:13.5px;cursor:pointer;text-align:center;transition:background .15s}',
    '#dsh-exit-card .btn-quit:hover{background:rgba(232,50,70,.20)}',
    '#dsh-exit-card .btn-cancel{padding:8px;border:none;border-radius:10px;background:transparent;color:#6e7f9e;font-size:12.5px;cursor:pointer;text-align:center;transition:color .15s}',
    '#dsh-exit-card .btn-cancel:hover{color:#a8b8d0}',
    '@media(hover:none){#dsh-exit-card .btn-min,#dsh-exit-card .btn-quit,#dsh-exit-card .btn-cancel{padding:13px}}',
  ].join('\n')
  var HTML = [
    '<div id="dsh-exit-overlay">',
    '  <div id="dsh-exit-card">',
    '    <div class="hdr"><span class="title">退出 Deepseek Harness</span></div>',
    '    <div class="sub">后台运行时窗口会隐藏到系统托盘，任务完成后会发通知。</div>',
    '    <div class="btns">',
    '      <button class="btn-min" data-v="minimize">最小化到托盘</button>',
    '      <button class="btn-quit" data-v="quit">退出应用</button>',
    '      <button class="btn-cancel" data-v="cancel">取消</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n')

  function dismiss() {
    var el = document.getElementById('dsh-exit-overlay')
    if (el) el.remove()
  }

  function show() {
    dismiss()
    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    document.body.insertAdjacentHTML('beforeend', HTML)
    document.querySelectorAll('[data-v]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-v')
        dismiss()
        if (window.dshDesktop && window.dshDesktop._call) {
          var target = v === 'cancel' ? 'win.close-dialog' : (v === 'quit' ? 'win.close-force' : 'win.hide-and-close-dialog')
          window.dshDesktop._call(target, {}).catch(function () { dismiss() })
        } else {
          dismiss()
        }
      })
    })
    // Escape / Cmd+W 取消
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape' || (e.metaKey && e.key === 'w')) {
        e.preventDefault()
        dismiss()
        if (window.dshDesktop && window.dshDesktop._call) window.dshDesktop._call('win.close-dialog', {})
        else dismiss()
        document.removeEventListener('keydown', onKey)
      }
    })
  }

  window.__dshExitOverlay = { show: show, dismiss: dismiss }
  show()
})()

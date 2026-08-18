window.__ModuleLoader__.load({ id: 'dsh-dafeiyu', factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  const React = require('react')
  const { useEffect, useState } = React
  const CONFIG_ENDPOINT = '/plugins/dsh-dafeiyu/config'

  const cardStyle = {
    listStyle: 'none', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 12,
    padding: 16, background: 'var(--surface-color, transparent)', display: 'grid', gap: 14,
  }
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20 }
  const selectStyle = { minWidth: 120, padding: '6px 10px', borderRadius: 8 }

  function Field({ label, hint, children }) {
    return React.createElement('label', { style: rowStyle },
      React.createElement('span', null,
        React.createElement('span', { style: { display: 'block', fontWeight: 600 } }, label),
        React.createElement('small', { style: { display: 'block', opacity: 0.65, marginTop: 3 } }, hint),
      ),
      children,
    )
  }

  function BigFishCard() {
    const [status, setStatus] = useState('loading')
    const [value, setValue] = useState({})
    const [busy, setBusy] = useState(false)
    const writable = status === 'ready' && !busy
    useEffect(() => {
      let active = true
      fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`settings request failed: ${response.status}`)
          return response.json()
        })
        .then((next) => { if (active) { setValue(next); setStatus('ready') } })
        .catch(() => { if (active) setStatus('unavailable') })
      return () => { active = false }
    }, [])
    const write = async (field, next) => {
      setBusy(true)
      try {
        const response = await fetch(CONFIG_ENDPOINT, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: next }),
        })
        if (!response.ok) throw new Error(`settings write failed: ${response.status}`)
        setValue(await response.json())
        setStatus('ready')
      } catch {
        setStatus('unavailable')
      } finally {
        setBusy(false)
      }
    }
    return React.createElement('li', { style: cardStyle, 'data-testid': 'dsh-dafeiyu-settings' },
      React.createElement('div', null,
        React.createElement('strong', { style: { fontSize: 16 } }, '大肥鱼桌面伴侣'),
        React.createElement('p', { style: { margin: '5px 0 0', opacity: 0.72 } }, '入口和状态属于 DSH，鱼始终显示在 Windows 桌面最上层。'),
      ),
      status === 'unavailable'
        ? React.createElement('span', { role: 'status' }, '大肥鱼设置尚未连接到 DSH Host。')
        : status === 'loading'
        ? React.createElement('span', null, '正在读取设置…')
        : React.createElement(React.Fragment, null,
          React.createElement(Field, { label: '启用大肥鱼', hint: '关闭后立即退出；重新开启无需单独启动程序。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.enabled !== false, disabled: !writable,
              onChange: (event) => void write('enabled', event.target.checked),
            }),
          ),
          React.createElement(Field, { label: '角色大小', hint: `${Math.round((value.scale ?? 1) * 100)}%` },
            React.createElement('input', {
              type: 'range', min: 0.7, max: 1.4, step: 0.05, value: value.scale ?? 1, disabled: !writable,
              onChange: (event) => void write('scale', Number(event.target.value)),
            }),
          ),
          React.createElement(Field, { label: '活跃程度', hint: '控制空闲时微动作的出现频率。' },
            React.createElement('select', {
              value: value.activityLevel ?? 'normal', disabled: !writable, style: selectStyle,
              onChange: (event) => void write('activityLevel', event.target.value),
            },
            React.createElement('option', { value: 'quiet' }, '安静'),
            React.createElement('option', { value: 'normal' }, '标准'),
            React.createElement('option', { value: 'lively' }, '活泼')),
          ),
          React.createElement(Field, { label: '减少动态效果', hint: '减少走动、循环帧和程序化晃动。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.reducedMotion === true, disabled: !writable,
              onChange: (event) => void write('reducedMotion', event.target.checked),
            }),
          ),
          React.createElement(Field, { label: '响应子 Agent', hint: '默认只跟随顶层任务，避免状态过度跳动。' },
            React.createElement('input', {
              type: 'checkbox', checked: value.includeSubagents === true, disabled: !writable,
              onChange: (event) => void write('includeSubagents', event.target.checked),
            }),
          ),
          busy ? React.createElement('small', { role: 'status' }, '正在保存…') : null,
        ),
    )
  }

  function apply(ctx) {
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item', id: 'dsh-dafeiyu', key: 'dsh-dafeiyu', order: 30,
      inject: () => ({}),
    }, BigFishCard))
  }

  module.exports = {
    name: 'dsh-dafeiyu-client',
    inject: ['slots'],
    apply,
  }
  return module.exports
} })

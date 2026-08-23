// dsh-pet-settings — 设置页「桌宠」分区（DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 注册 settings.section「桌宠」，集中管理两只宠物：
//     1. 页面桌宠（dsh-pet）：启用/停用开关走 window.dshDesktop.pluginManager
//        桥（写 profile cordis.patch.yml，重启后生效，与「插件 → 管理」
//        同一语义）；大小/位置在桌宠自己的齿轮面板调整，这里给出提示。
//     2. 大肥鱼桌面伴侣（dsh-dafeiyu）：启用、角色大小、空闲微动作频率、
//        减少动态 —— 直接 PATCH /plugins/dsh-dafeiyu/config（同源，服务
//        端热应用，无需重启），与插件页内的「大肥鱼设置」卡片同一端点。
//   · 与 dsh-dafeiyu 的 settings.plugin.item 卡片并存：两处入口同一后端。
window.__ModuleLoader__.load({
  id: 'dsh-pet-settings',
  factory: function (require) {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { useEffect, useState } = React;

    const FISH_ENDPOINT = '/plugins/dsh-dafeiyu/config';

    const CARD_STYLE = {
      listStyle: 'none', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 12,
      padding: 16, background: 'var(--surface-color, transparent)', display: 'grid', gap: 14,
    };
    const ROW_STYLE = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20 };
    const SELECT_STYLE = { minWidth: 120, padding: '6px 10px', borderRadius: 6, background: 'var(--surface-color, transparent)' };
    const TOGGLE_STYLE = { width: 16, height: 16, accentColor: 'var(--accent-color, #5e9cff)' };

    function Field({ label, hint, children }) {
      return React.createElement('label', { style: ROW_STYLE },
        React.createElement('span', null,
          React.createElement('span', { style: { display: 'block', fontWeight: 600 } }, label),
          hint ? React.createElement('small', { style: { display: 'block', opacity: 0.65, marginTop: 3 } }, hint) : null,
        ),
        children,
      );
    }

    function Status({ kind, text }) {
      if (!text) return null;
      return React.createElement('div', { role: 'status', style: { fontSize: 12, color: kind === 'ok' ? '#7fd6a0' : kind === 'err' ? '#e5484d' : 'inherit', opacity: 0.85 } }, text);
    }

    function pluginRowsFrom(result) {
      if (Array.isArray(result)) return result;
      if (Array.isArray(result && result.rows)) return result.rows;
      if (Array.isArray(result && result.entries)) return result.entries;
      return [];
    }

    function pluginRow(rows, id) {
      return rows.find((item) => item && (item.id === id || item.entryId === id)) || null;
    }

    // ── 页面桌宠（dsh-pet）开关 ──────────────────────────────
    function PagePetCard() {
      const [state, setState] = useState({ loaded: false, enabled: false, busy: false, pending: null, notice: null, err: null });
      useEffect(() => {
        let active = true;
        const b = window.dshDesktop && window.dshDesktop.pluginManager;
        if (!b) { if (active) setState((s) => ({ ...s, err: '插件管理桥不可用' })); return; }
        b.list().then((res) => {
          if (!active) return;
          const row = pluginRow(pluginRowsFrom(res), 'dsh-pet');
          setState((s) => ({ ...s, loaded: true, enabled: !!(row && row.enabled), err: null }));
        }).catch((err) => {
          if (active) setState((s) => ({
            ...s,
            loaded: true,
            err: '读取桌宠状态失败: ' + String((err && err.message) || err),
          }));
        });
        return () => { active = false; };
      }, []);

      const toggle = (enabled) => {
        const b = window.dshDesktop && window.dshDesktop.pluginManager;
        if (!b || state.busy) return;
        setState((s) => ({ ...s, busy: true, pending: enabled, notice: null, err: null }));
        b.setEnabled('dsh-pet', enabled).then((res) => {
          setState((s) => ({
            ...s, busy: false, pending: null,
            enabled: res && res.ok ? enabled : s.enabled,
            notice: res && res.ok ? (enabled ? '已启用，重启应用后生效' : '已停用，重启应用后生效') : null,
            err: res && !res.ok ? String(res.error || '操作失败') : null,
          }));
        }).catch((err) => {
          setState((s) => ({ ...s, busy: false, pending: null, err: String((err && err.message) || err) }));
        });
      };

      const shown = state.pending !== null ? state.pending : state.enabled;
      return React.createElement('li', { style: CARD_STYLE, 'data-testid': 'dsh-pet-settings-page-pet' },
        React.createElement('div', null,
          React.createElement('strong', { style: { fontSize: 16 } }, '页面桌宠'),
          React.createElement('p', { style: { margin: '5px 0 0', opacity: 0.72 } }, '显示在应用窗口内的桌宠；大小与位置在桌宠上的齿轮面板里调整。'),
        ),
        !state.loaded && !state.err
          ? React.createElement('span', null, '正在读取状态…')
          : React.createElement(Field, { label: '启用页面桌宠', hint: '停用后窗口内不再显示；重启应用后生效。' },
            React.createElement('input', {
              type: 'checkbox', style: TOGGLE_STYLE,
              checked: shown, disabled: state.busy,
              onChange: (e) => toggle(e.target.checked),
            }),
          ),
        React.createElement(Status, { kind: state.err ? 'err' : 'ok', text: state.err || state.notice }),
      );
    }

    // ── 大肥鱼（dsh-dafeiyu） ────────────────────────────────
    function FishCard() {
      const [status, setStatus] = useState('loading');
      const [value, setValue] = useState({});
      const [busy, setBusy] = useState(false);
      const writable = status === 'ready' && !busy;
      useEffect(() => {
        let active = true;
        const loadSettings = () => fetch(FISH_ENDPOINT, { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error('settings request failed: ' + response.status);
            return response.json();
          })
          .then((next) => { if (active) { setValue(next); setStatus('ready'); } })
          .catch(() => { if (active) setStatus('unavailable'); });
        const bridge = window.dshDesktop && window.dshDesktop.pluginManager;
        if (!bridge) {
          loadSettings();
          return () => { active = false; };
        }
        bridge.list()
          .then((result) => {
            if (!active) return;
            const row = pluginRow(pluginRowsFrom(result), 'dsh-dafeiyu');
            if (row && row.enabled === false) {
              setStatus('disabled');
              return;
            }
            loadSettings();
          })
          .catch(loadSettings);
        return () => { active = false; };
      }, []);
      const write = (field, next) => {
        setBusy(true);
        fetch(FISH_ENDPOINT, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: next }),
        })
          .then(async (response) => {
            if (!response.ok) throw new Error('settings write failed: ' + response.status);
            setValue(await response.json());
            setStatus('ready');
          })
          .catch(() => setStatus('unavailable'))
          .finally(() => setBusy(false));
      };
      return React.createElement('li', { style: CARD_STYLE, 'data-testid': 'dsh-pet-settings-fish' },
        React.createElement('div', null,
          React.createElement('strong', { style: { fontSize: 16 } }, '大肥鱼桌面伴侣'),
          React.createElement('p', { style: { margin: '5px 0 0', opacity: 0.72 } }, '始终显示在 Windows 桌面最上层，右键可隐藏、减少动态。'),
        ),
        status === 'unavailable'
          ? React.createElement('span', { role: 'status' }, '大肥鱼设置尚未连接到 DSH Host。')
          : status === 'disabled'
          ? React.createElement('span', { role: 'status' }, '大肥鱼当前未启用。请在“插件 → 管理”启用 dsh-dafeiyu 后重启应用。')
          : status === 'loading'
          ? React.createElement('span', null, '正在读取设置…')
          : React.createElement(React.Fragment, null,
            React.createElement(Field, { label: '启用大肥鱼', hint: '关闭后立即退出；重新开启无需单独启动程序。' },
              React.createElement('input', {
                type: 'checkbox', style: TOGGLE_STYLE,
                checked: value.enabled !== false, disabled: !writable,
                onChange: (e) => write('enabled', e.target.checked),
              }),
            ),
            React.createElement(Field, { label: '角色大小' },
              React.createElement('input', {
                type: 'range', min: 0.7, max: 1.4, step: 0.05,
                value: Number.isFinite(value.scale) ? value.scale : 1,
                disabled: !writable,
                onChange: (e) => write('scale', Number(e.target.value)),
                style: { width: 160, accentColor: 'var(--accent-color, #5e9cff)' },
              }),
            ),
            React.createElement(Field, { label: '空闲微动作频率' },
              React.createElement('select', {
                style: SELECT_STYLE, disabled: !writable,
                value: value.activityLevel || 'normal',
                onChange: (e) => write('activityLevel', e.target.value),
              },
                React.createElement('option', { value: 'quiet' }, '安静'),
                React.createElement('option', { value: 'normal' }, '标准'),
                React.createElement('option', { value: 'lively' }, '活泼'),
              ),
            ),
            React.createElement(Field, { label: '减少动态', hint: '减少走动、循环帧和程序化晃动。' },
              React.createElement('input', {
                type: 'checkbox', style: TOGGLE_STYLE,
                checked: value.reducedMotion === true, disabled: !writable,
                onChange: (e) => write('reducedMotion', e.target.checked),
              }),
            ),
          ),
      );
    }

    function PetSettingsSection() {
      return React.createElement('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 } },
        React.createElement(PagePetCard, null),
        React.createElement(FishCard, null),
      );
    }

    // ── 注册 ─────────────────────────────────────────────────
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'pet-settings',
        order: 8,
        label: () => '桌宠',
      }, PetSettingsSection));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});

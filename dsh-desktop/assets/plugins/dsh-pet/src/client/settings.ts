/**
 * 桌宠配置管理设置页（settings.section 插槽，id: pet-config）
 *
 * - 多开：管理多个桌宠，每个宠物独立 id/size/位置（corner + marginX/Y）
 * - 数据流：设置页持有「合并后的完整宠物列表」→ 保存时全量 PUT /dsh-pet-7340/config
 *   （用户覆盖层 = 完整列表，加载时全量替换默认，天然支持增删）
 * - 即时生效：保存/恢复默认后调用 petBridge.sync 通知容器重新渲染，无需刷新页面
 *
 * 样式对齐官方设置页：max-width 720px、全走 --dsw-alias-* 语义 token（主题跟随）。
 */
import { assertClientConfig, stripJsonc } from './config';
import { NOTIFY_ICONS, reloadNotifications, requestNotificationPermission } from './notify';
import type { Corner, Pet } from './types';
import type { ChangeEvent, CSSProperties, Dispatch, FunctionComponent, SetStateAction, useEffect } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 容器与设置页共享的桥（同一 bundle 单例）：
 * current=最新完整宠物列表（默认空）；sync=容器注册的重渲染回调（未注册时为无操作函数）；
 * template=config.jsonc 默认宠物模板（pets[0]），「添加宠物」用它作为默认配置 */
export const petBridge: {
  current: Pet[];
  sync: (pets: Pet[]) => void;
  template: Pet | undefined;
} = {
  current: [],
  sync: () => {},
  template: undefined,
};

/** 字典命名空间 */
export const NS = 'pet.config';

export const zh = {
  nav: '桌宠配置',
  intro: '管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。',
  petsLabel: '宠物列表',
  add: '添加宠物',
  remove: '删除',
  confirmRemove: '确定删除宠物「{id}」吗？',
  confirmTitle: '确认操作',
  cancel: '取消',
  atLeastOne: '至少保留一个宠物。',
  emptyPets: '暂无宠物，点击「添加宠物」创建。',
  sizeLabel: '大小（宽度 px）',
  sizeHint: '高度自动 = 宽度 × 9/16。',
  balanceEnabled: '余额功能',
  balanceEnabledHint: '启用后该宠物触发余额动画并显示余额气泡。',
  cornerLabel: '位置',
  'corner.top-left': '左上角',
  'corner.top-right': '右上角',
  'corner.bottom-left': '左下角',
  'corner.bottom-right': '右下角',
  marginX: '水平偏移',
  marginY: '垂直偏移',
  save: '保存',
  reset: '恢复默认',
  confirmReset: '确定恢复默认吗？将删除整个用户配置（含自定义的动画池与播放权重）。',
  resetHint: '「重置」会删除整个用户配置（含自定义的动画池与播放权重），不只是宠物列表。',
  configMeta: '高级配置（文件）',
  configMetaHint: '用户配置可覆盖宠物列表 / 动画池 / 播放权重，修改后刷新或重启生效；默认配置为完整参考。',
  defaultConfig: '默认配置（只读，完整参考）',
  userConfig: '用户配置（自定义覆盖）',
  animationDir: '动画素材目录（可自定义/扩充动画）',
  saved: '已保存，桌宠即时生效。',
  loadError: '加载配置失败',
  invalid: '请检查输入：大小需为正数，边距可为任意数字。',
  busy: '保存中…',
  notifyToggle: '系统通知',
  notifyToggleHint: '对话完成 / 生成失败 / 权限申请 / 用户选择，在窗口失焦时弹出系统级通知（桌面右下角）。',
  notifyGetPermission: '获取权限',
  notifyPermissionOk: '已获得通知权限，右下角出现测试通知。',
  notifyDenyUnsupported: '当前环境不支持系统通知（浏览器无 Notification API）。',
  notifyDenyBlocked: '通知权限已被浏览器标记为「阻止」。',
  notifyDenyRejected: '你在权限询问弹窗中选择了「阻止」。',
  notifyDenyError: '申请权限时出错',
  notifyGuide: '引导：点击地址栏左侧 🔒/ⓘ →「网站设置」→「通知」→ 改为「允许」，刷新页面后重试。',
};

export const en = {
  nav: 'Pet Config',
  intro: 'Manage multiple pets: each pet has its own size and position (applies instantly after saving).',
  petsLabel: 'Pets',
  add: 'Add pet',
  remove: 'Remove',
  confirmRemove: 'Delete pet "{id}"?',
  confirmTitle: 'Confirm action',
  cancel: 'Cancel',
  atLeastOne: 'Keep at least one pet.',
  emptyPets: 'No pets yet — click "Add pet" to create one.',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  balanceEnabled: 'Balance',
  balanceEnabledHint: 'When enabled, this pet plays balance animations and shows the balance bubble.',
  cornerLabel: 'Position',
  'corner.top-left': 'Top-left',
  'corner.top-right': 'Top-right',
  'corner.bottom-left': 'Bottom-left',
  'corner.bottom-right': 'Bottom-right',
  marginX: 'Horizontal offset',
  marginY: 'Vertical offset',
  save: 'Save',
  reset: 'Reset to default',
  confirmReset: 'Reset to default? This deletes the whole user config (including custom animation pools & weights).',
  resetHint:
    '"Reset" deletes the whole user config (including custom animation pools & weights), not just the pet list.',
  configMeta: 'Advanced (files)',
  configMetaHint:
    'User config may override pets / animation pools / weights — refresh or restart to apply. The default config is the complete reference.',
  defaultConfig: 'Default config (read-only, complete reference)',
  userConfig: 'User config (custom overrides)',
  animationDir: 'Animation assets dir (add/customize animations here)',
  saved: 'Saved — the pets updated instantly.',
  loadError: 'Failed to load config',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
  notifyToggle: 'System notifications',
  notifyToggleHint:
    'OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.',
  notifyGetPermission: 'Get permission',
  notifyPermissionOk: 'Notification permission granted — a test notification was sent.',
  notifyDenyUnsupported: 'System notifications are not supported in this environment (no Notification API).',
  notifyDenyBlocked: 'Notification permission is blocked by the browser.',
  notifyDenyRejected: 'You chose "Block" in the permission prompt.',
  notifyDenyError: 'Failed to request permission',
  notifyGuide:
    'Guide: click the 🔒/ⓘ icon next to the address bar → Site settings → Notifications → set to "Allow", then refresh and retry.',
};

/**
 * 制造「桌宠配置」设置页组件（工厂函数）。
 *
 * 为什么是工厂而非直接定义组件：client 半侧是 __ModuleLoader__ 单文件形态，
 * react 能力不能顶层 import，只能由 DSH 的 require('react') 在运行时注入，
 * 因此把组件依赖作为参数传入，在工厂内制造出可用的组件后再注册进设置页插槽。
 *
 * @param rt        运行时注入的依赖集合
 * @param rt.h      react/jsx-runtime 的 jsx 函数（即 factory 里的 `h`）——
 *                  用于手写 React 元素，如 `h('button', { onClick, children: '保存' })`
 * @param rt.useState react 的 useState hook——管理页面内可变状态
 *                  （宠物列表 / 选中项 / 忙碌 / 保存消息），值变化时自动重渲染
 * @param rt.t      locale 绑定到本插件的翻译函数（ctx.locale.bind(NS)）——
 *                  取中英文文案，如 `t('nav')` → '桌宠配置' / 'Pet Config'
 * @returns PetConfigSection 组件：即整个「桌宠配置」设置页
 *          （props 仅有 close，由设置页外壳提供，本页当前未使用）
 */
export function makePetConfigSection(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  useEffect: typeof useEffect;
  t: (key: string) => string;
}): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, t } = rt;

  const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const cornerLabel = (c: Corner): string => t('corner.' + c);

  const inputStyle = {
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '5px 10px',
    fontSize: '13px',
    minHeight: '28px',
    outline: 'none',
  } as CSSProperties;

  /** 生成一个未占用的宠物 id（pet-2、pet-3…） */
  const nextId = (list: Pet[]): string => {
    let n = 2;
    for (; ; n++) {
      const id = 'pet-' + n;
      if (!list.some((p) => p.id === id)) return id;
    }
  };

  return function PetConfigSection() {
    const initPets = petBridge.current;
    const [pets, setPets] = useState<Pet[]>(initPets.map((p) => ({ ...p, position: { ...p.position } })));
    const [selId, setSelId] = useState<string>(initPets[0]?.id ?? '');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 确认弹窗（仿官方弹窗：遮罩 + 居中卡片 + 双按钮）
    const [confirm, setConfirm] = useState<null | 'remove' | 'reset'>(null);
    // 配置文件地址（「高级配置」区块；读取失败仅缺省不显示，不影响表单）
    const [paths, setPaths] = useState<null | { user: string; default: string; animations: string }>(null);
    useEffect(() => {
      fetch('/dsh-pet-7340/config/meta')
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => setPaths(p))
        .catch(() => console.warn('[dsh-pet] 读取配置文件路径失败'));
    }, []);

    // 系统通知总开关（全局：读写用户级配置 main-config.json 的 notificationsEnabled；即时生效）
    const [notifyEnabled, setNotifyEnabled] = useState(true);
    // 权限申请按钮的反馈（就地显示在按钮旁，与全局保存反馈分离）
    const [permMsg, setPermMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    useEffect(() => {
      let alive = true;
      fetch('/dsh-pet-7340/config')
        .then((r) => (r.ok && r.status !== 204 ? r.json() : null))
        .then((d) => {
          if (alive && d && typeof d.notificationsEnabled === 'boolean') setNotifyEnabled(d.notificationsEnabled);
        })
        .catch(() => {
          /* 无用户层时保持默认（true） */
        });
      return () => {
        alive = false;
      };
    }, []);

    const toggleNotify = async (v: boolean) => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 开启时先借用户手势申请系统通知权限（无手势的自动申请可能被浏览器静默压制）
        if (v) await requestNotificationPermission();
        // 与保存同构：整包写用户级配置（pets + 开关），避免开关写入被 sanitize 拒绝
        const res = await fetch('/dsh-pet-7340/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pets: pets, notificationsEnabled: v }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        setNotifyEnabled(v);
        petBridge.current = pets;
        petBridge.sync(pets);
        void reloadNotifications(); // 引擎重读开关：即时生效，无需刷新页面
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const grantNotifyPermission = async () => {
      setPermMsg({ kind: '', text: '' });
      const r = await requestNotificationPermission();
      if (!r.ok) {
        // 红字：失败理由 + 引导（unsupported 无引导，改环境才有意义）
        const reason =
          r.reason === 'unsupported'
            ? t('notifyDenyUnsupported')
            : r.reason === 'denied'
              ? t('notifyDenyBlocked')
              : r.reason === 'rejected'
                ? t('notifyDenyRejected')
                : t('notifyDenyError') + (r.message ? '：' + r.message : '');
        setPermMsg({ kind: 'err', text: reason + (r.reason === 'unsupported' ? '' : ' ' + t('notifyGuide')) });
        return;
      }
      try {
        // 成功即发一条测试通知验证链路（绕过聚焦门，直接确认）
        new Notification('测试通知', { body: '【dsh-pet】系统通知已就绪。', icon: NOTIFY_ICONS.test });
      } catch {
        /* 个别环境构造失败：仍按已授权提示 */
      }
      setPermMsg({ kind: 'ok', text: t('notifyPermissionOk') });
    };

    // 当前选中的宠物对象（表单数据源）；selId 由 add/remove/reset 同步维护，列表非空时恒有效
    const cur = pets.find((p) => p.id === selId) ?? null;

    // 更新选中的宠物：size 走顶层；position 子字段整体替换
    const updateSel = (patch: Partial<Omit<Pet, 'position'>> & { position?: Partial<Pet['position']> }) =>
      setPets((list) =>
        list.map((p) => {
          if (p.id !== selId) return p;
          const { position: posPatch, ...rest } = patch;
          return { ...p, ...rest, position: posPatch ? { ...p.position, ...posPatch } : p.position };
        }),
      );

    const validated = (): boolean => {
      for (const p of pets) {
        if (
          !Number.isFinite(p.size) ||
          p.size <= 0 ||
          !Number.isFinite(p.position.marginX) ||
          !Number.isFinite(p.position.marginY)
        ) {
          setMsg({ kind: 'err', text: t('invalid') });
          return false;
        }
      }
      return true;
    };

    const save = async () => {
      const isOk = validated();
      if (!isOk) return;
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 保留用户级配置（main-config.json）里手写的 notificationsEnabled，避免保存时被整体覆盖丢失
        let notificationsEnabled: boolean | undefined;
        try {
          const prev = await fetch('/dsh-pet-7340/config');
          if (prev.ok && prev.status !== 204) {
            const pj = await prev.json().catch(() => null);
            if (pj && typeof pj.notificationsEnabled === 'boolean') notificationsEnabled = pj.notificationsEnabled;
          }
        } catch {
          /* 无用户层时忽略 */
        }
        const body: Record<string, unknown> = { pets: pets };
        if (notificationsEnabled !== undefined) body.notificationsEnabled = notificationsEnabled;
        const res = await fetch('/dsh-pet-7340/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        petBridge.current = pets;
        petBridge.sync(pets);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const reset = () => setConfirm('reset');

    const doReset = async () => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        await fetch('/dsh-pet-7340/config', { method: 'DELETE' });
        const defRes = await fetch('/dsh-pet-7340/config.jsonc');
        const defs = assertClientConfig(JSON.parse(stripJsonc(await defRes.text()))).pets;
        setPets(defs.map((p) => ({ ...p, position: { ...p.position } })));
        setSelId(defs[0]?.id ?? '');
        petBridge.current = defs;
        petBridge.sync(defs);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const addPet = () => {
      const tpl = petBridge.template;
      if (!tpl) return;
      const id = nextId(pets);
      setPets((list) => [
        ...list,
        { id, size: tpl.size, balanceEnabled: tpl.balanceEnabled, position: { ...tpl.position } },
      ]);
      setSelId(id);
    };

    const removeSel = () => {
      if (pets.length <= 1) {
        setMsg({ kind: 'err', text: t('atLeastOne') });
        return;
      }
      setConfirm('remove');
    };

    const doRemove = () => {
      const list = pets.filter((p) => p.id !== selId);
      setPets(list);
      setSelId(list[0].id);
    };

    const field = (key: 'size' | 'marginX' | 'marginY', value: number, setter: (v: number) => void, width: string) =>
      h('input', {
        type: 'number',
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        value: String(value),
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
        style: { width, ...inputStyle },
      });

    return h('section', {
      style: {
        maxWidth: '720px',
        color: 'var(--dsw-alias-label-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      children: [
        h('h2', {
          style: { margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: '24px' },
          children: t('nav'),
        }),
        h('p', {
          style: {
            margin: 0,
            fontSize: '14px',
            color: 'var(--dsw-alias-label-tertiary)',
            lineHeight: '22px',
          },
          children: t('intro'),
        }),

        // 宠物列表 + 添加
        h('div', {
          style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px' },
          children: [
            h('span', {
              style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
              children: t('petsLabel'),
            }),
            ...pets.map((p) =>
              h('button', {
                key: p.id,
                type: 'button',
                onClick: () => setSelId(p.id),
                style: {
                  border:
                    '1px solid ' +
                    (p.id === selId ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
                  background: p.id === selId ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  borderRadius: '8px',
                  padding: '4px 12px',
                  fontSize: '13px',
                  cursor: 'pointer',
                },
                children: p.id + ' (' + p.size + 'px)',
              }),
            ),
            h('button', {
              type: 'button',
              onClick: addPet,
              disabled: busy,
              style: {
                border: '1px dashed var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                borderRadius: '8px',
                padding: '4px 12px',
                fontSize: '13px',
                cursor: 'pointer',
              },
              children: '+ ' + t('add'),
            }),
          ],
        }),

        // 选中宠物表单
        cur
          ? h('div', {
              style: {
                display: 'flex',
                gap: '16px',
                flexWrap: 'wrap',
                marginTop: '8px',
                padding: '12px 14px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '12px',
              },
              children: [
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('sizeLabel'),
                    field('size', cur.size, (v) => updateSel({ size: v }), '150px'),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('sizeHint'),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('cornerLabel'),
                    h('select', {
                      value: cur.position.corner,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                        updateSel({ position: { corner: e.target.value as Corner } }),
                      style: { width: '160px', ...inputStyle },
                      children: CORNERS.map((c) =>
                        h('option', {
                          key: c,
                          value: c,
                          children: cornerLabel(c),
                        }),
                      ),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('marginX'),
                    field('marginX', cur.position.marginX, (v) => updateSel({ position: { marginX: v } }), '120px'),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('marginY'),
                    field('marginY', cur.position.marginY, (v) => updateSel({ position: { marginY: v } }), '120px'),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('balanceEnabled'),
                    h('input', {
                      type: 'checkbox',
                      checked: !!cur.balanceEnabled,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLInputElement>) => updateSel({ balanceEnabled: e.target.checked }),
                      style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
                    }),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('balanceEnabledHint'),
                    }),
                  ],
                }),
                h('button', {
                  type: 'button',
                  onClick: removeSel,
                  disabled: busy,
                  title: t('remove'),
                  style: {
                    alignSelf: 'flex-end',
                    border: '1px solid var(--dsw-alias-state-error-secondary)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-state-error-primary)',
                    borderRadius: '8px',
                    padding: '4px 12px',
                    fontSize: '12px',
                    cursor: 'pointer',
                  },
                  children: t('remove'),
                }),
              ],
            })
          : h('p', {
              style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' },
              children: t('emptyPets'),
            }),

        // 系统通知总开关（全局，写入用户级配置；即时生效，不归属单个宠物）
        h('label', {
          style: {
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            marginTop: '8px',
            fontSize: '13px',
            color: 'var(--dsw-alias-label-primary)',
          },
          children: [
            h('input', {
              type: 'checkbox',
              checked: notifyEnabled,
              disabled: busy,
              onChange: (e: ChangeEvent<HTMLInputElement>) => void toggleNotify(e.target.checked),
              style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
            }),
            h('span', { children: t('notifyToggle') }),
            h('span', {
              style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
              children: t('notifyToggleHint'),
            }),
          ],
        }),

        // 权限获取按钮 + 反馈（独立一行，样式对齐设置页现有按钮）
        h('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' },
          children: [
            h('button', {
              type: 'button',
              onClick: () => void grantNotifyPermission(),
              style: {
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
              },
              children: t('notifyGetPermission'),
            }),
            permMsg.text
              ? h('span', {
                  style: {
                    fontSize: '12px',
                    color:
                      permMsg.kind === 'err'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-state-ok-primary)',
                    lineHeight: '18px',
                  },
                  children: permMsg.text,
                })
              : null,
          ],
        }),

        // 操作区
        h('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' },
          children: [
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: save,
              style: {
                border: '1px solid var(--dsw-alias-button-info-fill)',
                background: 'var(--dsw-alias-button-info-fill)',
                color: '#fff',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
                opacity: busy ? 0.5 : 1,
              },
              children: t('save'),
            }),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: reset,
              style: {
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
                opacity: busy ? 0.5 : 1,
              },
              children: t('reset'),
            }),
            msg.text
              ? h('span', {
                  style: {
                    fontSize: '12px',
                    color:
                      msg.kind === 'err' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-ok-primary)',
                    marginLeft: '4px',
                  },
                  children: msg.text,
                })
              : null,
          ],
        }),

        // 重置的副作用提示（DELETE 会清掉整个用户配置，含高级自定义）
        h('p', {
          style: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '16px' },
          children: t('resetHint'),
        }),

        // 高级配置（文件地址）：供高级用户直接编辑配置文件自定义
        paths
          ? h('div', {
              style: {
                marginTop: '12px',
                padding: '10px 14px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-secondary)',
              },
              children: [
                h('div', {
                  style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
                  children: t('configMeta'),
                }),
                h('div', { style: { fontSize: '12px', lineHeight: '20px' }, children: t('configMetaHint') }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('defaultConfig') + '：' + paths.default,
                }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('userConfig') + '：' + paths.user,
                }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('animationDir') + '：' + paths.animations,
                }),
              ],
            })
          : null,

        // 确认弹窗（仿官方弹窗视觉：遮罩 + 居中卡片 + 双按钮）
        confirm
          ? h('div', {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483647,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
              },
              onClick: () => setConfirm(null),
              children: h('div', {
                style: {
                  width: '340px',
                  maxWidth: 'calc(100vw - 40px)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '12px',
                  padding: '16px 18px',
                  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                },
                onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
                children: [
                  h('div', {
                    style: { fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
                    children: t('confirmTitle'),
                  }),
                  h('div', {
                    style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                    children: confirm === 'remove' ? t('confirmRemove').replace('{id}', selId) : t('confirmReset'),
                  }),
                  h('div', {
                    style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
                    children: [
                      h('button', {
                        type: 'button',
                        onClick: () => setConfirm(null),
                        style: {
                          border: '1px solid var(--dsw-alias-border-l2)',
                          background: 'transparent',
                          color: 'var(--dsw-alias-label-primary)',
                          borderRadius: '8px',
                          padding: '4px 14px',
                          fontSize: '12px',
                          cursor: 'pointer',
                        },
                        children: t('cancel'),
                      }),
                      h('button', {
                        type: 'button',
                        onClick: () => {
                          const k = confirm;
                          setConfirm(null);
                          if (k === 'remove') doRemove();
                          else void doReset();
                        },
                        style:
                          confirm === 'remove'
                            ? {
                                border: '1px solid var(--dsw-alias-state-error-secondary)',
                                background: 'transparent',
                                color: 'var(--dsw-alias-state-error-primary)',
                                borderRadius: '8px',
                                padding: '4px 14px',
                                fontSize: '12px',
                                cursor: 'pointer',
                              }
                            : {
                                border: '1px solid var(--dsw-alias-button-info-fill)',
                                background: 'var(--dsw-alias-button-info-fill)',
                                color: '#fff',
                                borderRadius: '8px',
                                padding: '4px 14px',
                                fontSize: '12px',
                                cursor: 'pointer',
                              },
                        children: confirm === 'remove' ? t('remove') : t('reset'),
                      }),
                    ],
                  }),
                ],
              }),
            })
          : null,
      ],
    });
  };
}

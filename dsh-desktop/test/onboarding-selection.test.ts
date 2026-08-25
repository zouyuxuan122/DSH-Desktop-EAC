import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_PLUGIN_IDS,
  RECOMMENDED_PLUGIN_IDS,
  needsPluginOnboarding,
  pluginCurrentState,
  buildSelectionOps,
  sanitizeSelection,
  buildCatalog,
} from '../scripts/onboarding.js';
import { togglePluginInPatch } from '../scripts/plugin-manager-patch.js';

// 与 main.js COMPANION_PLUGINS 保持一致的样本注册表（id / 默认 disabled 标志）。
const REGISTRY = [
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal' },
  { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin', dir: 'dsh-webui-market' },
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
  { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
  { id: 'plugin-wizard', name: 'dsh-plugin-wizard', dir: 'dsh-plugin-wizard' },
  { id: 'dsh-pet', name: 'dsh-pet', dir: 'dsh-pet' },
  { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu', dir: 'dsh-dafeiyu', disabled: true },
  { id: 'zat-market', name: 'zat-dsh-engine', dir: 'zat-dsh-engine' },
  { id: 'offpeak', name: 'dsh-offpeak', dir: 'dsh-offpeak' },
  { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar' },
];

// ---------------------------------------------------------------------------
// 新老用户判定
// ---------------------------------------------------------------------------

test('needsPluginOnboarding：全新用户 → true', () => {
  assert.equal(
    needsPluginOnboarding({ settings: {}, settingsFileExists: false, profileDirExists: false, sharedProfileExists: false }),
    true
  );
});

test('needsPluginOnboarding：settings.json 已存在（任意老版本用户）→ false', () => {
  assert.equal(
    needsPluginOnboarding({ settings: {}, settingsFileExists: true, profileDirExists: false, sharedProfileExists: false }),
    false
  );
});

test('needsPluginOnboarding：web-desktop 专属 profile 已存在 → false', () => {
  assert.equal(
    needsPluginOnboarding({ settings: {}, settingsFileExists: false, profileDirExists: true, sharedProfileExists: false }),
    false
  );
});

test('needsPluginOnboarding：共享 web profile 存在（3.1.0 前老用户）→ false', () => {
  assert.equal(
    needsPluginOnboarding({ settings: {}, settingsFileExists: false, profileDirExists: false, sharedProfileExists: true }),
    false
  );
});

test('needsPluginOnboarding：已确认过向导 → false（即使环境像全新）', () => {
  assert.equal(
    needsPluginOnboarding({ settings: { pluginOnboardingDone: true }, settingsFileExists: false, profileDirExists: false, sharedProfileExists: false }),
    false
  );
});

// ---------------------------------------------------------------------------
// 当前启停状态（patch + 注册表默认）
// ---------------------------------------------------------------------------

test('pluginCurrentState：patch 条目优先于注册表默认', () => {
  const entries = [
    { insert: [{ id: 'balance', name: '@deepseek-ai/dsh-balance' }, { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu', disabled: true }] },
    { id: 'dsh-pet', name: 'dsh-pet', disabled: true },
    { id: 'offpeak', name: 'dsh-offpeak' }, // 裸顶层条目 = 启用
  ];
  const state = pluginCurrentState(entries, REGISTRY);
  assert.equal(state.balance, true);
  assert.equal(state['dsh-dafeiyu'], false);
  assert.equal(state['dsh-pet'], false);
  assert.equal(state.offpeak, true);
});

test('pluginCurrentState：无 patch 条目时取注册表默认', () => {
  const state = pluginCurrentState([], REGISTRY);
  assert.equal(state.balance, true);
  assert.equal(state['dsh-dafeiyu'], false, '注册表 disabled:true → 默认停用');
  assert.equal(state['zat-market'], true);
});

test('pluginCurrentState：容忍空/畸形条目', () => {
  const state = pluginCurrentState([null, 42, { insert: 'oops' }], REGISTRY);
  assert.equal(state.balance, true);
});

// ---------------------------------------------------------------------------
// 选择清洗
// ---------------------------------------------------------------------------

test('sanitizeSelection：丢弃未知/非字符串 id，核心恒在集合内', () => {
  const want = sanitizeSelection(['balance', 'dsh-pet', 'not-a-plugin', 123, null], REGISTRY, CORE_PLUGIN_IDS);
  assert.ok(want.has('balance'));
  assert.ok(want.has('dsh-pet'));
  assert.ok(!want.has('not-a-plugin'));
  assert.ok(!want.has('123'));
  for (const c of CORE_PLUGIN_IDS) assert.ok(want.has(c), '核心 id 必须存在: ' + c);
});

test('sanitizeSelection：非数组输入退化为仅核心', () => {
  const want = sanitizeSelection(undefined, REGISTRY, CORE_PLUGIN_IDS);
  assert.deepEqual([...want].sort(), [...CORE_PLUGIN_IDS].sort());
});

test('sanitizeSelection：平台 unavailable 插件即使被提交也不会启用', () => {
  const unavailable = new Set(['computer-user', 'dsh-dafeiyu']);
  const registry = [...REGISTRY, { id: 'computer-user', name: 'computer-user' }];
  const want = sanitizeSelection(['computer-user', 'dsh-dafeiyu', 'offpeak'], registry, CORE_PLUGIN_IDS, unavailable);
  assert.equal(want.has('computer-user'), false);
  assert.equal(want.has('dsh-dafeiyu'), false);
  assert.equal(want.has('offpeak'), true);
});

// ---------------------------------------------------------------------------
// 操作清单（首次 normalize / 二次差集）
// ---------------------------------------------------------------------------

test('buildSelectionOps：首次向导（current=null）→ 所有非核心都写显式状态', () => {
  const want = sanitizeSelection([], REGISTRY, CORE_PLUGIN_IDS);
  const ops = buildSelectionOps(REGISTRY, CORE_PLUGIN_IDS, want, null);
  const byId = new Map(ops.map((o) => [o.id, o]));
  for (const p of REGISTRY) {
    if (CORE_PLUGIN_IDS.has(p.id)) {
      assert.ok(!byId.has(p.id), '核心插件不得产生操作: ' + p.id);
    } else {
      assert.ok(byId.has(p.id), '非核心插件必须产生操作: ' + p.id);
      assert.equal(byId.get(p.id).enable, false);
    }
  }
});

test('buildSelectionOps：首次向导选中项 → enable', () => {
  const want = sanitizeSelection(['dsh-pet', 'offpeak'], REGISTRY, CORE_PLUGIN_IDS);
  const ops = buildSelectionOps(REGISTRY, CORE_PLUGIN_IDS, want, null);
  assert.equal(ops.find((o) => o.id === 'dsh-pet').enable, true);
  assert.equal(ops.find((o) => o.id === 'offpeak').enable, true);
  assert.equal(ops.find((o) => o.id === 'zat-market').enable, false);
});

test('buildSelectionOps：二次向导只切换与当前不同的插件', () => {
  const current = {
    balance: true, 'file-changes': true, 'client-file-changes': true, terminal: true,
    'dsh-market-plugin': true, 'plugin-manager': true, 'plugin-shield': true, 'plugin-wizard': true,
    'dsh-pet': false, 'dsh-dafeiyu': false, 'zat-market': true, offpeak: true, 'better-sidebar': true,
  };
  // 用户新勾选 dsh-pet，取消 zat-market / offpeak / better-sidebar
  const want = sanitizeSelection(['dsh-pet'], REGISTRY, CORE_PLUGIN_IDS);
  const ops = buildSelectionOps(REGISTRY, CORE_PLUGIN_IDS, want, current);
  const byId = new Map(ops.map((o) => [o.id, o]));
  assert.equal(ops.length, 4, '应有 4 个变更（pet 启用、zat/offpeak/better-sidebar 停用）');
  assert.deepEqual(byId.get('dsh-pet'), { id: 'dsh-pet', enable: true });
  assert.deepEqual(byId.get('zat-market'), { id: 'zat-market', enable: false });
  assert.deepEqual(byId.get('offpeak'), { id: 'offpeak', enable: false });
  assert.deepEqual(byId.get('better-sidebar'), { id: 'better-sidebar', enable: false });
});

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

test('buildCatalog：核心/推荐/体积/描述标记正确', () => {
  const catalog = buildCatalog(REGISTRY, {
    coreIds: CORE_PLUGIN_IDS,
    recommendedIds: RECOMMENDED_PLUGIN_IDS,
    describe: (name) => 'desc-of-' + name,
    dirSize: (dir) => ({ 'dsh-pet': 15728640, 'dsh-dafeiyu': 60817408 }[dir] || 0),
  });
  const byId = new Map(catalog.map((c) => [c.id, c]));
  assert.equal(byId.get('dsh-market-plugin').core, true);
  assert.equal(byId.get('plugin-wizard').core, true);
  assert.equal(byId.get('better-sidebar').core, false);
  assert.equal(byId.get('better-sidebar').recommended, true);
  assert.equal(byId.get('offpeak').recommended, true);
  assert.equal(byId.get('dsh-pet').recommended, false, '桌宠不进推荐');
  assert.equal(byId.get('dsh-dafeiyu').recommended, false, '注册表默认禁用的不进推荐');
  assert.equal(byId.get('dsh-dafeiyu').registryDisabled, true);
  assert.equal(byId.get('dsh-pet').size, 15728640);
  assert.equal(byId.get('better-sidebar').description, 'desc-of-dsh-better-sidebar');
});

test('buildCatalog：平台能力状态会阻止 unavailable 插件成为推荐项', () => {
  const registry = [...REGISTRY, { id: 'computer-user', name: 'computer-user' }, { id: 'picturereader', name: 'picturereader' }];
  const catalog = buildCatalog(registry, {
    coreIds: CORE_PLUGIN_IDS,
    recommendedIds: new Set(['computer-user', 'picturereader']),
    capabilities: {
      'computer-user': { status: 'unavailable', reason: 'Wayland/X11 无透明 SendInput 等价实现' },
      picturereader: { status: 'external-dependency', reason: 'OCR 需要外部后端' },
    },
  });
  const byId = new Map(catalog.map((item) => [item.id, item]));
  assert.equal(byId.get('computer-user').recommended, false);
  assert.equal(byId.get('computer-user').capability.status, 'unavailable');
  assert.equal(byId.get('picturereader').capability.status, 'external-dependency');
});

// ---------------------------------------------------------------------------
// 端到端：ops → togglePluginInPatch 真实文本手术 → patch 状态一致
// ---------------------------------------------------------------------------

test('首次向导全流程：patch 写入 disabled 行，sync 不重写（已有行优先）', () => {
  // 模拟 syncCompanionPlugins 刚写出的 insert 行（无任何用户层条目）
  let patch = "- insert:\n    - id: balance\n      name: '@deepseek-ai/dsh-balance'\n    - id: dsh-pet\n      name: 'dsh-pet'\n    - id: dsh-dafeiyu\n      name: 'dsh-dafeiyu'\n      disabled: true\n    - id: zat-market\n      name: 'zat-dsh-engine'\n";
  // 用户只勾选 dsh-pet（其余停用）
  const want = sanitizeSelection(['dsh-pet'], REGISTRY, CORE_PLUGIN_IDS);
  const ops = buildSelectionOps(REGISTRY, CORE_PLUGIN_IDS, want, null);
  for (const op of ops) {
    if (op.enable) patch = togglePluginInPatch(patch, op.id, true, op.id);
    else patch = togglePluginInPatch(patch, op.id, false, op.id);
  }
  // 停用项应有顶层 disabled 条目
  assert.ok(/- id: zat-market\n  name: 'zat-market'\n  disabled: true/.test(patch), 'zat-market 应带 disabled');
  // 核心插件不受影响：balance 保持 insert 内层无 disabled
  assert.ok(/- id: balance\n      name: '@deepseek-ai\/dsh-balance'/.test(patch), 'balance 行应保持原样');

  // 模拟下次启动 sync 的「已有行不重写」：新写 insert 行时应跳过已有 id
  const finalState = pluginCurrentState(parsePatchEntries(patch), REGISTRY);
  assert.equal(finalState['zat-market'], false);
  assert.equal(finalState['dsh-pet'], true);
  assert.equal(finalState.balance, true);
});

// 轻量解析 cordis.patch.yml：顶层 `- id:` 条目与 `- insert:` 内层条目，
// 与 pluginManagerReadPatch 的 entries 形态一致（{id, disabled} / {insert:[...]}）。
function parsePatchEntries(text) {
  const entries = [];
  let insert = null;
  for (const raw of text.split('\n')) {
    const indent = /^(\s*)/.exec(raw)[1].length;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '- insert:') { insert = []; continue; }
    const idm = /^- id:\s*([\w.-]+)\s*$/.exec(line);
    if (idm) {
      const entry = { id: idm[1], disabled: false };
      if (indent > 0 && insert) insert.push(entry);
      else {
        if (insert && insert.length) { entries.push({ insert }); }
        insert = null;
        entries.push(entry);
      }
      continue;
    }
    const dm = /^disabled:\s*(true|false)\s*$/.exec(line);
    if (dm) {
      const target = insert && insert.length ? insert : entries;
      if (target.length) target[target.length - 1].disabled = dm[1] === 'true';
      continue;
    }
  }
  if (insert && insert.length) entries.push({ insert });
  return entries;
}

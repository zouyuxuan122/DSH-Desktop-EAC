// 内置插件 client 契约回归测试（2026-08-25 修复）：
//   1) rc.2 内核 dsh-client-ui-renderer 的 client 包只导出 apply/inject，
//      不导出 useSyncExternalStoreWithSelector —— 6 个插件改为内联
//      use-sync-external-store 1.2.0 with-selector shim（本文件对拍官方算法）；
//   2) rc.2 设置作用域（SettingsScopeController）无 load() —— 3 个插件移除
//      裸调，禁止再出现未守卫的 scope.load(。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PLUGINS = join(ROOT, 'assets', 'plugins');

const USES_PLUGINS = [
  'dsh-compact/lib/client.js',
  'dsh-conversation-tweaks/lib/client.js',
  'dsh-openclaw-bridge/lib/client.js',
  'dsh-prompt-custom/lib/client.js',
  'dsh-session-manager/lib/client.js',
];
const SCOPE_LOAD_PLUGINS = [
  'picturereader/client.js',
  'computer-user/client.js',
  'dsh-soul-md/client.js',
];

test('5 个 uSES 插件：不再 require ui-renderer，且内联 shim 存在、文件可解析', () => {
  for (const rel of USES_PLUGINS) {
    const src = readFileSync(join(PLUGINS, rel), 'utf8');
    assert.doesNotMatch(src, /require\(["']@deepseek-ai\/dsh-client-ui-renderer["']\)/,
      `${rel} 仍 require ui-renderer`);
    assert.match(src, /function useSyncExternalStoreWithSelector\(/,
      `${rel} 缺少内联 shim`);
    assert.match(src, /const objectIs = \(a, b\) => \(a === b && \(a !== 0 \|\| 1 \/ a === 1 \/ b\)\)/,
      `${rel} 缺少 Object.is 兜底`);
    assert.doesNotThrow(() => new Function(src), `${rel} 语法解析失败`);
  }
});

test('3 个 scope.load 插件：scope.load 调用必须是守卫式（rc.2 宿主无 load）', () => {
  // rc.2 设置作用域（SettingsScopeController）无 load()，裸调 scope.load() 会
  // 在无 load 宿主上崩溃；守卫式（typeof scope.load === "function" 或
  // scope.load && …）与 dsh-easy-setup 同款，允许保留。注释里的提及不算调用。
  for (const rel of SCOPE_LOAD_PLUGINS) {
    const src = readFileSync(join(PLUGINS, rel), 'utf8');
    for (const m of src.matchAll(/scope\.load\s*\(/g)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lineHead = src.slice(lineStart, m.index).trimStart();
      if (lineHead.startsWith('//') || lineHead.startsWith('*') || lineHead.startsWith('/*')) continue;
      const pre = src.slice(Math.max(0, m.index - 120), m.index);
      const guarded =
        /typeof\s+scope\.load\s*===/.test(pre) ||
        /scope\.load\s*&&/.test(pre);
      assert.ok(guarded, `${rel} 存在未守卫的 scope.load() 调用（字符 ${m.index}）：rc.2 宿主无 load()，必须 typeof 守卫或短路守卫`);
    }
    assert.doesNotThrow(() => new Function(src), `${rel} 语法解析失败`);
  }
});

test('dsh-easy-setup 仅剩守卫式 scope.load（无崩溃风险）', () => {
  const src = readFileSync(join(PLUGINS, 'dsh-easy-setup/lib/client.js'), 'utf8');
  const calls = [...src.matchAll(/scope\.load\(\)/g)];
  assert.ok(calls.length >= 1, 'dsh-easy-setup 应仍有守卫式调用');
  for (const m of calls) {
    const pre = src.slice(Math.max(0, m.index - 40), m.index);
    assert.match(pre, /scope\.load\s*&&\s*$/, 'scope.load 调用必须是守卫式（scope.load && scope.load()）');
  }
});

// ---------------------------------------------------------------------------
// shim 语义对拍：mock React hooks 环境下，内联实现 vs 官方 1.2.0 算法
// ---------------------------------------------------------------------------

/** 极简 React hooks 运行时：跨 render 保留 ref/memo，effect 在 render 后同步跑。 */
function createHarness() {
  const refs = new Map<number, { current: any }>();
  const memos = new Map<number, { deps: any[]; value: any }>();
  let effects: { fn: () => void; deps: any[] | null; last: any[] | null }[] = [];
  let ordinal = 0;
  const hooks = {
    useRef(initial: any) {
      const id = ordinal++;
      if (!refs.has(id)) refs.set(id, { current: initial });
      return refs.get(id)!;
    },
    useMemo(factory: () => any, deps: any[]) {
      const id = ordinal++;
      const prev = memos.get(id);
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => Object.is(d, deps[i]))) return prev.value;
      const value = factory();
      memos.set(id, { deps: deps.slice(), value });
      return value;
    },
    useEffect(fn: () => void, deps: any[]) {
      const id = ordinal++;
      if (effects[id]) { effects[id].fn = fn; effects[id].deps = deps; }
      else effects[id] = { fn, deps, last: null };
    },
    useDebugValue() {},
    useSyncExternalStore(_sub: any, getSel: () => any, getServer: any) { return getServer === undefined ? getSel() : getSel(); },
  };
  const resetOrdinal = () => { ordinal = 0; };
  const runEffects = () => {
    for (const ef of effects) {
      if (!ef) continue;
      const changed = ef.last === null || !ef.deps!.every((d, i) => Object.is(d, ef.last![i]));
      if (changed) {
        ef.fn();
        ef.last = ef.deps!.slice();
      }
    }
  };
  return { hooks, resetOrdinal, runEffects };
}

/** 从插件文件里原样提取内联 shim（react 解构行 … 到 bindSnapshotSelector 之前）。 */
function extractShim(rel: string) {
  const src = readFileSync(join(PLUGINS, rel), 'utf8');
  const start = src.indexOf('const { useSyncExternalStore, useRef');
  const end = src.indexOf('const bindSnapshotSelector');
  assert.ok(start !== -1 && end !== -1 && end > start, `${rel} 提取 shim 失败`);
  const block = src.slice(start, end);
  return new Function('react', `${block}\nreturn { useSyncExternalStoreWithSelector };`);
}

/** 官方 use-sync-external-store 1.2.0 shim/with-selector（生产版，逐字转写）。 */
function referenceShim(hooks: any) {
  const t = hooks.useRef, u = hooks.useEffect, v = hooks.useMemo, w = hooks.useDebugValue;
  function p(a: any, b: any) { return a === b && (0 !== a || 1 / a === 1 / b) || a !== a && b !== b; }
  const q = typeof Object.is === 'function' ? Object.is : p;
  const r = hooks.useSyncExternalStore;
  return function useSyncExternalStoreWithSelector(a: any, b: any, e: any, l: any, g: any) {
    const c = t(null);
    let f: any;
    if (null === c.current) { f = { hasValue: false, value: null }; c.current = f; } else { f = c.current; }
    const memoPair = v(function () {
      let hasMemo = false, memoizedSnapshot: any, memoizedSelection: any;
      const memoizedSelector = (next: any) => {
        if (!hasMemo) {
          hasMemo = true;
          memoizedSnapshot = next;
          next = l(next);
          if (void 0 !== g && f.hasValue) {
            const current = f.value;
            if (g(current, next)) return memoizedSelection = current;
          }
          return memoizedSelection = next;
        }
        const prevSelection = memoizedSelection;
        if (q(memoizedSnapshot, next)) return prevSelection;
        const nextSelection = l(next);
        if (void 0 !== g && g(prevSelection, nextSelection)) return prevSelection;
        memoizedSnapshot = next;
        return memoizedSelection = nextSelection;
      };
      const server = void 0 === e ? null : e;
      return [function () { return memoizedSelector(b()); }, null === server ? void 0 : function () { return memoizedSelector(server()); }];
    }, [b, e, l, g]);
    const value = r(a, memoPair[0], memoPair[1]);
    u(function () { f.hasValue = true; f.value = value; }, [value]);
    w(value);
    return value;
  };
}

function runScenario(useSyncExternalStoreWithSelector: any, scenario: any) {
  const harness = createHarness();
  const store = { snap: scenario.initial, listeners: new Set<() => void>() };
  const subscribe = (fn: () => void) => { store.listeners.add(fn); return () => store.listeners.delete(fn); };
  const getSnapshot = () => store.snap;
  const out: any[] = [];
  for (const step of scenario.steps) {
    harness.resetOrdinal();
    store.snap = step.__set;
    const value = useSyncExternalStoreWithSelector(subscribe, getSnapshot, scenario.server, scenario.selector, scenario.isEqual);
    harness.runEffects();
    out.push(value);
  }
  return out;
}

/** 对象选择：输出“相对上一步是否保持同一引用”的模式；原始值：直接比对。 */
function assertSameBehavior(name: string, mine: any[], ref: any[]) {
  assert.equal(mine.length, ref.length, `${name}: 输出长度不一致`);
  for (let i = 0; i < mine.length; i++) {
    const m = mine[i], r = ref[i];
    if (typeof m === 'object' && m !== null) {
      const mStable = i > 0 && Object.is(m, mine[i - 1]);
      const rStable = i > 0 && Object.is(r, ref[i - 1]);
      assert.equal(mStable, rStable, `${name} step${i}: 选择引用稳定性不一致`);
      if (mStable) assert.ok(Object.is(m, mine[i - 1]), `${name} step${i}: 实现自身引用不稳定`);
    } else {
      assert.ok(Object.is(m, r), `${name} step${i}: 值不一致 ${String(m)} vs ${String(r)}`);
    }
  }
}

test('内联 shim 与官方 with-selector 算法行为一致（含 isEqual/NaN/-0/server snapshot）', () => {
  const mineFactory = extractShim('dsh-conversation-tweaks/lib/client.js');
  const mineHarness = createHarness();
  const mine = mineFactory(mineHarness.hooks).useSyncExternalStoreWithSelector;
  const reference = referenceShim(createHarness().hooks);

  const scenarios = [
    {
      name: '原始标量 + 恒等选择器',
      initial: 0,
      steps: [{ __set: 1 }, { __set: 2 }, { __set: 2 }, { __set: 3 }],
      selector: (s: any) => s,
      isEqual: undefined,
      server: undefined,
    },
    {
      name: '对象快照 + shallow isEqual（无关字段变化保持选择引用稳定）',
      initial: { count: 1, other: 'a' },
      steps: [
        { __set: { count: 1, other: 'b' } },
        { __set: { count: 2, other: 'b' } },
        { __set: { count: 2, other: 'c' } },
      ],
      selector: (s: any) => ({ count: s.count }),
      isEqual: (a: any, b: any) => a.count === b.count,
      server: undefined,
    },
    {
      name: 'isEqual 命中历史选择时保持引用',
      initial: { count: 1, other: 'a' },
      steps: [{ __set: { count: 1, other: 'x' } }, { __set: { count: 1, other: 'y' } }],
      selector: (s: any) => ({ count: s.count }),
      isEqual: (a: any, b: any) => a.count === b.count,
      server: undefined,
    },
    {
      name: 'NaN 选择值在快照不变时保持稳定',
      initial: NaN,
      steps: [{ __set: NaN }, { __set: 1 }],
      selector: (s: any) => s,
      isEqual: undefined,
      server: undefined,
    },
    {
      name: 'Object.is 区分 -0 与 +0',
      initial: -0,
      steps: [{ __set: 0 }, { __set: 0 }],
      selector: (s: any) => s,
      isEqual: undefined,
      server: undefined,
    },
    {
      name: '提供 getServerSnapshot 时行为一致',
      initial: 10,
      steps: [{ __set: 11 }, { __set: 11 }],
      selector: (s: any) => s * 2,
      isEqual: undefined,
      server: () => 99,
    },
    {
      name: 'isEqual 恒 false 时每步都是新选择',
      initial: { count: 1 },
      steps: [{ __set: { count: 1 } }, { __set: { count: 1 } }],
      selector: (s: any) => ({ count: s.count, tag: Math.random() }),
      isEqual: () => false,
      server: undefined,
    },
  ];

  for (const sc of scenarios) {
    assertSameBehavior(sc.name, runScenario(mine, sc), runScenario(reference, sc));
  }
});

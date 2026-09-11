import test from 'node:test';
import assert from 'node:assert/strict';
import { apply as applyPlugin } from '../assets/plugins/dsh-file-changes/lib/index.js';

test('dsh-file-changes 使用客户端可见的投影契约并保留 diffs 折叠', () => {
  let definition: any;
  const disposers: Array<() => void> = [];
  const ctx = {
    sessionProjections: {
      register(value: any) {
        definition = value;
        const dispose = () => {};
        disposers.push(dispose);
        return dispose;
      },
    },
    webServer: {
      register() {
        const dispose = () => {};
        disposers.push(dispose);
        return dispose;
      },
    },
  };

  const disposePlugin = applyPlugin(ctx as any);
  try {
    assert.ok(definition, '插件必须注册 fileChanges 投影');
    assert.equal(definition.key, 'fileChanges');
    assert.ok(definition.stateSchema, '投影必须声明 stateSchema');
    assert.ok(definition.wire, '投影必须声明 wire');
    assert.equal(definition.wire.viewSchema, definition.stateSchema);
    assert.equal(typeof definition.wire.view, 'function');
    assert.equal('schema' in definition, false, '不得继续使用旧的顶层 schema');
    assert.equal('view' in definition, false, '不得继续使用旧的顶层 view');

    const state = definition.apply(
      definition.init(),
      {
        type: 'tool/result',
        seq: 7,
        time: 1234,
        data: {
          meta: {
            diffs: [
              { path: 'src/example.ts', oldText: 'old', newText: 'new' },
            ],
          },
        },
      },
    );

    assert.deepEqual(state.changes, [{
      seq: 7,
      time: 1234,
      path: 'src/example.ts',
      op: 'edit',
      oldText: 'old',
      newText: 'new',
    }]);
    assert.deepEqual(
      definition.wire.viewSchema.parse(definition.wire.view(state)),
      state,
    );
  } finally {
    disposePlugin();
    for (const dispose of disposers) dispose();
  }
});

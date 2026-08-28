import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stageRoot = join(root, '..', 'tauri-shell');

// 防呆（v3.0.0 事故的 Tauri 版）：sidecar 顶层 require/mount 的本地模块若未
// 列进 stage-resources 的装配清单，打包产物启动即抛 "Cannot find module"
// 并闪退。本测试静态比对两边（原 bundled-files 契约针对 main.js +
// electron-builder.yml，两者已随 Electron 壳退役，接管为 sidecar ↔ 装配清单）。

function stageLists() {
  const src = fs.readFileSync(join(stageRoot, 'stage-resources.mjs'), 'utf8');
  const out = {};
  for (const name of ['ROOT_FILES', 'LIB_DESKTOP', 'LIB_VNEXT', 'SCRIPTS']) {
    const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`));
    assert.ok(m, `${name} 清单解析失败`);
    out[name] = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
}

function sidecarLocalRefs() {
  const src = [
    fs.readFileSync(join(stageRoot, 'sidecar', 'server.ts'), 'utf8'),
    fs.readFileSync(join(stageRoot, 'sidecar', 'rescue-integration.ts'), 'utf8'),
  ].join('\n');
  const refs = [];
  // mount('<name>') → lib/desktop/<name>.js
  for (const m of src.matchAll(/mount<[^>]*>\(['"]([\w-]+)['"]\)|mount\(['"]([\w-]+)['"]\)/g)) {
    refs.push('desktop/' + (m[1] || m[2]) + '.js');
  }
  // require(path.join(DSH_DESKTOP_ROOT, '<file>.js')) → 根模块
  for (const m of src.matchAll(/require\(path\.join\(DSH_DESKTOP_ROOT,\s*'([\w.-]+\.js)'\)\)/g)) {
    refs.push(m[1]);
  }
  // require(path.join(DSH_DESKTOP_ROOT, 'lib', ['desktop',|<dir>]?, '<file>.js'))
  for (const m of src.matchAll(/require\(path\.join\(DSH_DESKTOP_ROOT,\s*'lib',\s*(?:'([\w-]+)',\s*)?'([\w-]+\.js)'\)\)/g)) {
    refs.push((m[1] ? m[1] + '/' : '') + m[2]);
  }
  return [...new Set(refs)];
}

test('sidecar 引用/挂载的每个本地模块都在 stage-resources 装配清单中', () => {
  const lists = stageLists();
  const inList = (ref) => lists.ROOT_FILES.includes(ref)
    || lists.LIB_DESKTOP.includes(ref.replace(/^desktop\//, ''))
    || lists.LIB_VNEXT.includes(ref)
    || lists.SCRIPTS.includes(ref.replace(/^desktop\//, ''));
  const missing = sidecarLocalRefs().filter((r) => !inList(r));
  assert.deepEqual(missing, [],
    '以下模块被 sidecar 引用但未装配，会导致启动即闪退: ' + missing.join(', '));
});

test('装配清单不再携带 Electron 冻结壳独享模块', () => {
  const lists = stageLists();
  for (const dead of ['error-detail.js', 'koffi-preflight.js', 'renderer-recovery.js',
    'watchdog.js', 'session-encoding-heal.js']) {
    assert.ok(!lists.ROOT_FILES.includes(dead), `${dead} 仍待在 ROOT_FILES（已随 Electron 壳退役）`);
  }
  assert.ok(!lists.SCRIPTS.includes('koffi-preflight.cjs'), 'koffi-preflight.cjs 仍待在 SCRIPTS');
  assert.ok(!lists.SCRIPTS.includes('make-release-hashes.js'), 'make-release-hashes.js 仍待在 SCRIPTS');
});

test('Tauri 资源装配不再携带 WSL 后端', () => {
  const stageScript = fs.readFileSync(join(stageRoot, 'stage-resources.mjs'), 'utf8');
  assert.doesNotMatch(stageScript, /wsl-backend/i);
  assert.ok(!fs.existsSync(join(root, 'wsl-backend.ts')));
});
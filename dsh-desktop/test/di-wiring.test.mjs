import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DI 接线契约测试：每个抽取模块工厂从 deps/ctx 解构出的「无默认值」依赖，
// 必须在 main.js 对应接线块里被提供。漏依赖（pluginUpdater/showBox 那类
// 事故）会在模块加载/首次调用时以 undefined 崩溃，本测试从源码层面拦截。
//
// 工厂模块：createProcessTree / createRuntimePatches / createCompanionSync /
// createPluginManager / createProfileGuard / createShortcutManager /
// createClientUpdateFlow / createWebServiceSupervisor / createShutdownCoordinator；
// registerIpc 的稳定引用从 ctx 解构，单独对 main.js 的 ctx: { } 块校验。

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

/** 按顶层逗号切分（忽略括号/方括号/花括号内的逗号）。 */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** 提取工厂的 deps 解构块（去掉 JSDoc 与行注释）。 */
function destructureBlock(src, factoryName) {
  if (factoryName === 'registerIpc') {
    // registerIpc({ ipcMain, ctx, log }) 内的稳定引用从 ctx 解构
    const m = src.match(/function registerIpc\([^)]*\) \{[^]*?const \{([\s\S]*?)\} = ctx;/);
    return m ? m[1] : null;
  }
  const m = src.match(new RegExp('function ' + factoryName + '\\(deps[^)]*\\) \\{[^]*?const \\{([\\s\\S]*?)\\} = deps;'));
  return m ? m[1] : null;
}

/** 解析解构块 → { required: string[], optional: string[] }（有默认值的算 optional）。 */
function parseDeps(block) {
  const clean = block.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const required = [];
  const optional = [];
  for (const entry of splitTopLevel(clean)) {
    const name = entry.trim().split(/[=:]/)[0].trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    if (new RegExp('\\b' + name + '\\s*=').test(entry)) optional.push(name);
    else required.push(name);
  }
  return { required, optional };
}

/** 提取 main.js 中 factoryName({ ... }) 的对象字面量文本。 */
function wiringObject(factoryName) {
  const start = mainSrc.indexOf(factoryName + '({');
  if (start === -1) return null;
  let depth = 0;
  let i = start + factoryName.length + 1; // 定位到 '{'
  for (; i < mainSrc.length; i++) {
    const c = mainSrc[i];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) break; }
  }
  return mainSrc.slice(start + factoryName.length + 1, i);
}

/** registerIpc 的 ctx 对象块。 */
function ctxObject() {
  const start = mainSrc.indexOf('ctx: {');
  if (start === -1) return null;
  let depth = 0;
  let i = start + 5;
  for (; i < mainSrc.length; i++) {
    const c = mainSrc[i];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) break; }
  }
  return mainSrc.slice(start + 5, i);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FACTORY_MODULES = [
  ['platform/process-tree.js', 'createProcessTree'],
  ['profile/runtime-patches.js', 'createRuntimePatches'],
  ['profile/companion-sync.js', 'createCompanionSync'],
  ['profile/plugin-manager.js', 'createPluginManager'],
  ['profile/profile-guard.js', 'createProfileGuard'],
  ['platform/shortcuts.js', 'createShortcutManager'],
  ['client-update-flow.js', 'createClientUpdateFlow'],
  ['web-service-supervisor.js', 'createWebServiceSupervisor'],
  ['shutdown-coordinator.js', 'createShutdownCoordinator'],
];

test('工厂模块解构的每个必需依赖都在 main.js 接线块中提供', () => {
  let checked = 0;
  for (const [modulePath, factoryName] of FACTORY_MODULES) {
    const src = fs.readFileSync(path.join(root, modulePath), 'utf8');
    const block = destructureBlock(src, factoryName);
    assert.ok(block, `${factoryName} 未找到 deps 解构`);
    const { required } = parseDeps(block);
    // process-tree 的 deps 全部带默认值（设计如此），required 可为空
    assert.ok(required.length > 0 || block.trim().length > 0, `${factoryName} 应解构出依赖`);
    const wiring = wiringObject(factoryName);
    assert.ok(wiring, `${factoryName} 的接线块未找到`);
    const missing = required.filter((name) => !new RegExp('\\b' + escapeRe(name) + '\\b').test(wiring));
    assert.deepEqual(missing, [],
      `${factoryName} 的依赖 ${missing.join(', ')} 未在 main.js 接线中提供`);
    checked += 1;
  }
  assert.equal(checked, FACTORY_MODULES.length);
});

test('registerIpc 从 ctx 解构的稳定引用都在 main.js 的 ctx 对象中', () => {
  const src = fs.readFileSync(path.join(root, 'ipc', 'register-ipc.js'), 'utf8');
  const block = destructureBlock(src, 'registerIpc');
  assert.ok(block, 'registerIpc 未找到 ctx 解构');
  const { required } = parseDeps(block);
  assert.ok(required.length > 0, 'registerIpc 应解构出稳定引用');
  const ctx = ctxObject();
  assert.ok(ctx, 'main.js 未找到 ctx 对象');
  const missing = required.filter((name) => !new RegExp('\\b' + escapeRe(name) + '\\b').test(ctx));
  assert.deepEqual(missing, [], 'ctx 缺失稳定引用: ' + missing.join(', '));
});

test('所有工厂模块文件都在 electron-builder files 清单中（防漏打包）', () => {
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  for (const [modulePath] of FACTORY_MODULES) {
    assert.ok(yml.includes(modulePath), modulePath + ' 未列入 electron-builder files');
  }
  assert.ok(yml.includes('ipc/register-ipc.js'));
});

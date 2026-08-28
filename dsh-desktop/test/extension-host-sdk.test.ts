// VNext Phase 2 回归（Task 11.5）：SDK V1 能力面 + Core Bridge 全链路 ——
// 工具元数据/参数校验/设置命名空间/事件广播/上下文收集（超时丢弃）/
// 桥接端点鉴权与转发/示例插件端到端/桥接 cordis 组件（mock ctx）经真实
// HTTP 回环完成工具桥接与上下文注入。钉住架构文档 §5（SDK 与 Core Bridge）
// 与 spec E（SDK V1 + deny-by-default）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateMod = require(join(root, 'lib', 'state.js'));
const registry = require(join(root, 'lib', 'supervisor', 'registry.js'));
const installer = require(join(root, 'lib', 'supervisor', 'installer.js'));
const { startExtensionBridgeServer } = require(join(root, 'lib', 'extension-host', 'bridge-server.js'));
const { ExtensionHostManager } = require(join(root, 'lib', 'extension-host', 'manager.js'));

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'sdktest-'));
  stateMod.state.dshHome = home;
  return home;
}

async function until(fn, timeoutMs = 15_000, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function fastManager(extra = {}) {
  return new ExtensionHostManager({
    nodeExe: process.execPath,
    hostBootstrapPath: join(root, 'host-bootstrap.js'),
    heartbeatIntervalMs: 150,
    heartbeatTimeoutMs: 400,
    initTimeoutMs: 8_000,
    restartDelayOverrideMs: 250,
    ...extra,
  });
}

/**
 * 桥接端点 POST（node:http 直连：Node ≥ 24 的 global fetch 默认走环境代理，
 * 用户代理（0.0.0.0:xxxx）会把回环请求劫持成 EADDRNOTAVAIL —— 与桥接组件
 * 的生产实现同策略，见 dsh-eac-core-bridge/index.js）。
 */
function bridgePost(bridge, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(bridge.url + pathname);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-eac-token': token } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body ?? {}));
  });
}

/** 桥接 cordis 组件导入（cache-busting：模块加载期读环境变量，逐测试新实例）。 */
function bridgePluginUrl(caseTag) {
  return new URL('file:///' + join(root, 'assets', 'plugins', 'dsh-eac-core-bridge', 'index.js').replace(/\\/g, '/') + '?case=' + caseTag);
}

function installSample() {
  const r = installer.installSdkPlugin('sample-sdk-plugin', {
    srcDir: join(root, 'assets', 'sdk-plugins', 'sample-sdk-plugin'),
  });
  assert.equal(r.ok, true, '示例插件安装必须成功: ' + (r.error ?? ''));
}

// ---------------------------------------------------------------------------

test('SDK：示例插件端到端 —— 工具元数据/参数校验/设置持久化', async () => {
  const home = freshHome();
  const mgr = fastManager();
  try {
    installSample();
    assert.equal(await mgr.startPlugin('sample-sdk-plugin'), true);
    // 工具元数据上报（Core Bridge /tools 的数据源）。
    const metas = mgr.toolMetas('sample-sdk-plugin');
    assert.deepEqual(
      metas.map((t) => t.name).sort(),
      ['echo', 'status'],
    );
    const echo = metas.find((t) => t.name === 'echo');
    assert.ok(echo.description.includes('回显'), '工具描述须上报');
    assert.equal(echo.parameters.msg.required, true, '参数描述符须上报');

    // 参数校验：缺 msg 必填 → 拒绝。
    await assert.rejects(mgr.invoke('sample-sdk-plugin', 'echo', {}), /msg 必填/);
    // 正常调用 + 设置持久化（calls 计数跨调用增长）。
    const r1 = await mgr.invoke('sample-sdk-plugin', 'echo', { msg: '你好' });
    assert.deepEqual(r1, { echo: '你好', calls: 1 });
    const r2 = await mgr.invoke('sample-sdk-plugin', 'echo', { msg: '再次' });
    assert.equal(r2.calls, 2, 'settings.set 跨调用持久化');
    // 无参工具。
    const st = await mgr.invoke('sample-sdk-plugin', 'status');
    assert.equal(typeof st.hostPid, 'number');
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('SDK：上下文贡献 + 超时丢弃（provider 卡死不阻塞回合）', async () => {
  const home = freshHome();
  const src = join(home, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'ctxplug', version: '1.0.0', main: 'index.js' }));
  writeFileSync(
    join(src, 'index.js'),
    [
      'module.exports.activate = function (ctx) {',
      "  ctx.provideContext(() => 'fast-contribution');",
      "  ctx.provideContext(() => new Promise(() => {})); // 永不返回 → 必须被丢弃",
      '};',
    ].join('\n'),
  );
  assert.equal(installer.installSdkPlugin('ctxplug', { srcDir: src, userConsented: true }).ok, true);
  const mgr = fastManager();
  try {
    assert.equal(await mgr.startPlugin('ctxplug'), true);
    const t0 = Date.now();
    const contributions = await mgr.collectContexts('sess-1', 600);
    const elapsed = Date.now() - t0;
    // 慢 provider（host 侧 500ms 上限 + 传输 600ms）被丢弃，只剩快贡献；
    // 总耗时必须有界（绝不因单个插件卡死拖住回合）。
    assert.ok(elapsed < 3_000, `上下文收集必须限时完成（实际 ${elapsed}ms）`);
    assert.equal(contributions.length, 1);
    assert.match(contributions[0].text, /fast-contribution/);
    assert.equal(contributions[0].order, 500, '贡献 order 档位固定');
    assert.match(contributions[0].name, /^eac:ctxplug:0$/);
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('SDK：事件广播（turn-end → ctx.on 分发 → 插件侧可见）', async () => {
  const home = freshHome();
  const src = join(home, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'evtplug', version: '1.0.0', main: 'index.js' }));
  writeFileSync(
    join(src, 'index.js'),
    [
      'module.exports.activate = function (ctx) {',
      "  ctx.on('turn-end', (info) => ctx.settings.set('lastTurn', info && info.n));",
      "  ctx.registerTool('last-turn', () => ctx.settings.get('lastTurn', -1));",
      '};',
    ].join('\n'),
  );
  assert.equal(installer.installSdkPlugin('evtplug', { srcDir: src, userConsented: true }).ok, true);
  const mgr = fastManager();
  try {
    assert.equal(await mgr.startPlugin('evtplug'), true);
    assert.equal(await mgr.invoke('evtplug', 'last-turn'), -1, '广播前无记录');
    mgr.broadcastEvent('turn-end', { n: 7 });
    await until(async () => (await mgr.invoke('evtplug', 'last-turn')) === 7, 5_000, 50);
  } finally {
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Core Bridge 端点：token 鉴权 + /tools + /invoke + /context 全链路', async () => {
  const home = freshHome();
  installSample();
  const mgr = fastManager();
  const bridge = await startExtensionBridgeServer(mgr);
  try {
    assert.equal(await mgr.startPlugin('sample-sdk-plugin'), true);

    // 鉴权：无 token / 错 token → 401。
    const noTok = await bridgePost(bridge, '/tools', {}, undefined);
    assert.equal(noTok.status, 401);
    const badTok = await bridgePost(bridge, '/tools', {}, 'wrong-token');
    assert.equal(badTok.status, 401);

    // /tools：元数据下发。
    const tools = await bridgePost(bridge, '/tools', {}, bridge.token);
    assert.equal(tools.status, 200);
    const echo = tools.data.tools.find((t) => t.name === 'echo');
    assert.ok(echo && echo.pluginId === 'sample-sdk-plugin');

    // /invoke：转发调用 + 结果回传；未知工具 → ok:false（错误文本可见）。
    const inv = await bridgePost(bridge, '/invoke', { pluginId: 'sample-sdk-plugin', tool: 'echo', args: { msg: '桥接' } }, bridge.token);
    assert.equal(inv.data.ok, true);
    assert.equal(inv.data.result.echo, '桥接');
    const bad = await bridgePost(bridge, '/invoke', { pluginId: 'sample-sdk-plugin', tool: 'nope' }, bridge.token);
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.error, /unknown tool/);

    // /context：示例插件贡献一行标记。
    const ctx = await bridgePost(bridge, '/context', { sessionId: 's1' }, bridge.token);
    assert.equal(ctx.data.ok, true);
    assert.ok(ctx.data.contributions.length >= 1);
    assert.match(ctx.data.contributions[0].text, /sample-sdk-plugin/);
  } finally {
    bridge.close();
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Core Bridge cordis 组件：mock ctx 经真实 HTTP 桥接工具与上下文', async () => {
  const home = freshHome();
  installSample();
  const mgr = fastManager();
  const bridge = await startExtensionBridgeServer(mgr);
  // cordis 组件读取的环境。
  process.env.DSH_EAC_BRIDGE_URL = bridge.url;
  process.env.DSH_EAC_BRIDGE_TOKEN = bridge.token;
  try {
    assert.equal(await mgr.startPlugin('sample-sdk-plugin'), true);

    // mock cordis ctx：捕获 tools.register 与 session/created 挂载。
    const registeredTools = new Map();
    const sessionHandlers = [];
    const mockCtx = {
      logger: { info() {}, warn() {} },
      tools: {
        register(tool) {
          registeredTools.set(tool.name, tool);
        },
      },
      on(event, cb) {
        if (event === 'session/created') sessionHandlers.push(cb);
      },
      get() {
        return {
          get() {
            return { ctx: { on(_ev, assembleCb) { mockCtx._assemble = assembleCb; } } };
          },
        };
      },
      _assemble: null,
    };

    const bridgePlugin = await import(bridgePluginUrl('with-endpoint'));
    await bridgePlugin.apply(mockCtx);

    // 工具桥接：eac_sample-sdk-plugin_echo 已注册。
    const tool = registeredTools.get('eac_sample_sdk_plugin_echo');
    assert.ok(tool, '桥接工具必须以 eac_<pluginId>_<tool> 注册（实际: ' + [...registeredTools.keys()].join(',') + '）');
    assert.match(tool.description, /\[sample-sdk-plugin\]/);
    const out = await tool.execute({ msg: '经桥接组件调用' });
    assert.equal(JSON.parse(out).echo, '经桥接组件调用');

    // 上下文注入：session/created → agent assemble → 追加 contributions。
    assert.equal(sessionHandlers.length, 1);
    sessionHandlers[0]({ id: 'sess-9' });
    await new Promise((r) => setTimeout(r, 50)); // setTimeout(0) 挂载一拍
    assert.ok(mockCtx._assemble, 'system-prompt/assemble 监听必须挂到 agent.ctx');
    const assembly = { contexts: [{ name: 'core', order: 1, text: '核心提示词' }] };
    const enriched = await mockCtx._assemble(assembly);
    assert.equal(enriched.contexts.length, 2, '插件贡献须追加到 assembly.contexts');
    assert.equal(enriched.contexts[0].name, 'core', '核心段在前');
    assert.match(enriched.contexts[1].text, /sample-sdk-plugin/);
  } finally {
    delete process.env.DSH_EAC_BRIDGE_URL;
    delete process.env.DSH_EAC_BRIDGE_TOKEN;
    bridge.close();
    await mgr.shutdownAll();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Core Bridge cordis 组件：无端点环境（纯 dsh web）时空转不报错', async () => {
  const savedUrl = process.env.DSH_EAC_BRIDGE_URL;
  const savedTok = process.env.DSH_EAC_BRIDGE_TOKEN;
  delete process.env.DSH_EAC_BRIDGE_URL;
  delete process.env.DSH_EAC_BRIDGE_TOKEN;
  try {
    const mod = await import(bridgePluginUrl('no-endpoint'));
    let warned = false;
    await mod.apply({ logger: { info() {}, warn() { warned = true; } }, on() {}, tools: { register() {} }, get() { return {}; } });
    assert.equal(warned, false, '空转路径只 info 不 warn');
  } finally {
    if (savedUrl !== undefined) process.env.DSH_EAC_BRIDGE_URL = savedUrl;
    if (savedTok !== undefined) process.env.DSH_EAC_BRIDGE_TOKEN = savedTok;
  }
});

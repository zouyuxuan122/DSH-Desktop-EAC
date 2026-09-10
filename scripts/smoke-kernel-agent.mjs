// Keyless headless integration smoke. Uses the published agent/preset APIs from
// official agent-presets/tests/mount.spec.ts and SDK server SSE test fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const smokeRoot = path.resolve(process.env.DSH_SMOKE_TMP_ROOT || path.join(root, '.smoke-tmp'));
const preset = process.argv[2];
assert.ok(['anchored-standard', 'router-standard', 'router-spec', 'router-spec-nested'].includes(preset),
  'Usage: node scripts/smoke-kernel-agent.mjs <anchored-standard|router-standard|router-spec|router-spec-nested>');
const presetId = preset === 'router-spec-nested' ? 'router-spec' : preset;
const presetRoot = path.join(root, 'assets/agent-presets', preset === 'router-spec-nested' ? 'router-spec' : '');
const specMode = presetId === 'router-spec';
const readTool = specMode ? 'read' : 'str_replace_editor';
const keep = /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|PROCESSOR_ARCHITECTURE)$/i;
if (process.argv[3] !== '--worker') {
  const args = process.argv.slice(3);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--fixture-output'),
    'Optional export: --fixture-output NEW_EMPTY_DIRECTORY');
  const output = args.length ? path.resolve(args[1]) : undefined;
  if (output) {
    // Never reuse populated trees or follow a junction into a different home.
    let current = path.parse(output).root;
    for (const part of output.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { assert.equal((await fs.lstat(current)).isSymbolicLink(), false, 'No linked output ancestors'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { await fs.mkdir(output); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    assert.deepEqual(await fs.readdir(output), [], 'Fixture output must be empty');
  }
  await fs.mkdir(smokeRoot, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(smokeRoot, 'dsh-agent-smoke-'));
  let child;
  let timer;
  try {
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key))),
      HOME: temporary,
      USERPROFILE: temporary,
      APPDATA: path.join(temporary, 'AppData/Roaming'),
      LOCALAPPDATA: path.join(temporary, 'AppData/Local'),
    };
    child = childProcess.spawn(process.execPath,
      [fileURLToPath(import.meta.url), preset, '--worker', temporary, ...(output ? [output] : [])],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    timer = setTimeout(() => child.kill(), 35000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, `Worker failed or exceeded 35s:\n${stderr}\n${stdout}`);
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    // A loaded Windows .node file cannot be deleted until its process exits.
    // Only the supervisor removes the home, after observing worker close.
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), smokeRoot);
    assert.ok(path.basename(resolved).startsWith('dsh-agent-smoke-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    console.log(JSON.stringify({ ...result, cleanup: { ...result.cleanup, temporaryRemoved: true } }));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    // close was awaited above; a spawn failure has no live process to remove.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('close', resolve));
    }
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), smokeRoot);
    assert.ok(path.basename(resolved).startsWith('dsh-agent-smoke-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }
  process.exit(process.exitCode || 0);
}
const temporary = path.resolve(process.argv[4]);
assert.equal(path.dirname(temporary), smokeRoot);
assert.ok(path.basename(temporary).startsWith('dsh-agent-smoke-'));
const home = path.join(temporary, 'home');
const fixtureOutput = process.argv[5];
const workspace = path.join(fixtureOutput || temporary, 'workspace');
await fs.mkdir(home);
await fs.mkdir(workspace);
const originalCwd = process.cwd();
// Do not inherit credentials, proxy configuration, NODE_OPTIONS, or a live home.
for (const key of Object.keys(process.env)) if (!keep.test(key)) delete process.env[key];
Object.assign(process.env, {
  DSH_HOME: home, DSH_AGENTS_HOME: path.join(home, '.agents'), DSH_CWD: workspace, HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
  DSH_TELEMETRY_DISABLED: '1', DSH_OFFLINE_SMOKE_KEY: 'local-placeholder-not-a-real-key',
});
// Node on Windows can resolve os.homedir() from the process token rather than
// the mutable environment. Keep this isolated worker deterministic for the
// sandbox and prevent rc.2 workspace canonicalization from probing the real
// developer profile.
try { os.homedir = () => home; } catch { /* host may expose a read-only binding */ }
await fs.mkdir(path.join(home, '.agents'), { recursive: true });
process.chdir(workspace);

let port;
const denied = [];
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  const host = typeof options === 'object' ? options.host : args[1];
  const targetPort = typeof options === 'object' ? options.port : options;
  if (host !== '127.0.0.1' || Number(targetPort) !== port || !port) {
    denied.push(`socket:${String(host)}:${String(targetPort)}`);
    throw Error('Smoke forbids every socket except its local LLM provider');
  }
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== `http://127.0.0.1:${port}`) {
    denied.push(`fetch:${url.origin}`);
    throw Error('Smoke forbids external fetch');
  }
  return originalFetch(input, options);
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => {
    denied.push(`process:${name}`);
    throw Error('Smoke forbids child processes; only the real filesystem tool is exercised');
  };
}
syncBuiltinESMExports();

const nonce = randomUUID();
const fixture = path.join(workspace, 'smoke-input.txt');
const fixtureText = `offline-tool-witness:${nonce}\nsecond line\n`;
const answer = `Completed offline smoke ${nonce}`;
const reasoning = 'I will inspect the local fixture with the filesystem tool, then report the verified result.';
await fs.writeFile(fixture, fixtureText);
const requests = [];
const providerErrors = [];
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer local-placeholder-not-a-real-key');
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      assert.ok(raw.length < 2_000_000, 'bounded request size');
    }
    const body = JSON.parse(raw);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'offline-smoke-model');
    requests.push(body);
    assert.ok(requests.length <= 2, 'exactly one tool round and one completion expected');
    const chunk = (delta, finish_reason = null, usage) => `data: ${JSON.stringify({
      id: `smoke-${requests.length}`, object: 'chat.completion.chunk',
      created: 0, model: body.model,
      choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
    let frames;
    if (requests.length === 1) {
      assert.ok(body.tools.some(tool => tool.function.name === readTool));
      assert.ok(body.messages.some(message => message.role === 'user'));
      const args = JSON.stringify(specMode ? { file_path: fixture } : { command: 'view', path: fixture });
      // Split arguments across SSE chunks to exercise the real stream assembler.
      frames = [
        chunk({ role: 'assistant', content: null, reasoning_content: reasoning.slice(0, 30) }),
        chunk({ reasoning_content: reasoning.slice(30) }),
        chunk({ tool_calls: [{ index: 0, id: 'smoke-read', type: 'function',
          function: { name: readTool, arguments: args.slice(0, 17) } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(17) } }] }),
        chunk({}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 10 }),
      ];
    } else {
      const tool = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'smoke-read');
      assert.ok(tool, 'real tool result must be serialized into the next request');
      assert.ok(JSON.stringify(tool.content).includes(`offline-tool-witness:${nonce}`));
      frames = [
        chunk({ role: 'assistant', content: answer.slice(0, 12), reasoning_content: '' }),
        chunk({ content: answer.slice(12) }),
        chunk({}, 'stop', { prompt_tokens: 40, completion_tokens: 10 }),
      ];
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const frame of frames) response.write(frame);
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerErrors.push(error.stack);
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});

let ctx;
let handle;
let report;
const bounded = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 15000);
    })]);
  } finally {
    clearTimeout(timer);
  }
};
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const { Context } = await import('@deepseek-ai/cordis');
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const { SessionId, SessionLogOffset } = await import('@deepseek-ai/dsh-session');
  ctx = new Context();
  ctx.baseUrl = pathToFileURL(root + path.sep).href;
  const mount = async (name, config) => {
    const module = await import(name);
    await bounded(ctx.plugin(module.default ?? module, config), `host plugin ${name}`);
  };
  await mount('@deepseek-ai/cordis-plugin-loader');
  ctx.loader.builtins.include = (await import('@deepseek-ai/cordis-plugin-include')).default;
  ctx.loader.builtins.group = (await import('@deepseek-ai/cordis-plugin-group')).default;
  // Real host registries/providers needed by the unchanged standing presets.
  // No web search backend, credential store, telemetry, GUI or product startup.
  const host = [
    ['@deepseek-ai/cordis-plugin-timer'],
    ['@deepseek-ai/dsh-llm'],
    ['@deepseek-ai/dsh-session'],
    ['@deepseek-ai/dsh-session-projection'],
    ['@deepseek-ai/dsh-system-prompt'],
    ['@deepseek-ai/dsh-tools'],
    ['@deepseek-ai/dsh-agent'],
    ['@deepseek-ai/dsh-subprocess-local'],
    ['@deepseek-ai/dsh-fs-local', { cwd: workspace }],
    [process.platform === 'win32' ? '@deepseek-ai/dsh-pwsh-local' : '@deepseek-ai/dsh-bash-local',
      { cwd: workspace }],
    ['@deepseek-ai/dsh-shell-env', { dshHome: home }],
    ['@deepseek-ai/dsh-jobs-local'],
    ['@deepseek-ai/dsh-commands'],
    ['@deepseek-ai/dsh-skill'],
    ['@deepseek-ai/dsh-token-meter'],
    ['@deepseek-ai/dsh-subagent'],
    ['@deepseek-ai/dsh-user-questions'],
    ['@deepseek-ai/dsh-web'],
    ['@deepseek-ai/dsh-goal'],
    ['@deepseek-ai/dsh-session-persistence-jsonl', { root: path.join(home, 'sessions'), compression: 'none' }],
    ['@deepseek-ai/dsh-llm-deepseek', {
      apiKeyEnv: 'DSH_OFFLINE_SMOKE_KEY', baseURL: `http://127.0.0.1:${port}`,
      thinking: 'enabled', maxTokens: 256, streamIdleTimeoutMs: 3000,
    }],
    ['@deepseek-ai/dsh-agent-loop', { agents: [] }],
    ['@deepseek-ai/dsh-agent-presets', {
      default: presetId, roots: [{ path: presetRoot, trust: 'system' }],
      includeShippedRoot: false, includeUserRoot: false,
    }],
  ];
  for (const [name, config] of host) await mount(name, config);
  const versions = Object.fromEntries(['dsh', 'dsh-agent-loop', 'dsh-agent-presets', 'dsh-llm-deepseek']
    .map(name => [name, require(`@deepseek-ai/${name}/package.json`).version]));
  for (const version of Object.values(versions)) assert.equal(version, '0.1.5-rc.2');
  const sessionId = SessionId(`offline-${preset}-${nonce}`);
  const composition = path.join(presetRoot, presetId, 'agent.cordis.yml');
  const presetHash = createHash('sha256').update(await fs.readFile(composition)).digest('hex');
  handle = await bounded(ctx.agents.create({
    sessionId,
    meta: { cwd: workspace, agentPreset: presetId },
    agentOptions: { provider: 'deepseek-official', model: 'offline-smoke-model', maxTokens: 256 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, presetId); },
  }), 'preset mounting and session creation');
  const agent = handle.agent;
  assert.equal(ctx.agents.get(sessionId), agent);
  assert.equal(agent.session.header.agentPreset, presetId);
  const messages = [];
  ctx.on('session/event', (session, event) => {
    if (session.id === sessionId) messages.push(event);
  });
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: `Read smoke-input.txt with ${readTool} and report completion.` }],
    source: { kind: 'user' },
  }));
  await bounded(agent.whenIdle(), 'tool turn completion');
  assert.deepEqual(providerErrors, []);
  const events = agent.session.snapshotEvents();
  assert.equal(requests.length, 2, JSON.stringify({
    requests: requests.length,
    terminalEvents: events.filter(event => ['turn/end', 'step/end', 'agent/error'].includes(event.type)),
    env: { cwd: process.cwd(), home, dshHome: process.env.DSH_HOME, userProfile: process.env.USERPROFILE, osHome: os.homedir() },
  }));
  const types = events.map(event => event.type);
  for (const type of ['user/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end']) {
    assert.ok(types.includes(type), `missing durable ${type}: ${types.join(', ')}`);
  }
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
  assert.ok(JSON.stringify(events.find(event => event.type === 'tool/result').data).includes(nonce));
  assert.ok(events.filter(event => event.type === 'assistant/message')
    .some(event => JSON.stringify(event.data).includes(answer)));
  assert.ok(events.some(event => JSON.stringify(event.data).includes(reasoning)),
    'SSE reasoning must survive in durable session events');
  assert.equal(await fs.readFile(fixture, 'utf8'), fixtureText);
  await bounded(ctx.sessions.flush(agent.session), 'session flush');
  const reader = await bounded(ctx.sessionPersistence.open(sessionId, 'read'), 'persistence open');
  try {
    const stored = await bounded(reader.read(SessionLogOffset(0)), 'persistence read');
    assert.deepEqual(stored.events, events, 'published JSONL backend round-trips the complete session');
  } finally {
    await bounded(reader.close(), 'persistence reader close');
  }
  let exported;
  if (fixtureOutput) {
    const sessionsRoot = path.join(fixtureOutput, 'sessions');
    const artifacts = [];
    for (const relative of await fs.readdir(path.join(home, 'sessions'), { recursive: true })) {
      if (!relative.endsWith('.jsonl')) continue;
      const source = path.join(home, 'sessions', relative);
      assert.ok((await fs.lstat(source)).isFile());
      const destination = path.join(sessionsRoot, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination, 1); // COPYFILE_EXCL
      artifacts.push({ path: path.relative(fixtureOutput, destination).split(path.sep).join('/'),
        sha256: createHash('sha256').update(await fs.readFile(destination)).digest('hex') });
    }
    assert.equal(artifacts.length, 1);
    // A fresh owner has no live Session: discovery must come from copied JSONL.
    const cold = new Context();
    try {
      await cold.plugin((await import('@deepseek-ai/dsh-session')).default);
      await cold.plugin((await import('@deepseek-ai/dsh-session-persistence-jsonl')).default,
        { root: sessionsRoot, compression: 'none' });
      await cold.plugin((await import('@deepseek-ai/dsh-session-query')).default);
      const records = await cold.sessionQuery.listSessions();
      assert.ok(JSON.stringify(records).includes(sessionId), 'cold query discovers fixture');
      const copy = await cold.sessionPersistence.open(sessionId, 'read');
      try {
        assert.equal(copy.header.cwd, workspace);
        assert.deepEqual((await copy.read(SessionLogOffset(0))).events, events);
      } finally { await copy.close(); }
    } finally { await cold.fiber.dispose(); }
    exported = { directory: fixtureOutput, sessionId, workspace, artifacts,
      coldDiscoveryVerified: true, reasoning, answer, tool: readTool,
      kernel: versions.dsh, preset: presetId };
    await fs.writeFile(path.join(fixtureOutput, 'fixture.json'),
      JSON.stringify(exported, null, 2) + '\n', { flag: 'wx' });
    await fs.writeFile(path.join(fixtureOutput, 'README.txt'), [
      'Offline UI acceptance fixture; generated by the real alpha.2 kernel.',
      'Stop the isolated public test server before import. Never use a live/user home.',
      'Copy the CONTENTS of this sessions directory into <ISOLATED_DSH_HOME>/sessions,',
      'preserving every project/session subdirectory and the generation JSONL filename.',
      'Use a newly created test home; do not overwrite an existing session.',
      `Keep the workspace at its original absolute location: ${workspace}`,
      `Session ID: ${sessionId}`,
      'Start the public server with DSH_HOME pointing to that isolated home.',
      'Select the fixture workspace/session in the sidebar; do not submit another turn.',
      'The base bundle config uses dshHomePath("sessions"); session controller list',
      'uses sessionQuery.listSessions(), which discovers persisted JSONL without a registry import.',
      'Verified: fresh persistence/query owners list and read this copied log exactly.',
      'Fixture metadata is informational, not a server config. No keys/provider config included.',
      'The fake provider is stopped; this fixture supports history rendering, not continued inference.',
      '',
    ].join('\n'), { flag: 'wx' });
  }
  assert.equal(createHash('sha256').update(await fs.readFile(composition)).digest('hex'), presetHash);
  assert.deepEqual(denied, []);
  const firstRequestTools = requests[0].tools.map(tool => tool.function.name);
  const shell = preset === 'anchored-standard' || process.platform !== 'win32' ? 'bash' : 'pwsh';
  const expectedBootstrap = specMode ? [shell, 'read', 'write', 'edit'] : [shell, 'str_replace_editor'];
  assert.deepEqual([...firstRequestTools].sort(), expectedBootstrap.sort(), 'exact first-request preset catalog');
  const secondRequestTools = requests[1].tools.map(tool => tool.function.name).sort();
  if (preset === 'anchored-standard') {
    assert.deepEqual(secondRequestTools,
      ['bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor']);
  } else {
    assert.deepEqual(secondRequestTools, ctx.tools.schemas(agent).map(tool => tool.name).sort(),
      'router promotion exposes its full scoped catalog');
  }
  report = { preset, versions, presetSha256: presetHash, requests: requests.length,
    firstRequestTools, bootstrapMatches: true, warnings: [],
    secondRequestToolCount: secondRequestTools.length,
    eventTypes: types, turnEnd: 'completed', observedEvents: messages.length, persisted: true,
    externalCalls: 0, childProcesses: 0, ...(exported ? { fixture: exported } : {}) };
} catch (error) {
  console.error(error.stack);
  if (providerErrors.length) console.error(JSON.stringify(providerErrors));
  if (denied.length) console.error(JSON.stringify({ denied }));
  process.exitCode = 1;
} finally {
  try {
    if (handle) await bounded(handle.dispose(), 'agent disposal');
    if (ctx) await bounded(ctx.fiber.dispose(), 'root disposal');
  } catch (error) {
    console.error(`Kernel cleanup failed: ${error.stack}`);
    process.exitCode = 1;
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  process.chdir(originalCwd);
  assert.equal(server.listening, false);
  if (report && !process.exitCode) console.log(JSON.stringify({ ...report, cleanup: {
    serverClosed: true, kernelDisposed: true,
  } }));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const script = fileURLToPath(new URL('../scripts/smoke-kernel-agent.mjs', import.meta.url));

for (const preset of ['anchored-standard', 'router-standard', 'router-spec', 'router-spec-nested']) {
  test(`offline kernel 0.1.5-rc.2 + bundled ${preset}: real tool turn and persistence`,
    { timeout: 60000 }, async t => {
      // Start without inherited keys/proxies/NODE_OPTIONS, before any kernel import.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|PROCESSOR_ARCHITECTURE)$/i.test(key)));
      const child = spawn(process.execPath, [script, preset], {
        env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let errors = '';
      child.stdout.setEncoding('utf8').on('data', data => { output += data; });
      child.stderr.setEncoding('utf8').on('data', data => { errors += data; });
      const timer = setTimeout(() => child.kill(), 50000);
      t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      clearTimeout(timer);
      assert.equal(code, 0, `${preset}\n${output}\n${errors}`);
      const report = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(report.preset, preset);
      assert.equal(report.requests, 2);
      assert.equal(report.bootstrapMatches, true);
      assert.deepEqual(report.warnings, []);
      assert.equal(report.persisted, true);
      assert.equal(report.externalCalls, 0);
      assert.equal(report.childProcesses, 0);
      assert.deepEqual(report.cleanup, {
        serverClosed: true, kernelDisposed: true, temporaryRemoved: true,
      });
      t.diagnostic(JSON.stringify(report));
    });
}

test('opt-in fixture exports actual reasoning/tool JSONL and refuses reuse', { timeout: 60000 }, t => {
  const smokeRoot = path.join(path.dirname(script), '..', '.smoke-tmp');
  fs.mkdirSync(smokeRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(smokeRoot, 'dsh-fixture-export-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const output = path.join(scratch, 'fixture');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|PROCESSOR_ARCHITECTURE)$/i.test(key)));
  const run = () => spawnSync(process.execPath,
    [script, 'router-standard', '--fixture-output', output],
    { env, windowsHide: true, encoding: 'utf8', timeout: 50000 });
  const child = run();
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const report = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(report.cleanup.temporaryRemoved, true);
  assert.equal(report.fixture.coldDiscoveryVerified, true);
  const metadata = JSON.parse(fs.readFileSync(path.join(output, 'fixture.json')));
  assert.deepEqual(metadata, report.fixture);
  const artifact = metadata.artifacts[0];
  const bytes = fs.readFileSync(path.join(output, artifact.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  const records = bytes.toString().trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].cwd, path.join(output, 'workspace'));
  assert.ok(bytes.toString().includes(metadata.reasoning));
  assert.ok(bytes.toString().includes('"tool/call"'));
  assert.ok(bytes.toString().includes('"tool/result"'));
  assert.ok(bytes.toString().includes(metadata.answer));
  assert.ok(fs.existsSync(path.join(metadata.workspace, 'smoke-input.txt')));
  const rejected = run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Fixture output must be empty/);
  assert.deepEqual(fs.readFileSync(path.join(output, artifact.path)), bytes);
});

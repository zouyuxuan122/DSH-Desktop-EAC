import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('sidecar exposes Linux XDG data and desktop capabilities over shell.info', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidecar-platform-'));
  const child = spawn(process.execPath, ['../tauri-shell/sidecar/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      DSH_HOME: join(root, 'dsh-home'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
      DSH_DESKTOP_RECOVERY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
    if (typeof message.id === 'number') pending.get(message.id)?.(message.result || {});
  });
  let id = 0;
  const call = (method: string): Promise<Record<string, unknown>> => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
  });

  try {
    const info = await call('shell.info');
    assert.equal(info.platform, 'linux');
    assert.equal(info.userDataDir, join(root, 'xdg', 'deepseek-harness-eac'));
    const capabilities = info.capabilities as Record<string, unknown>;
    assert.ok(['supported', 'external-dependency'].includes(String(capabilities.clipboard)));
    assert.equal(capabilities.clientSelfUpdate, 'external-handoff');
    assert.equal(capabilities.computerUser, 'unavailable');
    assert.equal(capabilities.processFence, 'degraded');
    assert.deepEqual(await call('shutdown'), { bye: true });
    await new Promise<void>((resolve, reject) => {
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`sidecar exited ${String(code)}`)));
    });
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    lines.close();
    rmSync(root, { recursive: true, force: true });
  }
});

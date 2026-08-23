import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to one of the bundled PowerShell scripts inside this package. */
export function powerShellScript(name) {
  return join(__dirname, name);
}

/**
 * Run a bundled PowerShell script with a JSON payload (passed as base64 to avoid
 * shell-quoting/encoding issues). The script prints one JSON object to stdout;
 * it MUST carry a boolean `ok` field. `ok:true` resolves, otherwise we reject
 * with `.error`. Stdout lines before the JSON are tolerated.
 *
 * @param {string} scriptName  'capture.ps1' | 'input.ps1'
 * @param {object} payload     JSON payload object
 * @param {{timeoutMs?:number, signal?:AbortSignal}} opts
 * @returns {Promise<object>}  the parsed result object
 */
export function runPs(scriptName, payload, { timeoutMs = 25000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(JSON.stringify(payload ?? {}), 'utf8').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powerShellScript(scriptName), '-Json', b64],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    let settled = false;

    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`computer-use: PowerShell ${scriptName} 执行超时（${timeoutMs}ms）`));
    }, timeoutMs);

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => {
        child.kill();
        finish(reject, new Error('computer-use: 已取消'));
      }, { once: true });
    }

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      finish(reject, new Error(`computer-use: 无法启动 PowerShell：${e.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        let parsed;
        try { parsed = JSON.parse(lines[i]); } catch { continue; }
        if (parsed && typeof parsed.ok === 'boolean') {
          if (parsed.ok) return resolve(parsed);
          return reject(new Error(`computer-use: ${parsed.error || 'PowerShell 执行失败'}`));
        }
      }
      const detail = err.trim();
      reject(new Error(
        `computer-use: ${scriptName} 失败（exit ${code}）` +
        (detail ? `：${detail.slice(0, 300)}` : '（无输出）')
      ));
    });

    child.stdin.end();
  });
}

export default runPs;

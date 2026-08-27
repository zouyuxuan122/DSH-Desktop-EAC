/**
 * computer-user — Codex-style computer use for DeepSeek Harness (DSH).
 *
 * Reads the screen (computer_screenshot → PNG path) and drives the mouse &
 * keyboard (click / type / keypress / scroll / drag / move_mouse / wait /
 * get_cursor_position) via bundled PowerShell scripts using Win32 SendInput —
 * zero native dependencies, so it works in the same Node host that runs the
 * EAC desktop profile (same pattern as picturereader's Windows OCR).
 *
 * Pairs with picturereader: screenshot returns a file path that the model
 * feeds to image_scan / image_ocr, then acts on it.
 *
 * Settings (namespace `computer-user`, hot-reloaded via a runtime snapshot):
 *   mode — disabled / readonly / manual / auto
 *   screenshot_dir / default_scale / typing_interval_ms / scroll_units / debug
 *
 * @module computer-user
 */

import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { NS, Config } from './config.js';
import { createComputerTools } from './tools.js';
import { runPs, powerShellScript } from './ps.js';
import { createOutputGuard } from './output-guard.js';

export const name = 'computer-user';
export const version = '0.3.0';

/** Services required at runtime. */
export const inject = ['tools'];

/** In-memory set of session IDs that have been approved via /computer. */
const approvedSessions = new Set();

let sourceGetter = null;
let sourceSetter = null;
const getConfig = () => (sourceGetter ? sourceGetter() : undefined);

/** Persist the runtime mode (used by computer_set_mode + /computer manual mode). */
async function setMode(mode) {
  if (typeof sourceSetter !== 'function') throw new Error('computer-user: 设置服务不可用');
  await sourceSetter('mode', mode);
}

/**
 * Resolve the session-target set affected by /computer from a command
 * invocation: agent.id (SessionId) + session.header.sessionId, falling back
 * to '__global__' when neither is present.
 * @param {object} invocation
 * @returns {Set<string>}
 */
export function sessionTargetsFromInvocation(invocation) {
  const targets = new Set();
  try {
    if (invocation?.agent?.id) targets.add(String(invocation.agent.id));
    if (invocation?.agent?.session?.header?.sessionId) targets.add(String(invocation.agent.session.header.sessionId));
  } catch { /* ignore */ }
  if (targets.size === 0) targets.add('__global__');
  return targets;
}

/**
 * Toggle approval for a set of session targets: if any target is already
 * approved, revoke them all; otherwise approve them all.
 * @param {Set<string>} approvedSessions
 * @param {Set<string>} targets
 * @returns {{approved:boolean, targets:Set<string>}}
 */
export function toggleApproval(approvedSessions, targets) {
  const approved = [...targets].some((t) => approvedSessions.has(t));
  if (approved) {
    for (const t of targets) approvedSessions.delete(t);
    return { approved: false, targets };
  }
  for (const t of targets) approvedSessions.add(t);
  return { approved: true, targets };
}

export function apply(ctx, config) {
  // ── register tools ──
  ctx.effect(() => {
    for (const tool of createComputerTools({ runPs, getConfig, approvedSessions, sessionId: undefined, setMode })) {
      ctx.tools.register({
        ...tool,
        // Wrap execute to inject the current session ID at call time
        async execute(args, exec) {
          const sid = exec?.agent?.session?.header?.sessionId ?? exec?.sessionId ?? '';
          // Rebuild gate closure with the real session ID
          const tools = createComputerTools({ runPs, getConfig, approvedSessions, sessionId: sid, setMode });
          const realTool = tools.find((t) => t.name === tool.name);
          return realTool.execute(args, exec);
        },
      });
    }
  });

  // ── settings namespace (hot reload) ──
  try {
    ctx.inject(['settings'], (sctx) => {
      const settingsNs = settingsNamespace(NS);
      const scope = sctx.settings.register(settingsNs, Config, { base: config });
      sourceGetter = () => scope.get();
      sourceSetter = (key, value) => scope.set(key, value);
      scope.watch(() => { /* trigger hot reload */ });
    });
  } catch (error) {
    ctx.logger?.warn?.(`[computer-user] settings disabled: ${String(error?.message ?? error)}`);
    sourceGetter = () => ({ ...config, mode: config?.mode ?? 'manual' });
  }

  // ── /computer command for session approval ──
  try {
    ctx.inject(['commands'], (sctx) => {
      sctx.commands.register({
        name: 'computer',
        description: '批准当前会话使用 computer-user 的全部工具（手动批准模式下需要）',
        handler: async (invocation) => {
          // /computer 是开关：第一次批准当前会话，再按一次撤销批准。
          const targets = sessionTargetsFromInvocation(invocation);
          const { approved } = toggleApproval(approvedSessions, targets);
          const ids = [...targets].join(', ');
          return approved
            ? { kind: 'success', text: `✅ 已批准：computer-user 全部工具在当前会话可用（${ids}）。后续轮次持续生效；再按 /computer 可撤销。` }
            : { kind: 'success', text: `🔒 已撤销批准：computer-user 有副作用工具需重新 /computer 批准（${ids}）。` };
        },
      });
      ctx.logger?.info?.('[computer-user] /computer command registered');
    });
  } catch (error) {
    ctx.logger?.warn?.(`[computer-user] commands service not available: ${String(error?.message ?? error)}`);
  }

  // ── LLM output guard: strip fake tool-call text written as conversation ──
  //     text; first occurrence replaced with a coaching note, second chance
  //     (same fingerprint) passes through. Off when output_guard=false.
  try {
    ctx.inject(['llm'], (sctx) => {
      const llm = sctx.llm;
      if (!llm || typeof llm.listProviders !== 'function') return;
      const wrapProviders = () => {
        let wrapped = 0;
        for (const provider of llm.listProviders()) {
          let reg;
          try { reg = llm.registration(provider); } catch { continue; }
          if (!reg || !reg.adapter) continue;
          if (reg.adapter?.__cuOutputGuard) continue;
          const orig = reg.adapter;
          const origStream = orig.stream.bind(orig);
          const guardProxy = new Proxy(orig, {
            get(target, prop, receiver) {
              if (prop === 'stream') {
                return async function* (options) {
                  const cfg = getConfig();
                  if (cfg && cfg.output_guard === false) { yield* origStream(options); return; }
                  const guard = createOutputGuard({ allowAfter: 2 });
                  let noteShown = false;
                  for await (const chunk of origStream(options)) {
                    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                      const decision = guard.sniff(chunk.text);
                      if (decision.kind === 'reject') {
                        if (!noteShown) {
                          noteShown = true;
                          yield { ...chunk, text: decision.note };
                        }
                        continue; // drop the polluted delta
                      }
                      // pass / pass-second → forward the original delta
                    }
                    yield chunk;
                  }
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          Object.defineProperty(guardProxy, '__cuOutputGuard', { value: true, enumerable: false, configurable: true });
          reg.adapter = guardProxy;
          wrapped++;
        }
        if (wrapped > 0) ctx.logger?.info?.(`[computer-user] output guard active on ${wrapped} provider(s)`);
      };
      wrapProviders();
      // re-wrap if providers register later (best-effort; ignore failures)
      if (typeof llm.on === 'function') {
        try { llm.on('provider/register', () => { try { wrapProviders(); } catch { /* ignore */ } }); } catch { /* ignore */ }
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(`[computer-user] output guard unavailable: ${String(error?.message ?? error)}`);
  }

  // ── debug helper ──
  if (config?.debug) {
    ctx.logger?.info?.(`[computer-user] scripts: ${powerShellScript('capture.ps1')}, ${powerShellScript('input.ps1')}`);
  }
}

export default { name, version, inject, apply };

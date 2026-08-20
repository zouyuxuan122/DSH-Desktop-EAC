/**
 * dsh-auto-compact — host half (no-op).
 *
 * Compaction itself belongs to the harness core (dsh-compaction-basic +
 * dsh-command-compact's /compact). This plugin only decides WHEN to fire it
 * from the browser: the client half watches the session's contextPressure
 * projection and submits /compact through the composer when usage crosses
 * the threshold. Host half exists so the package is a valid bundle.
 */
export const name = 'auto-compact';
export const inject = [];
export function apply() {
  // no-op.
}

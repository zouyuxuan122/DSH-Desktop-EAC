/**
 * dsh-plugin-shield — host half (intentionally tiny).
 *
 * The real protection engine lives in the desktop shell's main process
 * (plugin-guard.js): it snapshots before every install / boot, verifies
 * boots and rolls back automatically when a plugin breaks the tree. This
 * host half exists only so the package is a valid bundle with a patch row;
 * all UI actions go through the window.dshDesktop.guard IPC bridge.
 */
export const name = 'plugin-shield';
export const inject = [];
export function apply() {
  // no-op: everything is client-side over the desktop shell bridge.
}

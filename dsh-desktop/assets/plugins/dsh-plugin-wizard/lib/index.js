/**
 * dsh-plugin-wizard — host half (intentionally tiny).
 *
 * The actual wizard lives in the desktop shell (assets/onboarding.html +
 * main-process onboard:* IPC). This host half exists only so the package is
 * a valid bundle with a patch row; the settings-section UI rides the
 * window.dshDesktop.pluginWizard bridge.
 */
export const name = 'plugin-wizard';
export const inject = [];
export function apply() {
  // no-op: everything is client-side over the desktop shell bridge.
}

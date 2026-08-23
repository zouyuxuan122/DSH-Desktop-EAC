/**
 * dsh-font-custom — host half (no-op).
 *
 * Font & color customization is purely client-side: a settings section plus
 * CSS-variable overrides persisted in localStorage. The host half exists so
 * the package is a valid bundle with a patch row.
 */
export const name = 'font-custom';
export const inject = [];
export function apply() {
  // no-op.
}

// Host-side entry: this companion package has no server half (the balance
// payload is produced by the DSH Desktop shell and pushed to the page).
// The loader (dsh 0.1.0-rc.6) rejects an empty default export, so the host
// half is a valid no-op Cordis plugin.
const name = "dsh-balance";
const inject = [];
function apply() {}
export { apply, inject, name };

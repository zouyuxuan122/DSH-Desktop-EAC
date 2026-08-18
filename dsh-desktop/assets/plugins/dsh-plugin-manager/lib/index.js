// Host-side entry: this companion package has no server half — the plugin
// list and enable/disable toggles are served by the DSH Desktop shell's main
// process through the preload bridge (window.dshDesktop.pluginManager):
//   list()       → every bundled/user/core plugin with description & enabled state
//   setEnabled() → write/remove the user-layer disabled entry in the web
//                  profile's cordis.patch.yml
//   uninstall()/restore() → remove/re-copy an optional desktop-owned package
//                  in the current profile (the app shell supplies the bridge)
// The loader rejects an empty default export, so the host half is a valid
// no-op Cordis plugin (same pattern as dsh-compaction-settings /
// dsh-wsl-settings / dsh-balance).
const name = 'dsh-plugin-manager';
const inject = [];
function apply() {}
export { apply, inject, name };

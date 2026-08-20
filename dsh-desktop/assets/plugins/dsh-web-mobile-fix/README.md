# dsh-web-mobile-fix
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Mobile layout fixes for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.

A pure client-side CSS overlay that repairs the worst mobile breakages on narrow (≤700px viewport) screens, without touching any product source:

- Settings panel becomes a full-screen column layout instead of a squeezed desktop layout
- Directory-picker footer (Cancel / Confirm) pinned to one bottom row
- Sidebar opens full-screen instead of squeezing the conversation
- Settings plugin navigation (4 buttons) fits on a single row
- Session-log button collapses to an icon
- Model name hidden in the composer (chevron only)
- Dropdowns / popups / menus render centered

## How it works

The plugin ships a browser half (`exports["./client"]`, declared via `dsh.client.platform: "web"`), discovered by the client-modules scanner and loaded from the boot manifest. It injects one `<style>` tag with `@media (max-width: 700px)` overrides targeting the product's stable `data-slot` attributes, and removes the tag on unload — fully reversible.

## Requirements

- DeepSeek Harness Web profile (`dsh --profile web`), any recent 0.1.x release
- Selectors target product slot contracts; they are stable within a version line but may need small updates after a major product revamp

## Install

### Bundle install (recommended)

Installed from npm:

```sh
dsh plugin --profile web add dsh-web-mobile-fix
```

(No npm / local development — point pnpm at the repo instead:

```sh
dsh plugin --profile web add github:AcidGr/dsh-web-mobile-fix
```
)

Restart `dsh web` (or wait for the profile hot-reload), then hard-refresh the browser.

### Manual install (no pnpm / offline)

```sh
PROFILE="$DSH_HOME/profiles/web"                 # adjust DSH_HOME and profile name
mkdir -p "$PROFILE/plugins" "$PROFILE/node_modules/@dsh-profile"
cp -r dsh-web-mobile-fix "$PROFILE/plugins/mobile-fix"
ln -sfn ../../plugins/mobile-fix "$PROFILE/node_modules/@dsh-profile/mobile-fix"
# append to $PROFILE/cordis.patch.yml:
#   - insert:
#       - id: mobile-fix
#         name: '@dsh-profile/mobile-fix'
```

## Verify

Open the Web UI on a phone-width window — the settings panel, sidebar, and popups should be mobile-adapted.

## Rollback

- Bundle install: `dsh plugin --profile web remove dsh-web-mobile-fix`
- Manual install: delete the `mobile-fix` insert block from `cordis.patch.yml` (the plugin dir can stay or go)

No product source is modified; upgrades do not overwrite it.

## License

MIT

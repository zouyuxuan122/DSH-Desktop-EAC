# DSH Composer Dynamic Island

**English** | [简体中文](README.zh-CN.md)

Collapse selected DeepSeek Harness Web composer controls into a compact,
upward-expanding island without moving their DOM nodes or changing the host
React tree.

[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) · A DeepSeek Harness ecosystem plugin.

## Compatibility boundary

This package has two deliberately separate layers:

- `src/index.ts` (published as `lib/types/index.js`) and `dsh-plugin.json` form
  a headless Community v0.15 host facet. It requires no contracts, permissions,
  credentials, browser, or GUI.
- `lib/client.js` is an optional DSH Web compatibility adapter. Community
  v0.15 does not define a client facet, so the adapter is not represented as
  one and is not claimed as cross-host UI conformance.

See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the exact boundary.

## Web behavior

The adapter detects controls from an active DSH input or composer surface and
lets the user choose which controls collapse into an upward-expanding island.
It discovers:

- native controls and contributions in `conversation.input.left`,
  `conversation.input.right`, and `conversation.input.model`;
- button-style contributions in future `conversation.input.*` or `composer.*`
  slots;
- nested button contributions marked with `data-plugin`, `data-plugin-id`,
  `data-extension`, `data-extension-id`, or `data-contribution`;
- unmarked button controls that are direct members of a confirmed composer
  toolbar, as manual opt-in choices.

Discovery stays inside a confirmed input/composer surface. Text-entry widgets
such as text/search inputs, textareas, contenteditable regions, and ARIA
textboxes are never collapsed, even when they carry a plugin marker. Search,
settings, and ordinary form controls outside the composer are not scanned.

Defaults collapse left-side plugin controls and the WebUI team-mode selector.
Native tools, permission controls, model controls, and send/stop remain in
their original positions. Existing controls remain owned by their original
React parent; the adapter changes presentation attributes and styles without
moving nodes to another parent.

Open DSH Settings and select `输入灵动岛` to change the detected controls.
Selections apply immediately and remain in browser local storage. Hover or
focus the three-dot handle to open, click to pin on touch devices, move away to
close, or press Escape to close and restore focus.

On very small viewports, selected controls that cannot fit safely remain in
their original toolbar position. Because React ownership is preserved, keyboard
and screen-reader order follows the original DOM order rather than the visual
island arrangement.

The plugin deliberately does **not** provide drag-and-drop, coordinate storage,
or any other user-facing button-position editor. Panel placement is calculated
only to render the island beside its fixed composer trigger.

## Installation

This repository is currently distributed from GitHub:

```sh
dsh plugin add github:says693/dsh-composer-dynamic-island
```

Alternatively, add `dsh-composer-dynamic-island` to a target profile and enable
its bundle. `cordis.patch.yml` contains the portable Cordis row. If the DSH Web
slot service or composer surface is unavailable, the browser adapter is not a
supported target and the host facet remains a no-op.

## Data and permissions

- Declared Community v0.15 permissions: none.
- Network requests: none.
- Filesystem access: none.
- Browser storage: only whether configuration is enabled and the identifiers of
  controls selected for the island.
- Conversation content, model-provider settings, API keys, and credentials are
  neither read nor stored.

Older stored layout coordinates and cached control labels are removed when the
adapter next loads.

## Removal

Remove `dsh-composer-dynamic-island` from the profile bundles and dependencies,
then restart DSH. Browser settings are intentionally preserved unless the
site's local storage key `dsh-composer-dynamic-island-config-v1` is removed.

## Development

Requires Node.js `^22.19 || >=24` and pnpm 10.

The package root follows the dsh-TUI plugin-template contract and exports
`name`, typed `Config`, and `apply` without a default export. The optional DSH
Web adapter remains a separate, explicitly non-standard client layer.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm verify
```

## Author

This plugin is written and maintained solely by [says693](https://github.com/says693).

## Status and license

The Community v0.15 metadata is a community draft compatibility declaration,
not an official DSH certification. The optional Web adapter must be tested on
each supported DSH Web host.

Released under the [MIT License](LICENSE).

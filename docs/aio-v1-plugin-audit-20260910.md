# AIO v1 Plugin Audit - 2026-09-10

## Scope

Audited branch: `aio-v1` at `00de52d` plus this working branch's changes.

Release target: **EAC 9.6.3** with `@deepseek-ai/dsh` **0.1.5-rc.2**.

The active built-in companion set has eight runtime entries and one required
compatibility dependency. No entry is a pure duplicate:

| Package | Role | Decision |
| --- | --- | --- |
| `dsh-aio-ui-compat` | Compatibility provider used by reviewed WebUI adapters | Retain; dependency-only |
| `dsh-auto-compact` | Optional compaction UI | Retain; independently toggleable |
| `@deepseek-ai/dsh-balance` | Price settings and balance display | Retain; no legacy bottom pill remains |
| `dsh-better-sidebar` | Workspace, terminal, editor and browser surface | Retain |
| `dsh-composer-dynamic-island` | Composer layout enhancement | Retain; model picker remains host-owned |
| `@deepseek-ai/dsh-plugin-manager` | Built-in plugin enable/remove controls | Retain; core |
| `dsh-plugin-shield` | Shell guard and recovery controls | Retain; core |
| `@deepseek-ai/dsh-skin-switch` | Main-repository skin selector and wiring owner | Retain; companion, no external auto-update |
| `dsh-undo-savepoint` | User-visible undo, snapshots and offline recovery | Retain; overlaps the guard only at recovery boundaries, not at user workflow scope |

The public seed stays dependency-only. `skin-switch` and `ui-skin-*` rows are
created idempotently by sidecar companion-sync, so a repaired profile gets the
same main-repository skin system without hard-coding package rows into the
sanitized seed. Nine skins are registered disabled; `maid-atelier` is retained
as an audited asset but skipped until its external runtime compatibility is
re-qualified.

## Fixed in This Branch

1. Safe mode now uses a profile-local marker that both Electron and Tauri
   synchronizers honor. Companion package files remain available, but loader
   rows are not reinserted until safe mode is exited.
2. `dsh-undo-savepoint` now derives its default state, snapshot and profile
   paths from `DSH_HOME`, preserving AIO's isolated user-data boundary.
3. The profile-upgrade gate now accepts the kernel's legitimate shared
   dependency-layer links while still rejecting links that escape trusted roots.
4. The AIO UI compatibility bundle is regenerated from the pinned upstream
   checkout `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`.
5. A damaged agent overlay is probed with its real CLI before it can shadow the
   bundled kernel. Failure quarantines it as `agent-broken-*` and retains
   `agent-previous`; the backup is cleared only after a verified overlay boot.
6. Sidecar TypeScript now resolves its locked Node types from the Tauri toolchain
   and uses the current Node16 module settings.
7. `js-yaml` is pinned to `4.3.2` to remove GHSA-2883-xcg3-v3hh from the
   production dependency graph.
8. `fs-ext@2.1.1` is now an explicit root build dependency. The native runtime
   build no longer relies on a transitive copy accidentally present in an old
   public seed.

## Community v0.15 Status

All nine packages under `assets/plugins/` now carry a unique root
`dsh-plugin.json`. Each is validated with the local
`dsh-ecosystem-spec` manifest validator against the fixed v0.15 schema and
current TUI host descriptor.

All ten `assets/skins/*` packages also carry a v0.15 manifest. Their manifest
metadata binds the package identity to `skin.json.wiring.id`; no skin declares
permissions, commands, subscriptions, or a fabricated standard contract.

The reviewed public profile seed also includes third-party runtime bundles such
as `@dsh-external/dsh-webui`, `dsh-drag-and-drop`, `dsh-meme`,
`dsh-plugin-wallpaper-engine`, `dsh-status-rotator` and `dsh-whale-widget`.
Those archives do not currently carry root Community v0.15 manifests. They are
runtime-compatible in the tested AIO seed, but they must not be described as
Community v0.15 compliant until each publisher supplies a reviewed manifest or
the package is retired from the seed.

## PR Decision

- PR #347 is already merged in `aio-v1` (`00de52d`).
- PR #340 targets a different main-branch layout. Its overlay health intent is
  implemented here using AIO's sidecar/updater boundary and covered by
  `test/agent-overlay-health.test.mjs`.
- PR #296 is currently GitHub-merge-conflicted (`dirty`). Its broad plugin
  compatibility UI must be ported only after the external seed packages have
  reviewed v0.15 manifests; importing it now would assert compatibility that
  the current seed cannot prove.
- PR #330 adds a large Windows speech-recognition plugin. It is not integrated:
  it expands the plugin set, adds native/model dependencies, and conflicts with
  the current duplicate-reduction and startup-stability priority.
- Main's Electron client self-update path is intentionally not copied into the
  Tauri AIO release line. The compatible part is the protected plugin updater:
  npm/GitHub source checks, `engines.dsh` gating, guard snapshots, isolated
  staging, overlay fallback, and explicit restart confirmation. Automatic
  plugin updates remain opt-in and default to disabled.

## Verification

- `npm test`: 733 tests, 731 passed, 0 failed, 2 conditional skips.
- `cargo test --locked --manifest-path tauri-app/Cargo.toml`: 21 passed.
- `npm audit --omit=dev --offline`: 0 findings (remote audit endpoint was
  unavailable in this environment).
- Built `DSHEAC AIO` 9.6.3 executable, NSIS installer and portable ZIP;
  release-path audit passed.
- `boot-smoke.js`: HTTP ready in 52.398 seconds, shutdown cleanup passed.
- `gui-smoke.js`: passed with the 9.6.3 release binary and verified chrome, plugin
  manager bridge, recovery bridge and a screenshot.

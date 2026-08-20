# Zat-DSH Engine

> The visual plugin marketplace for DeepSeek Harness. Browse, search, install, update and uninstall community plugins — Wallpaper Engine style.

[English](#zat-dsh-engine) · [中文说明](README.zh.md)

Zat-DSH Engine adds a **Plugin Market** tab to **Settings → Plugins** in the DeepSeek Harness web GUI. It lists the entire `dsh-plugin` topic community from GitHub, shows bilingual intros, and installs plugins with one click.

## Features

- **Full community catalog** — live GitHub search of the `dsh-plugin` topic (1700+ repositories, growing daily)
- **AI plugin finder** — in any conversation just say what you need (e.g. "find me a plugin that lets the model see images") and the AI searches the market, recommends candidates, and reports each one's **pre-install health + security scan** (✅/⚠️/❌) — problems are reported honestly, nothing is blindly recommended
- **12 categories** — Theme, Tools, Browser, Skills, Vision, Network, Agents, Data, Hardware, Design, Security…
- **Live search** — type to filter, no Enter key needed; clearing the box returns to the full list
- **Bilingual intros** — 999 pre-translated Chinese intros bundled; new plugins are translated on the fly by your current model; English UI shows the original GitHub description
- **Install / Update / Uninstall** — one click, powered by the official `dsh plugin` profile mechanism (`pnpm` under the hood)
- **Monorepo-aware install** — repositories that bundle several plugins install correctly: a single-plugin repo installs silently, multi-plugin repos offer a plain-language picker
- **Installed detection** — marks plugins you already have, with version comparison and an **update badge** when a newer version is released
- **Cross-platform** — full Windows and Linux support (PowerShell / sh, curl / wget, system-proxy aware)
- **Network auto-adaptation** — inherits your VPN/system proxy for fetching and installing; if GitHub is unreachable, requests automatically fall back to `gh-proxy.com` and recover. **Works without a VPN**: proxy → direct → mirror → built-in fetch fallback
- **One-click enable/disable** — toggle plugins right on the card (official core and the market itself are protected)
- **Pre-install conflict gate + 🩺 health check** — blocking two marketplaces at once, official-package hijack, duplicate patch rows / registered names; one-click health report on conflicts and dependency issues
- **Pre-install health + security scan** — every candidate is checked before install (entry files, build artifacts, dependency style, network destinations, OS support); the security scan catches obfuscation/credential theft/exfiltration but only warns (no false positives); objective issues (missing entries, unsupported OS) are blocked
- **One-click check + repair** — detects network/pnpm/entry/OS/past-error problems in one click, auto-fixes what it can (installs pnpm, enables plugins, fills deps), and explains the rest
- **Safe by default** — install/uninstall/toggle roll back automatically on failure; a last-known-good backup restores a broken profile with one command
- **Live progress bar** — install/update/uninstall show a bar right on the card (percent + live counts); progress survives leaving and re-entering the market
- **One-click star** — reuses your local git credentials to star repos; badge color legend, auto-fading notices
- **Self-update** — a button appears beside the title when a newer version of the marketplace itself is available

## Installation

### From GitHub (recommended, after release)

```sh
dsh plugin --profile web add github:mishibeikejie/zat-dsh-engine
```

### From China without a VPN (via the domestic mirror, verified)

```sh
dsh plugin --profile web add https://gh-proxy.com/https://github.com/mishibeikejie/zat-dsh-engine.git
```

Either command installs the same plugin. Once installed, the market's own search and install paths carry the mirror fallback, so networking is handled for you.

### From a local checkout

```sh
git clone https://github.com/mishibeikejie/zat-dsh-engine.git
dsh plugin --profile web add ./zat-dsh-engine
```

### From npm (if published later)

```sh
dsh plugin --profile web add zat-dsh-engine
```

Replace `web` with your profile name if you use a different one (`headless` etc.).

> Requirements: a working dsh installation, `pnpm` and `curl` on PATH, and a profile that has been initialized (`dsh plugin --profile web add` creates it on first use).

## Usage

1. Restart dsh after installing.
2. Open the web GUI → **Settings → Plugins**.
3. Click the **🛒 Plugin Market** tab on the right of the plugin list.
4. Browse, search, filter by category or install state, and click **Install** on any card.
5. Restart dsh to activate installed plugins.

## Update

```sh
dsh plugin --profile web add github:mishibeikejie/zat-dsh-engine
```

Re-running `add` updates to the latest commit. The marketplace also detects its own updates and shows an **Update** button beside the title.

## Uninstall

```sh
dsh plugin --profile web remove zat-dsh-engine
```

## FAQ

**The market shows at most 1000 plugins in the All view.** GitHub's search API caps any query at 1000 results. Search and category filters reach every plugin regardless.

**Why do I need a model for Chinese intros?** 999 intros ship with the plugin. Only plugins released after the snapshot are translated on the fly, using the model you selected in dsh.

**Is the mirror safe?** The mirror is only used when a direct GitHub request fails, and only for public repository metadata.

**dsh won't start after installing a plugin — how do I recover?** After every successful install/uninstall/toggle, the market backs up the last known-good state into the `zat-backup/` folder inside your profile directory. Restore it by copying the three files back over the profile directory.

In the commands below, `web` is your profile name: **everyone using the web GUI has the profile `web`** (unless you started dsh with a custom name — if unsure, open the market and look at the "Profile:" line in the footer; use whatever it says):

```sh
# Windows (PowerShell)
Copy-Item "$HOME\.dsh\profiles\web\zat-backup\*" "$HOME\.dsh\profiles\web\" -Force

# macOS / Linux
cp ~/.dsh/profiles/web/zat-backup/* ~/.dsh/profiles/web/
```

Then start dsh again. This restores the state right after the last successful operation, so the plugin that broke startup is removed from the enabled list and the profile boots normally.

**Can I install two marketplace plugins at once?** No — the install gate blocks it: two market/manager plugins register the same settings pages and services, which can take dsh down. Uninstall the current one first if you want to switch.

## Permissions & trust (security-review perspective)

This marketplace is at heart a **package manager**, and that job itself requires strong capabilities. A security review will always see the behaviors below — here is what each one is for and where its boundaries are:

- **Running shell commands**: install/update/uninstall means running pnpm. The market only runs the pnpm/curl/wget/powershell commands it assembles itself; during install, pnpm runs the plugin's own prepare/postinstall scripts (standard behavior for every package manager) — the market scans those scripts first and warns ahead of time about network downloads or high-risk patterns.
- **Reading git credentials**: used in exactly two places — starring a repo and the "set GitHub token" feature. Credentials only go to api.github.com; they are never written to disk, logged, or sent anywhere else.
- **The gh-proxy.com mirror**: only as a fallback when a direct GitHub request fails, and only for public repository metadata. A plugin's own network behavior after install has nothing to do with the mirror.
- **Reading/writing profile files**: install/uninstall/toggle must edit the profile's package.json etc. Every change is backed up to `zat-backup/` first, and failed operations restore automatically.
- **Pre-install health + security scan**: every candidate and every installed plugin is scanned for structural, dependency, and security patterns (obfuscation, credential theft, suspicious exfiltration, system modification), with all network destinations listed before install; security findings only warn (never block), while objective issues like missing entries or unsupported OS are blocked.

Each of these is the minimal permission set required for the market to work; if a review questions a specific behavior, this section is the reference.

## Changelog

### v0.5.0

- One-click check + repair: real detection (network/pnpm/entry files/OS support/past errors), auto-fixes what it can (installs pnpm, enables plugins, fills missing deps), and explains the rest clearly
- System compatibility: cards show "supported systems" (Windows/macOS/Linux); unsupported plugins are blocked before install
- Category search fixed (no more 422) + search-term hardening (OR/symbols/Chinese all work) + auto mirror on rate limit
- Install/update now falls back to two mirrors (gh-proxy + ghfast), so it works without a VPN; triple-retry updates, no more false downgrade prompts
- Security scan only warns (no false positives, notification plugins no longer flagged); every error is now one line: what went wrong + how to fix
- npm/locally-installed plugins are visible, manageable, update-checkable (via the npm registry) and updatable in "Installed"; install and detail show "how to use"

### v0.4.4

- Fix: no more automatic GitHub login popup when you're not signed in; starring no longer forces a login redirect
- Fix: installing a plugin now falls back to the domestic mirror when direct GitHub fails, so it works without a VPN; a missing pnpm now yields a clear error
- New: the Sessions page is now two columns — the right "Archived" column lists archived sessions separately, deletable directly
- Fix: plugins installed from npm/locally (no repo address) now appear in "Installed" and can be uninstalled/toggled
- Fix: installing a plugin whose entry files are missing (uncommitted build artifacts) is now blocked up front instead of failing in pnpm
- New: cards show "supported systems" (Windows/macOS/Linux), auto-detected for new plugins; plugins that don't support the current OS are blocked in the health check and install gate

### v0.4.3

- New: say what you need in any chat and the AI finds plugins, with a pre-install health + security scan per candidate
- The scan catches missing files, bad deps, credential theft, suspicious exfiltration — ❌ ones can't install
- Fix: no more "update to an older version" prompts

### v0.4.2

- Fix: health check falsely reported "multiple marketplace plugins" (aliased entries counted twice)
- Fix: install/update auto-discovers pnpm (nvm, corepack and npm-global installs all work)
- Update summary wraps instead of overflowing

### v0.4.1

- New "Sessions" section (right below Agent Presets in Settings): lists every session with its title, one-click permanent delete, running/subagent sessions protected
- Fix: searching Chinese or special characters returned 400
- Fix: the update button gave no feedback — now a live progress bar with a completion notice
- Fix: deleted sessions left a stale "ungrouped" entry in the sidebar

### v0.4.0

- Enable/disable plugins in one click, right on the card (official core and the market itself are protected)
- Pre-install conflict gate (market-vs-market, official-package hijack, duplicate patch rows / registered names) + one-click health check
- Auto-rollback on install/uninstall/toggle; last-known-good backup restores a broken profile with one command
- Live progress bar on the card (percent + live pnpm counts) that survives leaving and re-entering the market
- Works without a VPN: system proxy → direct → China mirror → built-in fetch fallback; mirror ≈7 MB/s
- Installed/installable filters served in one shot; paged results deduped
- One-click star, badge color legend, auto-fading notices

## Sponsor

If Zat-DSH Engine saves you time, consider supporting the author:

- GitHub Sponsors: <https://github.com/sponsors/mishibeikejie>

Every bit of support keeps the catalog data, translations and feature updates coming.

## License

[MIT](LICENSE)

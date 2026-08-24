<div align="center">

<p><a href="README.md">中文</a> | <a href="README.en.md">English</a></p>

<h1>Deepseek Harness EAC — Embracing All Creation</h1>

<p><strong>EAC = Embracing All Creation (揽尽万象)</strong></p>

<p>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC"><img src="https://img.shields.io/github/stars/zouyuxuan122/Deepseek-Harness-EAC?style=flat&label=%E2%AD%90&color=08C" alt="GitHub stars"></a>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases"><img src="https://img.shields.io/badge/Windows-10%2F11-4493F8?style=flat" alt="Windows"></a>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/tag/v4.4.0-linux"><img src="https://img.shields.io/badge/Linux-pacman%2Fdeb%2Frpm%2FAppImage-178600?style=flat" alt="Linux"></a>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC"><img src="https://img.shields.io/badge/Desktop-App-47848F?style=flat" alt="Desktop App"></a>
<a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
</p>

<p>A ready-to-use <strong>Windows and Linux desktop client</strong> built around the official <a href="https://github.com/deepseek-ai/deepseek-harness">deepseek-ai/deepseek-harness</a> (<code>@deepseek-ai/dsh</code>, the everything-is-a-plugin agent harness).
On top of the official foundation, EAC embraces community creations — skins, plugins, tools, memories, and more — all installable with one click.</p>

<p><a href="docs/screenshot-preview.jpg"><img src="docs/screenshot-preview.jpg" alt="Deepseek Harness EAC UI preview"></a></p>

</div>

---

## Table of Contents

- [Why EAC](#why-eac)
- [Quick Start](#quick-start)
- [Features](#features)
- [Community & Support](#community--support)
- [Developer Documentation](#developer-documentation)
- [Acknowledgements](#acknowledgements)
- [Star History](#star-history)
- [License](#license)

---

## Why EAC

| Area | Official DeepSeek Harness default experience | Deepseek Harness EAC enhancements |
| --- | --- | --- |
| Installation and launch | Requires a separately installed Node.js environment and CLI startup | Bundles Node.js, the npm CLI, and dsh; provides setup and portable builds that launch with a double-click |
| Desktop experience | Primarily used from a terminal or browser | Native desktop window, system tray, shortcut maintenance, process cleanup, and task notifications |
| CLI coexistence | CLI and Web normally use the same plugin environment | Uses a separate `web-desktop` profile while sharing sessions and API keys with the CLI, keeping plugins isolated |
| Plugin reliability | Plugins are generally installed through a package manager and troubleshot manually | Takes snapshots before installation and startup, with health checks, repair, retry, rollback, and incident reports |
| Interface customization | Uses the official interface by default | Includes 10 skins plus font, size, color, and mobile layout customization |
| Project tools | Relies on external editors and terminals | Includes a file tree, line-level diffs, one-click restore, persistent terminal, and HTML/local-port previews |
| Context and personas | `/compact` and persona files are managed manually | Supports automatic compaction, persona cards, and hot-reloading for `soul.md` |
| Models and MCP | Primarily managed through configuration files or the CLI | Provides visual configuration for vision models and MCP, plus imports from Claude Code and Codex |
| Plugin ecosystem | Plugins are installed through the CLI or package manager | Includes a plugin marketplace with search, one-click installation, removal, and management |
| Conversation efficiency | Uses the standard conversation workflow | Adds temporary side conversations, conversation-node navigation, and reasoning-effort controls for third-party models |
| Messaging integration | Does not include EAC messaging bridges by default | Connects to WeChat ClawBot / OpenClaw in one click |
| Updates and maintenance | Updated through a package manager or manually | Checks dsh agent and desktop-client updates separately, preserving or rolling back the previous version on failure |

> EAC does not modify the official dsh core, preserving its plugin architecture and official capabilities in full.
> It shares sessions and API keys from `DSH_HOME` by default while isolating the desktop plugin environment.

---

## Quick Start

### Requirements

- Windows 10/11 (x64)
- Linux x86_64 (Arch / Ubuntu / Debian / Fedora, or any distribution that supports AppImage)
- No pre-installed Node.js or other runtime required

### Windows

> The current full edition is v4.4.1 (Electron shell); the Lite edition below uses a Tauri (Rust) shell — smaller and faster to start. Download installers directly from Releases.

| File | Description | Size |
| --- | --- | --- |
| [Setup exe](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.1/Deepseek-Harness-EAC-Setup-v4.4.1-x64.exe) | Installs to the system and creates shortcuts | ~246 MB |
| [Portable exe](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.1/Deepseek-Harness-EAC-Portable-v4.4.1-x64.exe) | No installation required; a single file you can place anywhere | ~212 MB |
| [Lite setup](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.5-lite/Deepseek.Harness.EAC.v4Lite_4.5.0_x64-setup.exe) | **Lite edition** (lighter Tauri shell, independent of the full builds above and safe to run side by side): main executable `Deepseek Harness EAC v4Lite.exe`, data directory `~/.dsh-v4lite`, SHA256 checksum file included with the release | ~73 MB |

See the [Releases page](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases) for more versions.

> 💡 **Upgrading**: just download and run the newest installer above over your existing install.
> Plugins, skins, sessions and settings are preserved: data lives in
> `%APPDATA%\Deepseek Harness EAC\` and `~/.dsh`, untouched by the upgrade.

### Linux (x64)

Linux packaging was contributed by community developer [@Luoye-hb](https://github.com/Luoye-hb) in [PR #12](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/pull/12). The packages were released with [v4.4.0-linux](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/tag/v4.4.0-linux) and support **Arch / Ubuntu / Debian / Fedora**, plus a universal AppImage:

| Distribution | Package | Install command |
| --- | --- | --- |
| Arch Linux | [.pacman](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0-x64.pacman) | `sudo pacman -U ./Deepseek-Harness-EAC-4.4.0-x64.pacman` |
| Ubuntu / Debian | [.deb](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0-amd64.deb) | `sudo apt install ./Deepseek-Harness-EAC-4.4.0-amd64.deb` |
| Fedora | [.rpm](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0.x86_64.rpm) | `sudo dnf install ./Deepseek-Harness-EAC-4.4.0.x86_64.rpm` |
| Universal | [.AppImage](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4.0-linux/Deepseek-Harness-EAC-4.4.0-x86_64.AppImage) | Run directly after `chmod +x` |

> - Uninstall with `pacman -Rns dsh-desktop`, `apt remove dsh-desktop`, or `dnf remove dsh-desktop`.
> - Like the Windows build, Linux packages include Node.js and the npm CLI. No pre-installed Node.js is needed, and data continues to use `~/.dsh` (`DSH_HOME`).
> - Linux updates are managed by the system package manager rather than the in-app updater. To build it yourself, use the source code in the repository's root `linux` branch.

### First Run

1. Launch the app. After the startup animation, the DeepSeek Harness Web UI loads automatically in a native window and is accessible only through the local loopback interface.
2. If you have not configured an API key, open Settings and complete the setup before starting. The configuration is identical to the dsh CLI.
3. Common entry points: Settings → Skins (10 built-in skins) / Plugin Marketplace / one-click model selection; conversation area → Terminal / Files tabs.

### Data Directories

> Portable data is stored in `data\` next to the exe; the setup build uses `%APPDATA%\Deepseek Harness EAC\`.
> To override the dsh configuration directory, set the `DSH_HOME` environment variable before launch, just as you would with the dsh CLI.

### Updating

- **Desktop client**: checks upstream releases automatically after launch, with fallback release sources. After your approval, it downloads and installs the update. The portable build replaces itself and restarts; the setup build opens the new installer. The current version is preserved if the update fails.
- **Official agent (dsh)**: detects new `@deepseek-ai/dsh` versions and, after approval, installs them into a data-directory overlay with an atomic switch. If the new version fails to start, you can roll back to the bundled version in one click.
- You can also download and run the latest package above without losing data. Since v2.0, the installer closes running old and new instances before uninstalling, preventing the "Failed to uninstall old application files" error during an in-place upgrade.

---

## Features

### Out-of-the-box Desktop Experience

- **Bundled runtime**: includes Node.js, the npm CLI, `@deepseek-ai/dsh`, and official plugins, with no additional runtime installation required.
- **Setup and portable builds**: launch with a double-click and automatically select a free port; portable data stays with the application directory for easy migration.
- **Desktop integration**: provides a native window, system tray, shortcut maintenance, process cleanup, and task-completion notifications.
- **CLI coexistence**: shares sessions and API keys from `DSH_HOME` while using a separate `web-desktop` profile so desktop and CLI plugins do not interfere with each other.
- **Automatic updates**: updates the dsh agent and desktop client separately, preserving or restoring the previous version if installation fails.

### Development Workflow

- **File tree and previews**: browse project files and preview HTML files or local-port services inside the app.
- **Change tracking and restore**: inspect session file changes and line-level diffs, then restore individual files or all changes at once.
- **In-session terminal**: use persistent PowerShell in the project directory with streaming output, command history, and automatic reconnection.
- **Conversation navigation**: jump quickly between user messages.
- **Temporary conversations**: ask follow-up questions from the current context in a separate floating window without affecting the main conversation.

### Conversations & Models

- **Automatic compaction**: runs `/compact` as the context approaches its limit, with a configurable threshold and silent retry on failure.
- **Persona management**: includes six persona cards with save, apply, delete, live editing, and `soul.md` hot-reload support.
- **Image understanding**: uses `picturereader` to analyze local or online images and return the result directly to the conversation.
- **MCP and quick setup**: visually manages MCP and imports skills, MCP configuration, and memory from Claude Code or Codex.
- **Third-party model controls**: adjusts reasoning effort for supported third-party models.
- **DeepSeek balance**: displays the current-turn cost and account balance, with top-up access and automatic refresh.

### Plugins & Reliability

- **Unified plugin marketplace**: `dsh-unified-market` aggregates multiple plugin sources with search, one-click installation, and removal.
- **Plugin Protection Center**: `dsh-plugin-shield`, together with the built-in `plugin-guard` engine, provides snapshots, health checks, repair, retry, rollback, and incident reports.
- **Self-healing reliability**: automatically handles profile-module shadowing, plugin startup failures, and file-lock issues during service restarts.
- **Complete dependency distribution**: bundled plugins and their self-contained dependencies ship with the installer, reducing environment-specific failures.

### Interface & Integrations

- **Interface customization**: includes 10 community skins with mutually exclusive switching, one-click restoration of the native look, and font, size, and color settings.
- **Mobile layout support**: improves settings panels, dialogs, sidebars, and conversations on narrow screens.
- **WeChat ClawBot**: connects to WeChat ClawBot / OpenClaw through the bundled bridge plugin in one click.

---

## Community & Support

### Community Groups

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/qq-group-qrcode.jpg" alt="dsh EAC QQ Community Group 2 QR code" width="320" />
    </td>
    <td align="center" width="50%">
      <img src="docs/wechat-group-qrcode.jpg" alt="dsh EAC WeChat community group QR code" width="320" />
    </td>
  </tr>
  <tr>
    <td align="center"><strong>QQ Community Group 2</strong><br />Group number: 1021296425</td>
    <td align="center"><strong>WeChat Community Group</strong></td>
  </tr>
</table>

### Bug & Feature Requests

To report a bug or suggest a feature, visit [https://eac.dtyg123.dpdns.org/](https://eac.dtyg123.dpdns.org/).

---

## Developer Documentation

### Build from Source

```powershell
cd dsh-desktop
npm install
npm run fetch-runtime    # bundle node.exe + npm CLI
npm run dist             # build portable + NSIS installer -> dist/
```

> Behind a firewall? Use the Electron mirror `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` and the builder toolchain mirror `$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`.

Run tests:

```powershell
npm test                 # node --test test/*.test.mjs
```

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Electron shell (main.js)                                │
│  · Single-instance lock / window / menu / lifecycle      │
│  · Session watcher (session-watcher.js) → notifications  │
│  · Official updater (updater.js) → approved overlay      │
│  · Client updater (client-updater.js) → download/replace │
│  · Spawn node.exe from vendor|resources                  │
└──────────────┬───────────────────────────────────────────┘
               │  dsh web --host 127.0.0.1 --port 0
               ▼
       Bundled node.exe + @deepseek-ai/dsh
       Path resolution: user overlay > bundled package
       Prints "dsh web: http://127.0.0.1:<port>"
               │  Parse URL, poll HTTP 200
               ▼
       Native window loads Web UI (localhost only)
```

### Project Structure

```
dsh-desktop/                  # Electron desktop app
├── main.js                   # Electron main process
├── updater.js                # Official dsh agent updater
├── client-updater.js         # Desktop client updater
├── balance.js                # DeepSeek balance query
├── session-watcher.js        # Session completion watcher
├── plugin-guard.js           # Plugin protection engine: snapshots/rollback/checks/repair/guarded startup/reports
├── profile-module-heal.js    # Profile module shadowing repair: real directories + pnpm links
├── preload.js                # Sandbox preload
├── assets/                   # Loading/update pages, icons, skins, companion plugins
│   ├── skins/                # 10 built-in Web UI skins
│   └── plugins/              # Desktop companions: dsh-balance / dsh-file-changes / dsh-terminal
│                             # / dsh-easy-setup / dsh-skin-switch
│                             # Bundled community plugins: dsh-webui-market / dsh-tool-vision
│                             # / dsh-soul-md / dsh-web-mobile-fix
│                             # (vendor and self-contained runtime dependencies included in the repository)
├── scripts/                  # Build and development helper scripts
├── build/icon.png            # electron-builder icon
├── vendor/                   # Bundled node.exe / npm CLI (not committed)
├── electron-builder.yml      # Build configuration
└── dist/                     # Build output (not committed; published to Releases)
openclaw-dsh-bridge/          # WeChat bridge plugin (optional, research-grade)
research/                     # Third-party WeChat / bridge protocol research
```

---

## Acknowledgements

### Plugin Acknowledgements

| Plugin | Description |
| --- | --- |
| dsh-auto-compact | Automatically sends `/compact` as the context approaches its limit |
| @deepseek-ai/dsh-balance | Account balance, cost estimates, and pricing settings |
| dsh-better-sidebar (provider: omdsh-dev) | VS Code-style right sidebar with Explorer, editor, terminal, Git, and browser views |
| dsh-change-review | AI change review for automatically rechecking file modifications |
| @deepseek-ai/dsh-client-file-changes | Files view with session change tracking and one-click restore |
| dsh-compact | Request-path context compaction and overflow recovery |
| @deepseek-ai/dsh-conversation-tweaks | Collapses long output and adds a right-side conversation navigation rail |
| dsh-dafeiyu (provider: QCYTSN) | Dafeiyu desktop companion |
| dsh-deep-whale (provider: Small-tailqwq) | Source of the Deep-Sea Maid Workshop `maid-atelier` skin |
| dsh-dock-settings | Skills and MCP settings management |
| @deepseek-ai/dsh-easy-setup | Quick setup for vision models, `soul.md`, and migration |
| @deepseek-ai/dsh-file-changes | Session file-change projection |
| dsh-file-drop-eac | Drag files or folders into a conversation |
| @deepseek-ai/dsh-float-window | Opens a conversation in a separate window |
| dsh-font-custom | Custom fonts plus text and code colors |
| dsh-image-paste | Paste and send clipboard images |
| dsh-message-rewind | Rewrite a message and regenerate from that point |
| @vlln/dsh-navbar (provider: vlln) | Conversation-node navigation bar for jumping between user messages |
| dsh-offpeak (provider: christophersmith2737-commits) | DeepSeek peak/off-peak pricing reminder and interception |
| @deepseek-ai/dsh-openclaw-bridge | WeChat ClawBot / OpenClaw bridge |
| dsh-pet (provider: PC2005-cloud) | Floating desktop pet for the page |
| dsh-pet-settings | Desktop pet settings section |
| dsh-plugin-guard (provider: lxzy-7) | Pre-install snapshots, rollback, and guarded startup |
| dsh-plugin-healthcheck (provider: chenw2759-wq) | Static plugin health checks and risk inspection |
| @deepseek-ai/dsh-plugin-manager | Lists and enables or disables bundled plugins |
| dsh-plugin-shield | Plugin protection with snapshots, rollback, and health checks |
| dsh-plugin-wizard | Plugin selection wizard |
| @deepseek-ai/dsh-prompt-custom | Custom core prompts |
| dsh-session-manager | Session deletion and archive management |
| dsh-settings-groups | Collapsible advanced options on the Settings page |
| dsh-settings-nav-custom | Customization for the Settings sidebar |
| dsh-settings-scroll-fix | Mouse-wheel and overflow scrolling repair for Settings |
| @dsh-external/dsh-side-session (provider: dsh-external) | Temporary side conversations that do not affect the main conversation |
| @deepseek-ai/dsh-skin-switch | Built-in skin switching |
| dsh-soul-md (provider: Scorp1o117) | `soul.md` persona-card injection |
| @deepseek-ai/dsh-terminal | Interactive command line inside a conversation |
| @deepseek-ai/dsh-third-party-thinking | Reasoning-effort controls for third-party models |
| dsh-tool-vision (provider: Scorp1o117) | Image analysis through OpenAI-compatible vision models |
| dsh-undo-savepoint | Configuration snapshots and undo/rollback |
| dsh-unified-market | Unified plugin marketplace aggregating three sources |
| dsh-web-plugin-manager (provider: LX2000WASD) | Entry point for guarded plugin installation and health checks |
| dsh-web-mobile-fix (provider: AcidGr) | Mobile layout fixes |
| dsh-web-ui (provider: zhu1090093659) | Source of nine built-in Web UI skins |
| dsh-webui-market (provider: Sanqi-normal) | Community plugin directory with one-click installation and removal |
| picturereader | Unified image-understanding plugin |

Thank you to every plugin provider for contributing to this project and the open-source community. With so many plugins, we may not have identified every plugin and source individually. If you recognize your work here, please let us know so we can add it to the acknowledgements. You are also welcome to join our community groups to exchange ideas and help the ecosystem grow.

### Skin Sources & Licenses

The Settings page includes 10 Web UI skins and keeps the native appearance by default. Enabling one skin automatically disables the others, and the default look can be restored in one click. Complete source, author, and license information ships with the installer.

Nine skins come from the community project [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) under BSD-3-Clause. `maid-atelier` comes from [dsh-deep-whale / Deep-Sea Maid Workshop](https://github.com/Small-tailqwq/dsh-deep-whale) under CC BY-NC-SA 4.0 and may not be used commercially.

| Skin | Source | License |
| --- | --- | --- |
| xp (Windows XP style) | [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) | BSD-3-Clause |
| qq98 (classic QQ 98 style) | Same as above | BSD-3-Clause |
| ths (Tonghuashun style) | Same as above | BSD-3-Clause |
| blue-fantasy | Same as above | BSD-3-Clause |
| dragon-heir | Same as above | BSD-3-Clause |
| minecraft | Same as above | BSD-3-Clause |
| trading | Same as above | BSD-3-Clause |
| whale-song | Same as above | BSD-3-Clause |
| miku (Hatsune Miku) | Same as above | BSD-3-Clause |
| maid-atelier (Deep-Sea Maid Workshop) | [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) | **CC BY-NC-SA 4.0** (non-commercial) |

### Contributors

Thanks to every contributor:

<p align="center">
  <a href="https://github.com/zouyuxuan122/Deepseek-Harness-EAC/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=zouyuxuan122/Deepseek-Harness-EAC" />
  </a>
</p>

---

## Star History

<a href="https://www.star-history.com/?repos=zouyuxuan122%2FDeepseek-Harness-EAC&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=zouyuxuan122/Deepseek-Harness-EAC&type=date&theme=dark&legend=bottom-right&sealed_token=5SkHr7TORH0WuK6eeH5IP-Q2hISGL0m3EDvMKDG6hAUNQssgWBUixIuZWP_ygvty93H_loEZ8JUEgXKy8xGAuH4-mq_DTlClZbM_mOYiomJbfc3zANNWFg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=zouyuxuan122/Deepseek-Harness-EAC&type=date&legend=bottom-right&sealed_token=5SkHr7TORH0WuK6eeH5IP-Q2hISGL0m3EDvMKDG6hAUNQssgWBUixIuZWP_ygvty93H_loEZ8JUEgXKy8xGAuH4-mq_DTlClZbM_mOYiomJbfc3zANNWFg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=zouyuxuan122/Deepseek-Harness-EAC&type=date&legend=bottom-right&sealed_token=5SkHr7TORH0WuK6eeH5IP-Q2hISGL0m3EDvMKDG6hAUNQssgWBUixIuZWP_ygvty93H_loEZ8JUEgXKy8xGAuH4-mq_DTlClZbM_mOYiomJbfc3zANNWFg" />
 </picture>
</a>

---

## License

MIT. Based on [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT). Built-in skins remain the property of their original authors; see the skin license table above.

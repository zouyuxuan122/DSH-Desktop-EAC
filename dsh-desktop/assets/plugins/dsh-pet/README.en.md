# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=monthly&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=total&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

> A floating desktop pet for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI: idle breathing, random actions (including dozing off), occasional turns, screen wandering, click reactions, and draggable.

---

## 🚀 Quick Start (Install the Plugin)

```sh
dsh plugin --profile web add dsh-pet
```

Restart `dsh web` and the pet appears in the bottom-right corner — all transparent animations, ready to use out of the box, no generation pipeline required.

> 💡 Want to craft your own one-of-a-kind pet? Clone [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) and use the bundled asset pipeline (AI prompts → green-screen video → transparent animation, generated with Doubao) to generate one from scratch — fully reproducible.

## ✨ Features

- **A pure pet, nothing else**: no business features — no weather, no monitoring, no agent-state sensing; just a companion. Zero core changes, zero model cost (no LLM/API calls at runtime)
- **Hand-drawn style transparent animations**: idle breathing, dozing off, playing with a Rubik's cube, humming, hair-raising, blowing bubbles, playing with a water gun, playing violin, the whale emerging, eating rice, looking in the mirror, three dances, writing code, seasonal actions (kite flying, snowman building, ice cream eating, fireworks…) — all seamlessly chained
- **Never-ending animation chain**: when each animation finishes, the next one is picked instantly by probability (30% idle / 10% turn / 40% action / 20% move)
- **Screen wandering**: walks toward its facing direction, checks the space ahead and never walks off screen
- **Click / drag**: click triggers a random reaction animation (happy / shy / tsundere); drag it anywhere
- **Left/right facing**: all animations are CSS-mirrored, the pet can face left or right
- **Ground alignment**: animations share a unified foot line, the pet always stands on the "ground"
- **Smooth transitions**: double-buffered video cross-fade, zero blank frames between switches
- **Accessibility-friendly**: supports `prefers-reduced-motion`

## ⚙️ Configuration

| Key        | Description                                   | Current status                                                                        |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `size`     | Stage width (px); pet height ≈ width×9/16×74% | Default 462 (≈260px tall); editable per pet via the settings page (applies instantly) |
| `position` | Default corner position                       | Defaults to bottom-right; editable per pet via the settings page (applies instantly)  |

> Note: the plugin works out of the box; all config above is optional. Settings-page edits are saved to `$DSH_HOME/dsh-pet/main-config.json` (user layer, takes precedence over the packaged defaults).
> ⚠️ The legacy paths `$DSH_HOME/pet-config.json` / `$DSH_HOME/pet-assets` (pre-v0.1.6) are no longer read — migrate manually after upgrading.

### 📄 Advanced customization (edit config files directly)

All user data lives under `$DSH_HOME/dsh-pet/` (one directory per plugin; future character packs follow the same pattern with their own plugin id):

| Layer                      | Path                                 | Purpose                                                                                                                 |
| -------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Default config (read-only) | `assets/config.jsonc` in the package | Complete reference: pet list / animation pools (idle/turn/drag/clicks/moves/categories) / playback weights              |
| User config                | `$DSH_HOME/dsh-pet/main-config.json` | Override fragment: optionally override `pets` / `animations` / `animationWeights`; missing fields fall back to defaults |
| User animations (optional) | `$DSH_HOME/dsh-pet/main-animation/`  | Drop `.webm` files here to make them playable — **takes precedence over the packaged assets**                           |

- The settings page shows these paths at the bottom
- Custom animations: put `xxx.webm` into `main-animation/`, name it in an animation pool/category as `"xxx"`, then **refresh the page** (no DSH restart needed)
- Format: `.webm` only; **transparent animations require VP9 Alpha encoding** (same spec as the packaged assets — plain webm will show a black background)
- After editing the user config, **refresh the page** to apply
- Fill animation names by referring to the default config to avoid referencing missing animations

## 🗑️ Uninstall

```sh
dsh plugin --profile web remove dsh-pet
```

## 🖥️ Running Screenshots

What the pet looks like running inside the DSH Web UI:

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet running in DSH Web UI 1" title="dsh-pet running in DSH Web UI 1">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet running in DSH Web UI 2" title="dsh-pet running in DSH Web UI 2">
</p>

## 🎬 Animation Previews

> The animations have transparent backgrounds; in these GIF previews the transparent areas show the page background color, while the actual playback (webm) is transparent.

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="Idle breathing & chill" title="Idle breathing & chill">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="Looking around" title="Looking around">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="Floating in place" title="Floating in place">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="Napping" title="Napping">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="Click response - happy bounce" title="Click response - happy bounce">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="Dragged by the mouse" title="Dragged by the mouse">
</p>

All animations live in the repo under `dsh-pet/assets/thumb/`.

## 📚 A Complete Project (More Than a Plugin)

This is a **complete three-piece project** — anyone can clone the repo and generate their own desktop pet from scratch:

```
① Prompts (recipe)      →  ② Asset pipeline (engine)  →  ③ Plugin (product)
AI animation prompts        source video → transparent       the pet running in DSH
```

- Repository: [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
- Design & implementation docs: [DESIGN.md](https://github.com/PC2005-cloud/dsh-pet/blob/master/DESIGN.md)

## 🔎 Discover More DSH Plugins

- Community plugin catalog: [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)
- DSH official repository: [deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)

## 📄 License

- Code: MIT
- Assets (animations/prompts/source videos): open-source use permitted, **no commercial use**

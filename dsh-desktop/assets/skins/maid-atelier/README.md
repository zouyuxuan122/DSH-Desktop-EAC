# Deep Whale Day & Night Theme · 鲸鱼娘昼夜工坊

> **EAC integration:** This copy is adapted for Deepseek Harness EAC's built-in
> skin manager. In EAC, enable it from **设置 → 皮肤 (Settings → Skins)**. The
> upstream install commands below (`dsh plugin --profile web add ...`) are for
> the official Harness CLI and are **not** the way to install it inside EAC.


> **Non-commercial / 禁止商用：** This project is released under CC BY-NC-SA 4.0. Personal and other non-commercial use is permitted with attribution; commercial use is prohibited, and adaptations must use the same license. 本项目采用 CC BY-NC-SA 4.0，允许保留署名的个人及其他非商业使用，禁止商业使用，衍生作品必须以相同许可证共享。

A complete day/night character UI skin for the DeepSeek Harness Web GUI. It replaces only the presentation layer: the native theme service switches the full scene, character, companion, controls, ornaments, and lightweight atmosphere without reading or changing sessions, model requests, or workspace data.

面向 DeepSeek Harness Web GUI 的完整鲸鱼娘昼夜主题。它只修改展示层：原生主题服务会同步切换场景、角色、侧栏宠物、控件、花边与轻量动态特效，不读取或更改会话、模型请求和工作区数据。

## Screenshots · 主题截图

| Day · 白昼 | Night · 黑夜 |
| --- | --- |
| ![Deep Whale day theme](screenshots/day.png) | ![Deep Whale night theme](screenshots/night.png) |

## v0.1.10 update · v0.1.10 更新

- The full background viewport border has been removed: no corner ornaments, perimeter pearl rails, or top/bottom whale crests remain around the room scene. / 已移除完整背景视口边框：房间场景四周不再显示角花、珍珠连接线或顶部/底部鲸鱼徽章。
- The clean day/night character scenes remain unchanged, while the composer crown, sidebar ornaments, chibi companion, and atmosphere effects are preserved. / 干净的昼夜角色场景保持不变，同时保留输入框顶饰、侧栏装饰、Q 版角色和环境动态特效。
- Browser zoom now affects only the native Harness layout and scene cropping; there is no viewport-decoration layer to stretch, clip, or misalign. / 浏览器缩放现在只影响 Harness 原生布局与场景裁切，不再存在可能被拉长、裁切或错位的视口装饰层。

## Features · 功能

- Complete crystal-workshop day scene and moon-tide observatory night scene with independent palettes, system title colors, character plates, and transparent chibi companions. / 完整的白昼水晶工坊与夜晚月潮观测室，分别使用独立色板、系统标题栏颜色、角色图和透明 Q 版侧栏宠物。
- Full component coverage for new sessions, workspace trees, session lists, chat cards, context injection, thinking rows, composer, model and permission menus, settings, tools, Todo, terminal, title bar, and collapsed sidebar. / 覆盖新建会话、工作区树、会话列表、聊天卡片、上下文注入、思考行、输入框、模型与权限菜单、设置、工具、Todo、终端、标题栏和折叠侧栏。
- Composer crown rails, sidebar ribbons, nine-slice component frames, and workspace ornaments retain their source proportions without adding a frame around the full viewport. / 输入框顶饰、侧栏飘带、组件九宫格边框和工作区装饰均保持源图比例，同时不再包围整个视口。
- The composer crown is separated from the content background; its outer tips align with the top border while the center emblem spans the rim without blocking native controls. / 输入框顶饰与内容背景分离，两侧尖角对齐顶部边框，中央徽章跨坐边线且不遮挡原生控件。
- Deterministic atmosphere with 24 staggered rising bubbles by day and 24 slowly drifting stars by night; `prefers-reduced-motion` disables the loops. / 白昼使用 24 个错峰上浮气泡，夜晚使用 24 个缓慢漂移星点；`prefers-reduced-motion` 会停用循环动画。
- All runtime artwork is embedded into the client bundle as data URIs, so the installed skin requires no remote asset service. / 所有运行时素材均以内嵌 data URI 进入客户端 bundle，安装后的主题不依赖远程素材服务。

## Requirements · 使用条件

- A working DeepSeek Harness checkout with the Web GUI profile.
- `dsh` available on the command line for plugin installation.
- Node.js and pnpm are required only when rebuilding or running tests from source.

## Install from the Release ZIP · 从 Release 安装

1. Download `deep-whale-day-night-theme-v0.1.10.zip` and `SHA256SUMS.txt` from the [v0.1.10 release](https://github.com/GGBond2424648901/deep-whale-day-night-theme/releases/tag/v0.1.10).
2. Verify the ZIP SHA-256 against `SHA256SUMS.txt`, then extract it to a permanent directory.
3. From the Harness checkout, add the extracted theme package:

```sh
dsh plugin --profile web add /absolute/path/to/deep-whale-day-night-theme-v0.1.10
```

## Install from Source · 从源码安装

```sh
git clone https://github.com/GGBond2424648901/deep-whale-day-night-theme.git
cd <harness>
dsh plugin --profile web add /absolute/path/to/deep-whale-day-night-theme
```

The plugin activates when loaded and restores every CSS, DOM, page-title, and system-color change when unloaded. It remains compatible with mutually exclusive switching through the Harness skin center; its wiring ID is `ui-skin-maid-atelier`.

插件加载后立即生效，卸载时会还原全部 CSS、DOM、页面标题和系统颜色写入。它兼容 Harness 皮肤中心的互斥切换，wiring ID 为 `ui-skin-maid-atelier`。

## Theme Plugins manager compatibility · 主题插件管理器兼容性

Official Harness compositions register Deep Whale as a lifecycle-owned builtin adapter in **Settings → Theme Plugins**. The card shows the day/night cover, complete bilingual description, version, author, source, and the prominent **CC BY-NC-SA 4.0 — personal and non-commercial use only** notice. Selecting another card completely disposes Deep Whale's scene, ornaments, companions, animations, observers, timers, favicon, title, and system-color effects; selecting Deep Whale again restores the full interface.

官方 Harness 组合会把 Deep Whale 注册为**设置 → 主题插件**中的生命周期托管内置适配器。卡片会显示昼夜封面、完整中英说明、版本、作者、来源，以及醒目的 **CC BY-NC-SA 4.0——仅限个人及其他非商业用途，禁止商用**提示。切换到其他卡片时会完整清理 Deep Whale 的场景、装饰、宠物、动画、观察器、计时器、favicon、标题和系统颜色副作用；再次选择即可恢复整套界面。

The standalone Release ZIP is the complete behavioral plugin and therefore contains reviewed JavaScript. The Theme Plugins manager's **local ZIP** and **public GitHub URL** import entries intentionally accept declarative, data-only theme ZIPs and never execute JavaScript. In official builds, install Deep Whale through its builtin card; use the import entries for compatible declarative themes such as the Harness Aurora Glass example.

独立 Release ZIP 是包含完整行为的插件，因此含有经过审查的 JavaScript。主题插件管理器的**本地 ZIP**和**公开 GitHub 链接**导入入口只接受声明式纯数据主题包，绝不执行 JavaScript。官方构建中请通过 Deep Whale 内置卡片启用本主题；导入入口用于 Harness Aurora Glass 示例一类兼容的声明式主题。

## Day and Night Switching · 昼夜切换

Use the native top-right theme control. Day mode applies pearl white, ice blue, sapphire text, champagne-gold edges, rising bubbles, and the crystal scene. Night mode applies deep-sea blue, cobalt glass, moon-silver text, warm-gold edges, drifting stars, and the observatory scene. View Transition provides the circular reveal where supported, with a short fade fallback elsewhere.

使用右上角原生主题按钮切换。白昼模式采用珍珠白、冰蓝、蓝宝石文字、香槟金细边、上浮气泡和水晶场景；夜晚模式采用深海蓝、钴蓝玻璃、月银文字、暖金细边、漂移星点和观测室场景。支持 View Transition 时使用圆形揭幕，不支持时自动退化为短淡入。

## Development · 开发

```sh
pnpm install
pnpm run embed:assets
pnpm run typecheck
pnpm run test
pnpm run build
```

`assets/` contains editable scene, character, companion, composer, trim, and component artwork. The runtime defaults are the full-scale white-dress V3 day scene with a less-negative horizontal offset and the matched-height, left-safe V5 night scene with its restrained shy blush and reddish-pink lips; `deep-whale-day-scene-v3.webp`, `deep-whale-night-scene-v3.webp`, `deep-whale-night-scene-v4.webp`, and the earlier variants remain included as alternate source artwork. `scripts/embed-deep-whale-art.mjs` generates `src/client/deep-whale-art.generated.ts`; `src/client/ornament-art.ts` owns the non-distorting vector rails; and `lib/` contains the committed prebuilt package.

`assets/` 保存可编辑的场景、角色、宠物、输入框、花边与组件素材。`scripts/embed-deep-whale-art.mjs` 生成 `src/client/deep-whale-art.generated.ts`，`src/client/ornament-art.ts` 负责不变形的矢量长轨，`lib/` 保存已提交的预编译包。

## Repository Layout · 目录结构

```text
assets/       Editable day/night artwork and generated UI slices
lib/          Prebuilt installable JavaScript
preview/      Compact light and dark previews
screenshots/  Full-page day and night captures
scripts/      Artwork embedding and build helpers
src/          TypeScript source and client skin
tests/        UI, asset, behavior, and distribution contracts
```

## Compatibility · 兼容性

The skin targets the DeepSeek Harness Web GUI and peers with `@deepseek-ai/cordis` and `@deepseek-ai/dsh-client-ui-theme`. It keeps native controls, accessibility attributes, keyboard focus, menus, dialogs, and upstream auto-grow behavior; the skin is not a replacement for Harness itself.

本主题面向 DeepSeek Harness Web GUI，并以 `@deepseek-ai/cordis` 和 `@deepseek-ai/dsh-client-ui-theme` 为 peer dependencies。它保留原生控件、无障碍属性、键盘焦点、菜单、对话框和上游自动增高行为，不包含 Harness 主程序。

## Attribution and License · 署名与许可

This repository is distributed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International**. The controlling terms are in [LICENSE](LICENSE); the complete three-stage creator and generation attribution chain is in [NOTICE](NOTICE).

本仓库以 **知识共享署名-非商业性使用-相同方式共享 4.0 国际许可协议**发布。完整法律条款见 [LICENSE](LICENSE)，三阶段创作者与生成过程署名链见 [NOTICE](NOTICE)。

Original character creator: **上善** ([Pixiv](https://www.pixiv.net/users/62155430)). Secondary DeepSeek maid redesign: **zipzip** ([Pixiv](https://www.pixiv.net/users/18604994)). Theme adaptation and UI preparation: **Small-tailqwq**.

DeepSeek and related names or logos are the property of their respective owners. This fan-made non-commercial project does not imply official endorsement or affiliation.

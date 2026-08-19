# dsh-skin

**Custom Skin for DeepSeek Harness Web** —— 为 DeepSeek Harness 网页版定制外观的开源插件。

不改布局，只改控件外观：内置极简主题、主色、文字色、区域文字色、图片 / GIF / 视频换肤、每个背景独立不透明度、可保存的命名预设。所有设置自动持久化，重启后自加载。

## 预览

![高自定义静态版界面](images/preview-static.jpg)

![视频背景版界面](images/preview-video-bg.jpg)

| 外观皮肤面板 | 外观皮肤面板（更多设置） |
| --- | --- |
| ![外观皮肤面板](images/panel-1.jpg) | ![外观皮肤面板更多设置](images/panel-2.jpg) |

## 功能

- **主题**：极简浅色 / 极简深色
- **主色**：一个主色，自动派生按钮、激活态、运行中等强调色
- **文字颜色**：全局文字色（深浅自动适配）+ 工作区 / 输出界面 / 输入框 三处区域文字色
- **图片换肤**（5 个槽位，每个可上传或填 URL，可独立调不透明度）：
  - 全局背景图
  - 侧栏纹理
  - 聊天区纹理
  - 输入框卡片
  - 输入气泡
- **动图与视频**：支持 GIF（动图）与视频；视频自动静音循环播放
- **预设**：保存当前全套配置，自定义命名、不限数量，可应用 / 删除
- **持久化**：设置自动保存到 `~/.dsh/dsh-skin-state.json`，重启 Harness 后自动恢复

## 上传与大小限制

| 类型 | 大小上限 | 说明 |
| --- | --- | --- |
| 图片（PNG / JPG / WebP / GIF 等） | **30 MB** | 上传后以 base64 存入本地配置，会占用配置体积 |
| 视频（MP4 / WebM / OGG / MOV 等） | **100 MB** | 上传走浏览器本地对象 URL，**不占配置体积**，但重启后需重新上传；要长期保留请用 URL 地址 |
| URL 地址（图片 / GIF / 视频） | 无大小限制 | 填 `http(s)://` 或 `data:` 开头的地址直接加载，不占本地配置 |

> 建议：大体积背景优先用「url地址」加载；上传的图片会随每次改动一并保存，图片过大可能导致保存 / 加载变慢。

## 兼容性

- 目标版本：**dsh `0.1.0-rc.6`**（web profile）
- 主题配色 / 文字色 / 预设依赖 `--dsw-*` CSS 变量，**跨版本基本可用**
- 图片 / 视频换肤的定位依赖当前版本的 DOM 类名（`SLOT_SELECTORS` / `VIDEO_TARGET`），**版本敏感**；若换肤不生效，请在 `packages/dsh-skin/lib/client.js` 顶部调整这些选择器

## 安装

前置：已安装 DeepSeek Harness（web profile）、git、node、pnpm。

> **clone 位置不限**：在任意目录（桌面、Downloads 等）执行下面的命令即可，脚本会自动把插件安装到 profile 目录 `~/.dsh/profiles/web`，无需手动放进 `.dsh`。

### Windows

```powershell
git clone https://github.com/wei-806206088/dsh-skin.git
cd dsh-skin
.\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/wei-806206088/dsh-skin.git
cd dsh-skin
chmod +x install.sh
./install.sh
```

脚本会自动：复制插件、注册到 profile、声明 workspace 依赖、启用 `packages/*` 工作区、运行 `pnpm install`，并在修改前备份原文件为 `*.dsh-skin.bak`（幂等，可重复运行）。

安装完成后**重启 DeepSeek Harness**，右下角出现调色盘按钮即为成功。装完后 clone 目录可删（插件已复制进 profile）；保留则便于以后 `git pull` 后重跑脚本升级。

> 默认安装到 `~/.dsh/profiles/web`。若你的 profile 目录不同，可用 `-ProfileDir`（PowerShell）或第一个参数（bash）指定实际路径。

## 使用

1. 点击右下角调色盘按钮打开「外观皮肤」面板；
2. 选择主题（极简浅色 / 极简深色），再调整主色、文字色、区域文字色；
3. 图片换肤：每个槽位可「上传」或填「url地址」加载图片 / GIF / 视频，用滑杆调各自的不透明度；
4. 满意后可在「预设」中命名保存，随时切换；
5. 「恢复」可一键「恢复到官方默认」或「恢复到主题默认」。

## 卸载

手动移除：
- `cordis.patch.yml` 中的 `dsh-skin` 行；
- `package.json` 中的 `"dsh-skin"` 依赖；
- `packages/dsh-skin/` 目录；
- （可选）`~/.dsh/dsh-skin-state.json` 外观设置文件。

然后重启 Harness。

## 声明

本项目**免费、开源**，遵循 [MIT](./LICENSE) 协议，可自由使用、修改和分发。

如果你觉得这个插件有用，欢迎点个 ⭐ **Star** 支持；遇到问题或想提建议，请提交 Issue 或 Pull Request。感谢！

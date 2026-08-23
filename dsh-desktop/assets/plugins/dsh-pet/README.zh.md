# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-pet?color=brightgreen"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-25%20animations-ff69b4">
</p>

> 一只住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面里的桌面宠物：待机呼吸、随机动作、屏幕漫游、点击反应、可拖拽。
> A floating desktop pet for the DeepSeek Harness Web UI.

---

## ✨ 功能特性

- **28 个手绘风透明动画**：待机呼吸、打瞌睡、玩魔方、哼歌、炸毛、吐泡泡、玩水枪、小提琴演奏……全部无缝衔接
- **永不停止的动画链**：每段动画播完立即按概率选下一个（30% 待机 / 10% 转向 / 40% 动作 / 20% 移动）
- **屏幕漫游**：朝 facing 方向行走，自动检查空间、不走出屏幕
- **点击 / 拖拽**：点击有随机回应动画（开心 / 害羞 / 傲娇），可拖到任意位置
- **左右朝向**：所有动画 CSS 镜像，人物可朝左 / 朝右
- **落地对齐**：动画统一脚底线，宠物始终站在"地面"上
- **流畅切换**：双缓冲 video 交叉淡入，切换零空白帧
- **无障碍友好**：支持 `prefers-reduced-motion`

## 📦 安装

```sh
dsh plugin --profile web add dsh-pet
```

重启 `dsh web`，宠物出现在界面右下角。

## ⚙️ 配置

| 配置项 | 说明 | 当前状态 |
|---|---|---|
| `size` | 宠物显示高度（px） | 默认 260，**暂未下发到浏览器**（DSH 客户端配置管线限制，走代码默认值） |
| `position` | 默认角落位置 | 默认右下角，同上暂未下发 |
| `fullRoot` | 原始 1200×1200 母版资源目录 | 默认 `$DSH_HOME/pet-assets`，需手动下载母版后生成 |

> 说明：插件安装即用，上述配置均为可选；`size`/`position` 的浏览器侧配置化正在规划中。

### 桌宠设置面板（DSH Desktop 内置版 V4.2）

鼠标悬停宠物右上角出现工具条（设置 / 关闭）。设置面板支持：

- **大小**：120–420px 滑杆实时调整
- **位置**：四角（右下 / 左下 / 右上 / 左上）或「自由位置」跟随拖拽
- **互动开关**：关闭后不再播放点击回应与随机动作，只保留待机
- **自动挂边隐藏**：空闲 8 秒后自动折叠成小图标贴边，鼠标悬停展开
- **关闭桌宠**：直接隐藏宠物；隐藏后角落出现「召唤桌宠」按钮一键恢复

所有设置保存在浏览器本地（`localStorage: dsh-pet:settings:v1`），重启后保留。

## 🗑️ 卸载

```sh
dsh plugin --profile web remove dsh-pet
```

## 🖥️ 运行效果

宠物实际运行在 DSH Web 界面中的样子：

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet 运行效果 1" title="dsh-pet 运行效果 1">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet 运行效果 2" title="dsh-pet 运行效果 2">
</p>

## 🎬 效果预览

> 动画为透明背景；GIF 预览中透明部分显示为页面底色，实际播放为透明。

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8%E4%BC%91%E9%97%B2.gif" width="160" alt="待机呼吸休闲" title="待机呼吸休闲">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E4%B8%9C%E5%BC%A0%E8%A5%BF%E6%9C%9B.gif" width="160" alt="东张西望" title="东张西望">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E5%8E%9F%E5%9C%B0%E6%BC%82%E6%B5%AE%E8%B8%8F%E6%AD%A5.gif" width="160" alt="原地漂浮踏步" title="原地漂浮踏步">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E5%8E%9F%E5%9C%B0%E5%B0%8F%E6%86%A9%E6%B2%89%E7%9C%A0.gif" width="160" alt="原地小憩沉眠" title="原地小憩沉眠">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E7%82%B9%E5%87%BB%E5%9B%9E%E5%BA%94%20-%20%E5%BC%80%E5%BF%83%E8%B7%83%E5%8A%A8.gif" width="160" alt="点击回应 - 开心跃动" title="点击回应 - 开心跃动">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E8%A2%AB%E9%BC%A0%E6%A0%87%E6%8B%96%E6%8B%BD%E6%82%AC%E7%A9%BA%E5%8F%8D%E9%A6%88.gif" width="160" alt="被鼠标拖拽悬空反馈" title="被鼠标拖拽悬空反馈">
</p>

全部 28 个动画见仓库：`dsh-pet/assets/thumb/`。

## 📚 完整项目（不止是插件）

这是**完整的三件套项目**，任何人 clone 仓库都可以从零生成自己的桌面宠物：

```
① 提示词（配方）    →  ② 素材生成链（引擎）  →  ③ 插件（成品）
AI 生成动画的配方     源视频 → 透明动画的管线    运行在 DSH 里的宠物
```

- 仓库：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
- 设计与实现文档：[DESIGN.md](https://github.com/PC2005-cloud/dsh-pet/blob/master/DESIGN.md)

## 🔎 发现更多 DSH 插件

- 社区插件目录：[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)
- DSH 官方仓库：[deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)

## 📄 许可

- 代码：MIT
- 素材（动画/提示词）：见仓库说明

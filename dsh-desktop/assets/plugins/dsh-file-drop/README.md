# dsh-file-drop — 拖入文件到对话

DSH Desktop 配套插件：把本地文件直接拖进对话输入框，让 agent 直接处理。

- **文本 / 代码文件**（.md/.js/.py/.json 等常见文本扩展名与无扩展名文件）：
  内容自动注入输入框（上限 256 KB），带 `<!-- 拖入文件：<名> -->` 文件头。
- **图片**（png/jpg/webp/gif/svg 等）：注入路径提示文本，配合
  [dsh-tool-vision](https://github.com/Scorp1o117/dsh-tool-vision) 的
  `inspect_image` 工具让 agent 看图。
- **二进制 / 超大文件**：注入完整路径提示，agent 用文件工具直接读取。
- 纯客户端实现（host 半边 no-op），无宿主依赖；在「设置 → 插件 → 管理」
  可随时关闭。

Electron 桌面端下通过 preload 暴露的 `getPathForFile`（webUtils）获取拖入
文件的完整路径；纯浏览器打开 WebUI 时自动降级为可读提示。

License: MIT。Deepseek Harness EAC 配套插件。
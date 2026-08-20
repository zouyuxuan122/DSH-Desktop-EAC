# dsh-image-paste — 图片粘贴发送

DSH Desktop 配套插件：在对话输入框按 **Ctrl/Cmd+V** 粘贴剪贴板里的图片
（截图、复制网页图片等）时，自动把图片保存到临时目录（`%TEMP%\dsh-paste`），
并把完整路径提示注入输入框，配合 `inspect_image` 视觉工具发送给 agent 分析。

- 支持 PNG / JPEG / WebP / GIF / BMP / AVIF / ICO / TIFF，单张上限 15MB。
- 纯文本粘贴完全不干预（交给上游输入框）；同时粘贴「文本 + 图片」时文本
  照常粘贴，图片提示追加在末尾。
- 多张图片一起粘贴时合并为一条提示，agent 逐一分析。
- 保存经受控 IPC（`dsh:image-paste-save`）：只接受 image/* 的 data URL、
  文件名清洗防路径穿越、写入路径固定为临时目录，不污染工作区。
- 临时文件随系统清理；若保存失败（如剪贴板图片损坏）静默降级，不打扰输入。
- 纯客户端实现（host 半边 no-op）；在「设置 → 插件 → 管理」可随时关闭。

与拖入图片（dsh-file-drop）的路径提示格式一致，agent 用同一套
`inspect_image` 流程处理。

License: MIT。Deepseek Harness EAC 配套插件。
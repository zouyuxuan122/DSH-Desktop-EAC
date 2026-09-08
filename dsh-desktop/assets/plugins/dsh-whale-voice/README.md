# dsh-whale-voice

> EAC 收录版。来源：[ntpzz/dsh-whale-chan-pack](https://github.com/ntpzz/dsh-whale-chan-pack/tree/main/plugins/dsh-whale-voice)，MIT。

DSH 左侧「语音」设置页与本地 Whisper 语音输入插件。

- 设置 Whisper 模型、识别语言、运行设备、麦克风、模型缓存目录和按钮图标。
- 可上传 PNG、JPG、WebP 或 GIF 作为麦克风按钮图标；文件会内嵌保存在配置中，并固定以 32 × 32 像素显示。
- 配置持久化至 `~/.dsh/whale-voice/config.json`，重启后保留。
- 识别使用本机 DSH host 的 Whisper 管线；麦克风音频只会发送给本机回环地址。
- 初始安装不下载 Whisper 运行库；默认选用 `tiny`。只有点击「保存并下载运行库和模型」后，插件才会下载运行库和所选模型到本机。
- Node 与客户端入口同时提供命名 `apply` 和 `default { apply }`。

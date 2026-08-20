# dsh-settings-nav-custom — 设置页左侧边栏自定义

DSH Desktop 配套插件：打开「设置」→ 左侧导航底部出现 **自定义边栏** 按钮，
点击后在浮层里按需显示/隐藏与排序左侧导航项（通用、模型、外观、插件、
市场等 `settings.section` 条目）。

- 默认**全显**，未配置时与官方行为完全一致（零改变）。
- 配置存 `localStorage`（`eac:settings-nav:v1`），重启/更新后保留。
- 导航项数据直接来自 slots 服务（与官方设置页同一数据源），第三方注册的
  设置区段自动出现。
- 纯客户端实现（host 半边 no-op），无宿主依赖；在「设置 → 插件 → 管理」
  可随时关闭。

注意：把当前正在查看的区段隐藏后，需通过「自定义边栏」浮层恢复。

License: MIT。Deepseek Harness EAC 配套插件。
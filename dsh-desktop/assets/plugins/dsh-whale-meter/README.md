# dsh-whale-meter

> EAC 收录版。来源：[ntpzz/dsh-whale-chan-pack](https://github.com/ntpzz/dsh-whale-chan-pack/tree/main/plugins/dsh-whale-meter)，MIT。

DSH Web 客户端费用/用量设置页。

- 从 DSH `tokenUsage` projection 读取各会话服务端统计。
- 将累计快照持久化到 `~/.dsh/whale-meter/usage.json`，重启不清零。
- 每日从 DeepSeek 官方价格页刷新一次，失败保留上次价格。
- 可自定义价格、美元换算系数、显示货币和文案。
- Node 入口同时导出命名 `apply` 与 `default { apply }`，兼容不同 loader unwrap 行为。

安装前先在备用 profile/端口验证。插件不应在验证完成前加入正在使用的 live profile。

# 产品服务模块规范

本文件覆盖不属于窗口壳、插件注册表或更新器的项目自有服务。

## 余额与定价

关键文件：

- `dsh-desktop/balance.ts`
- `dsh-desktop/lib/desktop/` 中的余额调用者
- `assets/plugins/dsh-balance`
- `tauri-shell/sidecar/server.ts` 的余额 RPC 和轮询

修改模型价格、峰谷窗口或推送格式时检查：

- `balance-prices-core.test.ts`
- `pricing-window.test.ts`
- `widget-theme.test.ts`
- bridge 中的余额通知消费者

## 会话完成通知

关键文件：

- `session-watcher.ts`
- sidecar 或壳层通知入口
- `settings.json` 的 `notifyOnTurnEnd`

保持：

- 使用持久化会话事件，不依赖脆弱 UI 私有协议。
- 子 Agent 不重复通知。
- turn 完成和旧格式 fallback 不重复触发。
- 通知点击只恢复窗口，不修改会话。

修改后至少运行 V2，并用临时会话执行真实通知验证。

## 文件与预览

关键文件：

- `lib/desktop/file-roots.ts`
- `lib/desktop/static-preview.ts`
- `lib/desktop/plugin-ops.ts::imagePasteSave`
- 文件类 DSH 插件

保持：

- 路径先解析为绝对路径，再验证位于允许根目录。
- 静态预览和端口预览只开放 loopback。
- 文件打开、还原和图片保存不接受路径穿越。
- MIME、大小限制和错误返回保持稳定。

## 端口与进程流

关键文件：

- `stable-port.ts`
- `stream-write-guard.ts`
- `koffi-preflight.ts`
- `lib/desktop/proc.ts`

对应测试：

- `stable-port.test.ts`
- `stream-write-after-end.test.ts`
- `koffi-preflight.test.ts`

## 错误详情与构建完整性

- `error-detail.ts` 对应 `error-detail.test.ts`。
- `bundle-integrity.ts` 对应 `bundle-integrity.test.ts`。
- `builtin-collision.ts` 对应 `builtin-collision.test.ts`。

错误详情必须脱敏，完整性检查只把文件丢失判为损坏，不因额外文件误报。

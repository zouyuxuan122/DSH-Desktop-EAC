# dsh-webui-prompt-optimizer

从 `statem-li/dsh-webui` 当前实现中独立提取的 DeepSeek Harness 提示词优化插件。

## 功能

- 在对话输入区右侧显示提示词优化图标。
- 使用当前会话选中的 provider/model，不单独保存 API Key。
- 单轮模式通过 SSE 流式写回优化结果，停止或失败时恢复原草稿。
- 多轮模式并行生成“均衡、精简、详尽”三个候选，可选择后继续迭代。
- 可选择把结果包装为 `/goal`，或附加 AI 浏览器验证要求。
- 优化接口仅允许本机 loopback 请求。

## 构建

```powershell
npm install
npm run build
```

## 安装

将本目录复制到 DSH profile 的 `node_modules/dsh-webui-prompt-optimizer`，并把
`cordis.patch.yml` 的 insert 项加入 profile 配置后重启 DSH。

## 来源

功能代码提取自 `statem-li/dsh-webui`，基于 2026-08-23 的提交
`235643c4086de5faf58ae98ef899bd8715ba66ab`。适配内容包括独立入口、独立路由、
独立 localStorage 键、包清单与构建配置。

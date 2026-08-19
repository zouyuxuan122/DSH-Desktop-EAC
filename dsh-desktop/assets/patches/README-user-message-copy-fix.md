# 用户消息复制按钮闪现修复说明

## 问题
用户发送的消息中的复制按钮闪现/无法点击，AI回复消息的复制按钮正常。

## 根因方向
用户消息的复制按钮（`MessageIconActions` 内）在点击时事件可能冒泡到父级，
且按钮/操作栏可能被覆盖层拦截，导致按钮闪现且无法稳定点击。

## 修复内容

### 1. 核心包补丁（手动应用到安装目录 node_modules）
文件：
`resources/app/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`

修改点：`MessageIconActions` 中复制按钮的 `onClick` 增加 `stopPropagation()`，
防止点击事件冒泡导致组件重挂载/状态重置。

原始代码：
```js
onClick: onCopy,
```

修改后：
```js
onClick: (e) => {
    e.stopPropagation();
    onCopy();
},
```

### 2. 皮肤CSS加强（已包含在 maid-atelier skin）
- 强制用户消息操作栏 `.p-xYUq_actions` 可见、可点击、高 z-index
- 强制用户消息复制按钮可见、可点击、增大点击区域
- 深色模式同步适配

## 如何重新应用
如果更新覆盖了 node_modules，请重新修改上述核心包文件，
或等待后续构建将补丁合入正式依赖。

## 验证
1. 重启 Deepseek Harness 客户端
2. 发送一条用户消息
3. 悬停/点击用户消息复制按钮，应可正常复制
4. AI回复消息复制按钮保持正常

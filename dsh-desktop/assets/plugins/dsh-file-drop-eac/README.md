# dsh-file-drop-eac — 拖入文件/文件夹到对话（EAC 特化版）

Deepseek Harness EAC 配套插件：把本地文件/文件夹直接拖进对话输入框，让 agent 处理。
本包是已弃用的 **dsh-file-drop** 的 EAC 特化重写，针对"拖入图片会与视觉桥重复注入冲突"做了裁剪。

## 移植来源与移植目标

- **移植来源**：Deepseek Harness EAC 内置插件 [`dsh-file-drop`](https://github.com/zouyuxuan122/Deepseek-Harness-EAC)（仓库内 `resources/app/assets/plugins/dsh-file-drop`），以及用户的拖拽真实路径需求
  [Deepseek-Harness-EAC issue #141](https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues/141)。
- **移植目标**：抽出为独立插件库 [`dsh-file-drop-eac`](https://github.com/jing-hy/dsh-file-drop-eac)，
  作为 EAC 客户端**内置替代插件**（登记进 `main.js` 的 `COMPANION_PLUGINS` 并落到
  `resources/app/assets/plugins/dsh-file-drop-eac`），由客户端内的 `syncCompanionPlugins`
  分发到 web profile，替换原 `dsh-file-drop`。发布：<https://github.com/jing-hy/dsh-file-drop-eac/releases>。


## 与 dsh-file-drop 的差异

| 行为 | dsh-file-drop（旧） | dsh-file-drop-eac（本包） |
| --- | --- | --- |
| 文本 / 代码文件 | 内容注入输入框（≤256 KB） | ✅ 保留 |
| 二进制 / 超大文件 | 注入完整路径提示 | ✅ 保留 |
| 图片 | 注入路径提示/文本 | ❌ **完全不接管**：拖图什么都不做，交给视觉桥 / 原生缩略图 |
| 文件夹 | ❌ 不支持（被静默忽略） | ✅ **新增接管**：识别并给出可操作降级提示 |

## 支持与限制

- **文本 / 代码文件**（`.md/.js/.py/.json` 等常见文本扩展名与无扩展名文件）：
  内容自动注入输入框（上限 256 KB），带 `<!-- 拖入文件：<名> -->` 文件头。
- **二进制 / 超大文件**：注入完整路径提示，agent 用文件工具按路径直接读取。
- **图片**：不接管（避免与视觉桥/缩略图重复注入冲突）。
- **文件夹**：识别为目录并提示 —— 浏览器 / Electron 出于安全限制**拿不到文件夹的磁盘绝对路径**
  （`webUtils.getPathForFile` 只接受 File，文件夹是 `webkitGetAsEntry()` 返回的目录条目，
  仅带虚拟路径），因此插件降级提示"在文件/项目目录标签打开该目录"或"关键文件逐一拖入"。

Electron 桌面端通过 preload 暴露的 `dshDesktop.getPathForFile`（webUtils）获取拖入文件的
完整磁盘路径；纯浏览器打开 WebUI 时自动降级为可读提示。

## 目录结构

```
dsh-file-drop-eac/
├── lib/
│   ├── index.js     # host half（no-op，让包成为合法 bundle）
│   └── client.js    # 浏览器半边（classic-script，经 __ModuleLoader__.load 注册）
├── test/
│   └── client.test.js  # node:test + vm 沙箱（纯逻辑 + 端到端 drop 注入）
├── README.md
└── package.json
```

`client.js` 是 classic-script bundle（官方模块加载器只支持该形式，不能 `import`），纯逻辑挂在
`window.__dshFileDropEacCore` 上（生产无副作用），供 node 测试直接评估本文件。

## 测试

```bash
npm test
# 或
node --test
```

License: MIT。Deepseek Harness EAC 配套插件。

# Third-Party Notices

`DSHEAC AIO v1`（All-in-One）聚合并再分发多类第三方内容。顶层 MIT License 只适用于相应项目代码，**不会覆盖第三方组件自己的许可证、商标或素材权利**。

## 主要上游

| 组件 | 来源 | 许可证/状态 |
| --- | --- | --- |
| DSH-Desktop-EAC v4.5-lite 基线 | `zouyuxuan122/DSH-Desktop-EAC` | MIT；顶层 LICENSE 保留上游版权声明 |
| DeepSeek Harness / `@deepseek-ai/dsh` | `deepseek-ai/deepseek-harness` | MIT；包内 `node_modules/@deepseek-ai/dsh/LICENSE` 随源码提供 |
| Tauri 2 及 Rust crates | Cargo.lock 所列项目 | 各自许可证；应使用 Cargo 工具生成完整清单 |
| Node.js 与 npm CLI | `vendor/node`、`vendor/npm` | Node.js/npm 及其依赖各自许可证；发布前需保留上游 notices |
| Microsoft Edge WebView2 离线安装器 | Tauri bundle 下载/嵌入 | 适用 Microsoft WebView2 分发条款，不受 MIT 覆盖 |

## 内置插件

| 组件 | 来源 | 许可证/状态 |
| --- | --- | --- |
| DSH Composer Dynamic Island 2.1.0 | `says693/dsh-composer-dynamic-island`，tag `v2.1.0`，commit `2ccd12ff807c3bc983defd2177e15be1a416106f` | MIT，`Copyright (c) 2026 says693`；LICENSE 与双语 README 随包保留 |

该插件的 `lib/client.js` 是上游提交中的预构建 Web 适配器；AIO 对它应用了
生命周期、焦点和可访问语义的局部修复。原始与 vendored SHA-256 及补丁摘要记录在
`assets/plugins/dsh-composer-dynamic-island/EAC-VENDOR.json`。该记录用于来源审计，
不代表官方 DSH 认证或独立安全沙箱。

## 内置皮肤

`assets/skins` 中 9 款皮肤的 package metadata 标注 `BSD-3-Clause`：

- xp
- qq98
- ths
- blue-fantasy
- dragon-heir
- minecraft
- trading
- whale-song
- miku

来源说明指向社区 `dsh-web-ui`。共享许可证文本已随 `assets/skins/dsh-skins-LICENSE.txt` 提供，内容为 BSD-3-Clause，版权声明为 `Copyright (c) 2026, zhu1090093659`。公开发布时仍须保证该文件进入二进制随附材料；各预览图和主题名称可能涉及额外素材或商标权，需另行核对。

## Profile seed 与本地插件

profile seed 包含多项 MIT、BSD-2-Clause、BSD-3-Clause、ISC、MPL-2.0 OR Apache-2.0 等依赖；常见实例包括：

- `@dsh-external/dsh-webui` — BSD-3-Clause
- `@dsh-external/dsh-visualize` — BSD-3-Clause
- `dsh-drag-and-drop` — BSD-3-Clause
- `dompurify` — MPL-2.0 OR Apache-2.0
- `entities` — BSD-2-Clause
- 多数 DSH 插件、React/Markdown/Shiki 依赖 — MIT

本地插件源码目录：

- `source/local-plugins/dsh-client-ui-custom-main`
- `source/local-plugins/dsh-usage-skill-statem-li`
- `source/local-plugins/dsh-webui-statem-bridge`
- `source/local-plugins/dsh-webui-statem-li-v4lite`

其中 package metadata 并非都含完整许可证文本。源码归档会排除本地插件 `dist` 安装器与 source map，但实际安装 payload 仍包含其编译产物或 profile 副本。

## 发布前许可证门禁

当前仓库**尚未形成完整、可法律依赖的 SBOM/notice bundle**。公开发布前至少完成：

1. 对根 `node_modules`、profile seed、vendor/npm 和 local-plugins 生成依赖清单；
2. 为每个直接分发组件记录名称、版本、来源 URL、许可证和版权声明；
3. 复制所有要求随二进制分发的 LICENSE/NOTICE；
4. 对字体、图片、音频、视频、数据库和 MSI/EXE/DLL 等非代码资产单独核对；
5. 确认商标和项目名称不会造成官方背书误解；
6. 对缺少许可证或来源不明的内容，先移除，后发布。

在完成上述门禁前，构建成功不代表具备公开再分发授权。

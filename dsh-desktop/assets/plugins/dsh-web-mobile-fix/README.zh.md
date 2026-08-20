# dsh-web-mobile-fix

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI 的移动端布局修复插件。

纯客户端 CSS 覆盖层，在窄屏（视口 ≤700px）下修复最影响使用的移动端问题，完全不改动产品源码：

- 设置面板改为全屏纵向布局，不再被挤成桌面布局
- 目录选择器底部（取消/确定）固定在同一个底部行
- 侧边栏打开时全屏显示，不再挤压对话区
- 设置页插件导航（4 个按钮）单行排满
- 会话日志按钮收成图标
- 输入框模型名隐藏（只留下拉箭头）
- 下拉菜单/弹层/菜单居中显示

## 工作原理

插件带一个浏览器端（`exports["./client"]`，通过 `dsh.client.platform: "web"` 声明），由 client-modules 扫描器发现并随启动清单加载。它注入一个 `<style>` 标签，内容是针对产品稳定 `data-slot` 属性的 `@media (max-width: 700px)` 覆盖；插件卸载时标签自动移除——完全可逆。

## 兼容性

- 需要 Harness Web profile（`dsh --profile web`），0.1.x 系列均可
- 选择器针对产品槽位契约，同版本线内稳定；产品大改版后可能需要小幅调整

## 安装

### 方式一：bundle 安装（推荐）

从 npm 安装：

```sh
dsh plugin --profile web add dsh-web-mobile-fix
```

（不走 npm / 本地开发时，可用仓库地址：

```sh
dsh plugin --profile web add github:AcidGr/dsh-web-mobile-fix
```

）

重启 `dsh web`（或等 profile 热加载），浏览器硬刷新即可。

### 方式二：手动安装（无 pnpm / 离线）

```sh
PROFILE="$DSH_HOME/profiles/web"                 # 按实际修改 DSH_HOME 和 profile 名
mkdir -p "$PROFILE/plugins" "$PROFILE/node_modules/@dsh-profile"
cp -r dsh-web-mobile-fix "$PROFILE/plugins/mobile-fix"
ln -sfn ../../plugins/mobile-fix "$PROFILE/node_modules/@dsh-profile/mobile-fix"
# 在 $PROFILE/cordis.patch.yml 追加：
#   - insert:
#       - id: mobile-fix
#         name: '@dsh-profile/mobile-fix'
```

## 验证

用手机宽度窗口打开 Web UI——设置面板、侧边栏、弹层应已适配移动端。

## 回滚

- bundle 安装：`dsh plugin --profile web remove dsh-web-mobile-fix`
- 手动安装：删掉 `cordis.patch.yml` 里的 `mobile-fix` insert 块（插件目录可留可删）

不修改任何产品源码，升级不覆盖、无残留。

## 许可证

MIT

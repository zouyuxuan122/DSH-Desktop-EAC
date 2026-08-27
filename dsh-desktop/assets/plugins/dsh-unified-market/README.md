# dsh-unified-market — 统一插件市场（Unified Plugin Market for DeepSeek Harness）

> 一个市场，三个数据源：**精选目录 + GitHub dsh-plugin 生态 + npm registry**。
> 对 DSH Desktop（EAC）针对性适配，开箱即用的插件安装 / 更新 / 自动更新 / 管理。

在设置页 **设置 → 插件 → 🛒 统一市场** 提供一站式体验：三源切换、分类下拉筛选、
已下载插件更新面板（一键全部更新 / 逐个更新 / 自动更新三档开关）、更新进度窗口、
市场自身自更新。

> **v0.3.0 起新增「📦 功能包」tab**：EAC 功能包（.dshpack）的安装 / 卸载 / 更新 /
> 导出 / 回滚与管理（本包承担交互编排层，核心逻辑在 L2 功能包 CLI，见下）。

---

## 整合自哪三个插件

本项目把三个社区插件市场的能力合并为单一市场，三者分别是：

| 来源插件 | 定位 | 本市场吸收的能力 |
|---|---|---|
| **[dsh-webui-market](https://github.com/Sanqi-normal/dsh-webui-market-plugin)**（精选目录市场）| awesome-dsh-plugin.com 精选目录 | 🎯 精选目录 + 离线快照兜底（`data/catalog-snapshot.json`）、**来源白名单 + 试装验证（trial boot）**：安装前在临时环境实际启动一次、只认 `dsh web:` 就绪行才放行、真实 profile 从未被写过、安装前快照可回滚、简单插件热挂载免重启、安装前冲突预检、`allowBuilds` 自动放行、第三方本地构建产物保留 |
| **[zat-dsh-engine](https://github.com/mishibeikejie/zat-dsh-engine)**（GitHub 生态市场）| GitHub `dsh-plugin` topic 检索 + 中文简介 + 国内镜像 | 🐙 GitHub 生态实时检索（按星排序、分页）、中文简介（README.zh.md 摘要）、**gh-proxy / ghfast 双镜像抓取兜底**（无 VPN 也能访问 GitHub）|
| **[dsh-plugin-marketplace](https://github.com/DSH-Desktop/dsh-plugin-marketplace)**（npm 市场，DSH Desktop 配套）| npm registry 检索 dsh 插件 | 📦 npm registry 检索（keywords:dsh-plugin）、**更新检测（版本对照、TTL 缓存）**、更新失败回滚、全部更新 |

> 三方定位与 “对 EAC 特化” 的联系：
> 旧三个市场在 **DSH Desktop（EAC）桌面壳**里交错存在，各有失效面（profile 解析错误、
> 重复注册、更新链路不完整），本项目把它们整合为一个对桌面壳正确的统一入口。

---

## 对 EAC 的针对性适配

EAC（DeepSeek Harness Desktop）的 Web UI 跑在**桌面专属 profile `web-desktop`**
（由主进程通过 `DSH_DESKTOP_PROFILE` 注入）。旧市场中：
- **zat-dsh-engine** 只认 `DSH_PROFILE`、否则回落选 `web`；
- **dsh-plugin-marketplace** 写死 `web`；

→ 它们在桌面壳里检测/修复/安装的实际对象是**另一套 profile**（这就是“在 EAC 里是摆设”的根因）。
本市场所有读写统一解析为：

```
DSH_DESKTOP_PROFILE → DSH_PROFILE → web（独立安装时回退）
```

另针对桌面壳做了这批适配：

- **profile / 同步层**
  - 全部读写走桌面壳真实 profile（`desktopProfile()` + `resolveProfile()` 归一化）。
  - 内置插件清单（`.dsh-builtin-plugins.json`）识别：内置插件不进入市场检测/更新，
    由官方「内置插件更新」统一维护，避免与 `syncCompanionPlugins` 冲突。
  - 市场自身作为**内置插件**（`COMPANION_PLUGINS` 注册 `unified-market`），
    上游发布后走官方 `PLUGIN_UPDATE_SOURCES` 自更新。
- **安装 / 更新链路**
  - 试装验证、冲突预检、来源白名单、安装前快照、热挂载（源自 dsh-webui-market）。
  - **Windows 文件锁（服务运行中 pnpm 写 node_modules）**：任务自动排队
    （`.dsh-market-pending.json`），并在「Web 服务启动早期」由本市场 host 自动消费；
    同时修复主进程排队消费对 `kind:"update"` 任务的遗漏。
  - **本地链接（`link:`/`file:` 指向开发目录）插件也能更新**：从上游接管安装，
    更新前先删除 junction/符号链接（Windows pnpm 替换 symlink 会 `EPERM`），
    失败自动回滚恢复原链接；本地开发目录原样保留。
  - **24h 发布保护期**：上游新版本发布不足 24h（pnpm `minimumReleaseAge`）时不显示
    “可更新”，避免“可见不可装”。
  - pnpm `allowBuilds` 拦截自动放行并重试。
- **自动更新 / 自更新**
  - 后台自动检测（启动 20s 后首检 + 每 6 小时），三档：关闭 / 仅提示 / 自动升级；
    状态持久化在 `<profile>/.dsh-unified-market.json`。
  - 市场自身自更新接口（`selfUpdate`）+ 官方内置插件更新引擎对接。
- **功能包 CLI 定位（v0.3.0）**：桌面壳经 `DSH_DESKTOP_RESOURCE_ROOT` 注入
  dsh-desktop 资源根，本市场据此定位 `scripts/feature-pack-cli.js` 并 spawn
  （与现有 `dsh plugin` 子进程同构）；缺该环境变量时功能包页明确降级提示，
  不影响插件市场其余功能。

---

## 功能包（Feature Pack · .dshpack）支持

> v0.3.0 引入。借鉴 HMCL 整合包体系：把「插件组合 + 预设 + 技能」打包为 `.dshpack`，
> 可一键安装 / 卸载 / 更新 / 导出 / 回滚；包声明对官方内核（`@deepseek-ai/dsh`）的
> **semver 兼容范围**，官方版本升级后由 EAC 桌面壳启动兼容扫描自动检出
> （`state: incompatible`），本市场「📦 功能包」页给出「迁移（安装新版）」/
> 「回滚（保护中心快照）」入口。

**分工**：本包只做**交互编排**（UI、op 轮询、上传中转、市场索引浏览）；解析 /
校验 / semver / 注册表 / 装配 / 兼容扫描等核心逻辑在 dsheac 主体 L2
（`dsh-desktop/lib/desktop/feature-pack.ts` + `scripts/feature-pack-cli.ts`），
经 `DSH_DESKTOP_RESOURCE_ROOT` 定位 spawn，**不重复实现**（避免双实现漂移）。

- host 新增 `pack.*` 方法：`pack.list / pack.inspect / pack.install / pack.uninstall /
  pack.update / pack.export / pack.rollback / pack.scan / pack.market`；安装类走现有
  op 串行/轮询/超时模型，上传文件在 op 结束后自动清理。
- `pack.market` 索引走 live → 5 分钟缓存 → `data/packs-snapshot.json` 内置离线快照
  三级降级（对齐 `catalog-snapshot.json` 模式）；下载校验 SHA-256（`--sha256`）。
- 功能包 CLI 退出码约定：`0` 成功｜`1` 一般失败｜`2` 用法｜`3` 文件锁待排队（自动写入
  `feature-packs/.ops/pending.json`，服务重启前的无锁窗口自动续跑）｜`4` 兼容失配｜
  `5` 冲突阻断。

---

## 功能一览

- **三源切换**：🎯 精选目录 / 🐙 GitHub dsh-plugin 生态 / 📦 npm，各自搜索、排序、分页；
  精选目录分类用**下拉框**筛选（含“全部 / 已安装”）。
- **安装**：内置标记拦截 → 冲突预检（refuse 拒装）→ 来源白名单 → 试装验证 →
  安装前快照 → pnpm `allowBuilds` 放行 → 本地构建产物保留 → 简单插件热挂载免重启。
- **已下载插件更新面板**：只列可更新的插件；每项 `当前版本 → 最新版本` +
  单个「更新」按钮；顶部「⬆ 全部更新 (N)」一键批量；「检查更新」强制重查。
- **更新进度窗口**：后台批量更新实时进度（`第 x/y 个`、成功/排队/失败计数、
  最近输出）；失败或排队时窗口**保留**显示原因（✕ 手动关闭），不再自动消失。
- **自动更新三档**：关闭 / 仅提示（默认）/ 自动升级。
- **本地链接插件**：也检测上游更新（GitHub repo / npm 名推断 → 市场按名匹配，
  可从上游接管安装或保留链接在本地更新。
- **市场自更新**：上游发布后由官方「内置插件更新」自动/手动升级。
- **功能包管理（v0.3.0）**：「📦 功能包」tab —— 已安装列表（版本/兼容性徽标/更新/导出/
  卸载）、本地导入 `.dshpack`（文件选择 → base64 → 安装）、功能包市场浏览一键安装
  （SHA-256 校验）、官方内核升级后不兼容提示条 + 一键迁移（选新版）/ 回滚。

---

## 安装

### 方式一：DSH Desktop（EAC）内置分发（推荐）

把本包放入 `assets/plugins/dsh-unified-market/`，并在桌面壳 `main.js`：
- `COMPANION_PLUGINS` 增加：
  ```js
  { id: 'unified-market', name: 'dsh-unified-market', dir: 'dsh-unified-market' }
  ```
- （可选）移除旧 `dsh-market-plugin`（dsh-webui-market）与 `zat-market`（zat-dsh-engine）条目。
- 重新启动应用，`syncCompanionPlugins` 会把包同步进 `web-desktop` profile 并挂载。

### 方式二：独立安装（非内置、脱壳）

```sh
dsh plugin --profile web-desktop add dsh-unified-market
# 或 GitHub 源：
dsh plugin --profile web-desktop add github:jing-hy/dsh-unified-market
```

安装后 **重启 Web 服务**，在 **设置 → 插件 → 🛒 统一市场** 使用。

---

## 市场自更新（内置分发时启用）

在 `main.js` 的 `PLUGIN_UPDATE_SOURCES` 启用：

```js
'unified-market': { npm: 'dsh-unified-market' },
```

之后由官方「内置插件更新」（启动 20s 后 + 每 6 小时检测、可开自动更新）负责
更新到覆盖层并重启服务生效；独立安装时市场的 `selfUpdate` 接口同样对比 npm 版本。

---

## 目录结构

```
dsh-unified-market/
├── package.json            # dsh.bundle.patch / dsh.client 声明 + 发布元信息
├── cordis.patch.yml        # host 半边挂载声明
├── lib/
│   ├── host.js             # host 半边（ESM）：HTTP 路由 /api/dsh-unified-market
│   ├── client.js           # 浏览器半边：设置页「统一市场」tab
│   ├── allow-builds.mjs    # pnpm allowBuilds 拦截自动放行
│   ├── artifact-keep.mjs   # 第三方本地构建产物保留
│   └── plugin-conflict-scan.mjs  # 安装前冲突预检
├── data/catalog-snapshot.json    # 精选目录离线快照（官网不可达时兜底）
├── data/packs-snapshot.json      # 功能包市场索引离线快照（v0.3.0 起）
├── README.md
└── LICENSE
```

通信：client 通过 `POST /api/dsh-unified-market`（兼容 `/api/dsh-market`）调用 host。
host 半边运行在 `dsh web` 进程（Cordis plugin，注入 `webServer`）。

---

## 版本记录

- **0.2.0**（2026）：三源合一 + EAC 适配（web-desktop profile、文件锁排队与启动消费、
  link→上游接管、24h 保护期、更新进度窗口）。
- **0.2.1**（2026）：修复 README 编码（去除 BOM / 修正 mojibake）。
- **0.3.0**（2026）：新增「📦 功能包」tab 与 `pack.*` host 方法 —— EAC 功能包
  （.dshpack）的交互编排层（安装/卸载/更新/导出/回滚/市场浏览 + 官方内核兼容扫描
  联动），SELF_VERSION 与 package.json 同步 0.3.0。

## 发布

- **npm**：`npm publish`（包名 `dsh-unified-market`；已发布至 0.2.1）。
- **GitHub**：`github.com/jing-hy/dsh-unified-market`（main 分支）。

## License

MIT（见 LICENSE）。离线目录快照数据来自 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)
社区目录，版权归各自作者；三方整合能力分别源自对应插件的 MIT/开源许可。
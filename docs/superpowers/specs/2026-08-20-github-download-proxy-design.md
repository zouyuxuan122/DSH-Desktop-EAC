# GitHub Release 下载代理补丁设计

日期：2026-08-20

## 目标

让桌面客户端在下载 GitHub Release 安装包和便携版时，优先使用
`gh.geekertao.top` 代理，从而改善部分网络环境下的下载速度。

补丁需要同时覆盖：

- `Deepseek-Harness-EAC-Setup-x64.exe`
- `Deepseek-Harness-EAC-Portable-x64.exe`

代理不可用时，客户端必须自动回退到现有 GitHub 和 Gitee 下载源。

## 非目标

- 不修改 Release 版本查询逻辑。
- 不把代理站作为唯一下载源。
- 不绕过 SHA-256 校验。
- 不修改安装器、便携版替换逻辑或更新回滚逻辑。
- 本次只生成本地打包产物，不创建 GitHub Release、不上传文件。

## 方案

修改 `dsh-desktop/client-updater.js`，在下载资产 URL 进入
`downloadWithSourceSwitch()` 之前增加 GitHub 代理 URL：

```text
GitHub Release asset
        |
        +--> gh.geekertao.top/<原始 GitHub URL>
        |
        +--> 原始 GitHub URL
        |
        +--> 现有 Gitee 备用 URL
```

只对以 `https://github.com/` 开头的 URL 生成代理地址。Gitee 地址和
其他自定义地址不经过该代理。

代理 URL 使用统一前缀拼接，不写死版本号或文件名。Release API 返回
新的版本和资产地址后，代理地址会自动跟随新版本。

## 下载与校验流程

1. 现有逻辑查询 GitHub/Gitee Release 元数据。
2. 根据部署形态选择 Setup 或 Portable 资产。
3. 对 GitHub 资产生成代理 URL。
4. 按“代理 → GitHub → Gitee”顺序下载。
5. 任一来源失败时清理当前临时文件并切换下一个来源。
6. 下载完成后继续使用现有 SHA-256 digest 或 `SHA256SUMS.txt` 校验。
7. 校验失败时删除文件并中止更新，不启动安装器。

代理服务返回 HTML 错误页、截断文件或其他错误内容时，现有大小检查和
SHA-256 校验负责阻止损坏文件进入安装流程。

## 配置边界

代理地址作为客户端默认下载策略的一部分写入代码，不要求用户配置环境变量。
后续如果代理域名变更，需要发布新的客户端版本；但普通的版本号、Release
标签和资产文件名变化不需要再次修改代码。

## 测试

新增或补充以下测试：

- GitHub 资产 URL 能生成正确的代理 URL。
- Gitee URL 不会被错误地加上代理前缀。
- 代理下载失败后能切换到 GitHub 原地址。
- 现有 Gitee 回退链路仍然可用。
- 下载完成后 SHA-256 校验仍然执行。
- Setup 和 Portable 两种资产都使用同一套代理策略。

验证命令：

```powershell
cd F:\Deepseek-Harness-EAC\dsh-desktop
npm test
npm run prepack
npm run dist
```

## 产物与交付边界

`npm run dist` 应在 `dsh-desktop/dist/` 生成：

- `Deepseek-Harness-EAC-Setup-x64.exe`
- `Deepseek-Harness-EAC-Portable-x64.exe`
- 对应的 `.blockmap`
- `SHA256SUMS.txt`

本轮只保留本地打包产物，等待真实代理下载测试通过后，再决定是否提交
功能 PR 和发布新版本。

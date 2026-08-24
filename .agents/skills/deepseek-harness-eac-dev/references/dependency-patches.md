# 依赖补丁与 vendored 覆盖

本项目原则上不直接修改 `@deepseek-ai/*` 安装包源码。当前存在经过项目维护者批准的受控例外，必须作为一条完整链路维护，不能只改其中一处。

## 受控链路

- 补丁事实源：`dsh-desktop/scripts/patch-deps.js`
- 本地安装树：`dsh-desktop/node_modules/@deepseek-ai/...`
- 分发重放：`tauri-shell/stage-resources.mjs`
- 必要的 vendored 覆盖：当前包括 `dsh-tool-bash/lib/index.js`

`npm ci` 会恢复 registry 内容，因此打包 staging 必须重新运行 `patch-deps.js`，再覆盖项目明确保留的 vendored 文件。

## 修改规则

- 先确认上游版本是否已经包含同等修复；已包含时删除本地补丁，不叠加重复逻辑。
- 补丁必须有稳定锚点、幂等标记和“目标不存在或已变化”的清晰诊断。
- 一个补丁涉及多个同构包时，目标集合必须完整；不能只补其中一个实现。
- 不在补丁中扩大权限、关闭安全校验或静默吞掉上游错误。
- vendored 文件必须能说明来源版本、项目差异和分发时为何需要覆盖。
- 修改 `patch-deps.js` 时同步检查 `stage-resources.mjs` 是否携带并重放该脚本。
- 修改 vendored 文件时同步检查 staging 的回填逻辑。

## 验证

至少完成：

- TypeScript build 和完整 Node 测试。
- `bundle-integrity.test.mjs`
- `bundled-files.test.mjs`
- `verify-dist-fresh.test.mjs`
- 在干净 staging 上运行 `stage-resources.mjs`
- 重复执行补丁，确认第二次不产生额外变化。
- 比较 staging 中目标文件包含补丁标记且与预期 vendored 覆盖一致。

发布链只使用 `.github/workflows/release-tauri.yml`。`.github/workflows/release.yml` 是禁用的 Electron 历史记录，不得重新启用。

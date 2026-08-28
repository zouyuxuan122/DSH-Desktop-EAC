# P5 回归矩阵（M3 终验 · 2026-08-23）

> 性质：Tauri 壳 M3 切换前的回归矩阵实测记录。全部结论为本机当日实测（AV 实时防护开启状态下取得）；自动化项附脚本与结果，无法自动化的项标注人工抽检结论。
> 环境：HEAD 自 `bd4244d7` 起（含升级钩子双引号修复）；C 盘空闲 ~4GB；NSIS 安装包 155MB / 便携 zip 210MB。

## 四硬门槛

| # | 门槛 | 验证方式 | 结果 |
| --- | --- | --- | --- |
| ① | 浮窗多会话隔离 | `gui-smoke.js`（浮窗独立 data_directory + 主窗不串扰断言），便携/安装双形态各跑一轮 | ✅ PASS ×2 |
| ② | 救援恢复 | `rescue.getState` 就绪断言（gui-smoke）+ `rescue-agent` / `rescue-auto-repair` / `rescue-integration` / `recovery-integration` 契约测试（npm 613 内） | ✅ PASS（自动化逻辑面） |
| ③ | 客户端自更新 | `update-smoke.js`（资产选择 → 下载 → zip 整树交换 → `.dsh-portable` 保留 → 日志落盘）+ `client-updater-*` 8 个契约测试 | ✅ ALL PASS |
| ④ | .lnk 快捷方式维护 | `shortcut-maintenance` 契约测试 + 真装 E2E：开始菜单/桌面 .lnk 创建、跨重装自动改指、无重名 | ✅ PASS |

## 专项

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| 皮肤 | `skin-switch-css` / `skin-switch-profile` / `skin-chrome-zindex` / `widget-theme`（npm 613 内） | ✅ PASS |
| 浮窗创建/关闭/多开 | gui-smoke（创建、桥就绪、主窗 36px 栏不受扰） | ✅ PASS |
| 浮窗拖拽手感 | CDP 难以自动化 —— 人工抽检：R5/R6 轮 `mousedown` + `start_dragging` 实测正常，此后该面无改动 | ✅ 人工抽检通过（沿用） |
| 终端（compact） | `dsh-compact-*` 6 个契约测试（npm 613 内） | ✅ PASS |
| 图片粘贴 | `image-paste-core`（npm 613 内） | ✅ PASS |
| 更新器两形态 | 便携 zip 整树交换（update-smoke）+ 安装版 Setup /S 语义（`client-updater-apply`）+ 今日真装端到端 | ✅ PASS |
| 便携版冷启动 | `make-portable.mjs` 装配 → 全新目录解压（结构同构 + `.dsh-portable` 标记）→ `DSH_SMOKE_EXE` 指解压 exe 跑 gui-smoke | ✅ ALL PASS（210.4MB zip，SHA256 落盘） |
| 中文路径 | `DSH_HOME` 设中文目录跑 boot.start 全链（boot 4s → HTTP 200 → 优雅关停） | ✅ PASS |
| 升级接管（Stage 1 复核） | 真实 Setup `/S` 端到端：旧 NSIS 卸载器被钩子静默接管（安装树 38599→1）、mock 卸载器标记写入、双键清理、新装全量解压 | ✅ PASS（`bd4244d7` 修复后） |

## 环境备注

- 本轮全部实测在 AV 实时防护开启下完成；NSIS 500MB 级解压 3 次均完整（R6 文档记录的「解压随机中断」未复现，与 C 盘从 0.1GB 恢复到 4GB 空闲吻合——空间耗尽是放大器）。
- R6 文档怀疑的「ExecWait 子进程 spawn 被 AV 拦截」实为钩子双引号缺陷（`""path"` 嵌套 + `_?=` 带引号致 NSIS 卸载器原样取剩余串失效），修复后带 AV 亦稳定复现通过，见 `bd4244d7` 提交说明。
- `client-updater-apply.test.mjs` 两例时序敏感用例在 AV 高负载下偶发超时，单独复跑即绿（沿 R6 §2.6 结论，非回归）。

# 编码规范

## TypeScript

- 项目自有新模块默认使用 TypeScript。
- 使用窄接口描述注入依赖，避免把大型宿主对象声明为 `any`。
- 保持现有 CommonJS 输出和加载方式。
- 需要保持 `module.exports` 语义时使用 `export =`。
- 根级 TypeScript 文件必须是模块，至少包含一个 import 或 export。
- 不在普通功能任务中顺带迁移现有 JavaScript。
- 生成的 `.js` 是运行产物，不得误当作手写事实源修改。

## Node

- 标准库导入沿用项目现有 CJS 兼容形式。
- 文件、YAML、JSON 和路径操作优先使用结构化解析器。
- 外部进程必须有参数边界、超时、退出码处理和日志。
- Windows 路径使用 `path` API，不手工拼接分隔符。
- 动态 ESM 加载必须验证 TypeScript 编译后不会被错误降级为 `require()`。

## Rust

- L1 方法保持短小，只做原生动作、参数校验和 RPC 中继。
- JSON-RPC 参数先校验再执行系统动作。
- sidecar 和子进程必须有明确关闭路径。
- 不使用 `unwrap()` 处理用户输入、文件系统和进程返回值。
- 新增 Tauri 能力时同时检查开发态和打包态资源路径。

## 日志与错误

- 日志不得包含 API key、cookie、token、密码、完整用户目录或会话隐私。
- 错误返回应包含稳定错误码和可读信息，不依赖界面解析日志文案。
- 失败路径不得删除诊断文件、旧版本或用户配置。
- 注释只解释非显然约束、兼容原因和失败恢复策略。

## 项目事实源

- `dsh-desktop/lib/desktop/*.ts`：TypeScript 是事实源，同名 `.js` 是就地编译产物。
- `tauri-shell/sidecar/*.ts`：TypeScript 是事实源，同名 `.js` 由构建生成。
- `tauri-shell/src/main.rs`：Rust 壳事实源。
- `dsh-desktop/assets/plugins/**`：可能是自研源码、第三方源码或预构建产物，修改前先看包来源和许可证。
- Electron 壳链（`main.js` / `preload.js` / `electron-builder.yml`）已随 5.1.x 瘦身退役删除；窗口桥单源 = `dsh-desktop/assets/ws-jsonrpc-client.js` + `tauri-shell/sidecar/bridge.ts`（build.rs 拼装注入）。

## 受控依赖补丁

- 原则上不直接维护 `node_modules/@deepseek-ai/**`；当前批准的例外以 `dsh-desktop/scripts/patch-deps.js` 为补丁事实源。
- 修改补丁时必须同步检查 `tauri-shell/scripts/stage-resources.mjs` 的重放顺序和明确保留的 vendored 覆盖。
- 受控 vendored 文件不是普通项目源码，不得顺带格式化、类型迁移或重写导出结构。
- 完整维护与验证流程见 `dependency-patches.md`。

## 文本契约

部分测试直接读取源码文本。修改符号、路径、单行注册表或文件扩展名前先运行：

```powershell
rg "<文件名或关键锚点>" dsh-desktop/test
```

不要把文本契约测试全部改成更宽松的正则来掩盖行为变化。

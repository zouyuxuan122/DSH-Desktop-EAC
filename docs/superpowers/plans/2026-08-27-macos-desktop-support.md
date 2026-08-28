# macOS 桌面支持实施计划（Deepseek Harness EAC, arm64）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Deepseek Harness EAC 增加 macOS (Apple Silicon/arm64) 本地桌面版 `.app`，沿用 L1 Tauri + L2 sidecar + L3 dsh 三层架构，照搬仓库内 Linux 移植的 Adapter 模式。

**Architecture:** L1 Tauri 2 壳（WKWebView）只补 darwin 版三个原生动作（open / osascript 通知 / pbcopy）；L2 平台 Adapter 加 darwin 分支；L3 `@deepseek-ai/dsh` 零改动。所有改动走 cfg/Adapter 分支，最小 diff，保持 upstream 可合并。

**Tech Stack:** TypeScript (node:test, tsc), Rust (Tauri 2, tokio), Node 24（随包 vendor/node）, npm, `@tauri-apps/cli@2`。

## Global Constraints

- 首发仅 arm64（Apple Silicon）；路径与命令不写死 arch，未来可加 x64。
- macOS 13.0+（`bundle.macOS.minimumSystemVersion = "13.0"`）。
- 本机构建、无签名公证、无 CI；产物 `.app`（主）与 `.dmg`（可选）。
- 不得修改 L3 `@deepseek-ai/*` 任何代码。
- 与全局 CLI 共享 `~/.dsh`（`DSH_HOME`），桌面端 profile 为 `web-desktop`。
- 能力语义必须诚实：`supported / degraded / external-dependency / unavailable`，不伪装成功。
- 客户端自更新（client-update）在 darwin 整体关闭；dsh agent 更新（updater.ts overlay）完整保留。
- 上游 merge-friendly：改动只走 cfg / Adapter 分支，不动 Windows/Linux 既有行为。
- 测试运行必须用 **Node >= 24**（test-runner 硬性要求）：统一用 `vendor/node/node vendor/npm/bin/npm-cli.js` 执行 npm 脚本（下文以 `$N24` 代指）。

---

## 任务总览与文件结构

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| Task 0 | 基线验证：macOS 上现有代码跑通（Node 24 vendor + 构建 + 原生模块 + boot-smoke） | — |
| Task 1 | `platform.ts` darwin Adapter（TDD） | Task 0 |
| Task 2 | `main.rs` darwin 三函数分支 + AppleScript 转义（TDD） | Task 0 |
| Task 3 | `rescue-integration.ts` 诊断 zip darwin（TDD） | Task 0 |
| Task 4 | `client-update.ts` darwin 关闭更新流程（TDD） | Task 0 |
| Task 5 | `stage-resources.mjs` darwin 装配 + 裁剪模块（TDD + 全量装配验证） | Task 0、1 |
| Task 6 | macOS 打包配置 + icns + `.app` 构建与审计 | Task 2、5 |
| Task 7 | 验收冒烟清单（手动，含退出零孤儿） | Task 6 |

Task 1–4 相互独立，可并行；Task 5 需 Task 0 的构建产物；Task 6 需 Task 2 与 Task 5。

---

### Task 0: 基线验证——macOS 上现有代码跑通

**Files:**
- Create: `dsh-desktop/vendor/node/node`、`dsh-desktop/vendor/npm/`（gitignore 内，不提交）
- 无源码改动。发现基线问题先修复并回报，不进入 Task 1。

**Interfaces:**
- Produces: 可用的 `$N24` 运行时、`dsh-desktop/` 编译产物（lib/**/*.js、tauri-shell/sidecar/*.js）、`dsh-desktop/native/{supervisor,snapshot}/index.node`（darwin-arm64）。

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd ~/dsh-eac-macos/dsh-desktop
npm install
```
Expected: 成功（`.npmrc` 含 legacy-peer-deps；darwin-arm64 可选依赖 koffi/sharp/node-pty 已随装）。postinstall 的 `patch-deps.js` 若在 macOS 报错被 `|| exit 0` 吞掉——记录但继续。

- [ ] **Step 2: 装配 Node 24 vendor 运行时**（系统 Node 22 不满足 test-runner 的 >= 24 门槛）

Run:
```bash
cd ~/dsh-eac-macos/dsh-desktop
mkdir -p vendor/node vendor/npm
curl -fsSL -o /tmp/node24.tar.gz https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz
tar -xzf /tmp/node24.tar.gz -C /tmp
cp /tmp/node-v24.20.0-darwin-arm64/bin/node vendor/node/node && chmod 755 vendor/node/node
cp -R /tmp/node-v24.20.0-darwin-arm64/lib/node_modules/npm vendor/npm/
```
Expected: `vendor/node/node --version` → `v24.20.0`。
（curl 若超时，加 `-x http://127.0.0.1:7890` 走本机代理。）

- [ ] **Step 3: 编译 TypeScript**

Run:
```bash
N24="vendor/node/node vendor/npm/bin/npm-cli.js"
$N24 run typecheck && $N24 run build
```
Expected: 0 error；`lib/desktop/*.js` 与 `tauri-shell/sidecar/*.js` 产物生成。

- [ ] **Step 4: 构建两个原生模块（darwin-arm64）**

Run:
```bash
$N24 run build:native                        # supervisor：cargo build --release → index.node
$N24 exec -- node scripts/build-native.js build snapshot   # snapshot 同理
```
Expected: 两处输出 `[build-native] …/libdsh_{supervisor,snapshot}_native.dylib -> …/index.node`。
（`build-native.ts` 已含 darwin 分支：非 win32 不启用 lld-link，产物按 `lib*.dylib` 查找——上游为 Linux 移植预埋，**零改动**。）

- [ ] **Step 5: 跑全量测试基线**

Run:
```bash
$N24 test
```
Expected: 全绿或仅少量已知平台跳过（Windows 专属测试自带 skip 守卫，Linux CI 同套测试全绿，macOS 应一致）。若有 darwin 相关失败，修复后再继续。

- [ ] **Step 6: boot-smoke——sidecar 独立跑通 dsh 启动链**

Run:
```bash
cd ~/dsh-eac-macos && node boot-smoke.js
```
Expected: 临时 DSH_HOME 下 sidecar 启动 → `dsh web: http://127.0.0.1:<port>` → HTTP 探活 200 → 优雅关停零残留。

无提交（vendor 不入库）。注意：`native/{supervisor,snapshot}/index.node` 上游跟踪的是 Windows PE 二进制，darwin 重建后工作区保持 modified、**不提交**；`node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js` 被 npm install 覆盖后执行 `git checkout -- <file>` 恢复跟踪版本。

---

### Task 6-fix: 资源根定位支持 macOS bundle 与开发态布局（TDD）

**Files:**
- Modify: `tauri-shell/src/main.rs`

**Interfaces:**
- Consumes: Task 6 产物（打包后的 .app 与 `--bridge-test` 自检入口）。
- Produces: 打包态 `resource_root()` 命中 `Contents/Resources/`；开发态 `sidecar_script()` 命中 `tauri-shell/sidecar/server.js`；Windows/Linux 打包态行为逐字不变。

- [ ] **Step 1: RED 证据（Task 6 已产出）**

打包二进制 `--bridge-test` 输出：`[bridge] sidecar = /Users/mac/dsh-eac-macos/sidecar/server.js`（不存在）；双击 .app 时 sidecar 从未 spawn、用户数据目录从未创建。根因：`resource_root()`（main.rs:53-83）只探测 exe 同级 `sidecar/` 与 `resources/`，macOS 大小写敏感文件系统下 `Contents/Resources` 不命中，回退开发布局探测命中仓库根，但 `sidecar_script()`（main.rs:84-86）拼 `sidecar/` 而非 `tauri-shell/sidecar/`。

- [ ] **Step 2: 实现 resource_root 的 macOS bundle 探测**

在 `resource_root()` 的 `resources` 探测之后插入（Windows/Linux 打包态探测顺序不变）：

```rust
            // macOS bundle 布局：Contents/MacOS/<bin> → Contents/Resources/。
            #[cfg(target_os = "macos")]
            if let Some(contents) = dir.parent() {
                let mac_res = contents.join("Resources");
                if mac_res.join("sidecar").join("server.js").exists() {
                    return mac_res;
                }
            }
```

- [ ] **Step 3: 实现 sidecar_script 的开发态回退**

```rust
fn sidecar_script() -> std::path::PathBuf {
    let root = resource_root();
    let packaged = root.join("sidecar").join("server.js");
    if packaged.exists() {
        return packaged;
    }
    // 开发态（仓库根布局）：sidecar 编译产物位于 tauri-shell/sidecar/。
    root.join("tauri-shell").join("sidecar").join("server.js")
}
```

（打包态三平台资源根均含 `sidecar/server.js`，第一分支保持逐字不变的旧行为；开发态仓库根无 `sidecar/`，落到 tauri-shell 分支。）

- [ ] **Step 4: 验证**

Run:
```bash
cd ~/dsh-eac-macos/tauri-shell && cargo test && cargo check   # 编译通过
./target/release/dsh-eac-shell --bridge-test                  # 开发态：sidecar = …/tauri-shell/sidecar/server.js（存在）
npx -y @tauri-apps/cli@2 build                                # 重建 bundle（数分钟，勿中断）
APP="target/release/bundle/macos/Deepseek Harness EAC.app"
"$APP/Contents/MacOS/dsh-eac-shell" --bridge-test             # 打包态：sidecar = …/Contents/Resources/sidecar/server.js（存在）
open "$APP" && sleep 8 && pgrep -fl sidecar                   # sidecar 进程 spawn
```
Expected: 两次 bridge-test 的 sidecar 路径均存在；open 后 sidecar 进程出现、`~/Library/Application Support/deepseek-harness-eac/logs/` 被创建；退出后 `killall dsh-eac-shell` 零残留。

- [ ] **Step 5: Commit**

```bash
git add tauri-shell/src/main.rs
git commit -m "fix(darwin): resource_root 支持 macOS bundle Resources 与开发态 sidecar 定位"
```

---

### Task 0-fix: 基线测试 darwin 兼容修复（TDD）

**Files:**
- Modify: `dsh-desktop/test/sidecar-platform.test.ts`、`dsh-desktop/test/watchdog-behavior.test.ts`

**Interfaces:**
- Consumes: Task 0 基线产物（vendor Node 24）。
- Produces: macOS 上全量测试 0 失败（695 pass + 2 修复 = 697 pass，8 skip 保持 Windows 守卫）。

- [ ] **Step 1: RED 证据（已由 Task 0 跑出）**

失败 1：`test/sidecar-platform.test.ts:40` `assert.equal(info.platform, 'linux')`——sidecar 在 macOS 上如实返回 `darwin`。
失败 2：`test/watchdog-behavior.test.ts:106` 非 win32 分支硬编码 `/bin/true`，macOS 上不存在（只有 `/usr/bin/true`），`existsSync` 断言失败。

- [ ] **Step 2: 修复 watchdog 测试**

`watchdog-behavior.test.ts` 中：

```ts
  const exe = process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe')
    : process.platform === 'darwin' ? '/usr/bin/true' : '/bin/true';
```

- [ ] **Step 3: 修复 sidecar-platform 测试**

`sidecar-platform.test.ts` 中 `assert.equal(info.platform, 'linux');` 改为：

```ts
    assert.equal(info.platform, process.platform);
```

（`userDataDir` 断言在 darwin 上暂仍走 XDG fallback 故保持通过；Task 1 实现 darwin 数据目录后会随 Task 1 的调度上下文同步更新本测试，见 Task 1 备注。）

- [ ] **Step 4: 恢复 vendored 文件并运行验证**

Run:
```bash
cd ~/dsh-eac-macos
git checkout -- dsh-desktop/node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js
cd dsh-desktop && vendor/node/node vendor/npm/bin/npm-cli.js test
```
Expected: 697 pass / 8 skip / 0 fail，输出无异常噪音。

- [ ] **Step 5: Commit**

```bash
git add dsh-desktop/test/sidecar-platform.test.ts dsh-desktop/test/watchdog-behavior.test.ts
git commit -m "test(darwin): 基线测试 darwin 兼容——platform 断言与 /usr/bin/true"
```

（`index.node` 平台二进制保持未提交。）

---

### Task 1: `platform.ts` darwin Adapter（TDD）

**Files:**
- Modify: `dsh-desktop/lib/desktop/platform.ts`
- Test: `dsh-desktop/test/platform.test.ts`

**Interfaces:**
- Consumes: `createDesktopPlatform(options)` / `nodeExecutableName(platform)` / `pluginCapabilityDetails(platform)` 现有签名（`DesktopPlatformOptions` 不变）。
- Produces（darwin 下）:
  - `userDataDir()` → `<homeDir>/Library/Application Support/deepseek-harness-eac`
  - `runtimeExecutableName()` → `'node'`
  - `capabilities()` → `{ clipboard: 'supported', clientSelfUpdate: 'external-handoff', computerUser: 'unavailable', processFence: 'degraded', plugins: { computerUser: 'unavailable', ocr: 'external-dependency', dafeiyu: 'unavailable' } }`
  - `pluginCapabilityDetails('darwin')` → `computer-user` 与 `picturereader` 的 reason 提及 v1.5。

- [ ] **Step 1: 写失败测试**（追加到 `test/platform.test.ts` 末尾）

```ts
test('macOS desktop platform uses ~/Library/Application Support and POSIX Node runtime name', () => {
  const platform = createDesktopPlatform({
    platform: 'darwin',
    env: {},
    homeDir: '/Users/alice',
  });

  assert.equal(platform.userDataDir(), '/Users/alice/Library/Application Support/deepseek-harness-eac');
  assert.equal(platform.runtimeExecutableName(), 'node');
  assert.equal(nodeExecutableName('darwin'), 'node');
  assert.equal(platform.capabilities().clipboard, 'supported');
  assert.equal(platform.capabilities().clientSelfUpdate, 'external-handoff');
  assert.equal(platform.capabilities().processFence, 'degraded');
  assert.deepEqual(platform.capabilities().plugins, {
    computerUser: 'unavailable',
    ocr: 'external-dependency',
    dafeiyu: 'unavailable',
  });
});

test('macOS plugin capability reasons mention the v1.5 plan', () => {
  const details = pluginCapabilityDetails('darwin');
  assert.equal(details['computer-user'].status, 'unavailable');
  assert.match(details['computer-user'].reason, /v1\.5/);
  assert.equal(details.picturereader.status, 'external-dependency');
});
```

（文件顶部 import 补 `pluginCapabilityDetails`。）

- [ ] **Step 2: 运行验证失败**

Run: `$N24 test -- test/platform.test.ts`（cwd `dsh-desktop`）
Expected: FAIL——`userDataDir()` 现走 XDG fallback（`~/.config/...`）与断言不符。

- [ ] **Step 3: 最小实现**

`platform.ts` 的 `userDataDir` 在 linux 分支之后、fallback 之前插入：

```ts
    if (platform === 'darwin') {
      // macOS 惯例：~/Library/Application Support/<app>（不经 XDG fallback）。
      return path.join(homeDir, 'Library', 'Application Support', 'deepseek-harness-eac');
    }
```

`capabilities()` 的 clipboard 三元链插入 darwin 臂：

```ts
    clipboard: platform === 'win32'
      ? 'supported'
      : platform === 'linux' && (commandExists('wl-copy') || commandExists('xclip') || commandExists('xsel'))
        ? 'supported'
        : platform === 'darwin'
          ? 'supported' // pbcopy/pbpaste 为 macOS 内置
          : platform === 'linux' ? 'external-dependency' : 'unavailable',
```

`pluginCapabilityDetails` 在 win32 分支之后插入：

```ts
  if (platform === 'darwin') {
    return {
      'computer-user': { status: 'unavailable', reason: 'macOS v1.5 计划：CGEvent + TCC 授权' },
      picturereader: { status: 'external-dependency', reason: 'OCR 需 Python (paddle/rapid)，v1.5 计划 Vision 后端' },
      'dsh-dafeiyu': { status: 'unavailable', reason: '无 macOS helper 产物' },
    };
  }
```

（`clientSelfUpdate`、`processFence`、`computerUser`、`plugins` 的非 win32 默认值已正确，无需改动。）

- [ ] **Step 4: 运行验证通过**

Run: `$N24 test -- test/platform.test.ts` → PASS；再 `$N24 test` → 全绿；`$N24 run typecheck` → 0 error。

- [ ] **Step 5: Commit**

```bash
git add dsh-desktop/lib/desktop/platform.ts dsh-desktop/test/platform.test.ts
git commit -m "feat(darwin): 平台 Adapter——macOS 数据目录、剪贴板与插件能力声明"
```

---

### Task 2: `main.rs` darwin 三函数分支（TDD）

**Files:**
- Modify: `tauri-shell/src/main.rs`

**Interfaces:**
- Consumes: `run_bounded_command`、`run_clipboard_command`（同文件现有签名，不变）。
- Produces: `escape_apple_script_string(s: &str) -> String`（`#[cfg(target_os = "macos")]`，仅本文件使用）；darwin 下 `open_native_target` / `show_system_notification` / `write_clipboard_text` 三个函数返回 Ok。

- [ ] **Step 1: 写失败测试**（追加到 `main.rs` 末尾）

```rust
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::escape_apple_script_string;

    #[test]
    fn escapes_backslashes_and_quotes() {
        assert_eq!(escape_apple_script_string("a\\b\"c"), "a\\\\b\\\"c");
    }

    #[test]
    fn leaves_plain_text_unchanged() {
        assert_eq!(escape_apple_script_string("hello 世界"), "hello 世界");
    }
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cd ~/dsh-eac-macos/tauri-shell && cargo test`
Expected: FAIL——编译错误：`escape_apple_script_string` 未找到。

- [ ] **Step 3: 最小实现**

（1）文件顶部区域（`is_safe_external_url` 附近）添加：

```rust
/// AppleScript 字符串转义：反斜杠与双引号（osascript 通知文案用）。
#[cfg(target_os = "macos")]
fn escape_apple_script_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}
```

（2）`open_native_target` 在 linux 块之后、fallback 块之前插入：

```rust
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(target);
        return run_bounded_command(command, "open").await;
    }
```

（3）`show_system_notification` 在 linux 块之后插入：

```rust
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escape_apple_script_string(body),
            escape_apple_script_string(title)
        );
        let mut command = Command::new("osascript");
        command.args(["-e", &script]);
        return run_bounded_command(command, "osascript notification").await;
    }
```

（4）`write_clipboard_text` 在 linux 块之后插入：

```rust
    #[cfg(target_os = "macos")]
    {
        return run_clipboard_command("pbcopy", &[], text).await;
    }
```

- [ ] **Step 4: 运行验证通过**

Run:
```bash
cd ~/dsh-eac-macos/tauri-shell
cargo test && cargo check
```
Expected: 全部通过（darwin 主机上 cfg(macos) 生效；fallback 块的 `let _ = …` 在新平台仍编译通过）。
（不跑 clippy -D warnings：与 Linux CI 门槛一致仅 check；上游既有代码的 clippy 风格不在本任务范围。）

- [ ] **Step 5: Commit**

```bash
git add tauri-shell/src/main.rs
git commit -m "feat(darwin): L1 壳——open / osascript 通知 / pbcopy 剪贴板 macOS 分支"
```

---

### Task 3: 诊断 zip darwin 分支（TDD）

**Files:**
- Modify: `tauri-shell/sidecar/rescue-integration.ts`
- Test: Create `dsh-desktop/test/rescue-zip-command.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces: `buildZipCommand(platform: NodeJS.Platform, logsDir: string, zip: string): { program: string; args: string[] }`（从 `rescue-integration.js` 导出；win32 返回 PowerShell `Compress-Archive`（行为零回归），darwin 返回 `ditto`）。

- [ ] **Step 1: 写失败测试**（新文件 `dsh-desktop/test/rescue-zip-command.test.ts`）

```ts
// 诊断 zip 平台化命令：darwin 用内置 ditto；win32 保持 PowerShell 行为零回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZipCommand } from '../tauri-shell/sidecar/rescue-integration.js';

test('darwin 诊断 zip 使用 ditto 归档 logs 目录', () => {
  const cmd = buildZipCommand('darwin', '/tmp/logs', '/tmp/out.zip');
  assert.equal(cmd.program, 'ditto');
  assert.deepEqual(cmd.args, ['-c', '-k', '/tmp/logs', '/tmp/out.zip']);
});

test('win32 诊断 zip 保持 PowerShell Compress-Archive 原命令', () => {
  const cmd = buildZipCommand('win32', 'C:\\logs', 'C:\\out.zip');
  assert.equal(cmd.program, 'powershell');
  assert.deepEqual(cmd.args, [
    '-NoProfile',
    '-Command',
    'Compress-Archive -Path "C:\\logs\\*" -DestinationPath "C:\\out.zip" -Force',
  ]);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `$N24 test -- test/rescue-zip-command.test.ts`（cwd `dsh-desktop`）
Expected: FAIL——`buildZipCommand` 不是导出（`SyntaxError: The requested module does not provide an export`）。

- [ ] **Step 3: 最小实现**

`rescue-integration.ts`：在 `exportLogs` 上方添加纯函数，并改造 `exportLogs` 使用它。

```ts
/** 平台化诊断 zip 命令（纯函数，便于跨平台测试）。
 * 说明：darwin 的 ditto 归档 logs 目录本体，与 Windows `logs\*` 的内容级
 * 打包存在目录层级差异——对诊断用途无影响；ditto 为 macOS 内置零依赖。 */
export function buildZipCommand(
  platform: NodeJS.Platform,
  logsDir: string,
  zip: string,
): { program: string; args: string[] } {
  if (platform === 'darwin') {
    return { program: 'ditto', args: ['-c', '-k', logsDir, zip] };
  }
  return {
    program: 'powershell',
    args: ['-NoProfile', '-Command',
      `Compress-Archive -Path "${logsDir}\\*" -DestinationPath "${zip}" -Force`],
  };
}
```

`exportLogs` 中替换原有 spawn 块：

```ts
    const cmd = buildZipCommand(process.platform, logsDir, zip);
    await new Promise<void>((resolve) => {
      const ps = cp.spawn(cmd.program, cmd.args, { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    if (!fs.existsSync(zip)) return { ok: false, error: '打包失败' };
    if (process.platform === 'darwin') {
      cp.exec(`open "${path.dirname(zip).replace(/"/g, '')}"`, () => {});
    } else {
      cp.exec(`start "" "${path.dirname(zip).replace(/"/g, '')}"`, { windowsHide: true }, () => {});
    }
```

- [ ] **Step 4: 运行验证通过**

Run: `$N24 test -- test/rescue-zip-command.test.ts` → PASS；`$N24 test` → 全绿（含既有 `rescue-integration.test.ts` 接线测试）。

- [ ] **Step 5: Commit**

```bash
git add tauri-shell/sidecar/rescue-integration.ts dsh-desktop/test/rescue-zip-command.test.ts
git commit -m "feat(darwin): 诊断 zip 用 ditto 打包 + open 打开目录（win32 行为零回归）"
```

---

### Task 4: 客户端更新流程 darwin 关闭（TDD）

**Files:**
- Modify: `dsh-desktop/lib/desktop/client-update.ts`
- Test: Create `dsh-desktop/test/client-update-darwin.test.ts`

**Interfaces:**
- Consumes: `init(d: ClientUpdateCtx)`、`runClientUpdateFlow(manual: boolean)`（现有导出签名不变）。
- Produces: darwin 上 `runClientUpdateFlow` 在任何调用点（定时器/手动）都静默返回，不弹窗不联网。dsh agent 更新（`updater.ts`）不受影响。

- [ ] **Step 1: 写失败测试**（新文件 `dsh-desktop/test/client-update-darwin.test.ts`）

```ts
// macOS v1：上游 Release 无 macOS 资产，客户端更新流程整体关闭。
// dsh agent 更新（updater.ts overlay）不经过本模块，不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, runClientUpdateFlow } from '../lib/desktop/client-update.js';

test('darwin 上 runClientUpdateFlow 直接返回，不触发任何 UI', async () => {
  let boxes = 0;
  init({
    log: () => {},
    showBox: async () => { boxes += 1; return { response: 0 }; },
    isQuitting: () => false,
    getAppVersion: () => '5.1.0',
    getUserDataDir: () => '/tmp/dsh-eac-darwin-test',
    getDshHome: () => null,
    getPlatform: () => 'darwin',
    openExternal: async () => true,
    showUpdateWindow: () => null,
    makeUpdateProgressPusher: () => ({ client: () => {}, agent: () => {}, force: () => {} }),
    prepareQuitForClientUpdate: async () => {},
    exitProcess: () => {},
    getExecDir: () => '/tmp/dsh-eac-darwin-test',
  });
  await runClientUpdateFlow(true);
  assert.equal(boxes, 0);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `$N24 test -- test/client-update-darwin.test.ts`（cwd `dsh-desktop`）
Expected: FAIL——darwin 路径继续执行到 `updCtx()`，因 runtime-paths 未 init 抛 `TypeError`。

- [ ] **Step 3: 最小实现**

`client-update.ts` 的 `runClientUpdateFlow` 在 `isQuitting` 检查后插入守卫：

```ts
export async function runClientUpdateFlow(manual: boolean): Promise<void> {
  if (mod.isQuitting()) return;
  // macOS v1：上游 Release 无 macOS 资产，客户端更新整体关闭（恢复
  // external-handoff 需上游发布 macOS 包，届时删除本守卫即可）。
  if (mod.getPlatform() === 'darwin') return;
  if (clientUpdateBusy) {
```

- [ ] **Step 4: 运行验证通过**

Run: `$N24 test -- test/client-update-darwin.test.ts` → PASS；`$N24 test` → 全绿（win32 相关既有测试不受影响）。

- [ ] **Step 5: Commit**

```bash
git add dsh-desktop/lib/desktop/client-update.ts dsh-desktop/test/client-update-darwin.test.ts
git commit -m "feat(darwin): macOS v1 关闭客户端自更新检查（dsh agent 更新保留）"
```

---

### Task 5: `stage-resources.mjs` darwin 装配（TDD + 全量装配）

**Files:**
- Create: `tauri-shell/stage-platform-prune.mjs`（纯函数模块，独立文件以便测试——`stage-resources.mjs` 无 main guard，import 即执行，不可直接 import）
- Modify: `tauri-shell/stage-resources.mjs`
- Test: Create `dsh-desktop/test/stage-platform-prune.test.ts`

**Interfaces:**
- Consumes: 无（纯 Node fs）。
- Produces（导出自 `stage-platform-prune.mjs`）:
  - `isMachO(file: string): boolean`（读取失败返回 false；识别 64 位小端 Mach-O 魔数 `cf fa ed fe`）
  - `pruneDarwinPayloads(dir: string): void`（递归删除 `.exe`/`.dll` 与非 Mach-O 的 `.node`，清空空目录）
  - `pruneNonDarwinPrebuilds(dir: string): void`（`prebuilds/` 下只保留 `darwin-arm64`）

- [ ] **Step 1: 写失败测试**（新文件 `dsh-desktop/test/stage-platform-prune.test.ts`）

```ts
// darwin payload 裁剪纯函数测试（stage-resources.mjs 装配期使用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isMachO,
  pruneDarwinPayloads,
  pruneNonDarwinPrebuilds,
} from '../tauri-shell/stage-platform-prune.mjs';

const MACHO64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00]);

test('isMachO 识别 64 位小端 Mach-O 魔数，缺失文件返回 false', () => {
  assert.equal(isMachO('/nonexistent-file'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const macho = path.join(dir, 'a.node');
  const elf = path.join(dir, 'b.node');
  fs.writeFileSync(macho, MACHO64);
  fs.writeFileSync(elf, ELF);
  assert.equal(isMachO(macho), true);
  assert.equal(isMachO(elf), false);
});

test('pruneDarwinPayloads 删除 exe/dll 与非 Mach-O .node，保留 Mach-O .node 和普通文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'empty-dir'));
  fs.writeFileSync(path.join(dir, 'keep.node'), MACHO64);
  fs.writeFileSync(path.join(dir, 'drop-elf.node'), ELF);
  fs.writeFileSync(path.join(dir, 'tool.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'lib.dll'), 'MZ');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'text');
  fs.writeFileSync(path.join(dir, 'nested', 'keep2.node'), MACHO64);
  pruneDarwinPayloads(dir);
  assert.equal(fs.existsSync(path.join(dir, 'keep.node')), true);
  assert.equal(fs.existsSync(path.join(dir, 'drop-elf.node')), false);
  assert.equal(fs.existsSync(path.join(dir, 'tool.exe')), false);
  assert.equal(fs.existsSync(path.join(dir, 'lib.dll')), false);
  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(dir, 'nested', 'keep2.node')), true);
  assert.equal(fs.existsSync(path.join(dir, 'empty-dir')), false);
});

test('pruneNonDarwinPrebuilds 只保留 darwin-arm64 目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilds-'));
  const pre = path.join(dir, 'node_modules', 'node-pty', 'prebuilds');
  fs.mkdirSync(pre, { recursive: true });
  for (const p of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
    fs.mkdirSync(path.join(pre, p), { recursive: true });
  }
  fs.writeFileSync(path.join(pre, 'darwin-arm64', 'pty.node'), MACHO64);
  pruneNonDarwinPrebuilds(path.join(dir, 'node_modules'));
  assert.deepEqual(fs.readdirSync(pre), ['darwin-arm64']);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `$N24 test -- test/stage-platform-prune.test.ts`（cwd `dsh-desktop`）
Expected: FAIL——`stage-platform-prune.mjs` 不存在（`ERR_MODULE_NOT_FOUND`）。

- [ ] **Step 3: 最小实现——新建 `tauri-shell/stage-platform-prune.mjs`**

```js
'use strict';
// darwin payload 裁剪（stage-resources.mjs 装配期使用）。
// 独立模块：stage-resources.mjs 无 main guard，import 即执行全量装配，
// 纯函数放这里供 node:test 直接导入。
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** 是否为 64 位小端 Mach-O（.node 在 macOS 上为 Mach-O dylib）。 */
export function isMachO(file) {
  try {
    const data = readFileSync(file);
    return data.length >= 4
      && data[0] === 0xcf && data[1] === 0xfa && data[2] === 0xed && data[3] === 0xfe;
  } catch {
    return false;
  }
}

export function pruneDarwinPayloads(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneDarwinPayloads(file);
      if (readdirSync(file).length === 0) rmSync(file, { recursive: true, force: true });
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(?:exe|dll)$/i.test(entry.name) || (/\.node$/i.test(entry.name) && !isMachO(file))) {
      rmSync(file, { force: true });
    }
  }
}

export function pruneNonDarwinPrebuilds(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (entry.name === 'prebuilds') {
      for (const platformDir of readdirSync(child, { withFileTypes: true })) {
        if (platformDir.isDirectory() && platformDir.name !== 'darwin-arm64') {
          rmSync(path.join(child, platformDir.name), { recursive: true, force: true });
        }
      }
    } else {
      pruneNonDarwinPrebuilds(child);
    }
  }
}
```

- [ ] **Step 4: 运行验证通过（单元）**

Run: `$N24 test -- test/stage-platform-prune.test.ts` → PASS。

- [ ] **Step 5: 接入 `stage-resources.mjs`**

（1）import 区追加：

```js
import { isMachO, pruneDarwinPayloads, pruneNonDarwinPrebuilds } from './stage-platform-prune.mjs';
```

（2）用法注释与目标校验：

```js
// 用法：node stage-resources.mjs [--target=win32|linux|darwin] [--skip-npm]
…
if (targetPlatform !== 'win32' && targetPlatform !== 'linux' && targetPlatform !== 'darwin') {
  throw new Error(`[stage] 不支持目标平台: ${targetPlatform}`);
}
```

（3）vendor node chmod 条件放宽：

```js
if (targetPlatform === 'linux' || targetPlatform === 'darwin') {
  chmodSync(path.join(staged, 'dsh-desktop', 'vendor', 'node', runtimeName), 0o755);
}
```

（4）在 linux 裁剪块之后追加 darwin 裁剪块：

```js
if (targetPlatform === 'darwin') {
  console.log('[stage] 移除 Darwin 不可达的 Windows/Linux payload');
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'plugins', 'computer-user'), { recursive: true, force: true });
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'plugins', 'dsh-dafeiyu'), { recursive: true, force: true });
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'agent-presets'), { recursive: true, force: true });
  pruneDarwinPayloads(path.join(staged, 'dsh-desktop', 'assets'));
  pruneNonDarwinPrebuilds(nmDest);
  pruneDarwinPayloads(nmDest);
}
```

- [ ] **Step 6: 全量装配验证**

Run:
```bash
cd ~/dsh-eac-macos
node tauri-shell/stage-resources.mjs --target=darwin
```
Expected: 装配完成；随后验证树：
```bash
STAGED=tauri-shell/staged-resources
test -x "$STAGED/dsh-desktop/vendor/node/node" && echo node-ok
find "$STAGED" \( -name '*.exe' -o -name '*.dll' \) | wc -l        # → 0
ls "$STAGED/dsh-desktop/node_modules/@koromix/"                    # 仅 koffi 与 koffi-darwin-arm64
ls "$STAGED/dsh-desktop/node_modules/node-pty/prebuilds/"          # 仅 darwin-arm64
```
Expected: node-ok；0 个 exe/dll；koromix 目录无 win32/linux 包；prebuilds 仅 darwin-arm64。

- [ ] **Step 7: Commit**

```bash
git add tauri-shell/stage-platform-prune.mjs tauri-shell/stage-resources.mjs dsh-desktop/test/stage-platform-prune.test.ts
git commit -m "feat(darwin): stage-resources 支持 --target=darwin（Mach-O 裁剪 + arm64 prebuilds）"
```

---

### Task 6: macOS 打包配置与 `.app` 构建审计

**Files:**
- Create: `tauri-shell/tauri.macos.conf.json`
- Create: `tauri-shell/icons/icon.icns`（`tauri icon` 生成）
- 产物（不入库）: `tauri-shell/target/release/bundle/macos/*.app` / `.dmg`

**Interfaces:**
- Consumes: Task 5 的 `tauri-shell/staged-resources/`；Task 2 的 main.rs（可编译）。
- Produces: 可双击启动的 `Deepseek Harness EAC.app`。

- [ ] **Step 1: 生成 icns**

Run:
```bash
cd ~/dsh-eac-macos/tauri-shell
npx -y @tauri-apps/cli@2 icon icons/icon.png
```
Expected: `icons/icon.icns` 生成（同时刷新各尺寸 PNG/ICO，同源无差异）。

- [ ] **Step 2: 写 `tauri.macos.conf.json`**（Tauri 2 自动按平台合并，参照 `tauri.linux.conf.json` 先例）

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "targets": [
      "app",
      "dmg"
    ],
    "icon": [
      "icons/icon.icns"
    ],
    "macOS": {
      "minimumSystemVersion": "13.0"
    }
  }
}
```

- [ ] **Step 3: 壳编译检查**

Run: `cd ~/dsh-eac-macos/tauri-shell && cargo check`
Expected: 通过（darwin 主机上 cfg(macos) 分支生效，无 Windows import）。

- [ ] **Step 4: 构建 .app/.dmg**

Run: `cd ~/dsh-eac-macos/tauri-shell && npx -y @tauri-apps/cli@2 build`
Expected: `target/release/bundle/macos/Deepseek Harness EAC.app`（+ dmg）生成。

- [ ] **Step 5: 产物审计**

Run:
```bash
APP="tauri-shell/target/release/bundle/macos/Deepseek Harness EAC.app"
find "$APP" \( -name '*.exe' -o -name '*.dll' \) | wc -l     # → 0
file "$APP/Contents/Resources/dsh-desktop/vendor/node/node" # → Mach-O arm64
ls "$APP/Contents/Resources/"                               # sidecar/ 与 dsh-desktop/ 均在
plutil -p "$APP/Contents/Info.plist" | grep -i identifier   # com.deepseek.dsh.desktop.tauri
```
Expected: 如上注释。

- [ ] **Step 6: 首次启动冒烟**

Run: `open "tauri-shell/target/release/bundle/macos/Deepseek Harness EAC.app"`，随后 `pgrep -fl "dsh|node"` 观察。
Expected: 主窗出现并加载 Web UI（若首次未加载，查看 `~/Library/Application Support/deepseek-harness-eac/logs/`）。托盘图标此时为彩色缩略（可接受）；如显示异常，后续可加 `icon_as_template(true)` 配单色模板 PNG——记入 Task 7 观察项，不改代码。
注：菜单栏托盘外观属打磨项，不在本任务硬验收内。

- [ ] **Step 7: Commit**

```bash
git add tauri-shell/tauri.macos.conf.json tauri-shell/icons/icon.icns
git commit -m "feat(darwin): macOS 打包配置（.app/.dmg、icns、最低 13.0）"
```

---

### Task 7: 验收冒烟清单（手动执行，逐项勾选）

**Files:**
- Create: `docs/macos-smoke-report.md`（验收记录，提交入库）

**Interfaces:**
- Consumes: Task 6 的 `.app`。

- [ ] **Step 1: 桌面集成**
  - [ ] 双击 `Deepseek Harness EAC.app` 启动，主窗加载 Web UI（无终端窗口）
  - [ ] 菜单栏托盘图标出现，点击弹菜单：显示/隐藏、恢复中心、重启服务、反馈、退出可用
  - [ ] Dock 图标显示，Cmd+Q 可退出
- [ ] **Step 2: 原生三件套**
  - [ ] 会话里让 dsh 生成一个文件 → 文件树中"在访达中打开"正常（`open` 路径）
  - [ ] 复制一段文本 → 剪贴板为 `pbcopy` 写入（粘贴验证）
  - [ ] 长任务完成后收到系统通知（osascript 弹通知）
- [ ] **Step 3: 功能抽查**
  - [ ] 终端标签页可用（`sh -i`），better-sidebar PTY 打开无崩
  - [ ] 皮肤切换（任选 2 款）、插件市场安装/卸载一个插件
  - [ ] 余额显示、文件树/行级 diff/一键还原
  - [ ] 与 CLI 共存：CLI 创建的会话在桌面端可见（共享 `~/.dsh`）
- [ ] **Step 4: 退出零孤儿**
  - [ ] Cmd+Q 后 `pgrep -fl "dsh|node" | grep -v pgrep` 无 EAC 相关残留
  - [ ] 关窗（不退出）→ 托盘仍在 → 托盘退出 → 同上无残留
- [ ] **Step 5: 写验收记录并提交**

在 `docs/macos-smoke-report.md` 记录每项结果与截图（如需要），然后：

```bash
git add docs/macos-smoke-report.md
git commit -m "docs(darwin): macOS 验收冒烟记录"
```

---

## 任务间接口速查

| 生产者 | 消费者 | 契约 |
| --- | --- | --- |
| Task 1 `platform.ts` | Task 5 装配、运行时 | darwin capabilities：clipboard supported / clientSelfUpdate external-handoff / processFence degraded |
| Task 2 `main.rs` | Task 6 构建 | `escape_apple_script_string`（cfg macos）；三函数 darwin 分支 |
| Task 3 `buildZipCommand` | 测试、`exportLogs` | `(platform, logsDir, zip) => { program, args }` |
| Task 4 守卫 | server.ts 定时器/手动触发 | `runClientUpdateFlow` 在 darwin 静默返回 |
| Task 5 `stage-platform-prune.mjs` | stage-resources、测试 | `isMachO / pruneDarwinPayloads / pruneNonDarwinPrebuilds` |

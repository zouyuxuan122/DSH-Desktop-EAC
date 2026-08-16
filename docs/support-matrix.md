# Linux 支持矩阵与 glibc 基线

> 适用范围：Deepseek Harness EAC 桌面客户端的 Linux 打包（pacman / deb / rpm / AppImage）。
> 本文定义官方支持的发行版窗口、glibc 兼容性基线、node-pty 原生模块的低 glibc 构建流程，
> 以及发版前的验证清单。

## 1. 支持窗口

官方支持 **2025-01-01 至 2026-08-15 之间发布的系统**（以发行版主版本发布时间为准）。

| 发行版 | 发布时间 | glibc |
| --- | --- | --- |
| Ubuntu 25.04 / 25.10 | 2025-04 / 2025-10 | 2.41 |
| Debian 13 trixie | 2025-08 | 2.41 |
| Fedora 42 / 43 | 2025-04 / 2025-10 | 2.41+ |
| RHEL 10 / AlmaLinux 10 / Rocky 10 | 2025-06 起 | 2.41 |
| openSUSE Leap 16.0 | 2025-07 | ≥ 2.39（发布时确认） |
| Ubuntu 26.04 / Fedora 44 / Arch（滚动） | 2026 | 2.42 |

窗口内新版本的最低 glibc 为 **2.41**；保留余量后，官方基线定为 **glibc 2.34**
（见下节，由 Debian 12 编译基线实测得出）。

## 2. 各运行时组件的 glibc 要求

| 组件 | 最高 GLIBC 引用 | 说明 |
| --- | --- | --- |
| Electron 43 主程序 | 2.25 | 无压力 |
| 捆绑 node v24.19.0 | 2.28 | 应用的真实下限 |
| jieba / sqlite-vec / sharp / koffi | 2.14 – 2.17 | npm 预编译产物，老 glibc |
| **node-pty pty.node** | **≤ 2.34（必须）** | **唯一需要低 glibc 编译的组件** |

> 事故记录（2026-08）：node-pty@1.1.0 的 npm 包不带 linux-x64 预编译，安装时由
> node-gyp 现场编译。在 Arch（glibc 2.42）或最新 Ubuntu runner 上编译会绑定新 glibc，
> 导致 Debian 13（2.41）及更老系统启动即崩：`GLIBC_2.42 not found (required by pty.node)`。
> after-pack 与 CI 现在强制 glibc ≤ 2.34 审计（见 `dsh-desktop/scripts/after-pack.js`），
> 超标即构建失败。

## 3. node-pty 低 glibc 构建流程

基线环境：**Debian 12（bookworm，glibc 2.36）chroot + 官方 node v24.19.0**。
实测产物最高引用 `GLIBC_2.34`，可覆盖整个支持窗口（2.41+）并兼容仍在维护的旧 LTS。

```bash
# 宿主机（Arch 示例；任何能跑 debootstrap 的 Linux 均可）
sudo debootstrap --arch=amd64 bookworm /var/lib/dsh-pty-build https://deb.debian.org/debian
sudo mount --bind /proc /var/lib/dsh-pty-build/proc
sudo mount --bind /dev /var/lib/dsh-pty-build/dev
sudo cp /etc/resolv.conf /var/lib/dsh-pty-build/etc/resolv.conf

# 官方 node v24.19.0（⚠️ 绝不要用 Debian 自带 nodejs：
# 它的 node-gyp 会链接 libnode.so.108，产物在目标机无法加载）
curl -sL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz | \
  sudo tar -xJ -C /var/lib/dsh-pty-build/usr/local --strip-components=1

# chroot 内编译（npm 11 默认拦 install scripts，故手动跑 node-gyp）
sudo chroot /var/lib/dsh-pty-build bash -c '
  export PATH=/usr/local/bin:$PATH
  mkdir -p /build && cd /build && npm init -y >/dev/null
  npm install node-pty@1.1.0 --ignore-scripts
  cd node_modules/node-pty
  node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild
'
# 产物：/var/lib/dsh-pty-build/build/node_modules/node-pty/build/Release/pty.node
```

### 产物验证三连（全过才算数）

```bash
PTY=<产物路径>/pty.node
# ① glibc 上限 ≤ 2.34
objdump -T "$PTY" | grep -o 'GLIBC_[0-9.]*' | sort -V | tail -1
# ② 不得链接 libnode
objdump -p "$PTY" | grep NEEDED        # 只应有 libstdc++ / libgcc_s / libc
# ③ 捆绑 node 可加载（N-API 兼容）
resources/node/node -e "const p=require(process.argv[1]); if(typeof p.spawn!=='function') process.exit(2); console.log('OK')" "$PTY"
```

### 替换与打包

```bash
cp <验证通过产物> dsh-desktop/node_modules/node-pty/build/Release/pty.node
cd dsh-desktop && npm run dist:deb && npm run dist:rpm && npm run dist:appimage && npm run dist:arch
```

## 4. 自动审计

- `dsh-desktop/scripts/after-pack.js`：`auditNodePty()` 在打包时检查 pty.node 存在性、
  捆绑 node 可加载性，以及 **glibc 上限 ≤ 2.34**（超标直接 fail 构建）。
- `.github/workflows/build-arch-pacman.yml`：CI 在 debian:12 容器中重编 pty.node，
  并在 pacman 归档层面复核 glibc（最后一道防线）。
- `dsh-desktop/test/node-pty-audit.test.mjs`：覆盖审计逻辑（含 glibc 阈值）的单元测试。

## 5. 发版验证清单

1. `npm test` 全绿；`git diff --check` 无空白错误。
2. `objdump -T` 扫描打包产物中全部 `.node` / `.so`，最高 GLIBC ≤ 2.34。
3. `ldd` 检查 Electron / 捆绑 node / 各原生模块，无 `not found`。
4. Debian 13 VM 实测：安装 → 启动 → Web UI HTTP 200 → 终端页真实可用（node-pty 生效）。
5. 按支持窗口抽测：Debian 12 / Ubuntu 24.04 容器各跑一遍（deb 包）。
6. pacman 归档检查：`.PKGINFO`、`.MTREE`、`.INSTALL`、desktop 入口、图标、可执行文件、捆绑运行时齐全。

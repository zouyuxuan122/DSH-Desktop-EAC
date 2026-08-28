# 更新日志

本文件记录 dsh-unified-market 对外可见的变更。

## 0.3.1

- 修复功能包 CLI 定位失败的误导性报错：0.3.0 及之前，「桌面壳未注入
  `DSH_DESKTOP_RESOURCE_ROOT`」与「CLI 文件不存在（客户端安装不完整或版本
  过旧）」两种失败统一误报"缺少 DSH_DESKTOP_RESOURCE_ROOT"，用户在桌面端
  却被提示去桌面端，排障困难。
- 现 `packCliStatus()` 区分两种原因并给出可行动提示（升级 / 重装桌面客户端），
  `pack.*` 全部方法同步使用新文案。

## 0.3.0

- 新增「📦 功能包」tab 与 `pack.*` host 方法：EAC 功能包（.dshpack）的交互编排层
  （安装 / 卸载 / 更新 / 导出 / 回滚 / 市场浏览 + 官方内核兼容扫描联动）。
- `SELF_VERSION` 与 package.json 同步至 0.3.0。
- 针对 DSH Desktop（EAC）5.1 与 dsh 0.1.1-rc.2 完成专项适配测试。

## 0.2.1

- 修复 README 编码问题（去除 BOM、修正 mojibake）。

## 0.2.0

- 三源合一：精选目录（awesome-dsh-plugin.com）+ GitHub `dsh-plugin` 生态 + npm registry。
- EAC 适配：web-desktop profile 解析链（DSH_DESKTOP_PROFILE → DSH_PROFILE → web）、
  文件锁排队与启动消费、link → 上游接管、24h 保护期、更新进度窗口。

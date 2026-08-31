// 设置视图：实例目录 / 网络 / 外观 / 数据。

import { h } from "../ui/dom";
import { state, setState } from "../core/store";
import { api, sys } from "../core/api";
import type { Settings } from "../core/types";
import { toast } from "../ui/feedback";
import { confirmModal } from "../ui/feedback";

export function renderSettings(host: HTMLElement): () => void {
  const head = h("div", { class: "page-head" });
  const body = h("div", { class: "page-body" });
  host.append(head, body);

  head.innerHTML = `
    <div class="ghostly">CFG</div>
    <div class="row">
      <div><h1>设置</h1><div class="sub">目录 · 网络 · 外观</div></div>
      <div class="spacer"></div>
    </div>
    <div class="rule"></div>`;

  const save = async (patch: Partial<Settings>) => {
    if (!state.settings) return;
    const next = { ...state.settings, ...patch };
    setState({ settings: next });
    try {
      await api.setSettings(next);
    } catch (e) {
      toast("保存失败", String(e), "err");
    }
  };

  const section = (no: string, title: string) => {
    const s = h("div", { class: "set-section" });
    s.append(h("h2", {}, h("span", { class: "no" }, no), title));
    body.append(s);
    return s;
  };

  const row = (name: string, desc: string, ctl: HTMLElement) =>
    h("div", { class: "set-row" },
      h("div", { class: "s-info" },
        h("div", { class: "s-name" }, name),
        h("div", { class: "s-desc" }, desc),
      ),
      h("div", { class: "s-ctl" }, ctl),
    );

  // ---- 01 存储 ----
  const s1 = section("01", "存储");
  const rootText = h("span", { class: "path-text", title: state.settings?.instanceRoot ?? "" }, state.settings?.instanceRoot ?? "");
  s1.append(
    row("实例存储目录", "所有实例的程序与数据都存放在此目录下", h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
      rootText,
      h("button", {
        class: "btn small",
        onClick: async () => {
          const picked = await sys.pickFolder("选择实例存储目录", state.settings?.instanceRoot ?? "");
          if (picked) {
            await save({ instanceRoot: picked });
            rootText.textContent = picked;
            rootText.title = picked;
            toast("已更新", "新实例将安装到该目录（已有实例不受影响）");
          }
        },
      }, "更改"),
    )),
    row("删除前确认", "删除实例时弹出确认弹窗", toggle(state.settings?.confirmDelete ?? true, (v) => void save({ confirmDelete: v }))),
  );

  // ---- 02 网络 ----
  const s2 = section("02", "网络");
  const mirrorInput = h("input", {
    class: "input",
    value: state.settings?.mirrorPrefix ?? "",
    placeholder: "留空直连，例如 https://ghproxy.cn/",
    onChange: () => {
      const v = (mirrorInput as HTMLInputElement).value.trim();
      void save({ mirrorPrefix: v });
      toast("镜像已更新", v === "" ? "直连 GitHub" : v);
    },
  }) as HTMLInputElement;
  const seg = (opts: { v: string; label: string }[], cur: string, onPick: (v: string) => void) => {
    const wrap = h("div", { class: "theme-toggle" });
    for (const o of opts) {
      const b = h("button", {
        class: cur === o.v ? "on" : "",
        onClick: () => {
          onPick(o.v);
          wrap.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
        },
      }, o.label);
      wrap.append(b);
    }
    return wrap;
  };
  const regSeg = seg(
    [
      { v: "https://registry.npmjs.org", label: "NPM 官方" },
      { v: "https://registry.npmmirror.com", label: "NPMMIRROR" },
    ],
    state.settings?.npmRegistry ?? "https://registry.npmjs.org",
    (v) => {
      void save({ npmRegistry: v });
      toast("npm 源已切换", v);
    },
  );
  s2.append(
    row("下载镜像前缀", "GitHub 产物下载加速（ghproxy 等），留空则直连", mirrorInput),
    row("npm registry", "插件安装使用的 npm 源", regSeg),
  );

  // ---- 03 外观 ----
  const s3 = section("03", "外观");
  const themeT = h("div", { class: "theme-toggle" });
  const mkThemeBtn = (v: "dark" | "light", label: string) => {
    const b = h("button", { class: state.settings?.theme === v ? "on" : "", onClick: () => {
      void save({ theme: v });
      document.documentElement.setAttribute("data-theme", v);
      themeT.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    } }, label);
    return b;
  };
  themeT.append(mkThemeBtn("dark", "墨 DARK"), mkThemeBtn("light", "纸 LIGHT"));
  s3.append(
    row("主题", "墨（深色）/ 纸（浅色）双主题", themeT),
    row("减弱动效", "关闭非线性动画，保留功能", toggle(state.settings?.reduceMotion ?? false, (v) => {
      void save({ reduceMotion: v });
      document.body.classList.toggle("reduce-motion", v);
    })),
  );

  // ---- 04 数据 ----
  const s4 = section("04", "数据");
  const dirsBtn = h("div", { style: { display: "flex", gap: "8px" } });
  s4.append(row("启动器数据", "注册表、市场缓存与下载缓存所在目录", dirsBtn));
  void api.appDirs().then((d) => {
    dirsBtn.append(
      h("button", { class: "btn small ghost", onClick: () => void sys.openPath(d.dataDir) }, "打开数据目录"),
      h("button", { class: "btn small ghost", onClick: () => void sys.openPath(d.cacheDir) }, "打开下载缓存"),
    );
  });

  // ---- 05 关于 ----
  const s5 = section("05", "关于");
  s5.append(
    row("EAC LAUNCHER", "DSH EAC 多实例启动器 · v1.0.0", h("span", { class: "mono faint" }, "Tauri 2 + TypeScript")),
    row("上游项目", "Deepseek Harness EAC（揽尽万象）", h("button", {
      class: "btn small ghost",
      onClick: () => window.open("https://github.com/zouyuxuan122/DSH-Desktop-EAC", "_blank"),
    }, "GitHub ↗")),
    row("插件生态", "dsh-plugins 社区", h("button", {
      class: "btn small ghost",
      onClick: () => window.open("https://github.com/dsh-plugins", "_blank"),
    }, "GitHub ↗")),
    row("危险操作", "清空启动器全部注册信息（不删除实例文件）", h("button", {
      class: "btn small ghost danger",
      onClick: async () => {
        const ok = await confirmModal({
          title: "重置注册表",
          body: "将移除启动器的实例注册信息。实例磁盘文件不会被删除；被移除的实例之后无法在启动器中管理（可手动删除目录）。",
          confirmText: "重置",
          danger: true,
        });
        if (ok) toast("占位", "此功能将在下个版本提供");
      },
    }, "重置注册表")),
  );

  function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
    const el = h("div", { class: `switch ${on ? "on" : ""}`, onClick: () => {
      const now = !el.classList.contains("on");
      el.classList.toggle("on", now);
      onChange(now);
    } }, h("i"));
    return el;
  }

  return () => undefined;
}

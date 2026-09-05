// 应用外壳：标题栏（自定义窗口控制）+ 侧栏导航 + 视图路由。
// 视图渲染器返回清理回调，内部自行订阅状态做局部更新。

import { h } from "./ui/dom";
import { icons } from "./ui/icons";
import { state, setState, subscribe, type ViewId, runningCount } from "./core/store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { renderHome } from "./views/home";
import { renderSafety } from "./views/safety";
import { renderMarket } from "./views/market";
import { renderTasks } from "./views/tasks";
import { renderSettings } from "./views/settings";
import { toast } from "./ui/feedback";

const NAV: { id: ViewId; label: string; cn: string; icon: keyof typeof icons }[] = [
  { id: "home", label: "INSTANCES", cn: "实例库", icon: "grid" },
  { id: "safety", label: "SAFETY", cn: "安全中心", icon: "shield" },
  { id: "market", label: "MARKET", cn: "插件市场", icon: "market" },
  { id: "tasks", label: "TRANSFER", cn: "传输", icon: "activity" },
  { id: "settings", label: "SETTINGS", cn: "设置", icon: "sliders" },
];

export type Renderer = (host: HTMLElement) => void | (() => void);

let viewHost: HTMLElement | null = null;
let currentView: HTMLElement | null = null;
let cleanup: (() => void) | void;
let currentViewId: ViewId | null = null;

export function buildShell(root: HTMLElement): void {
  const win = getCurrentWindow();
  const titlebar = h("div", { class: "titlebar" },
    h("div", { class: "brand" },
      h("div", { class: "mark" }, h("i"), h("i"), h("i")),
    ),
    h("div", { class: "title-mid" },
      h("span", { class: "word" }, "EAC LAUNCHER · DSH EAC 多实例启动器"),
    ),
    h("div", { class: "winctl" },
      h("button", { onClick: () => void win.minimize(), title: "最小化" }, h("span", { innerHTML: icons.min })),
      h("button", { onClick: () => void win.toggleMaximize(), title: "最大化" }, h("span", { innerHTML: icons.max })),
      h("button", { class: "close", onClick: () => void win.close(), title: "关闭" }, h("span", { innerHTML: icons.close })),
    ),
  );

  const navBtns = new Map<ViewId, HTMLButtonElement>();
  const nav = h("div", { class: "nav" });
  for (const n of NAV) {
    const b = h("button", {
      class: "nav-item",
      onClick: () => setView(n.id),
      title: n.cn,
    }) as HTMLButtonElement;
    b.innerHTML = `<span class="ni" style="display:inline-flex;width:17px;height:17px">${icons[n.icon]}</span><span>${n.label}</span>`;
    navBtns.set(n.id, b);
    nav.append(b);
  }
  const rail = h("div", { class: "rail" },
    nav,
    h("div", { class: "spacer" }),
    (() => {
      // 主题切换器：墨 | 纸 两段式，当前主题高亮
      const foot = h("div", { class: "rail-foot" });
      const seg = h("div", { class: "theme-seg", title: "主题：墨（深色）/ 纸（浅色）" });
      const btnDark = h("button", { title: "墨（深色）" }, "墨") as HTMLButtonElement;
      const btnLight = h("button", { title: "纸（浅色）" }, "纸") as HTMLButtonElement;
      const paint = () => {
        const cur = state.settings?.theme ?? "dark";
        btnDark.classList.toggle("on", cur === "dark");
        btnLight.classList.toggle("on", cur === "light");
      };
      const apply = async (next: "dark" | "light") => {
        document.documentElement.setAttribute("data-theme", next);
        if (state.settings) {
          const s = { ...state.settings, theme: next };
          setState({ settings: s });
          try { await import("./core/api").then((m) => m.api.setSettings(s)); } catch { /* 静默 */ }
        }
        paint();
      };
      btnDark.addEventListener("click", () => void apply("dark"));
      btnLight.addEventListener("click", () => void apply("light"));
      paint();
      seg.append(btnDark, btnLight);
      foot.append(seg);
      return foot;
    })(),
  );

  viewHost = h("div", { class: "view-host" });
  const ticker = h("div", { class: "ticker" },
    h("span", { class: "tag" }, "SYS"),
    h("span", { class: "msg", id: "ticker-msg" }, "就绪"),
  );

  root.append(titlebar, h("div", { class: "shell" }, rail, h("div", { class: "stage" }, viewHost, ticker)));

  subscribe(() => {
    for (const [id, b] of navBtns) b.classList.toggle("active", state.view === id);
    for (const n of NAV) {
      const b = navBtns.get(n.id)!;
      b.querySelector(".nav-badge")?.remove();
      if (n.id === "tasks") {
        const active = state.tasks.filter((t) => t.state === "active").length;
        if (active > 0) b.append(h("span", { class: "nav-badge" }, String(active)));
      }
      if (n.id === "safety") {
        const warn = state.instances.filter(
          (i) => (i.failStreak ?? 0) >= 2 || i.updateAvailable || (i.quarantine?.length ?? 0) > 0,
        ).length;
        if (warn > 0) b.append(h("span", { class: "nav-badge" }, String(warn)));
      }
    }
    const msg = document.getElementById("ticker-msg");
    if (msg) {
      const active = state.tasks.filter((t) => t.state === "active");
      if (active.length > 0) {
        msg.textContent = active.map((t) => `${t.label} · ${t.message}`).join("   |   ");
        msg.style.color = "var(--paper)";
      } else {
        const run = runningCount();
        msg.textContent = run > 0 ? `${run} 个实例运行中 · DSH_HOME 隔离` : "就绪";
        msg.style.color = "";
      }
    }
  });

  setView("home");
}

export function setView(id: ViewId): void {
  if (state.view === id && currentView) return;
  setState({ view: id, drawerId: null });
  if (!viewHost) return;
  swapView(id);
}

export function refreshCurrentView(): void {
  if (currentViewId && viewHost) swapView(currentViewId, true);
}

function swapView(id: ViewId, soft = false): void {
  const renderers: Record<ViewId, Renderer> = {
    home: renderHome,
    safety: renderSafety,
    market: renderMarket,
    tasks: renderTasks,
    settings: renderSettings,
  };
  if (cleanup) {
    try { cleanup(); } catch { /* noop */ }
    cleanup = undefined;
  }
  const old = currentView;
  if (old) {
    old.classList.add("exit");
    setTimeout(() => old.remove(), 260);
  }
  const el = h("div", { class: "view enter" });
  cleanup = renderers[id](el);
  viewHost!.append(el);
  if (!soft) {
    [...el.children].forEach((c, i) => (c as HTMLElement).style.setProperty("--i", String(i)));
  } else {
    el.classList.remove("enter");
  }
  currentView = el;
  currentViewId = id;
}

window.addEventListener("unhandledrejection", (e) => {
  const reason = String(e.reason ?? "未知错误");
  if (reason.includes("__CANCELLED__")) return;
  toast("错误", reason, "err");
});

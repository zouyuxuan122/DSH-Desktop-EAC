// 入口：字体与样式 → 启动屏 → 初始化 → 外壳。

import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/views.css";

import { api, onTaskUpdate, onInstanceEvent } from "./core/api";
import { hydrate, setState, state, subscribe, upsertTask } from "./core/store";
import { buildShell, refreshCurrentView } from "./app";
import { openWizard } from "./views/onboard";
import { toast } from "./ui/feedback";
import { h } from "./ui/dom";
import { installMock } from "./core/mock";

// 浏览器直开（无 Tauri 运行时）时挂载演示桩
if (!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) {
  installMock();
}

function splash(): HTMLElement {
  const el = h("div", { class: "boot grain" },
    h("div", { class: "bars" }, h("i"), h("i"), h("i"), h("i")),
    h("div", { class: "word" }, "EAC LAUNCHER"),
    h("div", { class: "line" }, h("i")),
  );
  document.body.append(el);
  return el;
}

async function boot(): Promise<void> {
  const sp = splash();

  let cfg;
  try {
    cfg = await api.getState();
  } catch (e) {
    sp.remove();
    document.body.append(
      h("div", { style: { padding: "40px", color: "var(--danger)", fontFamily: "var(--font-mono)" } },
        "后端初始化失败: " + String(e)),
    );
    return;
  }
  hydrate(cfg);

  // 主题与动效偏好
  if (cfg.settings.theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  }
  document.body.classList.toggle("reduce-motion", cfg.settings.reduceMotion);

  buildShell(document.getElementById("app")!);

  // 新实例向导（按钮触发）
  let wizardCloser: (() => void) | null = null;
  subscribe(() => {
    if (state.wizardOpen && !wizardCloser) {
      setState({ wizardOpen: false });
      const realClose = openWizard("add");
      wizardCloser = () => {
        realClose();
        wizardCloser = null;
      };
    }
  });

  // 事件订阅
  void onTaskUpdate((t) => {
    upsertTask(t);
    // 任务完结时兜底刷新实例状态（防止个别事件丢失导致 UI 滞后）
    if (t.state !== "active" && t.instanceId) {
      void api.getState().then((c) => {
        const stale = c.instances.find((i) => i.id === t.instanceId);
        const cur = state.instances.find((i) => i.id === t.instanceId);
        if (stale && cur && (stale.status !== cur.status || stale.exePath !== cur.exePath)) {
          setState({ instances: c.instances });
        }
      });
    }
  });
  void onInstanceEvent("instance:ready", async (id) => {
    const c = await api.getState();
    hydrate(c);
    const inst = c.instances.find((i) => i.id === id);
    toast("安装完成", `${inst?.name ?? id} 已就绪`);
    refreshCurrentView();
  });
  void onInstanceEvent("instance:error", async (id) => {
    const c = await api.getState();
    hydrate(c);
    const inst = c.instances.find((i) => i.id === id);
    toast("安装失败", inst?.errorMessage ?? id, "err");
    refreshCurrentView();
  });

  // 运行状态轮询
  const poll = async () => {
    for (const inst of state.instances) {
      if (inst.status !== "ready") continue;
      try {
        const r = await api.isInstanceRunning(inst.id);
        if (!!state.running[inst.id] !== r) {
          setState({ running: { ...state.running, [inst.id]: r } });
        }
      } catch {
        /* 忽略轮询错误 */
      }
    }
  };
  void poll();
  setInterval(() => void poll(), 4000);

  // 首次运行 → 引导向导
  const enter = () => {
    sp.classList.add("leaving");
    setTimeout(() => sp.remove(), 700);
    if (!cfg.settings.onboarded || cfg.instances.length === 0) {
      openWizard(cfg.settings.onboarded ? "add" : "first");
    }
  };
  setTimeout(enter, 1250);

  // 启动屏结束再显示窗口，避免白闪
  void (await import("@tauri-apps/api/window")).getCurrentWindow().show();
}

void boot();

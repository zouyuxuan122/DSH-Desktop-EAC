// 实例库视图：规格表行 + 详情抽屉 + 脉冲线。

import { h } from "../ui/dom";
import { ico } from "../ui/icons";
import { pulseWidget } from "../ui/pulse";
import { state, subscribe, setState, instanceById } from "../core/store";
import { api, sys } from "../core/api";
import { fmtBytes, fmtDate, relTime } from "../core/format";
import type { InstanceMeta, InstalledPlugin } from "../core/types";
import { toast, confirmModal, promptModal } from "../ui/feedback";
import { setView, refreshCurrentView } from "../app";

export function renderHome(host: HTMLElement): () => void {
  let pulse = pulseWidget("VITALS / 实例脉搏");
  let listWrap: HTMLElement;
  let headWrap: HTMLElement;

  const build = () => {
    host.innerHTML = "";
    pulse = pulseWidget();

    headWrap = h("div", { class: "page-head" });
    host.append(headWrap, h("div", { class: "page-body", id: "home-body" }));
    buildHead();
    listWrap = host.querySelector("#home-body")!;
    buildList();
    // 脉冲线入场后再挂载
    setTimeout(() => pulse.mount(), 120);
  };

  const buildHead = () => {
    headWrap.innerHTML = "";
    const n = state.instances.length;
    const run = Object.values(state.running).filter(Boolean).length;
    headWrap.append(
      h("div", { class: "ghostly" }, String(n + 1).padStart(2, "0")),
      h("div", { class: "row" },
        h("div", {},
          h("h1", {}, "实例库"),
          h("div", { class: "sub" }, "多版本 · 多实例 · DSH_HOME 完全隔离"),
        ),
        h("div", { class: "spacer" }),
        pulse.root,
        h("div", { class: "actions" },
          h("button", {
            class: "btn solid",
            onClick: () => setState({ wizardOpen: true }),
          }, ico("plus"), "新实例"),
        ),
      ),
      h("div", { class: "rule" }),
      h("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "8px" } },
        h("span", { class: "mono faint" }, `${n} 个实例 · ${run} 个运行中`),
        h("span", { class: "mono faint" }, state.settings?.instanceRoot ?? ""),
      ),
    );
  };

  const buildList = () => {
    const keepScroll = listWrap.scrollTop;
    listWrap.innerHTML = "";
    if (state.instances.length === 0) {
      listWrap.append(
        h("div", { class: "empty-frame" },
          h("div", { class: "big" }, "init"),
          h("h3", { style: { fontWeight: "640", fontSize: "17px" } }, "还没有任何实例"),
          h("p", {}, "从上游 Release 下载完整版或 Lite 版，创建你的第一个 DSH EAC 实例。每个实例拥有独立的程序目录与 DSH_HOME 数据目录。"),
          h("button", {
            class: "btn solid",
            style: { marginTop: "8px" },
            onClick: () => setState({ wizardOpen: true }),
          }, ico("download"), "开始安装向导"),
        ),
      );
      return;
    }
    const grid = h("div", { class: "inst-list" });
    state.instances.forEach((inst, i) => grid.append(row(inst, i)));
    listWrap.append(grid);
    listWrap.scrollTop = keepScroll;
  };

  const row = (inst: InstanceMeta, i: number): HTMLElement => {
    const running = !!state.running[inst.id];
    const size = state.sizeCache[inst.id];
    const st = statusBlock(inst, running);
    const ops = h("div", { class: "ops" });
    if (running) {
      ops.append(h("button", {
        class: "btn small",
        onClick: (e) => { e.stopPropagation(); void doStop(inst); },
      }, ico("stop"), "停止"));
    } else if (inst.status === "ready") {
      ops.append(h("button", {
        class: "btn small solid",
        onClick: (e) => { e.stopPropagation(); void doLaunch(inst); },
      }, ico("play"), "启动"));
    } else if (inst.status === "error") {
      ops.append(h("button", {
        class: "btn small",
        onClick: (e) => { e.stopPropagation(); void doRetry(inst); },
      }, ico("refresh"), "重试安装"));
    } else {
      ops.append(h("span", { class: "mono faint" }, "安装中…"));
    }
    ops.append(h("button", {
      class: "btn small ghost",
      title: "详情 / 插件",
      onClick: (e) => { e.stopPropagation(); setState({ drawerId: inst.id }); },
    }, ico("arrow")));

    const el = h("div", { class: `inst-row ${state.drawerId === inst.id ? "active" : ""}` },
      h("div", { class: "idx" }, String(i + 1).padStart(2, "0")),
      h("div", { class: "meta" },
        h("div", { class: "name" },
          h("span", { class: "nm" }, inst.name),
          h("span", { class: "chip" }, inst.edition === "lite" ? "LITE" : "FULL"),
          h("span", { class: "chip on" }, inst.tag),
        ),
        h("div", { class: "path" }, inst.appDir),
      ),
      h("div", { class: "meta" },
        h("div", { class: "path" }, size != null ? fmtBytes(size) : "计算中…"),
        h("div", { class: "path" }, `创建 ${fmtDate(inst.createdAt)}`),
      ),
      st,
      ops,
    );
    el.addEventListener("click", () => setState({ drawerId: inst.id }));
    return el;
  };

  const statusBlock = (inst: InstanceMeta, running: boolean): HTMLElement => {
    if (running) {
      return h("div", { class: "status" }, h("i", { class: "dot run" }), h("span", {}, "运行中"));
    }
    if (inst.status === "installing") {
      return h("div", { class: "status" }, h("i", { class: "dot installing" }), h("span", {}, "安装中"));
    }
    if (inst.status === "error") {
      return h("div", { class: "status", title: inst.errorMessage ?? "" },
        h("i", { class: "dot err" }), h("span", {}, "安装失败"));
    }
    return h("div", { class: "status" }, h("i", { class: "dot ready" }),
      h("span", { class: "dim" }, `就绪 · ${relTime(inst.lastLaunchedAt)}`));
  };

  // ---- 动作 ----
  const doLaunch = async (inst: InstanceMeta) => {
    try {
      await api.launchInstance(inst.id);
      toast("已启动", `${inst.name} 正在启动，窗口稍后弹出`, "info");
      setState({
        running: { ...state.running, [inst.id]: true },
        instances: state.instances.map((x) =>
          x.id === inst.id
            ? { ...x, lastLaunchedAt: Date.now(), launchCount: x.launchCount + 1 }
            : x,
        ),
      });
    } catch (e) {
      toast("启动失败", String(e), "err");
    }
  };
  const doStop = async (inst: InstanceMeta) => {
    try {
      await api.stopInstance(inst.id);
      setState({ running: { ...state.running, [inst.id]: false } });
      toast("已停止", `${inst.name} 的进程树已结束`);
    } catch (e) {
      toast("停止失败", String(e), "err");
    }
  };
  const doRetry = async (inst: InstanceMeta) => {
    try {
      await api.retryInstanceInstall(inst.id);
      toast("重新安装", "已重新排队下载");
      refreshCurrentView();
    } catch (e) {
      toast("失败", String(e), "err");
    }
  };

  const doDelete = async (inst: InstanceMeta) => {
    const ok = await confirmModal({
      title: "删除实例",
      body: `将永久删除「${inst.name}」及其全部数据（程序 + DSH_HOME）：

${inst.dir}

此操作不可撤销。`,
      confirmText: "永久删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteInstance(inst.id);
      toast("已删除", inst.name);
      setState({ instances: state.instances.filter((x) => x.id !== inst.id), drawerId: null });
      refreshCurrentView();
    } catch (e) {
      toast("删除失败", String(e), "err");
    }
  };

  // ---- 抽屉 ----
  const drawerEl = h("div", {});
  const renderDrawer = () => {
    drawerEl.innerHTML = "";
    const inst = state.drawerId ? instanceById(state.drawerId) : undefined;
    if (!inst) return;
    const running = !!state.running[inst.id];

    const body = h("div", { class: "d-body" });
    const head = h("div", { class: "d-head" },
      h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
        h("span", { class: "chip" }, inst.edition === "lite" ? "LITE" : "FULL"),
        h("span", { class: "chip on" }, inst.tag),
        h("div", { class: "spacer", style: { flex: 1 } }),
        h("button", { class: "btn ghost small", title: "关闭", onClick: () => setState({ drawerId: null }) }, ico("x")),
      ),
      h("h2", { style: { fontSize: "24px", fontWeight: "680", marginTop: "12px", fontVariationSettings: '"wdth" 112' } }, inst.name),
      h("div", { class: "d-tabs" },
        tabBtn("概览", state.drawerTab === "overview", () => setState({ drawerTab: "overview" })),
        tabBtn("插件", state.drawerTab === "plugins", () => setState({ drawerTab: "plugins" })),
      ),
    );

    if (state.drawerTab === "overview") {
      body.append(overviewTab(inst, running, () => void doDelete(inst), () => void doRename(inst), () => void doRetry(inst)));
    } else {
      pluginsTab(body, inst);
    }

    drawerEl.append(
      h("div", { class: "drawer" }, head, body),
    );
  };

  const doRename = async (inst: InstanceMeta) => {
    const name = await promptModal({ title: "重命名实例", value: inst.name });
    if (!name || name === inst.name) return;
    try {
      await api.renameInstance(inst.id, name);
      setState({ instances: state.instances.map((x) => (x.id === inst.id ? { ...x, name } : x)) });
      refreshCurrentView();
    } catch (e) {
      toast("失败", String(e), "err");
    }
  };

  const overviewTab = (
    inst: InstanceMeta,
    running: boolean,
    onDelete: () => void,
    onRename: () => void,
    onRetry: () => void,
  ): HTMLElement => {
    const wrap = h("div", {}, ...kvRow("状态", running ? "运行中" : inst.status === "ready" ? "就绪" : inst.status === "installing" ? "安装中" : `安装失败${inst.errorMessage ? " · " + inst.errorMessage : ""}`),
      ...kvRow("版本", `${inst.version}（${inst.tag}）`),
      ...kvRow("主程序", inst.exePath ?? "待安装完成发现"),
      ...kvRow("程序目录", inst.appDir),
      ...kvRow("数据目录", `${inst.dshHome}（DSH_HOME）`),
      ...kvRow("占用", state.sizeCache[inst.id] != null ? fmtBytes(state.sizeCache[inst.id]) : "…"),
      ...kvRow("创建于", fmtDate(inst.createdAt)),
      ...kvRow("最近启动", `${relTime(inst.lastLaunchedAt)} · 共 ${inst.launchCount} 次`),
    ) as HTMLElement;
    wrap.className = "kv";
    const ops = h("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "26px" } });
    if (running) {
      ops.append(h("button", { class: "btn", onClick: () => void doStop(inst) }, ico("stop"), "停止实例"));
    } else if (inst.status === "ready") {
      ops.append(h("button", { class: "btn solid", onClick: () => void doLaunch(inst) }, ico("play"), "启动实例"));
    } else if (inst.status === "error") {
      ops.append(h("button", { class: "btn", onClick: onRetry }, ico("refresh"), "重试安装"));
    }
    ops.append(
      h("button", { class: "btn ghost", onClick: () => void sys.openPath(inst.appDir).catch(() => toast("无法打开", inst.appDir, "err")) }, ico("folder"), "程序目录"),
      h("button", { class: "btn ghost", onClick: () => void sys.openPath(inst.dshHome).catch(() => toast("无法打开", inst.dshHome, "err")) }, ico("folder"), "数据目录"),
      h("button", { class: "btn ghost", onClick: onRename }, ico("edit"), "重命名"),
      h("button", { class: "btn ghost danger", onClick: onDelete }, ico("trash"), "删除"),
    );
    const wrap2 = h("div", {}, wrap, ops);
    wrap2.querySelectorAll(".kv .v").forEach((v) => ((v as HTMLElement).style.wordBreak = "break-all"));
    return wrap2;
  };

  const pluginsTab = (body: HTMLElement, inst: InstanceMeta) => {
    body.append(h("div", { class: "search-line" },
      h("span", { class: "mono faint" }, "已装插件 · web-desktop profile"),
      h("div", { class: "spacer", style: { flex: 1 } }),
      h("button", {
        class: "btn small",
        onClick: () => { setState({ drawerId: null }); setView("market"); },
      }, ico("market"), "去市场安装"),
    ));
    const holder = h("div", {});
    body.append(holder);
    const drawList = (plugs: InstalledPlugin[]) => {
      holder.innerHTML = "";
      if (plugs.length === 0) {
        holder.append(h("div", { class: "empty-frame", style: { margin: "20px 0", padding: "34px" } },
          h("p", {}, "尚未安装任何第三方插件。"),
        ));
        return;
      }
      plugs.forEach((p, i) => {
        holder.append(h("div", { class: "plug-row" },
          h("div", { class: "idx" }, String(i + 1).padStart(2, "0")),
          h("div", {},
            h("div", { class: "p-name" }, p.name,
              h("span", { class: "chip" }, `v${p.version || "?"}`),
              p.isBundle ? h("span", { class: "chip on" }, "BUNDLE") : h("span", { class: "chip" }, "LIB"),
              p.disabled ? h("span", { class: "chip", style: { borderColor: "var(--danger)", color: "var(--danger)" } }, "已停用") : null,
            ),
            h("div", { class: "p-desc mono" }, p.id),
          ),
          h("div", { class: "m-ops" },
            h("button", {
              class: "btn small ghost",
              onClick: async () => {
                try {
                  await api.togglePlugin(inst.id, p.name, !p.disabled);
                  toast(p.disabled ? "已启用" : "已停用", p.name);
                  drawList(await api.listPlugins(inst.id));
                } catch (e) {
                  toast("失败", String(e), "err");
                }
              },
            }, p.disabled ? "启用" : "停用"),
            h("button", {
              class: "btn small ghost danger",
              onClick: async () => {
                const ok = await confirmModal({ title: "卸载插件", body: `${p.name}\n\n将从实例 profile 中移除。`, confirmText: "卸载", danger: true });
                if (!ok) return;
                try {
                  await api.uninstallPlugin(inst.id, p.name);
                  toast("卸载完成", p.name);
                  drawList(await api.listPlugins(inst.id));
                } catch (e) {
                  toast("卸载失败", String(e), "err");
                }
              },
            }, ico("trash"), "卸载"),
          ),
        ));
      });
    };
    api.listPlugins(inst.id)
      .then(drawList)
      .catch((e) => holder.append(h("p", { class: "mono", style: { color: "var(--danger)", marginTop: "14px" } }, String(e))));
  };

  const tabBtn = (label: string, active: boolean, onClick: () => void) =>
    h("button", { class: `d-tab ${active ? "active" : ""}`, onClick }, label);

  const kvRow = (k: string, v: string) => [h("div", { class: "k" }, k), h("div", { class: "v" }, v)];

  // ---- 订阅与生命周期 ----
  build();
  document.body.append(drawerEl);
  const el0 = host.querySelector("#home-body");
  if (el0) {
    // 尺寸懒计算
    for (const inst of state.instances) {
      if (state.sizeCache[inst.id] == null) {
        void api.instanceSize(inst.id).then((n) => {
          setState({ sizeCache: { ...state.sizeCache, [inst.id]: n } });
          buildList();
        });
      }
    }
  }

  const unsub = subscribe(() => {
    // 抽屉开关
    const wantDrawer = !!state.drawerId;
    const hasDrawer = !!drawerEl.querySelector(".drawer");
    if (wantDrawer !== hasDrawer) renderDrawer();
    // 头部数字与列表（轻量重建）
    buildHead();
    buildList();
    if (wantDrawer && hasDrawer) renderDrawer();
  });
  renderDrawer();

  return () => {
    unsub();
    pulse.unmount();
    drawerEl.remove();
  };
}

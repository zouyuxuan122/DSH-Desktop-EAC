// 插件市场视图：dsh-plugin-market 目录 + 目标实例选择 + 安装。

import { h } from "../ui/dom";
import { ico } from "../ui/icons";
import { state, subscribe, setState } from "../core/store";
import { api } from "../core/api";
import type { InstalledPlugin, MarketPlugin } from "../core/types";
import { toast } from "../ui/feedback";

export function renderMarket(host: HTMLElement): () => void {
  let target = state.instances.find((i) => i.status === "ready")?.id ?? "";
  const installedMap = new Map<string, InstalledPlugin[]>();
  let query = "";

  const head = h("div", { class: "page-head" });
  const body = h("div", { class: "page-body" });
  const listHost = h("div", {});
  host.append(head, body);

  const drawHead = () => {
    head.innerHTML = "";
    const ready = state.instances.filter((i) => i.status === "ready");
    const sel = h("select", { class: "select", style: { width: "240px" }, onChange: () => {
      target = (sel as HTMLSelectElement).value;
      void loadInstalled().then(drawRows);
    } }) as HTMLSelectElement;
    if (ready.length === 0) {
      sel.append(h("option", {}, "暂无就绪实例"));
    } else {
      for (const i of ready) {
        const o = h("option", { value: i.id }, `${i.name} · ${i.tag}`) as HTMLOptionElement;
        if (i.id === target) o.selected = true;
        sel.append(o);
      }
      if (!target) target = ready[0].id;
    }
    head.append(
      h("div", { class: "ghostly" }, "MKT"),
      h("div", { class: "row" },
        h("div", {},
          h("h1", {}, "插件市场"),
          h("div", { class: "sub" }, "dsh-plugin-market 社区目录 · 一键装入指定实例"),
        ),
        h("div", { class: "spacer" }),
        h("div", { class: "field", style: { width: "240px" } },
          h("label", {}, "目标实例"),
          sel,
        ),
        h("div", { class: "actions" },
          h("button", { class: "btn ghost", title: "刷新目录", onClick: () => void reload(true) }, ico("refresh")),
        ),
      ),
      h("div", { class: "rule" }),
    );
  };

  const searchWrap = () => {
    const input = h("input", {
      class: "input",
      placeholder: "搜索插件名 / 描述 / npm 包名…",
      value: query,
      onInput: () => {
        query = (input as HTMLInputElement).value.toLowerCase();
        drawRows();
      },
    }) as HTMLInputElement;
    return h("div", { class: "search-line" },
      h("span", { style: { display: "inline-flex", width: "15px", height: "15px", color: "var(--paper-faint)" }, innerHTML: ico("search").innerHTML }),
      input,
      h("span", { class: "mono faint count", id: "mkt-count" }, ""),
    );
  };

  const loadInstalled = async () => {
    if (!target) return;
    if (!installedMap.has(target)) {
      try {
        installedMap.set(target, await api.listPlugins(target));
      } catch {
        installedMap.set(target, []);
      }
    }
  };

  const filtered = (): MarketPlugin[] => {
    const q = query.trim().toLowerCase();
    return state.market.filter((p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.descZh.toLowerCase().includes(q) ||
      p.descEn.toLowerCase().includes(q));
  };

  const installStateOf = (p: MarketPlugin): InstalledPlugin | undefined => {
    const list = installedMap.get(target);
    return list?.find((x) => x.name === p.id || x.id === p.id.split("/").pop());
  };

  const drawRows = () => {
    // 搜索栏只构建一次（避免每次状态变化重建导致输入框失焦），仅重建列表区
    const keepScroll = listHost.scrollTop;
    listHost.innerHTML = "";
    const list = filtered();
    const count = body.querySelector("#mkt-count")!;
    count.textContent = `${list.length} 个插件`;
    listHost.scrollTop = keepScroll;

    if (state.marketState === "loading" && state.market.length === 0) {
      listHost.append(h("div", { class: "empty-frame" }, h("div", { class: "big" }, "…"), h("p", {}, "正在拉取市场目录")));
      return;
    }
    if (state.marketState === "error" && state.market.length === 0) {
      listHost.append(h("div", { class: "empty-frame" },
        h("div", { class: "big", style: { color: "var(--danger)" } }, "404"),
        h("p", {}, state.marketError),
        h("button", { class: "btn small", onClick: () => void reload() }, ico("refresh"), "重试"),
      ));
      return;
    }
    if (state.market.length === 0) return;

    if (!target) {
      listHost.append(h("div", { class: "empty-frame" },
        h("div", { class: "big" }, "—"),
        h("p", {}, "先创建一个就绪的实例，再回来安装插件。"),
      ));
      return;
    }

    const grid = h("div", {});
    list.forEach((p, i) => grid.append(marketRow(p, i)));
    listHost.append(grid);
  };

  const marketRow = (p: MarketPlugin, i: number): HTMLElement => {
    const installed = installStateOf(p);
    const active = state.tasks.find(
      (t) => t.kind === "plugin" && t.state === "active" && t.instanceId === target && t.label.includes(p.id),
    );
    const ops = h("div", { class: "m-ops" });
    if (active) {
      ops.append(h("div", { style: { width: "120px" } },
        h("div", { class: "bar indeterminate" }, h("i", { style: { width: "34%" } })),
        h("div", { class: "mono faint", style: { marginTop: "5px", fontSize: "9px" } }, active.message.slice(0, 26)),
      ));
    } else if (installed) {
      ops.append(h("span", { class: "chip on" }, "已安装"));
      ops.append(h("button", {
        class: "btn small ghost danger",
        onClick: async () => {
          try {
            await api.uninstallPlugin(target, installed.name);
            toast("卸载任务已开始", p.id);
            setTimeout(() => void refreshInstalled(), 800);
          } catch (e) {
            toast("失败", String(e), "err");
          }
        },
      }, "卸载"));
    } else {
      ops.append(h("button", {
        class: "btn small",
        onClick: async () => {
          try {
            await api.installPlugin(target, p.id);
            toast("安装任务已开始", `${p.id} → ${targetName()}`);
            setTimeout(() => void refreshInstalled(), 1200);
          } catch (e) {
            toast("无法安装", String(e), "err");
          }
        },
      }, ico("download"), "装入实例"));
    }
    if (p.repository) {
      ops.append(h("button", {
        class: "btn small ghost",
        title: "打开仓库",
        onClick: () => window.open(p.repository, "_blank"),
      }, ico("external")));
    }
    return h("div", { class: "market-row" },
      h("div", { class: "idx" }, String(i + 1).padStart(2, "0")),
      h("div", {},
        h("div", { class: "m-name" }, p.name,
          h("span", { class: "chip" }, p.supportVersions || "ANY"),
        ),
        h("div", { class: "m-id" }, p.id),
        h("div", { class: "m-desc" }, p.descZh || p.descEn),
      ),
      ops,
    );
  };

  const targetName = () => state.instances.find((x) => x.id === target)?.name ?? target;

  const refreshInstalled = async () => {
    installedMap.delete(target);
    await loadInstalled();
    drawRows();
  };

  const reload = async (force = false) => {
    setState({ marketState: "loading", marketError: "" });
    try {
      const list = await api.fetchMarket(force);
      setState({ market: list, marketState: "ok" });
    } catch (e) {
      setState({ marketState: "error", marketError: String(e) });
    }
    installedMap.clear();
    await loadInstalled();
    drawHead();
    drawRows();
  };

  drawHead();
  // 搜索栏与列表区分离：搜索输入不随状态更新重建
  body.append(searchWrap());
  body.append(listHost);

  if (state.marketState === "idle") void reload();
  else void loadInstalled().then(drawRows);

  const seenDone = new Set<string>();
  const unsub = subscribe(() => {
    // 插件任务完成后刷新已装列表
    for (const t of state.tasks) {
      if (t.kind === "plugin" && t.instanceId === target && t.state !== "active") {
        if (!seenDone.has(t.id)) {
          seenDone.add(t.id);
          void refreshInstalled();
          break;
        }
      }
    }
    // 行内进度刷新
    if (document.body.contains(body)) drawRows();
  });

  return unsub;
}

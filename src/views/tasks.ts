// 传输视图：下载/插件任务队列与历史。

import { h } from "../ui/dom";
import { ico } from "../ui/icons";
import { state, subscribe, setState } from "../core/store";
import { api } from "../core/api";
import { fmtBytes, pct } from "../core/format";
import { toast } from "../ui/feedback";

export function renderTasks(host: HTMLElement): () => void {
  const head = h("div", { class: "page-head" });
  const body = h("div", { class: "page-body" });
  host.append(head, body);

  const drawHead = () => {
    head.innerHTML = "";
    const active = state.tasks.filter((t) => t.state === "active").length;
    head.append(
      h("div", { class: "ghostly" }, "IO"),
      h("div", { class: "row" },
        h("div", {},
          h("h1", {}, "传输"),
          h("div", { class: "sub" }, "实例产物下载 · 插件装卸 · 断点续传"),
        ),
        h("div", { class: "spacer" }),
        h("div", { class: "actions" },
          h("button", {
            class: "btn ghost",
            disabled: state.tasks.every((t) => t.state !== "done" && t.state !== "cancelled" && t.state !== "error"),
            onClick: () => {
              for (const t of state.tasks) {
                if (t.state !== "active") void api.clearTask(t.id).catch(() => undefined);
              }
              setState({ tasks: state.tasks.filter((t) => t.state === "active") });
            },
          }, "清理已完成"),
        ),
      ),
      h("div", { class: "rule" }),
      h("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "8px" } },
        h("span", { class: "mono faint" }, `${state.tasks.length} 条记录 · ${active} 个进行中`),
        h("span", { class: "mono faint" }, ""),
      ),
    );
  };

  const drawRows = () => {
    const keep = body.scrollTop;
    body.innerHTML = "";
    if (state.tasks.length === 0) {
      body.append(h("div", { class: "empty-frame" },
        h("div", { class: "big" }, "quiet"),
        h("p", {}, "没有进行中或历史的传输任务。"),
      ));
      return;
    }
    const grid = h("div", {});
    for (const t of state.tasks) grid.append(taskRow(t));
    body.append(grid);
    body.scrollTop = keep;
  };

  const taskRow = (t: (typeof state.tasks)[number]): HTMLElement => {
    const isDownload = t.kind === "instance" && t.stage === "download";
    const p = t.total > 0 ? pct(t.received, t.total) : 0;
    const inst = t.instanceId ? state.instances.find((i) => i.id === t.instanceId) : undefined;
    const right = h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } });
    if (t.state === "active") {
      if (t.kind === "instance") {
        right.append(h("button", {
          class: "btn small ghost",
          onClick: async () => {
            try {
              await api.cancelTask(t.id);
              toast("已请求取消", t.label);
            } catch (e) {
              toast("失败", String(e), "err");
            }
          },
        }, "取消"));
      }
    } else {
      right.append(h("button", {
        class: "btn small ghost",
        onClick: () => {
          void api.clearTask(t.id).catch((e) => toast("无法移除", String(e), "err"));
          setState({ tasks: state.tasks.filter((x) => x.id !== t.id) });
        },
      }, ico("x"), "移除"));
    }
    return h("div", { class: `task-row ${t.state}` },
      h("div", {},
        h("div", { class: "t-label" },
          h("span", { class: "chip" }, t.kind === "instance" ? "实例" : "插件"),
          t.label,
          inst ? h("span", { class: "chip" }, inst.name) : null,
        ),
        h("div", { class: "t-msg" }, t.message),
      ),
      h("div", {},
        h("div", { class: `bar ${isDownload && t.state === "active" ? "" : t.state === "active" ? "indeterminate" : ""}` },
          h("i", { style: { width: `${t.state === "active" ? (isDownload ? p : 34) : 100}%` } }),
        ),
        h("div", { class: "mono faint", style: { marginTop: "6px", display: "flex", justifyContent: "space-between" } },
          h("span", {}, isDownload && t.total > 0 ? `${fmtBytes(t.received)} / ${fmtBytes(t.total)}` : t.stage),
          h("span", {}, t.state === "active" && isDownload ? `${fmtBytes(t.speedBps)}/s` : stateLabel(t.state)),
        ),
      ),
      right,
    );
  };

  const stateLabel = (s: string) =>
    s === "active" ? "进行中" : s === "done" ? "完成" : s === "error" ? "失败" : "已取消";

  drawHead();
  drawRows();
  const unsub = subscribe(() => {
    drawHead();
    drawRows();
  });
  return unsub;
}

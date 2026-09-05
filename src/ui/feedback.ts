// 提示堆栈 + 确认弹窗 + 版本选择弹窗

import { h } from "./dom";
import type { EditionInfo } from "../core/types";
import { fmtBytes, fmtIsoDate } from "../core/format";

export function toast(title: string, message: string, kind: "info" | "err" = "info"): void {
  let host = document.querySelector(".toasts") as HTMLElement | null;
  if (!host) {
    host = h("div", { class: "toasts" });
    document.body.append(host);
  }
  const el = h("div", { class: `toast ${kind === "err" ? "err" : ""}` },
    h("div", { class: "t" }, title),
    h("div", { class: "m" }, message),
  );
  host.append(el);
  const kill = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener("click", kill);
  setTimeout(kill, 4200);
}

export function confirmModal(opts: {
  title: string;
  body: string;
  confirmText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      ov.remove();
      resolve(v);
    };
    const ov = h("div", {
      class: "overlay",
      onClick: (e: MouseEvent) => {
        if (e.target === ov) done(false);
      },
    },
      h("div", { class: "modal" },
        h("h3", {}, opts.title),
        h("p", {}, opts.body),
        h("div", { class: "foot" },
          h("button", { class: "btn ghost", onClick: () => done(false) }, "取消"),
          h("button", {
            class: `btn ${opts.danger ? "danger" : "solid"}`,
            onClick: () => done(true),
          }, opts.confirmText ?? "确认"),
        ),
      ),
    );
    document.body.append(ov);
  });
}

export function promptModal(opts: {
  title: string;
  body?: string;
  value?: string;
  confirmText?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let input: HTMLInputElement;
    const done = (v: string | null) => {
      ov.remove();
      resolve(v);
    };
    const ov = h("div", {
      class: "overlay",
      onClick: (e: MouseEvent) => {
        if (e.target === ov) done(null);
      },
    },
      h("div", { class: "modal" },
        h("h3", {}, opts.title),
        opts.body ? h("p", {}, opts.body) : null,
        (input = h("input", {
          class: "input",
          value: opts.value ?? "",
          placeholder: "输入名称",
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === "Enter") done(input.value.trim() || null);
          },
        })) as HTMLInputElement,
        h("div", { class: "foot", style: { marginTop: "22px" } },
          h("button", { class: "btn ghost", onClick: () => done(null) }, "取消"),
          h("button", { class: "btn solid", onClick: () => done(input.value.trim() || null) }, opts.confirmText ?? "确认"),
        ),
      ),
    );
    document.body.append(ov);
    setTimeout(() => input?.focus(), 60);
  });
}

/** 版本选择弹窗（升级/降级）：从上游历史 Release 中挑一个 */
export function pickEditionModal(
  instanceName: string,
  list: EditionInfo[],
): Promise<EditionInfo | null> {
  return new Promise((resolve) => {
    const done = (v: EditionInfo | null) => {
      ov.remove();
      resolve(v);
    };
    const rows = list.map((e) => {
      const r = h("button", {
        class: "pick-row",
        onClick: () => done(e),
      },
        h("span", { class: "mono", style: { fontWeight: 600 } }, e.tag),
        h("span", { class: "mono faint", style: { fontSize: "11px" } },
          `${fmtBytes(e.asset.size)} · ${fmtIsoDate(e.publishedAt)}`),
        h("span", { class: "spacer" }),
        h("span", { class: "mono faint", style: { fontSize: "11px" } }, e.asset.name),
      ) as HTMLButtonElement;
      return r;
    });
    const scroll = h("div", { class: "pick-list", style: { maxHeight: "46vh", overflowY: "auto", marginTop: "16px", display: "flex", flexDirection: "column", gap: "6px" } }, ...rows);
    const ov = h("div", {
      class: "overlay",
      onClick: (e: MouseEvent) => {
        if (e.target === ov) done(null);
      },
    },
      h("div", { class: "modal", style: { maxWidth: "760px", width: "92vw" } },
        h("h3", {}, `选择版本 · ${instanceName}`),
        h("p", { style: { color: "var(--paper-dim)", fontSize: "12px" } },
          "升级 / 降级只替换程序目录，DSH_HOME 数据与插件保留；旧版本保留为备份可再回退。"),
        scroll,
        h("div", { class: "foot", style: { marginTop: "18px" } },
          h("span", { class: "mono faint", style: { fontSize: "11px" } },
            `${list.length} 个版本 · 新 → 旧`),
          h("div", { class: "spacer" }),
          h("button", { class: "btn ghost", onClick: () => done(null) }, "取消"),
        ),
      ),
    );
    document.body.append(ov);
  });
}

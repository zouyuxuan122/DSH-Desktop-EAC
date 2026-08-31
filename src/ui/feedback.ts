// 提示堆栈 + 确认弹窗

import { h } from "./dom";

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

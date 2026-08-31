// DOM 构建助手：h(tag, props, ...children)

type Child = Node | string | number | null | undefined | false;

export type Props = {
  [key: string]: unknown;
  class?: string;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "onClick") el.addEventListener("click", v as EventListener);
    else if (k === "onInput") el.addEventListener("input", v as EventListener);
    else if (k === "onChange") el.addEventListener("change", v as EventListener);
    else if (k === "onKeyDown") el.addEventListener("keydown", v as EventListener);
    else if (k === "style" && typeof v === "object")
      Object.assign(el.style, v as CSSStyleDeclaration);
    else if (k.startsWith("data-")) el.setAttribute(k, String(v));
    else if (k in el && typeof v === "boolean")
      (el as unknown as Record<string, boolean>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** 给元素列表设置交错入场序号 */
export function staggerChildren(root: Element, selector = ":scope > *"): void {
  const all = [...root.querySelectorAll<HTMLElement>(selector), ...([...root.children] as HTMLElement[])];
  all.forEach((n, i) => {
    if (!n.style.getPropertyValue("--i")) n.style.setProperty("--i", String(i));
  });
}

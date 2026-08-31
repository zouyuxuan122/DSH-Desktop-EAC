// 内联 SVG 图标（16px 网格，线性风格）

const S = (body: string, vb = "0 0 16 16") =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

export const icons = {
  // 导航
  grid: S(`<rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><path d="M9 11.5h4.5M11.25 9v4.5"/>`),
  market: S(`<path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4"/>`),
  activity: S(`<path d="M1.5 8.5h3l2-5 3 9 2-4h3"/>`),
  sliders: S(`<path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.6" fill="var(--ink-0)"/><circle cx="10.5" cy="11" r="1.6" fill="var(--ink-0)"/>`),
  // 窗口控制
  min: `<svg viewBox="0 0 11 11"><path d="M1.5 5.5h8" stroke="currentColor" stroke-width="1.1"/></svg>`,
  max: `<svg viewBox="0 0 11 11"><rect x="1.8" y="1.8" width="7.4" height="7.4" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>`,
  close: `<svg viewBox="0 0 11 11"><path d="M1.8 1.8l7.4 7.4M9.2 1.8l-7.4 7.4" stroke="currentColor" stroke-width="1.1"/></svg>`,
  // 动作
  play: S(`<path d="M4.5 2.8v10.4l8-5.2z" fill="currentColor" stroke="none"/>`),
  stop: S(`<rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" stroke="none"/>`),
  folder: S(`<path d="M1.8 4.2v8.5h12.4V5.8H8L6.5 4.2z"/>`),
  external: S(`<path d="M6.5 3H3v10h10V9.5M9.5 2.5H13.5V6.5M13.2 2.8L7.5 8.5"/>`),
  trash: S(`<path d="M2.8 4.2h10.4M6.5 4V2.6h3V4M4 4.4l.6 9h6.8l.6-9M6.7 6.6v4.6M9.3 6.6v4.6"/>`),
  refresh: S(`<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>`),
  download: S(`<path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13h11"/>`),
  check: S(`<path d="M2.8 8.5l3.4 3.4 7-7.4"/>`),
  x: S(`<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>`),
  plus: S(`<path d="M8 2.5v11M2.5 8h11"/>`),
  search: S(`<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/>`),
  edit: S(`<path d="M2.5 13.5l.7-3L10.6 3l2.4 2.4-7.4 7.5zM9.3 4.3l2.4 2.4"/>`),
  plug: S(`<path d="M5.5 2.5v3M10.5 2.5v3M4 5.5h8v2.5a4 4 0 0 1-8 0zM8 12v2"/>`),
  back: S(`<path d="M13 8H3M6.5 4.5L3 8l3.5 3.5"/>`),
  arrow: S(`<path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"/>`),
};

export function ico(name: keyof typeof icons, cls = ""): HTMLElement {
  const span = document.createElement("span");
  span.className = `ico ${cls}`;
  span.innerHTML = icons[name];
  span.style.display = "inline-flex";
  const svg = span.querySelector("svg");
  if (svg) {
    svg.style.width = "1em";
    svg.style.height = "1em";
  }
  return span;
}

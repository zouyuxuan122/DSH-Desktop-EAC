// 生成 src-tauri/icons/icon.png（1024px），供 tauri icon 派生全套图标
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const svg = readFileSync("build/icon.svg", "utf8");
const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } });
const png = resvg.render().asPng();
mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/icon.png", png);
console.log("icon.png written:", png.length, "bytes");

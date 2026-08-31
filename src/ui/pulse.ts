// 签名视觉：脉冲线（心电图）。振幅 = 空息呼吸 + 聚合下载速率 + 运行实例数。
// 弹簧平滑 + 非线性扫描，是整个启动器的"生命体征"。

import { aggSpeed, runningCount } from "../core/store";

export class PulseLine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private samples: number[] = [];
  private phase = 0;
  private amp = 2;
  private targetAmp = 2;
  private raf = 0;
  private lastT = 0;
  private running = true;
  private ro: ResizeObserver | null = null;
  private w = 0;
  private hgt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.lastT = performance.now();
    // 布局就绪后初始化；尺寸变化（视图切换/窗口缩放）时重建缓冲
    const setup = () => {
      const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
      const hgt = canvas.clientHeight || canvas.parentElement?.clientHeight || 0;
      if (w < 10 || hgt < 10) return false;
      if (w === this.w && hgt === this.hgt) return true;
      this.w = w;
      this.hgt = hgt;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const N = Math.max(24, Math.floor(w / 2));
      this.samples = new Array(N).fill(hgt / 2);
      return true;
    };
    if (!setup()) {
      let tries = 0;
      const retry = () => {
        if (this.running && !setup() && tries++ < 40) setTimeout(retry, 60);
      };
      setTimeout(retry, 60);
    }
    this.ro = new ResizeObserver(() => setup());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.loop(this.lastT);
  }

  private loop = (t: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(64, t - this.lastT) / 1000;
    this.lastT = t;
    const n = this.samples.length;
    if (n === 0 || this.w === 0) return;

    // 目标振幅：对数压缩速率，运行实例线性叠加
    const speed = aggSpeed();
    const run = runningCount();
    const idle = 3.4 + Math.sin(t / 900) * 1.9;
    const act = Math.log10(1 + speed / 4096) * 6.5 + run * 5;
    this.targetAmp = Math.min(19, idle + act);
    // 弹簧趋近（欠阻尼，非线性）
    this.amp += (this.targetAmp - this.amp) * Math.min(1, dt * 7);
    this.phase += dt * (2.4 + Math.min(6, Math.log10(1 + speed / 2048) * 4));

    const w = this.w;
    const hgt = this.hgt;
    const mid = hgt / 2;
    // 左移采样
    this.samples.shift();
    const env = (x: number) => {
      const e = x / n;
      return Math.sin(Math.PI * Math.min(1, Math.max(0, e))) ** 0.7;
    };
    const y =
      mid -
      Math.sin(this.phase) * this.amp * env(n - 1) -
      Math.sin(this.phase * 2.7) * this.amp * 0.35 * env(n - 1);
    this.samples.push(y);

    const css = getComputedStyle(this.canvas);
    const stroke = css.color || "#f2f1ec";
    this.ctx.clearRect(0, 0, w, hgt);
    // 基线
    this.ctx.strokeStyle = "rgba(128,128,128,0.18)";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, mid + 0.5);
    this.ctx.lineTo(w, mid + 0.5);
    this.ctx.stroke();
    // 波形
    this.ctx.strokeStyle = stroke;
    this.ctx.lineWidth = 1.4;
    this.ctx.globalAlpha = 0.92;
    this.ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      if (i === 0) this.ctx.moveTo(x, this.samples[i]);
      else this.ctx.lineTo(x, this.samples[i]);
    }
    this.ctx.stroke();
    // 扫描亮点
    this.ctx.globalAlpha = 1;
    const lx = w - 1.5;
    this.ctx.fillStyle = stroke;
    this.ctx.beginPath();
    this.ctx.arc(lx, this.samples[n - 1], 2, 0, Math.PI * 2);
    this.ctx.fill();
  };

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.ro = null;
  }
}

/** 挂载脉冲线容器 */
export function pulseWidget(label = "VITALS"): { root: HTMLElement; mount: () => void; unmount: () => void } {
  const canvas = document.createElement("canvas");
  const root = document.createElement("div");
  root.className = "pulse-wrap";
  const lab = document.createElement("span");
  lab.className = "p-label";
  lab.textContent = label;
  root.append(canvas, lab);
  let line: PulseLine | null = null;
  return {
    root,
    mount: () => {
      if (!line) line = new PulseLine(canvas);
    },
    unmount: () => {
      line?.destroy();
      line = null;
    },
  };
}

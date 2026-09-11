/**
 * VCPColorEngine.js —— VCP 色彩引擎 v2（三代合体版）
 *
 * 哲学：骨骼愈坚硬，血肉愈自由。
 *   - 物理层（确定性数学）：OKLCH 感知空间 + 普朗克温度隐喻 + 黄金角散布，
 *     全部纯函数、零随机数 → 流式渲染重建结果恒定（无频闪）。
 *   - 审美层（软先验）：门-斯宾塞模糊区、松田调和几何、浊色排斥、歌德面积律
 *     以「柔和吸引」而非硬否决实现——不产生参数断裂；Agent 显式锚定即豁免。
 *   - 测量层（真不变量）：真实 WCAG 对比度计算 + sRGB 色域二分边界 + 模糊区
 *     终值复检。不达标 → 有界搜索微调明度/色度，直到通过或如实上报未达标。
 *
 * 三代来源：
 *   Gen1 五大艺术流派命名预设（editorial/chiaroscuro/fauvism/cyberpunk/wabi_sabi）
 *   Gen2 SCC 连续意识场（thermalSoul/valence/arousal/entropy 四维灵魂向量）
 *   Gen3 人类经典美学公理（软先验化 + 测量闭环取代硬 snap）
 *
 * 零依赖；可在浏览器 <script>、CommonJS require、或注入 bundle 内运行。
 * 全局挂载：globalThis.VCPColorEngine / globalThis.__vcpColor。
 *
 * 集成方式（渲染层注入，模型只写声明，hex 永不经过 LLM）：
 *   <div id="vcp-root" data-vcp-preset="cyberpunk" data-vcp-mode="dark">
 *     子元素用 var(--vcp-base) / var(--vcp-surface) / var(--vcp-border)
 *     var(--vcp-text-primary) / var(--vcp-text-muted)
 *     var(--vcp-accent-primary) / var(--vcp-accent-secondary)
 *     var(--vcp-code-bg) / var(--vcp-code-text) / var(--vcp-danger) / var(--vcp-glow)
 *   自定义灵魂：data-vcp-soul="18000,-0.2,0.6,0.1"（色温K,愉悦度,激惹度,熵）
 *   锁定点缀色：data-vcp-accent="#00ff66" 或色相角（如 140）
 */

class VCPColorEngine {
  // ==================== 基础数学 ====================

  static clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }
  static lerp(a, b, t) { return a + (b - a) * t }
  static mod360(x) { return ((x % 360) + 360) % 360 }
  /** 两色相角的最短角距（0~180）。 */
  static angleDist(a, b) { return Math.abs(((a - b) % 360 + 540) % 360 - 180) }
  /** 最短路径环向插值（跨 0°/360° 正确）。 */
  static lerpAngle(a, b, t) {
    const d = ((b - a) % 360 + 540) % 360 - 180
    return this.mod360(a + d * t)
  }

  // ==================== OKLCH ↔ sRGB（Ottosson 标准矩阵） ====================

  /** OKLCH → sRGB Hex。 */
  static oklchToHex(L, C, h) {
    const hRad = (h * Math.PI) / 180
    const a = C * Math.cos(hRad)
    const b = C * Math.sin(hRad)

    // OKLab -> Linear LMS
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3

    // Linear LMS -> Linear sRGB
    const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    // Gamma
    const gamma = x => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(0, x), 1 / 2.4) - 0.055)
    const toHex = x => Math.round(this.clamp(gamma(x), 0, 1) * 255).toString(16).padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(bl)}`
  }

  /** sRGB Hex → [r,g,b]（0~1），支持 #abc 简写。 */
  static hexToRgb(hex) {
    let h = (hex || '').replace('#', '')
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    if (h.length !== 6) return [0, 0, 0]
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
  }

  /** sRGB Hex → OKLCH（用于 data-vcp-accent="#hex" 锚定）。 */
  static hexToOklch(hex) {
    const [r, g, b] = this.hexToRgb(hex)
    const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
    const lr = lin(r), lg = lin(g), lb = lin(b)
    const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
    const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
    const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s)
    const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    const oa = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    const ob = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return { L, C: Math.hypot(oa, ob), h: (Math.atan2(ob, oa) * 180 / Math.PI + 360) % 360 }
  }

  /** (L,C,h) 是否落在 sRGB 色域内（线性通道 ε 容差）。 */
  static inGamut(L, C, h) {
    const hRad = (h * Math.PI) / 180
    const a = C * Math.cos(hRad), b = C * Math.sin(hRad)
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
    const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    const eps = 1e-4
    return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && bl >= -eps && bl <= 1 + eps
  }

  /** 二分求 (L,h) 处 sRGB 色域允许的最大色度 C。 */
  static maxChroma(L, h) {
    let lo = 0, hi = 0.4
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (this.inGamut(L, mid, h)) lo = mid; else hi = mid
    }
    return lo
  }

  // ==================== WCAG 对比度（真实公式，不偷懒用 ΔL） ====================

  static relativeLuminance(hex) {
    const [r, g, b] = this.hexToRgb(hex)
    const f = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }

  static contrastRatio(hexA, hexB) {
    const y1 = this.relativeLuminance(hexA), y2 = this.relativeLuminance(hexB)
    const hi = Math.max(y1, y2), lo = Math.min(y1, y2)
    return (hi + 0.05) / (lo + 0.05)
  }

  // ==================== 灵魂基底：普朗克温度 → 连续 OKLCH ====================
  // 暖区（烛火→日光）与冷区（日光→深空）在 6000K~7200K 平滑交叠，
  // 修复旧版 6600K 处 135° 色相断裂（连续性公理）。

  static kelvinToHueChroma(kelvin) {
    const k = this.clamp(kelvin, 1000, 30000) / 100
    const hWarm = 32 + Math.log(Math.max(1, k)) * 14
    const cWarm = 0.06 * (1 - k / 100)
    const hCold = 220 + Math.min(60, Math.max(0, k - 66) * 0.4)
    const cCold = 0.04 + Math.min(0.06, Math.max(0, k - 66) * 0.0008)
    const t = this.clamp((k - 60) / 12, 0, 1)
    return {
      kelvin: Math.round(kelvin),
      h: this.lerpAngle(hWarm, hCold, t),
      c: this.clamp(this.lerp(cWarm, cCold, t), 0.005, 0.12),
    }
  }

  // ==================== 命名预设：五大流派 + 人格 ====================
  // 预设 = 一组 curated 灵魂向量；preset 内 accentHue 视为「策展式显式锚定」
  // （豁免模糊区/浊色软先验——这是人挑过的，不是算法自动生成的）。

  static PRESETS = {
    editorial: { thermalSoul: 6000, valence: 0.1, arousal: 0.5, entropy: 0.05, accentHue: 220, accentC: 0.24 },
    chiaroscuro: { thermalSoul: 2400, valence: 0.2, arousal: 0.35, entropy: 0.15, darkNative: true, accentHue: 42 },
    fauvism: { thermalSoul: 5000, valence: 0.3, arousal: 0.85, entropy: 0.3, darkNative: true },
    cyberpunk: { thermalSoul: 18000, valence: -0.1, arousal: 0.7, entropy: 0.15, darkNative: true, accentHue: 170, accentC: 0.22 },
    wabi_sabi: { thermalSoul: 4000, valence: 0.4, arousal: 0.25, entropy: 0.35, darkNative: false },
    'cyber-hacker': { thermalSoul: 18000, valence: -0.2, arousal: 0.6, entropy: 0.15, darkNative: true, accentHue: 170, accentC: 0.22 },
    'jiangnan-scholar': { thermalSoul: 3000, valence: 0.4, arousal: 0.25, entropy: 0.35, darkNative: false },
    'void-prophet': { thermalSoul: 20000, valence: 0.1, arousal: 0.5, entropy: 0.7, darkNative: true },
  }

  // ==================== 测量闭环工具 ====================

  /** 对比度投影：fg 与 bg 不达标 → 沿「远离 bg」方向有界搜索微调 fg 明度。 */
  static projectContrast(fg, bg, required, name, audit) {
    const bgHex = this.oklchToHex(bg.L, bg.C, bg.H)
    const measure = () => this.contrastRatio(this.oklchToHex(fg.L, fg.C, fg.H), bgHex)
    if (measure() >= required) return false
    const dir = fg.L > bg.L ? 1 : -1
    let adjusted = false
    for (let i = 0; i < 60; i++) {
      fg.L = this.clamp(fg.L + dir * 0.008, 0.02, 0.98)
      adjusted = true
      if (measure() >= required) return true
    }
    if (audit) {
      audit.unfixed = audit.unfixed || []
      audit.unfixed.push({ pair: name, required })
    }
    return adjusted
  }

  // ==================== 主入口 ====================

  /**
   * @param {Object} opts
   * @param {string} [opts.movement] 预设名：editorial|chiaroscuro|fauvism|cyberpunk|wabi_sabi|cyber-hacker|jiangnan-scholar|void-prophet
   * @param {number} [opts.thermalSoul] 灵魂色温 1000~30000K（1200-2400 烛火 / 5500-6500 日光 / 12000-25000 深空）
   * @param {number} [opts.valence] 愉悦度 -1~1
   * @param {number} [opts.arousal] 激惹度 0~1
   * @param {number} [opts.entropy] 灵性熵 0~1（高熵→渗色、低熵→纯净）
   * @param {boolean|string} [opts.darkNative] 基态；opts.mode='dark'|'light' 等价
   * @param {number} [opts.accentHue] 显式锚定点缀色相角（豁免审美软先验）
   * @param {string} [opts.accentHex] 显式锚定点缀色 hex（如 '#00ff66'）
   */
  static generate(opts) {
    opts = opts || {}
    const presetKey = opts.movement || opts.preset
    const preset = presetKey ? this.PRESETS[presetKey] : null
    const p = preset ? Object.assign({}, preset) : {}

    if (typeof opts.thermalSoul === 'number') p.thermalSoul = opts.thermalSoul
    if (typeof opts.valence === 'number') p.valence = opts.valence
    if (typeof opts.arousal === 'number') p.arousal = opts.arousal
    if (typeof opts.entropy === 'number') p.entropy = opts.entropy
    if (typeof opts.darkNative === 'boolean') p.darkNative = opts.darkNative
    if (opts.mode === 'dark') p.darkNative = true
    else if (opts.mode === 'light') p.darkNative = false

    const dark = p.darkNative !== false
    const V = this.clamp(p.valence === undefined ? 0 : p.valence, -1, 1)
    const A = this.clamp(p.arousal === undefined ? 0.5 : p.arousal, 0, 1)
    const H = this.clamp(p.entropy === undefined ? 0.3 : p.entropy, 0, 1)

    // ---- 1. 灵魂基底 ----
    const soul = this.kelvinToHueChroma(p.thermalSoul === undefined ? 4500 : p.thermalSoul)
    const baseL = dark
      ? 0.06 + (V + 1) * 0.035 + H * 0.02
      : 0.96 - (1 - V) * 0.03 - H * 0.02
    const baseC = soul.c * (0.3 + H * 0.7)
    const baseH = soul.h

    // ---- 2. 点缀色：显式锚定 > 黄金角散布 ----
    const accentExplicit = p.accentHue != null || opts.accentHue != null || opts.accentHex != null
    let accentH, accentC, accentL
    const autoAccentL = dark
      ? this.lerp(0.68, 0.82, (V + 1) / 2)
      : this.lerp(0.35, 0.48, 1 - (V + 1) / 2)
    if (typeof opts.accentHex === 'string' && opts.accentHex.charAt(0) === '#') {
      const oc = this.hexToOklch(opts.accentHex)
      accentH = oc.h
      accentC = Math.max(0.06 + A * 0.2, oc.C)
      accentL = autoAccentL
    } else {
      accentH = typeof opts.accentHue === 'number'
        ? opts.accentHue
        : (p.accentHue != null ? p.accentHue : this.mod360(baseH + 137.5077 * A * (1 + (1 - H) * 0.2)))
      accentC = 0.06 + A * 0.2
      accentL = autoAccentL
    }
    if (typeof p.accentC === 'number') accentC = p.accentC
    if (typeof p.accentL === 'number') accentL = p.accentL
    accentC = this.clamp(accentC, 0.04, 0.34)
    accentL = this.clamp(accentL, 0.15, 0.95)

    // ---- 3. 软先验：浊色排斥（柔和吸引；带边缘权重，显式锚定豁免） ----
    let muddyNudged = false
    if (!accentExplicit && accentL >= 0.2 && accentL <= 0.55 && accentC > 0.04 && accentH >= 85 && accentH <= 135) {
      const w = this.clamp(1 - Math.abs(accentH - 110) / 25, 0, 1)
      if (w > 0.01) {
        accentH = this.lerpAngle(accentH, accentH < 110 ? 65 : 155, 0.3 * w)
        accentC = accentC * (1 - 0.15 * w)
        muddyNudged = true
      }
    }

    // ---- 4. 组装 OKLCH 流形 ----
    const deltaL = dark ? 1 : -1
    const textL = dark
      ? this.clamp(0.94 + V * 0.04, 0.02, 0.98)
      : this.clamp(0.12 - V * 0.04, 0.02, 0.98)
    const mutedL = this.clamp(textL + (dark ? -0.35 : 0.35), 0.02, 0.98)
    const textC = this.clamp(baseC * 0.2 * (1 - H), 0, 0.1)
    const tokens = {
      base: { L: baseL, C: baseC, H: baseH },
      surface: { L: this.clamp(baseL + 0.05 * deltaL, 0.02, 0.98), C: this.clamp(baseC * 1.1, 0, 0.2), H: baseH },
      border: { L: this.clamp(baseL + 0.12 * deltaL, 0.02, 0.98), C: this.clamp(baseC * 1.5, 0, 0.25), H: this.mod360(baseH + 10) },
      textPrimary: { L: textL, C: textC, H: baseH },
      textMuted: { L: mutedL, C: textC, H: baseH },
      accentPrimary: { L: accentL, C: accentC, H: accentH },
      accentSecondary: { L: this.clamp(accentL * (dark ? 0.9 : 1.06), 0.02, 0.98), C: this.clamp(accentC * 0.8, 0, 0.3), H: this.mod360(accentH + 40) },
      codeBg: { L: this.clamp(baseL - (dark ? 0.03 : 0.06), 0.02, 0.98), C: this.clamp(baseC * 0.8, 0, 0.15), H: baseH },
      codeText: { L: dark ? 0.85 : 0.3, C: 0.06, H: accentH },
      danger: { L: dark ? 0.62 : 0.5, C: 0.2, H: 25 },
      glow: { L: accentL, C: this.clamp(accentC * 1.15, 0, 0.35), H: accentH },
    }

    // ---- 5. 测量闭环 A：sRGB 色域裁剪（二分求边界，色相无损） ----
    const audit = { contrasts: {}, gamut: {}, adjusted: 0, unfixed: [], muddy: { nudged: muddyNudged }, ambiguity: { corrected: false } }
    for (const k in tokens) {
      const tk = tokens[k]
      const maxC = this.maxChroma(tk.L, tk.H)
      if (tk.C > maxC) {
        audit.gamut[k] = { from: +tk.C.toFixed(3), to: +maxC.toFixed(3) }
        tk.C = maxC
      }
    }

    // ---- 6. 测量闭环 B：真实 WCAG 对比度投影（迭代至收敛） ----
    const pairs = [
      ['textPrimary', 'base', 7],
      ['textPrimary', 'surface', 4.5],
      ['textMuted', 'base', 4.5],
      ['accentPrimary', 'base', 4.5],
      ['accentSecondary', 'base', 4.5],
      ['codeText', 'codeBg', 4.5],
      ['danger', 'base', 4.5],
      ['glow', 'base', 3],
    ]
    for (let pass = 0; pass < 3; pass++) {
      let anyFix = false
      for (let pi = 0; pi < pairs.length; pi++) {
        const [fgK, bgK, req] = pairs[pi]
        if (this.projectContrast(tokens[fgK], tokens[bgK], req, fgK + ':' + bgK, audit)) anyFix = true
      }
      for (const k in tokens) {
        const tk = tokens[k]
        const maxC = this.maxChroma(tk.L, tk.H)
        if (tk.C > maxC) tk.C = maxC
      }
      if (!anyFix) break
    }

    // ---- 7. 测量闭环 C：模糊区（15°~38°）终值复检；显式锚定豁免 ----
    if (!accentExplicit) {
      let guard = 0
      while (guard < 3) {
        const dist = this.angleDist(tokens.accentPrimary.H, baseH)
        if (!(dist > 15 && dist < 38)) break
        const s = ((tokens.accentPrimary.H - baseH) % 360 + 540) % 360 - 180
        const target = dist < 26.5 ? 13 : 41
        const move = (s >= 0 ? 1 : -1) * (target - dist)
        tokens.accentPrimary.H = this.mod360(tokens.accentPrimary.H + move)
        tokens.accentSecondary.H = this.mod360(tokens.accentPrimary.H + 40)
        tokens.codeText.H = tokens.accentPrimary.H
        tokens.glow.H = tokens.accentPrimary.H
        audit.ambiguity.corrected = true
        guard++
      }
    }

    // ---- 8. 编译输出（诚实审计：最终实测值） ----
    const hex = {}, okl = {}, triples = {}
    for (const k in tokens) {
      const t = tokens[k]
      hex[k] = this.oklchToHex(t.L, t.C, t.H)
      okl[k] = 'oklch(' + (t.L * 100).toFixed(1) + '% ' + (+t.C.toFixed(4)) + ' ' + this.mod360(t.H).toFixed(1) + ')'
      triples[k] = [t.L, t.C, this.mod360(t.H)]
    }
    for (let pi = 0; pi < pairs.length; pi++) {
      const [fgK, bgK] = pairs[pi]
      audit.contrasts[fgK + ':' + bgK] = +this.contrastRatio(hex[fgK], hex[bgK]).toFixed(2)
    }
    audit.allPass = pairs.every(([fgK, bgK, req]) => (audit.contrasts[fgK + ':' + bgK] || 0) >= req - 1e-9)
    audit.ambiguity.dist = +this.angleDist(tokens.accentPrimary.H, baseH).toFixed(1)
    audit.accent = { explicit: accentExplicit, hue: +this.mod360(tokens.accentPrimary.H).toFixed(1) }

    return {
      movement: presetKey || null,
      physics: { thermalSoul: soul.kelvin, valence: V, arousal: A, entropy: H, darkNative: dark },
      oklch: triples,
      hex,
      cssOklch: okl,
      audit,
      /** 双声明 CSS 变量：现代浏览器用 oklch()，旧浏览器回退 hex。 */
      toCSS() {
        const kebab = k => k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())
        const out = []
        for (const k in hex) {
          out.push('--vcp-' + kebab(k) + ': ' + hex[k] + ';')
          out.push('--vcp-' + kebab(k) + ': ' + okl[k] + ';')
        }
        return out.join('\n')
      },
    }
  }
}

// 导出：CommonJS / 浏览器全局（bundle 注入与 <script> 两种环境均可用）
if (typeof module !== 'undefined' && module.exports) module.exports = VCPColorEngine
if (typeof globalThis !== 'undefined') {
  globalThis.VCPColorEngine = VCPColorEngine
  globalThis.__vcpColor = VCPColorEngine
} else if (typeof window !== 'undefined') {
  window.VCPColorEngine = VCPColorEngine
  window.__vcpColor = VCPColorEngine
}

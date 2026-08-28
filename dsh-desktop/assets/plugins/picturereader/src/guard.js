/**
 * Low-information image guard.
 *
 * Small local VLMs tend to hallucinate on blank / very simple images. Before
 * sending an image to a VLM we can cheaply measure color diversity, dominant
 * color coverage, edge density and brightness variance, then decide whether
 * the image is too empty to be worth a VLM call.
 *
 * @module picturereader/guard
 */

const SAMPLE = 64;

/**
 * Calculate luminance (Rec.601).
 * @param {number} r - red channel 0..255.
 * @param {number} g - green channel 0..255.
 * @param {number} b - blue channel 0..255.
 * @returns {number} luminance 0..255.
 */
function gray(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Detect low-information images (blank, very simple, or unrendered).
 *
 * The guard checks four heuristics:
 * 1. Color diversity: unique color buckets <= 8
 * 2. Dominant color coverage: top color >= 90%
 * 3. Dominant color with low edge density: top >= 60% AND edges < 8%
 * 4. Low brightness variance: standard deviation < 8
 *
 * @param {Uint8ClampedArray|Buffer} rgba - RGBA pixel data.
 * @param {number} width - image width in pixels.
 * @param {number} height - image height in pixels.
 * @returns {boolean} true when the image looks blank / very low-information.
 */
export function isLowInformationImage(rgba, width, height) {
  if (width <= 0 || height <= 0 || rgba.length < 4) return true;

  // Downsample to SAMPLE x SAMPLE (nearest neighbor is fine for a guard).
  const cells = [];
  const cellSizeX = Math.max(1, Math.floor(width / SAMPLE));
  const cellSizeY = Math.max(1, Math.floor(height / SAMPLE));
  const gridW = Math.min(SAMPLE, width);
  const gridH = Math.min(SAMPLE, height);

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const px = Math.min(width - 1, gx * cellSizeX + Math.floor(cellSizeX / 2));
      const py = Math.min(height - 1, gy * cellSizeY + Math.floor(cellSizeY / 2));
      const i = (py * width + px) * 4;
      cells.push([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]);
    }
  }

  const buckets = new Map();
  let total = 0;
  let sum = 0;
  let sumSq = 0;
  let edgeCount = 0;
  let edgePairs = 0;

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const [r, g, b] = cells[y * gridW + x];
      // Quantize to 3 bits per channel for bucketing
      const key = ((r & 0xe0) << 10) | ((g & 0xe0) << 5) | (b & 0xe0);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);

      const lum = gray(r, g, b);
      sum += lum;
      sumSq += lum * lum;
      total++;

      // Check horizontal edge (luminance difference > 20)
      if (x + 1 < gridW) {
        const [r2, g2, b2] = cells[y * gridW + x + 1];
        const lum2 = gray(r2, g2, b2);
        if (Math.abs(lum - lum2) > 20) edgeCount++;
        edgePairs++;
      }
    }
  }

  const unique = buckets.size;
  const top = Math.max(...buckets.values());
  const topRatio = total > 0 ? top / total : 1;
  const edgeRatio = edgePairs > 0 ? edgeCount / edgePairs : 0;
  const mean = total > 0 ? sum / total : 0;
  const variance = total > 0 ? Math.max(0, sumSq / total - mean * mean) : 0;
  const stdDev = Math.sqrt(variance);

  return (
    unique <= 8 ||
    topRatio >= 0.9 ||
    (topRatio >= 0.6 && edgeRatio < 0.08) ||
    stdDev < 8
  );
}

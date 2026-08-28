/**
 * Generate fixture images on disk and print the image_scan render for a
 * quick visual sanity check without booting a harness.
 * Usage: node scripts/preview.mjs
 * @module picturereader/scripts/preview
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeImage, renderImageScan } from '../src/core.js';
import { makeChartRgba, makeQuadrantRgba, pngFromRgba, jpegFromRgba, gifFromRgba, bmpFromRgba } from '../tests/fixtures.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures-out');
mkdirSync(outDir, { recursive: true });

const images = [
  { name: 'chart', width: 600, height: 400, rgba: makeChartRgba(), formats: ['png', 'jpeg', 'gif', 'bmp'] },
  { name: 'quadrant', width: 100, height: 100, rgba: makeQuadrantRgba(), formats: ['png'] }
];

for (const image of images) {
  for (const format of image.formats) {
    const buffer =
      format === 'png' ? pngFromRgba(image.width, image.height, image.rgba)
        : format === 'jpeg' ? jpegFromRgba(image.width, image.height, image.rgba)
          : format === 'gif' ? gifFromRgba(image.width, image.height, image.rgba)
            : bmpFromRgba(image.width, image.height, image.rgba, 24);
    writeFileSync(join(outDir, `${image.name}.${format}`), buffer);
  }
  const analysis = analyzeImage(image.rgba, image.width, image.height, { size: 32, mode: 'auto', region: undefined });
  console.log(renderImageScan({
    path: join(outDir, `${image.name}.png`),
    width: image.width,
    height: image.height,
    region: 'full',
    ...analysis
  }));
  console.log();
}

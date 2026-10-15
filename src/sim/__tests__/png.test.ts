import { describe, expect, it } from 'vitest';
import { compare, readPng, writePng, type Image } from '../../../scripts/lib/png.mjs';

function image(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): Image {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

describe('visual regression helpers', () => {
  it('round-trips an image through the PNG codec', () => {
    const img = image(37, 21, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255]);
    const back = readPng(writePng(img));
    expect(back.width).toBe(37);
    expect(back.height).toBe(21);
    expect(Buffer.compare(back.data, img.data)).toBe(0);
  });

  it('identical images differ by 0, a changed block is counted, size mismatch is flagged', () => {
    const a = image(20, 10, () => [10, 20, 30]);
    const same = image(20, 10, () => [10, 20, 30]);
    expect(compare(a, same).ratio).toBe(0);
    const tweaked = image(20, 10, (x, y) => (x < 5 && y < 4 ? [200, 20, 30] : [10, 20, 30]));
    expect(compare(a, tweaked).ratio).toBeCloseTo(20 / 200, 5);
    const slight = image(20, 10, () => [20, 25, 35]); // below the per-channel threshold: anti-aliasing noise
    expect(compare(a, slight).ratio).toBe(0);
    expect(compare(a, image(10, 10, () => [10, 20, 30])).sizeMismatch).toBe(true);
  });
});

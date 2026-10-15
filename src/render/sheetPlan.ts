/**
 * Layout of the baked atlas sheet. All unit looks (every kind x team x pose) live on ONE texture because the crowd renderer needs a
 * single texture; with many kinds on screen that sheet grows far beyond what a GPU accepts (a 1024 px wide sheet is over 14 000 px
 * high with six teams and every unit), and a texture over the limit loses its lower rows: those units turn invisible while the
 * simulation still runs them. The plan widens the sheet and lowers its resolution until it fits.
 */

export interface SheetItem {
  w: number;
  h: number;
}

export interface SheetPlan {
  /** Sheet size in layout units (before `resolution`). */
  width: number;
  height: number;
  /** Texture resolution: pixels = layout units x resolution. */
  resolution: number;
  /** Top-left corner of each item, in the order of the input. */
  positions: Array<{ x: number; y: number }>;
}

const WIDTHS = [1024, 2048, 4096, 8192, 16384];
const RESOLUTIONS = [2, 1, 0.5, 0.25];
/** Largest sheet area (in pixels) worth the memory; beyond this the resolution drops even if the dimensions would fit. */
const MAX_PIXELS = 48_000_000;

/** Shelf packing of `items` into rows of at most `width`. */
export function shelfPack(items: SheetItem[], width: number, pad: number): { height: number; positions: Array<{ x: number; y: number }> } {
  const positions: Array<{ x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const item of items) {
    if (x + item.w > width) {
      x = 0;
      y += rowH + pad;
      rowH = 0;
    }
    positions.push({ x, y });
    x += item.w + pad;
    rowH = Math.max(rowH, item.h);
  }
  return { height: y + rowH + pad, positions };
}

/**
 * Picks the sharpest layout whose sheet fits into `maxTexture` pixels per side: the highest resolution first, and for each
 * resolution the narrowest width that is tall enough to fit. Always returns a plan (the smallest resolution as a last resort).
 */
export function planSheet(items: SheetItem[], maxTexture: number, pad: number): SheetPlan {
  const widest = items.reduce((m, it) => Math.max(m, it.w), 0);
  let last: SheetPlan | null = null;
  for (const resolution of RESOLUTIONS) {
    for (const width of WIDTHS) {
      if (width < widest || width * resolution > maxTexture) continue;
      const { height, positions } = shelfPack(items, width, pad);
      last = { width, height, resolution, positions };
      if (height * resolution <= maxTexture && width * height * resolution * resolution <= MAX_PIXELS) return last;
    }
  }
  if (last) return last;
  const { height, positions } = shelfPack(items, Math.max(widest, 64), pad);
  return { width: Math.max(widest, 64), height, resolution: RESOLUTIONS.at(-1)!, positions };
}

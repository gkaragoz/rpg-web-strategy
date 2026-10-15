import { describe, expect, it } from 'vitest';
import { planSheet, shelfPack, type SheetItem } from '../../render/sheetPlan';
import { KIND_COUNT, STATS } from '../units';
import { POSES } from '../../render/unitView';

/** Every kind x team x pose cell the atlas bakes (tanks use a larger cell), plus a keep-sized decor item. */
function cells(teams: number, kinds = KIND_COUNT): SheetItem[] {
  const items: SheetItem[] = [];
  for (let k = 0; k < kinds; k++) for (let t = 0; t < teams; t++) for (let p = 0; p < POSES; p++) items.push({ w: 64 * STATS[k].scale, h: 96 * STATS[k].scale });
  items.push({ w: 272, h: 220 });
  return items;
}

describe('atlas sheet plan', () => {
  it('shelf packing never overlaps and stays inside the width', () => {
    const items = cells(3, 12);
    const { height, positions } = shelfPack(items, 2048, 3);
    positions.forEach((p, i) => {
      expect(p.x + items[i].w).toBeLessThanOrEqual(2048);
      expect(p.y + items[i].h).toBeLessThanOrEqual(height);
    });
    for (let i = 0; i < items.length; i += 7) {
      for (let j = i + 1; j < Math.min(items.length, i + 60); j++) {
        const a = { ...positions[i], ...items[i] };
        const b = { ...positions[j], ...items[j] };
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${i} vs ${j}`).toBe(false);
      }
    }
  });

  it('every team count and unit set fits every GPU texture limit (the old fixed 1024 px sheet did not)', () => {
    for (const maxTexture of [4096, 8192, 16384]) {
      for (const teams of [1, 2, 3, 4, 6]) {
        for (const kinds of [5, 20, KIND_COUNT]) {
          const plan = planSheet(cells(teams, kinds), maxTexture, 3);
          expect(plan.width * plan.resolution, `${maxTexture}/${teams}/${kinds} width`).toBeLessThanOrEqual(maxTexture);
          expect(plan.height * plan.resolution, `${maxTexture}/${teams}/${kinds} height`).toBeLessThanOrEqual(maxTexture);
          expect(plan.positions.length).toBe(cells(teams, kinds).length);
        }
      }
    }
    // The old layout: 1024 wide at resolution 1 would have been this tall with six teams and every unit.
    expect(shelfPack(cells(6), 1024, 3).height).toBeGreaterThan(8192);
  });

  it('keeps full sharpness for small armies and drops the resolution only when it must', () => {
    expect(planSheet(cells(2, 5), 4096, 3)).toMatchObject({ width: 1024, resolution: 2 });
    expect(planSheet(cells(6), 4096, 3).resolution).toBeLessThan(2);
    expect(planSheet(cells(6), 16384, 3).resolution).toBeGreaterThanOrEqual(1);
  });

  it('works even for a tiny texture limit', () => {
    const plan = planSheet(cells(6), 2048, 3);
    expect(plan.width * plan.resolution).toBeLessThanOrEqual(2048);
    expect(plan.height * plan.resolution).toBeLessThanOrEqual(2048);
  });
});

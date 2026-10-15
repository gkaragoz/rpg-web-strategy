import { describe, expect, it } from 'vitest';
import { allStrings } from '../../i18n';
import { markTourSeen, placeBalloon, studioSteps, tourSeen } from '../../app/tourLogic';

const VP = { width: 1280, height: 800 };
const SIZE = { width: 340, height: 160 };

describe('tour steps', () => {
  it('every step has title and body strings in both languages', () => {
    const { en, tr } = allStrings();
    for (const touch of [false, true]) {
      for (const s of studioSteps(touch)) {
        for (const table of [en, tr]) {
          expect(table[s.title], s.title).toBeTruthy();
          expect(table[s.body], s.body).toBeTruthy();
        }
      }
    }
  });

  it('touch devices get the gesture camera step, desktop the mouse one', () => {
    expect(studioSteps(true).at(-1)!.id).toBe('cameraTouch');
    expect(studioSteps(false).at(-1)!.id).toBe('camera');
    expect(studioSteps(false).length).toBe(studioSteps(true).length);
  });
});

describe('balloon placement', () => {
  it('goes below a target near the top and points up at it', () => {
    const p = placeBalloon({ x: 100, y: 50, width: 80, height: 40 }, SIZE, VP);
    expect(p.arrow).toBe('up');
    expect(p.top).toBeGreaterThan(90);
  });

  it('goes above a target at the bottom (the dock) and points down', () => {
    const p = placeBalloon({ x: 600, y: 740, width: 120, height: 44 }, SIZE, VP);
    expect(p.arrow).toBe('down');
    expect(p.top + SIZE.height).toBeLessThan(740);
  });

  it('goes above the whole panel when the target is inside it', () => {
    const dock = { x: 320, y: 540, width: 640, height: 245 };
    const p = placeBalloon({ x: 360, y: 585, width: 490, height: 44 }, SIZE, VP, dock);
    expect(p.arrow).toBe('down');
    expect(p.top + SIZE.height).toBeLessThan(dock.y);
  });

  it('stays inside the viewport at the edges and on a phone', () => {
    for (const vp of [VP, { width: 390, height: 844 }]) {
      for (const x of [-20, 0, 5, vp.width - 30, vp.width - 5]) {
        for (const y of [0, 300, vp.height - 50]) {
          const p = placeBalloon({ x, y, width: 60, height: 40 }, { width: 340, height: 170 }, vp);
          expect(p.left).toBeGreaterThanOrEqual(10);
          expect(p.left + 340).toBeLessThanOrEqual(vp.width - 10 + 0.001);
          expect(p.top).toBeGreaterThanOrEqual(10);
          expect(p.top + 170).toBeLessThanOrEqual(vp.height);
        }
      }
    }
  });

  it('is centred without a target, with an empty one and with one outside the screen', () => {
    for (const t of [null, { x: 10, y: 10, width: 0, height: 0 }, { x: 5000, y: 10, width: 40, height: 40 }]) {
      const p = placeBalloon(t, SIZE, VP);
      expect(p.arrow).toBeNull();
      expect(Math.round(p.left + SIZE.width / 2)).toBe(VP.width / 2);
    }
  });
});

describe('seen flag', () => {
  it('is false until marked and survives a broken storage', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(tourSeen(store)).toBe(false);
    markTourSeen(store);
    expect(tourSeen(store)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(tourSeen(broken)).toBe(false);
    expect(() => markTourSeen(broken)).not.toThrow();
    expect(tourSeen(null)).toBe(false);
  });
});

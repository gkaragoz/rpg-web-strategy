import { describe, expect, it } from 'vitest';
import { gestureStep } from '../../camera';

describe('two-finger gesture', () => {
  it('if only the midpoint moves, the camera moves the opposite way and zoom is unchanged', () => {
    const g = gestureStep({ x: 0, y: 0, zoom: 1 }, { mx: 0, my: 0, d: 100 }, { mx: 40, my: -20, d: 100 });
    expect(g.zoom).toBeCloseTo(1);
    expect(g.x).toBeCloseTo(-40);
    expect(g.y).toBeCloseTo(20);
  });

  it('spreading the fingers zooms in; the world point under the midpoint stays fixed', () => {
    const cam = { x: 10, y: 5, zoom: 0.5 };
    const prev = { mx: 30, my: 12, d: 100 };
    const g = gestureStep(cam, prev, { mx: 30, my: 12, d: 200 });
    expect(g.zoom).toBeCloseTo(1);
    // world point under the midpoint, at offset (mx,my) from the screen center: cam + m/zoom
    expect(cam.x + prev.mx / cam.zoom).toBeCloseTo(g.x + prev.mx / g.zoom);
    expect(cam.y + prev.my / cam.zoom).toBeCloseTo(g.y + prev.my / g.zoom);
  });

  it('zoom stays within its limits; a single finger (d=0) does not change zoom', () => {
    expect(gestureStep({ x: 0, y: 0, zoom: 2.4 }, { mx: 0, my: 0, d: 10 }, { mx: 0, my: 0, d: 1000 }).zoom).toBeCloseTo(2.5);
    expect(gestureStep({ x: 0, y: 0, zoom: 0.05 }, { mx: 0, my: 0, d: 1000 }, { mx: 0, my: 0, d: 10 }).zoom).toBeCloseTo(0.04);
    expect(gestureStep({ x: 0, y: 0, zoom: 1 }, { mx: 5, my: 5, d: 0 }, { mx: 15, my: 5, d: 0 }).zoom).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { gestureStep } from '../../camera';

describe('iki parmak hareketi', () => {
  it('yalniz orta nokta kayarsa kamera ters yone kayar, zoom degismez', () => {
    const g = gestureStep({ x: 0, y: 0, zoom: 1 }, { mx: 0, my: 0, d: 100 }, { mx: 40, my: -20, d: 100 });
    expect(g.zoom).toBeCloseTo(1);
    expect(g.x).toBeCloseTo(-40);
    expect(g.y).toBeCloseTo(20);
  });

  it('parmaklar acilirsa yakinlasir; orta noktanin altindaki dunya noktasi sabit kalir', () => {
    const cam = { x: 10, y: 5, zoom: 0.5 };
    const prev = { mx: 30, my: 12, d: 100 };
    const g = gestureStep(cam, prev, { mx: 30, my: 12, d: 200 });
    expect(g.zoom).toBeCloseTo(1);
    // orta nokta ekran merkezinden (mx,my) uzakliktaki dunya noktasi: cam + m/zoom
    expect(cam.x + prev.mx / cam.zoom).toBeCloseTo(g.x + prev.mx / g.zoom);
    expect(cam.y + prev.my / cam.zoom).toBeCloseTo(g.y + prev.my / g.zoom);
  });

  it('zoom sinirlarda kalir; tek parmak (d=0) zoom degistirmez', () => {
    expect(gestureStep({ x: 0, y: 0, zoom: 2.4 }, { mx: 0, my: 0, d: 10 }, { mx: 0, my: 0, d: 1000 }).zoom).toBeCloseTo(2.5);
    expect(gestureStep({ x: 0, y: 0, zoom: 0.05 }, { mx: 0, my: 0, d: 1000 }, { mx: 0, my: 0, d: 10 }).zoom).toBeCloseTo(0.04);
    expect(gestureStep({ x: 0, y: 0, zoom: 1 }, { mx: 5, my: 5, d: 0 }, { mx: 15, my: 5, d: 0 }).zoom).toBe(1);
  });
});

import { Container, Graphics, Sprite } from 'pixi.js';
import { isoX, isoY } from '../iso';
import type { Bridge, Terrain } from '../sim/terrain';
import type { Atlas } from './atlas';

type Pt = [number, number];

/** Dunya (x, y) -> ekran. */
const scr = (x: number, y: number, z = 0): Pt => [isoX(x, y), isoY(x, y, z)];
const flat = (p: Pt[]): number[] => p.flatMap((q) => q);

/** Nehir, kopruler ve yollar: zemin ile birimler arasinda duran statik katman. */
export function buildTerrainOverlay(t: Terrain): Container {
  const root = new Container();
  const g = new Graphics();
  root.addChild(g);

  // Toprak yol karolari.
  for (const idx of t.pathTiles) {
    const tx = idx % t.size;
    const ty = Math.floor(idx / t.size);
    const c = [scr(tx + 0.5, ty), scr(tx + 1, ty + 0.5), scr(tx + 0.5, ty + 1), scr(tx, ty + 0.5)];
    g.poly(flat(c)).fill({ color: 0xb79a6a, alpha: 0.9 });
  }

  // Nehir: merkez cizgisinden iki kiyi noktasi dizisi -> ucgen seritler yerine tek poligon.
  const sMin = -t.size * 0.75;
  const sMax = t.size * 0.75;
  const step = 0.75;
  const band = (extra: number, scale: number, color: number, alpha = 1): void => {
    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let s = sMin; s <= sMax; s += step) {
      const o = t.offsetAt(s);
      const half = (t.widthAt(s) * scale) / 2 + extra;
      left.push(scr(t.worldX(s, o - half), t.worldY(s, o - half)));
      right.push(scr(t.worldX(s, o + half), t.worldY(s, o + half)));
    }
    g.poly(flat([...left, ...right.reverse()])).fill({ color, alpha });
  };
  band(1.0, 1, 0xe3d3a4); // kumlu kiyi
  band(0, 1, 0x4a90c8);
  band(0, 0.62, 0x6fb0e0);
  band(0, 0.22, 0x8cc6ee, 0.8);

  // Dalga cizgileri.
  for (let s = sMin + 2; s < sMax; s += 3.1) {
    const o = t.offsetAt(s);
    const w = t.widthAt(s);
    const d = o + (((Math.round(s * 7) % 5) - 2) / 5) * (w * 0.35);
    const a = scr(t.worldX(s, d), t.worldY(s, d));
    const b = scr(t.worldX(s + 0.9, d), t.worldY(s + 0.9, d));
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: 1.5, color: 0xffffff, alpha: 0.55 });
  }

  for (const b of t.bridges) drawBridge(g, t, b);

  // Harita seklinde maskele (nehir haritanin disina tasmasin).
  const n = t.size;
  const mask = new Graphics();
  mask.poly([isoX(0, 0), isoY(0, 0), isoX(n, 0), isoY(n, 0), isoX(n, n), isoY(n, n), isoX(0, n), isoY(0, n)]).fill(0xffffff);
  root.addChild(mask);
  root.mask = mask;
  return root;
}

function drawBridge(g: Graphics, t: Terrain, b: Bridge): void {
  const Z = 6;
  const s0 = b.s - b.halfW;
  const s1 = b.s + b.halfW;
  const d0 = b.o - b.halfLen;
  const d1 = b.o + b.halfLen;
  const base: Pt[] = [
    scr(t.worldX(s0, d0), t.worldY(s0, d0)),
    scr(t.worldX(s1, d0), t.worldY(s1, d0)),
    scr(t.worldX(s1, d1), t.worldY(s1, d1)),
    scr(t.worldX(s0, d1), t.worldY(s0, d1)),
  ];
  const up = (p: Pt, z = Z): Pt => [p[0], p[1] - z];

  // Yan yuzler: ekranda en alttaki kosenin iki komsu kenari.
  let bottom = 0;
  for (let i = 1; i < 4; i++) if (base[i][1] > base[bottom][1]) bottom = i;
  for (const nb of [(bottom + 1) % 4, (bottom + 3) % 4]) {
    g.poly(flat([base[bottom], base[nb], up(base[nb]), up(base[bottom])])).fill(nb === (bottom + 1) % 4 ? 0x6b4a2b : 0x7f5733).stroke({ width: 1, color: 0x000000, alpha: 0.35 });
  }

  // Direkler/korkuluk: uzun kenarlar s = s0 ve s1; arka olan once.
  const rail = (sc: number): void => {
    for (let d = d0 + 0.3; d <= d1 - 0.2; d += 1.1) {
      const p = scr(t.worldX(sc, d), t.worldY(sc, d), Z);
      const q = scr(t.worldX(sc, d), t.worldY(sc, d), Z + 11);
      g.moveTo(p[0], p[1]).lineTo(q[0], q[1]).stroke({ width: 3, color: 0x5b3d22 });
    }
    const a = scr(t.worldX(sc, d0 + 0.3), t.worldY(sc, d0 + 0.3), Z + 10);
    const c = scr(t.worldX(sc, d1 - 0.2), t.worldY(sc, d1 - 0.2), Z + 10);
    g.moveTo(a[0], a[1]).lineTo(c[0], c[1]).stroke({ width: 3, color: 0x8a6238 });
  };
  const yS = (sc: number): number => scr(t.worldX(sc, b.o), t.worldY(sc, b.o))[1];
  const far = yS(s0) < yS(s1) ? s0 : s1;
  const near = far === s0 ? s1 : s0;
  rail(far);

  g.poly(flat(base.map((p) => up(p)))).fill(0xa9794a).stroke({ width: 1, color: 0x000000, alpha: 0.4 });
  for (let d = d0 + 0.45; d < d1; d += 0.45) {
    const p = scr(t.worldX(s0, d), t.worldY(s0, d), Z);
    const q = scr(t.worldX(s1, d), t.worldY(s1, d), Z);
    g.moveTo(p[0], p[1]).lineTo(q[0], q[1]).stroke({ width: 1, color: 0x000000, alpha: 0.22 });
  }
  rail(near);
}

/** Demo icin: dekoru Sprite olarak ekler (zIndex = x+y ile birimlerle birlikte siralanir). */
export function addDecorSprites(t: Terrain, atlas: Atlas, layer: Container): void {
  for (const d of t.decor) {
    const list = atlas.decor[d.kind];
    const spr9 = list[d.variant % list.length];
    const s = new Sprite(spr9.texture);
    s.anchor.set(spr9.ax, spr9.ay);
    s.position.set(isoX(d.x, d.y), isoY(d.x, d.y));
    s.zIndex = d.x + d.y;
    layer.addChild(s);
  }
}

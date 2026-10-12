import { Container, Graphics, Sprite } from 'pixi.js';
import { isoX, isoY } from '../iso';
import type { Bridge, Terrain } from '../sim/terrain';
import type { Atlas } from './atlas';
import { PALETTES, type BiomePalette } from './biome';

type Pt = [number, number];

/** Dunya (x, y) -> ekran. */
const scr = (x: number, y: number, z = 0): Pt => [isoX(x, y), isoY(x, y, z)];
const flat = (p: Pt[]): number[] => p.flatMap((q) => q);

/** Nehir, kopruler ve yollar: zemin ile birimler arasinda duran statik katman. */
export function buildTerrainOverlay(t: Terrain): Container {
  const root = new Container();
  const g = new Graphics();
  root.addChild(g);
  const pal = PALETTES[t.spec.biome];

  // Toprak yol karolari.
  for (const idx of t.pathTiles) {
    const tx = idx % t.size;
    const ty = Math.floor(idx / t.size);
    const c = [scr(tx + 0.5, ty), scr(tx + 1, ty + 0.5), scr(tx + 0.5, ty + 1), scr(tx, ty + 0.5)];
    g.poly(flat(c)).fill({ color: pal.path, alpha: 0.9 });
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
  const hasRiver = t.spec.river !== 'none';
  if (hasRiver) {
    band(1.0, 1, pal.bank); // kiyi
    band(0, 1, pal.water);
    band(0, 0.62, pal.waterMid);
    band(0, 0.22, pal.waterShine, 0.8);
  }

  // Nehir icindeki adalar: kiyi halkasi + zemin rengi.
  const tileDiamond = (tx: number, ty: number, grow: number): number[] => {
    const cx = tx + 0.5;
    const cy = ty + 0.5;
    const h = 0.5 + grow;
    return flat([scr(cx, cy - h), scr(cx + h, cy), scr(cx, cy + h), scr(cx - h, cy)]);
  };
  for (const idx of t.landTiles) g.poly(tileDiamond(idx % t.size, Math.floor(idx / t.size), 0.35)).fill({ color: pal.bank, alpha: 0.95 });
  for (const idx of t.landTiles) {
    const tx = idx % t.size;
    const ty = Math.floor(idx / t.size);
    g.poly(tileDiamond(tx, ty, 0.02)).fill((tx + ty) % 2 === 0 ? pal.grassA : pal.grassB);
  }

  // Dalga cizgileri.
  for (let s = sMin + 2; hasRiver && s < sMax; s += 3.1) {
    const o = t.offsetAt(s);
    const w = t.widthAt(s);
    const d = o + (((Math.round(s * 7) % 5) - 2) / 5) * (w * 0.35);
    const a = scr(t.worldX(s, d), t.worldY(s, d));
    const b = scr(t.worldX(s + 0.9, d), t.worldY(s + 0.9, d));
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: 1.5, color: pal.wave, alpha: pal.waveAlpha });
  }

  for (const b of t.bridges) {
    if (t.spec.crossing === 'ford') drawFord(g, t, b, pal);
    else drawBridge(g, t, b, pal, t.spec.crossing === 'stone');
  }

  // Harita seklinde maskele (nehir haritanin disina tasmasin).
  const n = t.size;
  const mask = new Graphics();
  mask.poly([isoX(0, 0), isoY(0, 0), isoX(n, 0), isoY(n, 0), isoX(n, n), isoY(n, n), isoX(0, n), isoY(0, n)]).fill(0xffffff);
  root.addChild(mask);
  root.mask = mask;
  return root;
}

/** Sig gecit: acik renkli sig su seridi ve basamak taslari. */
function drawFord(g: Graphics, t: Terrain, b: Bridge, pal: BiomePalette): void {
  const s0 = b.s - b.halfW;
  const s1 = b.s + b.halfW;
  const d0 = b.o - b.halfLen;
  const d1 = b.o + b.halfLen;
  const quad: Pt[] = [scr(t.worldX(s0, d0), t.worldY(s0, d0)), scr(t.worldX(s1, d0), t.worldY(s1, d0)), scr(t.worldX(s1, d1), t.worldY(s1, d1)), scr(t.worldX(s0, d1), t.worldY(s0, d1))];
  g.poly(flat(quad)).fill({ color: pal.bank, alpha: 0.55 });
  const inner: Pt[] = [scr(t.worldX(s0 + 0.4, d0 + 0.5), t.worldY(s0 + 0.4, d0 + 0.5)), scr(t.worldX(s1 - 0.4, d0 + 0.5), t.worldY(s1 - 0.4, d0 + 0.5)), scr(t.worldX(s1 - 0.4, d1 - 0.5), t.worldY(s1 - 0.4, d1 - 0.5)), scr(t.worldX(s0 + 0.4, d1 - 0.5), t.worldY(s0 + 0.4, d1 - 0.5))];
  g.poly(flat(inner)).fill({ color: pal.waterShine, alpha: 0.55 });
  let k = 0;
  for (let d = d0 + 0.5; d < d1; d += 0.85) {
    const sOff = Math.sin(d * 12.9898 + b.s) * 1.1;
    const p = scr(t.worldX(b.s + sOff, d), t.worldY(b.s + sOff, d));
    const r = 5 + (k++ % 3) * 1.3;
    g.ellipse(p[0], p[1] + 1.5, r + 1, r * 0.5 + 1).fill({ color: 0x000000, alpha: 0.18 });
    g.ellipse(p[0], p[1], r, r * 0.5).fill(0x9d9b92).stroke({ width: 0.8, color: 0x6a6860 });
    g.ellipse(p[0] - 1, p[1] - 1, r * 0.6, r * 0.28).fill(0xb9b7ad);
  }
}

function drawBridge(g: Graphics, t: Terrain, b: Bridge, pal: BiomePalette, stone: boolean): void {
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
    g.poly(flat([base[bottom], base[nb], up(base[nb]), up(base[bottom])])).fill(nb === (bottom + 1) % 4 ? (stone ? pal.stoneSideA : pal.deckSideA) : stone ? pal.stoneSideB : pal.deckSideB).stroke({ width: 1, color: 0x000000, alpha: 0.35 });
  }

  // Direkler/korkuluk: uzun kenarlar s = s0 ve s1; arka olan once.
  const rail = (sc: number): void => {
    for (let d = d0 + 0.3; d <= d1 - 0.2; d += 1.1) {
      const p = scr(t.worldX(sc, d), t.worldY(sc, d), Z);
      const q = scr(t.worldX(sc, d), t.worldY(sc, d), Z + 11);
      g.moveTo(p[0], p[1]).lineTo(q[0], q[1]).stroke({ width: stone ? 5 : 3, color: stone ? pal.stoneSideA : pal.post });
    }
    const a = scr(t.worldX(sc, d0 + 0.3), t.worldY(sc, d0 + 0.3), Z + 10);
    const c = scr(t.worldX(sc, d1 - 0.2), t.worldY(sc, d1 - 0.2), Z + 10);
    g.moveTo(a[0], a[1]).lineTo(c[0], c[1]).stroke({ width: stone ? 5 : 3, color: stone ? pal.stoneRail : pal.rail });
  };
  const yS = (sc: number): number => scr(t.worldX(sc, b.o), t.worldY(sc, b.o))[1];
  const far = yS(s0) < yS(s1) ? s0 : s1;
  const near = far === s0 ? s1 : s0;
  rail(far);

  g.poly(flat(base.map((p) => up(p)))).fill(stone ? pal.stoneDeck : pal.deck).stroke({ width: 1, color: 0x000000, alpha: 0.4 });
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

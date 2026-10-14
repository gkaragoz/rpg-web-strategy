import { Container, Graphics, Sprite } from 'pixi.js';
import { isoX, isoY } from '../iso';
import type { Bridge, Terrain } from '../sim/terrain';
import type { Atlas } from './atlas';
import { PALETTES, type BiomePalette } from './biome';

type Pt = [number, number];

/** World (x, y) -> screen. */
let elev = (_x: number, _y: number): number => 0;
const scr = (x: number, y: number, z = 0): Pt => [isoX(x, y), isoY(x, y, z + elev(x, y))];
const flat = (p: Pt[]): number[] => p.flatMap((q) => q);

/** River, bridges and roads: a static layer sitting between the ground and the units. */
export function buildTerrainOverlay(t: Terrain, skipRoad?: (idx: number) => boolean): Container {
  const root = new Container();
  const g = new Graphics();
  root.addChild(g);
  const pal = PALETTES[t.spec.biome];
  elev = t.hasRelief ? (x, y) => t.elevPx(x, y) : () => 0;

  // Dirt road tiles.
  for (const idx of t.pathTiles) {
    if (skipRoad && skipRoad(idx)) continue;
    drawRoadTile(g, t, idx, pal);
  }

  // River: two bank point arrays from the center line -> a single polygon instead of triangle strips.
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
  const hasRiver = t.riverKind !== 'none';
  if (hasRiver) {
    band(1.0, 1, pal.bank); // bank
    band(0, 1, pal.water);
    band(0, 0.62, pal.waterMid);
    band(0, 0.22, pal.waterShine, 0.8);
  }

  // Islands inside the river: bank ring + ground color.
  const tileDiamond = (tx: number, ty: number, grow: number): number[] => {
    const cx = tx + 0.5;
    const cy = ty + 0.5;
    const h = 0.5 + grow;
    return flat([scr(cx - h, cy - h), scr(cx + h, cy - h), scr(cx + h, cy + h), scr(cx - h, cy + h)]);
  };
  for (const idx of t.landTiles) g.poly(tileDiamond(idx % t.size, Math.floor(idx / t.size), 0.35)).fill({ color: pal.bank, alpha: 0.95 });
  for (const idx of t.landTiles) {
    const tx = idx % t.size;
    const ty = Math.floor(idx / t.size);
    g.poly(tileDiamond(tx, ty, 0.02)).fill((tx + ty) % 2 === 0 ? pal.grassA : pal.grassB);
  }

  // Wave lines.
  for (let s = sMin + 2; hasRiver && s < sMax; s += 3.1) {
    const o = t.offsetAt(s);
    const w = t.widthAt(s);
    const d = o + (((Math.round(s * 7) % 5) - 2) / 5) * (w * 0.35);
    const a = scr(t.worldX(s, d), t.worldY(s, d));
    const b = scr(t.worldX(s + 0.9, d), t.worldY(s + 0.9, d));
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: 1.5, color: pal.wave, alpha: pal.waveAlpha });
  }

  // Cross channels (island layout): bank + water tiles, under the bridges.
  const bridgeSet = new Set(t.crossBridgeTiles);
  for (const grow of [0.45, 0]) {
    for (const idx of t.crossWaterTiles) {
      const tx = idx % t.size;
      const ty = Math.floor(idx / t.size);
      const h = 0.5 + grow;
      const cx = tx + 0.5;
      const cy = ty + 0.5;
      g.poly(flat([scr(cx - h, cy - h), scr(cx + h, cy - h), scr(cx + h, cy + h), scr(cx - h, cy + h)])).fill(grow > 0 ? { color: pal.bank, alpha: 0.9 } : pal.water);
    }
  }
  for (const idx of t.crossWaterTiles) {
    if (bridgeSet.has(idx)) continue;
    const tx = idx % t.size;
    const ty = Math.floor(idx / t.size);
    if ((tx * 7 + ty * 13) % 5 !== 0) continue;
    const a = scr(tx + 0.2, ty + 0.5);
    const b = scr(tx + 0.8, ty + 0.5);
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: 1.4, color: pal.wave, alpha: pal.waveAlpha });
  }

  // Cross channel bridges (island layout): tile-based wood/stone deck.
  for (const idx of t.crossBridgeTiles) {
    const tx = idx % t.size;
    const ty = Math.floor(idx / t.size);
    const stone = t.spec.crossing === 'stone';
    const q = [scr(tx, ty, 6), scr(tx + 1, ty, 6), scr(tx + 1, ty + 1, 6), scr(tx, ty + 1, 6)];
    g.poly(flat([scr(tx + 1, ty + 1, 0), scr(tx, ty + 1, 0), q[3], q[2]])).fill(stone ? pal.stoneSideB : pal.deckSideB);
    g.poly(flat(q)).fill(stone ? pal.stoneDeck : pal.deck).stroke({ width: 1, color: 0x000000, alpha: 0.3 });
    const a = scr(tx, ty + 0.5, 6);
    const b = scr(tx + 1, ty + 0.5, 6);
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: 1, color: 0x000000, alpha: 0.18 });
  }

  for (const b of t.bridges) {
    if (t.spec.crossing === 'ford') drawFord(g, t, b, pal);
    else drawBridge(g, t, b, pal, t.spec.crossing === 'stone');
  }

  // Mask to the map shape (so the river does not spill outside the map).
  const n = t.size;
  const mask = new Graphics();
  mask.poly([isoX(0, 0), isoY(0, 0), isoX(n, 0), isoY(n, 0), isoX(n, n), isoY(n, n), isoX(0, n), isoY(0, n)]).fill(0xffffff);
  root.addChild(mask);
  root.mask = mask;
  return root;
}

/** One dirt road tile (diamond between the tile edge midpoints), on the terrain surface. */
export function drawRoadTile(g: Graphics, t: Terrain, idx: number, pal: BiomePalette = PALETTES[t.spec.biome]): void {
  elev = t.hasRelief ? (x, y) => t.elevPx(x, y) : () => 0;
  const tx = idx % t.size;
  const ty = Math.floor(idx / t.size);
  const c = [scr(tx + 0.5, ty), scr(tx + 1, ty + 0.5), scr(tx + 0.5, ty + 1), scr(tx, ty + 0.5)];
  g.poly(flat(c)).fill({ color: pal.path, alpha: 0.9 });
}

/** Ford: a light-colored shallow water strip and stepping stones. */
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

  // Side faces: the two neighboring edges of the bottom-most corner on screen.
  let bottom = 0;
  for (let i = 1; i < 4; i++) if (base[i][1] > base[bottom][1]) bottom = i;
  for (const nb of [(bottom + 1) % 4, (bottom + 3) % 4]) {
    g.poly(flat([base[bottom], base[nb], up(base[nb]), up(base[bottom])])).fill(nb === (bottom + 1) % 4 ? (stone ? pal.stoneSideA : pal.deckSideA) : stone ? pal.stoneSideB : pal.deckSideB).stroke({ width: 1, color: 0x000000, alpha: 0.35 });
  }

  // Posts/railing: long edges s = s0 and s1; the back one first.
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

/** For the demo: adds decor as a Sprite (zIndex = x+y, sorted together with units). */
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

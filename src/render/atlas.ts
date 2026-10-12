import { Container, Graphics, Rectangle, Texture, type Renderer } from 'pixi.js';
import type { Biome } from '../sim/mapSpec';
import type { DecorKind } from '../sim/terrain';
import { KIND_COUNT, MAX_TEAMS, STATS } from '../sim/units';
import { POSES, POSE_STATES, UnitView, type TeamColors } from './unitView';

const SHEET_W = 1024;
const PAD = 3;

export interface Sprite9 {
  texture: Texture;
  /** Anchor (0..1): birimin/dekorun yere basan noktasi. */
  ax: number;
  ay: number;
}

export interface Atlas {
  /** [(kind*MAX_TEAMS + team)*POSES + poz] (0 bekleme, 1-2 yuruyus, 3 hazirlik, 4 vurus) */
  unitTex: Texture[];
  /** unitTex ile ayni indeks: dokunun yere bastigi nokta (0..1). */
  unitAnchor: Array<{ ax: number; ay: number }>;
  arrowTex: Texture;
  pixelTex: Texture;
  decor: Record<DecorKind, Sprite9[]>;
  /** Efekt parcacik dokulari (beyaz; calisma aninda renklendirilir). */
  fx: Record<'puff' | 'spark' | 'star' | 'ring', Sprite9>;
  /** Atlas dokusunu GPU'dan birakir (palet degisince eskisi icin). */
  dispose: () => void;
}

interface Item {
  w: number;
  h: number;
  /** Anchor, hucre ici piksel. */
  ax: number;
  ay: number;
  draw: (c: Container, x: number, y: number) => void;
  done: (tex: Texture) => void;
}

const SKIN_D = 0x000000;

function box(g: Graphics, pts: number[], fill: number, strokeA = 0.28): void {
  g.poly(pts).fill(fill).stroke({ width: 1, color: SKIN_D, alpha: strokeA });
}

/** Cam ormani: koyu cam agaci (B stili). */
function drawPine(g: Graphics, k: number): void {
  g.ellipse(0, 0, 11 * k, 4 * k).fill({ color: 0x000000, alpha: 0.22 });
  g.rect(-2.5 * k, -8 * k, 5 * k, 8 * k).fill(0x5b3d22);
  g.poly([-15 * k, -6 * k, 15 * k, -6 * k, 0, -26 * k]).fill(0x2b6236);
  g.poly([-12 * k, -18 * k, 12 * k, -18 * k, 0, -36 * k]).fill(0x34773f);
  g.poly([-8.5 * k, -30 * k, 8.5 * k, -30 * k, 0, -46 * k]).fill(0x418a4b);
}

interface RockTheme {
  fill: number;
  stroke: number;
  top: number;
  side: number;
  snow: boolean;
}
const ROCKS: Record<Biome, RockTheme> = {
  forest: { fill: 0x9a9a94, stroke: 0x6b6b66, top: 0xb9b9b2, side: 0x8a8a84, snow: false },
  desert: { fill: 0xc2a070, stroke: 0x8d7248, top: 0xdcc08c, side: 0xb08f5f, snow: false },
  snow: { fill: 0x8e9aa6, stroke: 0x66727e, top: 0xf2f7fb, side: 0x7e8a96, snow: true },
  swamp: { fill: 0x77806a, stroke: 0x4d5546, top: 0x93a07f, side: 0x6a7260, snow: false },
};

interface HouseTheme {
  right: number;
  left: number;
  top: number;
  door: number;
  hole: number;
  beam: number;
  rubble: number;
  rubbleStroke: number;
  snow: boolean;
}
const HOUSES: Record<Biome, HouseTheme> = {
  forest: { right: 0xc8a373, left: 0xad8760, top: 0xd9bd91, door: 0x3a2a20, hole: 0x4a3426, beam: 0x6b4a2b, rubble: 0xbf9c6c, rubbleStroke: 0x8a6a44, snow: false },
  desert: { right: 0xe0c08a, left: 0xc59f68, top: 0xefd9aa, door: 0x4a3322, hole: 0x5a4028, beam: 0x7a5530, rubble: 0xd6b57c, rubbleStroke: 0x9b7a48, snow: false },
  snow: { right: 0x9a8f86, left: 0x7f756d, top: 0xd5dde4, door: 0x2e2622, hole: 0x3a322c, beam: 0x5a4636, rubble: 0xa89d93, rubbleStroke: 0x6f655c, snow: true },
  swamp: { right: 0x6f5a3c, left: 0x57462e, top: 0x7c8a4c, door: 0x241c14, hole: 0x2c231a, beam: 0x3d2f1e, rubble: 0x6b5a3e, rubbleStroke: 0x3d3224, snow: false },
};

/** Kar cami: koyu yesil katlar, uclarda kar. */
function drawSnowPine(g: Graphics, k: number): void {
  g.ellipse(0, 0, 11 * k, 4 * k).fill({ color: 0x4a5a6a, alpha: 0.22 });
  g.rect(-2.5 * k, -8 * k, 5 * k, 8 * k).fill(0x5b3d22);
  const tier = (base: number, tip: number, half: number, color: number): void => {
    g.poly([-half * k, base * k, half * k, base * k, 0, tip * k]).fill(color);
    const mid = base + (tip - base) * 0.5;
    const w = half * 0.5;
    g.poly([0, tip * k, -w * k, mid * k, -w * 0.4 * k, (mid + 1.5) * k, 0, (mid + 0.5) * k, w * 0.4 * k, (mid + 1.5) * k, w * k, mid * k]).fill(0xf4f9fc);
  };
  tier(-6, -26, 15, 0x2c5a48);
  tier(-18, -36, 12, 0x34695a);
  tier(-30, -46, 8.5, 0x3e7a68);
}

/** Palmiye (col): kavisli govde, yelpaze yapraklar. */
function drawPalm(g: Graphics, k: number): void {
  g.ellipse(0, 0, 9 * k, 3.5 * k).fill({ color: 0x000000, alpha: 0.2 });
  g.moveTo(0, 0).quadraticCurveTo(5 * k, -18 * k, 1 * k, -34 * k).stroke({ width: 4 * k, color: 0x8a6a45 });
  g.moveTo(0, 0).quadraticCurveTo(5 * k, -18 * k, 1 * k, -34 * k).stroke({ width: 1.2 * k, color: 0xa88556 });
  const tx = 1 * k;
  const ty = -34 * k;
  const leaves: Array<[number, number]> = [
    [-15, -3],
    [-11, -10],
    [-2, -13],
    [9, -9],
    [14, -2],
  ];
  leaves.forEach(([dx, dy], i) => {
    const ex = tx + dx * k;
    const ey = ty + dy * k + 5 * k;
    const mx = tx + dx * 0.5 * k;
    const my = ty + dy * 0.5 * k - 4 * k;
    g.poly([tx, ty, mx, my - 2.5 * k, ex, ey, mx, my + 3 * k]).fill(i % 2 === 0 ? 0x4f9a3c : 0x5fae48);
  });
  g.circle(tx - 1.5 * k, ty + 2 * k, 1.8 * k).fill(0x6b4a2b);
  g.circle(tx + 1.8 * k, ty + 2.5 * k, 1.8 * k).fill(0x6b4a2b);
}

function drawCactus(g: Graphics, k: number): void {
  g.ellipse(0, 0, 8 * k, 3 * k).fill({ color: 0x000000, alpha: 0.2 });
  g.roundRect(-3.2 * k, -28 * k, 6.4 * k, 28 * k, 3.2 * k).fill(0x4f8a45).stroke({ width: 0.8, color: 0x2f5a2c });
  g.roundRect(-10 * k, -20 * k, 4.4 * k, 3.4 * k, 1.7 * k).fill(0x4f8a45);
  g.roundRect(-10 * k, -26 * k, 3.6 * k, 9 * k, 1.8 * k).fill(0x4f8a45).stroke({ width: 0.8, color: 0x2f5a2c });
  g.roundRect(5.6 * k, -15 * k, 4.4 * k, 3.4 * k, 1.7 * k).fill(0x4f8a45);
  g.roundRect(6.4 * k, -22 * k, 3.6 * k, 9 * k, 1.8 * k).fill(0x4f8a45).stroke({ width: 0.8, color: 0x2f5a2c });
  g.moveTo(-0.8 * k, -26 * k).lineTo(-0.8 * k, -2 * k).stroke({ width: 1, color: 0x6fae62, alpha: 0.8 });
}

/** Olu agac (bataklik): egri kara govde, sarkan yosun. */
function drawDeadTree(g: Graphics, k: number): void {
  g.ellipse(0, 0, 10 * k, 3.6 * k).fill({ color: 0x000000, alpha: 0.25 });
  g.poly([-3 * k, 0, -2 * k, -22 * k, -0.5 * k, -34 * k, 1.5 * k, -34 * k, 2.5 * k, -20 * k, 3.5 * k, 0]).fill(0x4a3b2a).stroke({ width: 0.8, color: 0x2b2118 });
  const branch = (x0: number, y0: number, x1: number, y1: number, w: number): void => {
    g.moveTo(x0 * k, y0 * k).lineTo(x1 * k, y1 * k).stroke({ width: w * k, color: 0x4a3b2a });
  };
  branch(-1, -24, -13, -36, 2.4);
  branch(-9, -32, -14, -29, 1.4);
  branch(1.5, -30, 12, -42, 2.2);
  branch(8, -37, 14, -35, 1.3);
  branch(0, -34, -2, -46, 2);
  for (const [mx, my, len] of [[-12, -34, 9], [10, -40, 11], [-6, -29, 7]]) {
    g.moveTo(mx * k, my * k).lineTo((mx + 0.5) * k, (my + len) * k).stroke({ width: 1.6 * k, color: 0x7f9a5a, alpha: 0.85 });
  }
}

function drawRock(g: Graphics, k: number, big: boolean, th: RockTheme = ROCKS.forest): void {
  g.ellipse(0, 1, 9 * k, 3 * k).fill({ color: 0x000000, alpha: 0.2 });
  g.poly([-7 * k, 0, -4 * k, -6 * k, 4 * k, -7 * k, 8 * k, 0]).fill(th.fill).stroke({ width: 0.8, color: th.stroke });
  g.poly([-4 * k, -6 * k, 4 * k, -7 * k, 2 * k, -4 * k, -3 * k, -3.5 * k]).fill(th.top);
  if (big) {
    g.poly([2 * k, 0, 5 * k, -8 * k, 11 * k, -5 * k, 12 * k, 0]).fill(th.side).stroke({ width: 0.8, color: th.stroke });
    g.poly([5 * k, -8 * k, 11 * k, -5 * k, 8 * k, -4.5 * k]).fill(th.top);
  }
  if (th.snow) g.poly([-5 * k, -5 * k, -4 * k, -6.5 * k, 4 * k, -7.5 * k, 6 * k, -5 * k, 2 * k, -5.8 * k]).fill(0xffffff);
}

/** Kerpic (kil) ev: ayak izi w x h tile, alt kose noktasina demirli. style 0/1: hangi kose cokmus. */
function drawHouse(g: Graphics, w: number, h: number, H: number, style: number, th: HouseTheme = HOUSES.forest): void {
  const S = 32;
  const P = (a: number, b: number, z = 0): [number, number] => [((a - w) - (b - h)) * S, (((a - w) + (b - h)) * S) / 2 - z];
  const flat = (...p: Array<[number, number]>): number[] => p.flatMap((q) => q);
  const h10 = style === 0 ? H * 0.58 : H;
  const h01 = style === 1 ? H * 0.58 : H;
  const h00 = H * 0.92;
  const h11 = H;

  g.poly(flat(P(-0.4, -0.4), P(w + 0.6, -0.4), P(w + 0.6, h + 0.6), P(-0.4, h + 0.6))).fill({ color: 0x000000, alpha: 0.18 });
  box(g, flat(P(w, 0, 0), P(w, h, 0), P(w, h, h11), P(w, 0, h10)), th.right);
  box(g, flat(P(0, h, 0), P(w, h, 0), P(w, h, h11), P(0, h, h01)), th.left);
  box(g, flat(P(0, 0, h00), P(w, 0, h10), P(w, h, h11), P(0, h, h01)), th.top);
  if (th.snow) g.poly(flat(P(0.1, 0.1, h00 + 1), P(w - 0.1, 0.1, h10 + 1), P(w - 0.1, h - 0.1, h11 + 1), P(0.1, h - 0.1, h01 + 1))).fill({ color: 0xffffff, alpha: 0.82 });

  // Cokmus cati deligi ve kirisler.
  const z = H * 0.9;
  const hole = flat(P(w * 0.22, h * 0.28, z), P(w * 0.72, h * 0.28, z), P(w * 0.72, h * 0.78, z), P(w * 0.22, h * 0.78, z));
  g.poly(hole).fill(th.hole);
  for (let i = 0; i < 2; i++) {
    const a = P(w * (0.3 + i * 0.22), h * 0.2, z + 2);
    const b = P(w * (0.3 + i * 0.22 + 0.1), h * 0.85, z + 2);
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: 3, color: th.beam });
  }
  // Kapi (sag yuz) ve pencere (sol yuz), catlak.
  const b0 = h * 0.3;
  const b1 = b0 + 0.9;
  g.poly(flat(P(w, b0, 0), P(w, b1, 0), P(w, b1, H * 0.6), P(w, b0, H * 0.62))).fill(th.door);
  const a0 = w * 0.3;
  const a1 = a0 + 0.55;
  g.poly(flat(P(a0, h, H * 0.45), P(a1, h, H * 0.45), P(a1, h, H * 0.75), P(a0, h, H * 0.75))).fill(th.door);
  const c0 = P(w, h, H);
  const c1 = P(w, h - 0.45, H * 0.4);
  g.moveTo(c0[0], c0[1]).lineTo(c1[0], c1[1]).stroke({ width: 1, color: SKIN_D, alpha: 0.45 });
  // Taban enkazi.
  const r0 = P(w + 0.2, h * 0.5, 0);
  g.poly([r0[0] - 6, r0[1], r0[0] - 2, r0[1] - 5, r0[0] + 5, r0[1] - 3, r0[0] + 8, r0[1] + 1]).fill(th.rubble).stroke({ width: 0.8, color: th.rubbleStroke });
}

function drawWall(g: Graphics, style: number, th: HouseTheme = HOUSES.forest): void {
  const S = 32;
  const H = 15;
  const P = (a: number, b: number, z = 0): [number, number] => [((a - 1) - (b - 1)) * S, (((a - 1) + (b - 1)) * S) / 2 - z];
  const flat = (...p: Array<[number, number]>): number[] => p.flatMap((q) => q);
  const h10 = style === 0 ? H : H * 0.55;
  const h01 = style === 0 ? H * 0.6 : H;
  g.poly(flat(P(-0.2, -0.2), P(1.3, -0.2), P(1.3, 1.3), P(-0.2, 1.3))).fill({ color: 0x000000, alpha: 0.15 });
  box(g, flat(P(1, 0, 0), P(1, 1, 0), P(1, 1, H), P(1, 0, h10)), th.right);
  box(g, flat(P(0, 1, 0), P(1, 1, 0), P(1, 1, H), P(0, 1, h01)), th.left);
  box(g, flat(P(0, 0, H * 0.9), P(1, 0, h10), P(1, 1, H), P(0, 1, h01)), th.top);
  if (th.snow) g.poly(flat(P(0.05, 0.05, H * 0.9 + 1), P(0.95, 0.05, h10 + 1), P(0.95, 0.95, H + 1), P(0.05, 0.95, h01 + 1))).fill({ color: 0xffffff, alpha: 0.85 });
}

function drawRubble(g: Graphics, style: number, th: HouseTheme = HOUSES.forest): void {
  g.ellipse(0, 1, 11, 4).fill({ color: 0x000000, alpha: 0.15 });
  const pieces: number[][] =
    style === 0
      ? [[-9, 0, -6, -5, 0, -4, 1, 0], [1, 0, 3, -7, 9, -4, 10, 0], [-3, 1, -1, -3, 4, -2, 5, 1]]
      : [[-10, 0, -7, -4, -2, -6, 0, 0], [0, 0, 4, -5, 10, -3, 9, 0], [-5, 2, -2, -1, 3, -1, 4, 2]];
  const cols = [th.rubble, th.top, th.left];
  pieces.forEach((p, i) => g.poly(p).fill(cols[i]).stroke({ width: 0.8, color: th.rubbleStroke }));
}

/** Birim, ok ve dekor dokularini tek bir atlas dokusunda pisirir (ParticleContainer tek doku ister). */
export function bakeAtlas(renderer: Renderer, teamColors: TeamColors[], biome: Biome = 'forest'): Atlas {
  const items: Item[] = [];
  const unitTex: Texture[] = [];
  const unitAnchor: Array<{ ax: number; ay: number }> = [];
  const decor: Record<DecorKind, Sprite9[]> = { tree: [], rock: [], boulder: [], house: [], wall: [], rubble: [] };
  let arrowTex!: Texture;
  let pixelTex!: Texture;
  const fx = {} as Record<'puff' | 'spark' | 'star' | 'ring', Sprite9>;

  // Birimler: (kind*MAX_TEAMS + team)*2 + poz. Tanklar 2x buyuk hucre kullanir.
  const teams = Math.min(MAX_TEAMS, Math.max(1, teamColors.length));
  for (let kind = 0; kind < KIND_COUNT; kind++) {
    const k = STATS[kind].scale;
    const w = 64 * k;
    const h = 96 * k;
    const ax = 32 * k;
    const ay = 80 * k;
    for (let team = 0; team < teams; team++) {
      for (let pose = 0; pose < POSES; pose++) {
        const idx = (kind * MAX_TEAMS + team) * POSES + pose;
        items.push({
          w,
          h,
          ax,
          ay,
          draw: (c, x, y) => {
            const view = new UnitView(kind, teamColors[team], 0);
            view.update(POSE_STATES[pose], 0, 0);
            view.root.position.set(x + ax, y + ay);
            c.addChild(view.root);
          },
          done: (t) => {
            unitTex[idx] = t;
            unitAnchor[idx] = { ax: ax / w, ay: ay / h };
          },
        });
      }
    }
  }
  items.push({
    w: 32,
    h: 24,
    ax: 16,
    ay: 12,
    draw: (c, x, y) => {
      const g = new Graphics();
      g.moveTo(x + 4, y + 12).lineTo(x + 20, y + 12).stroke({ width: 2, color: 0x6b4a2b });
      g.poly([x + 20, y + 9, x + 25, y + 12, x + 20, y + 15]).fill(0xcfd4dc);
      g.poly([x + 4, y + 12, x + 1, y + 9, x + 7, y + 12, x + 1, y + 15]).fill(0xf2f2f2);
      c.addChild(g);
    },
    done: (t) => (arrowTex = t),
  });
  items.push({
    w: 4,
    h: 4,
    ax: 2,
    ay: 2,
    draw: (c, x, y) => c.addChild(new Graphics().rect(x, y, 4, 4).fill(0xffffff)),
    done: (t) => (pixelTex = t),
  });

  // Efekt dokulari (beyaz, merkez anchor): yumusak toz, kivilcim, 4 uclu yildiz, elips halka.
  const addFx = (name: 'puff' | 'spark' | 'star' | 'ring', w: number, h: number, paint: (g: Graphics) => void): void => {
    items.push({
      w,
      h,
      ax: w / 2,
      ay: h / 2,
      draw: (c, x, y) => {
        const g = new Graphics();
        g.position.set(x + w / 2, y + h / 2);
        paint(g);
        c.addChild(g);
      },
      done: (t) => (fx[name] = { texture: t, ax: 0.5, ay: 0.5 }),
    });
  };
  addFx('puff', 24, 24, (g) => {
    g.circle(0, 0, 11).fill({ color: 0xffffff, alpha: 0.18 });
    g.circle(0, 0, 8.5).fill({ color: 0xffffff, alpha: 0.28 });
    g.circle(0, 0, 6).fill({ color: 0xffffff, alpha: 0.42 });
    g.circle(0, 0, 3.2).fill({ color: 0xffffff, alpha: 0.6 });
  });
  addFx('spark', 14, 22, (g) => {
    g.poly([0, -10, 2.6, 0, 0, 10, -2.6, 0]).fill(0xffffff);
  });
  addFx('star', 24, 24, (g) => {
    g.poly([0, -11, 2.6, -2.6, 11, 0, 2.6, 2.6, 0, 11, -2.6, 2.6, -11, 0, -2.6, -2.6]).fill(0xffffff);
  });
  addFx('ring', 72, 38, (g) => {
    g.ellipse(0, 0, 32, 16).stroke({ width: 3.5, color: 0xffffff });
  });

  const add = (kind: DecorKind, w: number, h: number, ax: number, ay: number, paint: (g: Graphics) => void): void => {
    items.push({
      w,
      h,
      ax,
      ay,
      draw: (c, x, y) => {
        const g = new Graphics();
        g.position.set(x + ax, y + ay);
        paint(g);
        c.addChild(g);
      },
      done: (t) => decor[kind].push({ texture: t, ax: ax / w, ay: ay / h }),
    });
  };

  const rockTheme = ROCKS[biome];
  const houseTheme = HOUSES[biome];
  // Agac: biyoma gore cam, kaktus/palmiye, kar cami, olu agac (uc boy).
  const treeDraw: Array<(g: Graphics) => void> =
    biome === 'desert'
      ? [(g) => drawCactus(g, 1.0), (g) => drawPalm(g, 1.15), (g) => drawCactus(g, 1.5)]
      : biome === 'snow'
        ? [1.0, 1.3, 1.65].map((k) => (g: Graphics) => drawSnowPine(g, k))
        : biome === 'swamp'
          ? [1.0, 1.25, 1.55].map((k) => (g: Graphics) => drawDeadTree(g, k))
          : [1.0, 1.3, 1.65].map((k) => (g: Graphics) => drawPine(g, k));
  [1.0, 1.3, 1.65].forEach((k, i) => add('tree', Math.ceil(34 * k) + 6, Math.ceil(54 * k) + 10, Math.ceil(34 * k) / 2 + 3, Math.ceil(50 * k) + 4, treeDraw[i]));
  for (const k of [0.9, 1.3, 1.7]) add('rock', Math.ceil(20 * k) + 6, Math.ceil(12 * k) + 8, Math.ceil(10 * k) + 3, Math.ceil(10 * k) + 3, (g) => drawRock(g, k, false, rockTheme));
  for (const k of [1.9, 2.4, 2.9]) add('boulder', Math.ceil(26 * k) + 6, Math.ceil(14 * k) + 8, Math.ceil(11 * k) + 3, Math.ceil(11 * k) + 3, (g) => drawRock(g, k, true, rockTheme));
  const sizes: Array<[number, number]> = [
    [2, 2],
    [3, 2],
    [2, 3],
  ];
  for (const [w, h] of sizes) {
    for (let style = 0; style < 2; style++) {
      const H = 34;
      // Anchor = ayak izinin alt koseyi; x araligi [-w*32, h*32], y araligi [-(w+h)*16-H, 0].
      const W = (w + h) * 32 + 16;
      const Hh = (w + h) * 16 + H + 20;
      add('house', W, Hh, w * 32 + 8, (w + h) * 16 + H + 6, (g) => drawHouse(g, w, h, H, style, houseTheme));
    }
  }
  for (let style = 0; style < 2; style++) add('wall', 84, 62, 42, 52, (g) => drawWall(g, style, houseTheme));
  for (let style = 0; style < 2; style++) add('rubble', 30, 18, 15, 12, (g) => drawRubble(g, style, houseTheme));

  // Raf paketleme.
  const sheet = new Container();
  const placed: Array<{ item: Item; x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const item of items) {
    if (x + item.w > SHEET_W) {
      x = 0;
      y += rowH + PAD;
      rowH = 0;
    }
    placed.push({ item, x, y });
    item.draw(sheet, x, y);
    x += item.w + PAD;
    rowH = Math.max(rowH, item.h);
  }
  const sheetH = y + rowH + PAD;
  // GPU doku siniri: cok yuksek atlas'ta cozunurluk 1'e iner.
  const resolution = sheetH * 2 > 4096 ? 1 : 2;
  const atlas = renderer.generateTexture({ target: sheet, frame: new Rectangle(0, 0, SHEET_W, sheetH), resolution, antialias: true });
  sheet.destroy({ children: true });
  for (const { item, x: px, y: py } of placed) {
    item.done(new Texture({ source: atlas.source, frame: new Rectangle(px, py, item.w, item.h) }));
  }
  return { unitTex, unitAnchor, arrowTex, pixelTex, decor, fx, dispose: () => atlas.destroy(true) };
}

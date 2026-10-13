import { Container, Graphics } from 'pixi.js';

/** Attack animation family: unitView applies a separate timeline for each family. */
export type Anim = 'swing' | 'thrust' | 'bow' | 'cast' | 'slam' | 'throw' | 'siege' | 'punch';

/** Drawing hooks: UnitView moves these during animation. */
export interface Rig {
  torso: Container;
  /** Behind the body (cape, wing, tail). */
  back: Graphics;
  /** Body, head and headgear. */
  g: Graphics;
  legL: Graphics;
  legR: Graphics;
  weapon: Container | null;
  shield: Container | null;
  orb: Graphics | null;
  staff: Graphics | null;
  nock: Graphics | null;
  /** Fist pairs (punch animation): null if there are no hands. */
  fists: Container | null;
  /** Default hand drawing not needed (special bodies). */
  noHands: boolean;
  /** Team color hints. */
  skin: number;
}

const SKIN = 0xf2c9a0;
const SKIN_D = 0xa87b55;
const BROWN = 0x8b5a2b;
const STEEL = 0x8d96a3;
const STEEL_D = 0x5b6470;
const STEEL_L = 0xc9ced6;
const GOLD = 0xf2c230;
const GOLD_D = 0xb8860b;
const BONE = 0xe9e1c8;
const BONE_D = 0x8a826a;
const DARK = 0x2b2f36;
const WHITE = 0xf4f1ea;

type G = Graphics;

// ---------------------------------------------------------------- bodies

function tunic(g: G, col: number, edge: number): void {
  g.roundRect(-11, -6, 22, 18, 6).fill(col).stroke({ width: 1.5, color: edge });
}
function robe(g: G, col: number, edge: number, trim: number): void {
  g.poly([-10, -6, 10, -6, 15, 16, -15, 16]).fill(col).stroke({ width: 1.5, color: edge });
  g.rect(-12, 3, 24, 3).fill(trim);
  g.poly([-3, -6, 3, -6, 4, 16, -4, 16]).fill({ color: trim, alpha: 0.35 });
}
function plate(g: G, col: number, edge: number, trim: number): void {
  g.roundRect(-12, -7, 24, 20, 5).fill(col).stroke({ width: 1.5, color: edge });
  g.rect(-12, 3, 24, 3).fill(trim);
  g.roundRect(-9, -5, 18, 6, 3).fill({ color: 0xffffff, alpha: 0.2 });
  g.circle(-12, -6, 5).fill(col).stroke({ width: 1.2, color: edge });
  g.circle(12, -6, 5).fill(col).stroke({ width: 1.2, color: edge });
}
function heavy(g: G, col: number, edge: number, trim: number): void {
  g.roundRect(-14, -9, 28, 23, 6).fill(col).stroke({ width: 1.5, color: edge });
  g.rect(-14, 4, 28, 3).fill(trim);
  g.circle(-15, -8, 7).fill(col).stroke({ width: 1.3, color: edge });
  g.circle(15, -8, 7).fill(col).stroke({ width: 1.3, color: edge });
  g.roundRect(-9, -6, 18, 7, 3).fill({ color: 0xffffff, alpha: 0.18 });
}
function fur(g: G, col: number, edge: number): void {
  g.roundRect(-14, -8, 28, 22, 7).fill(col).stroke({ width: 1.5, color: edge });
  for (let i = -2; i <= 2; i++) g.circle(i * 5.5, -7, 4.5).fill(0xd8c8a0).stroke({ width: 0.8, color: 0x8a7a58 });
}
function bones(g: G, col = BONE): void {
  g.roundRect(-9, -6, 18, 18, 5).fill({ color: 0x14181f, alpha: 0.35 });
  for (let i = 0; i < 4; i++) g.roundRect(-10, -5 + i * 4.4, 20, 2.6, 1.3).fill(col).stroke({ width: 0.6, color: BONE_D });
  g.rect(-1.2, -6, 2.4, 17).fill(col);
}
function rock(g: G, col: number, edge: number, glow = 0): void {
  g.poly([-14, -8, 14, -8, 16, 14, -16, 14]).fill(col).stroke({ width: 1.6, color: edge });
  g.poly([-14, -8, -4, -12, 6, -9, 14, -8, 4, -4, -8, -3]).fill({ color: 0xffffff, alpha: 0.16 });
  const crack = glow || edge;
  g.moveTo(-5, -4).lineTo(-2, 3).lineTo(-6, 9).stroke({ width: 1.6, color: crack });
  g.moveTo(6, -3).lineTo(3, 5).lineTo(8, 11).stroke({ width: 1.6, color: crack });
  if (glow) {
    g.moveTo(-5, -4).lineTo(-2, 3).lineTo(-6, 9).stroke({ width: 3.4, color: glow, alpha: 0.25 });
    g.moveTo(6, -3).lineTo(3, 5).lineTo(8, 11).stroke({ width: 3.4, color: glow, alpha: 0.25 });
  }
}
function bare(g: G, skin: number, edge: number): void {
  g.roundRect(-13, -8, 26, 21, 7).fill(skin).stroke({ width: 1.5, color: edge });
  g.moveTo(0, -6).lineTo(0, 6).stroke({ width: 1, color: edge, alpha: 0.5 });
  g.moveTo(-8, 0).quadraticCurveTo(-4, 3, 0, 0).stroke({ width: 1, color: edge, alpha: 0.5 });
  g.moveTo(8, 0).quadraticCurveTo(4, 3, 0, 0).stroke({ width: 1, color: edge, alpha: 0.5 });
  g.circle(-14, -7, 6).fill(skin).stroke({ width: 1.2, color: edge });
  g.circle(14, -7, 6).fill(skin).stroke({ width: 1.2, color: edge });
}

// ---------------------------------------------------------------- heads

const HY = -14;
const HR = 12;

function eyes(g: G, y = HY, col = 0x222222, r = 1.7): void {
  g.circle(-3, y, r).fill(col);
  g.circle(5, y, r).fill(col);
}
function human(g: G, skin = SKIN, edge = SKIN_D): void {
  g.circle(0, HY, HR).fill(skin).stroke({ width: 1.5, color: edge });
  eyes(g);
}
function skull(g: G, glow = 0xff4040): void {
  g.circle(0, HY, HR).fill(BONE).stroke({ width: 1.5, color: BONE_D });
  g.circle(-4, HY - 1, 3).fill(0x14181f);
  g.circle(5, HY - 1, 3).fill(0x14181f);
  g.circle(-4, HY - 1, 1.3).fill(glow);
  g.circle(5, HY - 1, 1.3).fill(glow);
  g.poly([0, HY + 2, -1.8, HY + 5, 1.8, HY + 5]).fill(0x14181f);
  g.roundRect(-6, HY + 6, 12, 4, 1).fill(BONE).stroke({ width: 0.8, color: BONE_D });
  for (let i = -2; i <= 2; i++) g.moveTo(i * 2.4, HY + 6).lineTo(i * 2.4, HY + 10).stroke({ width: 0.8, color: BONE_D });
}
function orc(g: G, skin: number, edge: number): void {
  g.circle(0, HY, HR + 1).fill(skin).stroke({ width: 1.5, color: edge });
  g.rect(-8, HY - 6, 16, 3).fill({ color: edge, alpha: 0.6 });
  g.circle(-4, HY - 1, 2).fill(0xfff2a0);
  g.circle(5, HY - 1, 2).fill(0xfff2a0);
  g.circle(-4, HY - 1, 0.9).fill(0x222222);
  g.circle(5, HY - 1, 0.9).fill(0x222222);
  g.poly([-6, HY + 5, -4, HY - 1 + 8, -2.4, HY + 5]).fill(BONE).stroke({ width: 0.6, color: BONE_D });
  g.poly([6, HY + 5, 4, HY - 1 + 8, 2.4, HY + 5]).fill(BONE).stroke({ width: 0.6, color: BONE_D });
}
function goblin(g: G): void {
  g.poly([-11, HY - 2, -22, HY - 7, -11, HY - 8]).fill(0x7bbf4a).stroke({ width: 1, color: 0x3f7a28 });
  g.poly([11, HY - 2, 22, HY - 7, 11, HY - 8]).fill(0x7bbf4a).stroke({ width: 1, color: 0x3f7a28 });
  g.circle(0, HY, HR).fill(0x7bbf4a).stroke({ width: 1.5, color: 0x3f7a28 });
  g.circle(-4, HY - 1, 2.6).fill(0xffe94a);
  g.circle(5, HY - 1, 2.6).fill(0xffe94a);
  g.circle(-4, HY - 1, 1).fill(0x111111);
  g.circle(5, HY - 1, 1).fill(0x111111);
  g.moveTo(-4, HY + 6).quadraticCurveTo(0, HY + 9, 4, HY + 6).stroke({ width: 1.2, color: 0x2e5a1c });
}
function demonHead(g: G, skin: number, edge: number): void {
  g.poly([-8, HY - 7, -15, HY - 22, -2, HY - 11]).fill(BONE).stroke({ width: 0.9, color: BONE_D });
  g.poly([8, HY - 7, 15, HY - 22, 2, HY - 11]).fill(BONE).stroke({ width: 0.9, color: BONE_D });
  g.circle(0, HY, HR).fill(skin).stroke({ width: 1.5, color: edge });
  g.poly([-8, HY - 4, -2, HY - 2, -8, HY]).fill(0xffd21f);
  g.poly([8, HY - 4, 2, HY - 2, 8, HY]).fill(0xffd21f);
  g.moveTo(-5, HY + 6).lineTo(-2.5, HY + 8).lineTo(0, HY + 6).lineTo(2.5, HY + 8).lineTo(5, HY + 6).stroke({ width: 1.3, color: 0x2b0a0a });
}
function bull(g: G): void {
  g.poly([-9, HY - 7, -21, HY - 16, -17, HY - 5]).fill(BONE).stroke({ width: 0.9, color: BONE_D });
  g.poly([9, HY - 7, 21, HY - 16, 17, HY - 5]).fill(BONE).stroke({ width: 0.9, color: BONE_D });
  g.circle(0, HY, HR + 0.5).fill(0x8b5a3a).stroke({ width: 1.5, color: 0x4a2f1c });
  g.ellipse(0, HY + 5, 8, 6).fill(0xd8a984).stroke({ width: 1, color: 0x8a6a4a });
  g.circle(-3, HY + 5, 1.2).fill(0x3a2a20);
  g.circle(3, HY + 5, 1.2).fill(0x3a2a20);
  g.circle(-5, HY - 3, 1.7).fill(0x111111);
  g.circle(5, HY - 3, 1.7).fill(0x111111);
  g.circle(0, HY + 9, 3).stroke({ width: 1.2, color: 0xd8c8a0 });
}
function tuskHead(g: G): void {
  g.poly([-12, HY - 2, -20, HY - 9, -9, HY - 8]).fill(0x7a8089).stroke({ width: 1, color: 0x4a4f56 });
  g.poly([12, HY - 2, 20, HY - 9, 9, HY - 8]).fill(0x7a8089).stroke({ width: 1, color: 0x4a4f56 });
  g.circle(0, HY, HR + 1).fill(0x8a909a).stroke({ width: 1.5, color: 0x4a4f56 });
  g.ellipse(0, HY + 5, 9, 6).fill(0x9aa0aa).stroke({ width: 1, color: 0x5a5f66 });
  g.poly([-3, HY + 2, 0, HY - 15, 3, HY + 2]).fill(BONE).stroke({ width: 1, color: BONE_D });
  g.circle(-6, HY - 2, 1.8).fill(0x111111);
  g.circle(6, HY - 2, 1.8).fill(0x111111);
}
function gourdHead(g: G, glow = 0xffd21f): void {
  g.circle(0, HY, HR + 2).fill(0xe8741a).stroke({ width: 1.6, color: 0x8a3a0a });
  g.ellipse(-6, HY, 5, 12).stroke({ width: 1, color: 0xb8560f });
  g.ellipse(6, HY, 5, 12).stroke({ width: 1, color: 0xb8560f });
  g.poly([-7, HY - 3, -3, HY - 3, -5, HY - 8]).fill(glow);
  g.poly([7, HY - 3, 3, HY - 3, 5, HY - 8]).fill(glow);
  g.moveTo(-7, HY + 4).lineTo(-4, HY + 7).lineTo(-1, HY + 4).lineTo(2, HY + 7).lineTo(5, HY + 4).lineTo(7, HY + 6).stroke({ width: 2, color: glow });
  g.rect(-1.5, HY - 18, 3, 6).fill(0x4a7a2a);
}
function dollHead(g: G): void {
  g.circle(0, HY, HR).fill(0xcfb57a).stroke({ width: 1.5, color: 0x7a6334 });
  g.circle(-4, HY - 1, 2.6).fill(0x222222);
  g.circle(5, HY - 1, 2.6).fill(0x222222);
  g.moveTo(-6, HY + 5).lineTo(6, HY + 5).stroke({ width: 1.2, color: 0x5a3a1a });
  for (let i = -2; i <= 2; i++) g.moveTo(i * 2.6, HY + 3.2).lineTo(i * 2.6, HY + 6.8).stroke({ width: 1, color: 0x5a3a1a });
  g.moveTo(-9, HY - 6).lineTo(-3, HY - 10).stroke({ width: 1, color: 0x7a6334 });
}
function stoneHead(g: G, col: number, edge: number, glow: number): void {
  g.roundRect(-11, HY - 11, 22, 22, 4).fill(col).stroke({ width: 1.6, color: edge });
  g.rect(-9, HY - 3, 7, 4).fill(glow);
  g.rect(3, HY - 3, 7, 4).fill(glow);
  g.rect(-5, HY + 5, 10, 2.5).fill(edge);
  g.poly([-11, HY - 11, -2, HY - 15, 8, HY - 11]).fill({ color: 0xffffff, alpha: 0.15 });
}
function hoodFace(g: G, hood: number, edge: number, glow: number): void {
  g.circle(0, HY, HR + 1).fill(hood).stroke({ width: 1.5, color: edge });
  g.ellipse(0, HY + 1, 8, 8).fill(0x0d0f14);
  g.circle(-3.4, HY, 1.8).fill(glow);
  g.circle(3.4, HY, 1.8).fill(glow);
  g.poly([-12, HY - 4, 0, HY - 17, 12, HY - 4, 0, HY - 9]).fill(hood).stroke({ width: 1, color: edge });
}
function thornHead(g: G): void {
  g.roundRect(-9, HY - 13, 18, 26, 9).fill(0x4f9a45).stroke({ width: 1.6, color: 0x2f6a2c });
  g.moveTo(-3, HY - 11).lineTo(-3, HY + 10).stroke({ width: 1, color: 0x6fbe62, alpha: 0.7 });
  g.moveTo(3, HY - 11).lineTo(3, HY + 10).stroke({ width: 1, color: 0x6fbe62, alpha: 0.7 });
  eyes(g, HY, 0x222222, 1.8);
  g.moveTo(-4, HY + 5).quadraticCurveTo(0, HY + 8, 4, HY + 5).stroke({ width: 1.2, color: 0x1c4a1a });
  g.circle(0, HY - 14, 3.4).fill(0xf06aa8).stroke({ width: 0.8, color: 0xa83a74 });
  g.circle(0, HY - 14, 1.2).fill(0xffe94a);
  for (const [sx, sy] of [[-9, HY - 4], [9, HY - 4], [-9, HY + 4], [9, HY + 4]]) g.moveTo(sx, sy).lineTo(sx + (sx < 0 ? -3 : 3), sy - 1.5).stroke({ width: 1, color: 0xf2f2e0 });
}

// ---------------------------------------------------------------- headgear

function helm(g: G, col: number, plume: number | null, visor = false): void {
  g.moveTo(-12.5, -15).arc(0, -15, 12.5, Math.PI, Math.PI * 2).closePath().fill(col).stroke({ width: 1.2, color: STEEL_D });
  if (visor) {
    g.roundRect(-12, -15, 24, 12, 3).fill(col).stroke({ width: 1.2, color: STEEL_D });
    g.rect(-8, -10, 16, 3).fill(DARK);
    g.rect(-1, -15, 2, 12).fill(STEEL_D);
  }
  if (plume !== null) g.roundRect(-2, -31, 4, 8, 1).fill(plume);
}
function hood(g: G, col: number, edge: number): void {
  g.moveTo(-13, -13).arc(0, -13, 13, Math.PI, Math.PI * 2).quadraticCurveTo(0, -21, -13, -13).closePath().fill(col).stroke({ width: 1, color: edge });
}
function wizard(g: G, col: number, edge: number, star = true): void {
  g.ellipse(0, -24, 16, 4).fill(col).stroke({ width: 1.2, color: edge });
  g.poly([-10, -24, 10, -24, 2, -46, -3, -45]).fill(col).stroke({ width: 1.2, color: edge });
  g.poly([2, -46, 6, -44, 4, -40]).fill(col);
  g.rect(-10, -27, 20, 3).fill(GOLD);
  if (star) g.star(0, -33, 5, 3.2, 1.4).fill(GOLD);
}
function witch(g: G, col: number, edge: number): void {
  g.ellipse(0, -23, 19, 4.5).fill(col).stroke({ width: 1.2, color: edge });
  g.poly([-9, -23, 9, -23, 5, -40, -1, -48, -5, -40]).fill(col).stroke({ width: 1.2, color: edge });
  g.poly([-1, -48, 8, -44, 4, -42]).fill(col);
  g.rect(-9, -26, 18, 3.4).fill(0xf08a2a);
  g.roundRect(-3, -26.5, 6, 4.4, 1).fill(GOLD);
}
function berserkerHelm(g: G): void {
  g.moveTo(-13, -14).arc(0, -14, 13, Math.PI, Math.PI * 2).closePath().fill(0x9aa3b0).stroke({ width: 1.2, color: STEEL_D });
  g.rect(-13, -15, 26, 2.5).fill(0x6b5a3a);
  g.poly([-12, -17, -23, -22, -22, -31, -17, -26, -11, -22]).fill(BONE).stroke({ width: 0.9, color: BONE_D });
  g.poly([12, -17, 23, -22, 22, -31, 17, -26, 11, -22]).fill(BONE).stroke({ width: 0.9, color: BONE_D });
}
function beard(g: G, col = 0xc8863a): void {
  g.poly([-10, -10, 10, -10, 8, 3, 0, 9, -8, 3]).fill(col).stroke({ width: 1, color: 0x7a4a14 });
  g.circle(-3, HY - 0, 1.7).fill(0x222222);
  g.circle(5, HY - 0, 1.7).fill(0x222222);
}
function bandana(g: G, col: number, mask = false): void {
  g.rect(-12.5, -22, 25, 5).fill(col).stroke({ width: 1, color: 0x222222 });
  g.poly([12, -21, 20, -17, 15, -14, 12, -17]).fill(col);
  if (mask) g.roundRect(-11, -11, 22, 9, 3).fill(col).stroke({ width: 1, color: 0x222222 });
}
function nemes(g: G): void {
  g.poly([-13, -22, 13, -22, 17, 3, 8, 0, 8, -12, -8, -12, -8, 0, -17, 3]).fill(0xf2c230).stroke({ width: 1.2, color: GOLD_D });
  for (let i = 0; i < 5; i++) g.moveTo(-13, -21 + i * 3.2).lineTo(13, -21 + i * 3.2).stroke({ width: 1.3, color: 0x2a6fd0, alpha: 0.85 });
  g.poly([0, -22, 3, -29, -3, -29]).fill(0x2fb36a).stroke({ width: 0.8, color: 0x1a6a40 });
}
function habit(g: G): void {
  g.moveTo(-14, -9).arc(0, -14, 14, Math.PI * 0.95, Math.PI * 2.05).lineTo(14, 8).lineTo(-14, 8).closePath().fill(0x1b1b22).stroke({ width: 1.2, color: 0x000000 });
  g.ellipse(0, -13, 9.5, 10.5).fill(SKIN).stroke({ width: 1.2, color: SKIN_D });
  g.circle(-3, -13, 1.5).fill(0x222222);
  g.circle(4, -13, 1.5).fill(0x222222);
  g.rect(-9.5, -23, 19, 4.5).fill(WHITE).stroke({ width: 0.8, color: 0xb9b3a3 });
  g.rect(-1, -31, 2, 8).fill(WHITE);
  g.rect(-4, -28, 8, 2).fill(WHITE);
}
function miter(g: G, col: number): void {
  g.poly([-10, -24, 10, -24, 7, -42, 0, -37, -7, -42]).fill(col).stroke({ width: 1.2, color: GOLD_D });
  g.rect(-1, -40, 2, 14).fill(GOLD);
  g.rect(-4, -34, 8, 2).fill(GOLD);
}
function petasos(g: G, col: number): void {
  g.ellipse(0, -22, 18, 5).fill(col).stroke({ width: 1.2, color: 0x4a3a2a });
  g.roundRect(-8, -29, 16, 8, 4).fill(col).stroke({ width: 1.2, color: 0x4a3a2a });
}
function flameCrown(g: G): void {
  for (const [x, h] of [[-8, 12], [-4, 17], [0, 22], [4, 17], [8, 12]] as Array<[number, number]>) {
    g.poly([x - 3, -24, x, -24 - h, x + 3, -24]).fill(0xff7a1a);
    g.poly([x - 1.4, -24, x, -24 - h * 0.6, x + 1.4, -24]).fill(0xffd21f);
  }
}
function horns(g: G, col = BONE): void {
  g.poly([-9, -22, -17, -33, -5, -25]).fill(col).stroke({ width: 0.9, color: BONE_D });
  g.poly([9, -22, 17, -33, 5, -25]).fill(col).stroke({ width: 0.9, color: BONE_D });
}
function antlers(g: G): void {
  for (const s of [-1, 1]) {
    g.moveTo(s * 7, -23).lineTo(s * 11, -33).lineTo(s * 9, -41).stroke({ width: 2.2, color: 0xd8c8a0 });
    g.moveTo(s * 10, -30).lineTo(s * 17, -33).stroke({ width: 1.8, color: 0xd8c8a0 });
    g.moveTo(s * 10, -36).lineTo(s * 15, -41).stroke({ width: 1.6, color: 0xd8c8a0 });
  }
}
function halo(g: G, col = GOLD): void {
  g.ellipse(0, -32, 9, 3).stroke({ width: 2, color: col });
}

// ---------------------------------------------------------------- shield / off-hand

function mkShield(r: Rig, kind: 'round' | 'tower' | 'buckler' | 'cross' | 'bone' | 'pelte', col: number, edge: number): void {
  const sh = new Container();
  sh.position.set(-15, 2);
  const p = new Graphics();
  if (kind === 'round') {
    p.circle(0, 0, 11).fill(0x8b5a2b).stroke({ width: 1.5, color: 0x4a2f1c });
    p.circle(0, 0, 4).fill(STEEL).stroke({ width: 0.8, color: STEEL_D });
    p.circle(0, 0, 11).stroke({ width: 2, color: col, alpha: 0.9 });
  } else if (kind === 'tower') {
    p.roundRect(-8, -17, 16, 34, 4).fill(STEEL).stroke({ width: 1.6, color: STEEL_D });
    p.rect(-8, -3, 16, 5).fill(col);
    p.circle(0, 0, 3).fill(BONE).stroke({ width: 0.8, color: BONE_D });
  } else if (kind === 'buckler') {
    p.circle(0, 0, 8.5).fill(STEEL).stroke({ width: 1.4, color: STEEL_D });
    p.circle(0, 0, 3).fill(col).stroke({ width: 0.8, color: edge });
  } else if (kind === 'cross') {
    p.roundRect(-8, -14, 16, 28, 5).fill(WHITE).stroke({ width: 1.5, color: 0x8a8a8a });
    p.rect(-2, -11, 4, 22).fill(0xd8333a);
    p.rect(-6, -4, 12, 4).fill(0xd8333a);
  } else if (kind === 'bone') {
    p.roundRect(-8, -13, 16, 25, 6).fill(0x6b5a3a).stroke({ width: 1.4, color: 0x3a2f1c });
    p.moveTo(-6, -8).lineTo(6, 8).stroke({ width: 2, color: BONE });
    p.moveTo(6, -8).lineTo(-6, 8).stroke({ width: 2, color: BONE });
  } else {
    p.ellipse(0, 0, 11, 8).fill(0x7a5a38).stroke({ width: 1.4, color: 0x3a2a1c });
    p.circle(-6, 0, 3).fill(0x1d1d1d);
    p.circle(6, 0, 3).fill(0x1d1d1d);
    p.rect(-11, -1, 22, 2).fill(col);
  }
  sh.addChild(p);
  r.shield = sh;
  r.torso.addChild(sh);
}

// ---------------------------------------------------------------- weapons

function arm(r: Rig, x: number, y: number, rot: number, paint: (g: G) => void): Container {
  const w = new Container();
  w.position.set(x, y);
  w.rotation = rot;
  const g = new Graphics();
  paint(g);
  w.addChild(g);
  r.weapon = w;
  r.torso.addChild(w);
  return w;
}
const sword = (r: Rig, len = 24, blade = STEEL_L, guard = BROWN): void => {
  arm(r, 15.5, 4, 0.25, (g) => {
    g.rect(-1.7, -len + 2, 3.4, len).fill(blade).stroke({ width: 0.8, color: STEEL_D });
    g.poly([-1.7, -len + 2, 0, -len - 3, 1.7, -len + 2]).fill(blade);
    g.rect(-4.5, 1, 9, 3).fill(guard);
    g.rect(-1.2, 3, 2.4, 6).fill(guard);
  });
};
const katana = (r: Rig, glow: number): void => {
  arm(r, 15.5, 4, 0.2, (g) => {
    g.moveTo(0, 2).quadraticCurveTo(3, -16, 1, -34).stroke({ width: 3.2, color: 0xf2f6ff });
    g.moveTo(0, 2).quadraticCurveTo(3, -16, 1, -34).stroke({ width: 6, color: glow, alpha: 0.28 });
    g.rect(-4, 1, 8, 2.5).fill(GOLD);
    g.rect(-1.2, 3, 2.4, 7).fill(0x2a2a30);
  });
};
const axe = (r: Rig, head = STEEL, big = false): void => {
  arm(r, 15.5, 4, 0.25, (g) => {
    g.rect(-1.6, -24, 3.2, 32).fill(BROWN);
    const k = big ? 1.3 : 1;
    g.poly([1, -24, 11 * k, -28 * k, 12 * k, -14, 1, -14]).fill(head).stroke({ width: 1, color: STEEL_D });
    g.poly([-1, -24, -7 * k, -26 * k, -7 * k, -16, -1, -16]).fill(head).stroke({ width: 1, color: STEEL_D });
  });
};
const spear = (r: Rig, len = 30, tip = STEEL_L, flag: number | null = null): void => {
  arm(r, 16, 2, 0.12, (g) => {
    g.rect(-1.4, -len, 2.8, len + 14).fill(BROWN);
    g.poly([-3.4, -len, 0, -len - 10, 3.4, -len]).fill(tip).stroke({ width: 0.8, color: STEEL_D });
    if (flag !== null) g.poly([1.4, -len + 2, 10, -len + 6, 1.4, -len + 10]).fill(flag);
  });
};
const mace = (r: Rig, head = STEEL, spiked = true): void => {
  arm(r, 16, 3, 0.2, (g) => {
    g.rect(-1.7, -20, 3.4, 30).fill(BROWN);
    g.circle(0, -23, 7).fill(head).stroke({ width: 1, color: STEEL_D });
    if (spiked) for (let a = 0; a < 6; a++) g.poly([Math.cos(a) * 6 - 1, -23 + Math.sin(a) * 6, Math.cos(a) * 10, -23 + Math.sin(a) * 10, Math.cos(a) * 6 + 1, -23 + Math.sin(a) * 6]).fill(head);
  });
};
const hammer = (r: Rig, head = STEEL, big = 1): void => {
  arm(r, 17, 3, 0.2, (g) => {
    g.rect(-1.7 * big, -24 * big, 3.4 * big, 34 * big).fill(BROWN);
    g.roundRect(-8 * big, -32 * big, 16 * big, 11 * big, 2).fill(head).stroke({ width: 1, color: STEEL_D });
    g.rect(-8 * big, -28 * big, 16 * big, 2).fill(STEEL_D);
  });
};
const club = (r: Rig, col = 0x6b4a2b): void => {
  arm(r, 16, 4, 0.2, (g) => {
    g.poly([-2, 8, 2, 8, 6, -22, -6, -22]).fill(col).stroke({ width: 1, color: 0x3a2a1c });
    for (const [x, y] of [[-4, -16], [4, -12], [-3, -8]]) g.poly([x - 1.4, y, x, y - 4, x + 1.4, y]).fill(STEEL_L);
  });
};
const dagger = (r: Rig, x = 15.5, glow = 0): void => {
  arm(r, x, 5, 0.3, (g) => {
    g.poly([-2, 0, 0, -16, 2, 0]).fill(STEEL_L).stroke({ width: 0.8, color: STEEL_D });
    g.rect(-3.5, 0, 7, 2.2).fill(BROWN);
    g.rect(-1, 2, 2, 5).fill(BROWN);
    if (glow) g.poly([-2, 0, 0, -16, 2, 0]).stroke({ width: 3, color: glow, alpha: 0.35 });
  });
};
const bow = (r: Rig, col = BROWN, frost = false): void => {
  const w = new Container();
  w.position.set(18, 0);
  const b = new Graphics();
  b.moveTo(0, -14).quadraticCurveTo(14, 0, 0, 14).stroke({ width: 2.5, color: frost ? 0xaee0ff : col });
  b.moveTo(0, -14).lineTo(0, 14).stroke({ width: 0.8, color: 0x666666 });
  w.addChild(b);
  const nock = new Graphics();
  nock.moveTo(-9, 0).lineTo(11, 0).stroke({ width: 1.8, color: frost ? 0xcfeeff : 0x6b4a2b });
  nock.poly([11, -2.5, 16, 0, 11, 2.5]).fill(frost ? 0xaee0ff : 0xcfd4dc);
  nock.visible = false;
  w.addChild(nock);
  r.nock = nock;
  r.weapon = w;
  r.torso.addChild(w);
};
const staff = (r: Rig, orbCol: number, orbEdge: number, topper: 'orb' | 'crystal' | 'skull' | 'cross' | 'ankh' | 'lantern' | 'fire' = 'orb', wood = BROWN): void => {
  const s = new Graphics();
  s.moveTo(0, -18).lineTo(0, 14).stroke({ width: 2.5, color: wood });
  s.position.set(17, 0);
  r.staff = s;
  r.torso.addChild(s);
  const o = new Graphics();
  if (topper === 'crystal') o.poly([0, -7, 4.5, 0, 0, 7, -4.5, 0]).fill(orbCol).stroke({ width: 1, color: orbEdge });
  else if (topper === 'skull') {
    o.circle(0, 0, 5).fill(BONE).stroke({ width: 1, color: BONE_D });
    o.circle(-1.8, -0.5, 1.2).fill(orbCol);
    o.circle(1.8, -0.5, 1.2).fill(orbCol);
  } else if (topper === 'cross') {
    o.rect(-1.4, -7, 2.8, 14).fill(GOLD).stroke({ width: 0.7, color: GOLD_D });
    o.rect(-5, -3, 10, 2.8).fill(GOLD).stroke({ width: 0.7, color: GOLD_D });
  } else if (topper === 'ankh') {
    o.ellipse(0, -4, 3.6, 4.6).stroke({ width: 2, color: GOLD });
    o.rect(-1, -0.5, 2, 9).fill(GOLD);
    o.rect(-4, 3, 8, 2).fill(GOLD);
  } else if (topper === 'lantern') {
    o.roundRect(-3.5, -4, 7, 9, 2).fill(0xffd86a).stroke({ width: 1, color: 0x6b4a2b });
    o.rect(-3.5, -6, 7, 2).fill(0x4a3a2a);
  } else if (topper === 'fire') {
    o.poly([-4, 4, 0, -9, 4, 4]).fill(0xff7a1a);
    o.poly([-2, 4, 0, -4, 2, 4]).fill(0xffe27a);
  } else o.circle(0, 0, 4.5).fill(orbCol).stroke({ width: 1.2, color: orbEdge });
  o.position.set(17, -21);
  r.orb = o;
  r.torso.addChild(o);
};
const scythe = (r: Rig, glow: number): void => {
  arm(r, 16, 3, 0.15, (g) => {
    g.rect(-1.5, -32, 3, 44).fill(0x4a3a2a);
    g.moveTo(0, -32).quadraticCurveTo(14, -36, 17, -22).quadraticCurveTo(10, -30, 0, -27).closePath().fill(0xc9d0da).stroke({ width: 1, color: STEEL_D });
    g.moveTo(1, -30).quadraticCurveTo(12, -33, 16, -23).stroke({ width: 3, color: glow, alpha: 0.3 });
  });
};
const bomb = (r: Rig, col = 0x2b2f36): void => {
  arm(r, 16, 2, 0, (g) => {
    g.circle(0, -8, 8).fill(col).stroke({ width: 1.2, color: 0x000000 });
    g.circle(-2.6, -10.6, 2.2).fill({ color: 0xffffff, alpha: 0.25 });
    g.rect(-1.2, -19, 2.4, 4).fill(0x6b4a2b);
    g.moveTo(0, -19).quadraticCurveTo(4, -23, 7, -21).stroke({ width: 1.2, color: 0xc9b27a });
    g.star(7.5, -21.5, 4, 3, 1).fill(0xffb02a);
  });
};
const book = (r: Rig, col: number): void => {
  arm(r, 17, -4, 0.1, (g) => {
    g.roundRect(-8, -9, 16, 20, 2).fill(col).stroke({ width: 1.2, color: 0x2a1a0a });
    g.rect(-6, -7, 12, 16).fill({ color: 0xf4ead0, alpha: 0.95 });
    g.rect(-8, -9, 3, 20).fill(0x3a2a1a);
    g.star(2, 1, 5, 3.6, 1.4).fill(GOLD);
  });
};
const flameBlade = (r: Rig): void => {
  arm(r, 15.5, 4, 0.25, (g) => {
    g.rect(-2.2, -26, 4.4, 28).fill(0xff9a2a).stroke({ width: 0.8, color: 0xa83a0a });
    g.rect(-1, -26, 2, 28).fill(0xffe27a);
    g.poly([-2.2, -26, 0, -34, 2.2, -26]).fill(0xffd21f);
    g.rect(-5, 1, 10, 3).fill(GOLD_D);
    g.moveTo(-5, -20).lineTo(-9, -26).stroke({ width: 2, color: 0xff7a1a, alpha: 0.7 });
  });
};
const trident = (r: Rig, col = 0x9a2a6a): void => {
  arm(r, 16, 2, 0.12, (g) => {
    g.rect(-1.4, -28, 2.8, 42).fill(col);
    g.poly([-6, -22, -4, -34, -2.4, -22]).fill(STEEL_L).stroke({ width: 0.7, color: STEEL_D });
    g.poly([-2, -22, 0, -38, 2, -22]).fill(STEEL_L).stroke({ width: 0.7, color: STEEL_D });
    g.poly([2.4, -22, 4, -34, 6, -22]).fill(STEEL_L).stroke({ width: 0.7, color: STEEL_D });
    g.rect(-6, -23, 12, 2.6).fill(col);
  });
};
const flail = (r: Rig): void => {
  arm(r, 16, 3, 0.2, (g) => {
    g.rect(-1.5, -14, 3, 22).fill(0x4a3a2a);
    g.moveTo(0, -14).quadraticCurveTo(8, -20, 6, -28).stroke({ width: 1.6, color: 0x555555 });
    g.circle(6, -30, 6).fill(0x4a4f56).stroke({ width: 1, color: 0x111111 });
    for (let a = 0; a < 6; a++) g.poly([6 + Math.cos(a) * 5, -30 + Math.sin(a) * 5, 6 + Math.cos(a) * 9, -30 + Math.sin(a) * 9, 6 + Math.cos(a + 0.5) * 5, -30 + Math.sin(a + 0.5) * 5]).fill(0x2a2f36);
  });
};
const javelin = (r: Rig): void => {
  arm(r, 15, 2, 0.1, (g) => {
    g.rect(-1.2, -26, 2.4, 36).fill(0x8a6a3a);
    g.poly([-2.6, -26, 0, -34, 2.6, -26]).fill(STEEL_L).stroke({ width: 0.7, color: STEEL_D });
  });
};
const throwAxes = (r: Rig): void => {
  arm(r, 15.5, 4, 0.3, (g) => {
    g.rect(-1.4, -18, 2.8, 24).fill(BROWN);
    g.poly([1, -18, 10, -22, 10, -9, 1, -11]).fill(STEEL_L).stroke({ width: 0.9, color: STEEL_D });
    g.rect(-8, -14, 3, 12).fill(BROWN);
    g.poly([-8, -14, -15, -17, -15, -5, -8, -3]).fill(STEEL_L).stroke({ width: 0.9, color: STEEL_D });
  });
};
const fistsOf = (r: Rig, skin: number, edge: number, wrap: number | null = null): void => {
  const f = new Container();
  const g = new Graphics();
  g.circle(-14, 2, 5).fill(skin).stroke({ width: 1.2, color: edge });
  g.circle(14, 2, 5).fill(skin).stroke({ width: 1.2, color: edge });
  if (wrap !== null) {
    g.rect(-18, -1, 8, 3).fill(wrap);
    g.rect(10, -1, 8, 3).fill(wrap);
  }
  f.addChild(g);
  r.fists = f;
  r.torso.addChild(f);
};

// ---------------------------------------------------------------- extras

function cape(r: Rig, col: number, edge: number): void {
  r.back.poly([-11, -6, 11, -6, 15, 20, 0, 24, -15, 20]).fill(col).stroke({ width: 1.2, color: edge });
}
function wings(r: Rig, col: number, edge: number, bat = true): void {
  const w = r.back;
  for (const s of [-1, 1]) {
    if (bat) {
      w.poly([s * 8, -4, s * 30, -26, s * 26, -12, s * 34, -8, s * 24, -2, s * 28, 8, s * 10, 8]).fill(col).stroke({ width: 1, color: edge });
    } else {
      w.poly([s * 8, -4, s * 30, -24, s * 33, -14, s * 28, -10, s * 30, -2, s * 22, 0, s * 10, 8]).fill(col).stroke({ width: 1, color: edge });
      for (let i = 0; i < 4; i++) w.moveTo(s * 10, -2).lineTo(s * (24 + i * 2.6), -18 + i * 5).stroke({ width: 0.8, color: edge, alpha: 0.6 });
    }
  }
}
function tail(r: Rig, col: number): void {
  r.back.moveTo(-6, 8).quadraticCurveTo(-24, 14, -22, -2).stroke({ width: 3, color: col });
  r.back.poly([-22, -2, -27, -9, -17, -6]).fill(col);
}
function aura(r: Rig, col: number, a = 0.22): void {
  r.back.ellipse(0, 2, 22, 26).fill({ color: col, alpha: a });
  r.back.ellipse(0, 2, 15, 19).fill({ color: col, alpha: a });
}
function belt(g: G, col: number): void {
  g.rect(-11, 5, 22, 3.4).fill(col);
  g.roundRect(-2.5, 4.5, 5, 4.6, 1).fill(GOLD);
}
function stitches(g: G): void {
  for (let i = 0; i < 3; i++) g.moveTo(-6 + i * 6, 4).lineTo(-3 + i * 6, 8).stroke({ width: 1, color: 0x4a2f1c });
}

function legs(r: Rig, col = 0x5a4636, wide = false): void {
  const w = wide ? 8 : 6;
  r.legL.roundRect(wide ? -9 : -8, 8, w, 9, 2).fill(col);
  r.legR.roundRect(wide ? 1 : 2, 8, w, 9, 2).fill(col);
}

// ---------------------------------------------------------------- special (siege / ship / totem)

function siegeWheel(g: G, x: number, y: number, r: number): void {
  g.circle(x, y, r).fill(0x6b4a2b).stroke({ width: 1.6, color: 0x2a1a0c });
  g.circle(x, y, r * 0.35).fill(0x3a2a1c);
  for (let a = 0; a < 4; a++) g.moveTo(x, y).lineTo(x + Math.cos(a * Math.PI / 2 + 0.4) * r, y + Math.sin(a * Math.PI / 2 + 0.4) * r).stroke({ width: 1.2, color: 0x2a1a0c });
}

function drawPyreSling(r: Rig, c: number): void {
  r.noHands = true;
  r.g.roundRect(-18, 2, 36, 7, 2).fill(0x8a6238).stroke({ width: 1.3, color: 0x3a2610 });
  r.g.poly([-12, 2, -6, -12, -3, -12, -7, 2]).fill(0x7a5530).stroke({ width: 1, color: 0x3a2610 });
  r.g.poly([6, 2, 2, -12, 5, -12, 11, 2]).fill(0x7a5530).stroke({ width: 1, color: 0x3a2610 });
  siegeWheel(r.g, -13, 10, 7);
  siegeWheel(r.g, 13, 10, 7);
  r.g.rect(-18, -3, 5, 5).fill(c);
  const w = new Container();
  w.position.set(0, -10);
  const arm = new Graphics();
  arm.roundRect(-1.8, -26, 3.6, 30, 1).fill(0x9a7040).stroke({ width: 1, color: 0x3a2610 });
  arm.ellipse(0, -28, 7, 4).fill(0x6b4a2b).stroke({ width: 1, color: 0x2a1a0c });
  arm.circle(0, -31, 5).fill(0x555a62).stroke({ width: 1, color: 0x1a1d22 });
  arm.circle(0, -31, 5).stroke({ width: 3, color: 0xff7a1a, alpha: 0.5 });
  w.addChild(arm);
  w.rotation = -0.5;
  r.weapon = w;
  r.torso.addChild(w);
}
function drawBoltThrower(r: Rig, c: number): void {
  r.noHands = true;
  r.g.roundRect(-16, 3, 32, 6, 2).fill(0x8a6238).stroke({ width: 1.3, color: 0x3a2610 });
  siegeWheel(r.g, -11, 10, 6);
  siegeWheel(r.g, 11, 10, 6);
  r.g.rect(-18, -1, 5, 5).fill(c);
  r.g.roundRect(-3, -12, 6, 16, 2).fill(0x7a5530).stroke({ width: 1, color: 0x3a2610 });
  const w = new Container();
  w.position.set(6, -6);
  const b = new Graphics();
  b.moveTo(0, -17).quadraticCurveTo(13, 0, 0, 17).stroke({ width: 3, color: 0x5a3a1c });
  b.moveTo(0, -17).lineTo(0, 17).stroke({ width: 1, color: 0xd8d0b0 });
  b.rect(-22, -1.2, 28, 2.4).fill(0x8a6a3a);
  b.poly([6, -4, 16, 0, 6, 4]).fill(STEEL_L).stroke({ width: 0.8, color: STEEL_D });
  w.addChild(b);
  r.weapon = w;
  r.torso.addChild(w);
}
function drawShip(r: Rig, c: number, d: number): void {
  r.noHands = true;
  const g = r.g;
  g.poly([-26, -2, 26, -2, 20, 14, -20, 14]).fill(0x7a5330).stroke({ width: 1.6, color: 0x2a1a0c });
  g.poly([-26, -2, 26, -2, 24, 3, -24, 3]).fill(0x9a6a3c);
  for (let i = -2; i <= 2; i++) g.circle(i * 9, 7, 2.2).fill(0x1a1208);
  g.rect(-1.8, -44, 3.6, 44).fill(0x5a3a1c).stroke({ width: 1, color: 0x2a1a0c });
  g.poly([-2, -42, 22, -34, 22, -12, -2, -8]).fill(0xf0e8d0).stroke({ width: 1.2, color: 0x8a7a58 });
  g.poly([-2, -42, 12, -38, 12, -10, -2, -8]).fill({ color: c, alpha: 0.35 });
  g.circle(9, -24, 4).fill(0x14181f);
  g.rect(5, -22, 8, 1.6).fill(0x14181f);
  g.poly([0, -44, 12, -48, 12, -41]).fill(c);
  g.poly([-26, -2, -34, -8, -26, 3]).fill(0x9a6a3c).stroke({ width: 1, color: 0x2a1a0c });
  g.rect(-12, 4, 24, 3).fill(d);
  const w = new Container();
  w.position.set(20, 0);
  const cannon = new Graphics();
  cannon.roundRect(0, -3, 14, 6, 2).fill(0x2a2f36).stroke({ width: 1, color: 0x000000 });
  cannon.circle(14, 0, 3).fill(0x14181f);
  w.addChild(cannon);
  r.weapon = w;
  r.torso.addChild(w);
}
function drawTotem(r: Rig, c: number): void {
  r.noHands = true;
  const g = r.g;
  g.roundRect(-9, -34, 18, 48, 4).fill(0x8a5a2b).stroke({ width: 1.6, color: 0x3a2410 });
  for (const [y, col] of [[-26, c], [-12, 0xd8a53a], [2, 0x2fa36a]] as Array<[number, number]>) {
    g.roundRect(-8, y - 6, 16, 12, 3).fill(0x7a4a22).stroke({ width: 1, color: 0x3a2410 });
    g.rect(-6, y - 3, 4, 3).fill(col);
    g.rect(2, y - 3, 4, 3).fill(col);
    g.rect(-4, y + 2, 8, 2).fill(0x2a1a0c);
  }
  g.poly([-9, -34, 0, -44, 9, -34]).fill(0xb8863a).stroke({ width: 1, color: 0x3a2410 });
  for (const [x, col] of [[-12, 0xd8333a], [12, 0x2a6fd0], [-15, 0xf2c230], [15, 0x2fb36a]] as Array<[number, number]>) {
    g.poly([x * 0.7, -30, x * 1.6, -40, x * 0.7, -25]).fill(col);
  }
  g.circle(-4, -26, 1.5).fill(0xffe94a);
  g.circle(4, -26, 1.5).fill(0xffe94a);
  r.legL.roundRect(-8, 8, 6, 9, 2).fill(0x5a3a1c);
  r.legR.roundRect(2, 8, 6, 9, 2).fill(0x5a3a1c);
}

// ---------------------------------------------------------------- unit recipes

type Recipe = (r: Rig, c: number, d: number) => Anim;

const WIZ_RED = 0xb02a2a;
const NAVY = 0x23407a;

export const LOOKS: Record<string, Recipe> = {
  'militia': (r, c, d) => {
    legs(r);
    plate(r.g, STEEL, STEEL_D, d);
    human(r.g);
    helm(r.g, 0xaab1bc, c);
    sword(r);
    mkShield(r, 'buckler', c, d);
    return 'swing';
  },
  'longbowmen': (r, c) => {
    legs(r);
    tunic(r.g, 0x4a7a3a, 0x2a4a22);
    belt(r.g, 0x5a3a1c);
    human(r.g);
    hood(r.g, 0x3a5a2e, 0x1e3a18);
    r.g.rect(-12, -14, 24, 3).fill(c);
    bow(r);
    return 'bow';
  },
  'bulwark-guard': (r, c, d) => {
    legs(r, 0x4b4b52, true);
    heavy(r.g, 0x5b6470, 0x2b2f36, c);
    r.g.circle(0, HY, HR).fill(0x6b7480).stroke({ width: 1.5, color: 0x2b2f36 });
    helm(r.g, 0x6b7480, d, true);
    sword(r, 22, 0xaeb6c2);
    mkShield(r, 'tower', c, d);
    return 'swing';
  },
  'grenadier': (r, c) => {
    legs(r);
    tunic(r.g, 0xb86a2a, 0x6a3a14);
    belt(r.g, 0x2b2f36);
    r.g.circle(-6, 8, 3).fill(0x2b2f36);
    r.g.circle(6, 8, 3).fill(0x2b2f36);
    human(r.g);
    bandana(r.g, c);
    r.g.circle(-6, -17, 4).stroke({ width: 1.4, color: 0x8a8a8a });
    r.g.circle(4, -17, 4).stroke({ width: 1.4, color: 0x8a8a8a });
    bomb(r);
    return 'throw';
  },
  'pyre-sling': (r, c) => {
    drawPyreSling(r, c);
    return 'siege';
  },
  'dungeon-warden': (r, c, d) => {
    legs(r, 0x2a2024, true);
    heavy(r.g, 0x4a2a30, 0x1a0e10, 0xd8333a);
    for (const x of [-15, 15]) r.g.poly([x - 3, -13, x, -23, x + 3, -13]).fill(0x8a8a90).stroke({ width: 0.8, color: 0x2a2a30 });
    r.g.circle(0, HY, HR).fill(0xd9a58a).stroke({ width: 1.5, color: 0x7a4a34 });
    r.g.poly([-8, HY - 4, -2, HY - 2, -8, HY]).fill(0xff4030);
    r.g.poly([8, HY - 4, 2, HY - 2, 8, HY]).fill(0xff4030);
    horns(r.g, 0x2a2a30);
    flail(r);
    mkShield(r, 'bone', c, d);
    return 'swing';
  },
  'bone-soldier': (r, c) => {
    legs(r, BONE);
    bones(r.g);
    skull(r.g, 0x7aff9a);
    r.g.rect(-12, HY - 10, 24, 3).fill({ color: c, alpha: 0.9 });
    sword(r, 20, 0xa8a090, 0x6b4a2b);
    mkShield(r, 'bone', c, c);
    return 'swing';
  },
  'ember-adept': (r) => {
    legs(r, 0x4a2a20);
    robe(r.g, WIZ_RED, 0x6a1010, GOLD);
    human(r.g);
    wizard(r.g, 0xd84a1a, 0x7a2008);
    aura(r, 0xff6a1a, 0.16);
    staff(r, 0xff7a1a, 0xa83a0a, 'fire');
    return 'cast';
  },
  'cutpurses': (r, c) => {
    legs(r, 0x3a2a20);
    tunic(r.g, 0x7a5a38, 0x3a2a1c);
    belt(r.g, c);
    human(r.g);
    bandana(r.g, 0x2b2f36, true);
    r.g.circle(-3, HY - 2, 1.7).fill(0x222222);
    r.g.circle(5, HY - 2, 1.7).fill(0x222222);
    dagger(r);
    dagger(r, -15);
    return 'thrust';
  },
  'hill-brute': (r, c) => {
    legs(r, 0x5a4a2a, true);
    bare(r.g, 0x7fa05a, 0x3f5a2a);
    r.g.rect(-13, 3, 26, 6).fill(0x6b4a2b);
    r.g.rect(-13, 3, 26, 2).fill(c);
    orc(r.g, 0x7fa05a, 0x3f5a2a);
    r.g.poly([-6, -22, 0, -28, 6, -22]).fill(c);
    club(r);
    return 'slam';
  },
  'shade-blades': (r) => {
    aura(r, 0x6a4fa0, 0.18);
    r.back.poly([-11, -6, 11, -6, 16, 22, 8, 17, 0, 24, -8, 17, -16, 22]).fill({ color: 0x1d1830, alpha: 0.92 });
    r.g.roundRect(-11, -6, 22, 17, 6).fill(0x2a2342).stroke({ width: 1.4, color: 0x0d0a18 });
    hoodFace(r.g, 0x2a2342, 0x0d0a18, 0x9a7aff);
    dagger(r, 15.5, 0x9a7aff);
    dagger(r, -15, 0x9a7aff);
    return 'thrust';
  },
  'spark-novice': (r, c) => {
    legs(r);
    robe(r.g, NAVY, 0x0f1f40, c);
    human(r.g);
    r.g.poly([-12, -21, 12, -21, 8, -34, 0, -28, -6, -36]).fill(NAVY).stroke({ width: 1, color: 0x0f1f40 });
    r.g.rect(-12, -22, 24, 3).fill(GOLD);
    arm(r, 16, 2, 0.3, (g) => {
      g.rect(-1.2, -16, 2.4, 22).fill(0xd8c8a0);
      g.star(0, -18, 4, 4, 1.2).fill(0x7ad8ff);
    });
    return 'swing';
  },
  'berserker': (r, c, d) => {
    legs(r, 0x4a3a2a, true);
    fur(r.g, 0x7a5a38, 0x3a2a1c);
    r.g.rect(-14, 4, 28, 3).fill(c);
    human(r.g);
    beard(r.g);
    berserkerHelm(r.g);
    axe(r, STEEL, true);
    mkShield(r, 'round', c, d);
    return 'swing';
  },
  'frost-adept': (r) => {
    legs(r, 0x3a4a5a);
    robe(r.g, 0x4a8ac8, 0x1a3a6a, 0xcfeeff);
    human(r.g, 0xe6f0ff, 0x9ab0d0);
    wizard(r.g, 0x7ab8e8, 0x2a5a8a);
    aura(r, 0x9ae0ff, 0.16);
    staff(r, 0xaef0ff, 0x4a9ad0, 'crystal');
    return 'cast';
  },
  'lorekeeper': (r, c) => {
    legs(r);
    robe(r.g, 0xe8dcb8, 0x8a7a50, 0x7a3a2a);
    human(r.g);
    r.g.rect(-13, -24, 26, 3.4).fill(0x2b2f36);
    r.g.roundRect(-9, -29, 18, 6, 1).fill(0x2b2f36);
    r.g.poly([13, -23, 18, -17, 14, -16]).fill(c);
    r.g.circle(-5, HY, 4.2).stroke({ width: 1.2, color: GOLD_D });
    r.g.circle(6, HY, 4.2).stroke({ width: 1.2, color: GOLD_D });
    book(r, 0x7a3a2a);
    return 'cast';
  },
  'zealot': (r, c) => {
    legs(r, 0x2a2a30);
    plate(r.g, 0x2b2f36, 0x000000, c);
    r.g.rect(-2, -7, 4, 20).fill(WHITE);
    human(r.g);
    r.g.ellipse(0, -21, 19, 4.5).fill(0x1b1b22).stroke({ width: 1.2, color: 0x000000 });
    r.g.roundRect(-8, -30, 16, 9, 3).fill(0x1b1b22).stroke({ width: 1.2, color: 0x000000 });
    r.g.rect(-8, -24, 16, 2.4).fill(GOLD);
    spear(r, 26, 0xf4f1ea, c);
    return 'thrust';
  },
  'risen-guard': (r, c, d) => {
    legs(r, 0x3a3a32);
    plate(r.g, 0x6a7058, 0x2a2f22, 0x5a2a2a);
    skull(r.g, 0x7aff9a);
    helm(r.g, 0x5a6050, null);
    r.g.moveTo(-10, HY - 13).lineTo(-5, HY - 9).stroke({ width: 1.2, color: 0x14181f });
    sword(r, 22, 0x8a9078, 0x4a3a2a);
    mkShield(r, 'bone', c, d);
    return 'swing';
  },
  'flame-herald': (r) => {
    legs(r, 0x4a2a20, true);
    heavy(r.g, 0xc8502a, 0x5a1a08, GOLD);
    r.g.roundRect(-5, -6, 10, 12, 3).fill(0xffd21f).stroke({ width: 1, color: GOLD_D });
    human(r.g);
    helm(r.g, 0xe08a3a, null);
    flameCrown(r.g);
    aura(r, 0xff7a1a, 0.15);
    flameBlade(r);
    return 'swing';
  },
  'oathkeeper': (r, c, d) => {
    legs(r, 0x7a7a82, true);
    heavy(r.g, 0xe8e2d0, 0x8a846e, GOLD);
    r.g.rect(-2, -8, 4, 20).fill(c);
    human(r.g);
    helm(r.g, 0xf2eee0, c, true);
    for (const s of [-1, 1]) r.g.poly([s * 12, -16, s * 21, -24, s * 18, -14]).fill(WHITE).stroke({ width: 0.8, color: GOLD_D });
    cape(r, c, d);
    hammer(r, 0xf2eee0, 0.85);
    mkShield(r, 'cross', c, d);
    return 'swing';
  },
  'bolt-thrower': (r, c) => {
    drawBoltThrower(r, c);
    return 'siege';
  },
  'blast-imps': (r, c) => {
    legs(r, 0x4a3a1c);
    tunic(r.g, 0x6a5a2a, 0x2a2410);
    for (const x of [-8, 0, 8]) {
      r.g.roundRect(x - 2.2, -2, 4.4, 10, 1).fill(0xd8333a).stroke({ width: 0.8, color: 0x6a0a0a });
      r.g.moveTo(x, -2).lineTo(x + 1, -6).stroke({ width: 1, color: 0x3a2a1c });
    }
    goblin(r.g);
    r.g.rect(-12, -22, 24, 3).fill(c);
    return 'punch';
  },
  'thornlings': (r, c) => {
    legs(r, 0x3a7a32);
    r.g.roundRect(-12, -7, 24, 20, 8).fill(0x4f9a45).stroke({ width: 1.5, color: 0x2f6a2c });
    for (const x of [-6, 0, 6]) r.g.moveTo(x, -5).lineTo(x, 11).stroke({ width: 1, color: 0x6fbe62, alpha: 0.7 });
    r.g.roundRect(-20, -8, 7, 14, 3.5).fill(0x4f9a45).stroke({ width: 1.2, color: 0x2f6a2c });
    r.g.roundRect(13, -12, 7, 16, 3.5).fill(0x4f9a45).stroke({ width: 1.2, color: 0x2f6a2c });
    for (const [x, y] of [[-20, -4], [-20, 2], [20, -8], [20, -2], [-12, 4], [12, 6], [-12, -3]]) r.g.moveTo(x, y).lineTo(x + (x < 0 ? -4 : 4), y - 1.5).stroke({ width: 1.1, color: 0xf2f2e0 });
    thornHead(r.g);
    r.g.rect(-10, HY - 3, 20, 2.5).fill({ color: c, alpha: 0.9 });
    return 'punch';
  },
  'bone-caller': (r) => {
    legs(r, 0x2a2030);
    robe(r.g, 0x2a1d3a, 0x0d0a18, 0x7a3fb0);
    r.g.roundRect(-8, -6, 16, 12, 3).fill({ color: 0x14181f, alpha: 0.3 });
    hoodFace(r.g, 0x2a1d3a, 0x0d0a18, 0x7aff9a);
    r.g.circle(0, -27, 3).fill(BONE).stroke({ width: 0.8, color: BONE_D });
    aura(r, 0x4fff8a, 0.1);
    staff(r, 0x7aff9a, 0x2a8a50, 'skull', 0x3a2a1c);
    return 'cast';
  },
  'wayfarers': (r, c) => {
    legs(r, 0x6a5a3a);
    robe(r.g, 0xd8c8a0, 0x8a7a50, c);
    human(r.g);
    hood(r.g, 0xc8b88a, 0x8a7a50);
    halo(r.g);
    staff(r, 0xffd86a, 0x8a6a1a, 'lantern', 0x6b4a2b);
    return 'swing';
  },
  'night-lancer': (r) => {
    legs(r, 0x2a1830, true);
    heavy(r.g, 0x4a2a5a, 0x1a0e24, 0xd8333a);
    demonHead(r.g, 0xb04a6a, 0x5a1a34);
    cape(r, 0x2a1830, 0x0d0a18);
    trident(r);
    return 'thrust';
  },
  'sun-priest': (r) => {
    legs(r, 0x5a3a2a);
    robe(r.g, 0xf0eadc, 0xb0a888, 0xd8333a);
    r.g.rect(-12, 8, 24, 8).fill({ color: 0xd8333a, alpha: 0.6 });
    human(r.g);
    miter(r.g, 0xf4f1ea);
    aura(r, 0xffb04a, 0.14);
    staff(r, 0xff7a1a, 0xa83a0a, 'fire', 0x8a6a1a);
    return 'cast';
  },
  'soul-reaver': (r) => {
    legs(r, 0x1a1624, true);
    heavy(r.g, 0x2a2438, 0x0d0a18, 0x8a4fe0);
    hoodFace(r.g, 0x2a2438, 0x0d0a18, 0xb04fff);
    cape(r, 0x1a1624, 0x0d0a18);
    aura(r, 0x8a4fe0, 0.16);
    scythe(r, 0xb04fff);
    return 'swing';
  },
  'lancer-knight': (r, c, d) => {
    legs(r, 0x8a8a92, true);
    heavy(r.g, 0xf2eee0, 0x8a846e, 0xd8333a);
    r.g.rect(-2.2, -9, 4.4, 22).fill(0xd8333a);
    r.g.rect(-9, -2, 18, 4.4).fill(0xd8333a);
    human(r.g);
    helm(r.g, 0xe8e4d4, 0xd8333a, true);
    cape(r, 0xf4f1ea, 0xb0aa94);
    spear(r, 34, STEEL_L, 0xd8333a);
    mkShield(r, 'cross', c, d);
    return 'thrust';
  },
  'javelineers': (r, c, d) => {
    legs(r, 0x6a4a2a);
    tunic(r.g, 0xd8c8a0, 0x8a7a50);
    belt(r.g, c);
    human(r.g);
    petasos(r.g, 0x8a6a3a);
    javelin(r);
    mkShield(r, 'pelte', c, d);
    return 'throw';
  },
  'pit-fighters': (r, c) => {
    legs(r, 0x3a3a46, true);
    bare(r.g, SKIN, SKIN_D);
    r.g.rect(-13, 5, 26, 4).fill(0x2b2f36);
    r.g.moveTo(-9, -3).lineTo(-4, 3).stroke({ width: 2, color: c });
    r.g.moveTo(9, -3).lineTo(4, 3).stroke({ width: 2, color: c });
    human(r.g);
    bandana(r.g, c);
    fistsOf(r, SKIN, SKIN_D, 0xe8e0c8);
    return 'punch';
  },
  'horned-seer': (r) => {
    legs(r, 0x4a2a20);
    robe(r.g, 0x8a2a2a, 0x3a0a0a, GOLD);
    bull(r.g);
    aura(r, 0xff5a1a, 0.13);
    staff(r, 0xff6a1a, 0xa83a0a, 'fire', 0x3a2a1c);
    return 'cast';
  },
  'hex-poppets': (r, c) => {
    legs(r, 0xb89a5a);
    r.g.roundRect(-10, -5, 20, 17, 7).fill(0xcfb57a).stroke({ width: 1.4, color: 0x7a6334 });
    stitches(r.g);
    r.g.circle(-4, 2, 1.8).fill(0x222222);
    for (const [x, y] of [[-6, -2], [7, 4]]) {
      r.g.moveTo(x, y).lineTo(x + 7, y - 6).stroke({ width: 1.4, color: STEEL_L });
      r.g.circle(x + 7.5, y - 6.5, 1.8).fill(c);
    }
    dollHead(r.g);
    dagger(r, 15.5);
    return 'thrust';
  },
  'scarecrow': (r, c, d) => {
    legs(r, 0x4a2a1c, true);
    heavy(r.g, 0xa8501a, 0x4a1e08, c);
    gourdHead(r.g);
    mace(r, 0x6a4a2a);
    mkShield(r, 'round', c, d);
    return 'swing';
  },
  'hex-witch': (r) => {
    legs(r, 0x2a1d3a);
    robe(r.g, 0x4a2a6a, 0x1a0e24, 0xf08a2a);
    human(r.g, 0xcfe0b0, 0x7a8a5a);
    r.g.circle(-3, HY, 1.7).fill(0x7aff7a);
    r.g.circle(5, HY, 1.7).fill(0x7aff7a);
    witch(r.g, 0x2a1d3a, 0x0d0a18);
    aura(r, 0xb04fff, 0.13);
    staff(r, 0xf08a2a, 0x8a3a0a, 'orb', 0x3a2a1c);
    return 'cast';
  },
  'mender': (r) => {
    legs(r, 0x1b1b22);
    robe(r.g, 0x1b1b22, 0x000000, WHITE);
    r.g.rect(-6, -6, 12, 14).fill(WHITE).stroke({ width: 0.8, color: 0xb9b3a3 });
    habit(r.g);
    staff(r, 0xffffff, 0xb9b3a3, 'cross', 0x8a6a3a);
    return 'cast';
  },
  'war-barge': (r, c, d) => {
    drawShip(r, c, d);
    return 'siege';
  },
  'ash-fiend': (r) => {
    legs(r, 0x5a1a1a, true);
    wings(r, 0x5a1a2a, 0x2a0a10);
    tail(r, 0xa82a2a);
    bare(r.g, 0xc83a3a, 0x6a1010);
    r.g.rect(-13, 4, 26, 4).fill(0x2a0a0a);
    demonHead(r.g, 0xc83a3a, 0x6a1010);
    aura(r, 0xff3a1a, 0.13);
    trident(r, 0x4a1a1a);
    return 'thrust';
  },
  'axe-warden': (r, c) => {
    legs(r, 0x5a4a2a, true);
    fur(r.g, 0x9a8a68, 0x4a3a28);
    r.g.rect(-14, 4, 28, 3).fill(c);
    human(r.g);
    antlers(r.g);
    r.g.poly([-10, -10, 10, -10, 8, 1, 0, 5, -8, 1]).fill({ color: 0x8a7a58, alpha: 0.9 });
    throwAxes(r);
    return 'throw';
  },
  'dread-totem': (r, c) => {
    drawTotem(r, c);
    return 'slam';
  },
  'cinder-golem': (r) => {
    legs(r, 0x3a3236, true);
    rock(r.g, 0x4a4248, 0x14101a, 0xff6a1a);
    stoneHead(r.g, 0x5a5258, 0x14101a, 0xff8a2a);
    r.g.circle(-15, -5, 7).fill(0x4a4248).stroke({ width: 1.2, color: 0x14101a });
    r.g.circle(15, -5, 7).fill(0x4a4248).stroke({ width: 1.2, color: 0x14101a });
    aura(r, 0xff5a1a, 0.12);
    arm(r, 17, 2, 0.1, (g) => {
      g.poly([-9, -8, -4, -22, 8, -20, 11, -6, 2, 2]).fill(0x4a4248).stroke({ width: 1.4, color: 0x14101a });
      g.moveTo(-3, -16).lineTo(2, -8).stroke({ width: 2, color: 0xff8a2a });
    });
    return 'slam';
  },
  'dawn-blade': (r, c) => {
    legs(r, 0xcfc8b0);
    plate(r.g, 0xf4f0e0, 0xb0aa94, GOLD);
    r.g.rect(-2, -7, 4, 20).fill(c);
    human(r.g);
    helm(r.g, 0xf8f4e8, c);
    wings(r, 0xfdf8e0, 0xc8b878, false);
    aura(r, 0xfff2a0, 0.2);
    halo(r.g);
    katana(r, 0xffe27a);
    return 'swing';
  },
  'rime-archers': (r, c) => {
    legs(r, 0x3a4a5a);
    tunic(r.g, 0x8ac8e8, 0x2a5a8a);
    belt(r.g, 0xcfeeff);
    human(r.g, 0xe6f0ff, 0x9ab0d0);
    hood(r.g, 0xcfeeff, 0x6a9aba);
    r.g.rect(-12, -14, 24, 3).fill(c);
    aura(r, 0x9ae0ff, 0.12);
    bow(r, BROWN, true);
    return 'bow';
  },
  'tusk-rider': (r, c, d) => {
    legs(r, 0x4b4b52, true);
    heavy(r.g, 0x7a808a, 0x2b2f36, c);
    tuskHead(r.g);
    cape(r, c, d);
    spear(r, 24, STEEL_L, c);
    return 'slam';
  },
  'sand-king': (r) => {
    legs(r, 0xd8c890);
    robe(r.g, 0xf4ecd0, 0xb0a070, 0x2a6fd0);
    r.g.poly([-9, -6, 9, -6, 6, 4, -6, 4]).fill(GOLD).stroke({ width: 1, color: GOLD_D });
    human(r.g, 0xd8a070, 0x8a5a34);
    nemes(r.g);
    aura(r, 0x2fb3ff, 0.14);
    staff(r, 0x2fb3ff, 0x1a6aa0, 'ankh', 0x8a6a1a);
    return 'cast';
  },
  'granite-colossus': (r) => {
    legs(r, 0x6a6a64, true);
    rock(r.g, 0x8a8a82, 0x3a3a34, 0);
    stoneHead(r.g, 0x9a9a92, 0x3a3a34, 0x6fd06a);
    r.g.circle(-15, -5, 7).fill(0x8a8a82).stroke({ width: 1.2, color: 0x3a3a34 });
    r.g.circle(15, -5, 7).fill(0x8a8a82).stroke({ width: 1.2, color: 0x3a3a34 });
    for (const [x, y] of [[-10, 2], [8, 6], [-4, 9]]) r.g.circle(x, y, 2.6).fill({ color: 0x5aa04a, alpha: 0.85 });
    fistsOf(r, 0x8a8a82, 0x3a3a34);
    return 'slam';
  },
};

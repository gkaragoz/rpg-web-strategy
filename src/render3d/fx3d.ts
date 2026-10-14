import type { SimEvent } from '../sim/battle';

/** Glyph cells of the effect atlas: 0-9 digits, then the plus sign, a soft puff, a spark and a ring. */
export const GLYPH = { plus: 10, puff: 11, spark: 12, ring: 13 } as const;
export const GLYPH_CELLS = 16;

/** Element colors of `burst` events (physical, fire, ice, holy, dark, nature, energy). */
const ELEMENT_RGB: Array<[number, number, number]> = [
  [1, 0.92, 0.7],
  [1, 0.55, 0.15],
  [0.55, 0.85, 1],
  [1, 0.95, 0.6],
  [0.7, 0.35, 0.9],
  [0.45, 0.9, 0.35],
  [0.5, 0.8, 1],
];

export interface FxOptions {
  /** Floating damage / heal numbers. */
  numbers: boolean;
  /** Hit sparks, dust and bursts. */
  particles: boolean;
  /** Only events for which this returns true are shown (camera proximity). */
  visible?: (x: number, y: number) => boolean;
  /** Per-call spawn caps so a huge battle cannot flood the pool. */
  maxNumbers?: number;
  maxParticles?: number;
}

/**
 * Render-only effect pool (hit sparks, dust, bursts, floating damage numbers) fed by sim events. Positions are world
 * coordinates (x, up, z) like the rest of the 3D view; nothing here touches the simulation.
 */
export class Fx3D {
  count = 0;
  readonly cap: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly grow: Float32Array;
  readonly gravity: Float32Array;
  readonly glyph: Uint8Array;
  /** Offset in glyph sizes (digits of a number sit side by side). */
  readonly offX: Float32Array;
  /** 1: scales with the camera distance (numbers stay readable). */
  readonly isNumber: Uint8Array;
  readonly col: Float32Array;

  constructor(cap = 16384) {
    this.cap = cap;
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.gravity = new Float32Array(cap);
    this.glyph = new Uint8Array(cap);
    this.offX = new Float32Array(cap);
    this.isNumber = new Uint8Array(cap);
    this.col = new Float32Array(cap * 3);
  }

  clear(): void {
    this.count = 0;
  }

  private add(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, gravity: number, glyph: number, r: number, g: number, b: number, offX = 0, isNumber = 0): void {
    if (this.count >= this.cap) return;
    const i = this.count++;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.gravity[i] = gravity;
    this.glyph[i] = glyph;
    this.offX[i] = offX;
    this.isNumber[i] = isNumber;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
  }

  private number(x: number, y: number, z: number, value: number, r: number, g: number, b: number, plus: boolean, scale: number): void {
    const text = String(Math.max(0, Math.round(value)));
    const glyphs: number[] = plus ? [GLYPH.plus] : [];
    for (const ch of text) glyphs.push(ch.charCodeAt(0) - 48);
    const mid = (glyphs.length - 1) / 2;
    const drift = (Math.random() - 0.5) * 0.4;
    glyphs.forEach((gl, k) => this.add(x, y, z, drift, 1.7, 0, 0.95, 0.5 * scale, 0, 0, gl, r, g, b, (k - mid) * 0.62, 1));
  }

  /** Spawns effects for one frame of sim events. `ground(x, y)` is the terrain height at a map position (tile units). */
  spawn(events: readonly SimEvent[], ground: (x: number, y: number) => number, opts: FxOptions, rnd: () => number = Math.random): void {
    let numbers = opts.maxNumbers ?? 28;
    // Healers fire constantly: only a few heal numbers per frame so the damage numbers stay readable.
    let heals = 4;
    let puffs = opts.maxParticles ?? 160;
    const vis = opts.visible;
    for (const e of events) {
      if (numbers <= 0 && puffs <= 0) break;
      if (vis && !vis(e.x, e.y)) continue;
      const gy = Math.max(0, ground(e.x, e.y));
      const y = gy + 0.75;
      switch (e.type) {
        case 'hit': {
          const dmg = e.value ?? 0;
          if (opts.particles && puffs > 0) {
            puffs -= 3;
            for (let k = 0; k < 3; k++) {
              const a = rnd() * Math.PI * 2;
              const sp = 1.2 + rnd() * 1.8;
              this.add(e.x, y, e.y, Math.cos(a) * sp, 1.2 + rnd() * 1.4, Math.sin(a) * sp, 0.32 + rnd() * 0.2, 0.2 + rnd() * 0.12, -0.2, 6, GLYPH.spark, 1, 0.85, 0.35);
            }
            this.add(e.x, y, e.y, 0, 0.3, 0, 0.22, 0.45, 2.2, 0, GLYPH.puff, 1, 0.95, 0.8);
          }
          if (opts.numbers && numbers > 0 && dmg >= 1) {
            numbers--;
            const big = Math.min(1.8, 0.85 + dmg / 60);
            this.number(e.x, y + 0.9, e.y, dmg, 1, dmg >= 40 ? 0.5 : 0.95, dmg >= 40 ? 0.2 : 0.55, false, big);
          }
          break;
        }
        case 'heal':
          if (opts.numbers && numbers > 0 && heals > 0 && (e.value ?? 0) >= 3) {
            numbers--;
            heals--;
            this.number(e.x, y + 0.9, e.y, e.value ?? 0, 0.45, 1, 0.5, true, 0.9);
          }
          if (opts.particles && puffs > 0) {
            puffs--;
            this.add(e.x, y, e.y, 0, 0.8, 0, 0.6, 0.35, 0.8, 0, GLYPH.ring, 0.45, 1, 0.55);
          }
          break;
        case 'death':
          if (opts.particles && puffs > 0) {
            puffs -= 4;
            for (let k = 0; k < 4; k++) this.add(e.x + (rnd() - 0.5) * 0.5, gy + 0.3, e.y + (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.8, 0.5 + rnd() * 0.6, (rnd() - 0.5) * 0.8, 0.6 + rnd() * 0.3, 0.5, 1.1, -0.4, GLYPH.puff, 0.62, 0.58, 0.52);
          }
          break;
        case 'bash':
        case 'slam':
          if (opts.particles && puffs > 0) {
            puffs -= 6;
            this.add(e.x, gy + 0.15, e.y, 0, 0, 0, 0.5, 0.8, 5, 0, GLYPH.ring, 1, 0.9, 0.7);
            for (let k = 0; k < 5; k++) {
              const a = rnd() * Math.PI * 2;
              this.add(e.x, gy + 0.3, e.y, Math.cos(a) * 2.2, 0.6, Math.sin(a) * 2.2, 0.5, 0.5, 1.4, -0.5, GLYPH.puff, 0.7, 0.62, 0.5);
            }
          }
          break;
        case 'burst':
          if (opts.particles && puffs > 0) {
            const c = ELEMENT_RGB[e.element ?? 0] ?? ELEMENT_RGB[0];
            const r = Math.max(0.8, e.value ?? 1.5);
            puffs -= 8;
            this.add(e.x, gy + 0.2, e.y, 0, 0, 0, 0.55, r * 0.5, r * 2.6, 0, GLYPH.ring, c[0], c[1], c[2]);
            for (let k = 0; k < 6; k++) {
              const a = rnd() * Math.PI * 2;
              const sp = r * (1 + rnd());
              this.add(e.x, y, e.y, Math.cos(a) * sp, 0.8 + rnd(), Math.sin(a) * sp, 0.5, 0.35, -0.3, 2, GLYPH.spark, c[0], c[1], c[2]);
            }
          }
          break;
        case 'land':
          if (opts.particles && puffs > 0) {
            puffs--;
            this.add(e.x, gy + 0.1, e.y, 0, 0.4, 0, 0.35, 0.3, 1.6, 0, GLYPH.puff, 0.7, 0.62, 0.45);
          }
          break;
        default:
          break;
      }
    }
  }

  update(dt: number): void {
    let n = this.count;
    for (let i = 0; i < n; ) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        n--;
        if (i !== n) this.move(n, i);
        continue;
      }
      this.vy[i] -= this.gravity[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.size[i] = Math.max(0.02, this.size[i] + this.grow[i] * dt);
      i++;
    }
    this.count = n;
  }

  private move(from: number, to: number): void {
    for (const a of [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.age, this.life, this.size, this.grow, this.gravity, this.offX] as Float32Array[]) a[to] = a[from];
    this.glyph[to] = this.glyph[from];
    this.isNumber[to] = this.isNumber[from];
    for (let k = 0; k < 3; k++) this.col[to * 3 + k] = this.col[from * 3 + k];
  }

  /** Writes the instance buffers: iA = (x, y, z, size), iB = (u0, v0, du, dv), iC = (r, g, b, alpha), iO = (offX, 0, numberFlag). */
  write(iA: Float32Array, iB: Float32Array, iC: Float32Array, iO: Float32Array): number {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      iA[o] = this.px[i];
      iA[o + 1] = this.py[i];
      iA[o + 2] = this.pz[i];
      iA[o + 3] = this.size[i];
      const g = this.glyph[i];
      iB[o] = g / GLYPH_CELLS;
      iB[o + 1] = 0;
      iB[o + 2] = 1 / GLYPH_CELLS;
      iB[o + 3] = 1;
      const t = this.age[i] / this.life[i];
      // Numbers pop in, hold, then fade; puffs fade out linearly.
      const alpha = this.isNumber[i] ? Math.min(1, (1 - t) * 3) : (1 - t) * (1 - t);
      iC[o] = this.col[i * 3];
      iC[o + 1] = this.col[i * 3 + 1];
      iC[o + 2] = this.col[i * 3 + 2];
      iC[o + 3] = alpha;
      const p = i * 3;
      iO[p] = this.offX[i];
      iO[p + 1] = 0;
      iO[p + 2] = this.isNumber[i];
    }
    return n;
  }
}

/** Draws the glyph atlas (digits with a dark outline, plus, soft puff, spark, ring) on a canvas. */
export function drawFxAtlas(): HTMLCanvasElement {
  const cell = 64;
  const c = document.createElement('canvas');
  c.width = cell * GLYPH_CELLS;
  c.height = cell;
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 50px system-ui, sans-serif';
  g.lineJoin = 'round';
  const label = (i: number, s: string): void => {
    const cx = i * cell + cell / 2;
    g.lineWidth = 9;
    g.strokeStyle = 'rgba(0,0,0,0.9)';
    g.strokeText(s, cx, cell / 2 + 3);
    g.fillStyle = '#fff';
    g.fillText(s, cx, cell / 2 + 3);
  };
  for (let d = 0; d < 10; d++) label(d, String(d));
  label(GLYPH.plus, '+');
  // soft puff
  let cx = GLYPH.puff * cell + cell / 2;
  const rg = g.createRadialGradient(cx, cell / 2, 2, cx, cell / 2, cell / 2);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(GLYPH.puff * cell, 0, cell, cell);
  // spark (four-point star)
  cx = GLYPH.spark * cell + cell / 2;
  g.fillStyle = '#fff';
  g.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const r = k % 2 === 0 ? cell * 0.46 : cell * 0.1;
    g.lineTo(cx + Math.cos(a) * r, cell / 2 + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  // ring
  cx = GLYPH.ring * cell + cell / 2;
  g.strokeStyle = '#fff';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(cx, cell / 2, cell * 0.38, 0, Math.PI * 2);
  g.stroke();
  return c;
}

import type { Grid } from './grid';
import { T_BLOCKED, T_WATER, type Terrain } from './terrain';
import { SEPARATION_RADIUS, SEP_STRIDE } from './tuning';
import type { Units } from './units';

/**
 * Soft separation of crowded units as two parallel phases. `scan`: every unit whose turn it is (1 in SEP_STRIDE) sums the
 * push of all its neighbours onto ITSELF (it reads positions only and writes only its own push velocity; a pair is thus handled
 * from both ends over a few steps instead of pushing both at once). `apply`: every unit moves by its own push velocity and
 * the velocity decays. Neither phase reads what the other writes within the same phase, so thread order cannot matter.
 */
export class Separator {
  /** Per-step parameters (scaled for the step rate). */
  phase = 0;
  gain = 1.5;
  maxStep = 0.08;
  decay = 0.82;
  private readonly flags: Uint8Array | null;
  private readonly n: number;
  private readonly lim: number;

  constructor(
    private readonly u: Units,
    terrain: Terrain | null,
    private readonly grid: Grid,
    mapSize: number,
  ) {
    this.flags = terrain ? terrain.flags : null;
    this.n = mapSize;
    this.lim = mapSize - 0.5;
  }

  /** Is (x, y) water or an obstacle (positions are Float32: the test uses the rounded value). */
  private isBad(x: number, y: number): boolean {
    const f = this.flags![(Math.fround(y) | 0) * this.n + (Math.fround(x) | 0)];
    return f === T_WATER || f === T_BLOCKED;
  }

  /** Push/move check: the destination must not be water/an obstacle, and on a corner diagonal move the side neighbours must be open. */
  bad(ox: number, oy: number, x: number, y: number): boolean {
    if (!this.flags) return false;
    if (this.isBad(x, y)) return true;
    const fx = Math.fround(x);
    const fy = Math.fround(y);
    const gx = Math.fround(ox);
    const gy = Math.fround(oy);
    return (gx | 0) !== (fx | 0) && (gy | 0) !== (fy | 0) && (this.isBad(fx, gy) || this.isBad(gx, fy));
  }

  /** Accumulates the push on the units of [from, to) whose turn it is. */
  scan(from: number, to: number): void {
    const u = this.u;
    const grid = this.grid;
    const cols = grid.cols;
    const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    const sx = u.sepX;
    const sy = u.sepY;
    for (let i = from; i < to; i++) {
      if (!u.alive[i] || u.airT[i] > 0 || i % SEP_STRIDE !== this.phase) continue;
      const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / grid.cell) | 0));
      const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / grid.cell) | 0));
      const xi = u.x[i];
      const yi = u.y[i];
      // An attacking unit holds its ground: its neighbours push it less (the hit animation keeps playing).
      const wi = u.swing[i] > 0 ? 0.35 : 1;
      let ax = 0;
      let ay = 0;
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
          const c = gy * cols + gx;
          for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
            const j = grid.items[k];
            if (j === i || !u.alive[j] || u.airT[j] > 0) continue;
            const dx = xi - u.x[j];
            const dy = yi - u.y[j];
            const d2 = dx * dx + dy * dy;
            if (d2 >= r2) continue;
            if (d2 < 1e-6) {
              // Exactly on top of each other: a fixed, deterministic direction based on the index.
              const a = (i * 2.399963) % 6.283185;
              ax += Math.cos(a) * SEPARATION_RADIUS * 0.5;
              ay += Math.sin(a) * SEPARATION_RADIUS * 0.5;
            } else {
              const d = Math.sqrt(d2);
              const f = ((SEPARATION_RADIUS - d) * 0.5) / d;
              ax += dx * f;
              ay += dy * f;
            }
          }
        }
      }
      sx[i] += ax * this.gain * wi;
      sy[i] += ay * this.gain * wi;
    }
  }

  /** Moves the units of [from, to) by their push velocity and decays it. */
  apply(from: number, to: number): void {
    const u = this.u;
    const lim = this.lim;
    const maxStep = this.maxStep;
    const sx = u.sepX;
    const sy = u.sepY;
    for (let i = from; i < to; i++) {
      if (!u.alive[i]) continue;
      let vx = sx[i];
      let vy = sy[i];
      const m = vx * vx + vy * vy;
      if (m < 1e-7) {
        sx[i] = sy[i] = 0;
        if (u.x[i] > lim || u.y[i] > lim || u.x[i] < 0.5 || u.y[i] < 0.5) {
          u.x[i] = Math.min(lim, Math.max(0.5, u.x[i]));
          u.y[i] = Math.min(lim, Math.max(0.5, u.y[i]));
        }
        continue;
      }
      if (m > maxStep * maxStep) {
        const q = maxStep / Math.sqrt(m);
        vx *= q;
        vy *= q;
      }
      const bx = u.x[i];
      const by = u.y[i];
      let nx = Math.min(lim, Math.max(0.5, bx + vx));
      let ny = Math.min(lim, Math.max(0.5, by + vy));
      if (this.bad(bx, by, nx, ny)) {
        nx = bx;
        ny = by;
        sx[i] = sy[i] = 0;
      }
      u.x[i] = nx;
      u.y[i] = ny;
      sx[i] *= this.decay;
      sy[i] *= this.decay;
    }
  }
}

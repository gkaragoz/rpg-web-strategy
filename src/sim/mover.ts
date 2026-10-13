import { PATH_MAX } from './constants';
import { slopeSpeed } from './data/combat';
import type { Terrain } from './terrain';
import { F_RAGE, MOTION, STATS, type Units } from './units';

/** Units are processed in chunks (independent of the number of threads): one chunk is always handled by one thread, in index order.
 * A* searches are budgeted per chunk, see `runChunk`. */
export const MAX_CHUNKS = 64;

/** Intent flags (Units.mvFlags). */
export const MV_INTENT = 1;
export const MV_FACE = 2;
export const MV_ROUTE = 4;

/** Slots of the counter array (Atomics: several threads may count). */
export const CNT_STUCK = 0;
export const CNT_PATHS = 1;
export const CNT_PATH_FAILS = 2;

/** Stateless per-unit random number in [0, 1): the same on every client and every thread (replaces the shared RNG stream). */
export function unitRand(i: number, step: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(step + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Chunk layout of a battle: depends only on the unit count, never on the number of threads. */
export function chunkSize(count: number): number {
  return Math.max(256, Math.ceil(count / MAX_CHUNKS / 64) * 64);
}

/**
 * Movement of units: route over bridges, A* path following, heading smoothing, slope speed and obstacle sliding.
 * A unit's move reads only its own state, its goal and the static terrain and writes only its own state, so any set of
 * units can be moved in parallel (see `runChunk`); cross-unit consequences (a target that is unreachable) are recorded in
 * `Units.mvFail` and applied afterwards by the battle in unit order.
 */
export class Mover {
  /** Per-step parameters (set by the battle each step; scaled for the step rate). */
  brakeK: number = MOTION.brake;
  losEvery = 20;
  stepNo = 0;
  /** Number of chunks of the movement phase this step (set with the other per-step parameters). */
  chunks = 1;
  /** Counters (CNT_*). */
  readonly counts: Int32Array;
  private pathBudget = 0;
  private rx = 0;
  private ry = 0;
  private readonly tmpA = { x: 0, y: 0 };
  private readonly tmpB = { x: 0, y: 0 };

  constructor(
    private readonly u: Units,
    private readonly t: Terrain | null,
    private readonly mapSize: number,
    /** 'rage' skill move factor parameter (a). */
    private readonly rageA: number,
    counts?: Int32Array,
  ) {
    this.counts = counts ?? new Int32Array(4);
  }

  private moveMul(i: number): number {
    const u = this.u;
    let m = u.slowT[i] > 0 ? u.slowK[i] : 1;
    if ((u.flags[i] & F_RAGE) !== 0) m *= 1 + this.rageA * 0.5;
    return m;
  }

  private faceTo(i: number, dx: number, dy: number): void {
    const sx = dx - dy; // screen x direction
    if (Math.abs(sx) > 0.05) this.u.facing[i] = sx >= 0 ? 1 : -1;
  }

  /** Executes the queued move intents of units [from, to) (chunk number `chunk`): same result whichever thread runs the chunk. */
  runChunk(from: number, to: number, dt: number, chunk: number): void {
    const u = this.u;
    // About 24-30 A* searches per step for the whole army, however it is split: few chunks get several each step, many chunks one every other step.
    this.pathBudget = this.chunks > 24 ? ((chunk + this.stepNo) % 2 === 0 ? 1 : 0) : Math.ceil(24 / Math.max(1, this.chunks));
    for (let i = from; i < to; i++) {
      const f = u.mvFlags[i];
      if ((f & MV_INTENT) === 0) continue;
      u.mvFlags[i] = 0;
      if (!u.alive[i]) continue;
      this.move(i, u.mvGx[i], u.mvGy[i], u.mvSpeed[i], dt, (f & MV_FACE) !== 0, (f & MV_ROUTE) !== 0);
    }
  }

  /** Moves unit i toward (gx, gy) now. Returns the distance moved. */
  move(i: number, gx: number, gy: number, speed: number, dt: number, faceMove = true, useRoute = true): number {
    const u = this.u;
    const t = this.t;
    if (u.slowT[i] > 0 || u.flags[i] !== 0) speed *= this.moveMul(i);
    if (t && useRoute) {
      this.applyRoute(i, gx, gy);
      gx = this.rx;
      gy = this.ry;
      this.followPath(i, gx, gy, dt);
      gx = this.rx;
      gy = this.ry;
    }
    const dx = gx - u.x[i];
    const dy = gy - u.y[i];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-4) return 0;
    let ux = dx / d;
    let uy = dy / d;
    if (u.sideT[i] > 0) {
      const sd = u.sideDir[i];
      const sx = -uy * sd;
      const sy = ux * sd;
      ux = ux * 0.35 + sx * 0.9;
      uy = uy * 0.35 + sy * 0.9;
      const m = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= m;
      uy /= m;
    }
    // Smooth heading: turn the heading gently toward the target for steady progress; brake on a reversal.
    const hl = Math.abs(u.hx[i]) + Math.abs(u.hy[i]);
    if (hl < 0.01) {
      u.hx[i] = ux;
      u.hy[i] = uy;
    } else {
      const dot = u.hx[i] * ux + u.hy[i] * uy;
      if (dot < -0.3) u.spd[i] *= this.brakeK;
      const k = Math.min(1, MOTION.turn * dt);
      let hx = u.hx[i] + (ux - u.hx[i]) * k;
      let hy = u.hy[i] + (uy - u.hy[i]) * k;
      const hm = Math.sqrt(hx * hx + hy * hy) || 1;
      hx /= hm;
      hy /= hm;
      u.hx[i] = hx;
      u.hy[i] = hy;
    }
    // Accelerate: a standing unit gets going quickly but not instantly; the target speed is never exceeded.
    u.spd[i] = Math.min(speed, u.spd[i] + MOTION.accel * dt);
    // Safety: if the computed speed is very low, still advance (so stuck detection can work).
    const eff = Math.max(u.spd[i], speed * 0.25);
    ux = u.hx[i];
    uy = u.hy[i];
    let step = Math.min(eff * dt, d);
    const ox = u.x[i];
    const oy = u.y[i];
    // Slopes: uphill slows down with the steepness of the climb, downhill is slightly faster (see slopeSpeed).
    if (t && t.hasRelief) {
      const grade = (t.heightAt(ox + ux * 0.45, oy + uy * 0.45) - t.heightAt(ox, oy)) / 0.45;
      step *= slopeSpeed(grade, STATS[u.kind[i]].scale > 1.5);
    }
    // Positions are stored as Float32: the walkability test must use the rounded value.
    const lim = this.mapSize - 0.5;
    let nx = Math.fround(Math.min(lim, Math.max(0.5, ox + ux * step)));
    let ny = Math.fround(Math.min(lim, Math.max(0.5, oy + uy * step)));
    if (t && !t.stepOk(ox, oy, nx, ny)) {
      // In front of an obstacle, slide along the edge at FULL speed (so the unit can progress even if the target direction is perpendicular to the obstacle).
      const canX = t.walkable(Math.fround(ox + (ux >= 0 ? step : -step)), oy);
      const canY = t.walkable(ox, Math.fround(oy + (uy >= 0 ? step : -step)));
      const dirX = Math.abs(ux) > 1e-3 ? (ux > 0 ? 1 : -1) : u.sideDir[i];
      const dirY = Math.abs(uy) > 1e-3 ? (uy > 0 ? 1 : -1) : u.sideDir[i];
      let slideX = canX && (!canY || Math.abs(ux) >= Math.abs(uy));
      let slideY = canY && !slideX;
      if (!slideX && !slideY) {
        // Both axes are blocked in the direct direction: try the opposite direction (beside the obstacle).
        if (t.walkable(Math.fround(ox + dirX * -step), oy) && Math.abs(ux) > 1e-3) {
          nx = Math.fround(ox - dirX * step);
          ny = oy;
        } else {
          nx = ox;
          ny = oy;
        }
        slideX = slideY = false;
      }
      if (slideX) {
        nx = Math.fround(Math.min(lim, Math.max(0.5, ox + dirX * step)));
        ny = oy;
        if (!t.walkable(nx, ny)) nx = ox;
      } else if (slideY) {
        nx = ox;
        ny = Math.fround(Math.min(lim, Math.max(0.5, oy + dirY * step)));
        if (!t.walkable(nx, ny)) ny = oy;
      }
      // The slide branch in the opposite direction must be validated too.
      if (!t.walkable(nx, ny)) {
        nx = ox;
        ny = oy;
      }
    }
    u.x[i] = nx;
    u.y[i] = ny;
    const mdx = nx - ox;
    const mdy = ny - oy;
    const mv = Math.sqrt(mdx * mdx + mdy * mdy);
    u.vx[i] = mdx / dt;
    u.vy[i] = mdy / dt;
    if (mv > 1e-4) u.moving[i] = 1;

    // Net displacement window: count as stuck if the unit advanced less than 0.3 tiles in 0.8 s (including back-and-forth wiggling).
    u.winT[i] += dt;
    if (u.winT[i] >= 0.8) {
      const wx = u.x[i] - u.winX[i];
      const wy = u.y[i] - u.winY[i];
      if (wx * wx + wy * wy < 0.09 && d > 1.2) {
        u.stuckT[i] = Math.max(u.stuckT[i], 0.6);
        Atomics.add(this.counts, CNT_STUCK, 1);
      }
      u.winX[i] = u.x[i];
      u.winY[i] = u.y[i];
      u.winT[i] = 0;
    }
    // Real progress toward the target (dragging along an edge does not count as progress).
    const progress = mdx * ux + mdy * uy;
    if (step > 0.02 && progress < step * 0.25) {
      u.stuckT[i] += dt;
      if (u.stuckT[i] > 0.5 && d > 1) {
        u.sideT[i] = 0.6;
        u.sideDir[i] = unitRand(i, this.stepNo) < 0.5 ? -1 : 1;
        u.stuckT[i] = 0;
        Atomics.add(this.counts, CNT_STUCK, 1);
      }
    } else if (u.stuckT[i] > 0) {
      u.stuckT[i] = Math.max(0, u.stuckT[i] - dt);
    }
    if (faceMove) this.faceTo(i, dx, dy);
    return mv;
  }

  /**
   * A* path for a stuck unit: if a path exists, (rx, ry) = the next waypoint. If there is none, the target is
   * unreachable: `mvFail` is set and the battle bans it afterwards.
   */
  private followPath(i: number, gx: number, gy: number, dt: number): void {
    const u = this.u;
    const t = this.t!;
    const base = i * PATH_MAX * 2;
    const pts = u.pathPts;
    this.rx = gx;
    this.ry = gy;
    let has = u.pathN[i] > 0;
    if (has) {
      u.pathT[i] += dt;
      const gd = (gx - u.pathGx[i]) ** 2 + (gy - u.pathGy[i]) ** 2;
      if (gd > 9 || u.pathT[i] > 12) {
        u.pathN[i] = 0;
        has = false;
      }
    }
    // Every ~0.6 s (staggered per unit) a line-of-sight check: if the target/waypoint is not visible, request a path,
    // if it is visible, drop the current path.
    let blocked = false;
    if ((i + this.stepNo) % this.losEvery === 0) {
      const dx0 = gx - u.x[i];
      const dy0 = gy - u.y[i];
      const far = dx0 * dx0 + dy0 * dy0 > 6;
      const clear = !far || t.lineWalkable(u.x[i], u.y[i], gx, gy);
      if (has && clear) {
        u.pathN[i] = 0;
        has = false;
      }
      blocked = far && !clear;
    }
    // If the next waypoint of the active path is not visible from the current position (dragged/pushed), rebuild the path.
    let dropped = false;
    if (has) {
      const k = Math.min(u.pathK[i], u.pathN[i] - 1);
      if (!t.lineWalkable(u.x[i], u.y[i], pts[base + k * 2], pts[base + k * 2 + 1])) {
        u.pathN[i] = 0;
        has = false;
        dropped = true;
      }
    }
    if (!has && (u.stuckT[i] > 0.3 || blocked || dropped) && this.pathBudget > 0) {
      this.pathBudget--;
      const found = t.findPath(u.x[i], u.y[i], gx, gy);
      if (found && found.length > 0) {
        const n = Math.min(PATH_MAX, found.length / 2);
        for (let k = 0; k < n * 2; k++) pts[base + k] = found[k];
        u.pathN[i] = n;
        u.pathK[i] = 0;
        u.pathGx[i] = gx;
        u.pathGy[i] = gy;
        u.pathT[i] = 0;
        has = true;
        Atomics.add(this.counts, CNT_PATHS, 1);
        u.sideT[i] = 0;
      } else if (!found) {
        Atomics.add(this.counts, CNT_PATH_FAILS, 1);
        u.mvFail[i] = 1;
        u.stuckT[i] = 0;
      }
    }
    if (!has) return;
    const m = u.pathN[i];
    let k = u.pathK[i];
    while (k < m) {
      const wx = pts[base + k * 2] - u.x[i];
      const wy = pts[base + k * 2 + 1] - u.y[i];
      if (wx * wx + wy * wy > 0.12) break;
      k++;
    }
    // If the next waypoint is directly visible from the unit's current position, skip the waypoint.
    if (k + 1 < m && t.lineWalkable(u.x[i], u.y[i], pts[base + (k + 1) * 2], pts[base + (k + 1) * 2 + 1])) k++;
    if (k >= m) {
      u.pathN[i] = 0;
      return;
    }
    u.pathK[i] = k;
    this.rx = pts[base + k * 2];
    this.ry = pts[base + k * 2 + 1];
    u.sideT[i] = 0;
  }

  /** River crossing: if the target is on the opposite bank, (rx, ry) = bridge entrance/exit, otherwise the target itself. */
  private applyRoute(i: number, gx: number, gy: number): void {
    const u = this.u;
    const t = this.t!;
    this.rx = gx;
    this.ry = gy;
    const su = t.sideAt(u.x[i], u.y[i]);
    const sg = t.sideAt(gx, gy);
    let b = u.route[i];
    const lat = (((i * 37) % 100) / 100 - 0.5) * 1.8;

    // If it left the bridge corridor (pushed to the shore, target changed), reset the phase: return to the entrance.
    if (b >= 0 && u.routePhase[i] === 1) {
      const br = t.bridges[b];
      const s = t.toS(u.x[i], u.y[i]);
      const d = t.toD(u.x[i], u.y[i]);
      if (Math.abs(s - br.s) > br.halfW + 0.4 || Math.abs(d - br.o) > br.halfLen + 1.2) u.routePhase[i] = 0;
    }

    if (su === sg) {
      if (b >= 0 && u.routePhase[i] === 1) {
        // Past the midpoint: leave via the bridge up to the far end.
        const e = this.tmpA;
        t.bridgeEnd(t.bridges[b], su, lat, e);
        const ex = e.x - u.x[i];
        const ey = e.y - u.y[i];
        if (ex * ex + ey * ey > 1) {
          this.rx = e.x;
          this.ry = e.y;
          return;
        }
      }
      u.route[i] = -1;
      u.routePhase[i] = 0;
      return;
    }

    if (b < 0) {
      b = this.chooseBridge(su, u.x[i], u.y[i], gx, gy);
      if (b < 0) return;
      u.route[i] = b;
      u.routePhase[i] = 0;
    }
    const br = t.bridges[b];
    if (u.routePhase[i] === 0) {
      const e = this.tmpA;
      t.bridgeEnd(br, su, lat, e);
      const ex = e.x - u.x[i];
      const ey = e.y - u.y[i];
      if (ex * ex + ey * ey > 0.8) {
        this.rx = e.x;
        this.ry = e.y;
        return;
      }
      u.routePhase[i] = 1;
    }
    const x = this.tmpA;
    t.bridgeEnd(br, -su, lat, x);
    this.rx = x.x;
    this.ry = x.y;
  }

  private chooseBridge(su: number, x: number, y: number, gx: number, gy: number): number {
    const t = this.t!;
    let best = -1;
    let bestCost = Infinity;
    const a = this.tmpA;
    const c = this.tmpB;
    for (let k = 0; k < t.bridges.length; k++) {
      const br = t.bridges[k];
      t.bridgeEnd(br, su, 0, a);
      t.bridgeEnd(br, -su, 0, c);
      const cost = Math.hypot(a.x - x, a.y - y) + br.w + 5 + Math.hypot(c.x - gx, c.y - gy);
      if (cost < bestCost) {
        bestCost = cost;
        best = k;
      }
    }
    return best;
  }
}

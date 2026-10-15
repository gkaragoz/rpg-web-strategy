import type { Battle } from '../battle';
import type { Terrain } from '../terrain';
import { MAX_TEAMS } from '../units';
import { HILL_CONTESTED, HILL_NEUTRAL, type HillPointHud, type ModeHud, type ModeRules } from './types';

/** Points a team needs to win. */
export const HILL_TARGET = 100;
/** Sim seconds after which the team with the most points wins (tie: draw). */
export const HILL_TIME_LIMIT = 600;
const POINTS = 3;
/** Ownership and goals are re-evaluated every this many steps (offset so the first evaluation is step 1). */
const EVAL_EVERY = 10;

/** Capture radius (tiles) of every control point on a map of this size. */
export function hillRadius(mapSize: number): number {
  return Math.max(3.5, mapSize * 0.06);
}

/**
 * The three control points: the map centre plus two flanks. A flank is the centre offset by ~28% of the map size
 * perpendicular to the main axis between the team spawn centroids (first spawn to the mean of the others). With two teams
 * the flanks lie on both sides of the axis (fair); with more teams the second flank is 120 degrees after the first.
 * Every point is moved to the nearest walkable tile of the main region (`nearestWalkable`), so units can always reach it.
 * Pure and deterministic (no RNG).
 */
export function hillControlPoints(terrain: Terrain | null, mapSize: number, spawns: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const R = hillRadius(mapSize);
  const margin = R + 1;
  const half = mapSize / 2;
  const clampTo = (v: number) => Math.min(mapSize - margin, Math.max(margin, v));
  const snap = (x: number, y: number, maxR: number): { x: number; y: number } => {
    const cx = clampTo(x);
    const cy = clampTo(y);
    if (!terrain) return { x: cx, y: cy };
    return terrain.nearestWalkable(cx, cy, maxR, true) ?? terrain.nearestWalkable(cx, cy, mapSize, true) ?? { x: cx, y: cy };
  };

  const centre = snap(half, half, Math.ceil(mapSize / 2));
  const out = [centre];

  let ax = 1;
  let ay = 0;
  if (spawns.length >= 2) {
    let mx = 0;
    let my = 0;
    for (let i = 1; i < spawns.length; i++) {
      mx += spawns[i].x;
      my += spawns[i].y;
    }
    mx /= spawns.length - 1;
    my /= spawns.length - 1;
    const dx = mx - spawns[0].x;
    const dy = my - spawns[0].y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      ax = dx / len;
      ay = dy / len;
    }
  }
  const theta0 = Math.atan2(ax, -ay); // direction of the perpendicular (-ay, ax)
  const angles = [theta0, theta0 + (spawns.length <= 2 ? Math.PI : (2 * Math.PI) / 3)];
  const sepMin = R * 1.6;
  for (const theta of angles) {
    let best: { x: number; y: number } | null = null;
    let bestSep = -1;
    search: for (const frac of [0.28, 0.22, 0.34, 0.16]) {
      for (const jitter of [0, 0.2, -0.2, 0.4, -0.4]) {
        const a = theta + jitter;
        const p = snap(half + Math.cos(a) * mapSize * frac, half + Math.sin(a) * mapSize * frac, Math.ceil(mapSize * 0.15));
        let sep = Infinity;
        for (const o of out) sep = Math.min(sep, Math.hypot(o.x - p.x, o.y - p.y));
        if (sep > bestSep) {
          bestSep = sep;
          best = p;
        }
        if (sep >= sepMin) break search;
      }
    }
    out.push(best!);
  }
  return out;
}

/** King of the Hill: hold control points to score; first to HILL_TARGET wins, the time limit decides otherwise. */
export class HillRules implements ModeRules {
  readonly id = 'hill' as const;
  private readonly scoreArr = new Int32Array(MAX_TEAMS);
  private readonly owners = new Int32Array(POINTS).fill(HILL_NEUTRAL);
  private readonly px = new Float64Array(POINTS);
  private readonly py = new Float64Array(POINTS);
  private radius = 3.5;
  private readonly counts = new Int32Array(POINTS * MAX_TEAMS);
  private sps = 30;

  init(b: Battle): void {
    this.scoreArr.fill(0);
    this.owners.fill(HILL_NEUTRAL);
    this.radius = hillRadius(b.mapSize);
    this.sps = Math.round(1 / b.dt);
    // Spawn centroids of the teams that have units.
    const u = b.units;
    const n = b.allTeams.length;
    const sx = new Float64Array(n);
    const sy = new Float64Array(n);
    const sc = new Int32Array(n);
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i] || u.team[i] >= n) continue;
      sx[u.team[i]] += u.x[i];
      sy[u.team[i]] += u.y[i];
      sc[u.team[i]]++;
    }
    const spawns: Array<{ x: number; y: number }> = [];
    for (let t = 0; t < n; t++) if (sc[t] > 0) spawns.push({ x: sx[t] / sc[t], y: sy[t] / sc[t] });
    const pts = hillControlPoints(b.terrain, b.mapSize, spawns);
    for (let p = 0; p < POINTS; p++) {
      this.px[p] = pts[p].x;
      this.py[p] = pts[p].y;
    }
    b.teamHasGoal.fill(0);
  }

  step(b: Battle, dt: number): void {
    this.sps = Math.max(1, Math.round(1 / dt));
    const n = b.stepNo;
    if ((n - 1) % EVAL_EVERY === 0) {
      this.evaluate(b);
      this.setGoals(b);
    }
    // One point per second of sim time for every owned point: counted in whole steps, so every client agrees exactly.
    if (n % this.sps === 0) {
      for (let p = 0; p < POINTS; p++) if (this.owners[p] >= 0) this.scoreArr[this.owners[p]]++;
    }
  }

  private evaluate(b: Battle): void {
    const u = b.units;
    const counts = this.counts;
    counts.fill(0);
    const r2 = this.radius * this.radius;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) continue;
      const x = u.x[i];
      const y = u.y[i];
      const tm = u.team[i];
      for (let p = 0; p < POINTS; p++) {
        const dx = x - this.px[p];
        const dy = y - this.py[p];
        if (dx * dx + dy * dy < r2) counts[p * MAX_TEAMS + tm]++;
      }
    }
    const teams = b.allTeams.length;
    for (let p = 0; p < POINTS; p++) {
      let top = 0;
      let who = -1;
      let tie = false;
      for (let t = 0; t < teams; t++) {
        const c = counts[p * MAX_TEAMS + t];
        if (c > top) {
          top = c;
          who = t;
          tie = false;
        } else if (c === top && c > 0) tie = true;
      }
      if (top === 0) continue; // nobody there: the owner keeps the point
      this.owners[p] = tie ? HILL_CONTESTED : who;
    }
  }

  /** Each living team heads for the nearest control point it does not own. */
  private setGoals(b: Battle): void {
    const teams = b.allTeams.length;
    for (let t = 0; t < teams; t++) {
      b.teamHasGoal[t] = 0;
      if (b.alivePerTeam[t] <= 0) continue;
      let best = -1;
      let bestD = Infinity;
      for (let p = 0; p < POINTS; p++) {
        if (this.owners[p] === t) continue;
        const dx = this.px[p] - b.centroidX[t];
        const dy = this.py[p] - b.centroidY[t];
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best < 0) continue;
      b.teamGoalX[t] = this.px[best];
      b.teamGoalY[t] = this.py[best];
      b.teamHasGoal[t] = 1;
    }
  }

  winner(b: Battle): number | undefined {
    const teams = b.allTeams.length;
    let top = -1;
    let who = -1;
    let tie = false;
    for (let t = 0; t < teams; t++) {
      const s = this.scoreArr[t];
      if (s > top) {
        top = s;
        who = t;
        tie = false;
      } else if (s === top) tie = true;
    }
    if (top >= HILL_TARGET && !tie) return who;
    if (b.stepNo >= HILL_TIME_LIMIT * this.sps) return tie ? -2 : who;
    return undefined;
  }

  serialize(): number[] {
    const out: number[] = [];
    for (let t = 0; t < MAX_TEAMS; t++) out.push(this.scoreArr[t]);
    for (let p = 0; p < POINTS; p++) out.push(this.owners[p]);
    for (let p = 0; p < POINTS; p++) out.push(this.px[p], this.py[p]);
    out.push(this.radius);
    return out;
  }

  restore(s: number[]): void {
    let k = 0;
    for (let t = 0; t < MAX_TEAMS; t++) this.scoreArr[t] = s[k++] ?? 0;
    for (let p = 0; p < POINTS; p++) this.owners[p] = s[k++] ?? HILL_NEUTRAL;
    for (let p = 0; p < POINTS; p++) {
      this.px[p] = s[k++] ?? 0;
      this.py[p] = s[k++] ?? 0;
    }
    this.radius = s[k++] ?? this.radius;
  }

  hud(b: Battle): ModeHud {
    const points: HillPointHud[] = [];
    for (let p = 0; p < POINTS; p++) points.push({ x: this.px[p], y: this.py[p], radius: this.radius, owner: this.owners[p] });
    return {
      kind: 'hill',
      scores: Array.from(this.scoreArr),
      target: HILL_TARGET,
      points,
      timeLeft: Math.max(0, HILL_TIME_LIMIT - b.stepNo / this.sps),
    };
  }

  scores(): number[] | undefined {
    return Array.from(this.scoreArr);
  }
}

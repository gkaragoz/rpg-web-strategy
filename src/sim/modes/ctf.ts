import type { Battle } from '../battle';
import { STATS, MAX_TEAMS } from '../units';
import type { CtfFlagHud, ModeHud, ModeRules } from './types';

/** Captures a team needs to win. */
export const CTF_TARGET = 3;
/** Sim seconds after which the team with the most captures wins (tie or all zero: draw). */
export const CTF_TIME_LIMIT = 600;
/** Pickups and goals are re-evaluated every this many steps (offset so the first evaluation is step 1). */
const EVAL_EVERY = 5;

/** Pickup / capture radius (tiles) of every base on a map of this size. */
export function ctfRadius(mapSize: number): number {
  return Math.max(3, mapSize * 0.05);
}

/**
 * Flag base of a team: the centroid of its initial units snapped to the nearest walkable tile of the main region (so units
 * can always reach it). Pure and deterministic (no RNG); without terrain the centroid is only clamped into the map.
 */
export function ctfBasePoint(b: Battle, cx: number, cy: number): { x: number; y: number } {
  const margin = 1.5;
  const x = Math.min(b.mapSize - margin, Math.max(margin, cx));
  const y = Math.min(b.mapSize - margin, Math.max(margin, cy));
  const t = b.terrain;
  if (!t) return { x, y };
  return t.nearestWalkable(x, y, Math.ceil(b.mapSize * 0.25), true) ?? t.nearestWalkable(x, y, b.mapSize, true) ?? { x, y };
}

/**
 * Capture the Flag: every team has one flag at a home base (centroid of its starting units). The first living unit of
 * another team (lowest unit index) that comes within the base radius of a flag at home becomes its carrier; the carrier
 * ignores the fight and walks to its own base (see `drive`). Reaching it scores a capture and the flag goes home; a dead
 * carrier returns the flag at once. First to CTF_TARGET captures wins; after CTF_TIME_LIMIT the most captures win.
 *
 * State (plain numbers, in serialize/restore/hash): captures, carrier unit per flag, base x/y, "exists" flag, radius.
 */
export class CtfRules implements ModeRules {
  readonly id = 'ctf' as const;
  private readonly caps = new Int32Array(MAX_TEAMS);
  /** Unit index carrying the flag OF team t (-1: at home). */
  private readonly carrier = new Int32Array(MAX_TEAMS).fill(-1);
  private readonly bx = new Float64Array(MAX_TEAMS);
  private readonly by = new Float64Array(MAX_TEAMS);
  private readonly exists = new Uint8Array(MAX_TEAMS);
  private radius = 3;
  private sps = 30;

  init(b: Battle): void {
    this.caps.fill(0);
    this.carrier.fill(-1);
    this.exists.fill(0);
    this.bx.fill(0);
    this.by.fill(0);
    this.radius = ctfRadius(b.mapSize);
    this.sps = Math.round(1 / b.dt);
    const u = b.units;
    const n = b.allTeams.length;
    const sx = new Float64Array(n);
    const sy = new Float64Array(n);
    const sc = new Int32Array(n);
    for (let i = 0; i < u.count; i++) {
      const t = u.team[i];
      if (!u.alive[i] || u.owner[i] >= 0 || t >= n) continue;
      sx[t] += u.x[i];
      sy[t] += u.y[i];
      sc[t]++;
    }
    for (let t = 0; t < n; t++) {
      if (sc[t] === 0) continue;
      const p = ctfBasePoint(b, sx[t] / sc[t], sy[t] / sc[t]);
      this.bx[t] = p.x;
      this.by[t] = p.y;
      this.exists[t] = 1;
    }
    b.teamHasGoal.fill(0);
  }

  /** Is unit i currently carrying a flag. */
  private carrying(i: number, teams: number): boolean {
    for (let f = 0; f < teams; f++) if (this.carrier[f] === i) return true;
    return false;
  }

  /** Carrier behaviour (called from Battle.updateUnit): walk to the own base, no fighting. */
  drive(b: Battle, i: number, _dt: number): boolean {
    const teams = b.allTeams.length;
    if (!this.carrying(i, teams)) return false;
    const u = b.units;
    const tm = u.team[i];
    u.swing[i] = 0;
    u.hitPending[i] = 0;
    b.queueMove(i, this.bx[tm], this.by[tm], STATS[u.kind[i]].speed);
    return true;
  }

  onKill(_b: Battle, j: number, _src: number): void {
    for (let f = 0; f < MAX_TEAMS; f++) if (this.carrier[f] === j) this.carrier[f] = -1;
  }

  step(b: Battle, dt: number): void {
    this.sps = Math.max(1, Math.round(1 / dt));
    const u = b.units;
    const teams = b.allTeams.length;
    const r2 = this.radius * this.radius;
    // Captures (every step): a carrier inside its own base radius scores. Flags are handled in team order.
    for (let f = 0; f < teams; f++) {
      const c = this.carrier[f];
      if (c < 0) continue;
      if (!u.alive[c]) {
        this.carrier[f] = -1; // died outside killUnit (safety net)
        continue;
      }
      const tm = u.team[c];
      const dx = u.x[c] - this.bx[tm];
      const dy = u.y[c] - this.by[tm];
      if (dx * dx + dy * dy < r2) {
        this.caps[tm]++;
        this.carrier[f] = -1;
      }
    }
    if ((b.stepNo - 1) % EVAL_EVERY === 0) {
      this.pickups(b, teams, r2);
      this.setGoals(b, teams);
    }
  }

  /** Lowest-index unit wins a flag that several units reach in the same check (units are scanned in index order). */
  private pickups(b: Battle, teams: number, r2: number): void {
    let free = false;
    for (let f = 0; f < teams; f++) if (this.exists[f] && this.carrier[f] < 0) free = true;
    if (!free) return;
    const u = b.units;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i] || u.owner[i] >= 0) continue;
      const tm = u.team[i];
      if (tm >= teams) continue;
      const x = u.x[i];
      const y = u.y[i];
      let best = -1;
      let bestD = Infinity;
      for (let f = 0; f < teams; f++) {
        if (f === tm || !this.exists[f] || this.carrier[f] >= 0) continue;
        const dx = x - this.bx[f];
        const dy = y - this.by[f];
        const d = dx * dx + dy * dy;
        if (d < r2 && d < bestD) {
          bestD = d;
          best = f;
        }
      }
      if (best < 0 || this.carrying(i, teams)) continue;
      this.carrier[best] = i;
      free = false;
      for (let f = 0; f < teams; f++) if (this.exists[f] && this.carrier[f] < 0) free = true;
      if (!free) return;
    }
  }

  /** Escort a carrier home; else hunt the carrier of our flag; else go for the nearest enemy flag at home. */
  private setGoals(b: Battle, teams: number): void {
    const u = b.units;
    for (let t = 0; t < teams; t++) {
      b.teamHasGoal[t] = 0;
      if (b.alivePerTeam[t] <= 0) continue;
      let mine = false;
      for (let f = 0; f < teams; f++) if (this.carrier[f] >= 0 && u.team[this.carrier[f]] === t) mine = true;
      if (mine) {
        b.teamGoalX[t] = this.bx[t];
        b.teamGoalY[t] = this.by[t];
        b.teamHasGoal[t] = 1;
        continue;
      }
      const thief = this.carrier[t];
      if (thief >= 0) {
        b.teamGoalX[t] = u.x[thief];
        b.teamGoalY[t] = u.y[thief];
        b.teamHasGoal[t] = 1;
        continue;
      }
      let best = -1;
      let bestD = Infinity;
      for (let f = 0; f < teams; f++) {
        if (f === t || !this.exists[f] || this.carrier[f] >= 0) continue;
        const dx = this.bx[f] - b.centroidX[t];
        const dy = this.by[f] - b.centroidY[t];
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      if (best < 0) continue;
      b.teamGoalX[t] = this.bx[best];
      b.teamGoalY[t] = this.by[best];
      b.teamHasGoal[t] = 1;
    }
  }

  winner(b: Battle): number | undefined {
    const teams = b.allTeams.length;
    let top = -1;
    let who = -1;
    let tie = false;
    for (let t = 0; t < teams; t++) {
      const s = this.caps[t];
      if (s > top) {
        top = s;
        who = t;
        tie = false;
      } else if (s === top) tie = true;
    }
    if (top >= CTF_TARGET && !tie) return who;
    if (b.stepNo >= CTF_TIME_LIMIT * this.sps) return tie || top <= 0 ? -2 : who;
    return undefined;
  }

  serialize(): number[] {
    const out: number[] = [];
    for (let t = 0; t < MAX_TEAMS; t++) out.push(this.caps[t]);
    for (let t = 0; t < MAX_TEAMS; t++) out.push(this.carrier[t]);
    for (let t = 0; t < MAX_TEAMS; t++) out.push(this.bx[t], this.by[t], this.exists[t]);
    out.push(this.radius);
    return out;
  }

  restore(s: number[]): void {
    let k = 0;
    for (let t = 0; t < MAX_TEAMS; t++) this.caps[t] = s[k++] ?? 0;
    for (let t = 0; t < MAX_TEAMS; t++) this.carrier[t] = s[k++] ?? -1;
    for (let t = 0; t < MAX_TEAMS; t++) {
      this.bx[t] = s[k++] ?? 0;
      this.by[t] = s[k++] ?? 0;
      this.exists[t] = s[k++] ?? 0;
    }
    this.radius = s[k++] ?? this.radius;
  }

  hud(b: Battle): ModeHud {
    const u = b.units;
    const flags: CtfFlagHud[] = [];
    for (let t = 0; t < MAX_TEAMS; t++) {
      if (!this.exists[t]) continue;
      const c = this.carrier[t];
      if (c >= 0 && u.alive[c]) flags.push({ team: t, x: u.x[c], y: u.y[c], carrier: c, carrierTeam: u.team[c] });
      else flags.push({ team: t, x: this.bx[t], y: this.by[t], carrier: -1, carrierTeam: -1 });
    }
    return {
      kind: 'ctf',
      captures: Array.from(this.caps),
      target: CTF_TARGET,
      radius: this.radius,
      flags,
      timeLeft: Math.max(0, CTF_TIME_LIMIT - b.stepNo / this.sps),
    };
  }

  scores(): number[] | undefined {
    return Array.from(this.caps);
  }
}

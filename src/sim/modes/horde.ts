import type { Battle } from '../battle';
import { humanTeamCount } from '../battleConfig';
import {
  HORDE_GATES,
  HORDE_TIME_LIMIT,
  HORDE_WAVES,
  hordeHash,
  hordeKind,
  hordePoolSize,
  hordeWaveOffset,
  hordeWaveSize,
  hordeWaveStep,
} from './hordeWaves';
import type { ModeHud, ModeRules } from './types';

/**
 * Horde (wave defence): every human team is an ALLY (alliance group, see `teamGroups`) against one AI team, the horde, whose
 * team index is the number of human teams (`hordeTeamIndex`). The horde is a pool of dormant units reserved at reset (so
 * capacity and unit indices are identical on every client) that wake up at spawn gates in 12 waves: wave 1 at 15 s, then one
 * every 25 s of sim time (integer step counting). Wave n has (4 + 3 (n - 1)) units per human team, tiers rise with n (tables
 * in `hordeWaves.ts`, the tuning knobs). Horde units use the classic AI: no target -> march to the nearest enemy centroid.
 *
 * Victory: wave 12 has spawned and every horde unit is dead -> the winner is the lowest-index human team that still has living
 * units. Defeat: every human unit is dead (winner = horde team index), or HORDE_TIME_LIMIT seconds pass with the horde alive.
 * A draw is not possible (the classic draw rules are off in every non-classic mode).
 *
 * Score ("waves survived"): `scores()` is [waves reached for every human team ..., 0 for the horde]; the humans are allies, so
 * the human entries are equal. Waves reached = waves spawned while any human was alive (spawning stops with the humans).
 *
 * Gates: up to 3 walkable main-region points near the map edge, on the side(s) farthest from the human centroids. Wave units
 * are spread around the gates (unit k uses gate k mod gates) with a deterministic jitter (hash of wave and unit number).
 *
 * State (plain numbers, in serialize/restore/hash): waves spawned, first pool unit, gate count, gate x/y.
 */
export class HordeRules implements ModeRules {
  readonly id = 'horde' as const;
  readonly lastStanding = false;
  private wave = 0;
  private poolStart = 0;
  private gates = 0;
  private readonly gx = new Float64Array(HORDE_GATES);
  private readonly gy = new Float64Array(HORDE_GATES);
  private humans = 2;
  private hordeTeam = 2;
  private sps = 30;

  init(b: Battle): void {
    this.sps = Math.max(1, Math.round(1 / b.dt));
    this.humans = humanTeamCount(b.config);
    this.hordeTeam = this.humans;
    this.wave = 0;
    this.gates = 0;
    this.chooseGates(b);
    const u = b.units;
    this.poolStart = u.count;
    const total = hordePoolSize(this.humans);
    for (let w = 1; w <= HORDE_WAVES; w++) {
      const size = hordeWaveSize(w, this.humans);
      for (let k = 0; k < size; k++) {
        if (u.count >= u.cap) break;
        const i = u.spawn(this.hordeTeam, hordeKind(w, k, this.humans), this.gx[0], this.gy[0], b.rng);
        u.alive[i] = 0;
        u.deathT[i] = 1000;
        u.hp[i] = 0;
      }
    }
    // Capacity is reserved from the config: the pool must fit exactly.
    if (u.count - this.poolStart !== total) throw new Error('horde pool does not fit the unit capacity');
  }

  /** Picks the gates: perimeter candidates ranked by their distance to the nearest human centroid. */
  private chooseGates(b: Battle): void {
    const u = b.units;
    const size = b.mapSize;
    const sx = new Float64Array(this.humans);
    const sy = new Float64Array(this.humans);
    const sn = new Int32Array(this.humans);
    for (let i = 0; i < u.count; i++) {
      const t = u.team[i];
      if (!u.alive[i] || t >= this.humans) continue;
      sx[t] += u.x[i];
      sy[t] += u.y[i];
      sn[t]++;
    }
    const cx: number[] = [];
    const cy: number[] = [];
    for (let t = 0; t < this.humans; t++) {
      if (sn[t] === 0) continue;
      cx.push(sx[t] / sn[t]);
      cy.push(sy[t] / sn[t]);
    }
    if (cx.length === 0) {
      cx.push(size / 2);
      cy.push(size / 2);
    }
    const inset = 2.5;
    const per = 12;
    const span = size - 2 * inset;
    const cand: Array<{ x: number; y: number; score: number }> = [];
    const add = (px: number, py: number): void => {
      let x = px;
      let y = py;
      if (b.terrain) {
        const p = b.terrain.nearestWalkable(px, py, 6, true);
        if (!p) return;
        x = p.x;
        y = p.y;
      }
      let score = Infinity;
      for (let t = 0; t < cx.length; t++) score = Math.min(score, Math.hypot(x - cx[t], y - cy[t]));
      cand.push({ x, y, score });
    };
    for (let k = 0; k < per; k++) {
      const v = inset + ((k + 0.5) / per) * span;
      add(v, inset);
      add(v, size - inset);
      add(inset, v);
      add(size - inset, v);
    }
    if (cand.length === 0) {
      const p = b.terrain?.nearestWalkable(size / 2, size / 2, size, true);
      cand.push({ x: p ? p.x : size / 2, y: p ? p.y : size / 2, score: 0 });
    }
    // Stable order: score descending, ties by generation order.
    const order = cand.map((_, i) => i).sort((a, c) => cand[c].score - cand[a].score || a - c);
    const best = cand[order[0]].score;
    const apart = size * 0.2;
    for (const idx of order) {
      if (this.gates >= HORDE_GATES) break;
      const c = cand[idx];
      if (this.gates > 0 && c.score < best * 0.75) continue;
      let ok = true;
      for (let g = 0; g < this.gates; g++) if (Math.hypot(c.x - this.gx[g], c.y - this.gy[g]) < apart) ok = false;
      if (!ok) continue;
      this.gx[this.gates] = c.x;
      this.gy[this.gates] = c.y;
      this.gates++;
    }
  }

  private humansAlive(b: Battle): number {
    let n = 0;
    for (let t = 0; t < this.humans; t++) n += b.alivePerTeam[t];
    return n;
  }

  step(b: Battle, dt: number): void {
    this.sps = Math.max(1, Math.round(1 / dt));
    if (this.wave >= HORDE_WAVES || b.stepNo < hordeWaveStep(this.wave + 1, this.sps)) return;
    if (this.humansAlive(b) === 0) return;
    this.spawnWave(b, this.wave + 1);
    this.wave++;
    // Fresh units are alive now: the winner check of this very step must see them.
    b.countAlive();
  }

  private spawnWave(b: Battle, n: number): void {
    const u = b.units;
    const size = hordeWaveSize(n, this.humans);
    const first = this.poolStart + hordeWaveOffset(n, this.humans);
    for (let k = 0; k < size; k++) {
      const i = first + k;
      const g = k % this.gates;
      const h = hordeHash(n * 131 + 7, k);
      const ang = ((h & 0xffff) / 65536) * Math.PI * 2;
      const rad = 0.6 + (((h >>> 16) & 0xffff) / 65536) * 2.4;
      let x = this.gx[g] + Math.cos(ang) * rad;
      let y = this.gy[g] + Math.sin(ang) * rad;
      if (b.terrain) {
        const p = b.terrain.nearestWalkable(x, y, 3, true);
        x = p ? p.x : this.gx[g];
        y = p ? p.y : this.gy[g];
      } else {
        const lim = b.mapSize - 0.5;
        x = Math.min(lim, Math.max(0.5, x));
        y = Math.min(lim, Math.max(0.5, y));
      }
      u.alive[i] = 1;
      u.hp[i] = u.maxHp[i];
      u.deathT[i] = 0;
      u.x[i] = u.px[i] = x;
      u.y[i] = u.py[i] = y;
      u.winX[i] = x;
      u.winY[i] = y;
      u.winT[i] = 0;
      u.target[i] = -1;
      u.retarget[i] = 0;
      u.cooldown[i] = 0.4;
      u.flash[i] = 0.25;
    }
    // A quiet stretch before the wave must not count as "nobody died for a long time" (damage ramp).
    b.lastDeathTime = b.time;
  }

  winner(b: Battle): number | undefined {
    if (this.humansAlive(b) === 0) return this.hordeTeam;
    if (this.wave >= HORDE_WAVES && b.alivePerTeam[this.hordeTeam] === 0) {
      for (let t = 0; t < this.humans; t++) if (b.alivePerTeam[t] > 0) return t;
    }
    if (b.stepNo >= HORDE_TIME_LIMIT * this.sps) return this.hordeTeam;
    return undefined;
  }

  serialize(): number[] {
    const out = [this.wave, this.poolStart, this.gates];
    for (let g = 0; g < HORDE_GATES; g++) out.push(this.gx[g], this.gy[g]);
    return out;
  }

  restore(s: number[]): void {
    this.wave = s[0] ?? 0;
    this.poolStart = s[1] ?? 0;
    this.gates = s[2] ?? 0;
    for (let g = 0; g < HORDE_GATES; g++) {
      this.gx[g] = s[3 + g * 2] ?? 0;
      this.gy[g] = s[4 + g * 2] ?? 0;
    }
  }

  hud(b: Battle): ModeHud {
    const next = this.wave >= HORDE_WAVES ? 0 : Math.max(0, hordeWaveStep(this.wave + 1, this.sps) / this.sps - b.stepNo / this.sps);
    return {
      kind: 'horde',
      wave: this.wave,
      waves: HORDE_WAVES,
      nextIn: next,
      hordeAlive: b.alivePerTeam[this.hordeTeam] ?? 0,
      hordeTeam: this.hordeTeam,
      timeLeft: Math.max(0, HORDE_TIME_LIMIT - b.stepNo / this.sps),
    };
  }

  scores(): number[] | undefined {
    const out: number[] = [];
    for (let t = 0; t < this.humans; t++) out.push(this.wave);
    out.push(0);
    return out;
  }

  /** Spawn gate positions (tiles), for the UI / tests. */
  gatePoints(): Array<{ x: number; y: number }> {
    return Array.from({ length: this.gates }, (_, g) => ({ x: this.gx[g], y: this.gy[g] }));
  }
}

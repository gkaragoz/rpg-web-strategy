import { Grid } from './grid';
import { ENGAGE_LOCK, MAX_RING, MELEE_SLACK, MELEE_SLOTS, OTHER_BANK_PENALTY, PRIEST_RING, SWITCH_BONUS } from './tuning';
import type { Terrain } from './terrain';
import { STATS, STRUCT_OF, TANK, isHealer, isMelee, isRanged, isTank, type Units } from './units';

/** Pick results in `Units.pickBest` besides a unit index. */
export const PICK_NONE = -1;
export const PICK_KEEP = -2;

/** Stateless random number in [0, 1) for a pair of units at a step (replaces a call of the shared RNG per candidate). */
export function pairRand(i: number, j: number, step: number): number {
  let h = Math.imul(i + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(j + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(step + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Target picking as a parallel phase: it reads only unit positions, hit points, the attacker/healer counts as they were at
 * the start of the step, the team grids and the static terrain, and writes only `pickBest[i]` / `pickMark[i]` of the unit it
 * works on. Which thread handles which unit therefore cannot change the result. The battle applies the choices afterwards
 * in unit order (counts, chase state), see `Battle.applyPick`.
 */
export class Picker {
  /** Per-step inputs (set by the battle / the pool control block). */
  step = 0;
  aliveMask = 0;
  dt = 0;
  private readonly enemies: number[][];
  private readonly selves: number[][];

  constructor(
    private readonly u: Units,
    private readonly t: Terrain | null,
    private readonly grids: Grid[],
    private readonly teamCount: number,
    /** Alliance group per team (default: every team its own group): teams of one group are never enemies. */
    private readonly group: ArrayLike<number> = Array.from({ length: teamCount }, (_, t) => t),
  ) {
    this.enemies = Array.from({ length: teamCount }, () => []);
    this.selves = Array.from({ length: teamCount }, (_, t) => Array.from({ length: teamCount }, (_, e) => e).filter((e) => group[e] === group[t]));
  }

  /** Builds the enemy lists of the teams that are alive (call once per phase, after setting `aliveMask`). */
  prepare(): void {
    for (let tm = 0; tm < this.teamCount; tm++) {
      const list = this.enemies[tm];
      list.length = 0;
      for (let e = 0; e < this.teamCount; e++) if (this.group[e] !== this.group[tm] && (this.aliveMask & (1 << e)) !== 0) list.push(e);
    }
  }

  /** Computes the choice of every unit in [from, to) that is about to retarget this step. */
  runChunk(from: number, to: number): void {
    const u = this.u;
    for (let i = from; i < to; i++) {
      u.pickMark[i] = 0;
      if (!u.alive[i] || u.airT[i] > 0 || STRUCT_OF[u.kind[i]] !== 0) continue;
      if (u.retarget[i] - this.dt > 0) continue;
      u.pickBest[i] = this.pick(i);
      u.pickMark[i] = 1;
    }
  }

  /** The choice of unit i: a unit index, PICK_NONE, or PICK_KEEP (the current target is locked). Taunted units are handled by the battle. */
  pick(i: number): number {
    const u = this.u;
    const kind = u.kind[i];
    const team = u.team[i];
    const cur = u.target[i];
    const isPriest = isHealer(kind);
    const melee = isMelee(kind);
    // Priests scan allies, the others scan all enemy teams.
    const searchTeams = isPriest ? this.selves[team] : this.enemies[team];
    const maxRing = isPriest ? PRIEST_RING : MAX_RING;
    const g0 = this.grids[0];
    const cols = g0.cols;
    const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / g0.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / g0.cell) | 0));
    const terrain = this.t;
    const sideI = terrain ? terrain.sideAt(u.x[i], u.y[i]) : 0;
    const reach = STATS[kind].range * 0.95;
    const myRegion = terrain ? terrain.regionAt(u.x[i], u.y[i]) : -1;
    const banned = u.banT[i] > 0 ? u.banTarget[i] : -1;
    // Lane Conquest: a unit inside a lane never picks a target inside another lane (the walls between lanes are far thicker than any range).
    const lanes = terrain !== null && terrain.laneOf !== null;
    const myLane = lanes ? (u.lane[i] >= 0 ? u.lane[i] : terrain!.laneAt(u.x[i], u.y[i])) : -1;

    // A current target in range (or within hitting distance) is locked: to avoid jitter/loops.
    if (cur >= 0 && u.alive[cur] && !isPriest) {
      const cdx = u.x[cur] - u.x[i];
      const cdy = u.y[cur] - u.y[i];
      const lockR = (melee ? STATS[kind].range + MELEE_SLACK : STATS[kind].range) * ENGAGE_LOCK;
      if (cdx * cdx + cdy * cdy <= lockR * lockR) return PICK_KEEP;
    }
    let best = -1;
    let bestScore = Infinity;
    let foundRing = -1;

    for (let r = 0; r <= maxRing; r++) {
      if (foundRing >= 0 && r > foundRing) break;
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= cols) continue;
        const edgeRow = gy === cy - r || gy === cy + r;
        const step = edgeRow || r === 0 ? 1 : 2 * r;
        for (let gx = cx - r; gx <= cx + r; gx += step) {
          if (gx < 0 || gx >= cols) continue;
          const c = gy * cols + gx;
          for (let ti = 0; ti < searchTeams.length; ti++) {
            const grid = this.grids[searchTeams[ti]];
            for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
              const j = grid.items[k];
              if (j === i || j === banned || (isPriest && u.hp[j] >= u.maxHp[j])) continue;
              const ddx = u.x[j] - u.x[i];
              const ddy = u.y[j] - u.y[i];
              const dist = Math.sqrt(ddx * ddx + ddy * ddy);
              const jitter = pairRand(i, j, this.step) * 0.8;
              const tank = isTank(u.kind[j]);
              let score: number;
              if (melee) {
                const att = u.attackers[j] - (j === cur ? 1 : 0);
                score = dist + att * 3.5 + jitter * 2 + (att >= (tank ? TANK.meleeSlots : MELEE_SLOTS) ? 100 : 0);
                if (tank) score -= TANK.tauntBonus; // a tank draws enemies onto itself
              } else if (isRanged(kind)) {
                const att = u.attackers[j] - (j === cur ? 1 : 0);
                score = dist + att * 2 + (u.hp[j] / u.maxHp[j]) * 3 + jitter * 2;
              } else {
                const heal = u.healers[j] - (j === cur ? 1 : 0);
                score = (u.hp[j] / u.maxHp[j]) * 10 + dist * 0.3 + heal * 4 + jitter;
              }
              // Closed pocket/island: unreachable if out of range, do not target.
              if (terrain && myRegion !== -1 && dist > reach && terrain.regionAt(u.x[j], u.y[j]) !== myRegion) continue;
              if (myLane >= 0) {
                const lj = u.lane[j] >= 0 ? u.lane[j] : terrain!.laneAt(u.x[j], u.y[j]);
                if (lj >= 0 && lj !== myLane) continue;
              }
              // A target across the river only if needed: an archer in range shoots over the river.
              if (terrain && (melee || isPriest || dist > reach) && terrain.sideAt(u.x[j], u.y[j]) !== sideI) {
                score += OTHER_BANK_PENALTY;
              }
              if (j === cur) score -= SWITCH_BONUS;
              if (score < bestScore) {
                bestScore = score;
                best = j;
              }
              if (foundRing < 0) foundRing = r;
            }
          }
        }
      }
    }
    return best;
  }
}

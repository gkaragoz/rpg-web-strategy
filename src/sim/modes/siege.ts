import type { Battle } from '../battle';
import { SIEGE_CORE_KIND, STATS, MAX_TEAMS } from '../units';
import { ctfBasePoint } from './ctf';
import type { ModeHud, ModeRules } from './types';

/** Sim seconds the defender must survive with the core alive to win. */
export const SIEGE_TIME_LIMIT = 300;
/** Core health (game-scale hit points). */
export const SIEGE_CORE_HP = 3000;
/** Goals are re-evaluated every this many steps (offset so the first evaluation is step 1). */
const EVAL_EVERY = 5;

/**
 * Where the core stands: the map's keep (decor kind 'keep', citadel layout) snapped to the nearest walkable tile of the
 * main region; on the plateau layout the middle of the plateau (the defenders' last stand); otherwise the centroid of the defender's
 * initial units snapped the same way. Pure and deterministic.
 * `cx, cy` is that centroid (the caller computes it from the spawned units; NaN: use the map centre).
 */
export function siegeCorePoint(b: Battle, cx: number, cy: number): { x: number; y: number } {
  const keep = b.terrain?.decor.find((d) => d.kind === 'keep');
  if (keep) return ctfBasePoint(b, Math.floor(keep.x) + 0.5, Math.floor(keep.y) + 0.5);
  if (b.terrain?.layout === 'plateau' || !Number.isFinite(cx) || !Number.isFinite(cy)) return ctfBasePoint(b, b.mapSize / 2, b.mapSize / 2);
  return ctfBasePoint(b, cx, cy);
}

/**
 * Siege: one team (config.siegeDefender, default 0) defends a CORE (a structure unit, 3000 HP, never attacks or moves); every
 * other team attacks. Attackers win by destroying the core: the winner is the team that dealt the final blow, or, when the
 * killer is unknown (damage over time, environment) or a defender, the attacker team with the most damage on the core (ties:
 * lowest team index; no damage at all: draw). The defender wins when SIEGE_TIME_LIMIT seconds pass with the core alive, and
 * when every attacker is dead (last team standing, see Battle.step). The defender's army dying does NOT end the battle: the
 * core keeps the defender in the game until it falls.
 *
 * Goals: attackers march to the core; defender units without a target gather at it.
 *
 * State (plain numbers, in serialize/restore/hash): defender, core unit, core x/y, credited winner (-1 none yet), damage on the
 * core per team.
 */
export class SiegeRules implements ModeRules {
  readonly id = 'siege' as const;
  private defender = 0;
  private core = -1;
  private coreX = 0;
  private coreY = 0;
  /** -1: core still standing; else the team credited with destroying it (-2: draw). */
  private credit = -1;
  private readonly dmg = new Float64Array(MAX_TEAMS);
  private sps = 30;

  init(b: Battle): void {
    this.sps = Math.round(1 / b.dt);
    this.core = -1;
    this.credit = -1;
    this.dmg.fill(0);
    const teams = b.allTeams.length;
    const d = b.config.siegeDefender;
    this.defender = typeof d === 'number' && Number.isInteger(d) && d >= 0 && d < teams ? d : 0;
    const u = b.units;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i] || u.team[i] !== this.defender || u.owner[i] >= 0) continue;
      sx += u.x[i];
      sy += u.y[i];
      n++;
    }
    const p = siegeCorePoint(b, n > 0 ? sx / n : NaN, n > 0 ? sy / n : NaN);
    this.coreX = p.x;
    this.coreY = p.y;
    this.core = b.spawnStructure(SIEGE_CORE_KIND, this.defender, p.x, p.y);
    b.teamHasGoal.fill(0);
    this.setGoals(b);
  }

  onDamage(b: Battle, j: number, dealt: number, src: number): void {
    if (j !== this.core || src < 0 || dealt <= 0) return;
    const t = b.units.team[src];
    if (t !== this.defender && t < MAX_TEAMS) this.dmg[t] += dealt;
  }

  onKill(b: Battle, j: number, src: number): void {
    if (j !== this.core || this.credit !== -1) return;
    const killer = src >= 0 ? b.units.team[src] : -1;
    if (killer >= 0 && killer !== this.defender && killer < b.allTeams.length) {
      this.credit = killer;
      return;
    }
    let best = -1;
    let top = 0;
    for (let t = 0; t < b.allTeams.length; t++) {
      if (t === this.defender) continue;
      if (this.dmg[t] > top) {
        top = this.dmg[t];
        best = t;
      }
    }
    this.credit = best >= 0 ? best : -2;
  }

  step(b: Battle, dt: number): void {
    this.sps = Math.max(1, Math.round(1 / dt));
    // Safety net: a core that died outside killUnit.
    if (this.core >= 0 && this.credit === -1 && !b.units.alive[this.core]) this.onKill(b, this.core, -1);
    if ((b.stepNo - 1) % EVAL_EVERY === 0) this.setGoals(b);
  }

  private setGoals(b: Battle): void {
    const teams = b.allTeams.length;
    for (let t = 0; t < teams; t++) {
      b.teamHasGoal[t] = 0;
      if (this.core < 0 || this.credit !== -1 || b.alivePerTeam[t] <= 0) continue;
      b.teamGoalX[t] = this.coreX;
      b.teamGoalY[t] = this.coreY;
      b.teamHasGoal[t] = 1;
    }
  }

  winner(b: Battle): number | undefined {
    if (this.credit !== -1) return this.credit;
    if (this.core < 0) return -2;
    if (b.stepNo >= SIEGE_TIME_LIMIT * this.sps) return this.defender;
    return undefined;
  }

  serialize(): number[] {
    const out = [this.defender, this.core, this.coreX, this.coreY, this.credit];
    for (let t = 0; t < MAX_TEAMS; t++) out.push(this.dmg[t]);
    return out;
  }

  restore(s: number[]): void {
    this.defender = s[0] ?? 0;
    this.core = s[1] ?? -1;
    this.coreX = s[2] ?? 0;
    this.coreY = s[3] ?? 0;
    this.credit = s[4] ?? -1;
    for (let t = 0; t < MAX_TEAMS; t++) this.dmg[t] = s[5 + t] ?? 0;
  }

  hud(b: Battle): ModeHud {
    const u = b.units;
    const c = this.core;
    const maxHp = c >= 0 ? u.maxHp[c] : STATS[SIEGE_CORE_KIND].hp;
    const hp = c >= 0 && u.alive[c] ? Math.min(1, Math.max(0, u.hp[c] / u.maxHp[c])) : 0;
    return {
      kind: 'siege',
      defender: this.defender,
      coreHp: hp,
      coreMaxHp: maxHp,
      coreUnit: c,
      x: this.coreX,
      y: this.coreY,
      timeLeft: Math.max(0, SIEGE_TIME_LIMIT - b.stepNo / this.sps),
    };
  }

  scores(): number[] | undefined {
    return undefined;
  }
}

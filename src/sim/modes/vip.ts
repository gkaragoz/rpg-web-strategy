import type { Battle } from '../battle';
import { killUnit } from '../battleDamage';
import { MAX_TEAMS } from '../units';
import type { ModeHud, ModeRules } from './types';

/** Sim seconds after which the team whose VIP has the highest health fraction wins (tie: draw). */
export const VIP_TIME_LIMIT = 600;

/**
 * VIP: every team has one VIP unit; when it dies its whole team dies with it (through the normal kill path), and the last
 * team standing wins. Which unit is the VIP comes from `BattleConfig.vips` (layout index per team, -1: auto = highest max
 * HP, ties: lowest unit index; summon-pool units are never picked). No goals: units behave as in classic.
 *
 * State (plain numbers, in serialize/restore/hash): the VIP unit index per team and an "out" flag per team (1: the team has
 * been eliminated or never had a VIP).
 */
export class VipRules implements ModeRules {
  readonly id = 'vip' as const;
  private readonly vip = new Int32Array(MAX_TEAMS).fill(-1);
  private readonly out = new Uint8Array(MAX_TEAMS).fill(1);
  private sps = 30;

  init(b: Battle): void {
    this.sps = Math.round(1 / b.dt);
    this.vip.fill(-1);
    this.out.fill(1);
    b.teamHasGoal.fill(0);
    const u = b.units;
    const cfg = b.config.vips;
    const teams = b.allTeams.length;
    for (let t = 0; t < teams; t++) {
      let pick = -1;
      const e = cfg ? cfg[t] : -1;
      if (b.config.mode === 'custom' && Number.isInteger(e) && e >= 0 && e < b.layoutUnits.length) {
        const i = b.layoutUnits[e];
        if (i >= 0 && u.alive[i] && u.team[i] === t && u.owner[i] < 0) pick = i;
      }
      if (pick < 0) {
        let best = -Infinity;
        for (let i = 0; i < u.count; i++) {
          if (!u.alive[i] || u.team[i] !== t || u.owner[i] >= 0) continue;
          if (u.maxHp[i] > best) {
            best = u.maxHp[i];
            pick = i;
          }
        }
      }
      this.vip[t] = pick;
      this.out[t] = pick < 0 ? 1 : 0;
    }
  }

  /** Eliminates team `t`: every living unit of it dies now. `src` is credited with the kills. */
  private eliminate(b: Battle, t: number, src: number): void {
    this.out[t] = 1;
    const u = b.units;
    for (let i = 0; i < u.count; i++) if (u.alive[i] && u.team[i] === t) killUnit(b, i, src, 0);
  }

  onKill(b: Battle, j: number, src: number): void {
    const t = b.units.team[j];
    if (t < MAX_TEAMS && this.vip[t] === j && this.out[t] === 0) this.eliminate(b, t, src);
  }

  step(b: Battle, dt: number): void {
    this.sps = Math.max(1, Math.round(1 / dt));
    // Safety net: a VIP that died outside killUnit would otherwise keep its team alive.
    let changed = false;
    for (let t = 0; t < MAX_TEAMS; t++) {
      if (this.out[t] === 0 && !b.units.alive[this.vip[t]]) {
        this.eliminate(b, t, -1);
        changed = true;
      }
    }
    if (changed) b.countAlive();
  }

  winner(b: Battle): number | undefined {
    if (b.stepNo < VIP_TIME_LIMIT * this.sps) return undefined;
    let top = -1;
    let who = -1;
    let tie = false;
    for (let t = 0; t < MAX_TEAMS; t++) {
      if (this.out[t] !== 0) continue;
      const f = this.fraction(b, t);
      if (f > top) {
        top = f;
        who = t;
        tie = false;
      } else if (f === top) tie = true;
    }
    return tie || who < 0 ? -2 : who;
  }

  private fraction(b: Battle, t: number): number {
    const i = this.vip[t];
    if (i < 0 || this.out[t] !== 0 || !b.units.alive[i]) return 0;
    return Math.min(1, Math.max(0, b.units.hp[i] / b.units.maxHp[i]));
  }

  serialize(): number[] {
    const s: number[] = [];
    for (let t = 0; t < MAX_TEAMS; t++) s.push(this.vip[t]);
    for (let t = 0; t < MAX_TEAMS; t++) s.push(this.out[t]);
    return s;
  }

  restore(s: number[]): void {
    for (let t = 0; t < MAX_TEAMS; t++) {
      this.vip[t] = s[t] ?? -1;
      this.out[t] = s[MAX_TEAMS + t] ?? 1;
    }
  }

  hud(b: Battle): ModeHud {
    const teams: Array<{ unit: number; hp: number; alive: boolean }> = [];
    for (let t = 0; t < MAX_TEAMS; t++) teams.push({ unit: this.vip[t], hp: this.fraction(b, t), alive: this.out[t] === 0 });
    return { kind: 'vip', teams, timeLeft: Math.max(0, VIP_TIME_LIMIT - b.stepNo / this.sps) };
  }

  scores(): number[] | undefined {
    return undefined;
  }
}

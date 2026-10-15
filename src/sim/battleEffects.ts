import { F_RAGE, STRUCT_OF } from './units';
import { SKILL_ELEMENT, skillParams, type SkillParams } from './data/skills';
import { CC_IMMUNE } from './data/combat';
import type { SkillId } from './data/troops';
import type { Battle } from './battle';

// Battle helpers: skill lookup, damage multipliers, neighbour gathering and status effects (slow, stun, fear, weaken, shield, taunt, heal).

export function sp(b: Battle, id: SkillId): SkillParams {
  return (b.skillCache[id] ??= skillParams(id));
}

/** Damage multiplier: weaken, rage, spear stacks. */
export function dealMul(b: Battle, i: number): number {
  const u = b.units;
  let m = 1;
  if (u.weakT[i] > 0) m *= u.weakK[i];
  if ((u.flags[i] & F_RAGE) !== 0) m *= 1 + sp(b, 'rage').a;
  if (u.stacks[i] > 0) m *= 1 + u.stacks[i] * sp(b, 'spearBuild').a;
  return m;
}

export function atkRate(b: Battle, i: number): number {
  const u = b.units;
  let m = u.slowT[i] > 0 ? u.slowA[i] : 1;
  if ((u.flags[i] & F_RAGE) !== 0) m *= 1 + sp(b, 'rage').a;
  return m;
}

export function tick(b: Battle, i: number, every: number): boolean {
  const u = b.units;
  if (++u.skillN[i] >= every) {
    u.skillN[i] = 0;
    return true;
  }
  return false;
}

export function burst(b: Battle, x: number, y: number, radius: number, skill: SkillId | null): void {
  if (b.emitEvents) b.pushEvent({ type: 'burst', x, y, unit: -1, value: radius, element: skill ? (SKILL_ELEMENT[skill] ?? 0) : 0 });
}

/** Collects the living units of the given teams within radius r of (x,y) into out. */
export function gather(b: Battle, teams: number[], x: number, y: number, r: number, out: number[], max = 96): number {
  const u = b.units;
  out.length = 0;
  const g0 = b.grids[0];
  const cols = g0.cols;
  const cell = g0.cell;
  const gx0 = Math.max(0, ((x - r) / cell) | 0);
  const gx1 = Math.min(cols - 1, ((x + r) / cell) | 0);
  const gy0 = Math.max(0, ((y - r) / cell) | 0);
  const gy1 = Math.min(cols - 1, ((y + r) / cell) | 0);
  const r2 = r * r;
  for (let a = 0; a < teams.length; a++) {
    const grid = b.grids[teams[a]];
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * cols + gx;
        for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
          const j = grid.items[k];
          if (!u.alive[j]) continue;
          const dx = u.x[j] - x;
          const dy = u.y[j] - y;
          if (dx * dx + dy * dy <= r2) {
            out.push(j);
            if (out.length >= max) return out.length;
          }
        }
      }
    }
  }
  return out.length;
}

/** Enemies in the strip of length x half-width from point (ox,oy) in direction (dx,dy). */
export function gatherLine(b: Battle, teams: number[], ox: number, oy: number, dx: number, dy: number, length: number, half: number, out: number[]): number {
  const u = b.units;
  const tmp = b.scratch2;
  gather(b, teams, ox + (dx * length) / 2, oy + (dy * length) / 2, length / 2 + half, tmp, 200);
  out.length = 0;
  for (let k = 0; k < tmp.length; k++) {
    const j = tmp[k];
    const rx = u.x[j] - ox;
    const ry = u.y[j] - oy;
    const along = rx * dx + ry * dy;
    if (along < -0.3 || along > length) continue;
    if (Math.abs(rx * dy - ry * dx) <= half) out.push(j);
  }
  return out.length;
}

export function applySlow(b: Battle, j: number, dur: number, moveK: number, atkK: number): void {
  const u = b.units;
  if (u.invulnT[j] > 0) return;
  if (u.slowT[j] > 0) {
    u.slowK[j] = Math.min(u.slowK[j], moveK);
    u.slowA[j] = Math.min(u.slowA[j], atkK);
  } else {
    u.slowK[j] = moveK;
    u.slowA[j] = atkK;
  }
  u.slowT[j] = Math.max(u.slowT[j], dur);
}

export function applyStun(b: Battle, j: number, dur: number): void {
  const u = b.units;
  if (u.invulnT[j] > 0 || !u.alive[j] || u.ccImmT[j] > 0 || STRUCT_OF[u.kind[j]] !== 0) return;
  u.stunT[j] = Math.max(u.stunT[j], dur);
  u.ccImmT[j] = dur + CC_IMMUNE;
}

export function applyFear(b: Battle, j: number, dur: number, fx: number, fy: number): void {
  const u = b.units;
  if (u.invulnT[j] > 0 || !u.alive[j] || u.ccImmT[j] > 0 || STRUCT_OF[u.kind[j]] !== 0) return;
  u.fearT[j] = Math.max(u.fearT[j], dur);
  u.ccImmT[j] = dur + CC_IMMUNE;
  u.fearX[j] = fx;
  u.fearY[j] = fy;
}

export function applyWeak(b: Battle, j: number, dur: number, k: number): void {
  const u = b.units;
  u.weakK[j] = u.weakT[j] > 0 ? Math.min(u.weakK[j], k) : k;
  u.weakT[j] = Math.max(u.weakT[j], dur);
}

export function applyShield(b: Battle, j: number, dur: number, k: number): void {
  const u = b.units;
  u.shieldK[j] = u.shieldT[j] > 0 ? Math.min(u.shieldK[j], k) : k;
  u.shieldT[j] = Math.max(u.shieldT[j], dur);
}

export function applyTaunt(b: Battle, j: number, by: number, dur: number): void {
  const u = b.units;
  if (u.invulnT[j] > 0 || STRUCT_OF[u.kind[j]] !== 0) return;
  // If another tank is already taunting, do not switch targets (to avoid oscillation).
  if (u.tauntT[j] > 0 && u.tauntBy[j] !== by && u.tauntBy[j] >= 0 && u.alive[u.tauntBy[j]]) return;
  u.tauntBy[j] = by;
  u.tauntT[j] = Math.max(u.tauntT[j], dur);
  u.target[j] = by;
  u.retarget[j] = dur;
}

export function cleanse(b: Battle, j: number): void {
  const u = b.units;
  u.stunT[j] = u.slowT[j] = u.fearT[j] = u.burnT[j] = u.weakT[j] = 0;
}

export function healUnit(b: Battle, j: number, amount: number): number {
  const u = b.units;
  if (!u.alive[j]) return 0;
  const before = u.hp[j];
  u.hp[j] = Math.min(u.maxHp[j], u.hp[j] + amount);
  const gained = u.hp[j] - before;
  b.counters.heal += gained;
  if (gained > 0 && b.emitEvents) b.pushEvent({ type: 'heal', x: u.x[j], y: u.y[j], unit: j, value: gained, kind: u.kind[j] });
  return gained;
}

/** Heals the friendly units around (including those at the center). */
export function healArea(b: Battle, team: number, x: number, y: number, r: number, amount: number): void {
  const out = b.scratch;
  gather(b, b.selfList[team], x, y, r, out, 64);
  for (let k = 0; k < out.length; k++) if (b.units.hp[out[k]] < b.units.maxHp[out[k]]) healUnit(b, out[k], amount);
}

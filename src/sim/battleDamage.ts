import { T_WATER } from './terrain';
import { F_EXPLODED, F_REVIVED, Kind, STATS, TANK, isRanged, isTank, KIND_COUNT } from './units';
import { TYPE_MULT, highGroundDamage } from './data/combat';
import { STALE_AFTER, STALE_RAMP, MAX_LAUNCH } from './battleConfig';
import type { SkillId } from './data/troops';
import { sp, burst, gather, applySlow, cleanse } from './battleEffects';
import type { Battle } from './battle';

// Battle: damage and death, effect zones and the comedy physics (launch, flight, landing), tank area strikes.

/** Damage type / armor class per kind (indices into TYPE_MULT). */
const DMG_OF = Uint8Array.from(STATS, (s) => s.dmgType);
const ARM_OF = Uint8Array.from(STATS, (s) => s.armorCls);

/** Shield Tank: damage in the cone in front of it + strong knockback. */
export function shieldBash(b: Battle, i: number, dx: number, dy: number, dist: number): void {
  const u = b.units;
  const s = STATS[Kind.Shield];
  let fx = dx;
  let fy = dy;
  if (dist > 0.01) {
    fx /= dist;
    fy /= dist;
  } else {
    fx = u.facing[i];
    fy = -u.facing[i];
  }
  areaStrike(b, i, s.aoe, s.power, s.knockback, fx, fy, true);
  if (b.emitEvents) b.pushEvent({ type: 'bash', x: u.x[i], y: u.y[i], unit: i, angle: Math.atan2(fy, fx) });
}

/** Hammer Tank: circular strike around it; survivors are pushed back by half. */
export function bruteSlam(b: Battle, i: number): void {
  const u = b.units;
  const s = STATS[Kind.Brute];
  areaStrike(b, i, s.aoe, s.power, s.knockback, 0, 0, false);
  if (b.emitEvents) b.pushEvent({ type: 'slam', x: u.x[i], y: u.y[i], unit: i });
}

/** Scans the cells around the tank in the enemy grids: damage + knockback (cone or circle). */
export function areaStrike(b: Battle, i: number, radius: number, power: number, push: number, fx: number, fy: number, cone: boolean): void {
  const u = b.units;
  const ax = u.x[i];
  const ay = u.y[i];
  const enemies = b.enemyList[u.team[i]];
  const g0 = b.grids[0];
  const cols = g0.cols;
  const cx = Math.min(cols - 1, Math.max(0, (ax / g0.cell) | 0));
  const cy = Math.min(cols - 1, Math.max(0, (ay / g0.cell) | 0));
  const victims: number[] = [];
  for (let e = 0; e < enemies.length; e++) {
    const grid = b.grids[enemies[e]];
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
        const c = gy * cols + gx;
        for (let k = grid.start[c]; k < grid.start[c + 1]; k++) victims.push(grid.items[k]);
      }
    }
  }
  for (const j of victims) {
    if (!u.alive[j]) continue;
    const dx = u.x[j] - ax;
    const dy = u.y[j] - ay;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > radius) continue;
    let ux = d > 0.01 ? dx / d : 1;
    let uy = d > 0.01 ? dy / d : 0;
    if (cone && d > 0.01 && (dx * fx + dy * fy) / d < TANK.coneCos) continue;
    damage(b, j, power, i, true);
    if (!u.alive[j]) continue;
    if (b.comedy && u.airT[j] <= 0) {
      launch(b, j, cone ? fx : ux, cone ? fy : uy, push * 3.4 + 1.2);
      continue;
    }
    if (cone) {
      ux = fx;
      uy = fy;
    }
    // A victim that is itself a tank is pushed half as far.
    const amount = isTank(u.kind[j]) ? push * 0.5 : push;
    u.kbVx[j] = ux * amount * 9;
    u.kbVy[j] = uy * amount * 9;
    u.stunT[j] = TANK.stun;
  }
}

/** Applies the knockback velocity: never pushed onto a non-walkable tile, the velocity decays per step. */
export function applyKnockback(b: Battle, i: number, dt: number): void {
  const u = b.units;
  const t = b.terrain;
  const ox = u.x[i];
  const oy = u.y[i];
  let nx = Math.fround(Math.min(b.mapSize - 0.5, Math.max(0.5, ox + u.kbVx[i] * dt)));
  let ny = Math.fround(Math.min(b.mapSize - 0.5, Math.max(0.5, oy + u.kbVy[i] * dt)));
  if (t && !t.stepOk(ox, oy, nx, ny)) {
    if (t.walkable(nx, oy)) ny = oy;
    else if (t.walkable(ox, ny)) nx = ox;
    else {
      nx = ox;
      ny = oy;
    }
  }
  u.x[i] = nx;
  u.y[i] = ny;
  u.moving[i] = 1;
  u.kbVx[i] *= TANK.kbDecay;
  u.kbVy[i] *= TANK.kbDecay;
  if (Math.abs(u.kbVx[i]) + Math.abs(u.kbVy[i]) < 0.3) u.kbVx[i] = u.kbVy[i] = 0;
}

/** Launches j through the air `dist` tiles in the direction (ux,uy) (peak height grows with distance). */
export function launch(b: Battle, j: number, ux: number, uy: number, dist: number): void {
  const u = b.units;
  if (!b.comedy || !u.alive[j] || u.airT[j] > 0) return;
  const heavy = STATS[u.kind[j]].scale > 1 ? 0.5 : 1;
  const d = Math.min(MAX_LAUNCH, dist * heavy);
  if (d < 1) return;
  const lim = b.mapSize - 0.5;
  const len = Math.hypot(ux, uy) || 1;
  // Slight deviation: every launch looks different (deterministic rng).
  const a = Math.atan2(uy, ux) + (b.rng() - 0.5) * 0.7;
  u.airX0[j] = u.x[j];
  u.airY0[j] = u.y[j];
  u.airX1[j] = Math.min(lim, Math.max(0.5, u.x[j] + Math.cos(a) * d * (len > 0 ? 1 : 0)));
  u.airY1[j] = Math.min(lim, Math.max(0.5, u.y[j] + Math.sin(a) * d));
  u.airDur[j] = 0.42 + d * 0.06;
  u.airT[j] = u.airDur[j];
  u.airH[j] = 1.1 + d * 0.2;
  u.swing[j] = 0;
  u.hitPending[j] = 0;
  u.kbVx[j] = u.kbVy[j] = 0;
  u.stunT[j] = 0;
  u.sepX[j] = u.sepY[j] = 0;
  u.pathN[j] = 0;
  u.mvFlags[j] = 0;
  if (b.emitEvents) b.pushEvent({ type: 'burst', x: u.x[j], y: u.y[j], unit: -1, value: 0.8, element: 8 });
}

/** Flight step: linear progress + parabolic height; calls land() on touchdown. */
export function flyStep(b: Battle, i: number, dt: number): void {
  const u = b.units;
  u.airT[i] -= dt;
  const k = Math.min(1, Math.max(0, 1 - u.airT[i] / u.airDur[i]));
  u.x[i] = u.airX0[i] + (u.airX1[i] - u.airX0[i]) * k;
  u.y[i] = u.airY0[i] + (u.airY1[i] - u.airY0[i]) * k;
  u.lift[i] = 4 * u.airH[i] * k * (1 - k);
  u.moving[i] = 1;
  u.swing[i] = 0;
  u.hitPending[i] = 0;
  if (u.airT[i] <= 0) land(b, i);
}

/** Landing: water -> drowns; obstacle/cliff -> nearest walkable point; then lying on the ground + crushing. */
export function land(b: Battle, i: number): void {
  const u = b.units;
  u.airT[i] = 0;
  u.lift[i] = 0;
  u.x[i] = Math.fround(u.airX1[i]);
  u.y[i] = Math.fround(u.airY1[i]);
  const t = b.terrain;
  if (t) {
    const f = t.flags[((u.y[i] | 0) * t.size + (u.x[i] | 0)) | 0];
    if (f === T_WATER) {
      if (b.emitEvents) b.pushEvent({ type: 'burst', x: u.x[i], y: u.y[i], unit: -1, value: 1.8, element: 9 });
      killUnit(b, i);
      return;
    }
    if (!t.walkable(u.x[i], u.y[i]) || !t.reachable(u.x[i], u.y[i])) {
      const p = t.nearestWalkable(u.x[i], u.y[i], 12, true);
      if (!p) {
        killUnit(b, i);
        return;
      }
      u.x[i] = Math.fround(p.x);
      u.y[i] = Math.fround(p.y);
    }
  }
  u.px[i] = u.x[i];
  u.py[i] = u.y[i];
  u.winX[i] = u.x[i];
  u.winY[i] = u.y[i];
  u.winT[i] = 0;
  u.stunT[i] = 0.9 + b.rng() * 0.6;
  u.airImm[i] = 2.4;
  u.target[i] = -1;
  u.retarget[i] = 0.6;
  // Crush: small damage to neighbors caught under the landing unit.
  const out = b.scratch2;
  gather(b, b.allTeams, u.x[i], u.y[i], 0.8, out, 12);
  const crush = Math.max(2, u.maxHp[i] * 0.03);
  for (let k = 0; k < out.length; k++) {
    const j = out[k];
    if (j !== i && u.airT[j] <= 0) damage(b, j, crush, i, false, true);
  }
  if (b.emitEvents) b.pushEvent({ type: 'burst', x: u.x[i], y: u.y[i], unit: -1, value: 1.2, element: 0 });
}

/** After a hit: if the damage is a big share of health, throws the unit into the air (comedy physics). */
export function comedyHit(b: Battle, j: number, src: number, amount: number, melee: boolean): void {
  const u = b.units;
  if (u.airImm[j] > 0 || u.airT[j] > 0 || !u.alive[j]) return;
  const ratio = amount / Math.max(1, u.maxHp[j]);
  const srcMul = (isTank(u.kind[src]) ? 2.2 : 1) * (melee ? 1 : 0.4);
  const dist = (ratio * 34 + 0.4) * srcMul * (0.8 + b.rng() * 0.4);
  if (dist < 2.6) return;
  const dx = u.x[j] - u.x[src];
  const dy = u.y[j] - u.y[src];
  const l = Math.hypot(dx, dy);
  launch(b, j, l > 0.01 ? dx / l : 1, l > 0.01 ? dy / l : 0, dist);
}

export function pushUnit(b: Battle, j: number, ux: number, uy: number, amount: number): void {
  const u = b.units;
  if (!u.alive[j]) return;
  if (b.comedy) {
    launch(b, j, ux, uy, amount * 3.2 + 1);
    return;
  }
  const a = isTank(u.kind[j]) ? amount * 0.5 : amount;
  u.kbVx[j] = ux * a * 9;
  u.kbVy[j] = uy * a * 9;
}

export function addZone(b: Battle, x: number, y: number, r: number, t: number, dps: number, team: number, slowK: number, skill: SkillId): void {
  if (b.zones.length >= 32) b.zones.shift();
  b.zones.push({ x, y, r, t, dps, team, slowK });
  burst(b, x, y, r, skill);
}

export function updateZones(b: Battle, dt: number): void {
  const out = b.scratch;
  for (let k = b.zones.length - 1; k >= 0; k--) {
    const z = b.zones[k];
    z.t -= dt;
    if (z.t <= 0) {
      b.zones.splice(k, 1);
      continue;
    }
    gather(b, b.enemyList[z.team], z.x, z.y, z.r, out, 64);
    for (let a = 0; a < out.length; a++) {
      const j = out[a];
      if (z.dps > 0) damage(b, j, z.dps * dt, -1, false, true);
      if (z.slowK < 1 && b.units.alive[j]) applySlow(b, j, 0.4, z.slowK, z.slowK);
    }
  }
}

export function explode(b: Battle, i: number): void {
  const u = b.units;
  if ((u.flags[i] & F_EXPLODED) !== 0) return;
  u.flags[i] |= F_EXPLODED;
  const p = sp(b, 'explode');
  // May be called during death: a local array so as not to corrupt the shared array of nested loops.
  const out: number[] = [];
  gather(b, b.enemyList[u.team[i]], u.x[i], u.y[i], p.radius, out, 64);
  for (let k = 0; k < out.length; k++) damage(b, out[k], p.dmg, i, false);
  addZone(b, u.x[i], u.y[i], p.radius, p.dur, p.a / p.dur, u.team[i], 1, 'explode');
  if (u.alive[i]) killUnit(b, i);
}

/** Applies damage; returns the health actually lost. src: attacker, melee: close hit, quiet: do not produce events/flashes (damage over time). */
export function damage(b: Battle, j: number, amount: number, src = -1, melee = false, quiet = false): number {
  const u = b.units;
  if (!u.alive[j] || u.invulnT[j] > 0) return 0;
  // If no one has died for a long time, damage ramps up gradually: a heal stalemate cannot lock the battle.
  const stale = b.time - b.lastDeathTime - STALE_AFTER;
  if (stale > 0) amount *= 1 + stale * STALE_RAMP;
  if (src >= 0 && src !== j && b.terrain && b.terrain.hasRelief) amount *= highGroundDamage(b.terrain.heightAt(u.x[src], u.y[src]) - b.terrain.heightAt(u.x[j], u.y[j]), melee);
  if (src >= 0) amount *= TYPE_MULT[DMG_OF[u.kind[src]] * 4 + ARM_OF[u.kind[j]]];
  amount *= 1 - STATS[u.kind[j]].armor;
  if (u.shieldT[j] > 0) amount *= u.shieldK[j];
  const dealt = Math.min(amount, Math.max(0, u.hp[j]));
  b.counters.damage += dealt;
  if (src >= 0) b.meter.dmg[u.team[src] * KIND_COUNT + u.kind[src]] += dealt;
  if (!quiet) {
    if (b.emitEvents) b.pushEvent({ type: 'hit', x: u.x[j], y: u.y[j], unit: j, value: amount, kind: u.kind[j] });
    u.flash[j] = 0.12;
  }
  u.hp[j] -= amount;
  const skill = STATS[u.kind[j]].skill;
  if (skill === 'thorns' && melee && src >= 0 && u.alive[src]) damage(b, src, amount * sp(b, 'thorns').a, -1, false, true);
  if (b.comedy && !quiet && src >= 0 && src !== j && u.hp[j] > 0) comedyHit(b, j, src, amount, melee);
  if (!quiet && b.links.size > 0) {
    const lk = b.links.get(j);
    if (lk) for (const e of lk) if (u.alive[e]) damage(b, e, amount * sp(b, 'destinyBond').a, -1, false, true);
  }
  if (u.hp[j] <= 0) {
    if (skill === 'revive' && (u.flags[j] & F_REVIVED) === 0) {
      u.flags[j] |= F_REVIVED;
      u.hp[j] = u.maxHp[j] * sp(b, 'revive').a;
      u.invulnT[j] = 1;
      cleanse(b, j);
      burst(b, u.x[j], u.y[j], 2.2, skill);
      return dealt;
    }
    if (skill === 'explode' && (u.flags[j] & F_EXPLODED) === 0) {
      u.hp[j] = 1;
      explode(b, j);
      return dealt;
    }
    if (skill === 'destinyBond') {
      const lk = b.links.get(j);
      if (lk) for (const e of lk) if (u.alive[e]) damage(b, e, sp(b, 'destinyBond').dmg, -1, false, true);
    }
    killUnit(b, j, src, amount);
  }
  return dealt;
}

export function killUnit(b: Battle, j: number, src = -1, dmg = 0): void {
  const u = b.units;
  u.hp[j] = 0;
  b.lastDeathTime = b.time;
  b.counters.kills++;
  if (src >= 0 && src !== j) b.meter.kills[u.team[src]]++;
  u.alive[j] = 0;
  u.deathT[j] = 0;
  u.target[j] = -1;
  if (isRanged(u.kind[j])) {
    b.dbg.archerDeaths++;
    if (u.kiteState[j] === 1) b.dbg.archerDeathsKiting++;
  }
  if (b.emitEvents) {
    // Direction away from the hit and last hit strength (for the comedy-look ragdoll launch).
    const ang = src >= 0 && src !== j ? Math.atan2(u.y[j] - u.y[src], u.x[j] - u.x[src]) : u.facing[j] > 0 ? Math.PI : 0;
    b.pushEvent({ type: 'death', x: u.x[j], y: u.y[j], unit: j, kind: u.kind[j], angle: ang, value: dmg });
  }
}

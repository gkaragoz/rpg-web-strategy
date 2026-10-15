import { PROJ_TAG, Kind, STATS, isHealer, isRanged, isTank } from './units';
import { PF_PIERCE, PF_SKILL } from './projectiles';
import type { SkillParams } from './data/skills';
import { SPLASH_TARGETS, splashFactor } from './data/combat';
import { ARROW_SPEED, LANDING_RADIUS, STALE_AFTER, STALE_RAMP, TANK_REACH } from './battleConfig';
import type { SkillId } from './data/troops';
import { sp, dealMul, tick, burst, gather, gatherLine, applySlow, applyStun, applyFear, applyWeak, applyShield, applyTaunt, cleanse, healUnit, healArea } from './battleEffects';
import { damage, explode, addZone, pushUnit, areaStrike, shieldBash, bruteSlam } from './battleDamage';
import type { Battle } from './battle';

// Battle: resolving a unit attack (melee skills, projectiles, summons, periodic skills, projectile landing).

export function resolveHit(b: Battle, i: number): void {
  const u = b.units;
  const kind = u.kind[i];
  const s = STATS[kind];
  const skill = s.skill;
  if (skill === 'summonSkeleton') {
    summon(b, i);
    return;
  }
  const t = u.target[i];
  if (t < 0 || !u.alive[t]) return;
  const dx = u.x[t] - u.x[i];
  const dy = u.y[t] - u.y[i];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const power = s.power * dealMul(b, i);

  if (kind === Kind.Shield) {
    shieldBash(b, i, dx, dy, dist);
  } else if (kind === Kind.Brute) {
    bruteSlam(b, i);
  } else if (isHealer(kind)) {
    if (dist <= s.range + 1 && u.hp[t] < u.maxHp[t]) {
      const before = u.hp[t];
      const stale = b.time - b.lastDeathTime - STALE_AFTER;
      const heal = stale > 0 ? s.power / (1 + stale * STALE_RAMP) : s.power;
      u.hp[t] = Math.min(u.maxHp[t], u.hp[t] + heal);
      b.counters.heal += u.hp[t] - before;
      if (b.emitEvents) b.pushEvent({ type: 'heal', x: u.x[t], y: u.y[t], unit: t, value: heal, kind: u.kind[t] });
      if (skill === 'cleanse') {
        // Nun: also heals the target and the allies around it, removes control effects.
        const p = sp(b, 'cleanse');
        cleanse(b, t);
        const out = b.scratch;
        gather(b, b.selfList[u.team[i]], u.x[t], u.y[t], p.radius, out, 24);
        for (let k = 0; k < out.length; k++) {
          if (out[k] === t) continue;
          healUnit(b, out[k], heal * 0.5);
          cleanse(b, out[k]);
        }
        burst(b, u.x[t], u.y[t], p.radius, skill);
      }
    }
  } else if (isRanged(kind)) {
    fireShot(b, i, t, dist, power, skill);
  } else {
    meleeHit(b, i, t, dist, dx, dy, power, skill);
  }
}

/** Bone Caller: wakes a bone soldier from the pool. */
export function summon(b: Battle, i: number): void {
  const u = b.units;
  const pool = b.pools.get(i);
  if (!pool) return;
  let n = sp(b, 'summonSkeleton').count;
  for (let a = 0; a < pool.length && n > 0; a++) {
    const k = pool[a];
    if (u.alive[k]) continue;
    let x = u.x[i] + (b.rng() - 0.5) * 3;
    let y = u.y[i] + (b.rng() - 0.5) * 3;
    if (b.terrain) {
      const p = b.terrain.nearestWalkable(x, y, 3, true);
      if (!p) continue;
      x = p.x;
      y = p.y;
    }
    u.alive[k] = 1;
    u.hp[k] = u.maxHp[k];
    u.deathT[k] = 0;
    u.x[k] = u.px[k] = x;
    u.y[k] = u.py[k] = y;
    u.target[k] = -1;
    u.retarget[k] = 0;
    u.cooldown[k] = 0.4;
    u.flash[k] = 0.25;
    u.stunT[k] = u.slowT[k] = u.fearT[k] = u.burnT[k] = 0;
    u.winX[k] = x;
    u.winY[k] = y;
    u.winT[k] = 0;
    n--;
    burst(b, x, y, 1.6, 'summonSkeleton');
  }
}

/** Periodic skills: taunt, mockery, stone will. */
export function periodic(b: Battle, i: number, dt: number, skill: SkillId): void {
  const u = b.units;
  u.skillT[i] -= dt;
  if (u.skillT[i] > 0) return;
  const p = sp(b, skill);
  const out = b.scratch;
  const team = u.team[i];
  if (skill === 'mock' || skill === 'taunt') {
    u.skillT[i] = p.b;
    gather(b, b.enemyList[team], u.x[i], u.y[i], p.radius, out, 48);
    if (out.length === 0) {
      u.skillT[i] = 0.6;
      return;
    }
    for (let k = 0; k < out.length; k++) {
      // The taunt lasts until the next period: so the target does not keep changing.
      applyTaunt(b, out[k], i, p.b + 0.5);
      if (skill === 'mock') applyWeak(b, out[k], p.dur, p.a);
    }
    burst(b, u.x[i], u.y[i], p.radius, skill);
  } else if (skill === 'stoneWill') {
    u.skillT[i] = 6;
    gather(b, b.enemyList[team], u.x[i], u.y[i], p.radius, out, 48);
    if (out.length === 0) {
      u.skillT[i] = 1;
      return;
    }
    applyShield(b, i, p.dur, p.b);
    for (let k = 0; k < out.length; k++) {
      damage(b, out[k], STATS[u.kind[i]].power * 0.6, i, false);
      applySlow(b, out[k], p.dur, p.a, p.a);
    }
    burst(b, u.x[i], u.y[i], p.radius, skill);
  }
}

/** Melee hit: base damage + skill. */
export function meleeHit(b: Battle, i: number, t: number, dist: number, dx: number, dy: number, power: number, skill: SkillId | null): void {
  const u = b.units;
  const s = STATS[u.kind[i]];
  if (skill === 'explode') {
    explode(b, i);
    return;
  }
  if (dist > s.range + 0.6 + (isTank(u.kind[t]) && !isTank(u.kind[i]) ? TANK_REACH : 0)) return;
  const nx = dist > 0.01 ? dx / dist : u.facing[i];
  const ny = dist > 0.01 ? dy / dist : 0;
  const out = b.scratch;
  let dealt = 0;
  if (skill === 'stun') {
    // Night Lancer: every hit is a strong thrust into the strip in front of it + a stun.
    const p = sp(b, 'stun');
    gatherLine(b, b.enemyList[u.team[i]], u.x[i], u.y[i], nx, ny, p.length, p.half, out);
    for (let k = 0; k < out.length; k++) {
      damage(b, out[k], p.dmg, i, true);
      applyStun(b, out[k], p.dur);
    }
    burst(b, u.x[i] + nx * 2, u.y[i] + ny * 2, 2, skill);
    return;
  }
  if (s.shape === 1 && s.splash > 0) {
    gather(b, b.enemyList[u.team[i]], u.x[t], u.y[t], s.splash, out, SPLASH_TARGETS);
    for (let k = 0; k < out.length; k++) dealt += damage(b, out[k], power * splashFactor(Math.hypot(u.x[out[k]] - u.x[t], u.y[out[k]] - u.y[t]), s.splash), i, true);
    burst(b, u.x[t], u.y[t], s.splash, null);
  } else if (s.shape === 2 && s.splash > 0) {
    gatherLine(b, b.enemyList[u.team[i]], u.x[i], u.y[i], nx, ny, s.splash * 1.7, s.splash * 0.5 + 0.3, out);
    for (let k = 0; k < out.length; k++) dealt += damage(b, out[k], power, i, true);
  } else {
    dealt = damage(b, t, power, i, true);
  }
  if (!skill) return;
  const p = sp(b, skill);
  switch (skill) {
    case 'lifesteal':
      u.hp[i] = Math.min(u.maxHp[i], u.hp[i] + dealt * p.a);
      break;
    case 'heal':
      healArea(b, u.team[i], u.x[i], u.y[i], p.radius, p.dmg);
      burst(b, u.x[i], u.y[i], 1.8, skill);
      break;
    case 'bash':
      if (tick(b, i, p.every)) {
        areaStrike(b, i, p.radius, p.dmg, p.a, 0, 0, false);
        burst(b, u.x[i], u.y[i], p.radius, skill);
        if (b.emitEvents) b.pushEvent({ type: 'slam', x: u.x[i], y: u.y[i], unit: i });
      }
      break;
    case 'knives':
      if (tick(b, i, p.every)) {
        gather(b, b.enemyList[u.team[i]], u.x[i], u.y[i], p.radius, out, p.count);
        for (let k = 0; k < out.length; k++) damage(b, out[k], p.dmg, i, false);
        burst(b, u.x[i], u.y[i], p.radius, skill);
      }
      break;
    case 'shield':
      if (tick(b, i, p.every)) {
        gather(b, b.selfList[u.team[i]], u.x[i], u.y[i], p.radius, out, 48);
        let n = p.count;
        for (let k = 0; k < out.length && n > 0; k++) {
          const j = out[k];
          if (u.hp[j] < u.maxHp[j] * 0.7) {
            applyShield(b, j, p.dur, p.a);
            n--;
          }
        }
        burst(b, u.x[i], u.y[i], p.radius, skill);
      }
      break;
    case 'withstand':
      if (tick(b, i, p.every)) {
        gather(b, b.selfList[u.team[i]], u.x[i], u.y[i], p.radius, out, 48);
        for (let k = 0; k < out.length; k++) applyShield(b, out[k], p.dur, p.a);
        burst(b, u.x[i], u.y[i], p.radius, skill);
      }
      break;
    case 'charge':
      if (tick(b, i, p.every)) {
        gatherLine(b, b.enemyList[u.team[i]], u.x[i], u.y[i], nx, ny, p.length, p.half, out);
        for (let k = 0; k < out.length; k++) {
          damage(b, out[k], p.dmg, i, true);
          pushUnit(b, out[k], nx, ny, p.a);
          applyStun(b, out[k], 0.3);
        }
        burst(b, u.x[i] + nx * 3, u.y[i] + ny * 3, 2.5, skill);
      }
      break;
    case 'swarm':
      if (tick(b, i, p.every)) {
        gatherLine(b, b.enemyList[u.team[i]], u.x[i], u.y[i], nx, ny, p.length, p.half, out);
        for (let k = 0; k < out.length; k++) damage(b, out[k], p.dmg, i, false);
        burst(b, u.x[i] + nx * 4, u.y[i] + ny * 4, 3.5, skill);
      }
      break;
    case 'fear':
      if (tick(b, i, p.every)) {
        gather(b, b.enemyList[u.team[i]], u.x[i], u.y[i], p.radius, out, 64);
        for (let k = 0; k < out.length; k++) applyFear(b, out[k], p.dur, u.x[i], u.y[i]);
        burst(b, u.x[i], u.y[i], p.radius, skill);
      }
      break;
    case 'rockThrow':
      if (tick(b, i, p.every)) {
        gather(b, b.enemyList[u.team[i]], u.x[t], u.y[t], p.radius, out, 48);
        for (let k = 0; k < out.length; k++) {
          damage(b, out[k], p.dmg, i, false);
          applyStun(b, out[k], p.dur);
        }
        burst(b, u.x[t], u.y[t], p.radius, skill);
      }
      break;
    case 'refraction':
      if (tick(b, i, p.every)) {
        u.invulnT[i] = p.dur;
        gather(b, b.enemyList[u.team[i]], u.x[i], u.y[i], p.radius, out, 48);
        for (let k = 0; k < out.length; k++) damage(b, out[k], p.dmg, i, false);
        burst(b, u.x[i], u.y[i], p.radius, skill);
      }
      break;
  }
}

/** Ranged attack: spawns a projectile, sets the payload/flags for the skill. */
export function fireShot(b: Battle, i: number, t: number, dist: number, power: number, skill: SkillId | null): void {
  const u = b.units;
  const s = STATS[u.kind[i]];
  const team = u.team[i];
  let dmg = power;
  let flags = s.shape === 3 ? PF_PIERCE : 0;
  const lob = s.splash >= 3 || skill === 'ship';
  if (skill) {
    const p = sp(b, skill);
    switch (skill) {
      case 'crit':
        if (b.rng() < p.a) dmg *= p.b;
        break;
      case 'spearBuild':
        u.stacks[i] = Math.min(p.count, u.stacks[i] + 1);
        u.stackT[i] = p.dur;
        break;
      case 'frostBlast':
      case 'fireball':
      case 'ship':
      case 'curseZone':
      case 'chill':
        if (tick(b, i, p.every)) flags |= PF_SKILL;
        break;
      case 'hex':
        flags |= PF_SKILL;
        break;
      case 'orbs':
        if (tick(b, i, p.every)) fireOrbs(b, i, p);
        break;
      case 'axes':
        if (tick(b, i, p.every)) {
          const nx = dist > 0.01 ? (u.x[t] - u.x[i]) / dist : 1;
          const ny = dist > 0.01 ? (u.y[t] - u.y[i]) / dist : 0;
          const out = b.scratch;
          gatherLine(b, b.enemyList[team], u.x[i], u.y[i], nx, ny, p.length, p.half, out);
          for (let k = 0; k < out.length; k++) damage(b, out[k], p.dmg, i, false);
          burst(b, u.x[i] + nx * 5, u.y[i] + ny * 5, 3, skill);
        }
        break;
    }
  }
  const speed = lob ? 10 : ARROW_SPEED;
  const flight = Math.max(0.25, dist / speed);
  const tx = u.x[t] + u.vx[t] * flight;
  const ty = u.y[t] + u.vy[t] * flight;
  const height = lob ? 30 + dist * 3 : 18 + dist * 2.2;
  b.projectiles.spawn(u.x[i], u.y[i], tx, ty, flight, height, dmg, team, i, s.splash, flags, PROJ_TAG[u.kind[i]]);
  if (b.emitEvents) b.pushEvent({ type: 'shot', x: u.x[i], y: u.y[i], unit: i, angle: Math.atan2(ty - u.y[i], tx - u.x[i]) });
}

/** Horned Seer: fireballs at several enemies at once. */
export function fireOrbs(b: Battle, i: number, p: SkillParams): void {
  const u = b.units;
  const out = b.scratch;
  gather(b, b.enemyList[u.team[i]], u.x[i], u.y[i], STATS[u.kind[i]].range, out, 12);
  let n = p.count;
  for (let k = 0; k < out.length && n > 0; k++, n--) {
    const j = out[k];
    const d = Math.hypot(u.x[j] - u.x[i], u.y[j] - u.y[i]);
    b.projectiles.spawn(u.x[i], u.y[i], u.x[j], u.y[j], Math.max(0.3, d / ARROW_SPEED), 20 + d * 2, p.dmg, u.team[i], i, 0, 0, 1);
  }
}

/** Projectile landed: area, piercing or single target; skill side effects. */
export function arrowLanded(b: Battle, x: number, y: number, team: number, dmg: number, idx: number): void {
  const u = b.units;
  const pr = b.projectiles;
  const src = pr.src[idx];
  const spl = pr.splash[idx];
  const fl = pr.flags[idx];
  const skill = src >= 0 ? STATS[u.kind[src]].skill : null;
  const out = b.scratch;
  const enemies = b.enemyList[team];
  out.length = 0;
  if (spl > 0) {
    gather(b, enemies, x, y, spl, out, SPLASH_TARGETS);
    if (out.length > 0 && b.emitEvents && spl >= 2.5) burst(b, x, y, spl, skill);
  } else {
    const g0 = b.grids[0];
    const cols = g0.cols;
    const cx = Math.min(cols - 1, Math.max(0, (x / g0.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (y / g0.cell) | 0));
    let best = -1;
    let bestD = LANDING_RADIUS;
    for (let e = 0; e < enemies.length; e++) {
      const grid = b.grids[enemies[e]];
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
          const c = gy * cols + gx;
          for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
            const j = grid.items[k];
            if (!u.alive[j]) continue;
            const ex = u.x[j] - x;
            const ey = u.y[j] - y;
            const d = Math.sqrt(ex * ex + ey * ey);
            if (d < bestD) {
              bestD = d;
              best = j;
            }
          }
        }
      }
    }
    if (best >= 0) out.push(best);
    if (best >= 0 && (fl & PF_PIERCE) !== 0) {
      // Piercing: two more enemies right behind the same point, with reduced damage.
      const extra = b.scratch2;
      gather(b, enemies, x, y, 1.6, extra, 12);
      let n = 2;
      for (let k = 0; k < extra.length && n > 0; k++) {
        if (extra[k] !== best) {
          out.push(extra[k]);
          n--;
        }
      }
    }
  }
  if (out.length === 0) {
    if (b.emitEvents) b.pushEvent({ type: 'land', x, y, unit: -1 });
    if (skill === 'burnOil') landSkill(b, src, x, y, team, skill, fl);
    return;
  }
  let amount = dmg;
  let slowSkill: SkillParams | null = null;
  let stun = 0;
  if (skill && (fl & PF_SKILL) !== 0) {
    const p = sp(b, skill);
    if (skill === 'frostBlast') {
      amount = p.dmg;
      slowSkill = p;
    } else if (skill === 'ship') {
      amount = dmg * p.a;
      stun = p.dur;
    } else if (skill === 'chill') {
      slowSkill = p;
      stun = p.dur * 0.75;
    } else if (skill === 'hex') stun = p.dur;
  } else if (skill === 'hex') stun = sp(b, 'hex').dur;
  else if (skill === 'chill') slowSkill = sp(b, 'chill');
  const first = out[0];
  for (let k = 0; k < out.length; k++) {
    const j = out[k];
    const fall = spl > 0 && !(skill && (fl & PF_SKILL) !== 0) ? splashFactor(Math.hypot(u.x[j] - x, u.y[j] - y), spl) : 1;
    damage(b, j, (k === 0 || spl > 0 ? amount : amount * 0.6) * fall, src, false);
    if (!u.alive[j]) continue;
    if (slowSkill) applySlow(b, j, slowSkill.dur || 2, slowSkill.a, slowSkill.b);
    if (stun > 0 && (skill !== 'chill' || (fl & PF_SKILL) !== 0)) applyStun(b, j, stun);
  }
  landSkill(b, src, x, y, team, skill, fl, first);
}

/** Skill effects after landing: zone, split balls. */
export function landSkill(b: Battle, src: number, x: number, y: number, team: number, skill: SkillId | null, fl: number, first = -1): void {
  if (!skill || src < 0) return;
  const p = sp(b, skill);
  if (skill === 'burnOil') addZone(b, x, y, p.radius, p.dur, p.dmg / p.dur, team, 1, skill);
  else if (skill === 'curseZone' && (fl & PF_SKILL) !== 0) addZone(b, x, y, p.radius, p.dur, p.dmg, team, p.a, skill);
  else if (skill === 'fireball' && (fl & PF_SKILL) !== 0) {
    const near = b.scratch2;
    gather(b, b.enemyList[team], x, y, p.radius, near, 24);
    const u = b.units;
    for (let k = 0; k < p.count && near.length > 0; k++) {
      const j = near[Math.floor(b.rng() * near.length)];
      if (j === first && near.length > 1) continue;
      b.projectiles.spawn(x, y, u.x[j], u.y[j], 0.3, 14, p.dmg, team, src, 0, 0, 1);
    }
  }
}

import { PATH_MAX } from './constants';
import { PICK_KEEP } from './picker';
import { KITE, STATS, isHealer, isMelee, isRanged } from './units';
import { highGroundRange } from './data/combat';
import { CHASE_TIMEOUT, BAN_TIME, LEASH_HOLD_MAX, LEASH_OFF } from './battleConfig';
import type { Battle } from './battle';

// Battle: unit AI helpers (melee threat scan, kiting, chase watchdog, leash, target choice, marching).

/**
 * Can unit i (not melee) hit target t from this distance: height advantage extends the range of ranged attackers
 * (disadvantage shortens it), and a ridge in the way blocks direct fire (arrows, bolts), but not lobbed or magic shots.
 */
export function canShoot(b: Battle, i: number, t: number, dist: number): boolean {
  const u = b.units;
  const s = STATS[u.kind[i]];
  const tr = b.terrain;
  if (!tr || !tr.hasRelief || !isRanged(u.kind[i])) return dist <= s.range * 0.95;
  const reach = (s.range + highGroundRange(tr.heightAt(u.x[i], u.y[i]) - tr.heightAt(u.x[t], u.y[t]))) * 0.95;
  if (dist > reach) return false;
  if (s.magical || s.splash >= 3 || s.skill === 'ship') return true;
  return !tr.blocksFire(u.x[i], u.y[i], u.x[t], u.y[t]);
}

/** Melee threat scan: 3x3 cells on the coarse grid, staggered per unit. */
export function updateThreat(b: Battle, i: number): void {
  if ((i + b.stepNo) % b.scanEveryK !== 0) return;
  const u = b.units;
  const danger = isRanged(u.kind[i]) ? KITE.archerDanger : KITE.priestDanger;
  const d2max = danger * danger;
  const enemies = b.enemyList[u.team[i]];
  const g0 = b.grids[0];
  const cols = g0.cols;
  const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / g0.cell) | 0));
  const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / g0.cell) | 0));
  const xi = u.x[i];
  const yi = u.y[i];
  let best = Infinity;
  let ax = 0;
  let ay = 0;
  for (let e = 0; e < enemies.length; e++) {
    const grid = b.grids[enemies[e]];
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
        const c = gy * cols + gx;
        for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
          const j = grid.items[k];
          if (!isMelee(u.kind[j])) continue;
          const dx = xi - u.x[j];
          const dy = yi - u.y[j];
          const d2 = dx * dx + dy * dy;
          if (d2 >= d2max) continue;
          const w = 1 / (d2 + 0.5);
          ax += dx * w;
          ay += dy * w;
          if (d2 < best) best = d2;
        }
      }
    }
  }
  if (best === Infinity) {
    u.threatDist[i] = Infinity;
    return;
  }
  const mag = Math.sqrt(ax * ax + ay * ay) || 1;
  u.threatDx[i] = ax / mag;
  u.threatDy[i] = ay / mag;
  u.threatDist[i] = Math.sqrt(best);
}

/**
 * Archer/priest kiting: retreats if there is a threat. The archer may first take a quick shot, and fights
 * when stamina runs out or when cornered. While running back it faces the enemy.
 * true: moved/attacked this step.
 */
export function tryKite(b: Battle, i: number, dt: number): boolean {
  const u = b.units;
  const archer = isRanged(u.kind[i]);
  const danger = archer ? KITE.archerDanger : KITE.priestDanger;
  const safe = archer ? KITE.archerSafe : KITE.priestSafe;
  const td = u.threatDist[i];

  if (u.kiteState[i] === 1) {
    if (td >= safe || u.stamina[i] <= 0.05) u.kiteState[i] = 0;
  } else if (td < danger) {
    if (u.stamina[i] <= KITE.staminaMin) return false; // tired: cannot flee
    if (archer) {
      if (td <= KITE.archerCornered) {
        b.dbg.cornered++;
        return false; // fight: last defensive shot
      }
      const t = u.target[i];
      if (u.cooldown[i] <= 0 && td >= KITE.archerSnapMin && t >= 0 && u.alive[t]) {
        const ex = u.x[t] - u.x[i];
        const ey = u.y[t] - u.y[i];
        if (ex * ex + ey * ey <= STATS[u.kind[i]].range * STATS[u.kind[i]].range) {
          b.faceTo(i, ex, ey);
          b.startAttack(i);
          b.dbg.snapShots++;
          return true;
        }
      }
    }
    u.kiteState[i] = 1;
    b.dbg.kites++;
  }
  if (u.kiteState[i] !== 1) return false;

  const tm = u.team[i];
  let dx = u.threatDx[i];
  let dy = u.threatDy[i];
  let px = b.centroidX[tm] - u.x[i];
  let py = b.centroidY[tm] - u.y[i];
  const pl = Math.sqrt(px * px + py * py);
  if (pl > 1e-3) {
    px /= pl;
    py /= pl;
    // Lane Conquest: the army is spread over three walled lanes, so there is no common centre to retreat towards.
    const pull = b.noLeash ? 0 : KITE.armyPull;
    dx = dx * (1 - pull) + px * pull;
    dy = dy * (1 - pull) + py * pull;
  }
  const sp = STATS[u.kind[i]].speed * (archer ? KITE.archerSprint : KITE.priestSprint);
  const step = sp * dt;
  const mv = b.mover.move(i, u.x[i] + dx * 3, u.y[i] + dy * 3, sp, dt, false, false);
  b.faceTo(i, -u.threatDx[i], -u.threatDy[i]);
  b.dbg.kiteSteps++;
  u.stamina[i] = Math.max(0, u.stamina[i] - (archer ? KITE.staminaDrain : KITE.priestStaminaDrain) * dt);
  if (mv < step * 0.2) {
    // Stuck at a river/obstacle: give up fleeing.
    u.kiteState[i] = 0;
    u.stamina[i] = 0;
    b.dbg.cornered++;
  }
  return true;
}

/**
 * Progress watchdog: a unit that cannot get closer to its target (crowd, obstacle, unreachable) bans
 * that target after a while and picks another one. true: the target was dropped.
 */
export function chaseWatchdog(b: Battle, i: number, t: number, dist: number, dt: number): boolean {
  const u = b.units;
  // A unit following a detour (a ramp around a cliff) gets farther from its target in a straight line before it gets closer:
  // while it walks a path, progress is measured along that path.
  if (u.pathN[i] > 0) {
    const m = chaseWalk(b, i, t);
    if (m > u.chaseBest[i] + 4) {
      // A new, longer route was found: it is the new baseline, not a lack of progress.
      u.chaseBest[i] = m;
      u.chaseT[i] = 0;
      return false;
    }
    dist = m;
  }
  if (dist < u.chaseBest[i] - 0.5) {
    u.chaseBest[i] = dist;
    u.chaseT[i] = 0;
    return false;
  }
  u.chaseT[i] += dt;
  if (u.chaseT[i] < CHASE_TIMEOUT) return false;
  u.banTarget[i] = t;
  u.banT[i] = BAN_TIME;
  if (u.attackers[t] > 0 && !(isHealer(u.kind[i]))) u.attackers[t]--;
  if (u.healers[t] > 0 && isHealer(u.kind[i])) u.healers[t]--;
  u.target[i] = -1;
  u.retarget[i] = 0;
  u.chaseT[i] = 0;
  u.chaseBest[i] = Infinity;
  b.dbg.bans++;
  return true;
}

/** Remaining walking distance to the target along the unit's current path (its waypoints, then the straight leg to the target). */
export function chaseWalk(b: Battle, i: number, t: number): number {
  const u = b.units;
  const m = u.pathN[i];
  const pts = u.pathPts;
  const base = i * PATH_MAX * 2;
  let k = Math.min(u.pathK[i], m - 1);
  let d = Math.hypot(pts[base + k * 2] - u.x[i], pts[base + k * 2 + 1] - u.y[i]);
  for (; k < m - 1; k++) d += Math.hypot(pts[base + (k + 1) * 2] - pts[base + k * 2], pts[base + (k + 1) * 2 + 1] - pts[base + k * 2 + 1]);
  return d + Math.hypot(u.x[t] - pts[base + (m - 1) * 2], u.y[t] - pts[base + (m - 1) * 2 + 1]);
}

/** Leash: true if it is holding the unit back; if the wait was too long, temporarily disables it. */
export function leashHold(b: Battle, i: number, dt: number): boolean {
  const u = b.units;
  if (!beyondLeash(b, i)) {
    u.holdT[i] = 0;
    return false;
  }
  u.holdT[i] += dt;
  if (u.holdT[i] > LEASH_HOLD_MAX) {
    u.leashOffT[i] = LEASH_OFF;
    u.holdT[i] = 0;
    b.dbg.leashBreaks++;
    return false;
  }
  return true;
}

/** Archers/priests must not get in front of their own warrior center (toward the enemy). */
export function beyondLeash(b: Battle, i: number): boolean {
  const u = b.units;
  const tm = u.team[i];
  if (!b.kiteOn || b.noLeash || !b.hasFront[tm] || u.leashOffT[i] > 0) return false;
  const en = b.nearestEnemy[tm];
  if (en < 0) return false;
  let ex = b.centroidX[en] - b.frontX[tm];
  let ey = b.centroidY[en] - b.frontY[tm];
  const len = Math.sqrt(ex * ex + ey * ey);
  if (len < 1e-3) return false;
  ex /= len;
  ey /= len;
  return (u.x[i] - b.frontX[tm]) * ex + (u.y[i] - b.frontY[tm]) * ey > KITE.leash;
}

/**
 * The unit's target choice at its retarget moment: normally the result of the picking phase at the start of the step
 * (`Picker`), recomputed here when that result is missing or no longer valid.
 */
export function pickNow(b: Battle, i: number): void {
  const u = b.units;
  if (u.tauntT[i] > 0) {
    const b = u.tauntBy[i];
    if (b >= 0 && u.alive[b]) {
      u.target[i] = b;
      return;
    }
  }
  let best: number;
  if (u.pickMark[i]) {
    best = u.pickBest[i];
    u.pickMark[i] = 0;
    // The chosen unit (or the locked current target) may have died since the phase ran.
    if ((best >= 0 && !u.alive[best]) || (best === PICK_KEEP && !(u.target[i] >= 0 && u.alive[u.target[i]]))) best = b.picker.pick(i);
  } else best = b.picker.pick(i);
  applyPick(b, i, best);
}

/** Makes the choice effective: attacker/healer counts and chase state. */
export function applyPick(b: Battle, i: number, best: number): void {
  const u = b.units;
  if (best === PICK_KEEP) return;
  const cur = u.target[i];
  const isPriest = isHealer(u.kind[i]);
  if (cur >= 0 && cur !== best) {
    if (isPriest) {
      if (u.healers[cur] > 0) u.healers[cur]--;
    } else if (u.attackers[cur] > 0) u.attackers[cur]--;
  }
  if (best >= 0 && best !== cur) {
    if (isPriest) u.healers[best]++;
    else u.attackers[best]++;
  }
  if (best !== cur) {
    u.chaseT[i] = 0;
    u.chaseBest[i] = Infinity;
  }
  u.target[i] = best;
}

export function marchToEnemy(b: Battle, i: number, dt: number): void {
  const u = b.units;
  // A unit goal (a lane soldier's next waypoint) wins over everything else, including the leash.
  if (b.unitHasGoal[i] === 1) {
    b.queueMove(i, b.unitGoalX[i], b.unitGoalY[i], STATS[u.kind[i]].speed);
    return;
  }
  const tm = u.team[i];
  const en = b.nearestEnemy[tm];
  if (en < 0) return;
  if (!isMelee(u.kind[i]) && leashHold(b, i, dt)) return;
  // A mode goal (e.g. a control point) replaces the nearest enemy as the destination.
  if (b.teamHasGoal[tm]) {
    b.queueMove(i, b.teamGoalX[tm], b.teamGoalY[tm], STATS[u.kind[i]].speed);
    return;
  }
  b.queueMove(i, b.centroidX[en], b.centroidY[en], STATS[u.kind[i]].speed);
}

export function followArmy(b: Battle, i: number): void {
  const u = b.units;
  const tm = u.team[i];
  const en = b.nearestEnemy[tm];
  // With no warriors (only priests) there is no one to escort: do not flee into a corner.
  if (en < 0 || b.damagerCount[tm] === 0) return;
  let ax = b.centroidX[tm] - b.centroidX[en];
  let ay = b.centroidY[tm] - b.centroidY[en];
  const len = Math.sqrt(ax * ax + ay * ay) || 1;
  ax /= len;
  ay /= len;
  const gx = b.centroidX[tm] + ax * 2.5;
  const gy = b.centroidY[tm] + ay * 2.5;
  const gdx = gx - u.x[i];
  const gdy = gy - u.y[i];
  if (gdx * gdx + gdy * gdy > 2.25) b.queueMove(i, gx, gy, STATS[u.kind[i]].speed);
}

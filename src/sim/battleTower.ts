import { STATS, STRUCT_OF } from './units';
import { fireShot } from './battleSkills';
import { dealMul } from './battleEffects';
import type { Battle } from './battle';

// Battle: the armed structure (Lane Conquest tower). It never moves and ignores crowd control (it is a structure, see
// Battle.updateStructure), but it fires at the nearest enemy SOLDIER in range with the normal projectile pipeline (fireShot), so
// its arrows fly, land and deal damage exactly like an archer's. Structures (enemy towers, castles) are never its targets.

/** Seconds between two target scans while nothing is in range (the scan is cheap but there is no need to run it every step). */
export const TOWER_SCAN = 0.2;

/** Nearest living enemy non-structure unit within `range` of tower i, or -1. Allocation-free; ties go to the lowest unit index. */
export function towerTarget(b: Battle, i: number, range: number): number {
  const u = b.units;
  const enemies = b.enemyList[u.team[i]];
  const g0 = b.grids[0];
  const cols = g0.cols;
  const cell = g0.cell;
  const x = u.x[i];
  const y = u.y[i];
  const gx0 = Math.max(0, ((x - range) / cell) | 0);
  const gx1 = Math.min(cols - 1, ((x + range) / cell) | 0);
  const gy0 = Math.max(0, ((y - range) / cell) | 0);
  const gy1 = Math.min(cols - 1, ((y + range) / cell) | 0);
  let best = -1;
  let bestD = range * range;
  for (let e = 0; e < enemies.length; e++) {
    const grid = b.grids[enemies[e]];
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * cols + gx;
        for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
          const j = grid.items[k];
          if (!u.alive[j] || STRUCT_OF[u.kind[j]] !== 0 || u.airT[j] > 0) continue;
          const dx = u.x[j] - x;
          const dy = u.y[j] - y;
          const d = dx * dx + dy * dy;
          if (d < bestD || (d === bestD && best >= 0 && j < best)) {
            bestD = d;
            best = j;
          }
        }
      }
    }
  }
  return best;
}

/** One step of a tower: cooldown and animation timers, then (if ready) pick the nearest enemy soldier in range and shoot it. */
export function towerStep(b: Battle, i: number, dt: number): void {
  const u = b.units;
  const s = STATS[u.kind[i]];
  if (u.cooldown[i] > 0) u.cooldown[i] -= dt;
  if (u.retarget[i] > 0) u.retarget[i] -= dt;
  if (u.swing[i] > 0) u.swing[i] = Math.max(0, u.swing[i] - dt);
  if (u.cooldown[i] > 0 || u.retarget[i] > 0) return;
  const t = towerTarget(b, i, s.range);
  if (t < 0) {
    u.retarget[i] = TOWER_SCAN;
    return;
  }
  const dx = u.x[t] - u.x[i];
  const dy = u.y[t] - u.y[i];
  b.faceTo(i, dx, dy);
  fireShot(b, i, t, Math.sqrt(dx * dx + dy * dy), s.power * dealMul(b, i), null);
  u.cooldown[i] = s.cooldown;
  u.swing[i] = s.swing;
}

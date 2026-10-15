import { KIND_OF_TROOP, Kind, STATS } from './units';
import { DEMO_GAP_HALF, BENCH_GAP, SUMMON_POOL, benchLayout } from './battleConfig';
import { sp } from './battleEffects';
import type { Battle } from './battle';

// Battle: initial layouts (demo, bench, user-placed) and skill setup of the spawned units.

/** Units placed by the user. */
export function spawnLayout(b: Battle): void {
  const L = b.config.layout;
  if (!L) return;
  b.layoutUnits.length = 0;
  for (let k = 0; k + 3 < L.length; k += 4) {
    b.layoutUnits.push(-1);
    let x = L[k + 2];
    let y = L[k + 3];
    // When the seed changes, a unit left under water/an obstacle is moved to the nearest walkable point.
    if (b.terrain && !(b.terrain.walkable(x, y) && b.terrain.reachable(x, y))) {
      const p = b.terrain.nearestWalkable(x, y, 20, true);
      if (!p) continue;
      x = p.x;
      y = p.y;
    }
    const i = b.units.spawn(L[k] | 0, L[k + 1] | 0, x, y, b.rng);
    b.layoutUnits[k >> 2] = i;
    b.units.retarget[i] = b.rng() * 1.5;
  }
}

/** Armies line up facing each other along the horizontal screen axis (the x-y axis); the river lies between them. */
export function spawnArmy(b: Battle, team: number, side: number): void {
  const c = b.mapSize / 2;
  const ux = Math.SQRT1_2 * side;
  const uy = -Math.SQRT1_2 * side;
  const vx = Math.SQRT1_2;
  const vy = Math.SQRT1_2;
  const rows: Array<[number, number, number, number]> = [
    [Kind.Warrior, 5, 1.5, 0],
    [Kind.Archer, 3, 2.2, 2.5],
    [Kind.Priest, 2, 2.5, 4.5],
  ];
  for (const [kind, n, spacing, depth] of rows) {
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * spacing + (b.rng() - 0.5) * 0.4;
      const d = DEMO_GAP_HALF + depth + (b.rng() - 0.5) * 0.4;
      b.units.spawn(team, kind, c + ux * d + vx * off, c + uy * d + vy * off, b.rng);
    }
  }
}

/** Block layout: warriors in front, archers behind them, priests at the very back. */
export function spawnBenchArmy(b: Battle, team: number, side: number): void {
  const n = b.config.perTeam;
  const { cols, spacing } = benchLayout(n);
  const c = b.mapSize / 2;
  const ux = Math.SQRT1_2 * side;
  const uy = -Math.SQRT1_2 * side;
  const vx = Math.SQRT1_2;
  const vy = Math.SQRT1_2;
  const warriors = Math.round(n * 0.5);
  const archers = Math.round(n * 0.3);
  for (let k = 0; k < n; k++) {
    const kind = k < warriors ? Kind.Warrior : k < warriors + archers ? Kind.Archer : Kind.Priest;
    const row = Math.floor(k / cols);
    const col = k % cols;
    const off = (col - (cols - 1) / 2) * spacing + (b.rng() - 0.5) * 0.3;
    const d = BENCH_GAP / 2 + row * spacing + (b.rng() - 0.5) * 0.3;
    const i = b.units.spawn(team, kind, c + ux * d + vx * off, c + uy * d + vy * off, b.rng);
    b.units.retarget[i] = b.rng() * 3;
  }
}

/** Lifecycle setup for skilled units: bone soldier pool, hex links. */
export function setupSkills(b: Battle): void {
  const u = b.units;
  const skelKind = KIND_OF_TROOP['bone-soldier'];
  const n = u.count;
  for (let i = 0; i < n; i++) {
    const skill = STATS[u.kind[i]].skill;
    if (skill === 'summonSkeleton') {
      const pool: number[] = [];
      for (let k = 0; k < SUMMON_POOL; k++) {
        const s = u.spawn(u.team[i], skelKind, u.x[i], u.y[i], b.rng);
        u.alive[s] = 0;
        u.deathT[s] = 1000;
        u.hp[s] = 0;
        u.owner[s] = i;
        pool.push(s);
      }
      b.pools.set(i, pool);
    } else if (skill === 'destinyBond') {
      const foes: number[] = [];
      for (let j = 0; j < n; j++) if (u.alive[j] && b.group[u.team[j]] !== b.group[u.team[i]] && STATS[u.kind[j]].skill !== 'destinyBond') foes.push(j);
      const pick: number[] = [];
      const want = Math.min(sp(b, 'destinyBond').count, foes.length);
      while (pick.length < want) {
        const f = foes[Math.floor(b.rng() * foes.length)];
        if (!pick.includes(f)) pick.push(f);
      }
      if (pick.length) b.links.set(i, pick);
    }
  }
}

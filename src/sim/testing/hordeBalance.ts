import { Battle, type BattleConfig } from '../battle';
import { randomSpec } from '../mapSpec';
import { mulberry32 } from '../random';
import { terrainFor } from '../battleConfig';
import { unitGold, buyable, mapSizeForPlayers, teamZones } from '../../net/economy';
import { KIND_COUNT, STATS, STRUCT_OF, isHealer } from '../units';

/** Headless Horde tooling: gold-equal human armies defend against the waves in the real deterministic simulation. */

export interface HordeScenario {
  config: BattleConfig;
  simSeed: number;
  humans: number;
  /** Kinds of each human army, in placement order. */
  armies: number[][];
}

/** Kinds a player can buy (the same filter as the placement list). */
export function buyableKinds(): number[] {
  const out: number[] = [];
  for (let k = 0; k < KIND_COUNT; k++) if (STRUCT_OF[k] === 0 && buyable(k)) out.push(k);
  return out;
}

/**
 * A typical gold-equal army: 3-5 kinds picked by the seed, at most a quarter of the budget on healers, the rest spent as
 * evenly as possible (the budget is spent down to the cost of the cheapest chosen kind).
 */
export function typicalArmy(seed: number, gold: number): number[] {
  const rng = mulberry32(seed * 104729 + 11);
  const pool = buyableKinds();
  const kinds: number[] = [];
  const want = 3 + Math.floor(rng() * 3);
  while (kinds.length < want) {
    const k = pool[Math.floor(rng() * pool.length)];
    if (!kinds.includes(k)) kinds.push(k);
  }
  if (kinds.every((k) => isHealer(k))) kinds[0] = pool[0];
  const army: number[] = [];
  let left = gold;
  const healerCap = gold * 0.25;
  let healerSpent = 0;
  for (let guard = 0; guard < 100000; guard++) {
    const k = kinds[guard % kinds.length];
    const c = unitGold(k);
    if (c > left) {
      if (kinds.every((q) => unitGold(q) > left)) break;
      continue;
    }
    if (isHealer(k) && healerSpent + c > healerCap) {
      if (kinds.every((q) => isHealer(q) || unitGold(q) > left)) break;
      continue;
    }
    army.push(k);
    left -= c;
    if (isHealer(k)) healerSpent += c;
  }
  return army;
}

/** Horde battle with `humans` allied teams, each with a typical army of `gold`, on a random map of the usual online size. */
export function hordeScenario(seed: number, humans: number, gold = 2000): HordeScenario {
  const size = mapSizeForPlayers(humans);
  const spec = randomSpec(mulberry32(seed * 7919 + 13));
  const base: BattleConfig = { mode: 'custom', perTeam: 0, teamCount: humans, mapSize: size, env: true, kite: true, terrainSeed: 1 + (seed % 50), map: spec, rules: 'horde' };
  const terrain = terrainFor(base);
  const zones = teamZones(size, humans, terrain);
  const armies: number[][] = [];
  const layout: number[] = [];
  for (let t = 0; t < humans; t++) {
    const army = typicalArmy(seed * 31 + t, gold);
    armies.push(army);
    const z = zones[t];
    const cols = Math.max(1, Math.ceil(Math.sqrt(army.length * 1.4)));
    for (let i = 0; i < army.length; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      let x = z.cx + (c - (cols - 1) / 2) * 1.2;
      let y = z.cy + (r - (army.length / cols - 1) / 2) * 1.2;
      const p = terrain ? terrain.nearestWalkable(x, y, 12, true) : { x, y };
      if (p) {
        x = p.x;
        y = p.y;
      }
      layout.push(t, army[i], x, y);
    }
  }
  return { config: { ...base, layout: new Float32Array(layout) }, simSeed: 1 + (seed % 997), humans, armies };
}

export interface HordeResult {
  /** Winner team index (humans: a human team, horde: the horde team index), -1: unfinished. */
  winner: number;
  /** Waves spawned. */
  waves: number;
  /** Sim seconds. */
  time: number;
  humanVictory: boolean;
}

/** Runs a horde scenario to its end (or `maxSeconds`). */
export function runHorde(sc: HordeScenario, maxSeconds = 960): HordeResult {
  const b = new Battle(sc.simSeed, sc.config);
  const dt = b.dt;
  const steps = Math.ceil(maxSeconds / dt);
  for (let s = 0; s < steps && b.winner === -1; s++) b.step(dt);
  const hud = b.modeHud();
  const waves = hud.kind === 'horde' ? hud.wave : 0;
  return { winner: b.winner, waves, time: b.time, humanVictory: b.winner >= 0 && b.winner < sc.humans };
}

/** Name of a unit kind for logs. */
export function kindName(k: number): string {
  return STATS[k].name;
}

import { teamZones } from '../../net/economy';
import type { HelperInit } from '../movePool';
import { Battle, type BattleConfig } from '../battle';
import { DEFAULT_MAP } from '../mapSpec';
import { Terrain } from '../terrain';
import { KIND_COUNT } from '../units';

export interface BenchResult {
  dt: number;
  helpers: number;
  units: number;
  size: number;
  teams: number;
  msPerStep: number;
  maxStepMs: number;
  phases: Record<string, number>;
  alive: number[];
  dbg: Record<string, number>;
  hash: number;
}

/** Builds a custom battle with `perTeam` soldiers per team, packed into the team zones (deterministic). */
export { runHelper } from '../moverWorker';

export function benchBattle(perTeam: number, teams: number, size: number, seed = 3): { battle: Battle; units: number } {
  const t = new Terrain(size, { seed, spec: DEFAULT_MAP, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
  const zones = teamZones(size, teams, t);
  const layout: number[] = [];
  const kinds = Math.min(KIND_COUNT, 12);
  for (let team = 0; team < teams; team++) {
    let n = 0;
    for (let step = 1.0; n < perTeam && step < 3; step += 0.15) {
      for (let y = 0.5; y < size && n < perTeam; y += step)
        for (let x = 0.5; x < size && n < perTeam; x += step) {
          if (zones[team].contains(x, y) && t.walkable(x, y) && t.reachable(x, y)) {
            layout.push(team, (n * 7) % kinds, x, y);
            n++;
          }
        }
    }
  }
  const config: BattleConfig = { mode: 'custom', perTeam: 0, teamCount: teams, mapSize: size, env: true, kite: true, terrainSeed: seed, map: DEFAULT_MAP, layout: new Float32Array(layout) };
  return { battle: new Battle(1, config), units: layout.length / 4 };
}

/** Runs `steps` simulation steps and reports the cost per step and per phase (Battle.prof). */
export function runBench(perTeam: number, teams: number, size: number, steps: number, dtOverride = 0, helpers = 0, post: ((init: HelperInit) => void) | null = null): BenchResult {
  const { battle, units } = benchBattle(perTeam, teams, size);
  if (helpers > 0 && post) battle.useThreads(helpers, post);
  const dt = dtOverride > 0 ? dtOverride : battle.dt;
  for (let i = 0; i < 20; i++) battle.step(dt); // warm-up (helper threads need a moment to start)
  if (helpers > 0) {
    const until = Date.now() + 10000;
    while (battle.helperThreads < helpers && Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      battle.step(dt);
    }
  }
  const prof = battle.prof as unknown as Record<string, number>;
  for (const k of Object.keys(prof)) prof[k] = 0;
  battle.phaseMs.fill(0);
  let max = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    const a = performance.now();
    battle.step(dt);
    max = Math.max(max, performance.now() - a);
  }
  const total = performance.now() - t0;
  const phases: Record<string, number> = {};
  ['move', 'pick', 'sepScan', 'sepApply', 'gridPhase'].forEach((k, i) => (phases[k] = Math.round((battle.phaseMs[i] / steps) * 100) / 100));
  for (const k of Object.keys(prof)) if (k !== 'steps') phases[k] = Math.round((prof[k] / steps) * 100) / 100;
  return { dt, helpers: battle.helperThreads, units, size, teams, msPerStep: Math.round((total / steps) * 100) / 100, maxStepMs: Math.round(max * 10) / 10, phases, alive: battle.alivePerTeam.slice(0, teams), dbg: { ...(battle.dbg as unknown as Record<string, number>) }, hash: battle.hash() };
}

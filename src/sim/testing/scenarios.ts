import type { BattleConfig } from '../battle';
import { randomSpec } from '../mapSpec';
import { mulberry32 } from '../random';
import { TROOPS } from '../data/troops';
import { DEFAULT_STATS, KIND_OF_TROOP, LEGACY_COUNT as KIND_COUNT, Kind, TUNABLE, type StatOverrides } from '../units';

export interface Scenario {
  id: number;
  desc: string;
  config: BattleConfig;
  simSeed: number;
}

type Archetype = 'mixed' | 'melee' | 'ranged' | 'priests' | 'tanks' | 'single' | 'swarm' | 'longbowmen' | 'healTank';
type Style = 'ring' | 'scatter' | 'clusters' | 'stack' | 'twoSides';

const MAPS = [40, 56, 80];

function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function kindsFor(rng: () => number, a: Archetype): number[] {
  const n = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const rep = (k: number, c: number) => Array.from({ length: c }, () => k);
  switch (a) {
    case 'melee':
      return [...rep(Kind.Warrior, n(3, 30)), ...rep(Kind.Shield, n(0, 3)), ...rep(Kind.Brute, n(0, 3))];
    case 'ranged':
      return [...rep(Kind.Archer, n(2, 20)), ...rep(Kind.Priest, n(0, 4))];
    case 'longbowmen':
      return rep(Kind.Archer, n(1, 25));
    case 'priests':
      return rep(Kind.Priest, n(1, 8));
    case 'tanks':
      return [...rep(Kind.Shield, n(1, 6)), ...rep(Kind.Brute, n(1, 6))];
    case 'single':
      return [rng() * KIND_COUNT | 0];
    case 'swarm':
      return rep(Kind.Warrior, n(40, 120));
    case 'healTank':
      return [...rep(Kind.Shield, n(1, 3)), ...rep(Kind.Priest, n(2, 6))];
    default:
      return [
        ...rep(Kind.Warrior, n(2, 18)),
        ...rep(Kind.Archer, n(0, 10)),
        ...rep(Kind.Priest, n(0, 5)),
        ...rep(Kind.Shield, n(0, 3)),
        ...rep(Kind.Brute, n(0, 3)),
      ];
  }
}

function placement(rng: () => number, style: Style, team: number, teams: number, size: number, count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const clamp = (v: number) => Math.min(size - 0.6, Math.max(0.6, v));
  const c = size / 2;
  if (style === 'scatter') {
    for (let i = 0; i < count; i++) out.push([clamp(1 + rng() * (size - 2)), clamp(1 + rng() * (size - 2))]);
  } else if (style === 'stack') {
    const x = 2 + rng() * (size - 4);
    const y = 2 + rng() * (size - 4);
    for (let i = 0; i < count; i++) out.push([clamp(x + (rng() - 0.5) * 0.3), clamp(y + (rng() - 0.5) * 0.3)]);
  } else if (style === 'clusters') {
    const k = 2 + Math.floor(rng() * 2);
    const centers = Array.from({ length: k }, () => [3 + rng() * (size - 6), 3 + rng() * (size - 6)]);
    for (let i = 0; i < count; i++) {
      const ctr = centers[i % k];
      out.push([clamp(ctr[0] + (rng() - 0.5) * 6), clamp(ctr[1] + (rng() - 0.5) * 6)]);
    }
  } else if (style === 'twoSides') {
    // Teams on the two banks of the river, side by side
    const a = (team % 2 === 0 ? -1 : 1) * 0.707;
    const bx = c + a * size * 0.3;
    const by = c - a * size * 0.3;
    for (let i = 0; i < count; i++) out.push([clamp(bx + (rng() - 0.5) * 8), clamp(by + (rng() - 0.5) * 8)]);
  } else {
    const ang = (3 * Math.PI) / 4 + (team * 2 * Math.PI) / teams;
    const r = size * 0.3;
    const bx = c + Math.cos(ang) * r;
    const by = c + Math.sin(ang) * r;
    for (let i = 0; i < count; i++) out.push([clamp(bx + (rng() - 0.5) * 7), clamp(by + (rng() - 0.5) * 7)]);
  }
  return out;
}

/** 0.5x-2.2x of the default (extreme values only rarely): so battles can finish in a reasonable time. */
function statOverrides(rng: () => number): StatOverrides | undefined {
  if (rng() > 0.3) return undefined;
  const out: StatOverrides = Array.from({ length: KIND_COUNT }, () => ({}));
  const edits = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < edits; i++) {
    const k = Math.floor(rng() * KIND_COUNT);
    const t = pick(rng, TUNABLE.filter((x) => !x.tankOnly || k >= Kind.Shield));
    const base = DEFAULT_STATS[k][t.key];
    const v = rng() < 0.08 ? (rng() < 0.5 ? t.min : t.max) : base * (0.5 + rng() * 1.7);
    out[k][t.key] = Math.min(t.max, Math.max(t.min, v));
  }
  return out;
}

/** Seeded random scenario: the same id always produces the same scenario. */
export function makeScenario(id: number): Scenario {
  const rng = mulberry32(id * 7919 + 13);
  const teams = pick(rng, [2, 2, 2, 3, 3, 4, 5, 6]);
  const size = pick(rng, MAPS);
  const style = pick<Style>(rng, ['ring', 'ring', 'scatter', 'clusters', 'stack', 'twoSides']);
  const env = rng() < 0.85;
  const kite = rng() < 0.85;
  const archetypes: Archetype[] = ['mixed', 'mixed', 'mixed', 'melee', 'ranged', 'longbowmen', 'priests', 'tanks', 'single', 'swarm', 'healTank'];

  const layout: number[] = [];
  const names: string[] = [];
  for (let t = 0; t < teams; t++) {
    const arch = pick(rng, archetypes);
    names.push(arch);
    const kinds = kindsFor(rng, arch);
    const pos = placement(rng, style, t, teams, size, kinds.length);
    kinds.forEach((k, i) => layout.push(t, k, pos[i][0], pos[i][1]));
  }
  return {
    id,
    desc: `#${id} ${teams} teams ${size}x${size} ${style} env=${env} kite=${kite} [${names.join(',')}]`,
    simSeed: 1 + Math.floor(rng() * 1000),
    config: {
      mode: 'custom',
      perTeam: 0,
      teamCount: teams,
      mapSize: size,
      env,
      // The map recipe comes from a separate generator: the old scenario sequence stays unchanged.
      map: id % 2 === 0 ? undefined : randomSpec(mulberry32(id * 7919 + 13)),
      kite,
      terrainSeed: 1 + Math.floor(rng() * 50),
      layout: new Float32Array(layout),
      stats: statOverrides(rng),
    },
  };
}

/**
 * Roster-unit scenario: keeps makeScenario's layout/map, replaces the kinds with 1-3 random
 * roster units per team and picks the level at random.
 */
export function makeRosterScenario(id: number): Scenario {
  const sc = makeScenario(id);
  const rng = mulberry32(id * 31 + 7);
  const rosterKinds = TROOPS.filter((t) => !t.summoned).map((t) => KIND_OF_TROOP[t.id]);
  const L = sc.config.layout!;
  const pools = new Map<number, number[]>();
  for (let k = 0; k + 3 < L.length; k += 4) {
    const team = L[k] | 0;
    let pool = pools.get(team);
    if (!pool) {
      pool = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => rosterKinds[Math.floor(rng() * rosterKinds.length)]);
      pools.set(team, pool);
    }
    L[k + 1] = pool[Math.floor(rng() * pool.length)];
  }
  return { ...sc, desc: `${sc.desc} ROSTER L${(sc.config.level = 1 + Math.floor(rng() * 10))}`, config: { ...sc.config, stats: undefined } };
}

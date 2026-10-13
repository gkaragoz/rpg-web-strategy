import { Battle, type BattleConfig } from '../battle';
import { DEFAULT_MAP, type MapSpec } from '../mapSpec';
import { TROOP_BY_ID } from '../data/troops';
import { unitGold } from '../../net/economy';
import { KIND_COUNT, Kind, STATS, isHealer } from '../units';

/** Headless balance tooling: gold-equal single-type armies fight in the real (deterministic) simulation. */

export interface Scenario {
  id: string;
  map: MapSpec;
  env: boolean;
  mapSize: number;
}

export const SCENARIOS: Record<string, Scenario> = {
  open: { id: 'open', map: DEFAULT_MAP, env: false, mapSize: 56 },
  hills: { id: 'hills', map: { ...DEFAULT_MAP, river: 'none', forest: 'sparse', relief: 'hills' }, env: true, mapSize: 56 },
  ridge: { id: 'ridge', map: { ...DEFAULT_MAP, river: 'none', forest: 'sparse', relief: 'ridge' }, env: true, mapSize: 56 },
  forest: { id: 'forest', map: { ...DEFAULT_MAP, river: 'none', forest: 'sparse' }, env: true, mapSize: 56 },
};

export interface Job {
  a: number;
  b: number;
  scenario: string;
  seed: number;
  gold: number;
  /** Maximum units per side (keeps fights fast). */
  cap: number;
}

export interface FightResult {
  /** 0 = a wins, 1 = b wins, -2 = draw, -1 = unfinished */
  winner: number;
  /** Seconds of simulated time. */
  time: number;
  nA: number;
  nB: number;
  /** Remaining health fraction of the winning side (0 for a draw). */
  left: number;
}

/** Kinds that can be placed (summoned-only units are excluded). */
export function playableKinds(): number[] {
  const out: number[] = [];
  for (let k = 0; k < KIND_COUNT; k++) {
    const tr = STATS[k].troop ? TROOP_BY_ID[STATS[k].troop!] : undefined;
    if (tr?.summoned) continue;
    out.push(k);
  }
  return out;
}

/** How many units of this kind a gold budget buys (at least 1, at most cap). */
export function armySize(kind: number, gold: number, cap: number): number {
  return Math.max(1, Math.min(cap, Math.floor(gold / Math.max(1, unitGold(kind)))));
}

/** Share of the budget a healer army spends on healers; the rest buys a Warrior line to protect them. */
export const HEALER_SHARE = 0.35;

/**
 * The units of an army bought with `gold` for this kind, front line first. Most kinds fight alone; healers deal
 * (almost) no damage, so they are tested as healers behind a Warrior line.
 */
export function armyOf(kind: number, gold: number, cap: number): number[] {
  if (!isHealer(kind)) return Array.from({ length: armySize(kind, gold, cap) }, () => kind);
  const nH = Math.max(1, Math.min(cap, Math.floor((gold * HEALER_SHARE) / Math.max(1, unitGold(kind)))));
  const nW = Math.max(1, Math.min(cap, Math.floor((gold * (1 - HEALER_SHARE)) / Math.max(1, unitGold(Kind.Warrior)))));
  return [...Array.from({ length: nW }, () => Kind.Warrior), ...Array.from({ length: nH }, () => kind)];
}

/** Rectangular block of units (front line first) whose front edge is at `frontX` (team 0 faces +x, team 1 faces -x). */
function block(team: number, kinds: number[], frontX: number, cy: number, out: number[]): void {
  const n = kinds.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n / 1.6)));
  const rows = Math.ceil(n / cols);
  const sp = 1.2;
  for (let i = 0; i < n; i++) {
    const kind = kinds[i];
    const c = Math.floor(i / rows);
    const r = i % rows;
    const x = team === 0 ? frontX - c * sp : frontX + c * sp;
    const y = cy + (r - (rows - 1) / 2) * sp;
    out.push(team, kind, x, y);
  }
}

export function makeConfig(job: Job, armyA: number[], armyB: number[]): BattleConfig {
  const sc = SCENARIOS[job.scenario];
  const layout: number[] = [];
  const mid = sc.mapSize / 2;
  const half = 5.5;
  block(0, armyA, mid - half, mid, layout);
  block(1, armyB, mid + half, mid, layout);
  return { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: sc.mapSize, env: sc.env, kite: true, terrainSeed: 3, map: sc.map, layout: new Float32Array(layout) };
}

const MAX_SECONDS = 200;

/** One fight: army a (team 0) against army b (team 1), both bought with the same gold. */
export function runFight(job: Job): FightResult {
  const armyA = armyOf(job.a, job.gold, job.cap);
  const armyB = armyOf(job.b, job.gold, job.cap);
  const nA = armyA.length;
  const nB = armyB.length;
  const bt = new Battle(job.seed, makeConfig(job, armyA, armyB));
  const steps = 30 * MAX_SECONDS;
  let s = 0;
  for (; s < steps && bt.winner === -1; s++) bt.step(1 / 30);
  const u = bt.units;
  const hp = [0, 0];
  const max = [0, 0];
  for (let i = 0; i < u.count; i++) {
    max[u.team[i]] += u.maxHp[i];
    if (u.alive[i]) hp[u.team[i]] += Math.max(0, u.hp[i]);
  }
  const w = bt.winner;
  const left = w === 0 || w === 1 ? hp[w] / Math.max(1, max[w]) : 0;
  return { winner: w, time: s / 30, nA, nB, left };
}

/** Score of side a: 1 win, 0.5 draw/unfinished, 0 loss. */
export function scoreOf(r: FightResult): number {
  return r.winner === 0 ? 1 : r.winner === 1 ? 0 : 0.5;
}

export interface Tournament {
  kinds: number[];
  /** matrix[i][j] = mean score of kinds[i] against kinds[j] (0..1), NaN on the diagonal */
  matrix: number[][];
  /** per kind aggregates */
  rows: Array<{ kind: number; name: string; rate: number; clearWins: number; clearLosses: number; left: number; draws: number; cost: number }>;
  fights: number;
  draws: number;
}

export interface Played {
  job: Job;
  res: FightResult;
}

/** Builds the full job list: every unordered pair, both sides, every scenario and seed. */
export function makeJobs(kinds: number[], scenarios: string[], seeds: number, gold: number, cap: number): Job[] {
  const jobs: Job[] = [];
  for (const scenario of scenarios) {
    for (let x = 0; x < kinds.length; x++) {
      for (let y = x + 1; y < kinds.length; y++) {
        for (let seed = 1; seed <= seeds; seed++) {
          jobs.push({ a: kinds[x], b: kinds[y], scenario, seed, gold, cap });
          jobs.push({ a: kinds[y], b: kinds[x], scenario, seed, gold, cap });
        }
      }
    }
  }
  return jobs;
}

/** Aggregates played fights into the matrix and per-unit rows. */
export function aggregate(kinds: number[], played: Played[], clearHi = 0.65, clearLo = 0.35): Tournament {
  const idx = new Map<number, number>();
  kinds.forEach((k, i) => idx.set(k, i));
  const n = kinds.length;
  const sum = Array.from({ length: n }, () => new Float64Array(n));
  const cnt = Array.from({ length: n }, () => new Float64Array(n));
  const leftSum = new Float64Array(n);
  const leftCnt = new Float64Array(n);
  let draws = 0;
  for (const { job, res } of played) {
    const i = idx.get(job.a)!;
    const j = idx.get(job.b)!;
    const sc = scoreOf(res);
    sum[i][j] += sc;
    cnt[i][j]++;
    sum[j][i] += 1 - sc;
    cnt[j][i]++;
    if (res.winner < 0) draws++;
    else {
      const w = res.winner === 0 ? i : j;
      leftSum[w] += res.left;
      leftCnt[w]++;
    }
  }
  const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j || cnt[i][j] === 0 ? NaN : sum[i][j] / cnt[i][j])));
  const rows = kinds.map((kind, i) => {
    let tot = 0;
    let c = 0;
    let cw = 0;
    let cl = 0;
    for (let j = 0; j < n; j++) {
      const v = matrix[i][j];
      if (Number.isNaN(v)) continue;
      tot += v;
      c++;
      if (v >= clearHi) cw++;
      if (v <= clearLo) cl++;
    }
    return { kind, name: STATS[kind].name, rate: c ? tot / c : 0.5, clearWins: cw, clearLosses: cl, left: leftCnt[i] ? leftSum[i] / leftCnt[i] : 0, draws: 0, cost: unitGold(kind) };
  });
  return { kinds, matrix, rows, fights: played.length, draws };
}

/** Text report: sorted win rates with clear wins/losses, plus the strongest and weakest matchups. */
export function report(t: Tournament): string {
  const rows = t.rows.slice().sort((p, q) => q.rate - p.rate);
  const lines: string[] = [];
  lines.push(`fights ${t.fights}  draws/unfinished ${t.draws} (${((100 * t.draws) / Math.max(1, t.fights)).toFixed(1)}%)`);
  lines.push('unit'.padEnd(20) + 'win%'.padStart(6) + '  wins losses  hp-left  gold');
  for (const r of rows) {
    lines.push(r.name.padEnd(20) + (r.rate * 100).toFixed(0).padStart(5) + '%' + String(r.clearWins).padStart(6) + String(r.clearLosses).padStart(7) + (r.left * 100).toFixed(0).padStart(7) + '%' + String(r.cost).padStart(6));
  }
  return lines.join('\n') + '\n';
}

/** Units outside the allowed win-rate band, or without clear wins/losses. */
export function problems(t: Tournament, lo = 0.35, hi = 0.65, minWins = 3, minLosses = 3): string[] {
  const out: string[] = [];
  for (const r of t.rows) {
    if (r.rate > hi) out.push(`${r.name}: too strong (${(r.rate * 100).toFixed(0)}%)`);
    if (r.rate < lo) out.push(`${r.name}: too weak (${(r.rate * 100).toFixed(0)}%)`);
    if (r.clearWins < minWins) out.push(`${r.name}: only ${r.clearWins} clear wins`);
    if (r.clearLosses < minLosses) out.push(`${r.name}: only ${r.clearLosses} clear losses`);
  }
  return out;
}

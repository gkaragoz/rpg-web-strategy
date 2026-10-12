import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { Battle, type BattleConfig } from '../battle';
import { DEFAULT_MAP } from '../mapSpec';
import { TROOPS } from '../data/troops';
import { KIND_OF_TROOP, STATS } from '../units';

// BALANCE=1 LEVEL=6 npx vitest run src/sim/__tests__/balance.test.ts
// Her roster birimi (n adet) her digeriyle (n adet) dovusur; test-results/balance.txt'ye kazanma oranlari yazilir.
const ON = process.env.BALANCE === '1';
const LEVEL = Number(process.env.LEVEL ?? 6);
const N = Number(process.env.N ?? 5);

function fight(a: number, b: number, seed: number): number {
  const layout: number[] = [];
  for (let i = 0; i < N; i++) {
    layout.push(0, a, 20 + (i % 3) * 1.2, 28 + Math.floor(i / 3) * 1.2);
    layout.push(1, b, 29 + (i % 3) * 1.2, 28 + Math.floor(i / 3) * 1.2);
  }
  const config: BattleConfig = { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: false, kite: true, map: DEFAULT_MAP, level: LEVEL, layout: new Float32Array(layout) };
  const bt = new Battle(seed, config);
  for (let s = 0; s < 30 * 200 && bt.winner === -1; s++) bt.step(1 / 30);
  return bt.winner; // 0, 1, -2 (berabere), -1 (bitmedi)
}

describe.skipIf(!ON)('denge turnuvasi', () => {
  it('round-robin', () => {
    const ids = TROOPS.filter((t) => !t.summoned).map((t) => KIND_OF_TROOP[t.id]);
    const wins = new Map<number, number>();
    const games = new Map<number, number>();
    const draws = new Map<number, number>();
    for (const k of ids) {
      wins.set(k, 0);
      games.set(k, 0);
      draws.set(k, 0);
    }
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        for (let seed = 1; seed <= 2; seed++) {
          const swap = seed === 2;
          const a = swap ? ids[y] : ids[x];
          const b = swap ? ids[x] : ids[y];
          const w = fight(a, b, seed);
          for (const k of [ids[x], ids[y]]) games.set(k, games.get(k)! + 1);
          if (w === 0) wins.set(a, wins.get(a)! + 1);
          else if (w === 1) wins.set(b, wins.get(b)! + 1);
          else {
            draws.set(a, draws.get(a)! + 0.5);
            draws.set(b, draws.get(b)! + 0.5);
          }
        }
      }
    }
    const rows = ids.map((k) => ({ name: STATS[k].name, rate: wins.get(k)! / games.get(k)!, draws: draws.get(k)! / games.get(k)!, hp: STATS[k].hp, pw: STATS[k].power }));
    rows.sort((p, q) => q.rate - p.rate);
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/balance.txt', rows.map((r) => `${r.name.padEnd(18)} win ${(r.rate * 100).toFixed(0).padStart(3)}%  draw ${(r.draws * 100).toFixed(0).padStart(3)}%  hp ${Math.round(r.hp)} pw ${Math.round(r.pw)}`).join('\n') + '\n');
  }, 600000);
});

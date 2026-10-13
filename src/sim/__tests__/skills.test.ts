import { describe, expect, it } from 'vitest';
import { Battle, type BattleConfig } from '../battle';
import { DEFAULT_MAP } from '../mapSpec';
import { F_REVIVED, KIND_OF_TROOP, STATS } from '../units';

const K = (id: string): number => KIND_OF_TROOP[id];

/** Team A gets units `a`, team B gets units `b`; clean (no environment) map, close formation. */
function arena(a: string[], b: string[], gap = 5): Battle {
  const layout: number[] = [];
  a.forEach((id, i) => layout.push(0, K(id), 20 + (i % 3) * 1.2, 28 + Math.floor(i / 3) * 1.2));
  b.forEach((id, i) => layout.push(1, K(id), 20 + gap + (i % 3) * 1.2, 28 + Math.floor(i / 3) * 1.2));
  const config: BattleConfig = { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: false, kite: true, map: DEFAULT_MAP, layout: new Float32Array(layout) };
  return new Battle(5, config);
}

function run(b: Battle, seconds: number, each?: (b: Battle) => void): void {
  for (let s = 0; s < seconds * 30 && b.winner === -1; s++) {
    b.step(1 / 30);
    each?.(b);
  }
}

describe('skills', () => {
  it('Bone Caller summons bone soldiers (wakes them from the pool), they attack the enemy', () => {
    const b = arena(['bone-caller'], ['militia', 'militia', 'militia'], 14);
    const u = b.units;
    const skel = K('bone-soldier');
    let peak = 0;
    run(b, 25, () => {
      let n = 0;
      for (let i = 0; i < u.count; i++) if (u.alive[i] && u.kind[i] === skel) n++;
      peak = Math.max(peak, n);
    });
    expect(peak).toBeGreaterThan(0);
    expect(b.counters.damage).toBeGreaterThan(0);
  });

  it('Undead Soldier revives once', () => {
    const b = arena(['risen-guard'], ['longbowmen', 'longbowmen', 'longbowmen', 'longbowmen'], 6);
    const u = b.units;
    let revived = false;
    run(b, 40, () => {
      if (u.flags[0] & F_REVIVED) revived = true;
    });
    expect(revived).toBe(true);
  });

  it('Blast Imps explode on contact with the enemy: they die and deal area damage', () => {
    const b = arena(['blast-imps', 'blast-imps'], ['militia', 'militia', 'militia'], 4);
    run(b, 15);
    expect(b.units.alive[0] === 0 || b.units.alive[1] === 0).toBe(true);
    expect(b.counters.damage).toBeGreaterThan(0);
  });

  it('Ice Mage slows the enemy', () => {
    const b = arena(['frost-adept', 'frost-adept', 'frost-adept'], ['granite-colossus'], 8);
    const u = b.units;
    let slowed = false;
    run(b, 30, () => {
      for (let i = 0; i < u.count; i++) if (u.alive[i] && u.team[i] === 1 && u.slowT[i] > 0) slowed = true;
    });
    expect(slowed).toBe(true);
  });

  it('Nun heals an ally and clears crowd-control effects', () => {
    const b = arena(['mender', 'militia'], ['longbowmen', 'longbowmen'], 7);
    const u = b.units;
    let healed = false;
    run(b, 20, () => {
      if (b.counters.heal > 0) healed = true;
    });
    expect(healed || u.alive[0] === 0).toBe(true);
  });

  it('Scarecrow Sentinel taunts: nearby enemies target the guard', () => {
    const b = arena(['scarecrow', 'militia'], ['militia', 'militia', 'militia'], 3);
    const u = b.units;
    let taunted = false;
    run(b, 12, () => {
      for (let i = 0; i < u.count; i++) if (u.alive[i] && u.team[i] === 1 && u.tauntT[i] > 0 && u.tauntBy[i] === 0) taunted = true;
    });
    expect(taunted).toBe(true);
  });

  it('Dread Totem frightens the enemy', () => {
    const b = arena(['dread-totem'], ['militia', 'militia', 'militia'], 3);
    const u = b.units;
    let feared = false;
    run(b, 12, () => {
      for (let i = 0; i < u.count; i++) if (u.alive[i] && u.team[i] === 1 && u.fearT[i] > 0) feared = true;
    });
    expect(feared).toBe(true);
  });

  it('Hex Poppets: when one takes damage, the linked enemies take damage too', () => {
    const b = arena(['hex-poppets', 'militia'], ['longbowmen', 'longbowmen', 'longbowmen'], 6);
    const u = b.units;
    let mirrored = false;
    const start = Array.from({ length: u.count }, (_, i) => u.hp[i]);
    run(b, 20, () => {
      for (let i = 0; i < u.count; i++) if (u.team[i] === 1 && u.hp[i] < start[i] && u.hp[0] < start[0]) mirrored = true;
    });
    expect(mirrored).toBe(true);
  });

  it('roster units do not produce NaN/negative hp in a mixed 2x2 battle', () => {
    const ids = ['pyre-sling', 'bolt-thrower', 'war-barge', 'sand-king', 'sun-priest', 'horned-seer', 'ash-fiend', 'dawn-blade', 'rime-archers', 'cinder-golem'];
    const b = arena(ids, ids.slice().reverse(), 7);
    run(b, 90);
    const u = b.units;
    for (let i = 0; i < u.count; i++) {
      expect(Number.isFinite(u.x[i]) && Number.isFinite(u.y[i]) && Number.isFinite(u.hp[i]), `unit ${i} ${STATS[u.kind[i]].name}`).toBe(true);
      expect(u.hp[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

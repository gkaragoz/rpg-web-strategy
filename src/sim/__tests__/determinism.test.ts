import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { makeScenario, makeRosterScenario } from '../testing/scenarios';
import { packSnapshot, unpackSnapshot } from '../snapshot';

function mk(id: number, roster: boolean, comedy: boolean): Battle {
  const sc = roster ? makeRosterScenario(id) : makeScenario(id);
  return new Battle(sc.simSeed, { ...sc.config, comedy });
}

describe('deterministik sim: kontrol toplami ve durum goruntusu', () => {
  for (const [id, roster, comedy] of [[3, false, false], [17, true, false], [42, false, true], [77, true, true]] as const) {
    it(`senaryo ${id} roster=${roster} komedi=${comedy}: iki kosu ayni hash dizisi`, () => {
      const a = mk(id, roster, comedy);
      const b = mk(id, roster, comedy);
      for (let s = 0; s < 600 && a.winner === -1; s++) {
        a.step(1 / 30);
        b.step(1 / 30);
        if (s % 10 === 0) expect(b.hash(), `adim ${s}`).toBe(a.hash());
      }
    });

    it(`senaryo ${id}: goruntu al -> baska Battle'a yukle -> ayni devam (paketlenmis dahil)`, () => {
      const a = mk(id, roster, comedy);
      for (let s = 0; s < 240 && a.winner === -1; s++) a.step(1 / 30);
      const snap = unpackSnapshot(packSnapshot(a.serialize()));
      const b = mk(id, roster, comedy);
      b.restore(snap);
      expect(b.hash()).toBe(a.hash());
      for (let s = 0; s < 400 && a.winner === -1; s++) {
        a.step(1 / 30);
        b.step(1 / 30);
        if (s % 10 === 0) expect(b.hash(), `devam adim ${s}`).toBe(a.hash());
      }
      expect(b.winner).toBe(a.winner);
      expect(b.counters.kills).toBe(a.counters.kills);
    });
  }

  it('farkli tohum farkli hash uretir', () => {
    const a = mk(3, false, false);
    const sc = makeScenario(3);
    const b = new Battle(sc.simSeed + 1, sc.config);
    for (let s = 0; s < 120; s++) {
      a.step(1 / 30);
      b.step(1 / 30);
    }
    expect(b.hash()).not.toBe(a.hash());
  });
});

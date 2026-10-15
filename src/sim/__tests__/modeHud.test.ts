import { describe, expect, it } from 'vitest';
import { hillZoneSpecs, pointsHeld, stripProgress, type HillStrip } from '../../app/modeHud';
import { SELECTABLE_MODES } from '../../app/modeIds';
import { allStrings } from '../../i18n';

const data = (owners: number[]): HillStrip => ({ kind: 'hill', scores: [10, 4], target: 100, timeLeft: 0, points: owners.map((owner, i) => ({ x: i, y: i, radius: 4, owner })) });

describe('objective strip helpers', () => {
  it('progress is clamped to 0..1 and safe for a missing target', () => {
    expect(stripProgress(50, 100)).toBe(0.5);
    expect(stripProgress(500, 100)).toBe(1);
    expect(stripProgress(-3, 100)).toBe(0);
    expect(stripProgress(5, 0)).toBe(0);
  });

  it('counts held points per team and ignores neutral / contested ones', () => {
    expect(pointsHeld(data([0, 0, 1]), 2)).toEqual([2, 1]);
    expect(pointsHeld(data([-1, -2, 1]), 3)).toEqual([0, 1, 0]);
    expect(pointsHeld(data([5]), 2)).toEqual([0, 0]);
  });
});

describe('hill zone overlay', () => {
  it('covers the tiles inside each point, coloured by the owner (neutral and contested grey), and stays on the map', () => {
    const specs = hillZoneSpecs([{ x: 10.5, y: 10.5, radius: 3, owner: 1 }, { x: 0.5, y: 0.5, radius: 3, owner: -2 }, { x: 30, y: 30, radius: 3, owner: -1 }], [0xff0000, 0x00ff00], 32);
    expect(specs[0].color).toBe(0x00ff00);
    expect(specs[1].color).toBe(specs[2].color);
    for (const s of specs) {
      expect(s.tiles.length).toBeGreaterThan(5);
      for (const [x, y] of s.tiles) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(32);
      }
    }
    expect(specs[0].tiles.some(([x, y]) => x === 10 && y === 10)).toBe(true);
    expect(specs[0].tiles.some(([x, y]) => x === 20 && y === 20)).toBe(false);
  });
});

describe('mode picker', () => {
  it('every selectable mode has a name and a rule in both languages', () => {
    const { en, tr } = allStrings();
    for (const id of SELECTABLE_MODES) {
      for (const table of [en, tr]) {
        expect(table[`mode.${id}.name`], id).toBeTruthy();
        expect(table[`mode.${id}.rule`], id).toBeTruthy();
      }
    }
  });
});

describe('vip markers', () => {
  it('shows only living VIPs at interpolated positions in the team colour', async () => {
    const { vipMarkers } = await import('../../app/modeHud');
    const units = { px: [0, 10, 20], py: [0, 10, 20], x: [2, 12, 22], y: [4, 14, 24], alive: [1, 1, 0] };
    const hud = { kind: 'vip' as const, timeLeft: 0, teams: [{ unit: 0, hp: 1, alive: true }, { unit: 1, hp: 0, alive: false }, { unit: 2, hp: 0.5, alive: true }, { unit: -1, hp: 0, alive: false }] };
    const m = vipMarkers(hud, units, 0.5, [0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);
    expect(m).toEqual([{ x: 1, y: 2, color: 0xff0000, kind: 'vip' }]);
  });
});

describe('ctf strip helpers', () => {
  it('reports who carries a flag and whose flag is stolen, and places flag markers at home or over the carrier', async () => {
    const { ctfMarkers, ctfStatus } = await import('../../app/modeHud');
    const hud = {
      kind: 'ctf' as const,
      captures: [0, 1],
      target: 3,
      radius: 3,
      timeLeft: 0,
      flags: [
        { team: 0, x: 5, y: 5, carrier: 1, carrierTeam: 1 },
        { team: 1, x: 50, y: 50, carrier: -1, carrierTeam: -1 },
      ],
    };
    expect(ctfStatus(hud, 2)).toEqual({ carrying: [false, true], stolen: [true, false] });
    const units = { px: [0, 10], py: [0, 10], x: [0, 14], y: [0, 18], alive: [1, 1] };
    const m = ctfMarkers(hud, units, 0.5, [0xff0000, 0x0000ff]);
    expect(m).toEqual([
      { x: 12, y: 14, color: 0xff0000, kind: 'flag' },
      { x: 50, y: 50, color: 0x0000ff, kind: 'flag' },
    ]);
    // A dead carrier (the flag is about to go home) falls back to the base position.
    expect(ctfMarkers(hud, { ...units, alive: [1, 0] }, 0.5, [1, 2])[0]).toMatchObject({ x: 5, y: 5 });
  });
});

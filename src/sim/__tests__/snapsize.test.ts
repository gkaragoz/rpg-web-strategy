import { describe, expect, it } from 'vitest';
import { Reassembler, splitMsg } from '../../net/chunk';
import { b64decode, b64encode, type Msg } from '../../net/protocol';
import { Battle } from '../battle';
import { packSnapshot, unpackSnapshot } from '../snapshot';

describe('buyuk savas yeniden senkron boyutu', () => {
  it('9000 birimlik goruntu parcalanir, birlesir ve ayni duruma geri yuklenir', () => {
    const layout: number[] = [];
    for (let t = 0; t < 6; t++) for (let i = 0; i < 1500; i++) layout.push(t, i % 5, 5 + (i % 40) * 1.2 + t * 0.1, 5 + Math.floor(i / 40) * 1.2 + t * 0.2);
    const cfg = { mode: 'custom' as const, perTeam: 0, teamCount: 6, mapSize: 120, env: true, kite: true, terrainSeed: 9, level: 5, layout: new Float32Array(layout) };
    const a = new Battle(7, cfg);
    for (let i = 0; i < 20; i++) a.step(1 / 30);
    const data = b64encode(packSnapshot(a.serialize()));
    const msg = { t: 'resync', step: a.stepCount, data } as unknown as Msg;
    const parts = splitMsg(msg, 1);
    console.log(`birim=${a.units.count} b64=${(data.length / 1024).toFixed(0)}KB parca=${parts.length}`);
    const r = new Reassembler();
    let out: Msg | null = null;
    for (const p of parts) out = r.push(JSON.parse(JSON.stringify(p)) as Msg) ?? out;
    expect((out as unknown as { data: string }).data).toBe(data);
    const b = new Battle(7, cfg);
    b.restore(unpackSnapshot(b64decode(data)));
    expect(b.hash()).toBe(a.hash());
  });
});

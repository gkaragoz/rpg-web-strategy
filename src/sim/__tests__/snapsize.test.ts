import { describe, expect, it } from 'vitest';
import { Reassembler, splitMsg } from '../../net/chunk';
import { b64decode, b64encode, type Msg } from '../../net/protocol';
import { Battle } from '../battle';
import { packSnapshot, unpackSnapshot, unwire, wireGzip, wireRaw } from '../snapshot';

describe('large battle resync size', () => {
  it('a 9000-unit snapshot is split, reassembled and restored to the same state', () => {
    const layout: number[] = [];
    for (let t = 0; t < 6; t++) for (let i = 0; i < 1500; i++) layout.push(t, i % 5, 5 + (i % 40) * 1.2 + t * 0.1, 5 + Math.floor(i / 40) * 1.2 + t * 0.2);
    const cfg = { mode: 'custom' as const, perTeam: 0, teamCount: 6, mapSize: 120, env: true, kite: true, terrainSeed: 9, layout: new Float32Array(layout) };
    const a = new Battle(7, cfg);
    for (let i = 0; i < 20; i++) a.step(1 / 30);
    const data = b64encode(packSnapshot(a.serialize()));
    const msg = { t: 'resync', step: a.stepCount, data } as unknown as Msg;
    const parts = splitMsg(msg, 1);
    console.log(`units=${a.units.count} b64=${(data.length / 1024).toFixed(0)}KB parts=${parts.length}`);
    const r = new Reassembler();
    let out: Msg | null = null;
    for (const p of parts) out = r.push(JSON.parse(JSON.stringify(p)) as Msg) ?? out;
    expect((out as unknown as { data: string }).data).toBe(data);
    const b = new Battle(7, cfg);
    b.restore(unpackSnapshot(b64decode(data)));
    expect(b.hash()).toBe(a.hash());
  });

  it('the gzip wire form restores the same state and is much smaller than the raw one', async () => {
    const layout: number[] = [];
    for (let t = 0; t < 2; t++) for (let i = 0; i < 3000; i++) layout.push(t, i % 5, 5 + (i % 60) * 1.1 + t * 0.1, 5 + Math.floor(i / 60) * 1.1 + t * 0.2);
    const cfg = { mode: 'custom' as const, perTeam: 0, teamCount: 2, mapSize: 120, env: true, kite: true, terrainSeed: 9, layout: new Float32Array(layout) };
    const a = new Battle(7, cfg);
    for (let i = 0; i < 20; i++) a.step(1 / 30);
    const packed = packSnapshot(a.serialize());
    const gz = await wireGzip(packed);
    const raw = wireRaw(packed);
    console.log(`raw=${(raw.length / 1024).toFixed(0)}KB gzip=${(gz.length / 1024).toFixed(0)}KB`);
    expect(gz.length).toBeLessThan(raw.length / 3);
    const b = new Battle(7, cfg);
    b.restore(unpackSnapshot(await unwire(gz)));
    expect(b.hash()).toBe(a.hash());
    const c = new Battle(7, cfg);
    c.restore(unpackSnapshot(await unwire(raw)));
    expect(c.hash()).toBe(a.hash());
  });
});

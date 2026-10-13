import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, Reassembler, splitMsg } from '../../net/chunk';
import type { Msg } from '../../net/protocol';

const big = (n: number): Msg => ({ t: 'resync', step: 7, data: 'x'.repeat(n) }) as unknown as Msg;

describe('message chunking', () => {
  it('a small message is not split', () => {
    const m = big(100);
    const parts = splitMsg(m, 1);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(m);
    expect(new Reassembler().push(m)).toBe(m);
  });

  it('a 3 MB message is split, every piece is under the limit, and it reassembles identically', () => {
    const m = big(3_000_000);
    const parts = splitMsg(m, 5);
    expect(parts.length).toBeGreaterThan(10);
    for (const p of parts) expect(JSON.stringify({ to: '*', msg: p }).length).toBeLessThan(CHUNK_CHARS + 200);
    const r = new Reassembler();
    let out: Msg | null = null;
    for (const p of parts) out = r.push(JSON.parse(JSON.stringify(p)) as Msg) ?? out;
    expect(out).toEqual(m);
  });

  it('reassembles even when pieces arrive out of order; a repeated piece is ignored', () => {
    const m = big(1_000_000);
    const parts = splitMsg(m, 2, 100_000);
    const shuffled = parts.slice().reverse();
    const r = new Reassembler();
    let out: Msg | null = null;
    for (const p of shuffled) {
      r.push(p);
      expect(r.push(p)).toBeNull(); // duplicate: not counted
    }
    // if the last piece is sent once more it returns null; the completed message was produced in the loop above
    const r2 = new Reassembler();
    for (const p of shuffled) out = r2.push(p) ?? out;
    expect(out).toEqual(m);
  });

  it('a missing piece does not reassemble; a malformed piece is rejected; several interleaved messages do not mix', () => {
    const a = big(500_000);
    const b = { t: 'resync', step: 9, data: 'y'.repeat(500_000) } as unknown as Msg;
    const pa = splitMsg(a, 1, 100_000);
    const pb = splitMsg(b, 2, 100_000);
    const r = new Reassembler();
    const outs: Msg[] = [];
    for (let i = 0; i < pa.length; i++) {
      for (const p of [pa[i], pb[i]]) {
        const o = r.push(p);
        if (o) outs.push(o);
      }
    }
    expect(outs).toEqual([a, b]);
    const r3 = new Reassembler();
    for (const p of pa.slice(0, -1)) expect(r3.push(p)).toBeNull();
    expect(r3.push({ c: { id: 1, i: 99, n: 2, d: 'z' } } as unknown as Msg)).toBeNull();
    expect(r3.push({ c: { id: 'x' } } as unknown as Msg)).toBeNull();
  });
});

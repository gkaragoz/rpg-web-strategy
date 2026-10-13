import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { Battle } from '../battle';

/** Crowd readability metrics: per-step direction reversal rate and overlap rate. */
export function crowdMetrics(perTeam: number, seconds: number): { reversal: number; overlap: number; deaths: number } {
  const b = new Battle(3, { mode: 'bench', perTeam, env: false, kite: true });
  const u = b.units;
  const n = u.count;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const dx0 = new Float32Array(n);
  const dy0 = new Float32Array(n);
  let rev = 0;
  let moved = 0;
  let overlapSum = 0;
  let samples = 0;
  for (let s = 0; s < seconds * 30; s++) {
    for (let i = 0; i < n; i++) {
      px[i] = u.x[i];
      py[i] = u.y[i];
    }
    b.step(1 / 30);
    if (s < 6 * 30) continue;
    for (let i = 0; i < n; i++) {
      if (!u.alive[i]) continue;
      const dx = u.x[i] - px[i];
      const dy = u.y[i] - py[i];
      const d = Math.hypot(dx, dy);
      if (d > 0.03) {
        moved++;
        const d0 = Math.hypot(dx0[i], dy0[i]);
        if (d0 > 0.03 && (dx * dx0[i] + dy * dy0[i]) / (d * d0) < -0.3) rev++;
      }
      dx0[i] = dx;
      dy0[i] = dy;
    }
    if (s % 15 === 0) {
      // Overlap: fraction of units with a neighbor closer than 0.45 tile (coarse grid).
      const cell = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        if (!u.alive[i]) continue;
        const k = Math.floor(u.x[i] / 0.5) * 100003 + Math.floor(u.y[i] / 0.5);
        const a = cell.get(k);
        if (a) a.push(i);
        else cell.set(k, [i]);
      }
      let close = 0;
      let alive = 0;
      for (let i = 0; i < n; i++) {
        if (!u.alive[i]) continue;
        alive++;
        const cx = Math.floor(u.x[i] / 0.5);
        const cy = Math.floor(u.y[i] / 0.5);
        let found = false;
        for (let a = -1; a <= 1 && !found; a++) {
          for (let c = -1; c <= 1 && !found; c++) {
            const l = cell.get((cx + a) * 100003 + (cy + c));
            if (!l) continue;
            for (const j of l) if (j !== i && Math.hypot(u.x[i] - u.x[j], u.y[i] - u.y[j]) < 0.45) found = true;
          }
        }
        if (found) close++;
      }
      overlapSum += close / Math.max(1, alive);
      samples++;
    }
  }
  return { reversal: rev / Math.max(1, moved), overlap: overlapSum / Math.max(1, samples), deaths: b.counters.kills };
}

describe.skipIf(process.env.CROWD !== '1')('crowd metrics', () => {
  it('reports', () => {
    const r = crowdMetrics(Number(process.env.PER ?? 800), 26);
    require('node:fs').writeFileSync('test-results/crowd.txt', JSON.stringify(r));
    expect(r.reversal).toBeLessThan(1);
  }, 300000);
});

describe('jitter limits in a crowd', () => {
  it('direction reversal and overlap thresholds', () => {
    const r = crowdMetrics(500, 22);
    expect(r.reversal).toBeLessThan(0.15);
    expect(r.overlap).toBeLessThan(0.3);
  }, 120000);
});

import { describe, expect, it } from 'vitest';
import { MinimapQueue, minimapKey } from '../../app/minimap';
import { DEFAULT_MAP } from '../mapSpec';

describe('minimap cache key and queue', () => {
  it('the key changes with the recipe, the seed and the size (clamped to 32..72)', () => {
    const a = minimapKey(DEFAULT_MAP, 1, 56);
    expect(minimapKey({ ...DEFAULT_MAP }, 1, 56)).toBe(a);
    expect(minimapKey(DEFAULT_MAP, 2, 56)).not.toBe(a);
    expect(minimapKey({ ...DEFAULT_MAP, relief: 'peak' }, 1, 56)).not.toBe(a);
    expect(minimapKey(DEFAULT_MAP, 1, 80)).toBe(minimapKey(DEFAULT_MAP, 1, 120));
    expect(minimapKey(DEFAULT_MAP, 1, 10)).toBe(minimapKey(DEFAULT_MAP, 1, 32));
  });

  it('runs one job per step, visible (urgent or bumped) jobs first, and keeps one job per id', () => {
    const q = new MinimapQueue();
    const order: string[] = [];
    q.add('a', () => order.push('a'));
    q.add('b', () => order.push('b'));
    q.add('c', () => order.push('c'));
    q.add('a', () => order.push('a2')); // replaces the pending job
    q.bump('c');
    q.add('u', () => order.push('u'), true);
    expect(q.size).toBe(4);
    while (q.step()) {
      /* drain */
    }
    expect(order).toEqual(['u', 'c', 'b', 'a2']);
    expect(q.step()).toBe(false);
  });
});

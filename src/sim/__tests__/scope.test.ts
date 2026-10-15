import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scope } from '../../app/scope';

describe('Scope', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('removes listeners on dispose and early removal works', () => {
    const t = new EventTarget();
    const s = new Scope();
    const a = vi.fn();
    const b = vi.fn();
    const off = s.on(t, 'keydown', a);
    s.on(t, 'keydown', b);
    t.dispatchEvent(new Event('keydown'));
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    off();
    t.dispatchEvent(new Event('keydown'));
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 2]);
    s.dispose();
    t.dispatchEvent(new Event('keydown'));
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('stops intervals and cancels pending timeouts, forgets fired ones', () => {
    const s = new Scope();
    const tick = vi.fn();
    const late = vi.fn();
    const fired = vi.fn();
    s.interval(tick, 10);
    s.timeout(late, 100);
    s.timeout(fired, 5);
    vi.advanceTimersByTime(25);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(fired).toHaveBeenCalledTimes(1);
    s.dispose();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(late).not.toHaveBeenCalled();
  });

  it('runs cleanups newest first, survives a throwing cleanup, and is idempotent', () => {
    const s = new Scope();
    const order: number[] = [];
    s.add(() => order.push(1));
    s.add(() => {
      throw new Error('boom');
    });
    s.add(() => order.push(3));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    s.dispose();
    s.dispose();
    err.mockRestore();
    expect(order).toEqual([3, 1]);
    expect(s.disposed).toBe(true);
  });

  it('after dispose, new registrations are undone immediately', () => {
    const t = new EventTarget();
    const s = new Scope();
    s.dispose();
    const fn = vi.fn();
    s.add(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    const click = vi.fn();
    s.on(t, 'click', click);
    t.dispatchEvent(new Event('click'));
    expect(click).not.toHaveBeenCalled();
  });
});

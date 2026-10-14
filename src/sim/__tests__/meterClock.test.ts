import { describe, expect, it } from 'vitest';
import { latchEndTime } from '../../app/dpsMeter';

describe('damage meter clock', () => {
  it('follows the battle while it runs', () => {
    expect(latchEndTime(-1, -1, 12.5)).toBe(-1);
  });

  it('latches the time of the first update after the winner is known and keeps it', () => {
    const end = latchEndTime(-1, 0, 21);
    expect(end).toBe(21);
    expect(latchEndTime(end, 0, 56)).toBe(21);
    expect(latchEndTime(end, -2, 90)).toBe(21);
  });

  it('is released again when a new battle starts', () => {
    expect(latchEndTime(21, -1, 0.2)).toBe(-1);
  });
});

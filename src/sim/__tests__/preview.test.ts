import { describe, expect, it } from 'vitest';
import { ATTACK_SHARE, frameAt, overlayFor, type PreviewInfo } from '../../app/previewOverlay';
import { TROOPS } from '../data/troops';

const base: PreviewInfo = { ranged: false, magical: false, healer: false, tank: false, shape: 'single', aoe: 0, skill: null, race: null };

describe('attack preview overlay', () => {
  it('picks an effect that matches how the unit attacks', () => {
    expect(overlayFor(base).kind).toBe('slash');
    expect(overlayFor({ ...base, shape: 'rect' }).kind).toBe('wide-slash');
    expect(overlayFor({ ...base, shape: 'round', aoe: 3 }).kind).toBe('ring');
    expect(overlayFor({ ...base, tank: true }).kind).toBe('shock');
    expect(overlayFor({ ...base, skill: 'bash' }).kind).toBe('shock');
    expect(overlayFor({ ...base, ranged: true }).kind).toBe('arrow');
    expect(overlayFor({ ...base, ranged: true, shape: 'pierce' }).kind).toBe('bolt');
    expect(overlayFor({ ...base, ranged: true, skill: 'axes' }).kind).toBe('axe');
    expect(overlayFor({ ...base, ranged: true, magical: true }).kind).toBe('orb');
    expect(overlayFor({ ...base, healer: true }).color).toBe('#7dffa8');
    expect(overlayFor({ ...base, ranged: true, magical: true, skill: 'frostBlast' }).color).toBe('#9ae0ff');
  });

  it('every roster unit gets an overlay', () => {
    for (const t of TROOPS) {
      const o = overlayFor({ ranged: t.ranged, magical: t.magical, healer: t.skill === 'cleanse', tank: false, shape: t.shape, aoe: t.aoe, skill: t.skill, race: t.race });
      expect(o.kind, t.id).toBeTruthy();
      expect(o.color, t.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('the loop plays the attack frames first, then rests on the idle frame', () => {
    const n = 8;
    expect(frameAt(0, n)).toEqual({ frame: 0, swing: 0 });
    const mid = frameAt(ATTACK_SHARE / 2, n);
    expect(mid.frame).toBe(4);
    expect(mid.swing).toBeCloseTo(0.5);
    expect(frameAt(ATTACK_SHARE - 0.001, n).frame).toBe(n - 1);
    expect(frameAt(ATTACK_SHARE + 0.1, n)).toEqual({ frame: n, swing: -1 });
    expect(frameAt(1.0, n).frame).toBe(0); // wraps
    expect(frameAt(-0.25, n).frame).toBe(n); // negative offsets wrap too
  });
});

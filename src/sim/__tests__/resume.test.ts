import { describe, expect, it } from 'vitest';
import { NAV_DEPTH, Nav, navStateFor, readNavState, screenOfState, type HistoryLike, type NavScreen, type NavVerdict } from '../../app/nav';
import { RESUME_MAX_AGE_MS, decodeResume, encodeResume, resumeAction, resumeScreenFor } from '../../app/resume';

describe('resume record', () => {
  const now = 1_000_000;
  it('round-trips a fresh record', () => {
    expect(decodeResume(encodeResume('studio', now), now + 500)).toEqual({ screen: 'studio', at: now });
    expect(decodeResume(encodeResume('online', now), now)?.screen).toBe('online');
  });
  it('ignores missing, malformed and unknown data', () => {
    for (const raw of [null, undefined, '', '{', 'null', '42', '"studio"', '{}', '{"screen":"battle","at":1000000}', '{"screen":"studio"}', '{"screen":"studio","at":"x"}']) {
      expect(decodeResume(raw, now)).toBeNull();
    }
  });
  it('expires stale records and rejects future-dated ones', () => {
    expect(decodeResume(encodeResume('studio', now), now + RESUME_MAX_AGE_MS)).not.toBeNull();
    expect(decodeResume(encodeResume('studio', now), now + RESUME_MAX_AGE_MS + 1)).toBeNull();
    expect(decodeResume(encodeResume('studio', now + 60_000), now)).toBeNull();
  });
  it('maps records to boot actions (battles are never resumed)', () => {
    expect(resumeAction(null, true)).toBe('home');
    expect(resumeAction({ screen: 'studio', at: 0 }, false)).toBe('studio');
    expect(resumeAction({ screen: 'online', at: 0 }, true)).toBe('rejoin');
    expect(resumeAction({ screen: 'online', at: 0 }, false)).toBe('home');
  });
  it('picks the record to store from what is on screen', () => {
    expect(resumeScreenFor({ inOnlineSession: true, inStudioOrSoloBattle: false })).toBe('online');
    expect(resumeScreenFor({ inOnlineSession: false, inStudioOrSoloBattle: true })).toBe('studio');
    expect(resumeScreenFor({ inOnlineSession: false, inStudioOrSoloBattle: false })).toBeNull();
  });
});

/** Minimal session history: entries with states, an index, and a synchronous popstate callback on go(). */
class FakeHistory implements HistoryLike {
  entries: unknown[] = [null];
  idx = 0;
  onPop: (state: unknown) => void = () => {};
  get state(): unknown {
    return this.entries[this.idx];
  }
  pushState(data: unknown): void {
    this.entries.splice(this.idx + 1);
    this.entries.push(data);
    this.idx++;
  }
  replaceState(data: unknown): void {
    this.entries[this.idx] = data;
  }
  go(delta: number): void {
    const n = this.idx + delta;
    if (n < 0 || n >= this.entries.length) return;
    this.idx = n;
    this.onPop(this.state);
  }
}

function setup(verdict: (t: NavScreen, f: NavScreen) => NavVerdict = () => 'ok') {
  const h = new FakeHistory();
  const moves: string[] = [];
  const nav = new Nav(h, (t, f) => {
    moves.push(`${f}>${t}`);
    return verdict(t, f);
  });
  // Wire the fake popstate to the controller (the browser would dispatch an event).
  h.onPop = (s) => void (nav as unknown as { onPop(s: unknown): Promise<void> }).onPop(s);
  return { h, nav, moves };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('nav state', () => {
  it('reads only its own markers', () => {
    expect(readNavState(null)).toBeNull();
    expect(readNavState({ rw: 2, k: 'home' })).toBeNull();
    expect(readNavState({ rw: 1, k: 'nope' })).toBeNull();
    expect(readNavState(navStateFor('battle'))).toEqual({ rw: 1, k: 'battle' });
    expect(screenOfState('x')).toBe('home');
    expect(NAV_DEPTH.battle).toBeGreaterThan(NAV_DEPTH.studio);
  });
});

describe('nav history', () => {
  it('Home -> studio -> battle pushes one entry per level, Back walks down', async () => {
    const { h, nav, moves } = setup();
    nav.boot('home');
    nav.go('studio');
    nav.go('battle');
    expect(h.entries.length).toBe(3);
    h.go(-1); // user Back from the battle
    await tick();
    expect(nav.cur).toBe('studio');
    h.go(-1);
    await tick();
    expect(nav.cur).toBe('home');
    expect(moves).toEqual(['battle>studio', 'studio>home']);
    expect(h.idx).toBe(0);
  });

  it('a screen change made by the app (Edit button) walks the history back without a user move', async () => {
    const { h, nav, moves } = setup();
    nav.boot('home');
    nav.go('studio');
    nav.go('battle');
    nav.go('studio'); // Edit / Esc
    await tick();
    expect(h.idx).toBe(1);
    expect(moves).toEqual([]);
    expect(nav.cur).toBe('studio');
  });

  it('equal depth replaces the entry; lobby -> placement -> battle is one entry', () => {
    const { h, nav } = setup();
    nav.boot('home');
    nav.go('online');
    nav.go('online');
    expect(h.entries.length).toBe(2);
    nav.go('studio');
    expect(h.entries.length).toBe(2);
    expect(readNavState(h.state)?.k).toBe('studio');
  });

  it('a refused Back walks Forward to the room entry again (no new entry); accepted Back leaves it', async () => {
    let accept = false;
    const { h, nav, moves } = setup(() => (accept ? 'ok' : 'stay'));
    nav.boot('home');
    nav.go('online');
    h.go(-1);
    await tick();
    expect(nav.cur).toBe('online');
    expect(readNavState(h.state)?.k).toBe('online');
    expect(h.idx).toBe(1);
    expect(h.entries.length).toBe(2); // restored by go(+1): a pushState without a user gesture would be skipped by the next Back on Chrome
    accept = true;
    h.go(-1);
    await tick();
    expect(nav.cur).toBe('home');
    expect(moves.length).toBe(2);
  });

  it('boot reuses a matching entry (reload) and pushes for a resumed deeper screen', () => {
    const a = setup();
    a.h.entries = [navStateFor('home'), navStateFor('studio')];
    a.h.idx = 1;
    a.nav.boot('studio');
    expect(a.h.entries.length).toBe(2);
    const b = setup();
    b.nav.boot('studio'); // fresh tab resumed into the studio
    expect(b.h.entries.length).toBe(2);
    expect(readNavState(b.h.entries[0])).toBeNull();
    const c = setup();
    c.nav.boot('home');
    expect(c.h.entries.length).toBe(1);
  });

  it('going Home while nothing earlier exists does not trap (no dummy entry)', () => {
    const { h, nav } = setup();
    nav.boot('home');
    expect(h.entries.length).toBe(1);
    nav.go('home');
    expect(h.entries.length).toBe(1);
  });
});

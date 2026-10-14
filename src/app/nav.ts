/**
 * App-style browser history: Back/Forward move between the app's screens instead of leaving the page.
 *
 * Screens and their history depth: home 0, studio 1, online (lobby / placement / battle) 1, solo battle 2. Entering a deeper
 * screen pushes one entry, switching between screens of equal depth replaces the entry, going shallower walks back (`history.go`).
 * Home is the base entry and is never trapped: Back from Home leaves the app like in any website.
 */

export type NavScreen = 'home' | 'studio' | 'online' | 'battle';

export const NAV_DEPTH: Record<NavScreen, number> = { home: 0, studio: 1, online: 1, battle: 2 };

export interface NavState {
  rw: 1;
  k: NavScreen;
}

export function navStateFor(k: NavScreen): NavState {
  return { rw: 1, k };
}

/** Reads a history state written by this module; null for anything else (foreign states, hash entries, null). */
export function readNavState(raw: unknown): NavState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { rw?: unknown; k?: unknown };
  if (r.rw !== 1) return null;
  return r.k === 'home' || r.k === 'studio' || r.k === 'online' || r.k === 'battle' ? { rw: 1, k: r.k } : null;
}

/** The screen a history entry stands for (an entry without our marker is the home page). */
export function screenOfState(raw: unknown): NavScreen {
  return readNavState(raw)?.k ?? 'home';
}

/**
 * Answer of the app to a Back/Forward move: 'ok' (the app moved to the target screen), 'stay' (refused, e.g. the leave
 * confirmation was cancelled: the entry is pushed again) or 'revert' (the target cannot be shown, go back to where we were).
 */
export type NavVerdict = 'ok' | 'stay' | 'revert';

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
  go(delta: number): void;
}

export class Nav {
  /** The screen the app shows now (what the current history entry should stand for). */
  cur: NavScreen = 'home';
  private ignore = 0;
  private ignoreTimer: ReturnType<typeof setTimeout> | undefined;

  /** `onMove(target, from)` is called for user-initiated Back/Forward; `nav.cur` already equals `target` while it runs. */
  constructor(
    private readonly hist: HistoryLike,
    private readonly onMove: (target: NavScreen, from: NavScreen) => NavVerdict | Promise<NavVerdict>,
  ) {}

  /** Registers the popstate listener. */
  start(target: EventTarget): void {
    target.addEventListener('popstate', (e) => void this.onPop((e as PopStateEvent).state));
  }

  /**
   * Boot: the app shows `screen` now. Reuses the current entry when its depth already fits (reload / resume), otherwise
   * pushes one for a deeper screen. Never leaves two entries for one screen except after a reload of a deeper entry.
   */
  boot(screen: NavScreen): void {
    const have = readNavState(this.hist.state);
    this.cur = screen;
    if (have && NAV_DEPTH[have.k] >= NAV_DEPTH[screen]) this.hist.replaceState(navStateFor(screen), '');
    else if (NAV_DEPTH[screen] > 0) this.hist.pushState(navStateFor(screen), '');
    else this.hist.replaceState(navStateFor(screen), '');
  }

  /** The app changed screen by itself (button, battle end, session change): bring the history in line. */
  go(screen: NavScreen): void {
    if (screen === this.cur) return;
    const from = NAV_DEPTH[this.cur];
    const to = NAV_DEPTH[screen];
    this.cur = screen;
    if (to > from) this.hist.pushState(navStateFor(screen), '');
    else if (to === from) this.hist.replaceState(navStateFor(screen), '');
    else this.walk(from - to);
  }

  /** Programmatic walk back by `n` entries; the popstate it causes is not a user move. */
  private walk(n: number): void {
    this.ignore++;
    clearTimeout(this.ignoreTimer);
    // If the move never happens (no earlier entry), do not swallow the user's next real Back.
    this.ignoreTimer = setTimeout(() => (this.ignore = 0), 1000);
    this.hist.go(-n);
  }

  private async onPop(raw: unknown): Promise<void> {
    if (this.ignore > 0) {
      this.ignore--;
      return;
    }
    const target = screenOfState(raw);
    const from = this.cur;
    if (target === from) return;
    this.cur = target; // the history is already there; the app's own go() calls during the move are then no-ops
    let verdict: NavVerdict;
    try {
      verdict = await this.onMove(target, from);
    } catch (e) {
      console.error('[nav]', e);
      verdict = 'stay';
    }
    if (verdict === 'ok') return;
    this.cur = from;
    const dt = NAV_DEPTH[target];
    const df = NAV_DEPTH[from];
    if (verdict === 'revert' && dt > df) this.walk(dt - df);
    else this.hist.pushState(navStateFor(from), '');
  }
}

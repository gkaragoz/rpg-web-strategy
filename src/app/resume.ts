/**
 * Resume record: the language and 2D/3D switches reload the page, so the screen the player was on is stored in sessionStorage
 * right before the reload and restored once on boot. Pure helpers only (no DOM) so they can be unit tested.
 */

export const RESUME_KEY = 'rpgweb.resume';
/** A record older than this is ignored (it is only meant to survive one reload). */
export const RESUME_MAX_AGE_MS = 60_000;

export type ResumeScreen = 'studio' | 'online';
export interface ResumeRecord {
  screen: ResumeScreen;
  at: number;
}
/** What the boot code does with a record: open the solo studio, rejoin the last online room, or stay on the home page. */
export type ResumeAction = 'studio' | 'rejoin' | 'home';

export function encodeResume(screen: ResumeScreen, now: number): string {
  return JSON.stringify({ screen, at: now } satisfies ResumeRecord);
}

/** Parses a stored record; null for missing, malformed, unknown-screen, stale or future-dated data. */
export function decodeResume(raw: string | null | undefined, now: number): ResumeRecord | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const r = v as { screen?: unknown; at?: unknown };
  if (r.screen !== 'studio' && r.screen !== 'online') return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  const age = now - r.at;
  if (age < -5000 || age > RESUME_MAX_AGE_MS) return null; // stale (or from a clock that jumped)
  return { screen: r.screen, at: r.at };
}

/** Maps a record to the boot action; battles are never resumed, and an online record without a rejoin entry falls back to home. */
export function resumeAction(rec: ResumeRecord | null, canRejoin: boolean): ResumeAction {
  if (!rec) return 'home';
  if (rec.screen === 'studio') return 'studio';
  return canRejoin ? 'rejoin' : 'home';
}

/** Which record to store before a reload, given what the player is looking at (null: nothing worth resuming, i.e. home). */
export function resumeScreenFor(s: { inOnlineSession: boolean; inStudioOrSoloBattle: boolean }): ResumeScreen | null {
  if (s.inOnlineSession) return 'online';
  if (s.inStudioOrSoloBattle) return 'studio';
  return null;
}

export function saveResume(screen: ResumeScreen | null, now = Date.now()): void {
  try {
    if (screen) sessionStorage.setItem(RESUME_KEY, encodeResume(screen, now));
    else sessionStorage.removeItem(RESUME_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Reads and removes the record (it is used once). */
export function takeResume(now = Date.now()): ResumeRecord | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return decodeResume(raw, now);
  } catch {
    return null;
  }
}

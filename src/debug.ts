/**
 * Diagnostics hooks (`window.__sim`, `__session`, ...) used by the browser tests and scripted load tests. They are off for
 * players: they exist only with `?debug` (or `?bench`) in the URL, remembered for the tab session, and in the dev server.
 */
export type DebugKey = '__sim' | '__world' | '__benchResult' | '__session' | '__placement' | '__camera' | '__audio' | '__app' | '__v3' | '__atlas' | '__studioWorld';

const FLAG = 'rpgweb.debug';

function detect(): boolean {
  try {
    if (import.meta.env?.DEV) return true;
    const q = new URLSearchParams(location.search);
    if (q.has('debug') || q.has('bench')) {
      sessionStorage.setItem(FLAG, '1');
      return true;
    }
    return sessionStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

const enabled = typeof window !== 'undefined' && detect();

export const debugEnabled = (): boolean => enabled;

export function setDebug(key: DebugKey, value: unknown): void {
  if (enabled) (window as unknown as Record<string, unknown>)[key] = value;
}

export function getDebug<T>(key: DebugKey): T | undefined {
  return enabled ? ((window as unknown as Record<string, unknown>)[key] as T | undefined) : undefined;
}

export function clearDebug(key: DebugKey): void {
  if (enabled) delete (window as unknown as Record<string, unknown>)[key];
}

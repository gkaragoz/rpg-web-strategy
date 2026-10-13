export type SortKey = 'default' | 'cost' | 'hp' | 'power' | 'dps' | 'range' | 'speed' | 'name';
export type SortDir = 'asc' | 'desc';

export const SORT_KEYS: SortKey[] = ['default', 'cost', 'hp', 'power', 'dps', 'range', 'speed', 'name'];

/** Sorts unit kinds by `value(kind)`; ties keep the lower kind id first, so the order is stable. `default` keeps the input order. */
export function sortKinds(kinds: number[], key: SortKey, dir: SortDir, value: (kind: number, key: SortKey) => number | string): number[] {
  if (key === 'default') return kinds;
  const sign = dir === 'asc' ? 1 : -1;
  return kinds.slice().sort((a, b) => {
    const va = value(a, key);
    const vb = value(b, key);
    const c = typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : va - vb;
    return c * sign || a - b;
  });
}

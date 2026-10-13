import type { PlacedItem } from './protocol';

/**
 * The host's placed units with O(1) bookkeeping: per-team gold spent and unit count, and a per-team spatial hash for the
 * "too close to another unit" test (the naive scan made every placement O(units), so filling a room was O(units^2)).
 */
export class PlaceIndex {
  private readonly items = new Map<number, PlacedItem>();
  private readonly cells = new Map<number, PlacedItem[]>();
  private readonly spentBy: number[] = [];
  private readonly countBy: number[] = [];
  private readonly gap2: number;

  constructor(
    private readonly gap: number,
    private readonly cost: (kind: number) => number,
  ) {
    this.gap2 = gap * gap;
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
    this.cells.clear();
    this.spentBy.length = 0;
    this.countBy.length = 0;
  }

  spent(team: number): number {
    return this.spentBy[team] ?? 0;
  }

  count(team: number): number {
    return this.countBy[team] ?? 0;
  }

  private key(team: number, cx: number, cy: number): number {
    return (team * 4096 + (cy + 1024)) * 4096 + (cx + 1024);
  }

  add(it: PlacedItem): void {
    this.items.set(it.id, it);
    const k = this.key(it.team, Math.floor(it.x / this.gap), Math.floor(it.y / this.gap));
    const list = this.cells.get(k);
    if (list) list.push(it);
    else this.cells.set(k, [it]);
    this.spentBy[it.team] = (this.spentBy[it.team] ?? 0) + this.cost(it.kind);
    this.countBy[it.team] = (this.countBy[it.team] ?? 0) + 1;
  }

  /** Removes the listed ids that belong to `team`; returns the ids that were really removed. */
  remove(ids: Iterable<number>, team: number): number[] {
    const out: number[] = [];
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it || it.team !== team) continue;
      this.items.delete(id);
      const k = this.key(team, Math.floor(it.x / this.gap), Math.floor(it.y / this.gap));
      const list = this.cells.get(k);
      if (list) {
        const at = list.indexOf(it);
        if (at >= 0) list.splice(at, 1);
        if (!list.length) this.cells.delete(k);
      }
      this.spentBy[team] -= this.cost(it.kind);
      this.countBy[team]--;
      out.push(id);
    }
    return out;
  }

  /** Is a unit of `team` closer than the placement gap to (x, y)? */
  near(team: number, x: number, y: number): boolean {
    const cx = Math.floor(x / this.gap);
    const cy = Math.floor(y / this.gap);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(this.key(team, cx + dx, cy + dy));
        if (!list) continue;
        for (const u of list) if ((u.x - x) ** 2 + (u.y - y) ** 2 < this.gap2) return true;
      }
    return false;
  }

  /** All units in placement order (ids ascend). */
  all(): PlacedItem[] {
    return [...this.items.values()];
  }

  /** Units of one team, or of everybody. */
  visible(team: number | null): PlacedItem[] {
    const out: PlacedItem[] = [];
    for (const u of this.items.values()) if (team === null || u.team === team) out.push(u);
    return out;
  }
}

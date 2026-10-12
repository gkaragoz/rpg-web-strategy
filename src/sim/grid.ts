import type { Units } from './units';

/** Sayma siralamasi (counting sort) ile kurulan tek takimlik uniform grid. */
export class Grid {
  readonly cols: number;
  readonly cell: number;
  readonly start: Int32Array;
  readonly items: Int32Array;
  private readonly cursor: Int32Array;

  constructor(mapSize: number, cell: number, cap: number) {
    this.cell = cell;
    this.cols = Math.ceil(mapSize / cell);
    this.start = new Int32Array(this.cols * this.cols + 1);
    this.cursor = new Int32Array(this.cols * this.cols);
    this.items = new Int32Array(cap);
  }

  index(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, (x / this.cell) | 0));
    const cy = Math.min(this.cols - 1, Math.max(0, (y / this.cell) | 0));
    return cy * this.cols + cx;
  }

  /** team < 0: tum takimlar. */
  build(u: Units, team: number): void {
    const { start, cursor, items } = this;
    start.fill(0);
    for (let i = 0; i < u.count; i++) {
      if (u.alive[i] && (team < 0 || u.team[i] === team)) start[this.index(u.x[i], u.y[i]) + 1]++;
    }
    for (let c = 0; c < cursor.length; c++) start[c + 1] += start[c];
    cursor.set(start.subarray(0, cursor.length));
    for (let i = 0; i < u.count; i++) {
      if (u.alive[i] && (team < 0 || u.team[i] === team)) items[cursor[this.index(u.x[i], u.y[i])]++] = i;
    }
  }
}

import type { Units } from './units';

/** Single-team uniform grid built with a counting sort. */
export class Grid {
  cols: number;
  cell: number;
  start: Int32Array;
  items: Int32Array;
  private cursor: Int32Array;

  constructor(mapSize: number, cell: number, cap: number) {
    this.cell = cell;
    this.cols = Math.ceil(mapSize / cell);
    this.start = new Int32Array(this.cols * this.cols + 1);
    this.cursor = new Int32Array(this.cols * this.cols);
    this.items = new Int32Array(cap);
  }

  /** Moves the arrays that helper threads read (start, items) into shared memory; returns the buffers. */
  share(): { cell: number; cols: number; start: SharedArrayBuffer; items: SharedArrayBuffer } {
    const toShared = <T extends Int32Array>(a: T): T => {
      if (a.buffer instanceof SharedArrayBuffer) return a;
      const sab = new SharedArrayBuffer(a.byteLength);
      const out = new Int32Array(sab);
      out.set(a);
      return out as T;
    };
    this.start = toShared(this.start);
    this.items = toShared(this.items);
    return { cell: this.cell, cols: this.cols, start: this.start.buffer as SharedArrayBuffer, items: this.items.buffer as SharedArrayBuffer };
  }

  /** A read-only view of a grid built by another thread. */
  static view(g: { cell: number; cols: number; start: SharedArrayBuffer; items: SharedArrayBuffer }): Grid {
    const grid = Object.create(Grid.prototype) as Grid;
    grid.cell = g.cell;
    grid.cols = g.cols;
    grid.start = new Int32Array(g.start);
    grid.items = new Int32Array(g.items);
    return grid;
  }

  index(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, (x / this.cell) | 0));
    const cy = Math.min(this.cols - 1, Math.max(0, (y / this.cell) | 0));
    return cy * this.cols + cx;
  }

  /** team < 0: all teams. */
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

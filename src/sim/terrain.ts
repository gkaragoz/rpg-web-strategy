import { mulberry32 } from './random';

export const T_GRASS = 0;
export const T_WATER = 1;
export const T_BRIDGE = 2;
export const T_BLOCKED = 3;
export const T_PATH = 4;

const R = Math.SQRT1_2;
/** Nehir eksenleri: u = ordu ekseni (ekranda yatay), v = nehir yonu (ekranda dikey). */
export const U_X = R;
export const U_Y = -R;
export const V_X = R;
export const V_Y = R;

export type DecorKind = 'tree' | 'rock' | 'boulder' | 'house' | 'wall' | 'rubble';

export interface Decor {
  kind: DecorKind;
  /** tree: 0..2 boy; rock/boulder: 0..2; house: boyut*2+stil (0..5); wall/rubble: 0..1. */
  variant: number;
  /** Dunya (tile) koordinati: sprite'in ayak/alt-kose noktasi. */
  x: number;
  y: number;
}

export interface Bridge {
  /** Nehir ekseni (v) boyunca konum. */
  s: number;
  /** Bu konumda nehir merkezinin u-ofseti ve genisligi. */
  o: number;
  w: number;
  /** Tabla yari uzunlugu (u boyunca) ve yari genisligi (s boyunca). */
  halfLen: number;
  halfW: number;
}

export interface TerrainOptions {
  seed: number;
  /** Ordu doguslarinin kapladigi |d| araligi ve yari genisligi (s). */
  spawnD0: number;
  spawnD1: number;
  spawnHalfS: number;
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Harita verisi: hem sim (carpisma) hem renderer (cizim) ayni tohumla ayni sonucu uretir. */
export class Terrain {
  readonly size: number;
  readonly flags: Uint8Array;
  readonly bridges: Bridge[] = [];
  readonly decor: Decor[] = [];
  /** Toprak yol karolari (indeks). */
  readonly pathTiles: number[] = [];
  readonly cx: number;
  readonly cy: number;
  private readonly sMin: number;
  private readonly invStep: number;
  private readonly offTab: Float32Array;
  private readonly widTab: Float32Array;
  private readonly occ: Uint8Array;
  private readonly rng: () => number;
  private readonly opts: TerrainOptions;

  constructor(size: number, opts: TerrainOptions) {
    this.size = size;
    this.opts = opts;
    this.cx = this.cy = size / 2;
    this.flags = new Uint8Array(size * size);
    this.occ = new Uint8Array(size * size);
    this.rng = mulberry32(opts.seed * 9973 + 17);

    const step = 0.25;
    this.sMin = -size * 1.1;
    this.invStep = 1 / step;
    const n = Math.ceil((size * 2.2) / step) + 1;
    this.offTab = new Float32Array(n);
    this.widTab = new Float32Array(n);
    // Harita merkeze gore nokta simetriktir (adil): ofset tek, genislik cift fonksiyon.
    const a1 = 1.6 + this.rng() * 0.8;
    const a2 = 0.6 + this.rng() * 0.6;
    const k1 = 0.24 + this.rng() * 0.1;
    const k2 = 0.6 + this.rng() * 0.2;
    const k3 = 0.35 + this.rng() * 0.2;
    for (let i = 0; i < n; i++) {
      const s = this.sMin + i * step;
      // Ordu genisliginde nehir duz kalir (iki taraf icin adil); disarida kivrilir.
      const t = Math.min(1, Math.max(0, (Math.abs(s) - (opts.spawnHalfS + 2)) / 10));
      this.offTab[i] = (a1 * Math.sin(s * k1) + a2 * Math.sin(s * k2)) * t * t * (3 - 2 * t);
      this.widTab[i] = 5.2 + 0.6 * Math.cos(s * k3);
    }

    this.buildRiver();
    this.buildBridges();
    this.placeVillages();
    this.placeForest();
    this.mirror();
  }

  /** Tile yurunebilir mi (su ve engeller haric). */
  walkable(x: number, y: number): boolean {
    const n = this.size;
    if (x < 0 || y < 0 || x >= n || y >= n) return false;
    const f = this.flags[((y | 0) * n + (x | 0)) | 0];
    return f !== T_WATER && f !== T_BLOCKED;
  }

  /** (x,y) -> nehir koordinatlari: s (nehir boyunca), d (nehre dik, u ekseni). */
  toS(x: number, y: number): number {
    return (x - this.cx) * V_X + (y - this.cy) * V_Y;
  }
  toD(x: number, y: number): number {
    return (x - this.cx) * U_X + (y - this.cy) * U_Y;
  }

  offsetAt(s: number): number {
    return this.offTab[this.idx(s)];
  }
  widthAt(s: number): number {
    return this.widTab[this.idx(s)];
  }
  private idx(s: number): number {
    const i = ((s - this.sMin) * this.invStep + 0.5) | 0;
    return i < 0 ? 0 : i >= this.offTab.length ? this.offTab.length - 1 : i;
  }

  /** Nehrin hangi yakasi: -1 veya +1. */
  sideAt(x: number, y: number): number {
    const s = this.toS(x, y);
    return this.toD(x, y) >= this.offsetAt(s) ? 1 : -1;
  }

  /** Dunya noktasi (s, d). */
  worldX(s: number, d: number): number {
    return this.cx + s * V_X + d * U_X;
  }
  worldY(s: number, d: number): number {
    return this.cy + s * V_Y + d * U_Y;
  }

  /** Kopru ucu: side=-1/+1 yakasi, lat = tabla boyunca yanal ofset. */
  bridgeEnd(b: Bridge, side: number, lat: number, out: { x: number; y: number }): void {
    const s = b.s + lat;
    const d = b.o + side * (b.w / 2 + 2.4);
    out.x = this.worldX(s, d);
    out.y = this.worldY(s, d);
  }

  private tileIdx(x: number, y: number): number {
    return Math.floor(y) * this.size + Math.floor(x);
  }

  private inMap(x: number, y: number, m = 0): boolean {
    return x >= m && y >= m && x < this.size - m && y < this.size - m;
  }

  private buildRiver(): void {
    const n = this.size;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        const s = this.toS(x, y);
        if (Math.abs(this.toD(x, y) - this.offsetAt(s)) < this.widthAt(s) / 2) this.flags[ty * n + tx] = T_WATER;
      }
    }
  }

  private buildBridges(): void {
    const n = this.size;
    const spacing = n < 90 ? 16 : 28;
    const limit = n * 0.5 - 3;
    for (let k = -Math.floor(limit / spacing); k <= Math.floor(limit / spacing); k++) {
      const s = k * spacing;
      const w = this.widthAt(s);
      this.bridges.push({ s, o: this.offsetAt(s), w, halfLen: w / 2 + 2.5, halfW: 1.3 });
    }
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        const s = this.toS(x, y);
        const d = this.toD(x, y);
        for (const b of this.bridges) {
          if (Math.abs(s - b.s) < b.halfW + 0.05 && Math.abs(d - b.o) < b.halfLen) {
            this.flags[ty * n + tx] = T_BRIDGE;
            break;
          }
        }
      }
    }
  }

  /** Ordu doguslari ve kopru yaklasim koridorlari: engel konmaz. */
  private reserved(x: number, y: number, m: number): boolean {
    const s = this.toS(x, y);
    const d = Math.abs(this.toD(x, y));
    const { spawnD0, spawnD1, spawnHalfS } = this.opts;
    if (d > spawnD0 - m && d < spawnD1 + m && Math.abs(s) < spawnHalfS + m) return true;
    if (d < spawnD1 + 3 + m) {
      for (const b of this.bridges) if (Math.abs(s - b.s) < 3 + Math.min(m, 1)) return true;
    }
    return false;
  }

  private riverEdgeDist(x: number, y: number): number {
    const s = this.toS(x, y);
    return Math.abs(this.toD(x, y) - this.offsetAt(s)) - this.widthAt(s) / 2;
  }

  private freeRect(tx: number, ty: number, w: number, h: number, margin: number): boolean {
    const n = this.size;
    for (let y = ty - margin; y < ty + h + margin; y++) {
      for (let x = tx - margin; x < tx + w + margin; x++) {
        if (x < 1 || y < 1 || x >= n - 1 || y >= n - 1) return false;
        const i = y * n + x;
        if (this.flags[i] !== T_GRASS || this.occ[i]) return false;
        if (this.reserved(x + 0.5, y + 0.5, 1)) return false;
      }
    }
    return true;
  }

  private placeVillages(): void {
    const n = this.size;
    const rng = this.rng;
    const sites = Math.max(1, Math.round((n * n) / 2200));
    const centers: Array<{ x: number; y: number; side: number }> = [];
    const sizes: Array<[number, number]> = [
      [2, 2],
      [3, 2],
      [2, 3],
    ];

    for (let k = 0; k < sites; k++) {
      const side = -1; // yalniz bir yari uretilir, sonra yansitilir (mirror)
      for (let attempt = 0; attempt < 80; attempt++) {
        const s = (rng() * 2 - 1) * n * 0.6;
        const dd = 10 + rng() * 14;
        const x = this.worldX(s, side * dd);
        const y = this.worldY(s, side * dd);
        if (!this.inMap(x, y, 8) || this.reserved(x, y, 4)) continue;
        if (centers.some((c) => Math.hypot(c.x - x, c.y - y) < 16)) continue;
        if (this.flags[this.tileIdx(x, y)] !== T_GRASS) continue;
        centers.push({ x, y, side });
        break;
      }
    }

    for (const c of centers) {
      const count = 3 + Math.floor(rng() * 4);
      let placed = 0;
      for (let attempt = 0; attempt < 40 && placed < count; attempt++) {
        const a = rng() * Math.PI * 2;
        const r = 2.5 + rng() * 5.5;
        const [w, h] = sizes[Math.floor(rng() * sizes.length)];
        const tx = Math.floor(c.x + Math.cos(a) * r);
        const ty = Math.floor(c.y + Math.sin(a) * r);
        if (!this.freeRect(tx, ty, w, h, 1)) continue;
        for (let y = ty - 1; y < ty + h + 1; y++) for (let x = tx - 1; x < tx + w + 1; x++) this.occ[y * n + x] = 1;
        for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) this.flags[y * n + x] = T_BLOCKED;
        const sizeIdx = sizes.findIndex((z) => z[0] === w && z[1] === h);
        this.decor.push({ kind: 'house', variant: sizeIdx * 2 + (rng() < 0.5 ? 0 : 1), x: tx + w, y: ty + h });
        placed++;
        // Enkaz ve yikik duvar parcasi: evin cevresinde.
        for (let q = 0; q < 3; q++) {
          const rx = tx - 1 + Math.floor(rng() * (w + 2));
          const ry = ty - 1 + Math.floor(rng() * (h + 2));
          const edge = rx < tx || ry < ty || rx >= tx + w || ry >= ty + h;
          const i = ry * n + rx;
          if (!edge || rx < 1 || ry < 1 || rx >= n - 1 || ry >= n - 1 || this.flags[i] !== T_GRASS) continue;
          if (q === 0) {
            this.flags[i] = T_BLOCKED;
            this.decor.push({ kind: 'wall', variant: rng() < 0.5 ? 0 : 1, x: rx + 0.5, y: ry + 0.5 });
          } else {
            this.decor.push({ kind: 'rubble', variant: rng() < 0.5 ? 0 : 1, x: rx + 0.3 + rng() * 0.4, y: ry + 0.3 + rng() * 0.4 });
          }
        }
      }
      this.carvePath(c.x, c.y, c.side);
    }
  }

  /** d < 0 yarisini merkeze gore nokta yansitarak d > 0 yarisina kopyalar: iki taraf esit sartlarda. */
  private mirror(): void {
    const n = this.size;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        if (this.toD(tx + 0.5, ty + 0.5) >= 0) continue;
        this.flags[(n - 1 - ty) * n + (n - 1 - tx)] = this.flags[ty * n + tx];
      }
    }
    const houseSize = [
      [2, 2],
      [3, 2],
      [2, 3],
    ];
    const kept = this.decor.filter((d) => this.toD(d.x, d.y) < 0);
    this.decor.length = 0;
    for (const d of kept) this.decor.push(d);
    for (const d of kept) {
      let x = n - d.x;
      let y = n - d.y;
      if (d.kind === 'house') {
        const [w, h] = houseSize[d.variant >> 1];
        x += w;
        y += h;
      }
      this.decor.push({ kind: d.kind, variant: d.variant, x, y });
    }
    this.pathTiles.length = 0;
    for (let i = 0; i < this.flags.length; i++) if (this.flags[i] === T_PATH) this.pathTiles.push(i);
  }

  /** Koyden en yakin koprunun kendi yakadaki ucuna toprak yol. */
  private carvePath(x0: number, y0: number, side: number): void {
    if (this.bridges.length === 0) return;
    const p = { x: 0, y: 0 };
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (const b of this.bridges) {
      this.bridgeEnd(b, side, 0, p);
      const d = Math.hypot(p.x - x0, p.y - y0);
      if (d < best) {
        best = d;
        bx = p.x;
        by = p.y;
      }
    }
    const steps = Math.ceil(best / 0.6);
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((bx - x0) * i) / steps;
      const y = y0 + ((by - y0) * i) / steps;
      if (!this.inMap(x, y, 1)) continue;
      const idx = this.tileIdx(x, y);
      if (this.flags[idx] === T_GRASS) {
        this.flags[idx] = T_PATH;
        this.pathTiles.push(idx);
      }
    }
  }

  private placeForest(): void {
    const n = this.size;
    const rng = this.rng;
    const seed = this.opts.seed;
    const blockedNear = (tx: number, ty: number): boolean => {
      for (let y = ty - 1; y <= ty + 1; y++) {
        for (let x = tx - 1; x <= tx + 1; x++) {
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          if (this.flags[y * n + x] === T_BLOCKED) return true;
        }
      }
      return false;
    };
    for (let ty = 1; ty < n - 1; ty++) {
      for (let tx = 1; tx < n - 1; tx++) {
        const i = ty * n + tx;
        if (this.flags[i] !== T_GRASS || this.occ[i]) continue;
        const x = tx + 0.5;
        const y = ty + 0.5;
        if (this.reserved(x, y, 1)) continue;
        const edge = Math.min(tx, ty, n - tx, n - ty);
        const bias = 0.3 * (1 - Math.min(1, edge / 10));
        const v = 0.65 * noise(x / 9, y / 9, seed) + 0.35 * noise(x / 4, y / 4, seed + 7) + bias;
        const riverDist = this.riverEdgeDist(x, y);
        if (v > 0.6 && riverDist > 4) {
          if (rng() < 0.4 && !blockedNear(tx, ty)) {
            this.flags[i] = T_BLOCKED;
            this.decor.push({ kind: 'tree', variant: Math.floor(rng() * 3), x: x + (rng() - 0.5) * 0.4, y: y + (rng() - 0.5) * 0.4 });
          }
        } else if ((riverDist > 0.4 && riverDist < 2.5 && rng() < 0.05) || (v > 0.5 && v <= 0.6 && rng() < 0.03)) {
          const boulder = rng() < 0.25 && !blockedNear(tx, ty);
          if (boulder) this.flags[i] = T_BLOCKED;
          this.decor.push({ kind: boulder ? 'boulder' : 'rock', variant: Math.floor(rng() * 3), x: x + (rng() - 0.5) * 0.5, y: y + (rng() - 0.5) * 0.5 });
        }
      }
    }
  }
}

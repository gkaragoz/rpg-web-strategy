import { DEFAULT_MAP, type LayoutType, type MapSpec, type ReliefType, type RiverType } from './mapSpec';
import { mulberry32 } from './random';

export const T_GRASS = 0;
export const T_WATER = 1;
export const T_BRIDGE = 2;
export const T_BLOCKED = 3;
export const T_PATH = 4;

/** Bir yukselti kademesinin ekrandaki yuksekligi (piksel). */
export const LEVEL_PX = 22;
export const MAX_LEVEL_H = 4;
/** Tile yuksekligi birimleri: kademe basina 16 birim; komsu fark >= CLIFF_UNITS ise ucurum. */
export const H_UNITS = 16;
export const CLIFF_UNITS = 24;

const R = Math.SQRT1_2;
/** Nehir eksenleri: u = ordu ekseni (ekranda yatay), v = nehir yonu (ekranda dikey). */
export const U_X = R;
export const U_Y = -R;
export const V_X = R;
export const V_Y = R;

export type DecorKind = 'tree' | 'rock' | 'boulder' | 'house' | 'wall' | 'rubble' | 'tower' | 'keep';

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
  /** Harita tarifi (yoksa ilk surumdeki orman haritasi). */
  spec?: MapSpec;
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
  /** Nehir icindeki kara (ada) karolari (indeks). */
  readonly landTiles: number[] = [];
  /** Tile yukseltisi (0..4 kademe), kose yukseltileri ((n+1)^2, komsu tile ortalamasi) ve ucurum karolari. */
  height: Uint8Array;
  vh: Float32Array;
  hasRelief = false;
  readonly cliffTiles: number[] = [];
  readonly spec: MapSpec;
  /** Kurguya gore gecerli nehir ve kabartma turu (citadel/crossroads nehirsiz, archipelago adali). */
  readonly riverKind: RiverType;
  readonly layout: LayoutType;
  private readonly reliefKind: ReliefType | 'valley';
  /** Capraz kanal (adalar kurgusu) kopru karolari ve kanal yari genisligi. */
  readonly crossBridgeTiles: number[] = [];
  readonly crossWaterTiles: number[] = [];
  crossHalf = 0;
  /** Yurunebilir karolarin bagli bilesen numarasi (-1: yurunemez) ve en buyuk bilesen. */
  region: Int32Array = new Int32Array(0);
  mainRegion = -1;
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
    this.spec = opts.spec ?? DEFAULT_MAP;
    this.layout = this.spec.layout;
    this.riverKind = this.layout === 'citadel' || this.layout === 'crossroads' ? 'none' : this.layout === 'archipelago' ? 'islands' : this.spec.river;
    this.reliefKind = this.layout === 'valley' ? 'valley' : this.layout === 'citadel' ? 'plateau' : this.layout === 'archipelago' || this.layout === 'crossroads' ? 'hills' : this.spec.relief;
    this.cx = this.cy = size / 2;
    this.flags = new Uint8Array(size * size);
    this.occ = new Uint8Array(size * size);
    this.height = new Uint8Array(size * size);
    this.vh = new Float32Array((size + 1) * (size + 1));
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
    const rv = this.riverKind;
    const lakeL = size * 0.24;
    for (let i = 0; i < n; i++) {
      const s = this.sMin + i * step;
      // Ordu genisliginde nehir duz kalir (iki taraf icin adil); disarida kivrilir.
      const t = Math.min(1, Math.max(0, (Math.abs(s) - (opts.spawnHalfS + 2)) / 10));
      const wind = (a1 * Math.sin(s * k1) + a2 * Math.sin(s * k2)) * t * t * (3 - 2 * t);
      this.offTab[i] = rv === 'straight' || rv === 'none' ? 0 : wind;
      // Genislik cift fonksiyon (nokta simetri): gol, |s| = lakeL civarinda iki yana sismis.
      if (rv === 'none') this.widTab[i] = 0;
      else if (rv === 'straight') this.widTab[i] = 5 + 0.3 * Math.cos(s * k3);
      else if (rv === 'islands') this.widTab[i] = 8 + 0.8 * Math.cos(s * k3);
      else if (rv === 'lake') this.widTab[i] = 3.6 + 10 * Math.exp(-(((Math.abs(s) - lakeL) / 5.5) ** 2));
      else this.widTab[i] = 5.2 + 0.6 * Math.cos(s * k3);
    }

    this.buildRiver();
    if (rv !== 'none') this.buildBridges();
    if (rv === 'islands') this.carveIslands();
    if (this.layout === 'archipelago') this.buildCrossChannels();
    this.buildRelief();
    this.placeVillages();
    this.placeForest();
    this.mirror();
    if (this.layout === 'citadel') this.placeCastle();
    if (this.layout === 'crossroads') this.carveRoads();
    this.finishRelief();
    this.collectLand();
    this.computeRegions();
  }

  /** (x,y) noktasinin yuksekligi (kademe, kesirli): kose yukseltilerinin bilineer ara degeri. */
  heightAt(x: number, y: number): number {
    if (!this.hasRelief) return 0;
    const n = this.size;
    const cx = Math.min(n - 1, Math.max(0, Math.floor(x)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - cx));
    const fy = Math.min(1, Math.max(0, y - cy));
    const w = n + 1;
    const i = cy * w + cx;
    const h00 = this.vh[i];
    const h10 = this.vh[i + 1];
    const h01 = this.vh[i + w];
    const h11 = this.vh[i + w + 1];
    return h00 + (h10 - h00) * fx + (h01 - h00) * fy + (h00 - h10 - h01 + h11) * fx * fy;
  }

  /** (x,y) noktasinin ekran yuksekligi (piksel). */
  elevPx(x: number, y: number): number {
    return this.hasRelief ? this.heightAt(x, y) * LEVEL_PX : 0;
  }

  /** Kose yuksekligi (kademe) vx,vy in [0..n]. */
  vertexH(vx: number, vy: number): number {
    return this.vh[vy * (this.size + 1) + vx];
  }

  /**
   * (ox,oy) -> (nx,ny) adimi gecerli mi: hedef yurunebilir olmali ve kose capraz gecisinde
   * iki yan komsu da acik olmali (iki engelin kose kose degdigi yerden sizilmaz).
   */
  stepOk(ox: number, oy: number, nx: number, ny: number): boolean {
    if (!this.walkable(nx, ny)) return false;
    if ((ox | 0) !== (nx | 0) && (oy | 0) !== (ny | 0)) return this.walkable(nx, oy) && this.walkable(ox, ny);
    return true;
  }

  /** Tile yurunebilir mi (su ve engeller haric). */
  walkable(x: number, y: number): boolean {
    const n = this.size;
    if (x < 0 || y < 0 || x >= n || y >= n) return false;
    const f = this.flags[((y | 0) * n + (x | 0)) | 0];
    return f !== T_WATER && f !== T_BLOCKED;
  }

  /** Yurunebilir karolari bagli bilesenlere boler (8 komsuluk, kose kesme yok). */
  private computeRegions(): void {
    const n = this.size;
    const region = new Int32Array(n * n).fill(-1);
    const sizes: number[] = [];
    const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && this.walkable(x + 0.5, y + 0.5);
    const stack: number[] = [];
    let id = 0;
    for (let sy = 0; sy < n; sy++) {
      for (let sx = 0; sx < n; sx++) {
        if (region[sy * n + sx] !== -1 || !walk(sx, sy)) continue;
        let count = 0;
        region[sy * n + sx] = id;
        stack.push(sx, sy);
        while (stack.length) {
          const y = stack.pop()!;
          const x = stack.pop()!;
          count++;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (!walk(nx, ny) || region[ny * n + nx] !== -1) continue;
              if (dx && dy && !(walk(x + dx, y) && walk(x, y + dy))) continue;
              region[ny * n + nx] = id;
              stack.push(nx, ny);
            }
          }
        }
        sizes.push(count);
        id++;
      }
    }
    this.region = region;
    this.mainRegion = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
  }

  // ---- A* yol bulma (yalniz sikisan birimler icin) ----
  private astarG: Float32Array | null = null;
  private astarParent: Int32Array | null = null;
  private astarStamp: Int32Array | null = null;
  private astarClosed: Int32Array | null = null;
  private astarGen = 0;

  /** (x0,y0)-(x1,y1) dogrusu boyunca tum ornekler yurunebilir mi (birim yaricapi payi ile). */
  lineWalkable(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(len / 0.3));
    let px = x0;
    let py = y0;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (dx * i) / steps;
      const y = y0 + (dy * i) / steps;
      // Hareketle ayni kural: kose capraz gecisi (iki engel kose kose) yasak.
      if (!this.stepOk(Math.fround(px), Math.fround(py), Math.fround(x), Math.fround(y))) return false;
      px = x;
      py = y;
      // Kenarlara surtunmemek icin yan komsulara da bak (yaklasik birim yaricapi)
      const nx = -dy / (len || 1);
      const ny = dx / (len || 1);
      if (!this.walkable(x + nx * 0.2, y + ny * 0.2) || !this.walkable(x - nx * 0.2, y - ny * 0.2)) return false;
    }
    return true;
  }

  /**
   * Tile izgarasinda A* (8 komsu, kose kesme yok) + dogrudan gorus ile yol duzlestirme.
   * Donus: [x0,y0,x1,y1,...] ara noktalar (baslangic haric); yol yoksa null; zaten varmissa [].
   */
  findPath(sx: number, sy: number, gx: number, gy: number, maxNodes = 0): number[] | null {
    const n = this.size;
    const total = n * n;
    // Her karo en cok bir kez genisletilir (kapali kume): tum harita taransa bile `total` genisletme yeter.
    if (maxNodes <= 0) maxNodes = Math.max(8000, total + 64);
    if (!this.astarG) {
      this.astarG = new Float32Array(total);
      this.astarParent = new Int32Array(total);
      this.astarStamp = new Int32Array(total);
      this.astarClosed = new Int32Array(total);
    }
    const C = this.astarClosed!;
    const G = this.astarG;
    const P = this.astarParent!;
    const S = this.astarStamp!;
    const gen = ++this.astarGen;
    let goal = { x: gx, y: gy };
    if (!this.walkable(gx, gy)) {
      const q = this.nearestWalkable(gx, gy, 4);
      if (!q) return null;
      goal = q;
    }
    const start = (sy | 0) * n + (sx | 0);
    const target = (goal.y | 0) * n + (goal.x | 0);
    if (start === target) return [];
    const tx = goal.x | 0;
    const ty = goal.y | 0;
    const h = (x: number, y: number): number => {
      const dx = Math.abs(x - tx);
      const dy = Math.abs(y - ty);
      return dx + dy + (1.414 - 2) * Math.min(dx, dy);
    };
    // ikili yigin (f degeri kucuk olan once)
    const heapNode: number[] = [];
    const heapF: number[] = [];
    const push = (node: number, f: number): void => {
      let i = heapNode.length;
      heapNode.push(node);
      heapF.push(f);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapF[p] <= heapF[i]) break;
        [heapNode[p], heapNode[i]] = [heapNode[i], heapNode[p]];
        [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
        i = p;
      }
    };
    const pop = (): number => {
      const top = heapNode[0];
      const lastN = heapNode.pop()!;
      const lastF = heapF.pop()!;
      if (heapNode.length) {
        heapNode[0] = lastN;
        heapF[0] = lastF;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heapNode.length && heapF[l] < heapF[m]) m = l;
          if (r < heapNode.length && heapF[r] < heapF[m]) m = r;
          if (m === i) break;
          [heapNode[m], heapNode[i]] = [heapNode[i], heapNode[m]];
          [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
          i = m;
        }
      }
      return top;
    };
    G[start] = 0;
    S[start] = gen;
    P[start] = -1;
    push(start, h(start % n, (start / n) | 0));
    let expanded = 0;
    let found = false;
    while (heapNode.length && expanded < maxNodes) {
      const cur = pop();
      if (C[cur] === gen) continue;
      C[cur] = gen;
      expanded++;
      if (cur === target) {
        found = true;
        break;
      }
      const cx = cur % n;
      const cy = (cur / n) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          if (!this.walkable(nx + 0.5, ny + 0.5)) continue;
          if (dx && dy && !(this.walkable(cx + dx + 0.5, cy + 0.5) && this.walkable(cx + 0.5, cy + dy + 0.5))) continue;
          const idx = ny * n + nx;
          const ng = G[cur] + (dx && dy ? 1.414 : 1);
          if (S[idx] === gen && ng >= G[idx]) continue;
          S[idx] = gen;
          G[idx] = ng;
          P[idx] = cur;
          push(idx, ng + h(nx, ny));
        }
      }
    }
    if (!found) return null;
    // yolu geri kur (tile merkezleri)
    const nodes: number[] = [];
    for (let cur = target; cur !== -1 && cur !== start; cur = P[cur]) nodes.push(cur);
    nodes.reverse();
    const pts: number[] = [];
    for (const cur of nodes) pts.push((cur % n) + 0.5, ((cur / n) | 0) + 0.5);
    // dogrudan gorusle duzlestir
    const out: number[] = [];
    let ax = sx;
    let ay = sy;
    let i = 0;
    while (i < pts.length / 2) {
      let j = pts.length / 2 - 1;
      while (j > i && !this.lineWalkable(ax, ay, pts[j * 2], pts[j * 2 + 1])) j--;
      out.push(pts[j * 2], pts[j * 2 + 1]);
      ax = pts[j * 2];
      ay = pts[j * 2 + 1];
      i = j + 1;
    }
    return out;
  }

  /** (x,y)'nin bagli bilesen numarasi (-1: yurunemez / harita disi). */
  regionAt(x: number, y: number): number {
    const n = this.size;
    if (x < 0 || y < 0 || x >= n || y >= n) return -1;
    return this.region[((y | 0) * n + (x | 0)) | 0];
  }

  /** Ana (en buyuk) bolgede mi: kapali cep/ada degil. */
  reachable(x: number, y: number): boolean {
    return this.regionAt(x, y) === this.mainRegion;
  }

  /** (x,y) yurunemezse en yakin yurunebilir tile merkezini dondurur (halka halka arama). mainOnly: ana bolgede olsun. */
  nearestWalkable(x: number, y: number, maxR = 14, mainOnly = false): { x: number; y: number } | null {
    if (this.walkable(x, y) && (!mainOnly || this.reachable(x, y))) return { x, y };
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let r = 1; r <= maxR; r++) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const px = cx + dx + 0.5;
          const py = cy + dy + 0.5;
          if (!this.walkable(px, py) || (mainOnly && !this.reachable(px, py))) continue;
          const d = (px - x) * (px - x) + (py - y) * (py - y);
          if (d < bestD) {
            bestD = d;
            best = { x: px, y: py };
          }
        }
      }
      if (best) return best;
    }
    return null;
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
    // Tabla ucunun biraz icinde (uc, karo yuvarlamasiyla suya dusebilir).
    const d = b.o + side * (b.w / 2 + 1.7);
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
      this.bridges.push({ s, o: this.offsetAt(s), w, halfLen: w / 2 + 2.5, halfW: this.spec.crossing === 'ford' ? 2.4 : 1.8 });
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

  /** Nehirde kopru aralarina kucuk adalar (yalniz d < 0 yarisi; mirror digerini uretir). */
  private carveIslands(): void {
    const n = this.size;
    const spacing = n < 90 ? 16 : 28;
    const limit = n * 0.5 - 3;
    const K = Math.floor(limit / spacing);
    for (let k = -K - 1; k <= K; k++) {
      const sc = (k + 0.5) * spacing;
      if (Math.abs(sc) > limit - 2) continue;
      const o = this.offsetAt(sc);
      const rd = this.widthAt(sc) * 0.3;
      for (let ty = 0; ty < n; ty++) {
        for (let tx = 0; tx < n; tx++) {
          const i = ty * n + tx;
          if (this.flags[i] !== T_WATER) continue;
          const x = tx + 0.5;
          const y = ty + 0.5;
          if (this.toD(x, y) >= 0) continue;
          const a = (this.toS(x, y) - sc) / 3.4;
          const b = (this.toD(x, y) - o) / rd;
          if (a * a + b * b < 1) this.flags[i] = T_GRASS;
        }
      }
    }
  }

  /** Nehir icinde kalan kara karolari (ada): cizim icin. */
  private collectLand(): void {
    this.landTiles.length = 0;
    if (this.riverKind === 'none') return;
    const n = this.size;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = ty * n + tx;
        if (this.flags[i] !== T_GRASS) continue;
        if (this.riverEdgeDist(tx + 0.5, ty + 0.5) < 0) this.landTiles.push(i);
      }
    }
  }

  /** Adalar kurgusu: nehre dik iki kanal (s = +-yaklasik kopru araligi/2) ve kanallari asan kopruler. */
  private buildCrossChannels(): void {
    const n = this.size;
    const cw = Math.max(4, n * 0.07);
    this.crossHalf = cw / 2;
    const s0 = (n < 90 ? 16 : 28) / 2;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        const s = this.toS(x, y);
        if (Math.abs(Math.abs(s) - s0) >= cw / 2) continue;
        if (this.reserved(x, y, 1)) continue;
        const i = ty * n + tx;
        if (this.flags[i] === T_GRASS || this.flags[i] === T_PATH) {
          this.flags[i] = T_WATER;
          this.crossWaterTiles.push(i);
        }
      }
    }
    // Kopruler: her kanal icin d = +-0.16n ve +-0.34n.
    for (const sc of [-s0, s0]) {
      for (const dc of [-0.34 * n, -0.16 * n, 0.16 * n, 0.34 * n]) {
        for (let ty = 0; ty < n; ty++) {
          for (let tx = 0; tx < n; tx++) {
            const x = tx + 0.5;
            const y = ty + 0.5;
            if (Math.abs(this.toD(x, y) - dc) > 1.4 || Math.abs(this.toS(x, y) - sc) > cw / 2 + 1.3) continue;
            const i = ty * n + tx;
            if (this.flags[i] === T_BRIDGE) continue;
            if (this.flags[i] === T_WATER || this.flags[i] === T_GRASS) {
              this.flags[i] = T_BRIDGE;
              this.crossBridgeTiles.push(i);
            }
          }
        }
      }
    }
  }

  /** Cevreyi temizler: dekoru siler, agac/ev engellerini kaldirir (kale icin). */
  private clearArea(cx: number, cy: number, r: number): void {
    const n = this.size;
    const keep = this.decor.filter((d) => Math.hypot(d.x - cx, d.y - cy) >= r);
    this.decor.length = 0;
    for (const d of keep) this.decor.push(d);
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        if (Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy) >= r) continue;
        const i = ty * n + tx;
        if (this.flags[i] === T_BLOCKED && this.height[i] >= 0) {
          // yalniz ucurum olmayan (agac/ev/kaya) engeller kalkar
          let cliff = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx >= 0 && ny >= 0 && nx < n && ny < n && this.height[i] - this.height[ny * n + nx] >= CLIFF_UNITS) cliff = true;
          }
          if (!cliff) this.flags[i] = T_GRASS;
        }
        this.occ[i] = 0;
      }
    }
  }

  /** Merkez kale: plato ustunde halka duvar (rampa yonlerinde kapi), 4 kose kulesi ve ortada hisar. Nokta simetrik. */
  private placeCastle(): void {
    const n = this.size;
    const c = n / 2;
    const r = n * 0.21;
    const rho = r * 0.6;
    this.clearArea(c, c, rho + 2.5);
    const put = (tx: number, ty: number, kind: 'wall' | 'tower', variant: number): void => {
      const i = ty * n + tx;
      if (tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1 || this.flags[i] !== T_GRASS) return;
      this.flags[i] = T_BLOCKED;
      this.occ[i] = 1;
      this.decor.push(kind === 'wall' ? { kind, variant, x: tx + 0.5, y: ty + 0.5 } : { kind, variant, x: tx + 1, y: ty + 1 });
    };
    // Halka duvar: merkezden uzakligi [rho - 0.5, rho + 0.5) olan her tile; kapilar rampa yonlerinde.
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const dx = tx + 0.5 - c;
        const dy = ty + 0.5 - c;
        const dist = Math.hypot(dx, dy);
        if (dist < rho - 0.5 || dist >= rho + 0.5) continue;
        const gate = Math.pow(Math.max(0, Math.cos(2 * Math.atan2(dy, dx))), 4);
        if (gate > 0.55) continue;
        put(tx, ty, 'wall', (tx + ty) & 1);
      }
    }
    // Kose kuleleri (4 capraz yon, nokta simetrik).
    const A = Math.round(rho * Math.SQRT1_2);
    for (const [tx, ty] of [[c + A, c + A], [c - A - 1, c - A - 1], [c + A, c - A - 1], [c - A - 1, c + A]]) {
      const i = ty * n + tx;
      if (this.flags[i] === T_BLOCKED && this.decor.some((d) => d.kind === 'wall' && Math.floor(d.x) === tx && Math.floor(d.y) === ty)) {
        const k = this.decor.findIndex((d) => d.kind === 'wall' && Math.floor(d.x) === tx && Math.floor(d.y) === ty);
        this.decor.splice(k, 1);
        this.flags[i] = T_GRASS;
      }
      put(tx, ty, 'tower', 0);
    }
    // Hisar: ortada 4x4 (tile c-2..c+1), engel.
    for (let ty = c - 2; ty < c + 2; ty++) for (let tx = c - 2; tx < c + 2; tx++) {
      this.flags[ty * n + tx] = T_BLOCKED;
      this.occ[ty * n + tx] = 1;
    }
    this.decor.push({ kind: 'keep', variant: 0, x: c + 2, y: c + 2 });
  }

  /** Capraz yol: orta eksenler boyunca toprak yol (simetrik). */
  private carveRoads(): void {
    const n = this.size;
    for (let t = -n; t <= n; t += 0.4) {
      for (const [x, y] of [[this.worldX(0, t), this.worldY(0, t)], [this.worldX(t, 0), this.worldY(t, 0)]]) {
        if (!this.inMap(x, y, 1)) continue;
        const idx = this.tileIdx(x, y);
        if (this.flags[idx] === T_GRASS) {
          this.flags[idx] = T_PATH;
          this.pathTiles.push(idx);
        }
      }
    }
  }

  /** Yukselti uretimi: kabartma tipine gore surekli alan -> kademe; sinir/nehir/dogus yakini duzlenir. */
  private buildRelief(): void {
    const rl = this.reliefKind;
    if (rl === 'flat') return;
    const amp = this.layout === 'archipelago' ? 0.7 : this.layout === 'crossroads' ? 0.8 : 1;
    const n = this.size;
    const c = n / 2;
    const seed = this.opts.seed + 101;
    const hasRiver = this.riverKind !== 'none';
    const smooth = (a: number, b: number, v: number): number => {
      const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const radial = rl === 'plateau' || rl === 'peak';
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        const d = this.toD(x, y);
        if (d > 1e-9) continue; // yalniz d <= 0 yarisi uretilir, sonra yansitilir
        const s = this.toS(x, y);
        const ad = Math.abs(d);
        const dist = Math.hypot(x - c, y - c);
        let H = 0;
        if (rl === 'hills') {
          H = 7 * amp * (0.65 * noise(x / 13, y / 13, seed) + 0.35 * noise(x / 6, y / 6, seed + 5) - 0.36);
        } else if (rl === 'valley') {
          // Orta eksene paralel iki yuksek set; yalniz s ~ 0'da bir gecit (kapi) acik.
          const R = n * 0.17;
          const hw = n * 0.05 * (1 - 0.97 * Math.exp(-((s / (n * 0.075)) ** 2)));
          H = 4.4 * smooth(0, 1, (hw - Math.abs(ad - R)) / 0.9 + 0.5) + 0.35 * noise(x / 6, y / 6, seed + 4);
        } else if (rl === 'ridge') {
          const R = n * 0.2;
          const pass = 0.5 + 0.5 * Math.cos((s * Math.PI * 2) / (n * 0.5));
          H = 4.2 * Math.exp(-(((ad - R) / (n * 0.055)) ** 2)) * (0.25 + 0.75 * smooth(0.25, 0.8, pass)) + 0.7 * noise(x / 7, y / 7, seed + 3);
        } else if (rl === 'plateau') {
          const r = n * 0.21;
          const ang = Math.atan2(y - c, x - c);
          const ramp = Math.pow(Math.max(0, Math.cos(2 * ang)), 4);
          const w = 0.9 + 6 * ramp;
          // Citadel kurgusunda plato ustu tam duz (kale insa edilir).
          const top = this.layout === 'citadel' && dist < r * 0.85 ? 0 : 0.3;
          H = 3.4 * smooth(0, 1, (r - dist) / w + 0.5) + top * noise(x / 5, y / 5, seed + 2);
        } else {
          const R = n * 0.26;
          H = 5.4 * Math.pow(Math.max(0, 1 - dist / R), 1.15) + 1.1 * Math.abs(noise(x / 4.5, y / 4.5, seed + 9) - 0.5) * 2 * smooth(0, 5, R - dist);
        }
        if (!radial) H *= smooth(1.5, 5, ad); // nehir/orta eksen vadi
        if (hasRiver && !radial) H *= smooth(2.5, 6, this.riverEdgeDist(x, y));
        else if (hasRiver) H *= smooth(0, 2.5, this.riverEdgeDist(x, y));
        // Kopru ve yaklasim yollari duz kalir (rampa/ucurum kopruyu kesmesin).
        for (const br of this.bridges) {
          const bd = Math.max(Math.abs(s - br.s) / 4.5, Math.abs(d - br.o) / (br.halfLen + 6));
          if (bd < 1) H *= smooth(0.55, 1, bd);
        }
        H *= smooth(0, 3, Math.min(tx, ty, n - 1 - tx, n - 1 - ty)); // harita kenari duz
        if (this.reserved(x, y, 2)) H = 0;
        const f = this.flags[ty * n + tx];
        if (f === T_WATER || f === T_BRIDGE) H = 0;
        this.height[ty * n + tx] = Math.min(MAX_LEVEL_H * H_UNITS, Math.max(0, Math.round(H * H_UNITS)));
      }
    }
    // Nokta simetri.
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const d = this.toD(tx + 0.5, ty + 0.5);
        if (d > 1e-9 || (d >= -1e-9 && ty * n + tx > (n - 1 - ty) * n + (n - 1 - tx))) continue;
        this.height[(n - 1 - ty) * n + (n - 1 - tx)] = this.height[ty * n + tx];
      }
    }
    // Ucurum: komsusundan >= 2 kademe yuksekteki yurunebilir tile gecilmez.
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = ty * n + tx;
        if (this.flags[i] !== T_GRASS) continue;
        const h = this.height[i];
        let cliff = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          if (h - this.height[ny * n + nx] >= CLIFF_UNITS) cliff = true;
        }
        if (cliff) {
          this.flags[i] = T_BLOCKED;
          this.cliffTiles.push(i);
        }
      }
    }
  }

  /** Yukselti bittikten sonra: kose yukseltileri ve kabartma bayragi. */
  private finishRelief(): void {
    const n = this.size;
    let any = false;
    for (let i = 0; i < this.height.length; i++) if (this.height[i] > 0) any = true;
    this.hasRelief = any;
    if (!any) return;
    const w = n + 1;
    for (let vy = 0; vy <= n; vy++) {
      for (let vx = 0; vx <= n; vx++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 0; dy++) {
          for (let dx = -1; dx <= 0; dx++) {
            const tx = vx + dx;
            const ty = vy + dy;
            if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
            sum += this.height[ty * n + tx];
            cnt++;
          }
        }
        this.vh[vy * w + vx] = sum / Math.max(1, cnt) / H_UNITS;
      }
    }
    // Ucurum karolarini cizim icin ekran listesi olarak koru (dekor/ev yerlesimi bunlari zaten engel sayar).
    this.cliffTiles.length = 0;
    for (let i = 0; i < this.flags.length; i++) {
      if (this.flags[i] !== T_BLOCKED) continue;
      const tx = i % n;
      const ty = (i / n) | 0;
      const h = this.height[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx >= 0 && ny >= 0 && nx < n && ny < n && h - this.height[ny * n + nx] >= CLIFF_UNITS) {
          this.cliffTiles.push(i);
          break;
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
    const h0 = tx >= 0 && ty >= 0 && tx < n && ty < n ? this.height[ty * n + tx] : 0;
    for (let y = ty - margin; y < ty + h + margin; y++) {
      for (let x = tx - margin; x < tx + w + margin; x++) {
        if (x < 1 || y < 1 || x >= n - 1 || y >= n - 1) return false;
        const i = y * n + x;
        if (this.flags[i] !== T_GRASS || this.occ[i]) return false;
        if (Math.abs(this.height[i] - h0) > 4) return false; // yapi duz zemine kurulur
        if (this.reserved(x + 0.5, y + 0.5, 1)) return false;
      }
    }
    return true;
  }

  private placeVillages(): void {
    const n = this.size;
    const rng = this.rng;
    const vt = this.spec.village;
    if (vt === 'none') return;
    const sites =
      vt === 'scattered' ? Math.max(2, Math.round((n * n) / 900)) : vt === 'ruins' ? Math.max(1, Math.round((n * n) / 3600)) : vt === 'camp' ? Math.max(1, Math.round((n * n) / 3000)) : Math.max(1, Math.round((n * n) / 2200));
    const spacing = vt === 'scattered' ? 11 : vt === 'village' ? 16 : 20;
    const centers: Array<{ x: number; y: number; side: number }> = [];
    const sizes: Array<[number, number]> = [
      [2, 2],
      [3, 2],
      [2, 3],
    ];

    if (this.layout === 'crossroads') {
      // Kavsak kurgusu: kavsagin dort kosesinde sabit mezralar.
      for (const [sc, dc] of [[-0.25, -0.2], [0.25, -0.2]]) {
        const x = this.worldX(sc * n, dc * n);
        const y = this.worldY(sc * n, dc * n);
        if (this.inMap(x, y, 6) && this.flags[this.tileIdx(x, y)] === T_GRASS) centers.push({ x, y, side: -1 });
      }
    }
    for (let k = 0; this.layout !== 'crossroads' && k < sites; k++) {
      const side = -1; // yalniz bir yari uretilir, sonra yansitilir (mirror)
      for (let attempt = 0; attempt < 80; attempt++) {
        const s = (rng() * 2 - 1) * n * 0.6;
        const dd = 10 + rng() * 14;
        const x = this.worldX(s, side * dd);
        const y = this.worldY(s, side * dd);
        if (!this.inMap(x, y, 8) || this.reserved(x, y, 4)) continue;
        if (centers.some((c) => Math.hypot(c.x - x, c.y - y) < spacing)) continue;
        if (this.flags[this.tileIdx(x, y)] !== T_GRASS) continue;
        centers.push({ x, y, side });
        break;
      }
    }

    for (const c of centers) {
      const count = vt === 'scattered' ? 1 + Math.floor(rng() * 2) : vt === 'ruins' ? 2 + Math.floor(rng() * 2) : vt === 'camp' ? 2 : 3 + Math.floor(rng() * 4);
      let placed = 0;
      for (let attempt = 0; attempt < 40 && placed < count; attempt++) {
        const a = rng() * Math.PI * 2;
        const r = vt === 'camp' ? rng() * 2.2 : 2.5 + rng() * 5.5;
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
      if (vt === 'camp') this.wallRing(c.x, c.y, 5, 16, 5);
      if (vt === 'ruins') {
        this.wallRing(c.x, c.y, 7.5, 28, 7);
        for (let q = 0; q < 10; q++) {
          const a = rng() * Math.PI * 2;
          const r = 3 + rng() * 5;
          const x = c.x + Math.cos(a) * r;
          const y = c.y + Math.sin(a) * r;
          if (this.freeRect(Math.floor(x), Math.floor(y), 1, 1, 0)) this.decor.push({ kind: 'rubble', variant: rng() < 0.5 ? 0 : 1, x, y });
        }
      }
      this.carvePath(c.x, c.y, c.side);
    }
  }

  /** Karonun 8 komsusundan biri engel mi (duvarlar kose kose degmesin: sizinti olur). */
  private blockedAround(tx: number, ty: number): boolean {
    const n = this.size;
    for (let y = ty - 1; y <= ty + 1; y++) {
      for (let x = tx - 1; x <= tx + 1; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (this.flags[y * n + x] === T_BLOCKED) return true;
      }
    }
    return false;
  }

  /** Merkez etrafinda aralikli duvar halkasi (giris boslugu birakir). */
  private wallRing(cx: number, cy: number, radius: number, segs: number, gapEvery: number): void {
    const n = this.size;
    for (let k = 0; k < segs; k++) {
      if (k % gapEvery === 0) continue;
      const a = (k / segs) * Math.PI * 2;
      const tx = Math.floor(cx + Math.cos(a) * radius);
      const ty = Math.floor(cy + Math.sin(a) * radius);
      if (!this.freeRect(tx, ty, 1, 1, 0) || this.blockedAround(tx, ty)) continue;
      this.flags[ty * n + tx] = T_BLOCKED;
      this.occ[ty * n + tx] = 1;
      this.decor.push({ kind: 'wall', variant: k % 2, x: tx + 0.5, y: ty + 0.5 });
    }
  }

  /** d < 0 yarisini merkeze gore nokta yansitarak d > 0 yarisina kopyalar: iki taraf esit sartlarda. */
  private mirror(): void {
    const n = this.size;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const d = this.toD(tx + 0.5, ty + 0.5);
        // Eksen uzerindeki (d = 0) karolar kendi aralarinda: kucuk indeks kaynak olur.
        if (d > 1e-9 || (d >= -1e-9 && ty * n + tx > (n - 1 - ty) * n + (n - 1 - tx))) continue;
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
    const ft = this.spec.forest;
    const hasRiver = this.riverKind !== 'none';
    // Orman tipi: esik (thr), agac olasiligi ve kaya bandi ust siniri.
    const thr = ft === 'none' ? 99 : ft === 'sparse' ? 0.66 : ft === 'grove' ? 0.64 : 0.6;
    const prob = ft === 'sparse' ? 0.3 : ft === 'grove' ? 0.55 : 0.4;
    const rockHi = ft === 'none' ? 0.6 : Math.min(thr, 0.66);
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
        let v = 0.65 * noise(x / 9, y / 9, seed) + 0.35 * noise(x / 4, y / 4, seed + 7) + bias;
        if (ft === 'grove') v = 0.85 * noise(x / 17, y / 17, seed + 3) + 0.15 * noise(x / 5, y / 5, seed + 7);
        else if (ft === 'ring') v = edge < 9 ? 0.62 + 0.12 * (1 - edge / 9) + 0.1 * noise(x / 4, y / 4, seed + 7) : 0.3 * noise(x / 9, y / 9, seed);
        const riverDist = hasRiver ? this.riverEdgeDist(x, y) : 99;
        if (v > thr && riverDist > 4) {
          if (rng() < prob && !blockedNear(tx, ty)) {
            this.flags[i] = T_BLOCKED;
            this.decor.push({ kind: 'tree', variant: Math.floor(rng() * 3), x: x + (rng() - 0.5) * 0.4, y: y + (rng() - 0.5) * 0.4 });
          }
        } else if ((riverDist > 0.4 && riverDist < 2.5 && rng() < 0.05) || (v > 0.5 && v <= rockHi && rng() < 0.03)) {
          const boulder = rng() < 0.25 && !blockedNear(tx, ty);
          if (boulder) this.flags[i] = T_BLOCKED;
          this.decor.push({ kind: boulder ? 'boulder' : 'rock', variant: Math.floor(rng() * 3), x: x + (rng() - 0.5) * 0.5, y: y + (rng() - 0.5) * 0.5 });
        }
      }
    }
  }
}

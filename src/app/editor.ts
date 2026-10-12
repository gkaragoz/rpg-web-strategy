import { Graphics, Sprite, type Application } from 'pixi.js';
import type { Camera } from '../camera';
import { isoX, isoY } from '../iso';
import type { Atlas } from '../render/atlas';
import { KIND_COUNT, MAX_TEAMS, STATS } from '../sim/units';
import { composeArmy, composeFromKind, type Lane } from './armies';
import { POSES } from '../render/unitView';
import { BRUSHES, MAX_PLACED, saveState, teamColors, type AppState, type PlacedUnit } from './state';
import type { WorldView } from './world';

interface Op {
  type: 'add' | 'remove';
  units: PlacedUnit[];
}

export interface EditorDeps {
  app: Application;
  world: WorldView;
  camera: Camera;
  state: AppState;
  getAtlas: () => Atlas;
  /** Yerlestirilen turlerin dokusu atlas'ta yoksa pisirir (sprite'lar yeniden kurulur). */
  ensureAtlas: () => void;
  /** Birimler/sayilar degisti (arayuz sayaclarini guncelle). */
  onChange: () => void;
  toast: (msg: string) => void;
}

const MIN_GAP = 0.85;
/** Dairenin ekran elipsi: yaricap r tile -> rx = r*TILE_W/2*sqrt2, ry = rx/2. */
const ELLIPSE_X = 45.25;

/** Haritaya birim yerlestirme: fircayla boyama, silme, geri al/yinele, formasyon. */
export class Editor {
  private readonly sprites = new Map<PlacedUnit, Sprite>();
  private readonly ghost = new Graphics();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private stroke: Op | null = null;
  private strokeButton = -1;
  private lastStamp = { x: -999, y: -999 };
  private cursor = { x: 0, y: 0, inside: false };
  private active = false;
  private rng = Math.random;

  private readonly onDown = (e: PointerEvent) => this.pointerDown(e);
  private readonly onMove = (e: PointerEvent) => this.pointerMove(e);
  private readonly onUp = (e: PointerEvent) => this.pointerUp(e);
  private readonly onLeave = () => {
    this.cursor.inside = false;
    this.drawGhost();
  };
  private readonly onContext = (e: Event) => e.preventDefault();

  constructor(private readonly d: EditorDeps) {
    this.d.world.fxLayer.addChild(this.ghost);
  }

  enter(): void {
    this.active = true;
    const c = this.d.app.canvas;
    c.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointerleave', this.onLeave);
    c.addEventListener('contextmenu', this.onContext);
    this.refreshSprites();
  }

  exit(): void {
    this.active = false;
    const c = this.d.app.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('contextmenu', this.onContext);
    this.ghost.clear();
    this.clearSprites();
  }

  // ---- koordinatlar / gecerlilik ----

  private toTile(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.d.app.canvas.getBoundingClientRect();
    const p = this.d.world.root.toLocal({ x: clientX - rect.left, y: clientY - rect.top });
    // Yukseltili arazide ekran noktasi yukselti kadar yukari kayar: iki turda duzelt.
    let x = p.x / 64 + p.y / 32;
    let y = p.y / 32 - p.x / 64;
    const t = this.d.world.terrain;
    if (t && t.hasRelief) {
      for (let k = 0; k < 3; k++) {
        const e = t.elevPx(Math.min(this.d.world.mapSize, Math.max(0, x)), Math.min(this.d.world.mapSize, Math.max(0, y)));
        x = p.x / 64 + (p.y + e) / 32;
        y = (p.y + e) / 32 - p.x / 64;
      }
    }
    return { x, y };
  }

  private elevAt(x: number, y: number): number {
    const t = this.d.world.terrain;
    return t && t.hasRelief ? t.elevPx(Math.min(this.d.world.mapSize, Math.max(0, x)), Math.min(this.d.world.mapSize, Math.max(0, y))) : 0;
  }

  private inMap(x: number, y: number): boolean {
    const n = this.d.world.mapSize;
    return x >= 0.5 && y >= 0.5 && x <= n - 0.5 && y <= n - 0.5;
  }

  private nearUnit(x: number, y: number, gap: number, extra: PlacedUnit[] = []): boolean {
    const g2 = gap * gap;
    for (const u of this.d.state.units) if ((u.x - x) ** 2 + (u.y - y) ** 2 < g2) return true;
    for (const u of extra) if ((u.x - x) ** 2 + (u.y - y) ** 2 < g2) return true;
    return false;
  }

  /** Yerlestirme gecerli mi: harita icinde, yurunebilir, baska birime cok yakin degil. */
  isValid(x: number, y: number, extra: PlacedUnit[] = []): boolean {
    if (!this.inMap(x, y)) return false;
    const t = this.d.world.terrain;
    if (t && !t.walkable(x, y)) return false;
    return !this.nearUnit(x, y, MIN_GAP, extra);
  }

  // ---- fare ----

  private pointerDown(e: PointerEvent): void {
    if (!this.active || (e.button !== 0 && e.button !== 2)) return;
    const erase = e.button === 2 || this.d.state.tool === 'erase';
    this.strokeButton = e.button;
    this.stroke = { type: erase ? 'remove' : 'add', units: [] };
    this.lastStamp = { x: -999, y: -999 };
    const p = this.toTile(e.clientX, e.clientY);
    this.apply(p.x, p.y, e.shiftKey);
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.active) return;
    const rect = this.d.app.canvas.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    const p = this.toTile(e.clientX, e.clientY);
    this.cursor = { x: p.x, y: p.y, inside };
    if (this.stroke && inside) this.apply(p.x, p.y, e.shiftKey);
    this.drawGhost();
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.stroke || e.button !== this.strokeButton) return;
    const op = this.stroke;
    this.stroke = null;
    this.strokeButton = -1;
    if (op.units.length > 0) {
      this.undoStack.push(op);
      this.redoStack = [];
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.d.onChange();
    }
  }

  /** Boyama darbesinde fircayi uygular (aralik kontroluyle). */
  private apply(x: number, y: number, teamOnly: boolean): void {
    const br = BRUSHES[this.d.state.brush];
    const spacing = br.count === 1 ? 0.9 : br.radius * 0.7;
    if ((x - this.lastStamp.x) ** 2 + (y - this.lastStamp.y) ** 2 < spacing * spacing && this.lastStamp.x > -900) return;
    this.lastStamp = { x, y };
    if (this.stroke!.type === 'add') this.stampAdd(x, y);
    else this.stampErase(x, y, teamOnly);
  }

  private stampAdd(x: number, y: number): void {
    const s = this.d.state;
    const br = BRUSHES[s.brush];
    const added: PlacedUnit[] = [];
    if (br.count === 1) {
      if (!this.isValid(x, y)) return;
      added.push({ team: s.selTeam, kind: s.selKind, x, y });
    } else {
      for (let tries = 0; tries < br.count * 8 && added.length < br.count; tries++) {
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * br.radius;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (this.isValid(px, py, added)) added.push({ team: s.selTeam, kind: s.selKind, x: px, y: py });
      }
    }
    const room = MAX_PLACED - s.units.length;
    if (added.length > room) {
      added.length = Math.max(0, room);
      this.d.toast(`Üst sınıra ulaşıldı (${MAX_PLACED} asker).`);
    }
    if (added.length === 0) return;
    for (const u of added) s.units.push(u);
    this.d.ensureAtlas();
    for (const u of added) {
      if (!this.sprites.has(u)) this.addSprite(u);
      this.stroke!.units.push(u);
    }
    saveState(s);
    this.d.onChange();
  }

  private stampErase(x: number, y: number, teamOnly: boolean): void {
    const s = this.d.state;
    const br = BRUSHES[s.brush];
    const r = br.count === 1 ? 0.9 : br.radius;
    const r2 = r * r;
    const removed: PlacedUnit[] = [];
    s.units = s.units.filter((u) => {
      if ((u.x - x) ** 2 + (u.y - y) ** 2 > r2 || (teamOnly && u.team !== s.selTeam)) return true;
      removed.push(u);
      return false;
    });
    if (removed.length === 0) return;
    for (const u of removed) {
      this.dropSprite(u);
      this.stroke!.units.push(u);
    }
    saveState(s);
    this.d.onChange();
  }

  // ---- hayalet fircasi ----

  drawGhost(): void {
    const g = this.ghost;
    g.clear();
    if (!this.active || !this.cursor.inside) return;
    const s = this.d.state;
    const br = BRUSHES[s.brush];
    const erase = s.tool === 'erase';
    const { x, y } = this.cursor;
    const cx = isoX(x, y);
    const cy = isoY(x, y, this.elevAt(x, y));
    const colors = teamColors(s.palette, s.teamCount);
    const col = erase ? 0xffffff : colors[Math.min(s.selTeam, colors.length - 1)].main;
    const bad = !erase && br.count === 1 && !this.isValid(x, y);
    const radius = erase ? (br.count === 1 ? 0.9 : br.radius) : br.radius;
    g.ellipse(cx, cy, radius * ELLIPSE_X, (radius * ELLIPSE_X) / 2).fill({ color: bad ? 0xe0463b : col, alpha: 0.18 }).stroke({ width: 2, color: bad ? 0xe0463b : col, alpha: 0.9 });
    if (erase) {
      g.moveTo(cx - 8, cy - 4).lineTo(cx + 8, cy + 4).moveTo(cx - 8, cy + 4).lineTo(cx + 8, cy - 4).stroke({ width: 2, color: 0xe0463b });
    }
  }

  // ---- sprite'lar ----

  private spriteFor(u: PlacedUnit): Sprite {
    const atlas = this.d.getAtlas();
    const idx = (u.kind * MAX_TEAMS + u.team) * POSES;
    const tex = atlas.unitTex[idx] ?? atlas.unitTex[u.kind * MAX_TEAMS * POSES];
    const anc = atlas.unitAnchor[idx] ?? atlas.unitAnchor[u.kind * MAX_TEAMS * POSES];
    const spr = new Sprite(tex);
    spr.anchor.set(anc.ax, anc.ay);
    spr.position.set(isoX(u.x, u.y), isoY(u.x, u.y, this.elevAt(u.x, u.y)));
    spr.zIndex = u.x + u.y;
    // Haritanin ortasina bakar.
    const c = this.d.world.mapSize / 2;
    spr.scale.x = isoX(c, c) - isoX(u.x, u.y) >= 0 ? 1 : -1;
    return spr;
  }

  private addSprite(u: PlacedUnit): void {
    const spr = this.spriteFor(u);
    this.d.world.entityLayer.addChild(spr);
    this.sprites.set(u, spr);
  }

  private dropSprite(u: PlacedUnit): void {
    const spr = this.sprites.get(u);
    if (spr) {
      spr.destroy();
      this.sprites.delete(u);
    }
  }

  private clearSprites(): void {
    for (const spr of this.sprites.values()) spr.destroy();
    this.sprites.clear();
  }

  /** Tum sprite'lari state'ten yeniden kurar (atlas/palet degisince, sahneye girerken). */
  refreshSprites(): void {
    this.clearSprites();
    for (const u of this.d.state.units) this.addSprite(u);
  }

  // ---- geri al / yinele ----

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    this.revert(op);
    this.redoStack.push(op);
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    this.revert({ type: op.type === 'add' ? 'remove' : 'add', units: op.units });
    this.undoStack.push(op);
  }

  /** op'u tersine uygular: add'i geri alirken siler, remove'u geri alirken ekler. */
  private revert(op: Op): void {
    const s = this.d.state;
    if (op.type === 'add') {
      const set = new Set(op.units);
      s.units = s.units.filter((u) => !set.has(u));
      for (const u of op.units) this.dropSprite(u);
    } else {
      for (const u of op.units) {
        s.units.push(u);
        this.addSprite(u);
      }
    }
    saveState(s);
    this.d.onChange();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // ---- toplu islemler ----

  /** Takimin (veya tumunun) askerlerini siler; geri alinabilir. */
  clear(team?: number): number {
    const s = this.d.state;
    const removed = s.units.filter((u) => team === undefined || u.team === team);
    if (removed.length === 0) return 0;
    const set = new Set(removed);
    s.units = s.units.filter((u) => !set.has(u));
    for (const u of removed) this.dropSprite(u);
    this.undoStack.push({ type: 'remove', units: removed });
    this.redoStack = [];
    saveState(s);
    this.d.onChange();
    return removed.length;
  }

  /**
   * Blok dizilim: onde yakin, ortada uzak, arkada sifaci/kusatma hatti. Harita merkezine bakar.
   * `army` verilmezse klasik karisim (Savasci/Okcu/Rahip + tanklar) kullanilir.
   */
  formation(team: number, army?: Record<Lane, number[]>): PlacedUnit[] {
    const s = this.d.state;
    const n = this.d.world.mapSize;
    const c = n / 2;
    const a = (3 * Math.PI) / 4 + (team * 2 * Math.PI) / s.teamCount;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const R = n * (s.teamCount === 2 ? 0.28 : 0.3);
    const px = c + dx * R;
    const py = c + dy * R;
    const lx = -dy;
    const ly = dx;
    const src = army ?? { front: [0, 0, 0, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], mid: [1, 1, 1, 1, 1, 1], back: [2, 2, 2] };
    // Hat basina en cok 10 birimlik satirlar; buyuk birimler kendi satirina daha fazla derinlik ister.
    const rows: number[][] = [];
    for (const lane of ['front', 'mid', 'back'] as Lane[]) {
      const kinds = src[lane].slice().sort((p, q) => p - q);
      for (let i = 0; i < kinds.length; i += 10) rows.push(kinds.slice(i, i + 10));
    }
    const out: PlacedUnit[] = [];
    let depth = 0;
    rows.forEach((row) => {
      const big = row.some((k) => STATS[k].scale > 1);
      row.forEach((kind, ci) => {
        const off = (ci - (row.length - 1) / 2) * (big ? 1.6 : 1.3);
        let x = px + dx * depth + lx * off;
        let y = py + dy * depth + ly * off;
        const t = this.d.world.terrain;
        if (t && !t.walkable(x, y)) {
          const q = t.nearestWalkable(x, y, 6);
          if (!q) return;
          x = q.x;
          y = q.y;
        }
        if (this.isValid(x, y, out)) out.push({ team, kind, x, y });
      });
      depth += big ? 1.8 : 1.35;
    });
    return out;
  }

  /** Secili takim icin formasyon ekler; secili tur kendi hattinin ana birimi olur (var olanlari silmez). */
  fillFormation(team: number): number {
    const s = this.d.state;
    const army = composeFromKind(s.selKind, this.rand);
    const added = this.formation(team, army).slice(0, Math.max(0, MAX_PLACED - s.units.length));
    this.addMany(added);
    return added.length;
  }

  /** Tum takimlari temizleyip rol dengeli rastgele hizli dizilim kurar. */
  quickFormation(): number {
    this.clear();
    let total = 0;
    for (let t = 0; t < this.d.state.teamCount; t++) total += this.addRandomArmy(t);
    return total;
  }

  /** Verilen takima rol dengeli rastgele ordu ekler. */
  addRandomArmy(team: number): number {
    const s = this.d.state;
    const added = this.formation(team, composeArmy(this.rand)).slice(0, Math.max(0, MAX_PLACED - s.units.length));
    this.addMany(added);
    return added.length;
  }

  /** Secili takim disindaki tum takimlara rastgele dusman ordusu ekler. */
  addRandomEnemies(): number {
    let total = 0;
    for (let t = 0; t < this.d.state.teamCount; t++) if (t !== this.d.state.selTeam) total += this.addRandomArmy(t);
    return total;
  }

  /** Her cagrida farkli sonuc: sabit tohumlu uretec degil. */
  private rand = (): number => Math.random();

  private addMany(added: PlacedUnit[]): void {
    if (added.length === 0) return;
    const s = this.d.state;
    for (const u of added) s.units.push(u);
    this.d.ensureAtlas();
    for (const u of added) if (!this.sprites.has(u)) this.addSprite(u);
    this.undoStack.push({ type: 'add', units: added });
    this.redoStack = [];
    saveState(s);
    this.d.onChange();
  }

  /** Harita degisince (tohum/cevre/boyut): gecersiz kalan birimleri tasir veya kaldirir. */
  revalidate(): { moved: number; removed: number } {
    const s = this.d.state;
    const t = this.d.world.terrain;
    let moved = 0;
    let removed = 0;
    const keep: PlacedUnit[] = [];
    for (const u of s.units) {
      if (!this.inMap(u.x, u.y)) {
        u.x = Math.min(this.d.world.mapSize - 0.5, Math.max(0.5, u.x));
        u.y = Math.min(this.d.world.mapSize - 0.5, Math.max(0.5, u.y));
      }
      if (t && !t.walkable(u.x, u.y)) {
        const q = t.nearestWalkable(u.x, u.y);
        if (q) {
          u.x = q.x;
          u.y = q.y;
          moved++;
        } else {
          removed++;
          continue;
        }
      }
      keep.push(u);
    }
    s.units = keep;
    this.undoStack = [];
    this.redoStack = [];
    saveState(s);
    this.refreshSprites();
    return { moved, removed };
  }

  /** Takim sayisi azalinca fazlalik takimlarin askerlerini kaldirir. */
  dropTeamsAbove(count: number): number {
    const s = this.d.state;
    const before = s.units.length;
    s.units = s.units.filter((u) => u.team < count);
    this.undoStack = [];
    this.redoStack = [];
    saveState(s);
    this.refreshSprites();
    return before - s.units.length;
  }

  /** [takim][tur] sayilari. */
  counts(): number[][] {
    const grid = Array.from({ length: MAX_TEAMS }, () => new Array(KIND_COUNT).fill(0));
    for (const u of this.d.state.units) grid[u.team][u.kind]++;
    return grid;
  }

  setSeedForRandom(seed: number): void {
    let a = seed >>> 0;
    this.rng = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

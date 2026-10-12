import { Application, Container, Graphics, Particle, ParticleContainer, Rectangle, Texture, TilingSprite } from 'pixi.js';
import { isoX, isoY } from '../iso';
import type { SimView } from '../sim/backend';
import { SIM_DT } from '../sim/constants';
import { Kind, STATS } from '../sim/units';
import { DEATH_FADE, UnitView } from './unitView';

const CELL_W = 64;
const CELL_H = 96;
const FEET_Y = 80;
const SHEET_COLS = 4;
const DEPTH_SCALE = 4;

export interface MassViewport {
  /** Gorunur dunya dikdortgeni (iso piksel). */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MassOptions {
  bars: boolean;
  sort: boolean;
  cull: boolean;
}

/**
 * Buyuk olcek renderer'i: tum birimler tek bir atlas dokusundan ParticleContainer
 * parcaciklari olarak cizilir (birim basina Container/Graphics yok).
 */
export class MassRenderer {
  readonly layer: Container;
  private readonly units = new ParticleContainer({
    dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
  });
  private readonly arrows = new ParticleContainer({
    dynamicProperties: { vertex: false, position: true, rotation: true, uvs: false, color: false },
  });
  private readonly bars = new ParticleContainer({
    dynamicProperties: { vertex: true, position: true, rotation: false, uvs: false, color: true },
  });
  private readonly unitTex: Texture[] = []; // [kind*4 + team*2 + pose]
  private arrowTex!: Texture;
  private pixelTex!: Texture;
  private particles: Particle[] = [];
  private arrowParticles: Particle[] = [];
  private barBg: Particle[] = [];
  private barFill: Particle[] = [];
  private keys = new Int32Array(0);
  private order = new Int32Array(0);
  private counts = new Int32Array(0);
  /** Son karede cizilen birim ve ok sayilari. */
  drawnUnits = 0;
  drawnArrows = 0;

  constructor(
    private readonly app: Application,
    private readonly sim: SimView,
  ) {
    this.layer = new Container();
    this.bakeAtlas();
    this.layer.addChild(this.units, this.arrows, this.bars);
    this.rebuild();
  }

  /** Zemin: iki tonlu elmas desenli TilingSprite, harita sekline maskeli. */
  buildGround(): Container {
    const n = this.sim.mapSize;
    const tile = new Container();
    const bg = new Graphics();
    bg.rect(0, 0, 64, 32).fill(0x6c9e48);
    bg.poly([32, 0, 64, 16, 32, 32, 0, 16]).fill(0x78ab52);
    tile.addChild(bg);
    const tex = this.app.renderer.generateTexture({ target: tile, frame: new Rectangle(0, 0, 64, 32), resolution: 1 });
    const ts = new TilingSprite({ texture: tex, width: n * 64, height: n * 32 });
    ts.position.set(-n * 32, 0);
    const mask = new Graphics();
    mask.poly([0, 0, n * 32, n * 16, 0, n * 32, -n * 32, n * 16]).fill(0xffffff);
    const root = new Container();
    root.addChild(ts, mask);
    ts.mask = mask;
    return root;
  }

  private bakeAtlas(): void {
    const sheet = new Container();
    const cell = (idx: number): { x: number; y: number } => ({
      x: (idx % SHEET_COLS) * CELL_W,
      y: Math.floor(idx / SHEET_COLS) * CELL_H,
    });

    for (let kind = 0; kind < 3; kind++) {
      for (let team = 0; team < 2; team++) {
        for (let pose = 0; pose < 2; pose++) {
          const idx = kind * 4 + team * 2 + pose;
          const view = new UnitView(kind, team, 0);
          view.update(
            { hp: 1, maxHp: 1, facing: 1, moving: false, swingProgress: pose ? 0.55 : -1, flash: false, deathT: -1 },
            0,
            0,
          );
          const c = cell(idx);
          view.root.position.set(c.x + CELL_W / 2, c.y + FEET_Y);
          sheet.addChild(view.root);
        }
      }
    }

    // Son satir: ok ve 4x4 beyaz piksel (saglik cubugu).
    const extra = cell(12);
    const g = new Graphics();
    g.moveTo(extra.x + 6, extra.y + 20).lineTo(extra.x + 22, extra.y + 20).stroke({ width: 2, color: 0x6b4a2b });
    g.poly([extra.x + 22, extra.y + 17, extra.x + 27, extra.y + 20, extra.x + 22, extra.y + 23]).fill(0xcfd4dc);
    g.poly([extra.x + 6, extra.y + 20, extra.x + 3, extra.y + 17, extra.x + 9, extra.y + 20, extra.x + 3, extra.y + 23]).fill(0xf2f2f2);
    g.rect(extra.x + 40, extra.y + 40, 4, 4).fill(0xffffff);
    sheet.addChild(g);

    const rows = Math.ceil(13 / SHEET_COLS);
    const frame = new Rectangle(0, 0, SHEET_COLS * CELL_W, rows * CELL_H);
    const atlas = this.app.renderer.generateTexture({ target: sheet, frame, resolution: 2, antialias: true });
    sheet.destroy({ children: true });

    for (let idx = 0; idx < 12; idx++) {
      const c = cell(idx);
      this.unitTex.push(new Texture({ source: atlas.source, frame: new Rectangle(c.x, c.y, CELL_W, CELL_H) }));
    }
    this.arrowTex = new Texture({ source: atlas.source, frame: new Rectangle(extra.x, extra.y + 8, 32, 24) });
    this.pixelTex = new Texture({ source: atlas.source, frame: new Rectangle(extra.x + 40, extra.y + 40, 4, 4) });
  }

  /** Birim sayisi degisince (restart) parcaciklari yeniden kurar. */
  rebuild(): void {
    const u = this.sim.units;
    this.particles = [];
    for (let i = 0; i < u.count; i++) {
      this.particles.push(
        new Particle({ texture: this.unitTex[u.kind[i] * 4 + u.team[i] * 2], anchorX: 0.5, anchorY: FEET_Y / CELL_H }),
      );
    }
    this.keys = new Int32Array(u.count);
    this.order = new Int32Array(u.count);
    this.counts = new Int32Array(Math.ceil(this.sim.mapSize * 2 * DEPTH_SCALE) + 4);
    this.units.particleChildren = [];
    this.arrows.particleChildren = [];
    this.bars.particleChildren = [];
  }

  sync(time: number, alpha: number, view: MassViewport, opt: MassOptions): void {
    const u = this.sim.units;
    const out = this.units.particleChildren;
    const keys = this.keys;
    const order = this.order;
    let n = 0;

    // 1) Gorunur birimleri topla, konumlari yaz.
    for (let i = 0; i < u.count; i++) {
      const alive = u.alive[i] === 1;
      if (!alive && u.deathT[i] > DEATH_FADE) continue;
      const wx = u.px[i] + (u.x[i] - u.px[i]) * alpha;
      const wy = u.py[i] + (u.y[i] - u.py[i]) * alpha;
      const sx = isoX(wx, wy);
      const sy = isoY(wx, wy);
      if (opt.cull && (sx < view.left || sx > view.right || sy < view.top || sy > view.bottom)) continue;

      const p = this.particles[i];
      const kind = u.kind[i];
      const moving = u.moving[i] === 1;
      const bob = moving ? Math.abs(Math.sin(time * 15 + i)) * 4 : 0;
      const swing = u.swing[i] > 0;
      const prog = swing ? 1 - u.swing[i] / STATS[kind].swing : 0;
      let off = 0;
      if (swing) off = kind === Kind.Warrior ? Math.sin(prog * Math.PI) * 11 : kind === Kind.Archer ? -Math.sin(prog * Math.PI) * 4 : 0;
      p.x = sx + off * u.facing[i];
      p.y = sy - bob;
      p.scaleX = u.facing[i];
      p.texture = this.unitTex[kind * 4 + u.team[i] * 2 + (swing && prog > 0.3 ? 1 : 0)];
      if (alive) {
        p.scaleY = 1;
        p.rotation = 0;
        p.tint = u.flash[i] > 0 ? 0xff9a9a : 0xffffff;
        p.alpha = 1;
      } else {
        const k = Math.min(1, u.deathT[i] / DEATH_FADE);
        p.alpha = 1 - k;
        p.rotation = u.facing[i] * k * 1.2;
        p.scaleY = 1 - k * 0.2;
      }
      keys[n] = Math.min(this.counts.length - 2, Math.max(0, ((wx + wy) * DEPTH_SCALE) | 0));
      order[n] = i;
      n++;
    }

    // 2) Derinlik: x+y anahtarina gore sayma siralamasi (O(n)).
    out.length = n;
    if (opt.sort) {
      const counts = this.counts;
      counts.fill(0);
      for (let k = 0; k < n; k++) counts[keys[k] + 1]++;
      for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
      for (let k = 0; k < n; k++) out[counts[keys[k]]++] = this.particles[order[k]];
    } else {
      for (let k = 0; k < n; k++) out[k] = this.particles[order[k]];
    }
    this.drawnUnits = n;

    this.syncArrows(view, alpha * SIM_DT);
    this.syncBars(alpha, view, opt.bars);
  }

  private syncArrows(view: MassViewport, advance: number): void {
    const p = this.sim.projectiles;
    const out = this.arrows.particleChildren;
    let n = 0;
    for (let i = 0; i < p.count; i++) {
      if (!p.active[i]) continue;
      const k = Math.min(1, (p.t[i] + advance) / p.dur[i]);
      const k2 = Math.min(1, k + 0.03);
      const wx = p.sx[i] + (p.tx[i] - p.sx[i]) * k;
      const wy = p.sy[i] + (p.ty[i] - p.sy[i]) * k;
      const wx2 = p.sx[i] + (p.tx[i] - p.sx[i]) * k2;
      const wy2 = p.sy[i] + (p.ty[i] - p.sy[i]) * k2;
      const x = isoX(wx, wy);
      const y = isoY(wx, wy, 4 * p.height[i] * k * (1 - k));
      if (x < view.left || x > view.right || y < view.top || y > view.bottom) continue;
      let part = this.arrowParticles[n];
      if (!part) {
        part = new Particle({ texture: this.arrowTex, anchorX: 0.5, anchorY: 0.5 });
        this.arrowParticles[n] = part;
      }
      part.x = x;
      part.y = y;
      part.rotation = Math.atan2(isoY(wx2, wy2, 4 * p.height[i] * k2 * (1 - k2)) - y, isoX(wx2, wy2) - x);
      out[n++] = part;
    }
    out.length = n;
    this.drawnArrows = n;
  }

  private syncBars(alpha: number, view: MassViewport, enabled: boolean): void {
    const out = this.bars.particleChildren;
    if (!enabled) {
      out.length = 0;
      return;
    }
    const u = this.sim.units;
    let n = 0;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i] || u.hp[i] >= u.maxHp[i]) continue;
      const wx = u.px[i] + (u.x[i] - u.px[i]) * alpha;
      const wy = u.py[i] + (u.y[i] - u.py[i]) * alpha;
      const sx = isoX(wx, wy);
      const sy = isoY(wx, wy) - 72;
      if (sx < view.left || sx > view.right || sy < view.top || sy > view.bottom) continue;
      const ratio = u.hp[i] / u.maxHp[i];
      let bg = this.barBg[n];
      let fill = this.barFill[n];
      if (!bg) {
        bg = new Particle({ texture: this.pixelTex, anchorX: 0.5, anchorY: 0.5, scaleX: 34 / 4, scaleY: 5 / 4, tint: 0x1a1a1a });
        fill = new Particle({ texture: this.pixelTex, anchorX: 0.5, anchorY: 0.5, scaleY: 3 / 4 });
        this.barBg[n] = bg;
        this.barFill[n] = fill;
      }
      bg.x = sx;
      bg.y = sy;
      fill.x = sx - 16 + 16 * ratio;
      fill.y = sy;
      fill.scaleX = (32 * ratio) / 4;
      fill.tint = ratio > 0.5 ? 0x4cc35b : ratio > 0.25 ? 0xe6b73a : 0xe0463b;
      out[2 * n] = bg;
      out[2 * n + 1] = fill;
      n++;
    }
    out.length = 2 * n;
  }
}

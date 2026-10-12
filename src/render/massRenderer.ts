import { PALETTES } from './biome';
import { Application, Container, Graphics, Particle, ParticleContainer, Rectangle, Texture, TilingSprite } from 'pixi.js';
import type { Terrain } from '../sim/terrain';
import type { Atlas } from './atlas';
import { isoX, isoY } from '../iso';
import type { SimView } from '../sim/backend';
import { SIM_DT } from '../sim/constants';
import { MAX_TEAMS, STATS, isMelee, isRanged, isTank } from '../sim/units';
import { DEATH_FADE, POSES, statusTint } from './unitView';
import { projStyle } from './projectileStyle';

const DEPTH_SCALE = 4;

export interface MassViewport {
  /** Gorunur dunya dikdortgeni (iso piksel). */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Kamera yakinlastirmasi (1 = normal); uzakta animasyon sakinlestirilir. */
  zoom?: number;
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
  private readonly unitTex: Texture[]; // [(kind*MAX_TEAMS + team)*2 + poz]
  private readonly unitAnchor: Array<{ ax: number; ay: number }>;
  private readonly arrowTex: Texture;
  private readonly orbTex: Texture;
  private readonly pixelTex: Texture;
  private particles: Particle[] = [];
  private decorParticles: Particle[] = [];
  private decorKey: Int32Array = new Int32Array(0);
  private decorX: Float32Array = new Float32Array(0);
  private decorY: Float32Array = new Float32Array(0);
  private arrowParticles: Particle[] = [];
  private barBg: Particle[] = [];
  private barFill: Particle[] = [];
  /** Birim basina: yuruyus fazi, hareket miktari (0..1, yumusak), son siralama anahtari, suzulmus ekran konumu. */
  private phase = new Float32Array(0);
  private moveAmt = new Float32Array(0);
  private lastKey = new Int32Array(0);
  private fsx = new Float32Array(0);
  private fsy = new Float32Array(0);
  private lastTime = -1;
  private keys = new Int32Array(0);
  private order = new Int32Array(0);
  private counts = new Int32Array(0);
  /** Son karede cizilen birim ve ok sayilari. */
  drawnUnits = 0;
  drawnDecor = 0;
  drawnArrows = 0;

  constructor(
    private readonly app: Application,
    private readonly sim: SimView,
    atlas: Atlas,
    private readonly terrain: Terrain | null,
  ) {
    this.layer = new Container();
    this.unitTex = atlas.unitTex;
    this.unitAnchor = atlas.unitAnchor;
    this.arrowTex = atlas.arrowTex;
    this.orbTex = atlas.fx.puff.texture;
    this.pixelTex = atlas.pixelTex;
    this.buildDecor(atlas);
    this.layer.addChild(this.units, this.arrows, this.bars);
    this.rebuild();
  }

  /** Zemin: iki tonlu elmas desenli TilingSprite, harita sekline maskeli. */
  buildGround(): Container {
    const n = this.sim.mapSize;
    const tile = new Container();
    const bg = new Graphics();
    const pal = PALETTES[this.terrain?.spec.biome ?? 'forest'];
    bg.rect(0, 0, 64, 32).fill(pal.grassB);
    bg.poly([32, 0, 64, 16, 32, 32, 0, 16]).fill(pal.grassA);
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

  private buildDecor(atlas: Atlas): void {
    const decor = this.terrain ? this.terrain.decor : [];
    const n = decor.length;
    this.decorKey = new Int32Array(n);
    this.decorX = new Float32Array(n);
    this.decorY = new Float32Array(n);
    this.decorParticles = [];
    const maxKey = Math.ceil(this.sim.mapSize * 2 * DEPTH_SCALE) + 2;
    decor.forEach((d, i) => {
      const list = atlas.decor[d.kind];
      const spr = list[d.variant % list.length];
      this.decorX[i] = isoX(d.x, d.y);
      this.decorY[i] = isoY(d.x, d.y);
      this.decorKey[i] = Math.min(maxKey, Math.max(0, ((d.x + d.y) * DEPTH_SCALE) | 0));
      this.decorParticles.push(new Particle({ texture: spr.texture, x: this.decorX[i], y: this.decorY[i], anchorX: spr.ax, anchorY: spr.ay }));
    });
  }

  /** Birim sayisi degisince (restart) parcaciklari yeniden kurar. */
  rebuild(): void {
    const u = this.sim.units;
    this.particles = [];
    for (let i = 0; i < u.count; i++) {
      this.particles.push(
        new Particle({
          texture: this.unitTex[(u.kind[i] * MAX_TEAMS + u.team[i]) * POSES],
          anchorX: this.unitAnchor[(u.kind[i] * MAX_TEAMS + u.team[i]) * POSES].ax,
          anchorY: this.unitAnchor[(u.kind[i] * MAX_TEAMS + u.team[i]) * POSES].ay,
        }),
      );
    }
    this.phase = new Float32Array(u.count);
    this.moveAmt = new Float32Array(u.count);
    this.lastKey = new Int32Array(u.count).fill(-1);
    this.fsx = new Float32Array(u.count);
    this.fsy = new Float32Array(u.count);
    for (let i = 0; i < u.count; i++) this.phase[i] = (i * 2.399963) % 6.283185;
    this.lastTime = -1;
    this.keys = new Int32Array(u.count + this.decorParticles.length);
    this.order = new Int32Array(u.count + this.decorParticles.length);
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
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const zoom = view.zoom ?? 1;
    // Uzakta (kucuk piksel) sekme ve poz degisimi titreme gibi gorunur: sakinlestir.
    const calm = Math.min(1, Math.max(0, (zoom - 0.3) / 0.5));
    const follow = 1 - Math.exp(-dt * 30);
    const ease = 1 - Math.exp(-dt * 9);

    // 1) Gorunur birimleri topla, konumlari yaz.
    for (let i = 0; i < u.count; i++) {
      const alive = u.alive[i] === 1;
      if (!alive && u.deathT[i] > DEATH_FADE) continue;
      const wx = u.px[i] + (u.x[i] - u.px[i]) * alpha;
      const wy = u.py[i] + (u.y[i] - u.py[i]) * alpha;
      let sx = isoX(wx, wy);
      let sy = isoY(wx, wy);
      // Hafif alcak gecirgen konum filtresi: sim-ici kucuk titresimler gorunmez (isinlanma: dogrudan).
      if (this.lastKey[i] >= 0 && dt > 0) {
        const jx = sx - this.fsx[i];
        const jy = sy - this.fsy[i];
        if (jx * jx + jy * jy < 900) {
          sx = this.fsx[i] + jx * follow;
          sy = this.fsy[i] + jy * follow;
        }
      }
      this.fsx[i] = sx;
      this.fsy[i] = sy;
      if (opt.cull && (sx < view.left || sx > view.right || sy < view.top || sy > view.bottom)) continue;

      const p = this.particles[i];
      const kind = u.kind[i];
      // Hareket miktari yumusak (histerezis): durup kalkan birim her karede poz degistirmez.
      const target = u.moving[i] === 1 ? 1 : 0;
      this.moveAmt[i] += (target - this.moveAmt[i]) * ease;
      const amt = this.moveAmt[i];
      const moving = amt > 0.55;
      if (moving) this.phase[i] += dt * 11;
      const bob = moving ? Math.abs(Math.sin(this.phase[i])) * 4 * calm * amt : 0;
      const swing = u.swing[i] > 0;
      const prog = swing ? 1 - u.swing[i] / STATS[kind].swing : 0;
      let off = 0;
      if (swing) off = isMelee(kind) && !isTank(kind) ? Math.sin(prog * Math.PI) * 11 : isRanged(kind) ? -Math.sin(prog * Math.PI) * 4 : 0;
      p.x = sx + off * u.facing[i];
      p.y = sy - bob;
      p.scaleX = u.facing[i];
      // Poz: saldirida hazirlik/vurus, hareketteyse yuruyus A/B, degilse bekleme.
      let pose = 0;
      if (swing) pose = prog < 0.4 ? 3 : prog < 0.7 ? 4 : 0;
      else if (moving && calm > 0.25) pose = Math.sin(this.phase[i]) >= 0 ? 1 : 2;
      p.texture = this.unitTex[(kind * MAX_TEAMS + u.team[i]) * POSES + pose];
      if (alive) {
        p.scaleY = 1;
        p.rotation = moving ? 0.08 * u.facing[i] * calm * amt : 0;
        p.tint = u.flash[i] > 0 ? 0xff9a9a : u.status[i] !== 0 ? statusTint(u.status[i]) : 0xffffff;
        p.alpha = 1;
      } else {
        const k = Math.min(1, u.deathT[i] / DEATH_FADE);
        p.alpha = 1 - k;
        p.rotation = u.facing[i] * k * 1.2;
        p.scaleY = 1 - k * 0.2;
      }
      // Derinlik anahtari histerezisi: kucuk degisimde sira ayni kalir (ust uste birimler titremez).
      let key = Math.min(this.counts.length - 2, Math.max(0, ((wx + wy) * DEPTH_SCALE) | 0));
      const lk = this.lastKey[i];
      if (lk >= 0 && Math.abs(key - lk) < 2) key = lk;
      this.lastKey[i] = key;
      keys[n] = key;
      order[n] = i;
      n++;
    }

    // Dekor: statik; ayni siralamaya girer (indeks >= birim sayisi).
    const nUnits = n;
    const uc = this.particles.length;
    for (let d = 0; d < this.decorParticles.length; d++) {
      const sx = this.decorX[d];
      const sy = this.decorY[d];
      if (opt.cull && (sx < view.left - 60 || sx > view.right + 60 || sy < view.top - 20 || sy > view.bottom + 160)) continue;
      keys[n] = this.decorKey[d];
      order[n] = uc + d;
      n++;
    }

    // 2) Derinlik: x+y anahtarina gore sayma siralamasi (O(n)).
    out.length = n;
    if (opt.sort) {
      const counts = this.counts;
      counts.fill(0);
      for (let k = 0; k < n; k++) counts[keys[k] + 1]++;
      for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
      for (let k = 0; k < n; k++) out[counts[keys[k]]++] = order[k] < uc ? this.particles[order[k]] : this.decorParticles[order[k] - uc];
    } else {
      for (let k = 0; k < n; k++) out[k] = order[k] < uc ? this.particles[order[k]] : this.decorParticles[order[k] - uc];
    }
    this.drawnUnits = nUnits;
    this.drawnDecor = n - nUnits;

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
      const st = projStyle(p.tag[i]);
      part.texture = st.orb ? this.orbTex : this.arrowTex;
      part.tint = st.color;
      part.scaleX = part.scaleY = st.scale;
      part.rotation = st.orb ? 0 : Math.atan2(isoY(wx2, wy2, 4 * p.height[i] * k2 * (1 - k2)) - y, isoX(wx2, wy2) - x);
      out[n++] = part;
    }
    out.length = n;
    this.drawnArrows = n;
  }

  private syncBars(alpha: number, view: MassViewport, enabled: boolean): void {
    const out = this.bars.particleChildren;
    if (!enabled || (view.zoom ?? 1) < 0.3) {
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
      const k = STATS[u.kind[i]].scale;
      const barW = 34 * Math.sqrt(k);
      const sy = isoY(wx, wy) - 72 * k;
      if (sx < view.left || sx > view.right || sy < view.top || sy > view.bottom) continue;
      const ratio = u.hp[i] / u.maxHp[i];
      let bg = this.barBg[n];
      let fill = this.barFill[n];
      if (!bg) {
        bg = new Particle({ texture: this.pixelTex, anchorX: 0.5, anchorY: 0.5, scaleY: 5 / 4, tint: 0x1a1a1a });
        fill = new Particle({ texture: this.pixelTex, anchorX: 0.5, anchorY: 0.5, scaleY: 3 / 4 });
        this.barBg[n] = bg;
        this.barFill[n] = fill;
      }
      bg.x = sx;
      bg.y = sy;
      bg.scaleX = (barW + 2) / 4;
      fill.x = sx - barW / 2 + (barW * ratio) / 2;
      fill.y = sy;
      fill.scaleX = (barW * ratio) / 4;
      fill.tint = ratio > 0.5 ? 0x4cc35b : ratio > 0.25 ? 0xe6b73a : 0xe0463b;
      out[2 * n] = bg;
      out[2 * n + 1] = fill;
      n++;
    }
    out.length = 2 * n;
  }
}

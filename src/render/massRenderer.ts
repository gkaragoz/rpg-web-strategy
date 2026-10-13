import { PALETTES } from './biome';
import { comedy, hash01 } from './comedyFlag';
import { Application, Container, Graphics, Particle, ParticleContainer, Rectangle, Texture, TilingSprite, type IParticle } from 'pixi.js';
import type { Terrain } from '../sim/terrain';
import type { Atlas } from './atlas';
import { isoX, isoY } from '../iso';
import type { SimView } from '../sim/backend';
import { SIM_DT } from '../sim/constants';
import { MAX_TEAMS, STATS, isMelee, isRanged, isTank } from '../sim/units';
import { DEATH_FADE, POSES, statusTint } from './unitView';
import { projStyle } from './projectileStyle';
import { flatColorFilter, setFlatColor } from './outlineFilter';

const DEPTH_SCALE = 4;
/** Below this camera zoom units are drawn idle-pose only (no walk/strike animation math). */
const FAR_ZOOM = 0.3;
/** Most silhouette particles drawn for the focus outline (4 per soldier): beyond this the outline is thinned out. */
const FOCUS_MAX = 12000;

export interface MassViewport {
  /** Visible world rectangle (iso pixels). */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Camera zoom (1 = normal); animation is calmed when zoomed out. */
  zoom?: number;
}

export interface MassOptions {
  bars: boolean;
  sort: boolean;
  cull: boolean;
  /** Team whose soldiers are outlined (-1: none) and the outline colour. */
  focusTeam?: number;
  focusColor?: number;
}

/**
   * Large-scale renderer: all units are drawn as ParticleContainer particles from a single
   * atlas texture (no Container/Graphics per unit).
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
  /** High-ground chevrons above units that stand on elevated terrain. */
  private readonly marks = new ParticleContainer({
    dynamicProperties: { vertex: false, position: true, rotation: false, uvs: false, color: false },
  });
  private readonly chevronTex: Texture;
  private markParticles: Particle[] = [];
  private markSx = new Float32Array(0);
  private markSy = new Float32Array(0);
  private markLevel = new Uint8Array(0);
  /** Coloured silhouettes (4 offset copies per soldier) under the units: together they read as an outline. */
  private readonly focusLayer = new ParticleContainer({
    dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: false },
  });
  private readonly focusFilter = flatColorFilter(0xffffff);
  private focusColorNow = -1;
  private focusParticles: Particle[] = [];
  private readonly unitTex: Texture[]; // [(kind*MAX_TEAMS + team)*2 + pose]
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
  /** Per unit: walk phase, movement amount (0..1, smoothed), last sort key, smoothed screen position. */
  private phase = new Float32Array(0);
  private moveAmt = new Float32Array(0);
  private lastKey = new Int32Array(0);
  private fsx = new Float32Array(0);
  private fsy = new Float32Array(0);
  private lastTime = -1;
  /** Highest on-screen rise of any terrain tile (px): lets sync() reject off-screen units before the elevation lookup. */
  private maxRise = 0;
  private minRise = 0;
  private keys = new Int32Array(0);
  private order = new Int32Array(0);
  private counts = new Int32Array(0);
  /** Unit and arrow counts drawn in the last frame. */
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
    this.chevronTex = this.makeChevron();
    this.buildDecor(atlas);
    this.maxRise = this.computeMaxRise();
    const span = this.sim.mapSize * 34 + 300;
    this.focusLayer.boundsArea = new Rectangle(-span, -400, span * 2, span + 800);
    this.focusLayer.filters = [this.focusFilter];
    this.focusLayer.visible = false;
    this.layer.addChild(this.focusLayer, this.units, this.arrows, this.bars, this.marks);
    this.rebuild();
  }

  /** Small gold chevron (^) drawn above units standing on high ground. */
  private makeChevron(): Texture {
    const g = new Graphics();
    g.poly([0, 0, 8, 8, 5.5, 10.5, 0, 5, -5.5, 10.5, -8, 8]).fill(0xf2c14e).stroke({ width: 1.2, color: 0x2a1f05, alpha: 0.85 });
    return this.app.renderer.generateTexture({ target: g, resolution: 2, frame: new Rectangle(-10, -2, 20, 16) });
  }

  /** Releases the layer and the textures this renderer created (called when the battle ends). */
  destroy(): void {
    this.layer.destroy({ children: true });
    this.chevronTex.destroy(true);
  }

  /** Ground: two-tone diamond-pattern TilingSprite, masked to the map shape. */
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
      this.decorY[i] = isoY(d.x, d.y, this.terrain ? this.terrain.elevPx(d.x, d.y) : 0);
      this.decorKey[i] = Math.min(maxKey, Math.max(0, ((d.x + d.y) * DEPTH_SCALE) | 0));
      this.decorParticles.push(new Particle({ texture: spr.texture, x: this.decorX[i], y: this.decorY[i], anchorX: spr.ax, anchorY: spr.ay }));
    });
  }

  private computeMaxRise(): number {
    const t = this.terrain;
    if (!t || !t.hasRelief) return 0;
    let hi = 0;
    let lo = 0;
    const n = this.sim.mapSize;
    for (let y = 0; y <= n; y++)
      for (let x = 0; x <= n; x++) {
        const e = t.elevPx(Math.min(x, n - 0.01), Math.min(y, n - 0.01));
        hi = Math.max(hi, e);
        lo = Math.min(lo, e);
      }
    this.minRise = lo - 8;
    return hi + 8;
  }

  /** Rebuilds the particles when the unit count changes (restart). */
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
    this.markSx = new Float32Array(u.count);
    this.markSy = new Float32Array(u.count);
    this.markLevel = new Uint8Array(u.count);
    for (let i = 0; i < u.count; i++) this.phase[i] = (i * 2.399963) % 6.283185;
    this.lastTime = -1;
    this.keys = new Int32Array(u.count + this.decorParticles.length);
    this.order = new Int32Array(u.count + this.decorParticles.length);
    this.counts = new Int32Array(Math.ceil(this.sim.mapSize * 2 * DEPTH_SCALE) + 4);
    this.units.particleChildren = [];
    this.arrows.particleChildren = [];
    this.bars.particleChildren = [];
    this.marks.particleChildren = [];
    this.focusLayer.particleChildren = [];
  }

  /** Four copies shifted by ~2 px behind the unit = an outline (returns the new particle count of the focus layer). */
  private pushOutline(fn: number, p: Particle, fOut: IParticle[], fd: number): number {
    for (let c = 0; c < 4; c++) {
      let f = this.focusParticles[fn];
      if (!f) f = this.focusParticles[fn] = new Particle({ texture: p.texture, anchorX: p.anchorX, anchorY: p.anchorY });
      f.texture = p.texture;
      f.anchorX = p.anchorX;
      f.anchorY = p.anchorY;
      f.x = p.x + (c === 0 ? fd : c === 1 ? -fd : 0);
      f.y = p.y + (c === 2 ? fd : c === 3 ? -fd : 0);
      f.scaleX = p.scaleX;
      f.scaleY = p.scaleY;
      f.rotation = p.rotation;
      fOut[fn++] = f;
    }
    return fn;
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
    const terr = this.terrain;
    const relief = !!terr && terr.hasRelief;
    // When zoomed out (small pixels) bouncing and pose changes look like flicker: calm them.
    const calm = Math.min(1, Math.max(0, (zoom - 0.3) / 0.5));
    const far = zoom < FAR_ZOOM;
    const follow = 1 - Math.exp(-dt * 30);
    const ease = 1 - Math.exp(-dt * 9);

    // 1) Collect visible units, write positions.
    this.markLevel.fill(0);
    const focus = opt.focusTeam ?? -1;
    const fOut = this.focusLayer.particleChildren;
    let fn = 0;
    const fd = 2.4 / Math.max(0.3, zoom);
    for (let i = 0; i < u.count; i++) {
      const alive = u.alive[i] === 1;
      if (!alive && (comedy.visual || u.deathT[i] > DEATH_FADE)) continue;
      const wx = u.px[i] + (u.x[i] - u.px[i]) * alpha;
      const wy = u.py[i] + (u.y[i] - u.py[i]) * alpha;
      let sx = isoX(wx, wy);
      const lift = u.lift ? u.lift[i] : 0;
      if (opt.cull) {
        // Cheap rejection before the terrain lookup: the on-screen y lies between y(flat) - maxRise and y(flat).
        const flatY = isoY(wx, wy, 0);
        if (sx < view.left || sx > view.right || flatY - this.minRise < view.top || flatY - this.maxRise - lift * 38 > view.bottom) {
          this.fsx[i] = sx;
          this.fsy[i] = flatY;
          continue;
        }
      }
      let sy = isoY(wx, wy, (relief ? terr!.elevPx(wx, wy) : 0) + lift * 38);
      // Slight low-pass position filter: tiny jitters inside the sim are not visible (teleport: direct).
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
      if (alive && relief) {
        // Standing higher than its current target (half steps): that is what earns the damage and range bonus.
        const adv = u.hgAdv[i];
        this.markLevel[i] = adv >= 6 ? 3 : adv >= 4 ? 2 : adv >= 2 ? 1 : 0;
        this.markSx[i] = sx;
        this.markSy[i] = sy;
      }

      const p = this.particles[i];
      const kind = u.kind[i];
      if (far && alive && !comedy.visual) {
        // Zoomed far out nobody can see poses or bobbing: idle pose, facing, hit flash / status tint only.
        p.x = sx;
        p.y = sy;
        p.scaleX = u.facing[i];
        p.scaleY = 1;
        p.rotation = 0;
        p.texture = this.unitTex[(kind * MAX_TEAMS + u.team[i]) * POSES];
        p.tint = u.flash[i] > 0 ? 0xff9a9a : u.status[i] !== 0 ? statusTint(u.status[i]) : 0xffffff;
        p.alpha = 1;
        if (focus >= 0 && u.team[i] === focus && fn < FOCUS_MAX) fn = this.pushOutline(fn, p, fOut, fd);
        let key = Math.min(this.counts.length - 2, Math.max(0, ((wx + wy) * DEPTH_SCALE) | 0));
        const lk = this.lastKey[i];
        if (lk >= 0 && Math.abs(key - lk) < 2) key = lk;
        this.lastKey[i] = key;
        keys[n] = key;
        order[n] = i;
        n++;
        continue;
      }
      // Movement amount is smoothed (hysteresis): a unit that stops and starts does not change pose every frame.
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
      // Pose: wind-up/strike when attacking, walk A/B when moving, otherwise idle.
      let pose = 0;
      if (swing) pose = prog < 0.4 ? 3 : prog < 0.7 ? 4 : 0;
      else if (moving && calm > 0.25) pose = Math.sin(this.phase[i]) >= 0 ? 1 : 2;
      if (lift > 0.04) pose = 4;
      p.texture = this.unitTex[(kind * MAX_TEAMS + u.team[i]) * POSES + pose];
      if (alive && comedy.visual) {
        // Comedy: wobbling walk, springy body, squash-stretch on strike, occasional stumble.
        const wob = Math.sin(this.phase[i] * 0.5 + i) * 0.22 * amt * calm;
        const trip = hash01(i * 31 + Math.floor(time * 0.35)) < 0.012 ? 0.9 * Math.sin((time * 0.35 % 1) * Math.PI) : 0;
        p.rotation = (moving ? 0.1 * calm * amt : 0) * u.facing[i] + wob + trip * u.facing[i];
        const hit = u.flash[i] > 0 ? 1 : 0;
        const spring = 1 + 0.12 * Math.sin(this.phase[i] * 2) * amt * calm;
        p.scaleX = u.facing[i] * (spring * (1 - 0.08 * Math.sin(this.phase[i] * 2) * amt) + hit * 0.35);
        p.scaleY = spring - hit * 0.3;
        p.tint = u.flash[i] > 0 ? 0xff9a9a : u.status[i] !== 0 ? statusTint(u.status[i]) : 0xffffff;
        p.alpha = 1;
      } else if (alive) {
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
      // In the air (comedy physics): spins fast.
      if (alive && lift > 0.04) p.rotation = (time * 13 + i) * u.facing[i];
      if (focus >= 0 && alive && u.team[i] === focus && fn < FOCUS_MAX) fn = this.pushOutline(fn, p, fOut, fd);
      // Depth key hysteresis: on small changes the order stays the same (overlapping units do not flicker).
      let key = Math.min(this.counts.length - 2, Math.max(0, ((wx + wy) * DEPTH_SCALE) | 0));
      const lk = this.lastKey[i];
      if (lk >= 0 && Math.abs(key - lk) < 2) key = lk;
      this.lastKey[i] = key;
      keys[n] = key;
      order[n] = i;
      n++;
    }

    fOut.length = fn;
    this.focusLayer.visible = fn > 0;
    if (fn > 0 && (opt.focusColor ?? 0xffffff) !== this.focusColorNow) {
      this.focusColorNow = opt.focusColor ?? 0xffffff;
      setFlatColor(this.focusFilter, this.focusColorNow);
    }

    // Decor: static; enters the same sort (index >= unit count).
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

    // 2) Depth: counting sort by the x+y key (O(n)).
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
    this.syncMarks(zoom);
  }

  private syncMarks(zoom: number): void {
    const out = this.marks.particleChildren;
    if (!this.terrain || !this.terrain.hasRelief || zoom < 0.3) {
      out.length = 0;
      return;
    }
    const u = this.sim.units;
    let n = 0;
    for (let i = 0; i < u.count; i++) {
      const lvl = this.markLevel[i];
      if (lvl === 0) continue;
      const k = STATS[u.kind[i]].scale;
      for (let c = 0; c < lvl; c++) {
        let part = this.markParticles[n];
        if (!part) {
          part = new Particle({ texture: this.chevronTex, anchorX: 0.5, anchorY: 0.5 });
          this.markParticles[n] = part;
        }
        part.x = this.markSx[i];
        part.y = this.markSy[i] - 84 * k - c * 5;
        out[n++] = part;
      }
    }
    out.length = n;
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
      const ez = this.terrain && this.terrain.hasRelief ? this.terrain.elevPx(wx, wy) : 0;
      const y = isoY(wx, wy, ez + 4 * p.height[i] * k * (1 - k));
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
      part.rotation = st.orb ? 0 : Math.atan2(isoY(wx2, wy2, ez + 4 * p.height[i] * k2 * (1 - k2)) - y, isoX(wx2, wy2) - x);
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
      const sy = isoY(wx, wy, (this.terrain && this.terrain.hasRelief ? this.terrain.elevPx(wx, wy) : 0) + (u.lift ? u.lift[i] * 38 : 0)) - 72 * k;
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

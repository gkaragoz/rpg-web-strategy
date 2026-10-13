import { ParticleContainer, Particle } from 'pixi.js';
import { isoX, isoY } from '../iso';
import type { SimEvent } from '../sim/battle';
import { MAX_TEAMS, STATS } from '../sim/units';
import { T_WATER, type Terrain } from '../sim/terrain';
import type { Atlas } from './atlas';
import { hash01 } from './comedyFlag';
import { POSES } from './unitView';

export { comedy } from './comedyFlag';

const MAX_BODIES = 160;
const GRAV = 1150; // pixels/s^2
const SLIDE_FRICTION = 5.2;

const St = { Free: 0, Fly: 1, Slide: 2, Rest: 3, Sink: 4 } as const;

const hash = hash01;

/**
    * Ragdoll death system: a dead unit launches into the air with its atlas texture, spins, bounces 1-2 times, slides, stays
    * on the ground briefly and fades. Units that fall onto water sink. Occasionally a small piece (hat/star) breaks off and flies.
    * Render-only: no effect on the sim. For sound/effects, synthetic events are written to the `events` array.
 */
export class ComedySystem {
  readonly layer: ParticleContainer;
  /** Synthetic events produced during update() (burst: element 7 = confetti/splat, 8 = whoosh). */
  readonly events: SimEvent[] = [];
  private readonly parts: Particle[] = [];
  private readonly n = MAX_BODIES;
  private readonly st = new Uint8Array(MAX_BODIES);
  private readonly wx = new Float32Array(MAX_BODIES);
  private readonly wy = new Float32Array(MAX_BODIES);
  private readonly z = new Float32Array(MAX_BODIES);
  private readonly vx = new Float32Array(MAX_BODIES);
  private readonly vy = new Float32Array(MAX_BODIES);
  private readonly vz = new Float32Array(MAX_BODIES);
  private readonly rot = new Float32Array(MAX_BODIES);
  private readonly vrot = new Float32Array(MAX_BODIES);
  private readonly life = new Float32Array(MAX_BODIES);
  private readonly bounces = new Uint8Array(MAX_BODIES);
  private readonly flip = new Int8Array(MAX_BODIES);
  private readonly bit = new Uint8Array(MAX_BODIES);
  private readonly centerDy = new Float32Array(MAX_BODIES);
  private cursor = 0;
  private seq = 1;
  private live = 0;

  constructor(
    private readonly atlas: Atlas,
    private readonly terrain: Terrain | null,
    private readonly elev: (x: number, y: number) => number,
  ) {
    this.layer = new ParticleContainer({
      dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
    });
    for (let i = 0; i < this.n; i++) this.parts.push(new Particle({ texture: atlas.pixelTex, anchorX: 0.5, anchorY: 0.5 }));
    this.layer.particleChildren = [];
  }

  get active(): number {
    return this.live;
  }

  clear(): void {
    this.st.fill(St.Free);
    this.live = 0;
    this.layer.particleChildren.length = 0;
    this.events.length = 0;
  }

  /** Spawns a ragdoll from a death event. power: damage of the final blow; angle: direction away from the hit (world). */
  spawnDeath(x: number, y: number, angle: number, power: number, kind: number, team: number, facing: number, crowd: number): void {
    // With very large crowds the ragdoll count is limited (readability/performance).
    if (crowd > 1500 && hash(this.seq * 7) > 0.3) return;
    if (crowd > 600 && hash(this.seq * 5) > 0.7) return;
    const idx = (kind * MAX_TEAMS + team) * POSES;
    const tex = this.atlas.unitTex[idx] ?? this.atlas.unitTex[kind * MAX_TEAMS * POSES];
    const anc = this.atlas.unitAnchor[idx] ?? this.atlas.unitAnchor[kind * MAX_TEAMS * POSES];
    if (!tex || !anc) return;
    const i = this.take();
    const r = hash(this.seq++);
    const heavy = STATS[kind].scale > 1 ? 0.55 : 1;
    const sp = (4 + Math.min(7.5, Math.sqrt(Math.max(1, power)) * 0.62)) * heavy * (0.8 + r * 0.45);
    this.wx[i] = x;
    this.wy[i] = y;
    this.z[i] = 6;
    this.vx[i] = Math.cos(angle) * sp;
    this.vy[i] = Math.sin(angle) * sp;
    this.vz[i] = (340 + hash(this.seq++) * 220) * (0.75 + heavy * 0.25);
    this.rot[i] = 0;
    this.vrot[i] = (hash(this.seq++) < 0.5 ? -1 : 1) * (5 + hash(this.seq++) * 10) * heavy;
    this.life[i] = 0;
    this.bounces[i] = 0;
    this.flip[i] = facing >= 0 ? 1 : -1;
    this.bit[i] = 0;
    this.st[i] = St.Fly;
    const p = this.parts[i];
    p.texture = tex;
    p.anchorX = 0.5;
    p.anchorY = 0.5;
    p.alpha = 1;
    p.scaleX = this.flip[i];
    p.scaleY = 1;
    p.tint = 0xffffff;
    // The foot point is at the anchor; vertical shift for the body center (texture pixels).
    this.centerDy[i] = (anc.ay - 0.5) * tex.height;
    this.live++;
    this.events.push({ type: 'burst', x, y, unit: -1, value: 0.8, element: 8 });
    // Occasionally a piece breaks off: hat / star.
    if (hash(this.seq++) < 0.45) this.spawnBit(x, y, angle, power);
  }

  private spawnBit(x: number, y: number, angle: number, power: number): void {
    const i = this.take();
    const a = angle + (hash(this.seq++) - 0.5) * 1.6;
    const sp = 5 + Math.min(8, Math.sqrt(Math.max(1, power)) * 0.7) + hash(this.seq++) * 3;
    this.wx[i] = x;
    this.wy[i] = y;
    this.z[i] = 40;
    this.vx[i] = Math.cos(a) * sp;
    this.vy[i] = Math.sin(a) * sp;
    this.vz[i] = 480 + hash(this.seq++) * 260;
    this.rot[i] = 0;
    this.vrot[i] = (hash(this.seq++) - 0.5) * 30;
    this.life[i] = 0;
    this.bounces[i] = 1;
    this.flip[i] = 1;
    this.bit[i] = 1;
    this.st[i] = St.Fly;
    const p = this.parts[i];
    p.texture = this.atlas.fx.star.texture;
    p.anchorX = 0.5;
    p.anchorY = 0.5;
    p.alpha = 1;
    p.scaleX = p.scaleY = 0.85;
    p.tint = hash(this.seq++) < 0.5 ? 0xffd84a : 0xff7ab8;
    this.centerDy[i] = 0;
    this.live++;
  }

  /** Free slot (if full, reuses the oldest). */
  private take(): number {
    for (let k = 0; k < this.n; k++) {
      const i = (this.cursor + k) % this.n;
      if (this.st[i] === St.Free) {
        this.cursor = (i + 1) % this.n;
        return i;
      }
    }
    const i = this.cursor;
    this.cursor = (i + 1) % this.n;
    if (this.st[i] !== St.Free) this.live--;
    this.st[i] = St.Free;
    return i;
  }

  update(dt: number): void {
    const out = this.layer.particleChildren;
    let w = 0;
    const ter = this.terrain;
    for (let i = 0; i < this.n; i++) {
      const s = this.st[i];
      if (s === St.Free) continue;
      this.life[i] += dt;
      const p = this.parts[i];
      if (s === St.Fly || s === St.Slide) {
        this.wx[i] += this.vx[i] * dt;
        this.wy[i] += this.vy[i] * dt;
        const nmax = ter ? ter.size - 0.5 : 1000;
        if (this.wx[i] < 0.5 || this.wx[i] > nmax) {
          this.wx[i] = Math.min(nmax, Math.max(0.5, this.wx[i]));
          this.vx[i] *= -0.4;
        }
        if (this.wy[i] < 0.5 || this.wy[i] > nmax) {
          this.wy[i] = Math.min(nmax, Math.max(0.5, this.wy[i]));
          this.vy[i] *= -0.4;
        }
      }
      if (s === St.Fly) {
        this.vz[i] -= GRAV * dt;
        this.z[i] += this.vz[i] * dt;
        this.rot[i] += this.vrot[i] * dt;
        if (this.z[i] <= 0) {
          this.z[i] = 0;
          const water = ter ? ter.flags[(this.wy[i] | 0) * ter.size + (this.wx[i] | 0)] === T_WATER : false;
          if (water && !this.bit[i]) {
            this.st[i] = St.Sink;
            this.life[i] = 0;
            this.events.push({ type: 'burst', x: this.wx[i], y: this.wy[i], unit: -1, value: 1.6, element: 2 });
          } else if (this.bit[i]) {
            this.free(i);
            continue;
          } else {
            if (this.bounces[i] === 0) this.events.push({ type: 'burst', x: this.wx[i], y: this.wy[i], unit: -1, value: 1.4, element: 7 });
            if (Math.abs(this.vz[i]) > 140 && this.bounces[i] < 2) {
              this.vz[i] = -this.vz[i] * 0.38;
              this.vx[i] *= 0.62;
              this.vy[i] *= 0.62;
              this.vrot[i] *= 0.55;
              this.bounces[i]++;
            } else {
              this.st[i] = St.Slide;
              this.life[i] = 0;
            }
          }
        }
      } else if (s === St.Slide) {
        const f = Math.exp(-SLIDE_FRICTION * dt);
        this.vx[i] *= f;
        this.vy[i] *= f;
        // Lying down: ease toward the nearest lying angle (±90 degrees).
        const target = Math.round(this.rot[i] / Math.PI) * Math.PI + (this.flip[i] > 0 ? 1 : -1) * (Math.PI / 2) * (1 - 0);
        this.rot[i] += (target - this.rot[i]) * Math.min(1, dt * 7);
        if (Math.hypot(this.vx[i], this.vy[i]) < 0.35) {
          this.st[i] = St.Rest;
          this.life[i] = 0;
        }
      } else if (s === St.Rest) {
        if (this.life[i] > 3.2) {
          p.alpha = Math.max(0, 1 - (this.life[i] - 3.2) / 0.7);
          if (p.alpha <= 0) {
            this.free(i);
            continue;
          }
        }
      } else if (s === St.Sink) {
        p.alpha = Math.max(0, 1 - this.life[i] / 0.55);
        this.z[i] -= 60 * dt;
        if (p.alpha <= 0) {
          this.free(i);
          continue;
        }
      }
      const e = this.elev(this.wx[i], this.wy[i]);
      const lift = this.bit[i] ? 0 : this.centerDy[i];
      p.x = isoX(this.wx[i], this.wy[i]);
      p.y = isoY(this.wx[i], this.wy[i], e + this.z[i]) - lift;
      p.rotation = this.rot[i] * (this.bit[i] ? 1 : this.flip[i]);
      out[w++] = p;
    }
    out.length = w;
  }

  private free(i: number): void {
    this.st[i] = St.Free;
    this.live--;
  }
}

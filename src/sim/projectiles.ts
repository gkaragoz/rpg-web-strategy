/** Projectile flags: piercing, skill-triggered. */
export const PF_PIERCE = 1;
export const PF_SKILL = 2;

export class Projectiles {
  readonly cap: number;
  count = 0;
  active: Uint8Array;
  sx: Float32Array;
  sy: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  t: Float32Array;
  dur: Float32Array;
  height: Float32Array;
  dmg: Float32Array;
  team: Uint8Array;
  /** Payload: shooter unit (-1: none), area radius and flags (PF_*). */
  src: Int32Array;
  splash: Float32Array;
  flags: Uint8Array;
  /** Look tag (PROJ_TAG in units.ts). */
  tag: Uint8Array;
  cursor = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.active = new Uint8Array(cap);
    this.sx = new Float32Array(cap);
    this.sy = new Float32Array(cap);
    this.tx = new Float32Array(cap);
    this.ty = new Float32Array(cap);
    this.t = new Float32Array(cap);
    this.dur = new Float32Array(cap);
    this.height = new Float32Array(cap);
    this.dmg = new Float32Array(cap);
    this.team = new Uint8Array(cap);
    this.src = new Int32Array(cap).fill(-1);
    this.splash = new Float32Array(cap);
    this.flags = new Uint8Array(cap);
    this.tag = new Uint8Array(cap);
  }

  clear(): void {
    this.active.fill(0);
    this.count = 0;
    this.cursor = 0;
  }

  spawn(sx: number, sy: number, tx: number, ty: number, dur: number, height: number, dmg: number, team: number, src = -1, splash = 0, flags = 0, tag = 0): void {
    // Look for a free slot with a rotating cursor: avoids scanning the whole array every time.
    let i = this.cursor;
    let tries = 0;
    while (this.active[i] && tries < this.cap) {
      i = (i + 1) % this.cap;
      tries++;
    }
    if (tries === this.cap) return;
    this.cursor = (i + 1) % this.cap;
    this.active[i] = 1;
    this.sx[i] = sx;
    this.sy[i] = sy;
    this.tx[i] = tx;
    this.ty[i] = ty;
    this.t[i] = 0;
    this.dur[i] = dur;
    this.height[i] = height;
    this.dmg[i] = dmg;
    this.team[i] = team;
    this.src[i] = src;
    this.splash[i] = splash;
    this.flags[i] = flags;
    this.tag[i] = tag;
    if (i >= this.count) this.count = i + 1;
  }

  update(dt: number, land: (x: number, y: number, team: number, dmg: number, idx: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      if (!this.active[i]) continue;
      this.t[i] += dt;
      if (this.t[i] >= this.dur[i]) {
        this.active[i] = 0;
        land(this.tx[i], this.ty[i], this.team[i], this.dmg[i], i);
      }
    }
  }
}

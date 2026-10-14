import { MAX_TEAMS } from '../sim/units';

/** World units per sprite pixel (the 2D sprites are drawn for a 64 px wide tile; a soldier is about 1.2 tiles tall). */
export const PX_WORLD = 0.026;
/** Poses baked into the atlas: 0 idle, 1-2 walk A/B, 3 attack wind-up, 4 strike (same as render/unitView). */
export const POSES = 5;
export const DEATH_FADE = 0.7;

/** Sprite frames of the atlas in the form the GPU wants (see `atlasBridge`). */
export interface FrameTable {
  /** u0, v0, u1, v1 per frame (v0 bottom, three.js texture space). */
  uv: Float32Array;
  /** Anchor (ground contact point) as fractions of the frame, from the top-left, per frame. */
  anchor: Float32Array;
  /** Width and height in world units per frame. */
  size: Float32Array;
  has: Uint8Array;
}

export function newFrameTable(frames: number): FrameTable {
  return { uv: new Float32Array(frames * 4), anchor: new Float32Array(frames * 2), size: new Float32Array(frames * 2), has: new Uint8Array(frames) };
}

export const unitFrame = (kind: number, team: number, pose: number): number => (kind * MAX_TEAMS + team) * POSES + pose;

/** The unit fields the writer reads (a `UnitsView` or the sim's `Units`). */
export interface UnitsLike {
  count: number;
  kind: ArrayLike<number>;
  team: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  px: ArrayLike<number>;
  py: ArrayLike<number>;
  hp: ArrayLike<number>;
  maxHp: ArrayLike<number>;
  alive: ArrayLike<number>;
  facing: ArrayLike<number>;
  moving: ArrayLike<number>;
  swing: ArrayLike<number>;
  flash: ArrayLike<number>;
  deathT: ArrayLike<number>;
  status: ArrayLike<number>;
  lift?: ArrayLike<number>;
}

/** Status tint as 0xRRGGBB (same palette as the 2D view). */
export function statusRGB(st: number): number {
  if (st === 0) return 0xffffff;
  if (st & 32) return 0xfff2b0;
  if (st & 4) return 0xffc56a;
  if (st & 2) return 0xffa070;
  if (st & 1) return 0x9ad8ff;
  if (st & 16) return 0xbfe9ff;
  if (st & 8) return 0xd0b0ff;
  if (st & 64) return 0xffb0b0;
  return 0xffffff;
}

/**
 * Per-instance data of the unit billboards, rewritten every frame:
 * iA = x, y (up), z, facing; iB = width, height, anchorX, anchorY(from top); iUV = u0, v0, u1, v1; iC = flash, outline, tint (0xRRGGBB), fade.
 * `bars` collects health bars of damaged units: feet x, y (up), z, ratio / width, head height above the feet.
 */
export class UnitInstances {
  readonly iA: Float32Array;
  readonly iB: Float32Array;
  readonly iUV: Float32Array;
  readonly iC: Float32Array;
  readonly bar: Float32Array;
  readonly barB: Float32Array;
  readonly shadow: Float32Array;
  count = 0;
  barCount = 0;
  private readonly phase: Float32Array;
  private readonly moveAmt: Float32Array;

  constructor(readonly capacity: number) {
    this.iA = new Float32Array(capacity * 4);
    this.iB = new Float32Array(capacity * 4);
    this.iUV = new Float32Array(capacity * 4);
    this.iC = new Float32Array(capacity * 4);
    this.bar = new Float32Array(capacity * 4);
    this.barB = new Float32Array(capacity * 2);
    this.shadow = new Float32Array(capacity * 4);
    this.phase = new Float32Array(capacity);
    this.moveAmt = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) this.phase[i] = (i * 2.399963) % 6.283185;
  }

  /**
   * Fills the instance arrays for all units visible this frame. `ground(x, y)` is the terrain height; `scaleOf(kind)` the unit's
   * size factor for health bars; swing durations come from `swingTime(kind)` (pose progress).
   */
  write(
    u: UnitsLike,
    alpha: number,
    dt: number,
    frames: FrameTable,
    ground: (x: number, y: number) => number,
    opts: { focusTeam: number; swingTime: (kind: number) => number; showBars: boolean },
  ): void {
    const ease = 1 - Math.exp(-dt * 9);
    let n = 0;
    let b = 0;
    const n0 = Math.min(u.count, this.capacity);
    for (let i = 0; i < n0; i++) {
      const alive = u.alive[i] === 1;
      const dead = u.deathT[i];
      if (!alive && dead > DEATH_FADE) continue;
      const kind = u.kind[i];
      const team = u.team[i];
      const wx = u.px[i] + (u.x[i] - u.px[i]) * alpha;
      const wy = u.py[i] + (u.y[i] - u.py[i]) * alpha;
      // Pose: strike / wind-up while swinging, walk cycle while moving, otherwise idle.
      const target = u.moving[i] === 1 ? 1 : 0;
      this.moveAmt[i] += (target - this.moveAmt[i]) * ease;
      const amt = this.moveAmt[i];
      const moving = amt > 0.55;
      if (moving) this.phase[i] += dt * 11;
      let pose = 0;
      const sw = u.swing[i] > 0 ? opts.swingTime(kind) : 0;
      if (sw > 0) {
        const prog = 1 - u.swing[i] / sw;
        pose = prog < 0.4 ? 3 : prog < 0.7 ? 4 : 0;
      } else if (moving) pose = Math.sin(this.phase[i]) >= 0 ? 1 : 2;
      const f = unitFrame(kind, team, pose);
      if (frames.has[f] === 0) continue;
      const bob = moving ? Math.abs(Math.sin(this.phase[i])) * 0.09 * amt : 0;
      const lift = u.lift ? u.lift[i] * 38 * PX_WORLD : 0;
      const gy = ground(wx, wy);
      const w = frames.size[f * 2];
      let h = frames.size[f * 2 + 1];
      let fade = 1;
      if (!alive) {
        const k = Math.min(1, dead / DEATH_FADE);
        h *= 1 - k * 0.7;
        fade = 1 - k;
      }
      const o = n * 4;
      this.iA[o] = wx;
      this.iA[o + 1] = gy + bob + lift;
      this.iA[o + 2] = wy;
      this.iA[o + 3] = u.facing[i] >= 0 ? 1 : -1;
      this.iB[o] = w;
      this.iB[o + 1] = h;
      this.iB[o + 2] = frames.anchor[f * 2];
      this.iB[o + 3] = frames.anchor[f * 2 + 1];
      // Four scalar writes: `subarray` would allocate a view per unit per frame (30 000 objects of garbage).
      this.iUV[o] = frames.uv[f * 4];
      this.iUV[o + 1] = frames.uv[f * 4 + 1];
      this.iUV[o + 2] = frames.uv[f * 4 + 2];
      this.iUV[o + 3] = frames.uv[f * 4 + 3];
      this.iC[o] = u.flash[i] > 0 ? 1 : 0;
      this.iC[o + 1] = alive && opts.focusTeam >= 0 && team === opts.focusTeam ? 1 : 0;
      this.iC[o + 2] = statusRGB(u.status[i]);
      this.iC[o + 3] = fade;
      this.shadow[o] = wx;
      this.shadow[o + 1] = gy;
      this.shadow[o + 2] = wy;
      this.shadow[o + 3] = alive ? Math.max(0.5, Math.min(1.6, w / 1.4)) * (0.6 + 0.4 * fade) : 0.4 * fade;
      if (opts.showBars && alive && u.hp[i] < u.maxHp[i]) {
        const bo = b * 4;
        this.bar[bo] = wx;
        this.bar[bo + 1] = gy + bob + lift; // feet; the shader adds the head height along the leaning axis
        this.bar[bo + 2] = wy;
        this.bar[bo + 3] = u.hp[i] / u.maxHp[i];
        this.barB[b * 2] = Math.max(0.55, Math.min(1.4, w * 0.7));
        this.barB[b * 2 + 1] = h * frames.anchor[f * 2 + 1] + 0.12;
        b++;
      }
      n++;
    }
    this.count = n;
    this.barCount = b;
  }
}

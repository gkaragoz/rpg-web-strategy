import { Container, Graphics } from 'pixi.js';
import { Kind, LEGACY_COUNT, STATS } from '../sim/units';
import { comedy } from './comedyFlag';
import { LOOKS, type Anim, type Rig } from './looks';

const SCALE = 1.25;
const SKIN = 0xf2c9a0;
const SKIN_D = 0xa87b55;
const BROWN = 0x8b5a2b;
const STEEL = 0x8d96a3;
const STEEL_D = 0x5b6470;

export interface TeamColors {
  main: number;
  dark: number;
}

export interface ViewState {
  hp: number;
  maxHp: number;
  facing: number;
  moving: boolean;
  /** Attack progress 0..1, -1 if not attacking. */
  swingProgress: number;
  flash: boolean;
  /** Death animation time, -1 if alive. */
  deathT: number;
  /** For atlas baking: pins the walk phase. */
  phase?: number;
  /** Visual status mask (ST_*): slow, burning, stun... */
  status?: number;
  /** Comedy physics: height in the air (tiles); 0 = on the ground. */
  lift?: number;
}

/** Tint from the status mask (0xffffff: no effect). Priority: invulnerable > stun > burning > slow > shield > fear > taunt. */
export function statusTint(st: number): number {
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

export const DEATH_FADE = 0.7;

/** Poses baked into the atlas: 0 idle, 1-2 walk A/B, 3 attack wind-up, 4 strike. */
export const POSES = 5;
export const POSE_STATES: ViewState[] = [
  { hp: 1, maxHp: 1, facing: 1, moving: false, swingProgress: -1, flash: false, deathT: -1 },
  { hp: 1, maxHp: 1, facing: 1, moving: true, swingProgress: -1, flash: false, deathT: -1, phase: Math.PI / 2 },
  { hp: 1, maxHp: 1, facing: 1, moving: true, swingProgress: -1, flash: false, deathT: -1, phase: -Math.PI / 2 },
  { hp: 1, maxHp: 1, facing: 1, moving: false, swingProgress: 0.3, flash: false, deathT: -1 },
  { hp: 1, maxHp: 1, facing: 1, moving: false, swingProgress: 0.52, flash: false, deathT: -1 },
];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeOutBack = (t: number): number => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/** Attack phases: wind-up (0-0.4), strike (0.4-0.6), recovery (0.6-1). */
function attackPhases(p: number): { wind: number; strike: number; recover: number } {
  if (p < 0) return { wind: 0, strike: 0, recover: 0 };
  return { wind: clamp01(p / 0.4), strike: clamp01((p - 0.4) / 0.2), recover: clamp01((p - 0.6) / 0.4) };
}

export class UnitView {
  /** Health bar mode: 'damaged' when hurt, 'always' always, 'never' never. */
  static barMode: 'damaged' | 'always' | 'never' = 'damaged';

  readonly root = new Container();
  private readonly rig = new Container();
  private readonly inner = new Container();
  private readonly torso = new Container();
  private readonly legL = new Graphics();
  private readonly legR = new Graphics();
  private readonly bar = new Graphics();
  /** Gold chevrons above the head while the unit stands on high ground (0-3). */
  private readonly mark = new Graphics();
  private markLevel = 0;
  private readonly shadow: Graphics;
  private weapon: Container | null = null;
  private shield: Container | null = null;
  private orb: Graphics | null = null;
  private staff: Graphics | null = null;
  private nock: Graphics | null = null;
  /** Roster units (kind >= LEGACY_COUNT): animation family and initial stances. */
  private anim: Anim | null = null;
  private fists: Container | null = null;
  private restRot = 0;
  private weaponX = 0;
  private weaponY = 0;
  private phase: number;
  private lastHpRatio = -1;
  private readonly kind: number;
  private readonly kScale: number;
  private readonly base: number;
  private faceCur = 1;
  private age = 0;
  private hurtT = 0;
  private prevFlash = false;
  private readonly seed: number;

  constructor(kind: number, colors: TeamColors, seed: number) {
    this.kind = kind;
    this.seed = seed;
    this.kScale = STATS[kind].scale;
    this.base = SCALE * this.kScale;
    this.phase = seed * 1.7;

    const shadow = new Graphics();
    shadow
      .ellipse(0, 0, 15 * this.kScale, 7.5 * this.kScale)
      .fill({ color: 0x000000, alpha: 0.22 })
      .stroke({ width: 2 * Math.sqrt(this.kScale), color: colors.main, alpha: 0.95 });
    this.shadow = shadow;
    this.root.addChild(shadow);

    this.inner.y = -16;
    this.torso.pivot.set(0, 15);
    this.torso.position.set(0, 15);
    this.inner.addChild(this.legL, this.legR, this.torso);
    this.rig.addChild(this.inner);
    this.rig.scale.set(this.base);
    this.root.addChild(this.rig);
    if (kind >= LEGACY_COUNT && STATS[kind].troop && LOOKS[STATS[kind].troop!]) this.drawLook(kind, colors.main, colors.dark);
    else this.draw(kind, colors.main, colors.dark);

    this.bar.y = -72 * this.kScale;
    this.bar.visible = false;
    this.root.addChild(this.bar);
    this.mark.y = -84 * this.kScale;
    this.root.addChild(this.mark);
  }

  /** High-ground marker: `level` chevrons (0 hides it); only redrawn when the level changes. */
  setHighGround(level: number): void {
    if (level === this.markLevel) return;
    this.markLevel = level;
    this.mark.clear();
    for (let c = 0; c < level; c++) {
      const y = -c * 5;
      this.mark.poly([0, y, 8, y + 8, 5.5, y + 10.5, 0, y + 5, -5.5, y + 10.5, -8, y + 8]).fill(0xf2c14e).stroke({ width: 1.2, color: 0x2a1f05, alpha: 0.85 });
    }
    this.mark.visible = level > 0;
  }

  /** Roster unit: draws from the recipe table (looks.ts). */
  private drawLook(kind: number, c: number, d: number): void {
    const rig: Rig = {
      torso: this.torso,
      back: new Graphics(),
      g: new Graphics(),
      legL: this.legL,
      legR: this.legR,
      weapon: null,
      shield: null,
      orb: null,
      staff: null,
      nock: null,
      fists: null,
      noHands: false,
      skin: SKIN,
    };
    this.torso.addChild(rig.back, rig.g);
    this.anim = LOOKS[STATS[kind].troop!](rig, c, d);
    this.weapon = rig.weapon;
    this.shield = rig.shield;
    this.orb = rig.orb;
    this.staff = rig.staff;
    this.nock = rig.nock;
    this.fists = rig.fists;
    if (rig.weapon) {
      this.restRot = rig.weapon.rotation;
      this.weaponX = rig.weapon.x;
      this.weaponY = rig.weapon.y;
    }
    if (!rig.noHands && !rig.fists) {
      const hands = new Graphics();
      hands.circle(-13, 2, 3.5).fill(SKIN).stroke({ width: 1, color: SKIN_D });
      hands.circle(16, 2, 3.5).fill(SKIN).stroke({ width: 1, color: SKIN_D });
      this.torso.addChild(hands);
    }
  }

  private draw(kind: number, c: number, d: number): void {
    const g = new Graphics();
    const legCol = kind === Kind.Shield ? 0x4b4b52 : 0x5a4636;
    this.legL.roundRect(-8, 8, 6, 9, 2).fill(legCol);
    this.legR.roundRect(2, 8, 6, 9, 2).fill(legCol);

    if (kind === Kind.Warrior) {
      g.ellipse(-15, 2, 5, 8).fill(c).stroke({ width: 1.5, color: d });
    }

    // Body
    if (kind === Kind.Shield) {
      g.roundRect(-12, -8, 24, 21, 5).fill(STEEL).stroke({ width: 1.5, color: STEEL_D });
      g.rect(-12, 2, 24, 3).fill(d);
    } else if (kind === Kind.Brute) {
      g.roundRect(-13, -9, 26, 22, 6).fill(c).stroke({ width: 1.5, color: d });
      g.rect(-13, 4, 26, 3).fill(0x4a3a2e);
    } else {
      g.roundRect(-11, -6, 22, 18, 6)
        .fill(kind === Kind.Priest ? 0xf4f1ea : c)
        .stroke({ width: 1.5, color: kind === Kind.Priest ? 0xb9b3a3 : d });
      if (kind === Kind.Priest) g.rect(-11, 2, 22, 4).fill(c);
    }

    if (kind === Kind.Brute) {
      g.circle(-14, -8, 6.5).fill(STEEL).stroke({ width: 1.2, color: STEEL_D });
      g.circle(14, -8, 6.5).fill(STEEL).stroke({ width: 1.2, color: STEEL_D });
    }

    // Head
    const headY = kind === Kind.Shield ? -15 : kind === Kind.Brute ? -16 : -14;
    const headR = kind === Kind.Shield ? 11 : kind === Kind.Brute ? 10.5 : 12;
    if (kind === Kind.Shield) {
      g.circle(0, headY, headR).fill(0x9aa3b0).stroke({ width: 1.5, color: STEEL_D });
      g.rect(-8, headY - 2, 16, 4).fill(0x2b2f36);
      g.roundRect(-2, headY - 21, 4, 9, 1).fill(c);
    } else {
      g.circle(0, headY, headR).fill(SKIN).stroke({ width: 1.5, color: SKIN_D });
      g.circle(-3, headY, 1.7).fill(0x222222);
      g.circle(5, headY, 1.7).fill(0x222222);
    }

    if (kind === Kind.Warrior) {
      g.moveTo(-12.5, -15).arc(0, -15, 12.5, Math.PI, Math.PI * 2).closePath().fill(0xaab1bc).stroke({ width: 1.2, color: 0x6b7280 });
      g.roundRect(-2, -31, 4, 8, 1).fill(c);
    } else if (kind === Kind.Archer) {
      g.moveTo(-13, -13).arc(0, -13, 13, Math.PI, Math.PI * 2).quadraticCurveTo(0, -21, -13, -13).closePath().fill(d);
    } else if (kind === Kind.Priest) {
      g.ellipse(0, -30, 9, 3).stroke({ width: 2, color: 0xf2c230 });
    } else if (kind === Kind.Brute) {
      g.moveTo(-11, headY - 2).arc(0, headY - 2, 11, Math.PI, Math.PI * 2).closePath().fill(0x6f7782).stroke({ width: 1.2, color: 0x444444 });
      g.poly([-10, headY - 6, -17, headY - 17, -6, headY - 10]).fill(0xe9e1c8).stroke({ width: 0.8, color: 0x8a826a });
      g.poly([10, headY - 6, 17, headY - 17, 6, headY - 10]).fill(0xe9e1c8).stroke({ width: 0.8, color: 0x8a826a });
    }
    this.torso.addChild(g);

    if (kind === Kind.Warrior) {
      const w = new Container();
      w.position.set(15.5, 4);
      const blade = new Graphics();
      blade.rect(-1.7, -22, 3.4, 24).fill(0xc9ced6).stroke({ width: 0.8, color: 0x6b7280 });
      blade.rect(-4.5, 1, 9, 3).fill(BROWN);
      blade.rect(-1.2, 3, 2.4, 6).fill(BROWN);
      w.addChild(blade);
      w.rotation = 0.25;
      this.weapon = w;
      this.torso.addChild(w);
    } else if (kind === Kind.Archer) {
      const w = new Container();
      w.position.set(18, 0);
      const bow = new Graphics();
      bow.moveTo(0, -14).quadraticCurveTo(14, 0, 0, 14).stroke({ width: 2.5, color: BROWN });
      bow.moveTo(0, -14).lineTo(0, 14).stroke({ width: 0.8, color: 0x666666 });
      w.addChild(bow);
      // Arrow nocked on the bow (visible only while drawing).
      const nock = new Graphics();
      nock.moveTo(-9, 0).lineTo(11, 0).stroke({ width: 1.8, color: 0x6b4a2b });
      nock.poly([11, -2.5, 16, 0, 11, 2.5]).fill(0xcfd4dc);
      nock.visible = false;
      w.addChild(nock);
      this.nock = nock;
      this.weapon = w;
      this.torso.addChild(w);
    } else if (kind === Kind.Priest) {
      const staff = new Graphics();
      staff.moveTo(0, -18).lineTo(0, 14).stroke({ width: 2.5, color: BROWN });
      staff.position.set(17, 0);
      this.staff = staff;
      this.torso.addChild(staff);
      const orb = new Graphics();
      orb.circle(0, 0, 4.5).fill(0xffe27a).stroke({ width: 1.2, color: 0xd4a017 });
      orb.position.set(17, -21);
      this.orb = orb;
      this.torso.addChild(orb);
    } else if (kind === Kind.Shield) {
      const sh = new Container();
      sh.position.set(17, 1);
      const plate = new Graphics();
      plate.roundRect(-6, -15, 12, 30, 4).fill(c).stroke({ width: 1.5, color: d });
      plate.circle(0, 0, 3.5).fill(0xe9e1c8).stroke({ width: 0.8, color: 0x8a826a });
      plate.rect(-6, -15, 12, 3).fill({ color: 0xffffff, alpha: 0.25 });
      sh.addChild(plate);
      this.shield = sh;
      this.torso.addChild(sh);
      const sword = new Graphics();
      sword.rect(-13.7, -4, 3, 15).fill(0xc9ced6).stroke({ width: 0.8, color: 0x6b7280 });
      this.torso.addChild(sword);
    } else if (kind === Kind.Brute) {
      const w = new Container();
      w.position.set(17, 3);
      const hammer = new Graphics();
      hammer.rect(-1.7, -24, 3.4, 34).fill(BROWN);
      hammer.roundRect(-8, -32, 16, 11, 2).fill(STEEL).stroke({ width: 1, color: STEEL_D });
      hammer.rect(-8, -28, 16, 2).fill(STEEL_D);
      w.addChild(hammer);
      w.rotation = 0.2;
      this.weapon = w;
      this.torso.addChild(w);
    }

    const hands = new Graphics();
    hands.circle(-13, 2, 3.5).fill(SKIN).stroke({ width: 1, color: SKIN_D });
    const rx = kind === Kind.Warrior ? 15.5 : kind === Kind.Brute ? 17 : 16;
    const ry = kind === Kind.Warrior ? 4 : kind === Kind.Brute ? 3 : 0;
    hands.circle(rx, ry, 3.5).fill(SKIN).stroke({ width: 1, color: SKIN_D });
    this.torso.addChild(hands);
  }

  update(s: ViewState, time: number, dt: number): void {
    const alive = s.deathT < 0;
    this.age += dt;
    if (dt === 0) this.faceCur = s.facing;
    else this.faceCur += (s.facing - this.faceCur) * Math.min(1, dt * 14);

    this.phase = s.phase !== undefined ? s.phase : this.phase + dt * (s.moving ? 13 : 2);
    const sw = Math.sin(this.phase);

    // Legs: walk with alternating feet.
    if (s.moving) {
      this.legL.y = sw * 2.6;
      this.legR.y = -sw * 2.6;
      this.legL.x = -sw * 0.8;
      this.legR.x = sw * 0.8;
    } else {
      this.legL.y = this.legR.y = this.legL.x = this.legR.x = 0;
    }

    const cz = comedy.visual && alive;
    let bob = (s.moving ? Math.abs(sw) * 2.8 : Math.sin(time * 2.2 + this.seed) * 0.5) * (cz ? 1.9 : 1);
    let lean = s.moving ? 0.09 + sw * 0.025 : 0;
    let ox = 0;
    let sx = 1;
    let sy = 1;
    const p = s.swingProgress;
    const { wind, strike, recover } = attackPhases(p);
    const rest = 1 - recover; // return after the strike

    switch (this.kind) {
      case Kind.Warrior: {
        if (this.weapon) {
          this.weapon.rotation =
            p < 0 ? 0.25 : p < 0.4 ? lerp(0.25, -1.4, easeOut(wind)) : p < 0.6 ? lerp(-1.4, 1.3, strike) : lerp(1.3, 0.25, easeOut(recover));
        }
        if (p >= 0) {
          ox = p < 0.4 ? -3 * wind : p < 0.6 ? lerp(-3, 10, strike) : lerp(10, 0, recover);
          lean = p < 0.4 ? -0.12 * wind : p < 0.6 ? lerp(-0.12, 0.2, strike) : lerp(0.2, 0, recover);
        }
        break;
      }
      case Kind.Archer: {
        const draw = clamp01(p / 0.55);
        const released = p >= 0.55;
        if (this.nock) this.nock.visible = p >= 0 && !released;
        if (this.weapon) this.weapon.scale.x = p < 0 ? 1 : released ? lerp(1.15, 1, recover) : 1 + 0.35 * easeOut(draw);
        if (p >= 0) {
          ox = released ? -3 * rest : -2.5 * draw;
          lean = released ? -0.05 * rest : -0.1 * draw;
        }
        break;
      }
      case Kind.Priest: {
        if (this.orb) {
          const up = p < 0 ? 0 : p < 0.6 ? easeOut(clamp01(p / 0.5)) : 1 - recover;
          this.orb.y = -21 - 9 * up;
          this.orb.scale.set(p >= 0 ? 1 + 0.9 * up : 1 + Math.sin(time * 4 + this.seed) * 0.08);
        }
        if (this.staff) this.staff.rotation = p >= 0 ? -0.22 * (p < 0.6 ? clamp01(p / 0.5) : 1 - recover) : 0;
        break;
      }
      case Kind.Shield: {
        if (this.shield) {
          this.shield.x = p < 0 ? 17 : p < 0.4 ? lerp(17, 8, easeOut(wind)) : p < 0.6 ? lerp(8, 31, strike) : lerp(31, 17, easeOut(recover));
          this.shield.rotation = p < 0.4 ? 0 : p < 0.6 ? 0.16 * strike : 0.16 * (1 - recover);
        }
        if (p >= 0) {
          ox = p < 0.4 ? -2 * wind : p < 0.6 ? lerp(-2, 7, strike) : lerp(7, 0, recover);
          lean = p < 0.4 ? -0.08 * wind : p < 0.6 ? lerp(-0.08, 0.14, strike) : lerp(0.14, 0, recover);
        }
        break;
      }
      default: {
        const wp = this.weapon;
        switch (this.anim) {
          case 'swing': {
            if (wp) wp.rotation = p < 0 ? this.restRot : p < 0.4 ? lerp(this.restRot, -1.4, easeOut(wind)) : p < 0.6 ? lerp(-1.4, 1.3, strike) : lerp(1.3, this.restRot, easeOut(recover));
            if (this.shield) this.shield.x = p < 0 ? -15 : p < 0.6 ? lerp(-15, -11, easeOut(wind)) : lerp(-11, -15, recover);
            if (p >= 0) {
              ox = p < 0.4 ? -3 * wind : p < 0.6 ? lerp(-3, 9, strike) : lerp(9, 0, recover);
              lean = p < 0.4 ? -0.12 * wind : p < 0.6 ? lerp(-0.12, 0.2, strike) : lerp(0.2, 0, recover);
            }
            break;
          }
          case 'thrust': {
            if (wp) {
              wp.x = this.weaponX + (p < 0 ? 0 : p < 0.4 ? -5 * wind : p < 0.6 ? lerp(-5, 11, strike) : lerp(11, 0, easeOut(recover)));
            }
            if (p >= 0) {
              ox = p < 0.4 ? -2.5 * wind : p < 0.6 ? lerp(-2.5, 8, strike) : lerp(8, 0, recover);
              lean = p < 0.4 ? -0.1 * wind : p < 0.6 ? lerp(-0.1, 0.18, strike) : lerp(0.18, 0, recover);
            }
            break;
          }
          case 'bow': {
            const draw = clamp01(p / 0.55);
            const released = p >= 0.55;
            if (this.nock) this.nock.visible = p >= 0 && !released;
            if (wp) wp.scale.x = p < 0 ? 1 : released ? lerp(1.15, 1, recover) : 1 + 0.35 * easeOut(draw);
            if (p >= 0) {
              ox = released ? -3 * rest : -2.5 * draw;
              lean = released ? -0.05 * rest : -0.1 * draw;
            }
            break;
          }
          case 'cast': {
            const up = p < 0 ? 0 : p < 0.6 ? easeOut(clamp01(p / 0.5)) : 1 - recover;
            if (this.orb) {
              this.orb.y = -21 - 9 * up;
              this.orb.scale.set(p >= 0 ? 1 + 0.9 * up : 1 + Math.sin(time * 4 + this.seed) * 0.08);
            }
            if (this.staff) this.staff.rotation = p >= 0 ? -0.22 * up : 0;
            if (wp && !this.staff) {
              wp.y = this.weaponY - 8 * up + Math.sin(time * 3 + this.seed) * 1.2;
              wp.rotation = this.restRot + (p >= 0 ? -0.5 * up : 0);
            }
            break;
          }
          case 'slam': {
            if (wp) wp.rotation = p < 0 ? this.restRot : p < 0.4 ? lerp(this.restRot, -2.5, easeOut(wind)) : p < 0.6 ? lerp(-2.5, 1.2, strike) : lerp(1.2, this.restRot, easeOut(recover));
            if (this.fists) this.fists.y = p < 0 ? 0 : p < 0.4 ? -14 * wind : p < 0.6 ? lerp(-14, 6, strike) : lerp(6, 0, easeOut(recover));
            if (p >= 0) {
              sy = p < 0.4 ? 1 + 0.07 * wind : p < 0.6 ? lerp(1.07, 0.86, strike) : lerp(0.86, 1, recover);
              sx = p < 0.4 ? 1 - 0.04 * wind : p < 0.6 ? lerp(0.96, 1.1, strike) : lerp(1.1, 1, recover);
              if (p >= 0.4 && p < 0.7) bob -= 2.5 * strike;
              lean = p < 0.4 ? -0.1 * wind : p < 0.6 ? lerp(-0.1, 0.18, strike) : lerp(0.18, 0, recover);
            }
            break;
          }
          case 'throw': {
            if (wp) wp.rotation = p < 0 ? this.restRot : p < 0.4 ? lerp(this.restRot, -1.5, easeOut(wind)) : p < 0.6 ? lerp(-1.5, 1.1, strike) : lerp(1.1, this.restRot, easeOut(recover));
            if (p >= 0) {
              ox = p < 0.4 ? -2 * wind : p < 0.6 ? lerp(-2, 4, strike) : lerp(4, 0, recover);
              lean = p < 0.4 ? -0.1 * wind : p < 0.6 ? lerp(-0.1, 0.12, strike) : lerp(0.12, 0, recover);
            }
            break;
          }
          case 'siege': {
            if (wp) wp.rotation = p < 0 ? this.restRot : p < 0.5 ? lerp(this.restRot, this.restRot - 0.55, easeOut(clamp01(p / 0.5))) : p < 0.6 ? lerp(this.restRot - 0.55, this.restRot + 0.7, (p - 0.5) / 0.1) : lerp(this.restRot + 0.7, this.restRot, easeOut(recover));
            if (p >= 0.5) {
              ox = p < 0.6 ? -4 * clamp01((p - 0.5) / 0.1) : -4 * (1 - recover);
              sy = 1 - 0.05 * (p < 0.7 ? 1 : 1 - recover);
            }
            break;
          }
          case 'punch': {
            if (this.fists) {
              const ext = p < 0 ? 0 : p < 0.4 ? -4 * wind : p < 0.6 ? lerp(-4, 9, strike) : lerp(9, 0, easeOut(recover));
              this.fists.x = ext;
              this.fists.y = p >= 0 ? -2 * Math.sin(clamp01(p) * Math.PI) : 0;
            }
            if (p >= 0) {
              ox = p < 0.4 ? -2.5 * wind : p < 0.6 ? lerp(-2.5, 7, strike) : lerp(7, 0, recover);
              lean = p < 0.4 ? -0.12 * wind : p < 0.6 ? lerp(-0.12, 0.2, strike) : lerp(0.2, 0, recover);
            }
            break;
          }
        }
        break;
      }
      case Kind.Brute: {
        if (this.weapon) {
          this.weapon.rotation =
            p < 0 ? 0.2 : p < 0.4 ? lerp(0.2, -2.5, easeOut(wind)) : p < 0.6 ? lerp(-2.5, 1.2, strike) : lerp(1.2, 0.2, easeOut(recover));
        }
        if (p >= 0) {
          sy = p < 0.4 ? 1 + 0.07 * wind : p < 0.6 ? lerp(1.07, 0.86, strike) : lerp(0.86, 1, recover);
          sx = p < 0.4 ? 1 - 0.04 * wind : p < 0.6 ? lerp(0.96, 1.1, strike) : lerp(1.1, 1, recover);
          ox = p < 0.6 ? 0 : 0;
          if (p >= 0.4 && p < 0.7) bob -= 2.5 * strike;
          lean = p < 0.4 ? -0.1 * wind : p < 0.6 ? lerp(-0.1, 0.18, strike) : lerp(0.18, 0, recover);
        }
        break;
      }
    }

    // Hit reaction: short squash.
    if (s.flash && !this.prevFlash) this.hurtT = 0.2;
    this.prevFlash = s.flash;
    if (this.hurtT > 0) {
      this.hurtT -= dt;
      const k = clamp01(this.hurtT / 0.2);
      const m = cz ? 3 : 1;
      sx *= 1 + 0.14 * m * k;
      sy *= 1 - 0.12 * m * k;
    }
    // Idle breathing.
    if (!s.moving && p < 0) sy *= 1 + Math.sin(time * 2.2 + this.seed) * 0.012;

    // Comedy: wobbling body, tipping over and getting up, occasional stumble.
    if (cz) {
      lean += (s.moving ? Math.sin(this.phase * 0.5) * 0.2 : Math.sin(time * 2.4 + this.seed) * 0.05);
      const tripT = (time * 0.33 + this.seed * 0.137) % 1;
      if (Math.floor(time * 0.33 + this.seed * 0.137 + 7) % 53 === 0 && tripT < 0.25) lean += Math.sin((tripT / 0.25) * Math.PI) * 0.8;
    }
    if (this.shadow) {
      // The shadow stays on the ground; when the unit goes airborne the shadow looks small below.
      const lf = s.lift ?? 0;
      this.shadow.y = lf * 38;
      this.shadow.scale.set(Math.max(0.5, 1 - lf * 0.12));
    }
    this.torso.position.set(ox, 15 - bob);
    this.torso.rotation = lean;
    this.torso.scale.set(sx, sy);

    // Spawn: short pop-in.
    const pop = this.age < 0.28 ? lerp(0.55, 1, easeOutBack(clamp01(this.age / 0.28))) : 1;

    this.rig.x = 0;
    this.rig.scale.x = this.base * this.faceCur * pop;
    this.rig.tint = s.flash ? 0xff9a9a : statusTint(s.status ?? 0);

    let squash = 1;
    if (!alive) {
      const k = Math.min(1, s.deathT / DEATH_FADE);
      this.root.alpha = 1 - k * k;
      this.rig.rotation = s.facing * easeOut(k) * 1.45;
      squash = 1 - k * 0.25;
      this.rig.y = k * 6;
    } else {
      this.root.alpha = 1;
      const lift = s.lift ?? 0;
      // Spins in the air with arms and legs flailing (comedy physics).
      this.rig.rotation = lift > 0.04 ? (time * 13 + this.seed) * s.facing : 0;
      this.rig.y = 0;
    }
    this.rig.scale.y = this.base * squash * pop;

    const ratio = alive ? s.hp / s.maxHp : 1;
    const mode = UnitView.barMode;
    const barVisible = alive && mode !== 'never' && (mode === 'always' || ratio < 1);
    if (ratio !== this.lastHpRatio || (barVisible && this.bar.children.length === 0 && this.lastHpRatio < 0)) {
      this.lastHpRatio = ratio;
      const w = 34 * Math.sqrt(this.kScale);
      this.bar.clear();
      this.bar.roundRect(-w / 2 - 1, 0, w + 2, 6, 2).fill({ color: 0x14181f, alpha: 0.9 });
      const col = ratio > 0.5 ? 0x4cc35b : ratio > 0.25 ? 0xe6b73a : 0xe0463b;
      if (ratio > 0) this.bar.roundRect(-w / 2, 1, w * ratio, 4, 1.5).fill(col);
    }
    this.bar.visible = barVisible;
  }
}

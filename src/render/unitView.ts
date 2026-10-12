import { Container, Graphics } from 'pixi.js';
import { Kind, STATS } from '../sim/units';

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
  /** Saldiri ilerlemesi 0..1, saldirmiyorsa -1. */
  swingProgress: number;
  flash: boolean;
  /** Olum animasyonu suresi, hayattaysa -1. */
  deathT: number;
}

export const DEATH_FADE = 0.7;

export class UnitView {
  readonly root = new Container();
  private readonly rig = new Container();
  private readonly inner = new Container();
  private readonly bar = new Graphics();
  private weapon: Container | null = null;
  private shield: Container | null = null;
  private orb: Graphics | null = null;
  private phase: number;
  private lastHpRatio = -1;
  private readonly kind: number;
  /** Kind'a gore cizim olcegi (tank = 2x). */
  private readonly kScale: number;
  private readonly base: number;

  constructor(kind: number, colors: TeamColors, seed: number) {
    this.kind = kind;
    this.kScale = STATS[kind].scale;
    this.base = SCALE * this.kScale;
    this.phase = seed * 1.7;

    const shadow = new Graphics();
    shadow
      .ellipse(0, 0, 15 * this.kScale, 7.5 * this.kScale)
      .fill({ color: 0x000000, alpha: 0.22 })
      .stroke({ width: 2 * Math.sqrt(this.kScale), color: colors.main, alpha: 0.95 });
    this.root.addChild(shadow);

    this.inner.y = -16;
    this.rig.addChild(this.inner);
    this.rig.scale.set(this.base);
    this.root.addChild(this.rig);
    this.draw(kind, colors.main, colors.dark);

    this.bar.y = -72 * this.kScale;
    this.bar.visible = false;
    this.root.addChild(this.bar);
  }

  private draw(kind: number, c: number, d: number): void {
    const g = new Graphics();
    const legs = new Graphics();
    const legCol = kind === Kind.Shield ? 0x4b4b52 : 0x5a4636;
    legs.roundRect(-8, 8, 6, 9, 2).fill(legCol);
    legs.roundRect(2, 8, 6, 9, 2).fill(legCol);
    this.inner.addChild(legs);

    if (kind === Kind.Warrior) {
      g.ellipse(-15, 2, 5, 8).fill(c).stroke({ width: 1.5, color: d });
    }

    // Govde
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

    // Brute omuzluklari (govdenin ustunde)
    if (kind === Kind.Brute) {
      g.circle(-14, -8, 6.5).fill(STEEL).stroke({ width: 1.2, color: STEEL_D });
      g.circle(14, -8, 6.5).fill(STEEL).stroke({ width: 1.2, color: STEEL_D });
    }

    // Kafa
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
    this.inner.addChild(g);

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
      this.inner.addChild(w);
    } else if (kind === Kind.Archer) {
      const w = new Container();
      w.position.set(18, 0);
      const bow = new Graphics();
      bow.moveTo(0, -14).quadraticCurveTo(14, 0, 0, 14).stroke({ width: 2.5, color: BROWN });
      bow.moveTo(0, -14).lineTo(0, 14).stroke({ width: 0.8, color: 0x666666 });
      w.addChild(bow);
      this.weapon = w;
      this.inner.addChild(w);
    } else if (kind === Kind.Priest) {
      const staff = new Graphics();
      staff.moveTo(17, -18).lineTo(17, 14).stroke({ width: 2.5, color: BROWN });
      this.inner.addChild(staff);
      const orb = new Graphics();
      orb.circle(0, 0, 4.5).fill(0xffe27a).stroke({ width: 1.2, color: 0xd4a017 });
      orb.position.set(17, -21);
      this.orb = orb;
      this.inner.addChild(orb);
    } else if (kind === Kind.Shield) {
      // Kule kalkani onde (+x): saldirida one atilir.
      const sh = new Container();
      sh.position.set(17, 1);
      const plate = new Graphics();
      plate.roundRect(-6, -15, 12, 30, 4).fill(c).stroke({ width: 1.5, color: d });
      plate.circle(0, 0, 3.5).fill(0xe9e1c8).stroke({ width: 0.8, color: 0x8a826a });
      plate.rect(-6, -15, 12, 3).fill({ color: 0xffffff, alpha: 0.25 });
      sh.addChild(plate);
      this.shield = sh;
      this.inner.addChild(sh);
      const sword = new Graphics();
      sword.rect(-13.7, -4, 3, 15).fill(0xc9ced6).stroke({ width: 0.8, color: 0x6b7280 });
      this.inner.addChild(sword);
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
      this.inner.addChild(w);
    }

    const hands = new Graphics();
    hands.circle(-13, 2, 3.5).fill(SKIN).stroke({ width: 1, color: SKIN_D });
    const rx = kind === Kind.Warrior ? 15.5 : kind === Kind.Brute ? 17 : 16;
    const ry = kind === Kind.Warrior ? 4 : kind === Kind.Brute ? 3 : 0;
    hands.circle(rx, ry, 3.5).fill(SKIN).stroke({ width: 1, color: SKIN_D });
    this.inner.addChild(hands);
  }

  update(s: ViewState, time: number, dt: number): void {
    const alive = s.deathT < 0;
    this.phase += dt * (s.moving ? 15 : 2.2);

    const bob = s.moving ? Math.abs(Math.sin(this.phase)) * 3.2 : Math.sin(this.phase) * 0.7;
    this.inner.y = -16 - bob;

    let offX = 0;
    let squash = 1;
    const p = s.swingProgress;
    if (this.kind === Kind.Warrior) {
      if (this.weapon) this.weapon.rotation = p >= 0 ? -0.9 + Math.sin(Math.min(1, p * 1.3) * Math.PI * 0.5) * 2.3 : 0.25;
      if (p >= 0) offX = Math.sin(p * Math.PI) * 9;
    } else if (this.kind === Kind.Archer) {
      if (p >= 0) {
        offX = -Math.sin(p * Math.PI) * 3;
        if (this.weapon) this.weapon.scale.x = 1 + Math.sin(p * Math.PI) * 0.25;
      } else if (this.weapon) this.weapon.scale.x = 1;
    } else if (this.kind === Kind.Shield) {
      if (this.shield) {
        this.shield.x = 17 + (p >= 0 ? Math.sin(Math.min(1, p * 1.4) * Math.PI) * 12 : 0);
        this.shield.rotation = p >= 0 ? Math.sin(p * Math.PI) * 0.18 : 0;
      }
      if (p >= 0) offX = Math.sin(p * Math.PI) * 6;
    } else if (this.kind === Kind.Brute) {
      // Cekic basin uzerinden yere iner.
      if (this.weapon) this.weapon.rotation = p >= 0 ? -1.4 + Math.sin(Math.min(1, p * 1.2) * Math.PI * 0.5) * 2.7 : 0.2;
      if (p >= 0) {
        offX = Math.sin(p * Math.PI) * 4;
        squash = 1 - Math.sin(p * Math.PI) * 0.1;
      }
    } else if (this.orb) {
      const pulse = p >= 0 ? 1 + Math.sin(p * Math.PI) * 0.9 : 1 + Math.sin(time * 4 + this.phase) * 0.08;
      this.orb.scale.set(pulse);
    }

    this.rig.x = offX * s.facing * this.base;
    this.rig.scale.x = this.base * s.facing;
    this.rig.tint = s.flash ? 0xff9a9a : 0xffffff;

    if (!alive) {
      const k = Math.min(1, s.deathT / DEATH_FADE);
      this.root.alpha = 1 - k;
      this.rig.rotation = s.facing * k * 1.2;
      squash = 1 - k * 0.2;
    } else {
      this.root.alpha = 1;
      this.rig.rotation = 0;
    }
    this.rig.scale.y = this.base * squash;

    const ratio = alive ? s.hp / s.maxHp : 1;
    if (ratio !== this.lastHpRatio) {
      this.lastHpRatio = ratio;
      const w = 34 * Math.sqrt(this.kScale);
      this.bar.clear();
      if (ratio < 1) {
        this.bar.rect(-w / 2 - 1, 0, w + 2, 5).fill(0x1a1a1a);
        const col = ratio > 0.5 ? 0x4cc35b : ratio > 0.25 ? 0xe6b73a : 0xe0463b;
        this.bar.rect(-w / 2, 1, (w - 0) * ratio, 3).fill(col);
      }
    }
    this.bar.visible = alive && ratio < 1;
  }
}

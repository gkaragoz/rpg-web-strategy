import { Container, Graphics } from 'pixi.js';
import { Kind } from '../sim/units';

const SCALE = 1.25;
const SKIN = 0xf2c9a0;
const SKIN_D = 0xa87b55;
const BROWN = 0x8b5a2b;
const TEAM_COLORS = [
  { main: 0x4a8fe8, dark: 0x1e4a96 },
  { main: 0xe85a4f, dark: 0x9b2a22 },
];

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
  private orb: Graphics | null = null;
  private phase: number;
  private lastHpRatio = -1;
  private readonly kind: number;

  constructor(kind: number, team: number, seed: number) {
    this.kind = kind;
    this.phase = seed * 1.7;
    const col = TEAM_COLORS[team];

    const shadow = new Graphics();
    shadow.ellipse(0, 0, 15, 7.5).fill({ color: 0x000000, alpha: 0.22 }).stroke({ width: 2, color: col.main, alpha: 0.95 });
    this.root.addChild(shadow);

    this.inner.y = -16;
    this.rig.addChild(this.inner);
    this.rig.scale.set(SCALE);
    this.root.addChild(this.rig);
    this.draw(kind, col.main, col.dark);

    this.bar.y = -72;
    this.bar.visible = false;
    this.root.addChild(this.bar);
  }

  private draw(kind: number, c: number, d: number): void {
    const g = new Graphics();
    const legs = new Graphics();
    legs.roundRect(-8, 8, 6, 9, 2).fill(0x5a4636);
    legs.roundRect(2, 8, 6, 9, 2).fill(0x5a4636);
    this.inner.addChild(legs);

    if (kind === Kind.Warrior) {
      g.ellipse(-15, 2, 5, 8).fill(c).stroke({ width: 1.5, color: d });
    }
    g.roundRect(-11, -6, 22, 18, 6)
      .fill(kind === Kind.Priest ? 0xf4f1ea : c)
      .stroke({ width: 1.5, color: kind === Kind.Priest ? 0xb9b3a3 : d });
    if (kind === Kind.Priest) g.rect(-11, 2, 22, 4).fill(c);

    g.circle(0, -14, 12).fill(SKIN).stroke({ width: 1.5, color: SKIN_D });
    g.circle(-3, -14, 1.7).fill(0x222222);
    g.circle(5, -14, 1.7).fill(0x222222);

    if (kind === Kind.Warrior) {
      g.moveTo(-12.5, -15).arc(0, -15, 12.5, Math.PI, Math.PI * 2).closePath().fill(0xaab1bc).stroke({ width: 1.2, color: 0x6b7280 });
      g.roundRect(-2, -31, 4, 8, 1).fill(c);
    } else if (kind === Kind.Archer) {
      g.moveTo(-13, -13).arc(0, -13, 13, Math.PI, Math.PI * 2).quadraticCurveTo(0, -21, -13, -13).closePath().fill(d);
    } else {
      g.ellipse(0, -30, 9, 3).stroke({ width: 2, color: 0xf2c230 });
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
    } else {
      const staff = new Graphics();
      staff.moveTo(17, -18).lineTo(17, 14).stroke({ width: 2.5, color: BROWN });
      this.inner.addChild(staff);
      const orb = new Graphics();
      orb.circle(0, 0, 4.5).fill(0xffe27a).stroke({ width: 1.2, color: 0xd4a017 });
      orb.position.set(17, -21);
      this.orb = orb;
      this.inner.addChild(orb);
    }

    const hands = new Graphics();
    hands.circle(-13, 2, 3.5).fill(SKIN).stroke({ width: 1, color: SKIN_D });
    hands.circle(kind === Kind.Warrior ? 15.5 : 16, kind === Kind.Warrior ? 4 : 0, 3.5).fill(SKIN).stroke({ width: 1, color: SKIN_D });
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
    } else if (this.orb) {
      const pulse = p >= 0 ? 1 + Math.sin(p * Math.PI) * 0.9 : 1 + Math.sin(time * 4 + this.phase) * 0.08;
      this.orb.scale.set(pulse);
    }

    this.rig.x = offX * s.facing * SCALE;
    this.rig.scale.x = SCALE * s.facing;
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
    this.rig.scale.y = SCALE * squash;

    const ratio = alive ? s.hp / s.maxHp : 1;
    if (ratio !== this.lastHpRatio) {
      this.lastHpRatio = ratio;
      this.bar.clear();
      if (ratio < 1) {
        this.bar.rect(-17, 0, 34, 5).fill(0x1a1a1a);
        const col = ratio > 0.5 ? 0x4cc35b : ratio > 0.25 ? 0xe6b73a : 0xe0463b;
        this.bar.rect(-16, 1, 32 * ratio, 3).fill(col);
      }
    }
    this.bar.visible = alive && ratio < 1;
  }
}

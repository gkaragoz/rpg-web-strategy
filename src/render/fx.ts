import { comedy, hash01 } from './comedyFlag';
import { Container, Particle, ParticleContainer, Text, type TextStyleOptions } from 'pixi.js';
import type { Camera } from '../camera';
import { isoX, isoY } from '../iso';
import type { SimEvent } from '../sim/battle';
import { isTank } from '../sim/units';
import type { Atlas } from './atlas';
import type { MassViewport } from './massRenderer';

export type FxQuality = 'off' | 'low' | 'high';
type TexId = 'puff' | 'spark' | 'star' | 'ring';

const MAX_PARTICLES = 1400;
const MAX_NUMBERS = 36;

const NUMBER_STYLE: TextStyleOptions = {
  fontFamily: 'system-ui, Segoe UI, sans-serif',
  fontSize: 15,
  fontWeight: '800',
  fill: 0xffffff,
  stroke: { color: 0x14181f, width: 3.5 },
};

/**
 * Olay tabanli efekt sistemi: vurus kivilcimi, olum tozu, sifa, kalkan/cekic sok dalgasi,
 * ok izi/ok inisi, kamera sarsintisi ve yuzen hasar sayilari. Parcaciklar atlas'tan
 * tek ParticleContainer ile cizilir; sayilar havuzlu Text'tir.
 */
export class FxSystem {
  readonly layer: ParticleContainer;
  readonly numbers = new Container();
  quality: FxQuality;
  numbersOn: boolean;
  /** Komedi yazilari (BONK!, AAAH!...) acik mi: az birimde ve sayilar aciksa. */
  comicOn = false;
  private comicLast = 0;
  private comicN = 1;

  private readonly parts: Particle[] = [];
  private readonly free: number[] = [];
  private readonly live: number[] = [];
  // Parcacik durumu (SoA)
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly s0 = new Float32Array(MAX_PARTICLES);
  private readonly s1 = new Float32Array(MAX_PARTICLES);
  private readonly a0 = new Float32Array(MAX_PARTICLES);
  private readonly grav = new Float32Array(MAX_PARTICLES);
  private readonly vrot = new Float32Array(MAX_PARTICLES);
  private readonly squashY = new Float32Array(MAX_PARTICLES);

  private readonly texts: Text[] = [];
  private readonly textLife = new Float32Array(MAX_NUMBERS);
  private readonly textVy = new Float32Array(MAX_NUMBERS);
  private textCursor = 0;

  /** Arazi yuksekligi (ekran pikseli); olaylar yamacta dogru yerde cizilsin. */
  elev: (x: number, y: number) => number = () => 0;

  constructor(
    private readonly atlas: Atlas,
    private readonly camera: Camera,
    quality: FxQuality,
    numbersOn: boolean,
  ) {
    this.quality = quality;
    this.numbersOn = numbersOn;
    this.layer = new ParticleContainer({
      dynamicProperties: { vertex: true, position: true, rotation: true, uvs: true, color: true },
    });
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.parts.push(new Particle({ texture: atlas.fx.puff.texture, anchorX: 0.5, anchorY: 0.5, alpha: 0 }));
      this.free.push(MAX_PARTICLES - 1 - i);
    }
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const t = new Text({ text: '', style: NUMBER_STYLE });
      t.anchor.set(0.5);
      t.visible = false;
      this.numbers.addChild(t);
      this.texts.push(t);
    }
  }

  private spawn(
    tex: TexId,
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    s0: number,
    s1: number,
    color: number,
    alpha: number,
    opts: { rot?: number; vrot?: number; grav?: number; squashY?: number } = {},
  ): void {
    const i = this.free.pop();
    if (i === undefined) return;
    const p = this.parts[i];
    const sp = this.atlas.fx[tex];
    p.texture = sp.texture;
    p.x = x;
    p.y = y;
    p.rotation = opts.rot ?? 0;
    p.tint = color;
    p.alpha = alpha;
    p.scaleX = s0;
    p.scaleY = s0 * (opts.squashY ?? 1);
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.a0[i] = alpha;
    this.grav[i] = opts.grav ?? 0;
    this.vrot[i] = opts.vrot ?? 0;
    this.squashY[i] = opts.squashY ?? 1;
    this.live.push(i);
  }

  /** Dunya yonunu (dx,dy) ekran yonune cevirir (izometrik). */
  private screenDir(dx: number, dy: number): { x: number; y: number } {
    const sx = dx - dy;
    const sy = (dx + dy) * 0.5;
    const m = Math.hypot(sx, sy) || 1;
    return { x: sx / m, y: sy / m };
  }

  private inView(sx: number, sy: number, v: MassViewport): boolean {
    return sx > v.left - 100 && sx < v.right + 100 && sy > v.top - 100 && sy < v.bottom + 100;
  }

  /** Simden gelen olaylari efektlere cevirir. */
  handle(events: SimEvent[], view: MassViewport): void {
    if (this.quality === 'off') return;
    const high = this.quality === 'high';
    const crowded = this.live.length > MAX_PARTICLES * 0.85;
    for (const ev of events) {
      const sx = isoX(ev.x, ev.y);
      const sy = isoY(ev.x, ev.y, this.elev(ev.x, ev.y));
      if (!this.inView(sx, sy, view)) continue;
      switch (ev.type) {
        case 'hit':
          if (!crowded) this.hit(sx, sy, ev.value ?? 10, ev.kind ?? 0, high);
          break;
        case 'death':
          this.death(sx, sy, ev.kind ?? 0, high);
          break;
        case 'heal':
          this.heal(sx, sy, ev.value ?? 10, high);
          break;
        case 'bash':
          this.bash(sx, sy, ev.angle ?? 0, high);
          break;
        case 'slam':
          this.slam(sx, sy, high);
          break;
        case 'shot':
          if (high && !crowded) this.shot(sx, sy, ev.angle ?? 0);
          break;
        case 'land':
          if (high && !crowded) this.land(sx, sy);
          break;
        case 'burst':
          if (!crowded) this.burstFx(sx, sy, ev.value ?? 2, ev.element ?? 0, high);
          break;
      }
    }
  }

  /** Komedi gorunumunde efekt buyuklugu carpani. */
  private big(): number {
    return comedy.visual ? 1.8 : 1;
  }

  /** Komik yazi: hiz sinirli, sadece uygun oldugunda (komedi gorunumu + az birim + yakinlastirma). */
  private comic(sx: number, sy: number, words: string[], color: number, size = 22): void {
    if (!comedy.visual || !this.comicOn || this.camera.zoom < 0.45) return;
    const now = performance.now();
    if (now - this.comicLast < 110) return;
    this.comicLast = now;
    const w = words[Math.floor(hash01(this.comicN++ * 13) * words.length) % words.length];
    this.number(sx, sy - 52, w, color, size);
  }

  private hit(sx: number, sy: number, dmg: number, kind: number, high: boolean): void {
    const n = high ? 2 + Math.min(4, Math.floor(dmg / 7)) : 2;
    const cy = sy - 20;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 70 + Math.random() * 90;
      this.spawn('spark', sx, cy, Math.cos(a) * sp, Math.sin(a) * sp * 0.6 - 25, 0.22 + Math.random() * 0.14, 0.9, 0.2, Math.random() < 0.5 ? 0xfff0b0 : 0xffffff, 1, {
        rot: a + Math.PI / 2,
        grav: 150,
      });
    }
    if (high) this.spawn('ring', sx, cy, 0, 0, 0.18, 0.16, (isTank(kind) ? 0.7 : 0.45) * this.big(), 0xffffff, 0.75);
    if (dmg >= 30) this.comic(sx, sy, ['BONK!', 'POW!', 'BAM!', 'OOF!', 'WHAM!'], 0xffd84a);
    else if (dmg >= 14 && hash01(this.comicN * 3) < 0.25) this.comic(sx, sy, ['bop', 'pok', 'BIFF!', 'tak'], 0xffffff, 18);
    if (high && this.numbersOn && this.camera.zoom >= 0.5) this.number(sx, sy - 44 * (isTank(kind) ? 2 : 1), String(Math.max(1, Math.round(dmg))), dmg >= 18 ? 0xffb347 : 0xffffff, dmg >= 18 ? 18 : 15);
  }

  private death(sx: number, sy: number, kind: number, high: boolean): void {
    const k = isTank(kind) ? 1.8 : 1;
    if (comedy.visual) {
      // Konfeti ve komik yazi (ragdoll ayri sistemde ucar).
      const cols = [0xff4fa0, 0x4fd0ff, 0xffe04a, 0x7aff7a, 0xb04fff];
      const m = high ? 9 : 4;
      for (let i = 0; i < m; i++) {
        const a = Math.random() * Math.PI * 2;
        this.spawn('star', sx, sy - 22, Math.cos(a) * 90, -70 - Math.random() * 90, 0.9, 0.55 * k, 0.1, cols[i % cols.length], 1, { vrot: 7, grav: 220 });
      }
      this.comic(sx, sy, ['AAAH!', 'NOOO!', 'POOF!', 'ÖLDÜM!', 'YAPMAAA!', 'bye~'], 0xff9ad0, 24);
    }
    const n = high ? 8 : 3;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawn('puff', sx + Math.cos(a) * 6 * k, sy - 8 + Math.sin(a) * 3, Math.cos(a) * 34 * k, Math.sin(a) * 16 * k - 22, 0.5 + Math.random() * 0.4, 0.5 * k, 1.5 * k, Math.random() < 0.5 ? 0xb9a68a : 0x8a7d68, 0.7);
    }
    if (high) {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        this.spawn('star', sx, sy - 24, Math.cos(a) * 50, -40 - Math.random() * 40, 0.55, 0.7 * k, 0.1, 0xffe27a, 1, { vrot: 5, grav: 120 });
      }
    }
  }

  private heal(sx: number, sy: number, amount: number, high: boolean): void {
    const n = high ? 4 : 2;
    for (let i = 0; i < n; i++) {
      this.spawn('star', sx + (Math.random() - 0.5) * 22, sy - 14 - Math.random() * 12, (Math.random() - 0.5) * 12, -38 - Math.random() * 22, 0.75, 0.55, 0.15, 0x6cf08a, 0.95, { vrot: 2 });
    }
    if (high) {
      this.spawn('puff', sx, sy - 22, 0, -14, 0.5, 0.7, 1.5, 0x8cf5a4, 0.5);
      if (this.numbersOn && this.camera.zoom >= 0.5) this.number(sx + 8, sy - 50, `+${Math.round(amount)}`, 0x6cf08a, 14);
    }
  }

  private bash(sx: number, sy: number, angle: number, high: boolean): void {
    const d = this.screenDir(Math.cos(angle), Math.sin(angle));
    const n = high ? 7 : 4;
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 0.28;
      const ca = Math.cos(off);
      const sa = Math.sin(off);
      const dx = d.x * ca - d.y * sa;
      const dy = d.x * sa + d.y * ca;
      this.spawn('puff', sx + dx * 36, sy - 12 + dy * 36, dx * 140, dy * 140, 0.38, 0.6, 1.6, 0xffffff, 0.75);
    }
    if (high) this.spawn('ring', sx + d.x * 34, sy - 10 + d.y * 34, d.x * 40, d.y * 40, 0.3, 0.2, 1.1 * this.big(), 0xdff1ff, 0.7);
    this.camera.shake(3.5 * (comedy.visual ? 2 : 1));
    if (comedy.visual) this.camera.punch(0.022);
    this.comic(sx, sy, ['BAAM!', 'WHOOSH!', 'BONK!'], 0xffb347, 24);
  }

  private slam(sx: number, sy: number, high: boolean): void {
    this.spawn('ring', sx, sy - 4, 0, 0, 0.5, 0.35, 2.7 * this.big(), 0xffe9b0, 0.95);
    this.spawn('ring', sx, sy - 4, 0, 0, 0.75, 0.2, 1.8 * this.big(), 0xffffff, 0.5);
    const n = high ? 12 : 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      this.spawn('puff', sx + Math.cos(a) * 20, sy - 4 + Math.sin(a) * 10, Math.cos(a) * 110, Math.sin(a) * 55, 0.55 + Math.random() * 0.2, 0.7, 1.9, 0xc7b497, 0.7);
    }
    this.camera.shake(8 * (comedy.visual ? 2 : 1));
    if (comedy.visual) this.camera.punch(0.05);
    this.comic(sx, sy, ['KABOOM!', 'BOOM!', 'SMASH!', 'KABLAM!'], 0xff8a2a, 28);
  }

  /** Yetenek patlamasi/halkasi: unsura gore renkli halka ve parcaciklar (yaricap tile). */
  private burstFx(sx: number, sy: number, radius: number, element: number, high: boolean): void {
    if (element === 8) return; // whoosh: yalniz ses
    const COLORS = [0xe9e1c8, 0xff8a2a, 0x9ae0ff, 0xffe27a, 0xb04fff, 0x7aff9a, 0x4fc3ff, 0xffffff, 0xffffff, 0x5ab4ff];
    if (element === 9) {
      // Suya dusus: buyuk sicrama halkasi + damlalar.
      this.spawn('ring', sx, sy - 4, 0, 0, 0.6, 0.3, 2.4 * this.big(), 0xbfe6ff, 0.95);
      for (let i = 0; i < (high ? 9 : 4); i++) {
        const a = Math.random() * Math.PI * 2;
        this.spawn('puff', sx, sy - 8, Math.cos(a) * 55, -90 - Math.random() * 70, 0.7, 0.5, 0.2, 0xdff2ff, 0.9, { grav: 300 });
      }
      this.comic(sx, sy, ['SPLASH!', 'BLUB!', 'GLUB!'], 0x7fd0ff, 22);
      this.camera.shake(2.5);
      return;
    }
    if (element === 7) {
      // Ragdoll yere carpti: konfeti toz bulutu + komik yazi.
      const cols = [0xff4fa0, 0x4fd0ff, 0xffe04a, 0x7aff7a, 0xb04fff];
      for (let i = 0; i < (high ? 8 : 3); i++) {
        const a = Math.random() * Math.PI * 2;
        this.spawn(i % 2 ? 'star' : 'puff', sx, sy - 6, Math.cos(a) * 70, Math.sin(a) * 34 - 30, 0.6, 0.6, 0.2, cols[i % cols.length], 0.95, { vrot: 5, grav: 160 });
      }
      this.spawn('puff', sx, sy - 4, 0, -10, 0.5, 0.6, 1.8, 0xd8cdb6, 0.6);
      this.comic(sx, sy, ['SPLAT!', 'THUD!', 'BOING!', 'POF!'], 0xffffff, 20);
      this.camera.shake(2);
      return;
    }
    const col = COLORS[element] ?? 0xffffff;
    const r = Math.max(0.8, Math.min(5, radius));
    this.spawn('ring', sx, sy - 4, 0, 0, 0.45, 0.25, r * 1.15 * this.big(), col, 0.9);
    if (high) this.spawn('ring', sx, sy - 4, 0, 0, 0.65, 0.15, r * 0.8, 0xffffff, 0.45);
    const n = high ? 9 : 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const d = 14 + r * 14;
      this.spawn(element === 0 || element === 4 ? 'puff' : 'spark', sx + Math.cos(a) * d * 0.5, sy - 8 + Math.sin(a) * d * 0.25, Math.cos(a) * 60 * r, Math.sin(a) * 30 * r - 15, 0.5 + Math.random() * 0.25, 0.7, 0.2, col, 0.9, { rot: a + Math.PI / 2 });
    }
    if (r >= 3 && high) this.camera.shake(2.5);
  }

  private shot(sx: number, sy: number, angle: number): void {
    const d = this.screenDir(Math.cos(angle), Math.sin(angle));
    this.spawn('puff', sx + d.x * 18, sy - 24 + d.y * 18, d.x * 25, d.y * 25 - 6, 0.25, 0.35, 0.8, 0xffffff, 0.4);
  }

  private land(sx: number, sy: number): void {
    for (let i = 0; i < 3; i++) {
      this.spawn('puff', sx + (Math.random() - 0.5) * 8, sy, (Math.random() - 0.5) * 30, -14 - Math.random() * 14, 0.4, 0.4, 1, 0xb9a68a, 0.55);
    }
  }

  private number(sx: number, sy: number, text: string, color: number, size: number): void {
    const i = this.textCursor++ % MAX_NUMBERS;
    const t = this.texts[i];
    t.text = text;
    t.style.fill = color;
    t.style.fontSize = size;
    t.position.set(sx + (Math.random() - 0.5) * 14, sy);
    t.alpha = 1;
    t.scale.set(0.6);
    t.visible = true;
    this.textLife[i] = 0.95;
    this.textVy[i] = -46 - Math.random() * 14;
  }

  update(dt: number): void {
    const out = this.layer.particleChildren;
    let w = 0;
    for (let k = 0; k < this.live.length; k++) {
      const i = this.live[k];
      const life = (this.life[i] -= dt);
      if (life <= 0) {
        const p = this.parts[i];
        p.alpha = 0;
        this.free.push(i);
        continue;
      }
      const t = 1 - life / this.maxLife[i];
      const p = this.parts[i];
      this.vy[i] += this.grav[i] * dt;
      p.x += this.vx[i] * dt;
      p.y += this.vy[i] * dt;
      p.rotation += this.vrot[i] * dt;
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - (1 - t) * (1 - t));
      p.scaleX = s;
      p.scaleY = s * this.squashY[i];
      p.alpha = this.a0[i] * (1 - t * t);
      this.live[w++] = i;
      out[w - 1] = p;
    }
    this.live.length = w;
    out.length = w;

    for (let i = 0; i < MAX_NUMBERS; i++) {
      if (this.textLife[i] <= 0) continue;
      const t = this.texts[i];
      this.textLife[i] -= dt;
      if (this.textLife[i] <= 0) {
        t.visible = false;
        continue;
      }
      t.y += this.textVy[i] * dt;
      this.textVy[i] *= 0.95;
      const age = 0.95 - this.textLife[i];
      t.scale.set(Math.min(1.15, 0.6 + age * 5));
      t.alpha = Math.min(1, this.textLife[i] / 0.35);
    }
  }

  /** Aktif parcacik sayisi (istatistik). */
  get count(): number {
    return this.live.length;
  }

  clear(): void {
    for (const i of this.live) {
      this.parts[i].alpha = 0;
      this.free.push(i);
    }
    this.live.length = 0;
    this.layer.particleChildren.length = 0;
    for (let i = 0; i < MAX_NUMBERS; i++) {
      this.textLife[i] = 0;
      this.texts[i].visible = false;
    }
  }
}


export const Team = { Blue: 0, Red: 1 } as const;
export const Kind = { Warrior: 0, Archer: 1, Priest: 2 } as const;

export interface KindStats {
  name: string;
  hp: number;
  speed: number;
  range: number;
  /** Hasar (warrior/archer) veya iyilestirme miktari (priest). */
  power: number;
  cooldown: number;
  /** Saldiri animasyonunun toplam suresi. */
  swing: number;
  /** Animasyonun basindan etkinin uygulandigi ana kadar gecen sure. */
  hitAt: number;
}

export const STATS: KindStats[] = [
  { name: 'Warrior', hp: 160, speed: 3.0, range: 1.0, power: 16, cooldown: 0.9, swing: 0.35, hitAt: 0.2 },
  { name: 'Archer', hp: 80, speed: 2.4, range: 9, power: 13, cooldown: 1.4, swing: 0.4, hitAt: 0.25 },
  { name: 'Priest', hp: 90, speed: 2.6, range: 6.5, power: 20, cooldown: 1.5, swing: 0.5, hitAt: 0.3 },
];

/** Struct-of-arrays birim deposu: buyuk olcekli benchmark'a hazir. */
export class Units {
  count = 0;
  readonly cap: number;
  alive: Uint8Array;
  team: Uint8Array;
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  px: Float32Array;
  py: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  hp: Float32Array;
  maxHp: Float32Array;
  target: Int32Array;
  cooldown: Float32Array;
  retarget: Float32Array;
  swing: Float32Array;
  hitPending: Uint8Array;
  flash: Float32Array;
  deathT: Float32Array;
  facing: Int8Array;
  moving: Uint8Array;
  attackers: Uint8Array;
  healers: Uint8Array;
  slotAngle: Float32Array;

  constructor(cap: number) {
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.team = new Uint8Array(cap);
    this.kind = new Uint8Array(cap);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.hp = new Float32Array(cap);
    this.maxHp = new Float32Array(cap);
    this.target = new Int32Array(cap).fill(-1);
    this.cooldown = new Float32Array(cap);
    this.retarget = new Float32Array(cap);
    this.swing = new Float32Array(cap);
    this.hitPending = new Uint8Array(cap);
    this.flash = new Float32Array(cap);
    this.deathT = new Float32Array(cap);
    this.facing = new Int8Array(cap).fill(1);
    this.moving = new Uint8Array(cap);
    this.attackers = new Uint8Array(cap);
    this.healers = new Uint8Array(cap);
    this.slotAngle = new Float32Array(cap);
  }

  clear(): void {
    this.count = 0;
    this.alive.fill(0);
    this.target.fill(-1);
  }

  spawn(team: number, kind: number, x: number, y: number, rand: () => number): number {
    const i = this.count++;
    const s = STATS[kind];
    this.alive[i] = 1;
    this.team[i] = team;
    this.kind[i] = kind;
    this.x[i] = this.px[i] = x;
    this.y[i] = this.py[i] = y;
    this.vx[i] = this.vy[i] = 0;
    this.hp[i] = this.maxHp[i] = s.hp;
    this.target[i] = -1;
    this.cooldown[i] = rand() * s.cooldown;
    this.retarget[i] = rand() * 0.5;
    this.swing[i] = 0;
    this.hitPending[i] = 0;
    this.flash[i] = 0;
    this.deathT[i] = 0;
    this.facing[i] = team === Team.Blue ? 1 : -1;
    this.moving[i] = 0;
    this.slotAngle[i] = (rand() * 2 - 1) * 1.3;
    return i;
  }
}

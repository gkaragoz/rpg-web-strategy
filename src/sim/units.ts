export const MAX_TEAMS = 6;
export const Kind = { Warrior: 0, Archer: 1, Priest: 2, Shield: 3, Brute: 4 } as const;
export const KIND_COUNT = 5;

/** Yakin-dovus birimleri: Savasci, Kalkan Tanki, Cekic Tanki. */
export function isMelee(kind: number): boolean {
  return kind === Kind.Warrior || kind >= Kind.Shield;
}
/** Tanklar (2x boyut, alan etkili). */
export function isTank(kind: number): boolean {
  return kind >= Kind.Shield;
}

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
  /** Gelen hasari bu oranda azaltir (0..1). */
  armor: number;
  /** Cizim olcegi carpani (tank = 2). */
  scale: number;
  /** Alan etkisi: Kalkan = koni uzunlugu, Cekic = daire yaricapi (tile). */
  aoe: number;
  /** Alan etkisiyle geri itme mesafesi (tile). Cekic = Kalkan'in yarisi. */
  knockback: number;
}

export const STATS: KindStats[] = [
  { name: 'Savaşçı', hp: 160, speed: 3.0, range: 1.0, power: 16, cooldown: 0.9, swing: 0.35, hitAt: 0.2, armor: 0, scale: 1, aoe: 0, knockback: 0 },
  { name: 'Okçu', hp: 80, speed: 2.4, range: 9, power: 13, cooldown: 1.4, swing: 0.4, hitAt: 0.25, armor: 0, scale: 1, aoe: 0, knockback: 0 },
  { name: 'Rahip', hp: 90, speed: 2.6, range: 6.5, power: 14, cooldown: 1.8, swing: 0.5, hitAt: 0.3, armor: 0, scale: 1, aoe: 0, knockback: 0 },
  // Kalkan Tanki: onundeki konide itme (guclu knockback).
  { name: 'Kalkan Tankı', hp: 520, speed: 1.9, range: 1.5, power: 12, cooldown: 1.6, swing: 0.5, hitAt: 0.28, armor: 0.35, scale: 2, aoe: 2.6, knockback: 3.0 },
  // Cekic Tanki: cevresinde daire darbe; knockback Kalkan'in yarisi.
  { name: 'Çekiç Tankı', hp: 460, speed: 2.1, range: 1.8, power: 22, cooldown: 2.0, swing: 0.6, hitAt: 0.35, armor: 0.2, scale: 2, aoe: 2.2, knockback: 1.5 },
];

export type StatKey = 'hp' | 'speed' | 'power' | 'cooldown' | 'range' | 'armor' | 'knockback';
export type StatOverrides = Array<Partial<Record<StatKey, number>>>;

/** Arayuzde ayarlanabilen alanlar: sinirlar ve adimlar. */
export const TUNABLE: Array<{ key: StatKey; label: string; hint: string; min: number; max: number; step: number; tankOnly?: boolean }> = [
  { key: 'hp', label: 'Can', hint: 'Başlangıç canı', min: 10, max: 5000, step: 10 },
  { key: 'speed', label: 'Hız', hint: 'Hareket hızı (tile/sn)', min: 0.5, max: 8, step: 0.1 },
  { key: 'power', label: 'Güç', hint: 'Hasar (rahipte şifa miktarı)', min: 1, max: 300, step: 1 },
  { key: 'cooldown', label: 'Bekleme', hint: 'İki saldırı arası (sn)', min: 0.2, max: 6, step: 0.1 },
  { key: 'range', label: 'Menzil', hint: 'Saldırı menzili (tile)', min: 0.5, max: 16, step: 0.1 },
  { key: 'armor', label: 'Zırh', hint: 'Gelen hasarı azaltma (0 - 0.9)', min: 0, max: 0.9, step: 0.05 },
  { key: 'knockback', label: 'İtme', hint: 'Tank itme mesafesi (tile)', min: 0, max: 8, step: 0.5, tankOnly: true },
];

/** Varsayilan degerler (arayuzdeki "sifirla" icin). */
export const DEFAULT_STATS: KindStats[] = STATS.map((s) => ({ ...s }));

/** Kullanici ayarlarini STATS'a uygular; eksik alanlar varsayilana doner. Sim baslamadan once cagrilir. */
export function applyStats(overrides: StatOverrides | undefined): void {
  for (let k = 0; k < STATS.length; k++) {
    const o = overrides?.[k] ?? {};
    for (const t of TUNABLE) {
      const v = o[t.key];
      STATS[k][t.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(t.max, Math.max(t.min, v)) : DEFAULT_STATS[k][t.key];
    }
  }
}

/** Yumusak hareket: ivmelenme/frenleme (tile/sn^2) ve donus hizi (1/sn). */
export const MOTION = {
  accel: 16,
  /** Durma/hizli donus sirasinda hiz bu oranda kalir (adim basina). */
  brake: 0.6,
  turn: 12,
};

/** Tank etki sabitleri. */
export const TANK = {
  /** Kalkan itmesi yari acisi icin cos(60 derece). */
  coneCos: 0.5,
  stun: 0.3,
  /** Itme hizi adim basina bu oranda soner (30 Hz). */
  kbDecay: 0.7,
  /** Hedef puaninda tank bonusu (daha kucuk = daha cekici) ve tank icin melee yuva sayisi. */
  tauntBonus: 5,
  meleeSlots: 5,
  /** Tank yakinindaki birimleri itme yaricapi. */
  pushRadius: 1.8,
};

/** Vur-kac (kite) ve yol bulma ayarlari: tek yerde, kolay ayar. */
export const KITE = {
  archerDanger: 4.5,
  archerSafe: 6.5,
  archerCornered: 1.8,
  archerSnapMin: 2.5,
  priestDanger: 5,
  priestSafe: 7,
  archerSprint: 1.25,
  priestSprint: 1.15,
  staminaDrain: 0.8,
  priestStaminaDrain: 0.6,
  staminaRecharge: 0.35,
  staminaMin: 0.3,
  /** Kacis yonunde kendi ordu merkezine dogru karisim agirligi. */
  armyPull: 0.35,
  /** Okcu/priest, kendi warrior merkezinin bu kadar onune gecmez. */
  leash: 1.0,
  /** Tehdit taramasi her N adimda bir (birim basina kaydirmali). */
  scanEvery: 3,
};

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
  attackers: Uint16Array;
  healers: Uint16Array;
  slotAngle: Float32Array;
  stamina: Float32Array;
  /** 1: geri cekiliyor (kite). */
  kiteState: Uint8Array;
  /** En yakin yakin-dovus tehdidine mesafe (Infinity: yok) ve tehditten uzaga birim vektor. */
  threatDist: Float32Array;
  threatDx: Float32Array;
  threatDy: Float32Array;
  /** Nehir gecisi: secili kopru (-1: yok) ve evre (0: girise git, 1: karsiya gec). */
  route: Int16Array;
  routePhase: Uint8Array;
  /** Sikisma kirici: birikim ve yan adim suresi/yonu. */
  stuckT: Float32Array;
  sideT: Float32Array;
  sideDir: Int8Array;
  /** Geri itme hizi (tile/sn) ve sersemleme suresi. */
  kbVx: Float32Array;
  kbVy: Float32Array;
  stunT: Float32Array;
  /** Yasaklanan hedef ve kalan sure (ilerleme bekcisi). */
  banTarget: Int32Array;
  banT: Float32Array;
  /** Hedefe kovalama suresi ve o zamana kadarki en yakin mesafe. */
  chaseT: Float32Array;
  chaseBest: Float32Array;
  /** Leash yuzunden bekleme suresi ve leash'in devre disi kalacagi sure. */
  holdT: Float32Array;
  leashOffT: Float32Array;
  /** Net yer degistirme penceresi: baslangic konumu ve gecen sure (sikisma tespiti). */
  winX: Float32Array;
  winY: Float32Array;
  winT: Float32Array;
  /** Yumusak hareket: guncel hiz buyuklugu ve yon (birim vektor). */
  spd: Float32Array;
  hx: Float32Array;
  hy: Float32Array;

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
    this.attackers = new Uint16Array(cap);
    this.healers = new Uint16Array(cap);
    this.slotAngle = new Float32Array(cap);
    this.stamina = new Float32Array(cap).fill(1);
    this.kiteState = new Uint8Array(cap);
    this.threatDist = new Float32Array(cap).fill(Infinity);
    this.threatDx = new Float32Array(cap);
    this.threatDy = new Float32Array(cap);
    this.route = new Int16Array(cap).fill(-1);
    this.routePhase = new Uint8Array(cap);
    this.stuckT = new Float32Array(cap);
    this.sideT = new Float32Array(cap);
    this.sideDir = new Int8Array(cap);
    this.kbVx = new Float32Array(cap);
    this.kbVy = new Float32Array(cap);
    this.stunT = new Float32Array(cap);
    this.banTarget = new Int32Array(cap).fill(-1);
    this.banT = new Float32Array(cap);
    this.chaseT = new Float32Array(cap);
    this.chaseBest = new Float32Array(cap).fill(Infinity);
    this.holdT = new Float32Array(cap);
    this.leashOffT = new Float32Array(cap);
    this.winX = new Float32Array(cap);
    this.winY = new Float32Array(cap);
    this.winT = new Float32Array(cap);
    this.spd = new Float32Array(cap);
    this.hx = new Float32Array(cap);
    this.hy = new Float32Array(cap);
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
    this.facing[i] = team % 2 === 0 ? 1 : -1;
    this.moving[i] = 0;
    this.slotAngle[i] = (rand() * 2 - 1) * 1.3;
    this.stamina[i] = 1;
    this.kiteState[i] = 0;
    this.threatDist[i] = Infinity;
    this.threatDx[i] = this.threatDy[i] = 0;
    this.route[i] = -1;
    this.routePhase[i] = 0;
    this.stuckT[i] = this.sideT[i] = 0;
    this.sideDir[i] = 1;
    this.kbVx[i] = this.kbVy[i] = 0;
    this.stunT[i] = 0;
    this.banTarget[i] = -1;
    this.banT[i] = this.chaseT[i] = this.holdT[i] = this.leashOffT[i] = 0;
    this.chaseBest[i] = Infinity;
    this.winX[i] = x;
    this.winY[i] = y;
    this.winT[i] = 0;
    this.spd[i] = 0;
    this.hx[i] = this.hy[i] = 0;
    return i;
  }
}

import { t } from '../i18n';
import { TROOPS, type MoveClass, type SkillId, type TroopDef } from './data/troops';

export const MAX_TEAMS = 6;
/** The first 5 kinds (classic) have fixed ids. The rest are roster units (in TROOPS order). */
export const Kind = { Warrior: 0, Archer: 1, Priest: 2, Shield: 3, Brute: 4 } as const;
export const LEGACY_COUNT = 5;

/** Combat role: determines targeting, kiting and healing behavior. */
export const Role = { Melee: 0, Ranged: 1, Healer: 2, Tank: 3 } as const;

export interface KindStats {
  name: string;
  hp: number;
  speed: number;
  range: number;
  /** Damage (warrior/archer) or heal amount (priest). */
  power: number;
  cooldown: number;
  /** Total duration of the attack animation. */
  swing: number;
  /** Time from the start of the animation until the effect is applied. */
  hitAt: number;
  /** Reduces incoming damage by this fraction (0..1). */
  armor: number;
  /** Render scale multiplier (tank = 2). */
  scale: number;
  /** Area effect: Shield = cone length, Hammer = circle radius (tiles). */
  aoe: number;
  /** Knockback distance of the area effect (tiles). Hammer = half of Shield. */
  knockback: number;
  role: number;
  /** Area damage radius of the basic attack (tiles; 0: single target). */
  splash: number;
  /** Damage shape: 0 single target, 1 circle, 2 rectangle, 3 piercing. */
  shape: number;
  /** Magical damage (visual/audio cue). */
  magical: boolean;
  /** Roster unit id (absent for classic kinds) and its skill. */
  troop?: string;
  skill: SkillId | null;
}

const classic = (s: Omit<KindStats, 'role' | 'splash' | 'shape' | 'magical' | 'skill'> & { role: number }): KindStats => ({ ...s, splash: 0, shape: 0, magical: false, skill: null });

export const STATS: KindStats[] = [
  classic({ name: 'Warrior', role: Role.Melee, hp: 160, speed: 3.0, range: 1.0, power: 16, cooldown: 0.9, swing: 0.35, hitAt: 0.2, armor: 0, scale: 1, aoe: 0, knockback: 0 }),
  classic({ name: 'Archer', role: Role.Ranged, hp: 80, speed: 2.4, range: 9, power: 13, cooldown: 1.4, swing: 0.4, hitAt: 0.25, armor: 0, scale: 1, aoe: 0, knockback: 0 }),
  classic({ name: 'Priest', role: Role.Healer, hp: 90, speed: 2.6, range: 6.5, power: 14, cooldown: 1.8, swing: 0.5, hitAt: 0.3, armor: 0, scale: 1, aoe: 0, knockback: 0 }),
  // Shield Tank: knocks back in the cone in front of it (strong knockback).
  classic({ name: 'Shield Tank', role: Role.Tank, hp: 520, speed: 1.9, range: 1.5, power: 12, cooldown: 1.6, swing: 0.5, hitAt: 0.28, armor: 0.35, scale: 2, aoe: 2.6, knockback: 3.0 }),
  // Hammer Tank: circular strike around it; knockback is half of the Shield's.
  classic({ name: 'Hammer Tank', role: Role.Tank, hp: 460, speed: 2.1, range: 1.8, power: 22, cooldown: 2.0, swing: 0.6, hitAt: 0.35, armor: 0.2, scale: 2, aoe: 2.2, knockback: 1.5 }),
];

// ---- Roster units: level-dependent, normalized to the game scale ----

/** Divisors that scale the roster HP/attack values down to the game scale. */
export const HP_DIV = 5;
export const ATK_DIV = 6.5;
/** Defense to armor ratio: def / (def + ARMOR_K). */
export const ARMOR_K = 220;
export const MOVE_SPEED: Record<MoveClass, number> = { 0: 2.2, 1: 2.6, 2: 3.0, 3: 3.6, 4: 4.4 };
export const DEFAULT_LEVEL = 5;
export const MAX_LEVEL = 10;

/** Roster unit id to kind number. */
export const KIND_OF_TROOP: Record<string, number> = {};

function troopStats(t: TroopDef, level: number): KindStats {
  const [hp, atk, def] = t.levels[Math.min(MAX_LEVEL, Math.max(1, level)) - 1];
  const big = t.id === 'granite-colossus' || t.id === 'cinder-golem' || t.id === 'war-barge' || t.id === 'hill-brute' ? 1.8 : t.levels[0][0] >= 2000 ? 1.4 : 1;
  const heal = t.skill === 'cleanse';
  return {
    name: t.name,
    role: heal ? Role.Healer : t.ranged ? Role.Ranged : Role.Melee,
    hp: Math.round(hp / HP_DIV),
    speed: MOVE_SPEED[t.move],
    range: t.reach,
    power: Math.max(1, Math.round(atk / ATK_DIV)),
    cooldown: Math.round(Math.min(5, Math.max(0.4, 1 / Math.max(0.2, t.atkSpd))) * 100) / 100,
    swing: t.ranged ? (t.magical ? 0.5 : 0.4) : 0.35,
    hitAt: t.ranged ? (t.magical ? 0.3 : 0.25) : 0.2,
    armor: Math.round(Math.min(0.85, def / (def + ARMOR_K)) * 100) / 100,
    scale: big,
    aoe: 0,
    knockback: 0,
    splash: t.aoe,
    shape: { single: 0, round: 1, rect: 2, pierce: 3 }[t.shape],
    magical: t.magical,
    troop: t.id,
    skill: t.skill,
  };
}

TROOPS.forEach((t, i) => {
  KIND_OF_TROOP[t.id] = LEGACY_COUNT + i;
  STATS.push(troopStats(t, DEFAULT_LEVEL));
});

export const KIND_COUNT = STATS.length;

/** Localized display name of a unit kind: classic units use the string table, roster units keep their English names. */
export function unitDisplayName(kind: number): string {
  return kind < LEGACY_COUNT ? t(`units.classic.${kind}`) : STATS[kind].name;
}

/** Unit flags (Units.flags). */
export const F_REVIVED = 1;
export const F_RAGE = 2;
export const F_EXPLODED = 4;

/** Visual status mask (Units.status). */
export const ST_SLOW = 1;
export const ST_BURN = 2;
export const ST_STUN = 4;
export const ST_FEAR = 8;
export const ST_SHIELD = 16;
export const ST_INVULN = 32;
export const ST_TAUNT = 64;

/** Role queries (typed arrays for hot loops). */
const ROLE_OF = new Uint8Array(KIND_COUNT);
STATS.forEach((s, i) => (ROLE_OF[i] = s.role));

/** Close-combat units: melee and tanks. */
export function isMelee(kind: number): boolean {
  const r = ROLE_OF[kind];
  return r === Role.Melee || r === Role.Tank;
}
/** Tanks (2x size, area effect): only the classic Shield/Hammer. */
export function isTank(kind: number): boolean {
  return ROLE_OF[kind] === Role.Tank;
}
/** Role that heals allies (deals no damage): Priest, Nun. */
export function isHealer(kind: number): boolean {
  return ROLE_OF[kind] === Role.Healer;
}
/** Ranged attacker (archer-like): kites. */
export function isRanged(kind: number): boolean {
  return ROLE_OF[kind] === Role.Ranged;
}

export type StatKey = 'hp' | 'speed' | 'power' | 'cooldown' | 'range' | 'armor' | 'knockback';
export type StatOverrides = Array<Partial<Record<StatKey, number>>>;

/** Fields adjustable in the UI: bounds and steps. Labels and hints are localized lazily via getters. */
export const TUNABLE: Array<{ key: StatKey; label: string; hint: string; min: number; max: number; step: number; tankOnly?: boolean }> = [
  { key: 'hp', get label() { return t('units.stat.hp.label'); }, get hint() { return t('units.stat.hp.hint'); }, min: 10, max: 20000, step: 10 },
  { key: 'speed', get label() { return t('units.stat.speed.label'); }, get hint() { return t('units.stat.speed.hint'); }, min: 0.5, max: 8, step: 0.1 },
  { key: 'power', get label() { return t('units.stat.power.label'); }, get hint() { return t('units.stat.power.hint'); }, min: 1, max: 1000, step: 1 },
  { key: 'cooldown', get label() { return t('units.stat.cooldown.label'); }, get hint() { return t('units.stat.cooldown.hint'); }, min: 0.2, max: 6, step: 0.1 },
  { key: 'range', get label() { return t('units.stat.range.label'); }, get hint() { return t('units.stat.range.hint'); }, min: 0.5, max: 16, step: 0.1 },
  { key: 'armor', get label() { return t('units.stat.armor.label'); }, get hint() { return t('units.stat.armor.hint'); }, min: 0, max: 0.9, step: 0.05 },
  { key: 'knockback', get label() { return t('units.stat.knockback.label'); }, get hint() { return t('units.stat.knockback.hint'); }, min: 0, max: 8, step: 0.5, tankOnly: true },
];

/** Default values (for the UI "reset"); roster units are refreshed when the level changes. */
export const DEFAULT_STATS: KindStats[] = STATS.map((s) => ({ ...s }));

let currentLevel = DEFAULT_LEVEL;

/** Sets the stats of roster units to the given level (STATS and DEFAULT_STATS). */
export function setUnitLevel(level: number): void {
  const lv = Math.min(MAX_LEVEL, Math.max(1, Math.round(level)));
  currentLevel = lv;
  TROOPS.forEach((t, i) => {
    const k = LEGACY_COUNT + i;
    Object.assign(STATS[k], troopStats(t, lv));
    Object.assign(DEFAULT_STATS[k], troopStats(t, lv));
  });
}

export function unitLevel(): number {
  return currentLevel;
}

/** Applies user overrides to STATS; missing fields fall back to defaults. Called before the sim starts. */
export function applyStats(overrides: StatOverrides | undefined, level: number = DEFAULT_LEVEL): void {
  setUnitLevel(level);
  for (let k = 0; k < STATS.length; k++) {
    const o = overrides?.[k] ?? {};
    for (const t of TUNABLE) {
      const v = o[t.key];
      STATS[k][t.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(t.max, Math.max(t.min, v)) : DEFAULT_STATS[k][t.key];
    }
  }
}

/** Smooth movement: acceleration/braking (tiles/s^2) and turn rate (1/s). */
export const MOTION = {
  accel: 16,
  /** Speed retained per step while stopping or turning sharply. */
  brake: 0.6,
  turn: 12,
};

/** Tank effect constants. */
export const TANK = {
  /** cos(60 degrees) for the half-angle of the Shield knockback cone. */
  coneCos: 0.5,
  stun: 0.3,
  /** Knockback speed decays by this factor per step (30 Hz). */
  kbDecay: 0.7,
  /** Tank bonus in target scoring (smaller = more attractive) and the number of melee slots for a tank. */
  tauntBonus: 5,
  meleeSlots: 5,
  /** Radius within which a tank pushes nearby units. */
  pushRadius: 1.8,
};

/** Kiting and pathfinding settings: kept in one place for easy tuning. */
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
  /** Blend weight toward the own army's center in the escape direction. */
  armyPull: 0.35,
  /** Archers/priests never get further than this in front of their own warrior center. */
  leash: 1.0,
  /** Threat scan every N steps (staggered per unit). */
  scanEvery: 3,
};

/** Struct-of-arrays unit store: ready for large-scale benchmarks. */
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
  /** 1: retreating (kiting). */
  kiteState: Uint8Array;
  /** Distance to the nearest melee threat (Infinity: none) and the unit vector pointing away from it. */
  threatDist: Float32Array;
  threatDx: Float32Array;
  threatDy: Float32Array;
  /** River crossing: chosen bridge (-1: none) and phase (0: go to the entrance, 1: cross over). */
  route: Int16Array;
  routePhase: Uint8Array;
  /** Stuck breaker: accumulated time and sidestep time/direction. */
  stuckT: Float32Array;
  sideT: Float32Array;
  sideDir: Int8Array;
  /** Knockback velocity (tiles/s) and stun duration. */
  kbVx: Float32Array;
  kbVy: Float32Array;
  stunT: Float32Array;
  /** Banned target and remaining time (progress watchdog). */
  banTarget: Int32Array;
  banT: Float32Array;
  /** Time spent chasing the target and the closest distance reached so far. */
  chaseT: Float32Array;
  chaseBest: Float32Array;
  /** Time spent waiting because of the leash and the time the leash stays disabled. */
  holdT: Float32Array;
  leashOffT: Float32Array;
  /** Net displacement window: start position and elapsed time (stuck detection). */
  winX: Float32Array;
  winY: Float32Array;
  winT: Float32Array;
  /** Smooth movement: current speed magnitude and heading (unit vector). */
  spd: Float32Array;
  hx: Float32Array;
  hy: Float32Array;
  /** Status effects (slow, burn, shield, fear, weaken, invulnerability, taunt). */
  slowT: Float32Array;
  slowK: Float32Array;
  slowA: Float32Array;
  burnT: Float32Array;
  burnDps: Float32Array;
  shieldT: Float32Array;
  shieldK: Float32Array;
  fearT: Float32Array;
  fearX: Float32Array;
  fearY: Float32Array;
  weakT: Float32Array;
  weakK: Float32Array;
  invulnT: Float32Array;
  tauntT: Float32Array;
  tauntBy: Int32Array;
  /** Skill counter (triggers every N attacks), periodic skill timer, stacks and stack duration. */
  skillN: Uint8Array;
  skillT: Float32Array;
  stacks: Uint8Array;
  stackT: Float32Array;
  /** Bit flags (F_*): revived, rage, exploded. */
  flags: Uint8Array;
  /** Owner of a summoned unit (-1: none). */
  owner: Int32Array;
  /** Visual status mask (ST_*): read by the renderer for tinting. */
  status: Uint8Array;
  /** Separation push (smoothed velocity, tiles/step). */
  sepX: Float32Array;
  sepY: Float32Array;
  /** Uninterrupted time spent in range of the target (for resetting the progress watchdog). */
  rangeT: Float32Array;
  /** Comedy physics: flight time (remaining/total), start and end points, peak height, current height (tiles), re-launch immunity. */
  airT: Float32Array;
  airDur: Float32Array;
  airX0: Float32Array;
  airY0: Float32Array;
  airX1: Float32Array;
  airY1: Float32Array;
  airH: Float32Array;
  lift: Float32Array;
  airImm: Float32Array;

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
    this.slowT = new Float32Array(cap);
    this.slowK = new Float32Array(cap);
    this.slowA = new Float32Array(cap);
    this.burnT = new Float32Array(cap);
    this.burnDps = new Float32Array(cap);
    this.shieldT = new Float32Array(cap);
    this.shieldK = new Float32Array(cap);
    this.fearT = new Float32Array(cap);
    this.fearX = new Float32Array(cap);
    this.fearY = new Float32Array(cap);
    this.weakT = new Float32Array(cap);
    this.weakK = new Float32Array(cap);
    this.invulnT = new Float32Array(cap);
    this.tauntT = new Float32Array(cap);
    this.tauntBy = new Int32Array(cap).fill(-1);
    this.skillN = new Uint8Array(cap);
    this.skillT = new Float32Array(cap);
    this.stacks = new Uint8Array(cap);
    this.stackT = new Float32Array(cap);
    this.flags = new Uint8Array(cap);
    this.owner = new Int32Array(cap).fill(-1);
    this.status = new Uint8Array(cap);
    this.sepX = new Float32Array(cap);
    this.sepY = new Float32Array(cap);
    this.rangeT = new Float32Array(cap);
    this.airT = new Float32Array(cap);
    this.airDur = new Float32Array(cap);
    this.airX0 = new Float32Array(cap);
    this.airY0 = new Float32Array(cap);
    this.airX1 = new Float32Array(cap);
    this.airY1 = new Float32Array(cap);
    this.airH = new Float32Array(cap);
    this.lift = new Float32Array(cap);
    this.airImm = new Float32Array(cap);
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
    this.slowT[i] = this.burnT[i] = this.shieldT[i] = this.fearT[i] = this.weakT[i] = this.invulnT[i] = this.tauntT[i] = 0;
    this.slowK[i] = this.slowA[i] = this.shieldK[i] = this.weakK[i] = 1;
    this.burnDps[i] = 0;
    this.tauntBy[i] = -1;
    this.skillN[i] = this.stacks[i] = this.flags[i] = 0;
    this.skillT[i] = this.stackT[i] = 0;
    this.owner[i] = -1;
    this.status[i] = 0;
    this.sepX[i] = this.sepY[i] = 0;
    this.rangeT[i] = 0;
    this.airT[i] = this.airDur[i] = this.airH[i] = this.lift[i] = this.airImm[i] = 0;
    return i;
  }
}

/** Projectile look: 0 arrow, 1 fireball, 2 ice, 3 bomb, 4 rock, 5 holy orb, 6 dark orb, 7 cannonball, 8 spear, 9 axe, 10 energy. */
const TAG_OF: Record<string, number> = {
  'ember-adept': 1,
  'sun-priest': 1,
  'horned-seer': 1,
  'flame-herald': 1,
  'pyre-sling': 4,
  'cinder-golem': 4,
  'frost-adept': 2,
  'rime-archers': 2,
  grenadier: 3,
  lorekeeper: 5,
  mender: 5,
  'bone-caller': 6,
  'hex-witch': 6,
  'war-barge': 7,
  javelineers: 8,
  'bolt-thrower': 8,
  'axe-warden': 9,
  'sand-king': 10,
};
export const PROJ_TAG = new Uint8Array(KIND_COUNT);
STATS.forEach((s, i) => (PROJ_TAG[i] = s.troop ? (TAG_OF[s.troop] ?? 0) : 0));

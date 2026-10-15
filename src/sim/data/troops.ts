/**
 * Unit roster. Every unit is original: names, role archetypes, level curves and skill texts are authored for this game.
 * Stats are produced by a role/rarity budget (see `levelsFor`) in "raw" units; `src/sim/units.ts` normalizes them to
 * game scale (HP_DIV / ATK_DIV / ARMOR_K).
 */
import type { Localized } from '../../contracts/localized';
import { ARM, DMG } from './combat';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export type Race = 'human' | 'dark' | 'sacred' | 'wild';
/** 0 very slow .. 4 very fast. */
export type MoveClass = 0 | 1 | 2 | 3 | 4;
export type Shape = 'single' | 'round' | 'rect' | 'pierce';
/** Skill id; the engine in src/sim/battle.ts maps it to behaviour (null: no skill). */
export type SkillId =
  | 'summonSkeleton'
  | 'revive'
  | 'heal'
  | 'cleanse'
  | 'bash'
  | 'knives'
  | 'rage'
  | 'frostBlast'
  | 'shield'
  | 'burnOil'
  | 'explode'
  | 'thorns'
  | 'stun'
  | 'fireball'
  | 'lifesteal'
  | 'charge'
  | 'spearBuild'
  | 'withstand'
  | 'orbs'
  | 'destinyBond'
  | 'mock'
  | 'hex'
  | 'ship'
  | 'taunt'
  | 'swarm'
  | 'axes'
  | 'fear'
  | 'rockThrow'
  | 'refraction'
  | 'chill'
  | 'crit'
  | 'curseZone'
  | 'stoneWill';

export interface TroopDef {
  id: string;
  name: string;
  rarity: Rarity;
  race: Race;
  move: MoveClass;
  /** Attacks per second. */
  atkSpd: number;
  /** Strike distance in tiles (melee reach) or range for ranged units. */
  reach: number;
  ranged: boolean;
  magical: boolean;
  shape: Shape;
  /** Area damage radius in tiles (0: single target). */
  aoe: number;
  skill: SkillId | null;
  /** Short skill description. */
  skillText: Localized;
  /** Only arrives through summoning/reviving; not in the placement list. */
  summoned?: boolean;
  /**
   * Structure: a fixed object placed by a game mode (never bought, placed or moved by players; it has no attack, no skill and
   * ignores knockback / launch / stun / fear / taunt). Always also `summoned`, which hides it from every placement list.
   * A structure with `ranged: true` is ARMED (Lane Conquest tower): it still never moves, but fires at the nearest enemy unit in range.
   */
  structure?: boolean;
  /** Base stats: [hp, attack, defense]. */
  base: [number, number, number];
  /** Damage type of its attacks and armor class of its body (indices, see data/combat.ts). */
  dmgType: number;
  armorClass: number;
}

/** Role archetypes: share of the rarity budget spent on hp / attack and the base defense. */
type Role = 'tank' | 'bruiser' | 'skirmisher' | 'archer' | 'mage' | 'support' | 'siege' | 'glass';
const ROLE: Record<Role, { hp: number; atk: number; def: number }> = {
  tank: { hp: 0.62, atk: 0.12, def: 60 },
  bruiser: { hp: 0.45, atk: 0.26, def: 30 },
  skirmisher: { hp: 0.34, atk: 0.36, def: 18 },
  archer: { hp: 0.3, atk: 0.42, def: 12 },
  mage: { hp: 0.28, atk: 0.48, def: 10 },
  support: { hp: 0.5, atk: 0.18, def: 32 },
  siege: { hp: 0.46, atk: 0.42, def: 12 },
  glass: { hp: 0.2, atk: 0.6, def: 6 },
};
const BUDGET: Record<Rarity, number> = { common: 1000, rare: 1450, epic: 2250, legendary: 3500 };
/** Builds the base [hp, attack, defense] row from a role, a rarity and per-unit tweaks (hp x, attack x, defense +). */
function baseFor(rarity: Rarity, role: Role, hpX = 1, atkX = 1, defAdd = 0): [number, number, number] {
  const b = BUDGET[rarity];
  const r = ROLE[role];
  return [Math.round((b * r.hp * 1.6 * hpX) / 10) * 10, Math.round((b * r.atk * 0.2 * atkX) / 5) * 5, Math.round(r.def + defAdd)];
}

/**
 * Damage type / armor class per roster unit: S slash, P pierce, B blunt, M magic / L light, M medium, H heavy, S spirit.
 * Slash beats light, pierce beats medium, blunt beats heavy, magic beats spirit and heavy (see TYPE_MULT).
 */
const TYPING: Record<string, string> = {
  militia: 'S-M', longbowmen: 'P-L', 'bulwark-guard': 'B-H', grenadier: 'B-L', 'pyre-sling': 'B-L', 'dungeon-warden': 'B-M', 'bone-soldier': 'S-S',
  'ember-adept': 'M-L', cutpurses: 'S-L', 'hill-brute': 'B-M', 'shade-blades': 'S-S', 'spark-novice': 'M-L', berserker: 'S-M', 'frost-adept': 'M-L',
  lorekeeper: 'M-L', zealot: 'P-M', 'risen-guard': 'S-S', 'flame-herald': 'M-M', oathkeeper: 'B-H', 'bolt-thrower': 'P-L', 'blast-imps': 'B-L',
  thornlings: 'P-M', 'bone-caller': 'M-L', wayfarers: 'B-L', 'night-lancer': 'P-M', 'sun-priest': 'M-L', 'soul-reaver': 'S-S', 'lancer-knight': 'P-H',
  javelineers: 'P-L', 'pit-fighters': 'B-M', 'horned-seer': 'M-L', 'hex-poppets': 'P-S', scarecrow: 'B-M', 'hex-witch': 'M-L', mender: 'M-L',
  'war-barge': 'B-H', 'ash-fiend': 'S-M', 'axe-warden': 'S-M', 'dread-totem': 'M-S', 'cinder-golem': 'B-H', 'dawn-blade': 'S-M', 'rime-archers': 'P-L',
  'tusk-rider': 'P-H', 'sand-king': 'M-S', 'granite-colossus': 'B-H', 'siege-core': 'B-M', 'lane-castle': 'B-H', 'lane-tower': 'P-H',
};
const DMG_CODE: Record<string, number> = { S: DMG.slash, P: DMG.pierce, B: DMG.blunt, M: DMG.magic };
const ARM_CODE: Record<string, number> = { L: ARM.light, M: ARM.medium, H: ARM.heavy, S: ARM.spirit };
function typingOf(id: string): [number, number] {
  const code = TYPING[id];
  if (!code) throw new Error(`missing damage/armor typing for ${id}`);
  const [d, a] = code.split('-');
  return [DMG_CODE[d], ARM_CODE[a]];
}

const L = (en: string, tr: string): Localized => ({ en, tr });
const NONE = L('', '');

interface Spec {
  id: string;
  name: string;
  rarity: Rarity;
  race: Race;
  role: Role;
  move: MoveClass;
  atkSpd: number;
  reach: number;
  ranged?: boolean;
  magical?: boolean;
  shape?: Shape;
  aoe?: number;
  skill?: SkillId | null;
  text?: Localized;
  summoned?: boolean;
  structure?: boolean;
  /** Explicit base row [hp, attack, defense] instead of the role / rarity budget. */
  base?: [number, number, number];
  tweak?: [number, number, number];
}

const T = (s: Spec): TroopDef => ({
  id: s.id,
  name: s.name,
  rarity: s.rarity,
  race: s.race,
  move: s.move,
  atkSpd: s.atkSpd,
  reach: s.reach,
  ranged: !!s.ranged,
  magical: !!s.magical,
  shape: s.shape ?? 'single',
  aoe: s.aoe ?? 0,
  skill: s.skill ?? null,
  skillText: s.text ?? NONE,
  summoned: s.summoned,
  structure: s.structure,
  base: s.base ?? baseFor(s.rarity, s.role, ...(s.tweak ?? [1, 1, 0])),
  dmgType: typingOf(s.id)[0],
  armorClass: typingOf(s.id)[1],
});

// Reach: short 1.0, medium 1.8, long 2.6; ranged: bows/spells 8-9, siege 10-13.
export const TROOPS: TroopDef[] = [
  // ---- Common ----
  T({ id: 'militia', name: 'Militia', rarity: 'common', race: 'human', role: 'bruiser', move: 2, atkSpd: 1.1, reach: 1.0, tweak: [1, 1.5, 0] }),
  T({ id: 'longbowmen', name: 'Longbowmen', rarity: 'common', race: 'human', role: 'archer', move: 0, atkSpd: 0.8, reach: 9, ranged: true, tweak: [1.1, 1.25, 0] }),
  T({ id: 'bulwark-guard', name: 'Bulwark Guard', rarity: 'common', race: 'human', role: 'tank', move: 2, atkSpd: 1.1, reach: 1.0, tweak: [1.05, 1.9, 0] }),
  T({
    id: 'grenadier',
    name: 'Grenadier',
    rarity: 'common',
    race: 'human',
    role: 'glass',
    move: 0,
    atkSpd: 0.7,
    reach: 8,
    ranged: true,
    shape: 'round',
    aoe: 3,
    text: L('Hurls bombs that hurt everyone around the target.', 'Hedefin çevresindeki herkese zarar veren bombalar atar.'),
    tweak: [1.2, 0.8, 0],
  }),
  T({
    id: 'pyre-sling',
    name: 'Pyre Sling',
    rarity: 'common',
    race: 'human',
    role: 'siege',
    move: 0,
    atkSpd: 0.2,
    reach: 12,
    ranged: true,
    shape: 'round',
    aoe: 4,
    skill: 'burnOil',
    text: L('Flaming shot sets the ground ablaze and keeps burning the area.', 'Alevli mermi zemini tutuşturur ve bölgeyi yanmaya devam ettirir.'),
  }),
  T({ id: 'dungeon-warden', name: 'Dungeon Warden', rarity: 'common', race: 'dark', role: 'bruiser', move: 3, atkSpd: 1.1, reach: 1.0, tweak: [1.0, 1.35, 0] }),
  T({
    id: 'bone-soldier',
    name: 'Bone Soldier',
    rarity: 'common',
    race: 'dark',
    role: 'bruiser',
    move: 2,
    atkSpd: 1.1,
    reach: 1.0,
    summoned: true,
    text: L('Summoned by a Bone Caller.', 'Bir Kemik Çağırıcı tarafından çağrılır.'),
    tweak: [0.8, 0.85, -10],
  }),
  // ---- Rare ----
  T({ id: 'ember-adept', name: 'Ember Adept', rarity: 'rare', race: 'human', role: 'mage', move: 0, atkSpd: 0.7, reach: 8.5, ranged: true, magical: true, shape: 'round', aoe: 4 }),
  T({ id: 'cutpurses', name: 'Cutpurses', rarity: 'rare', race: 'human', role: 'skirmisher', move: 1, atkSpd: 1.25, reach: 1.0, tweak: [1.2, 1.2, 0] }),
  T({
    id: 'hill-brute',
    name: 'Hill Brute',
    rarity: 'rare',
    race: 'wild',
    role: 'bruiser',
    move: 2,
    atkSpd: 0.9,
    reach: 1.8,
    skill: 'bash',
    text: L('Heavy blow: damages an area and shoves enemies back.', 'Ağır darbe: alana hasar verir ve düşmanları geri iter.'),
    tweak: [1.9, 1.2, 4],
  }),
  T({
    id: 'shade-blades',
    name: 'Shade Blades',
    rarity: 'rare',
    race: 'dark',
    role: 'glass',
    move: 2,
    atkSpd: 1.2,
    reach: 1.0,
    skill: 'knives',
    text: L('Every 6th attack hurls deadly knives at nearby enemies.', 'Her 6. saldırıda yakındaki düşmanlara ölümcül bıçaklar fırlatır.'),
    tweak: [1.35, 1.0, 0],
  }),
  T({ id: 'spark-novice', name: 'Spark Novice', rarity: 'rare', race: 'human', role: 'mage', move: 4, atkSpd: 0.8, reach: 1.0, magical: true, shape: 'round', aoe: 3, tweak: [0.85, 0.75, 0] }),
  T({
    id: 'berserker',
    name: 'Berserker',
    rarity: 'rare',
    race: 'human',
    role: 'bruiser',
    move: 2,
    atkSpd: 1.1,
    reach: 1.0,
    skill: 'rage',
    text: L('Below 50% health it goes berserk: more damage and speed.', 'Canı %50’nin altına düşünce çılgına döner: daha çok hasar ve hız.'),
    tweak: [1.6, 0.95, 0],
  }),
  T({
    id: 'frost-adept',
    name: 'Frost Adept',
    rarity: 'rare',
    race: 'human',
    role: 'mage',
    move: 0,
    atkSpd: 0.7,
    reach: 8.5,
    ranged: true,
    magical: true,
    shape: 'round',
    aoe: 4,
    skill: 'frostBlast',
    text: L('Every 4th attack releases a frost burst that damages and slows enemies.', 'Her 4. saldırıda buz patlaması yapar: hasar verir ve düşmanları yavaşlatır.'),
    tweak: [1, 0.9, 0],
  }),
  T({ id: 'lorekeeper', name: 'Lorekeeper', rarity: 'rare', race: 'sacred', role: 'mage', move: 0, atkSpd: 0.7, reach: 8.5, ranged: true, magical: true, shape: 'round', aoe: 4, tweak: [1.1, 0.85, 0] }),
  T({ id: 'zealot', name: 'Zealot', rarity: 'rare', race: 'sacred', role: 'skirmisher', move: 2, atkSpd: 1.2, reach: 1.8, tweak: [1.15, 1.2, 14] }),
  T({
    id: 'risen-guard',
    name: 'Risen Guard',
    rarity: 'rare',
    race: 'dark',
    role: 'bruiser',
    move: 3,
    atkSpd: 1.3,
    reach: 1.0,
    skill: 'revive',
    text: L('Rises once from the dead during a battle.', 'Savaş boyunca bir kez ölümden döner.'),
    tweak: [0.95, 1.05, -2],
  }),
  T({ id: 'flame-herald', name: 'Flame Herald', rarity: 'rare', race: 'sacred', role: 'bruiser', move: 2, atkSpd: 0.7, reach: 1.0, magical: true, shape: 'rect', aoe: 1.8, tweak: [1.25, 0.95, -4] }),
  T({
    id: 'oathkeeper',
    name: 'Oathkeeper',
    rarity: 'rare',
    race: 'sacred',
    role: 'tank',
    move: 2,
    atkSpd: 1.0,
    reach: 1.0,
    skill: 'shield',
    text: L('Every 5th attack shields wounded allies nearby.', 'Her 5. saldırıda yakındaki yaralı müttefiklere koruyucu kalkan verir.'),
    tweak: [1.0, 1.7, 4],
  }),
  T({
    id: 'bolt-thrower',
    name: 'Bolt Thrower',
    rarity: 'rare',
    race: 'human',
    role: 'siege',
    move: 0,
    atkSpd: 0.3,
    reach: 13,
    ranged: true,
    shape: 'pierce',
    skill: 'crit',
    text: L('Bolts have a chance to strike critically.', 'Oklar belli bir olasılıkla kritik vuruş yapar.'),
    tweak: [0.9, 1.1, 0],
  }),
  T({
    id: 'blast-imps',
    name: 'Blast Imps',
    rarity: 'rare',
    race: 'wild',
    role: 'glass',
    move: 2,
    atkSpd: 1.0,
    reach: 1.0,
    shape: 'round',
    aoe: 3,
    skill: 'explode',
    text: L('Bursts on contact or on death, scorching the ground.', 'Düşmana değince ya da ölünce patlar, yeri yakar.'),
    tweak: [0.95, 1.4, 0],
  }),
  T({
    id: 'thornlings',
    name: 'Thornlings',
    rarity: 'rare',
    race: 'wild',
    role: 'skirmisher',
    move: 2,
    atkSpd: 0.9,
    reach: 1.0,
    skill: 'thorns',
    text: L('Reflects part of melee damage back at the attacker.', 'Yakın dövüş hasarının bir kısmını saldırgana yansıtır.'),
    tweak: [1.2, 1.4, 4],
  }),
  // ---- Epic ----
  T({
    id: 'bone-caller',
    name: 'Bone Caller',
    rarity: 'epic',
    race: 'dark',
    role: 'support',
    move: 0,
    atkSpd: 0.35,
    reach: 8.5,
    ranged: true,
    magical: true,
    skill: 'summonSkeleton',
    text: L('Calls up bone soldiers to fight for it.', 'Kendisi için savaşacak kemik askerler çağırır.'),
    tweak: [0.5, 0.9, -12],
  }),
  T({
    id: 'wayfarers',
    name: 'Wayfarers',
    rarity: 'epic',
    race: 'sacred',
    role: 'support',
    move: 2,
    atkSpd: 1.0,
    reach: 1.0,
    skill: 'heal',
    text: L('Heals friendly units close by.', 'Yakındaki dost birimleri iyileştirir.'),
    tweak: [0.95, 0.9, 0],
  }),
  T({
    id: 'night-lancer',
    name: 'Night Lancer',
    rarity: 'epic',
    race: 'dark',
    role: 'skirmisher',
    move: 2,
    atkSpd: 1.1,
    reach: 1.8,
    skill: 'stun',
    text: L('A powerful thrust hits the enemies ahead and stuns them.', 'Güçlü bir saplama öndeki düşmanlara vurur ve sersemletir.'),
    tweak: [1.0, 0.75, 0],
  }),
  T({
    id: 'sun-priest',
    name: 'Sun Priest',
    rarity: 'epic',
    race: 'sacred',
    role: 'mage',
    move: 0,
    atkSpd: 0.7,
    reach: 8.5,
    ranged: true,
    magical: true,
    shape: 'round',
    aoe: 5,
    skill: 'fireball',
    text: L('A fireball damages an area and splits into smaller shots.', 'Ateş topu alana hasar verir ve daha küçük toplara bölünür.'),
    tweak: [0.8, 0.9, 0],
  }),
  T({
    id: 'soul-reaver',
    name: 'Soul Reaver',
    rarity: 'epic',
    race: 'dark',
    role: 'skirmisher',
    move: 2,
    atkSpd: 1.2,
    reach: 1.0,
    shape: 'round',
    aoe: 4,
    skill: 'lifesteal',
    text: L('Every hit steals health from the target.', 'Her vuruşta hedefin canını çalar.'),
    tweak: [1.4, 1.0, -4],
  }),
  T({
    id: 'lancer-knight',
    name: 'Lancer Knight',
    rarity: 'epic',
    race: 'sacred',
    role: 'bruiser',
    move: 4,
    atkSpd: 1.1,
    reach: 1.0,
    skill: 'charge',
    text: L('Its lance pierces through enemies ahead and knocks them aside.', 'Mızrağı öndeki düşmanları delip geçer ve kenara iter.'),
    tweak: [1.7, 1.0, 12],
  }),
  T({
    id: 'javelineers',
    name: 'Javelineers',
    rarity: 'epic',
    race: 'human',
    role: 'archer',
    move: 2,
    atkSpd: 1.0,
    reach: 8,
    ranged: true,
    shape: 'pierce',
    skill: 'spearBuild',
    text: L('Each javelin thrown makes the next one hit harder.', 'Her fırlatılan cirit bir sonrakini daha sert vurdurur.'),
    tweak: [0.95, 1.1, 0],
  }),
  T({
    id: 'pit-fighters',
    name: 'Pit Fighters',
    rarity: 'epic',
    race: 'human',
    role: 'tank',
    move: 2,
    atkSpd: 1.0,
    reach: 1.0,
    skill: 'withstand',
    text: L('After a few attacks it grants nearby allies a damage-reducing guard.', 'Birkaç saldırıdan sonra yakındaki dostlara hasar azaltan bir koruma verir.'),
    tweak: [0.95, 1.1, 4],
  }),
  T({
    id: 'horned-seer',
    name: 'Horned Seer',
    rarity: 'epic',
    race: 'wild',
    role: 'mage',
    move: 0,
    atkSpd: 0.9,
    reach: 8.5,
    ranged: true,
    magical: true,
    skill: 'orbs',
    text: L('Sends fire orbs at several enemies at once.', 'Aynı anda birden çok düşmana ateş küresi gönderir.'),
    tweak: [0.85, 0.95, 0],
  }),
  T({
    id: 'hex-poppets',
    name: 'Hex Poppets',
    rarity: 'epic',
    race: 'dark',
    role: 'glass',
    move: 1,
    atkSpd: 1.3,
    reach: 1.0,
    skill: 'destinyBond',
    text: L('Curses enemies at the start; when a poppet is hurt, the cursed share the pain.', 'Savaş başında düşmanları lanetler; kukla zarar görünce lanetliler de aynı acıyı paylaşır.'),
    tweak: [0.55, 1.5, -6],
  }),
  T({
    id: 'scarecrow',
    name: 'Scarecrow Sentinel',
    rarity: 'epic',
    race: 'dark',
    role: 'tank',
    move: 2,
    atkSpd: 0.8,
    reach: 1.0,
    skill: 'mock',
    text: L('Provokes nearby enemies and weakens their attacks.', 'Yakındaki düşmanları kışkırtır ve saldırılarını zayıflatır.'),
    tweak: [1.2, 1.1, 8],
  }),
  T({
    id: 'hex-witch',
    name: 'Hex Witch',
    rarity: 'epic',
    race: 'dark',
    role: 'mage',
    move: 0,
    atkSpd: 0.33,
    reach: 8.5,
    ranged: true,
    magical: true,
    shape: 'round',
    aoe: 4,
    skill: 'hex',
    text: L('Hexes the target: it cannot move or attack for a moment.', 'Hedefi büyüler: bir süre hareket edemez ve saldıramaz.'),
    tweak: [0.8, 0.3, 0],
  }),
  T({
    id: 'mender',
    name: 'Mender',
    rarity: 'epic',
    race: 'human',
    role: 'support',
    move: 0,
    atkSpd: 0.5,
    reach: 8,
    ranged: true,
    magical: true,
    skill: 'cleanse',
    text: L('Heals allies in range and clears control effects from them.', 'Menzildeki dostları iyileştirir ve üzerlerindeki kontrol etkilerini kaldırır.'),
    tweak: [0.75, 1.3, -10],
  }),
  T({
    id: 'war-barge',
    name: 'War Barge',
    rarity: 'epic',
    race: 'human',
    role: 'siege',
    move: 0,
    atkSpd: 0.2,
    reach: 10,
    ranged: true,
    shape: 'round',
    aoe: 4,
    skill: 'ship',
    text: L('The crew protects it; the launched barge deals damage and stuns.', 'Mürettebat onu korur; fırlatılan mavna hasar verir ve sersemletir.'),
    tweak: [1.35, 1.3, 6],
  }),
  // ---- Legendary ----
  T({
    id: 'ash-fiend',
    name: 'Ash Fiend',
    rarity: 'legendary',
    race: 'dark',
    role: 'skirmisher',
    move: 2,
    atkSpd: 1.0,
    reach: 1.0,
    skill: 'swarm',
    text: L('Releases a swarm of winged creatures that damages the area ahead.', 'Kanatlı yaratıklardan oluşan bir sürü salar ve öndeki bölgeye hasar verir.'),
    tweak: [1.3, 0.95, 6],
  }),
  T({
    id: 'axe-warden',
    name: 'Axe Warden',
    rarity: 'legendary',
    race: 'sacred',
    role: 'skirmisher',
    move: 2,
    atkSpd: 1.1,
    reach: 7,
    ranged: true,
    skill: 'axes',
    text: L('Throws axes that cut through every enemy along a line.', 'Bir çizgi boyunca tüm düşmanları kesen baltalar fırlatır.'),
    tweak: [1.3, 0.9, 8],
  }),
  T({
    id: 'dread-totem',
    name: 'Dread Totem',
    rarity: 'legendary',
    race: 'wild',
    role: 'support',
    move: 3,
    atkSpd: 1.2,
    reach: 1.0,
    skill: 'fear',
    text: L('Terrifies the enemies around it so they flee.', 'Çevresindeki düşmanları korkutur, kaçarlar.'),
    tweak: [1.1, 0.95, 4],
  }),
  T({
    id: 'cinder-golem',
    name: 'Cinder Golem',
    rarity: 'legendary',
    race: 'dark',
    role: 'bruiser',
    move: 2,
    atkSpd: 0.9,
    reach: 1.0,
    shape: 'round',
    aoe: 3.4,
    skill: 'rockThrow',
    text: L('Hurls huge burning rocks: area damage and a stun.', 'Dev yanan kayalar fırlatır: alan hasarı ve sersemletme.'),
    tweak: [1.2, 0.95, 6],
  }),
  T({
    id: 'dawn-blade',
    name: 'Dawn Blade',
    rarity: 'legendary',
    race: 'sacred',
    role: 'skirmisher',
    move: 3,
    atkSpd: 1.3,
    reach: 1.8,
    shape: 'rect',
    aoe: 2,
    skill: 'refraction',
    text: L('Turns to light and cuts nearby enemies; invulnerable meanwhile.', 'Işığa dönüşüp yakın düşmanları keser; bu sırada dokunulmazdır.'),
    tweak: [1.0, 1.15, 4],
  }),
  T({
    id: 'rime-archers',
    name: 'Rime Archers',
    rarity: 'legendary',
    race: 'sacred',
    role: 'archer',
    move: 0,
    atkSpd: 0.8,
    reach: 9,
    ranged: true,
    skill: 'chill',
    text: L('Arrows slow attack and movement; every third arrow freezes.', 'Oklar saldırı ve hareket hızını düşürür; her üçüncü ok dondurur.'),
    tweak: [0.75, 1.15, 0],
  }),
  T({ id: 'tusk-rider', name: 'Tusk Rider', rarity: 'legendary', race: 'wild', role: 'bruiser', move: 4, atkSpd: 2.0, reach: 1.0, shape: 'rect', aoe: 1.5, tweak: [1.45, 1.5, 6] }),
  T({
    id: 'sand-king',
    name: 'Sand King',
    rarity: 'legendary',
    race: 'human',
    role: 'mage',
    move: 0,
    atkSpd: 0.7,
    reach: 8.5,
    ranged: true,
    magical: true,
    shape: 'round',
    aoe: 4,
    skill: 'curseZone',
    text: L('Desert curse: enemies in the zone take damage over time and slow down.', 'Çöl laneti: bölgedeki düşmanlar süreli hasar alır ve yavaşlar.'),
    tweak: [1.15, 1.1, 6],
  }),
  T({
    id: 'granite-colossus',
    name: 'Granite Colossus',
    rarity: 'legendary',
    race: 'wild',
    role: 'tank',
    move: 1,
    atkSpd: 0.8,
    reach: 1.0,
    shape: 'round',
    aoe: 4,
    skill: 'stoneWill',
    text: L('Becomes immune to damage; hits an area and slows enemies.', 'Hasara karşı bağışık olur; alana vurur ve düşmanları yavaşlatır.'),
    tweak: [1.15, 1.25, 8],
  }),
  // ---- Structures (game-mode objects; always at the end so the kind numbers of the units above never change) ----
  T({
    id: 'siege-core',
    name: 'Siege Core',
    rarity: 'legendary',
    race: 'human',
    role: 'tank',
    move: 0,
    atkSpd: 0.2,
    reach: 0,
    summoned: true,
    structure: true,
    text: L('The keep the defenders must hold.', 'Savunmacıların tutması gereken hisar.'),
    base: [15000, 0, 55],
  }),
  // Lane Conquest: the castle each team defends and the towers along the lanes (see sim/modes/lanes.ts).
  T({
    id: 'lane-castle',
    name: 'Lane Castle',
    rarity: 'legendary',
    race: 'human',
    role: 'tank',
    move: 0,
    atkSpd: 0.2,
    reach: 0,
    summoned: true,
    structure: true,
    text: L('The castle of a team: destroy the enemy one to win.', 'Bir takımın kalesi: kazanmak için düşman kaleyi yık.'),
    base: [25000, 0, 55],
  }),
  T({
    id: 'lane-tower',
    name: 'Lane Tower',
    rarity: 'legendary',
    race: 'human',
    role: 'archer',
    move: 0,
    atkSpd: 1 / 1.2,
    reach: 9,
    ranged: true,
    summoned: true,
    structure: true,
    text: L('A stone tower: never moves and shoots the nearest enemy soldier in range.', 'Taş kule: yerinden oynamaz ve menzildeki en yakın düşman askere ok atar.'),
    base: [4500, 182, 55],
  }),
];

export const TROOP_BY_ID: Record<string, TroopDef> = Object.fromEntries(TROOPS.map((t) => [t.id, t]));

export const RARITY_NAMES: Record<Rarity, Localized> = {
  common: { en: 'Common', tr: 'Yaygın' },
  rare: { en: 'Rare', tr: 'Nadir' },
  epic: { en: 'Epic', tr: 'Destansı' },
  legendary: { en: 'Legendary', tr: 'Efsanevi' },
};
export const RACE_NAMES: Record<Race, Localized> = {
  human: { en: 'Human', tr: 'İnsan' },
  dark: { en: 'Dark', tr: 'Karanlık' },
  sacred: { en: 'Sacred', tr: 'Kutsal' },
  wild: { en: 'Wild', tr: 'Vahşi' },
};

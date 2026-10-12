import { Grid } from './grid';
import { Terrain, T_BLOCKED, T_WATER } from './terrain';
import type { MapSpec } from './mapSpec';
import { DEFAULT_LEVEL, PROJ_TAG, F_EXPLODED, F_RAGE, F_REVIVED, KIND_OF_TROOP, ST_BURN, ST_FEAR, ST_INVULN, ST_SHIELD, ST_SLOW, ST_STUN, ST_TAUNT, KITE, Kind, MAX_TEAMS, MOTION, STATS, TANK, Units, applyStats, isHealer, isMelee, isRanged, isTank, type StatOverrides } from './units';
import { PF_PIERCE, PF_SKILL, Projectiles } from './projectiles';
import { SKILL_ELEMENT, skillParams, type SkillParams } from './data/skills';
import type { SkillId } from './data/troops';
import { mulberry32 } from './random';

export const MAP_SIZE = 56;
const ARROW_SPEED = 13;
const MELEE_SLOTS = 3;
const SEPARATION_RADIUS = 0.9;
const LANDING_RADIUS = 0.75;
const GRID_CELL = 4;
/** Ayrisma icin ince grid: hucre ~ ayrisma yaricapi, 3x3 komsuluk yeterli. */
const SEP_CELL = 1;
/** Ayrisma her adimda birimlerin 1/SEP_STRIDE'ini isler; itme gucu ayni oranda artar. */
const SEP_STRIDE = 3;
/** Itme hizi: kazanc, adim basina en buyuk yer degistirme (tile), adim basina sonumleme. */
const SEP_GAIN = 1.5;
const SEP_MAX_STEP = 0.08;
const SEP_DECAY = 0.82;
/** Dusman bu kadar hucre halkasi icinde yoksa orduya dogru yuru. */
const MAX_RING = 6;
const PRIEST_RING = 2;
/** Karsi yakadaki dusmana hedef puani cezasi (once ayni yakadakilerle dovusulur). */
const OTHER_BANK_PENALTY = 15;
/** Bu kadar sn olum olmazsa hasar saniyede %STALE_RAMP artar. */
const STALE_AFTER = 20;
const STALE_RAMP = 0.08;
/** Hedef degistirmeye direnc (puan bonusu) ve yeniden hedef arama araligi (sn). */
const SWITCH_BONUS = 6;
/** Menzildeki hedef kilitlenir: bu carpanla menzil icindeyken yeniden hedef aranmaz. */
const ENGAGE_LOCK = 1.25;
/** Melee saldirisi menzil toleransi (kalabalikta itilen birim de vurabilsin). */
const MELEE_SLACK = 0.4;
/** Tank hedefe yakin dovus menzili ek payi (tank itmesi yaricapi 1.8 > 1.4). */
const TANK_REACH = 0.6;
/** Ilerleme bekcisi: hedefe yaklasamayan birim bu sure sonra hedefi yasaklar. */
const CHASE_TIMEOUT = 6;
const BAN_TIME = 8;
/** Leash yuzunden bu kadar sn beklerse leash gecici devre disi. */
const LEASH_HOLD_MAX = 3;
const LEASH_OFF = 8;
/** Hic hasar yoksa (sn) berabere: once hasar varsa / hic olmamissa. */
const NO_DAMAGE_DRAW = 90;
const NO_DAMAGE_DRAW_FIRST = 150;
/** Hasar verebilen birim kalmadiysa bu sure sonra berabere. */
const NO_DAMAGER_DRAW = 4;
const DEMO_GAP_HALF = 9;
const BENCH_GAP = 24;

export interface SimEvent {
  /** hit: hasar aldi (value = hasar), shot: ok atildi, land: ok bos indi, heal: iyilesti (value = miktar). */
  type: 'heal' | 'death' | 'bash' | 'slam' | 'hit' | 'shot' | 'land' | 'burst';
  x: number;
  y: number;
  unit: number;
  /** bash: itme yonu (radyan, dunya x/y duzleminde). */
  angle?: number;
  value?: number;
  /** Olay sahibi birimin turu (olum/vurus icin). */
  kind?: number;
  /** burst: etki unsuru (0 fiziksel, 1 ates, 2 buz, 3 kutsal, 4 karanlik, 5 doga, 6 enerji); value = yaricap. */
  element?: number;
}

/** Adim basina uretilen olay ust siniri (cok kalabalikta mesaj/tahsis patlamasin). */
const EVENT_CAP = 300;
/** Her Bone Caller icin on-ayrilmis (uyuyan) iskelet sayisi. */
const SUMMON_POOL = 8;

/** Kalici etki bolgesi: yanma, lanet (dusman takimlarina etkir). */
interface Zone {
  x: number;
  y: number;
  r: number;
  t: number;
  dps: number;
  /** Bolgeyi koyan takim (diger takimlar etkilenir). */
  team: number;
  slowK: number;
}

export interface BattleConfig {
  /** 'demo': 10v10 el yapimi dizilim, 'bench': takim basina perTeam birim blok dizilimi,
   *  'custom': kullanicinin yerlestirdigi `layout`. */
  mode: 'demo' | 'bench' | 'custom';
  perTeam: number;
  /** Takim sayisi (2..6); varsayilan 2. */
  teamCount?: number;
  /** custom: harita boyutu (tile). */
  mapSize?: number;
  /** custom: birimler, 4'lu gruplar halinde (takim, tur, x, y). */
  layout?: Float32Array;
  /** Birim istatistik ayarlari (tur indeksine gore); yoksa varsayilanlar. */
  stats?: StatOverrides;
  /** false: cevre (nehir, engeller) yok, eski cıplak harita. Varsayilan true. */
  env?: boolean;
  /** Roster birimlerinin seviyesi (1-10). */
  level?: number;
  /** Harita tarifi (biyom, nehir, orman, koy, gecit); yoksa varsayilan orman haritasi. */
  map?: MapSpec;
  /** Harita tohumu. */
  terrainSeed?: number;
  /** false: okcu/priest vur-kac ve cizgi siniri kapali (eski davranis, karsilastirma icin). */
  kite?: boolean;
}

export const DBG_KEYS = ['kites', 'kiteSteps', 'snapShots', 'archerDeaths', 'archerDeathsKiting', 'stuck', 'cornered'] as const;
/** Yalniz sim-ici sayaclar (dogrulama): shared'a yazilmaz. */
export const EXTRA_DBG = ['bans', 'leashBreaks', 'paths', 'pathFails'] as const;

export class Battle {
  readonly units: Units;
  readonly projectiles: Projectiles;
  readonly events: SimEvent[] = [];
  readonly mapSize: number;
  readonly config: BattleConfig;
  readonly terrain: Terrain | null;
  winner = -1;
  time = 0;
  /** Faz bazli sim suresi (ms, birikimli): hazirlik, grid, birim guncelleme, ayrisma, ok. */
  readonly prof = { prep: 0, grid: 0, units: 0, pick: 0, separate: 0, arrows: 0, steps: 0 };
  /** Davranis sayaclari (dogrulama icin). */
  readonly dbg: Record<(typeof DBG_KEYS)[number] | (typeof EXTRA_DBG)[number], number> = {
    kites: 0,
    kiteSteps: 0,
    snapShots: 0,
    archerDeaths: 0,
    archerDeathsKiting: 0,
    stuck: 0,
    cornered: 0,
    bans: 0,
    leashBreaks: 0,
    paths: 0,
    pathFails: 0,
  };
  /** Toplam hasar/sifa/olum sayaclari (ilerleme olcumu ve testler icin). */
  readonly counters = { damage: 0, heal: 0, kills: 0 };
  private lastDamageSeen = 0;
  private lastDamageT = 0;
  private noDamagerSince = -1;
  readonly alivePerTeam: number[] = new Array(MAX_TEAMS).fill(0);
  private rng: () => number = Math.random;
  private get kiteOn(): boolean {
    return this.config.kite !== false;
  }
  private stepNo = 0;
  /** Sikisan birimler icin A* yollari (birim -> ara noktalar) ve kare basina yol hesabi butcesi. */
  private readonly paths = new Map<number, { pts: number[]; k: number; gx: number; gy: number; t: number }>();
  private pathBudget = 0;
  private lastDeathTime = 0;
  private readonly centroidX: number[] = new Array(MAX_TEAMS).fill(0);
  private readonly centroidY: number[] = new Array(MAX_TEAMS).fill(0);
  /** Yakin-dovus merkezi (cizgi siniri); melee yoksa takim merkezi. */
  private readonly frontX: number[] = new Array(MAX_TEAMS).fill(0);
  private readonly frontY: number[] = new Array(MAX_TEAMS).fill(0);
  private readonly hasFront: boolean[] = new Array(MAX_TEAMS).fill(false);
  /** Takim basina en yakin canli dusman takim (-1: yok) ve canli dusman takim listesi. */
  private readonly nearestEnemy = new Int8Array(MAX_TEAMS).fill(-1);
  private readonly enemyList: number[][] = Array.from({ length: MAX_TEAMS }, () => []);
  private readonly teamCount: number;
  /** Takim basina canli ve rahip olmayan birim sayisi (yalniz rahiplerden olusan takim kacmasin). */
  private readonly damagerCount: number[] = new Array(MAX_TEAMS).fill(0);
  private readonly selfList: number[][] = Array.from({ length: MAX_TEAMS }, (_, t) => [t]);
  private readonly grids: Grid[];
  private readonly sepGrid: Grid;
  private sepTick = 0;
  private rx = 0;
  private ry = 0;
  private readonly tmpA = { x: 0, y: 0 };
  private readonly tmpB = { x: 0, y: 0 };

  constructor(seed = 1, config: BattleConfig = { mode: 'demo', perTeam: 10 }) {
    this.config = config;
    applyStats(config.stats, config.level);
    const total = unitCapacity(config);
    this.mapSize = mapSizeFor(config);
    this.terrain = terrainFor(config);
    this.units = new Units(total);
    this.projectiles = new Projectiles(projectileCapacity(config));
    this.teamCount = Math.min(MAX_TEAMS, Math.max(2, config.teamCount ?? 2));
    this.grids = Array.from({ length: this.teamCount }, () => new Grid(this.mapSize, GRID_CELL, total));
    this.sepGrid = new Grid(this.mapSize, SEP_CELL, total);
    this.reset(seed);
  }

  /** Bench modunda olum/iyilestirme olaylari uretilmez (render bunlari kullanmaz). */
  private get emitEvents(): boolean {
    return this.config.mode !== 'bench';
  }

  reset(seed: number): void {
    this.rng = mulberry32(seed);
    this.units.clear();
    this.projectiles.clear();
    this.events.length = 0;
    this.winner = -1;
    this.time = 0;
    this.stepNo = 0;
    this.lastDeathTime = 0;
    this.counters.damage = this.counters.heal = this.counters.kills = 0;
    this.lastDamageSeen = this.lastDamageT = 0;
    this.noDamagerSince = -1;
    for (const k of DBG_KEYS) this.dbg[k] = 0;
    this.dbg.bans = this.dbg.leashBreaks = this.dbg.paths = this.dbg.pathFails = 0;
    this.paths.clear();
    this.zones.length = 0;
    this.links.clear();
    this.pools.clear();
    if (this.config.mode === 'custom') {
      this.spawnLayout();
      this.setupSkills();
    } else if (this.config.mode === 'bench') {
      this.spawnBenchArmy(0, -1);
      this.spawnBenchArmy(1, 1);
    } else {
      this.spawnArmy(0, -1);
      this.spawnArmy(1, 1);
    }
    this.countAlive();
  }

  /** Kullanicinin yerlestirdigi birimler. */
  private spawnLayout(): void {
    const L = this.config.layout;
    if (!L) return;
    for (let k = 0; k + 3 < L.length; k += 4) {
      let x = L[k + 2];
      let y = L[k + 3];
      // Tohum degisince su/engel altinda kalan birim en yakin yurunebilir noktaya tasinir.
      if (this.terrain && !(this.terrain.walkable(x, y) && this.terrain.reachable(x, y))) {
        const p = this.terrain.nearestWalkable(x, y, 20, true);
        if (!p) continue;
        x = p.x;
        y = p.y;
      }
      const i = this.units.spawn(L[k] | 0, L[k + 1] | 0, x, y, this.rng);
      this.units.retarget[i] = this.rng() * 1.5;
    }
  }

  /** Ordular ekranda yatay (x-y ekseni) boyunca karsilikli dizilir; nehir aralarindadir. */
  private spawnArmy(team: number, side: number): void {
    const c = this.mapSize / 2;
    const ux = Math.SQRT1_2 * side;
    const uy = -Math.SQRT1_2 * side;
    const vx = Math.SQRT1_2;
    const vy = Math.SQRT1_2;
    const rows: Array<[number, number, number, number]> = [
      [Kind.Warrior, 5, 1.5, 0],
      [Kind.Archer, 3, 2.2, 2.5],
      [Kind.Priest, 2, 2.5, 4.5],
    ];
    for (const [kind, n, spacing, depth] of rows) {
      for (let k = 0; k < n; k++) {
        const off = (k - (n - 1) / 2) * spacing + (this.rng() - 0.5) * 0.4;
        const d = DEMO_GAP_HALF + depth + (this.rng() - 0.5) * 0.4;
        this.units.spawn(team, kind, c + ux * d + vx * off, c + uy * d + vy * off, this.rng);
      }
    }
  }

  /** Blok dizilim: onde warriorlar, arkada archerlar, en arkada priestler. */
  private spawnBenchArmy(team: number, side: number): void {
    const n = this.config.perTeam;
    const { cols, spacing } = benchLayout(n);
    const c = this.mapSize / 2;
    const ux = Math.SQRT1_2 * side;
    const uy = -Math.SQRT1_2 * side;
    const vx = Math.SQRT1_2;
    const vy = Math.SQRT1_2;
    const warriors = Math.round(n * 0.5);
    const archers = Math.round(n * 0.3);
    for (let k = 0; k < n; k++) {
      const kind = k < warriors ? Kind.Warrior : k < warriors + archers ? Kind.Archer : Kind.Priest;
      const row = Math.floor(k / cols);
      const col = k % cols;
      const off = (col - (cols - 1) / 2) * spacing + (this.rng() - 0.5) * 0.3;
      const d = BENCH_GAP / 2 + row * spacing + (this.rng() - 0.5) * 0.3;
      const i = this.units.spawn(team, kind, c + ux * d + vx * off, c + uy * d + vy * off, this.rng);
      this.units.retarget[i] = this.rng() * 3;
    }
  }

  private countAlive(): void {
    const u = this.units;
    this.alivePerTeam.fill(0);
    for (let i = 0; i < u.count; i++) if (u.alive[i]) this.alivePerTeam[u.team[i]]++;
  }

  step(dt: number): void {
    const u = this.units;
    this.time += dt;
    this.stepNo++;
    this.pathBudget = 24;
    const pf = this.prof;
    let tp = performance.now();

    u.attackers.fill(0, 0, u.count);
    u.healers.fill(0, 0, u.count);
    this.centroidX.fill(0);
    this.centroidY.fill(0);
    const n = new Array(MAX_TEAMS).fill(0);
    const wx = new Array(MAX_TEAMS).fill(0);
    const wy = new Array(MAX_TEAMS).fill(0);
    const wn = new Array(MAX_TEAMS).fill(0);
    this.damagerCount.fill(0);
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) {
        u.deathT[i] += dt;
        continue;
      }
      u.px[i] = u.x[i];
      u.py[i] = u.y[i];
      u.vx[i] = u.vy[i] = 0;
      // Onceki adimda hareket etmediyse hiz hizla sonumlenir (aniden durma yerine kisa fren).
      if (u.moving[i] === 0) u.spd[i] *= MOTION.brake;
      u.moving[i] = 0;
      u.flash[i] = Math.max(0, u.flash[i] - dt);
      const t = u.target[i];
      if (t >= 0 && u.alive[t]) {
        if (isHealer(u.kind[i])) u.healers[t]++;
        else u.attackers[t]++;
      } else if (t >= 0) {
        // Hedef oldu: kisa, birime ozel bir gecikmeyle yeni hedef ara (hepsi ayni karede degil).
        u.target[i] = -1;
        u.retarget[i] = Math.min(u.retarget[i], this.rng() * 0.3);
      }
      const tm = u.team[i];
      this.centroidX[tm] += u.x[i];
      this.centroidY[tm] += u.y[i];
      n[tm]++;
      if (!isHealer(u.kind[i])) this.damagerCount[tm]++;
      if (isMelee(u.kind[i])) {
        wx[tm] += u.x[i];
        wy[tm] += u.y[i];
        wn[tm]++;
      }
    }
    for (let tm = 0; tm < this.teamCount; tm++) {
      if (n[tm] > 0) {
        this.centroidX[tm] /= n[tm];
        this.centroidY[tm] /= n[tm];
      }
      this.hasFront[tm] = wn[tm] > 0;
      this.frontX[tm] = wn[tm] > 0 ? wx[tm] / wn[tm] : this.centroidX[tm];
      this.frontY[tm] = wn[tm] > 0 ? wy[tm] / wn[tm] : this.centroidY[tm];
    }
    // Canli dusman takim listesi ve en yakin dusman takim (merkez uzakligina gore).
    for (let tm = 0; tm < this.teamCount; tm++) {
      const list = this.enemyList[tm];
      list.length = 0;
      let best = -1;
      let bestD = Infinity;
      for (let e = 0; e < this.teamCount; e++) {
        if (e === tm || n[e] === 0) continue;
        list.push(e);
        const dx = this.centroidX[e] - this.centroidX[tm];
        const dy = this.centroidY[e] - this.centroidY[tm];
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      this.nearestEnemy[tm] = best;
    }

    let tn = performance.now();
    pf.prep += tn - tp;
    tp = tn;
    for (let tm = 0; tm < this.teamCount; tm++) this.grids[tm].build(u, tm);
    this.sepGrid.build(u, -1);
    tn = performance.now();
    pf.grid += tn - tp;
    tp = tn;

    if (this.winner < 0) {
      if (this.zones.length > 0) this.updateZones(dt);
      // Sira her adimda terslenir: dusuk indeksli (ilk dogan) takim kalici avantaj kazanmasin.
      const cnt = u.count;
      const rev = (this.stepNo & 1) === 1;
      for (let k = 0; k < cnt; k++) {
        const i = rev ? cnt - 1 - k : k;
        if (u.alive[i]) this.updateUnit(i, dt);
      }
      tn = performance.now();
      pf.units += tn - tp;
      tp = tn;
      this.separate();
      tn = performance.now();
      pf.separate += tn - tp;
      tp = tn;
    }

    if (this.config.mode !== 'bench') this.updateStatus();
    this.projectiles.update(dt, (x, y, team, dmg, idx) => this.arrowLanded(x, y, team, dmg, idx));
    pf.arrows += performance.now() - tp;
    pf.steps++;
    this.countAlive();
    if (this.winner < 0) {
      // Kazanan: canli birimi olan son takim (hepsi olurse -2: berabere).
      let alive = 0;
      let last = -1;
      for (let tm = 0; tm < this.teamCount; tm++) {
        if (this.alivePerTeam[tm] > 0) {
          alive++;
          last = tm;
        }
      }
      if (alive === 1) this.winner = last;
      else if (alive === 0) this.winner = -2;
      else this.checkDraw(alive);
    }
  }

  /**
   * Savas kilitlenmesin diye beraberlik kurallari: (1) hicbir canli birim hasar veremiyor
   * (yalniz rahipler), (2) uzun suredir hic hasar yok (ulasilamaz hedef, sifa dengesi...).
   */
  private checkDraw(aliveTeams: number): void {
    const u = this.units;
    if (aliveTeams < 2) return;
    let damager = false;
    for (let i = 0; i < u.count; i++) {
      if (u.alive[i] && !isHealer(u.kind[i])) {
        damager = true;
        break;
      }
    }
    if (!damager) {
      if (this.noDamagerSince < 0) this.noDamagerSince = this.time;
      if (this.time - this.noDamagerSince > NO_DAMAGER_DRAW) this.winner = -2;
    } else this.noDamagerSince = -1;

    if (this.counters.damage > this.lastDamageSeen + 0.01) {
      this.lastDamageSeen = this.counters.damage;
      this.lastDamageT = this.time;
    }
    const limit = this.lastDamageSeen > 0 ? NO_DAMAGE_DRAW : NO_DAMAGE_DRAW_FIRST;
    if (this.time - this.lastDamageT > limit) this.winner = -2;
  }

  private pushEvent(e: SimEvent): void {
    if (this.events.length < EVENT_CAP) this.events.push(e);
  }

  private startAttack(i: number): void {
    const u = this.units;
    const s = STATS[u.kind[i]];
    u.cooldown[i] = s.cooldown;
    u.swing[i] = s.swing;
    u.hitPending[i] = 1;
  }

  private updateUnit(i: number, dt: number): void {
    const u = this.units;
    const kind = u.kind[i];
    const s = STATS[kind];
    const ranged = !isMelee(kind);
    u.cooldown[i] -= dt * (u.slowT[i] > 0 || u.flags[i] !== 0 ? this.atkRate(i) : 1);
    u.retarget[i] -= dt;
    if (u.slowT[i] > 0) u.slowT[i] -= dt;
    if (u.shieldT[i] > 0) u.shieldT[i] -= dt;
    if (u.weakT[i] > 0) u.weakT[i] -= dt;
    if (u.invulnT[i] > 0) u.invulnT[i] -= dt;
    if (u.tauntT[i] > 0) u.tauntT[i] -= dt;
    if (u.stackT[i] > 0 && (u.stackT[i] -= dt) <= 0) u.stacks[i] = 0;
    if (u.burnT[i] > 0) {
      u.burnT[i] -= dt;
      this.damage(i, u.burnDps[i] * dt, -1, false, true);
      if (!u.alive[i]) return;
    }
    const skill = s.skill;
    if (skill === 'rage' && (u.flags[i] & F_RAGE) === 0 && u.hp[i] < u.maxHp[i] * this.sp('rage').b) {
      u.flags[i] |= F_RAGE;
      this.burst(u.x[i], u.y[i], 2, skill);
    }
    if (u.sideT[i] > 0) u.sideT[i] -= dt;
    if (u.banT[i] > 0) u.banT[i] -= dt;
    if (u.leashOffT[i] > 0) u.leashOffT[i] -= dt;

    // Geri itilen/sersemleyen birim bu adimda eylem yapamaz.
    if (u.kbVx[i] !== 0 || u.kbVy[i] !== 0) this.applyKnockback(i, dt);
    if (u.stunT[i] > 0) {
      u.stunT[i] -= dt;
      u.swing[i] = 0;
      u.hitPending[i] = 0;
      return;
    }

    if (u.fearT[i] > 0) {
      // Korku: kaynaktan uzaklas, saldirma.
      u.fearT[i] -= dt;
      u.swing[i] = 0;
      u.hitPending[i] = 0;
      const fx = u.x[i] - u.fearX[i];
      const fy = u.y[i] - u.fearY[i];
      const fl = Math.sqrt(fx * fx + fy * fy) || 1;
      this.moveToward(i, u.x[i] + (fx / fl) * 6, u.y[i] + (fy / fl) * 6, s.speed * 1.15, dt, true, false);
      return;
    }
    if (skill === 'mock' || skill === 'taunt' || skill === 'stoneWill') this.periodic(i, dt, skill);

    if (ranged && this.kiteOn) {
      this.updateThreat(i);
      if (u.kiteState[i] !== 1) u.stamina[i] = Math.min(1, u.stamina[i] + KITE.staminaRecharge * dt);
    }

    if (u.swing[i] > 0) {
      u.swing[i] -= dt;
      const t = u.target[i];
      if (t >= 0 && u.alive[t]) this.faceTo(i, u.x[t] - u.x[i], u.y[t] - u.y[i]);
      if (u.hitPending[i] && s.swing - u.swing[i] >= s.hitAt) {
        u.hitPending[i] = 0;
        this.resolveHit(i);
      }
      return;
    }

    if (u.retarget[i] <= 0) {
      const tq = performance.now();
      this.pickTarget(i);
      this.prof.pick += performance.now() - tq;
      u.retarget[i] = u.target[i] < 0 ? 0.4 + this.rng() * 0.3 : 1.8 + this.rng() * 2.0;
    }

    if (ranged && this.kiteOn && this.tryKite(i, dt)) return;

    const t = u.target[i];
    if (t < 0) {
      if (isHealer(kind)) this.followArmy(i, dt);
      else this.marchToEnemy(i, dt);
      return;
    }

    const dx = u.x[t] - u.x[i];
    const dy = u.y[t] - u.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Buyuk (tank) hedefin govdesi daha genis: yakin dovusculer onu bu kadar fazla uzaktan vurabilir.
    const tr = isTank(u.kind[t]) && !isTank(kind) ? TANK_REACH : 0;

    if (dist <= (isMelee(kind) ? s.range + MELEE_SLACK + tr : s.range * 0.95)) {
      // Menzile giris anlik sayilmaz: kalabalikta menzil kenarinda gidip gelen birim sayaci sifirlayamaz.
      u.rangeT[i] += dt;
      if (u.rangeT[i] > 0.5) {
        u.chaseT[i] = 0;
        u.chaseBest[i] = Infinity;
      }
    } else {
      u.rangeT[i] = 0;
      if (this.chaseWatchdog(i, t, dist, dt)) return;
    }

    if (isMelee(kind)) {
      if (dist > s.range + MELEE_SLACK + tr) {
        // Hedefin etrafinda kisiye ozel bir aciya kosar: herkes ayni noktaya yigilmaz.
        const base = Math.atan2(-dy, -dx) + u.slotAngle[i];
        const reach = s.range * 0.7;
        let gx = u.x[t] + Math.cos(base) * reach;
        let gy = u.y[t] + Math.sin(base) * reach;
        // Yaklasma noktasi suya/engele ya da harita kenarinin disina dustuyse dogrudan hedefe yonel.
        const edge = this.mapSize - 0.5;
        const outside = gx < 0.5 || gy < 0.5 || gx > edge || gy > edge;
        if (outside || (this.terrain && !this.terrain.walkable(gx, gy))) {
          gx = u.x[t];
          gy = u.y[t];
        }
        this.moveToward(i, gx, gy, s.speed, dt);
        return;
      }
    } else if (dist > s.range * 0.95) {
      if (isHealer(kind) && this.kiteOn) {
        // Hastaya arkasindan yaklas: dusmandan uzakta dur.
        const en = this.nearestEnemy[u.team[i]];
        if (en >= 0) {
          let ax = u.x[t] - this.centroidX[en];
          let ay = u.y[t] - this.centroidY[en];
          const len = Math.sqrt(ax * ax + ay * ay) || 1;
          ax /= len;
          ay /= len;
          this.moveToward(i, u.x[t] + ax * 3, u.y[t] + ay * 3, s.speed, dt);
        } else {
          this.moveToward(i, u.x[t], u.y[t], s.speed, dt);
        }
      } else if (this.leashHold(i, dt)) {
        this.faceTo(i, dx, dy);
      } else {
        this.moveToward(i, u.x[t], u.y[t], s.speed, dt);
      }
      return;
    }

    this.faceTo(i, dx, dy);
    if (u.cooldown[i] <= 0) this.startAttack(i);
  }

  /** Yakin-dovus tehdidi taramasi: kaba gridde 3x3 hucre, birim basina kaydirmali. */
  private updateThreat(i: number): void {
    if ((i + this.stepNo) % KITE.scanEvery !== 0) return;
    const u = this.units;
    const danger = isRanged(u.kind[i]) ? KITE.archerDanger : KITE.priestDanger;
    const d2max = danger * danger;
    const enemies = this.enemyList[u.team[i]];
    const g0 = this.grids[0];
    const cols = g0.cols;
    const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / g0.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / g0.cell) | 0));
    const xi = u.x[i];
    const yi = u.y[i];
    let best = Infinity;
    let ax = 0;
    let ay = 0;
    for (let e = 0; e < enemies.length; e++) {
      const grid = this.grids[enemies[e]];
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
          const c = gy * cols + gx;
          for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
            const j = grid.items[k];
            if (!isMelee(u.kind[j])) continue;
            const dx = xi - u.x[j];
            const dy = yi - u.y[j];
            const d2 = dx * dx + dy * dy;
            if (d2 >= d2max) continue;
            const w = 1 / (d2 + 0.5);
            ax += dx * w;
            ay += dy * w;
            if (d2 < best) best = d2;
          }
        }
      }
    }
    if (best === Infinity) {
      u.threatDist[i] = Infinity;
      return;
    }
    const mag = Math.sqrt(ax * ax + ay * ay) || 1;
    u.threatDx[i] = ax / mag;
    u.threatDy[i] = ay / mag;
    u.threatDist[i] = Math.sqrt(best);
  }

  /**
   * Okcu/priest vur-kac: tehdit varsa geri cekilir. Okcu once cabuk atis yapabilir, stamina
   * bitince veya koseye sikisinca savasir. Geri kosarken yuzu dusmana donuktur.
   * true: bu adimda hareket/saldiri yapildi.
   */
  private tryKite(i: number, dt: number): boolean {
    const u = this.units;
    const archer = isRanged(u.kind[i]);
    const danger = archer ? KITE.archerDanger : KITE.priestDanger;
    const safe = archer ? KITE.archerSafe : KITE.priestSafe;
    const td = u.threatDist[i];

    if (u.kiteState[i] === 1) {
      if (td >= safe || u.stamina[i] <= 0.05) u.kiteState[i] = 0;
    } else if (td < danger) {
      if (u.stamina[i] <= KITE.staminaMin) return false; // yorgun: kacamaz
      if (archer) {
        if (td <= KITE.archerCornered) {
          this.dbg.cornered++;
          return false; // savas: son savunma atisi
        }
        const t = u.target[i];
        if (u.cooldown[i] <= 0 && td >= KITE.archerSnapMin && t >= 0 && u.alive[t]) {
          const ex = u.x[t] - u.x[i];
          const ey = u.y[t] - u.y[i];
          if (ex * ex + ey * ey <= STATS[u.kind[i]].range * STATS[u.kind[i]].range) {
            this.faceTo(i, ex, ey);
            this.startAttack(i);
            this.dbg.snapShots++;
            return true;
          }
        }
      }
      u.kiteState[i] = 1;
      this.dbg.kites++;
    }
    if (u.kiteState[i] !== 1) return false;

    const tm = u.team[i];
    let dx = u.threatDx[i];
    let dy = u.threatDy[i];
    let px = this.centroidX[tm] - u.x[i];
    let py = this.centroidY[tm] - u.y[i];
    const pl = Math.sqrt(px * px + py * py);
    if (pl > 1e-3) {
      px /= pl;
      py /= pl;
      dx = dx * (1 - KITE.armyPull) + px * KITE.armyPull;
      dy = dy * (1 - KITE.armyPull) + py * KITE.armyPull;
    }
    const sp = STATS[u.kind[i]].speed * (archer ? KITE.archerSprint : KITE.priestSprint);
    const step = sp * dt;
    const mv = this.moveToward(i, u.x[i] + dx * 3, u.y[i] + dy * 3, sp, dt, false, false);
    this.faceTo(i, -u.threatDx[i], -u.threatDy[i]);
    this.dbg.kiteSteps++;
    u.stamina[i] = Math.max(0, u.stamina[i] - (archer ? KITE.staminaDrain : KITE.priestStaminaDrain) * dt);
    if (mv < step * 0.2) {
      // Nehir/engel onunde sikisti: kacmayi birak.
      u.kiteState[i] = 0;
      u.stamina[i] = 0;
      this.dbg.cornered++;
    }
    return true;
  }

  /**
   * Ilerleme bekcisi: hedefe yaklasamayan (kalabalik, engel, ulasilamaz) birim bir sure sonra
   * o hedefi yasaklayip baska hedef secer. true: hedef birakildi.
   */
  private chaseWatchdog(i: number, t: number, dist: number, dt: number): boolean {
    const u = this.units;
    if (dist < u.chaseBest[i] - 0.5) {
      u.chaseBest[i] = dist;
      u.chaseT[i] = 0;
      return false;
    }
    u.chaseT[i] += dt;
    if (u.chaseT[i] < CHASE_TIMEOUT) return false;
    u.banTarget[i] = t;
    u.banT[i] = BAN_TIME;
    if (u.attackers[t] > 0 && !(isHealer(u.kind[i]))) u.attackers[t]--;
    if (u.healers[t] > 0 && isHealer(u.kind[i])) u.healers[t]--;
    u.target[i] = -1;
    u.retarget[i] = 0;
    u.chaseT[i] = 0;
    u.chaseBest[i] = Infinity;
    this.dbg.bans++;
    return true;
  }

  /** Leash: bekletiyorsa true; cok uzun beklediyse gecici olarak devre disi birakir. */
  private leashHold(i: number, dt: number): boolean {
    const u = this.units;
    if (!this.beyondLeash(i)) {
      u.holdT[i] = 0;
      return false;
    }
    u.holdT[i] += dt;
    if (u.holdT[i] > LEASH_HOLD_MAX) {
      u.leashOffT[i] = LEASH_OFF;
      u.holdT[i] = 0;
      this.dbg.leashBreaks++;
      return false;
    }
    return true;
  }

  /** Okcu/priest kendi warrior merkezinin onune (dusmana dogru) gecmesin. */
  private beyondLeash(i: number): boolean {
    const u = this.units;
    const tm = u.team[i];
    if (!this.kiteOn || !this.hasFront[tm] || u.leashOffT[i] > 0) return false;
    const en = this.nearestEnemy[tm];
    if (en < 0) return false;
    let ex = this.centroidX[en] - this.frontX[tm];
    let ey = this.centroidY[en] - this.frontY[tm];
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 1e-3) return false;
    ex /= len;
    ey /= len;
    return (u.x[i] - this.frontX[tm]) * ex + (u.y[i] - this.frontY[tm]) * ey > KITE.leash;
  }

  private pickTarget(i: number): void {
    const u = this.units;
    if (u.tauntT[i] > 0) {
      const b = u.tauntBy[i];
      if (b >= 0 && u.alive[b]) {
        u.target[i] = b;
        return;
      }
    }
    const kind = u.kind[i];
    const team = u.team[i];
    const cur = u.target[i];
    const isPriest = isHealer(kind);
    const melee = isMelee(kind);
    // Priest muttefik, digerleri tum dusman takimlari tarar.
    const searchTeams = isPriest ? this.selfList[team] : this.enemyList[team];
    const maxRing = isPriest ? PRIEST_RING : MAX_RING;
    const g0 = this.grids[0];
    const cols = g0.cols;
    const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / g0.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / g0.cell) | 0));
    const terrain = this.terrain;
    const sideI = terrain ? terrain.sideAt(u.x[i], u.y[i]) : 0;
    const reach = STATS[kind].range * 0.95;
    const myRegion = terrain ? terrain.regionAt(u.x[i], u.y[i]) : -1;
    const banned = u.banT[i] > 0 ? u.banTarget[i] : -1;

    // Menzildeki (veya vurulabilir mesafedeki) mevcut hedef kilitlidir: titresim/dongu olmasin.
    if (cur >= 0 && u.alive[cur] && !isPriest) {
      const cdx = u.x[cur] - u.x[i];
      const cdy = u.y[cur] - u.y[i];
      const lockR = (melee ? STATS[kind].range + MELEE_SLACK : STATS[kind].range) * ENGAGE_LOCK;
      if (cdx * cdx + cdy * cdy <= lockR * lockR) return;
    }
    let best = -1;
    let bestScore = Infinity;
    let foundRing = -1;

    for (let r = 0; r <= maxRing; r++) {
      if (foundRing >= 0 && r > foundRing) break;
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= cols) continue;
        const edgeRow = gy === cy - r || gy === cy + r;
        const step = edgeRow || r === 0 ? 1 : 2 * r;
        for (let gx = cx - r; gx <= cx + r; gx += step) {
          if (gx < 0 || gx >= cols) continue;
          const c = gy * cols + gx;
          for (let ti = 0; ti < searchTeams.length; ti++) {
            const grid = this.grids[searchTeams[ti]];
            for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
              const j = grid.items[k];
              if (j === i || j === banned || (isPriest && u.hp[j] >= u.maxHp[j])) continue;
              const ddx = u.x[j] - u.x[i];
              const ddy = u.y[j] - u.y[i];
              const dist = Math.sqrt(ddx * ddx + ddy * ddy);
              const jitter = this.rng() * 0.8;
              const tank = isTank(u.kind[j]);
              let score: number;
              if (melee) {
                const att = u.attackers[j] - (j === cur ? 1 : 0);
                score = dist + att * 3.5 + jitter * 2 + (att >= (tank ? TANK.meleeSlots : MELEE_SLOTS) ? 100 : 0);
                if (tank) score -= TANK.tauntBonus; // tank dusmani uzerine ceker
              } else if (isRanged(kind)) {
                const att = u.attackers[j] - (j === cur ? 1 : 0);
                score = dist + att * 2 + (u.hp[j] / u.maxHp[j]) * 3 + jitter * 2;
              } else {
                const heal = u.healers[j] - (j === cur ? 1 : 0);
                score = (u.hp[j] / u.maxHp[j]) * 10 + dist * 0.3 + heal * 4 + jitter;
              }
              // Kapali cep/ada: menzil disindaysa ulasilamaz, hedef alma.
              if (terrain && myRegion !== -1 && dist > reach && terrain.regionAt(u.x[j], u.y[j]) !== myRegion) continue;
              // Nehrin karsisindaki hedefe sadece gerekirse: okcu menzildeyse nehir uzerinden vurur.
              if (terrain && (melee || isPriest || dist > reach) && terrain.sideAt(u.x[j], u.y[j]) !== sideI) {
                score += OTHER_BANK_PENALTY;
              }
              if (j === cur) score -= SWITCH_BONUS;
              if (score < bestScore) {
                bestScore = score;
                best = j;
              }
              if (foundRing < 0) foundRing = r;
            }
          }
        }
      }
    }

    if (cur >= 0 && cur !== best) {
      if (isPriest) {
        if (u.healers[cur] > 0) u.healers[cur]--;
      } else if (u.attackers[cur] > 0) u.attackers[cur]--;
    }
    if (best >= 0 && best !== cur) {
      if (isPriest) u.healers[best]++;
      else u.attackers[best]++;
    }
    if (best !== cur) {
      u.chaseT[i] = 0;
      u.chaseBest[i] = Infinity;
    }
    u.target[i] = best;
  }

  private marchToEnemy(i: number, dt: number): void {
    const u = this.units;
    const en = this.nearestEnemy[u.team[i]];
    if (en < 0) return;
    if (!isMelee(u.kind[i]) && this.leashHold(i, dt)) return;
    this.moveToward(i, this.centroidX[en], this.centroidY[en], STATS[u.kind[i]].speed, dt);
  }

  private followArmy(i: number, dt: number): void {
    const u = this.units;
    const tm = u.team[i];
    const en = this.nearestEnemy[tm];
    // Savasci yoksa (yalniz rahipler) orduya eslik edecek kimse yok: kacip koseye gitme.
    if (en < 0 || this.damagerCount[tm] === 0) return;
    let ax = this.centroidX[tm] - this.centroidX[en];
    let ay = this.centroidY[tm] - this.centroidY[en];
    const len = Math.sqrt(ax * ax + ay * ay) || 1;
    ax /= len;
    ay /= len;
    const gx = this.centroidX[tm] + ax * 2.5;
    const gy = this.centroidY[tm] + ay * 2.5;
    const gdx = gx - u.x[i];
    const gdy = gy - u.y[i];
    if (gdx * gdx + gdy * gdy > 2.25) this.moveToward(i, gx, gy, STATS[u.kind[i]].speed, dt);
  }

  private resolveHit(i: number): void {
    const u = this.units;
    const kind = u.kind[i];
    const s = STATS[kind];
    const skill = s.skill;
    if (skill === 'summonSkeleton') {
      this.summon(i);
      return;
    }
    const t = u.target[i];
    if (t < 0 || !u.alive[t]) return;
    const dx = u.x[t] - u.x[i];
    const dy = u.y[t] - u.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);
    const power = s.power * this.dealMul(i);

    if (kind === Kind.Shield) {
      this.shieldBash(i, dx, dy, dist);
    } else if (kind === Kind.Brute) {
      this.bruteSlam(i);
    } else if (isHealer(kind)) {
      if (dist <= s.range + 1 && u.hp[t] < u.maxHp[t]) {
        const before = u.hp[t];
        const stale = this.time - this.lastDeathTime - STALE_AFTER;
        const heal = stale > 0 ? s.power / (1 + stale * STALE_RAMP) : s.power;
        u.hp[t] = Math.min(u.maxHp[t], u.hp[t] + heal);
        this.counters.heal += u.hp[t] - before;
        if (this.emitEvents) this.pushEvent({ type: 'heal', x: u.x[t], y: u.y[t], unit: t, value: heal, kind: u.kind[t] });
        if (skill === 'cleanse') {
          // Nun: hedefi ve cevresindeki dostlari da iyilestirir, kontrol etkilerini kaldirir.
          const p = this.sp('cleanse');
          this.cleanse(t);
          const out = this.scratch;
          this.gather(this.selfList[u.team[i]], u.x[t], u.y[t], p.radius, out, 24);
          for (let k = 0; k < out.length; k++) {
            if (out[k] === t) continue;
            this.healUnit(out[k], heal * 0.5);
            this.cleanse(out[k]);
          }
          this.burst(u.x[t], u.y[t], p.radius, skill);
        }
      }
    } else if (isRanged(kind)) {
      this.fireShot(i, t, dist, power, skill);
    } else {
      this.meleeHit(i, t, dist, dx, dy, power, skill);
    }
  }

  /** Kalkan Tanki: onundeki konide hasar + guclu geri itme. */
  private shieldBash(i: number, dx: number, dy: number, dist: number): void {
    const u = this.units;
    const s = STATS[Kind.Shield];
    let fx = dx;
    let fy = dy;
    if (dist > 0.01) {
      fx /= dist;
      fy /= dist;
    } else {
      fx = u.facing[i];
      fy = -u.facing[i];
    }
    this.areaStrike(i, s.aoe, s.power, s.knockback, fx, fy, true);
    if (this.emitEvents) this.pushEvent({ type: 'bash', x: u.x[i], y: u.y[i], unit: i, angle: Math.atan2(fy, fx) });
  }

  /** Cekic Tanki: cevresinde daire darbe; hayatta kalanlar yariya kadar geri itilir. */
  private bruteSlam(i: number): void {
    const u = this.units;
    const s = STATS[Kind.Brute];
    this.areaStrike(i, s.aoe, s.power, s.knockback, 0, 0, false);
    if (this.emitEvents) this.pushEvent({ type: 'slam', x: u.x[i], y: u.y[i], unit: i });
  }

  /** Dusman gridlerinde tank cevresindeki hucreleri tarar: hasar + knockback (koni veya daire). */
  private areaStrike(i: number, radius: number, power: number, push: number, fx: number, fy: number, cone: boolean): void {
    const u = this.units;
    const ax = u.x[i];
    const ay = u.y[i];
    const enemies = this.enemyList[u.team[i]];
    const g0 = this.grids[0];
    const cols = g0.cols;
    const cx = Math.min(cols - 1, Math.max(0, (ax / g0.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (ay / g0.cell) | 0));
    const victims: number[] = [];
    for (let e = 0; e < enemies.length; e++) {
      const grid = this.grids[enemies[e]];
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
          const c = gy * cols + gx;
          for (let k = grid.start[c]; k < grid.start[c + 1]; k++) victims.push(grid.items[k]);
        }
      }
    }
    for (const j of victims) {
      if (!u.alive[j]) continue;
      const dx = u.x[j] - ax;
      const dy = u.y[j] - ay;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > radius) continue;
      let ux = d > 0.01 ? dx / d : 1;
      let uy = d > 0.01 ? dy / d : 0;
      if (cone && d > 0.01 && (dx * fx + dy * fy) / d < TANK.coneCos) continue;
      this.damage(j, power);
      if (!u.alive[j]) continue;
      if (cone) {
        ux = fx;
        uy = fy;
      }
      // Tank olan kurban iki kat daha az itilir.
      const amount = isTank(u.kind[j]) ? push * 0.5 : push;
      u.kbVx[j] = ux * amount * 9;
      u.kbVy[j] = uy * amount * 9;
      u.stunT[j] = TANK.stun;
    }
  }

  /** Geri itme hizini uygular: yurunemez karoya itilmez, hiz adim basina soner. */
  private applyKnockback(i: number, dt: number): void {
    const u = this.units;
    const t = this.terrain;
    const ox = u.x[i];
    const oy = u.y[i];
    let nx = Math.fround(Math.min(this.mapSize - 0.5, Math.max(0.5, ox + u.kbVx[i] * dt)));
    let ny = Math.fround(Math.min(this.mapSize - 0.5, Math.max(0.5, oy + u.kbVy[i] * dt)));
    if (t && !t.stepOk(ox, oy, nx, ny)) {
      if (t.walkable(nx, oy)) ny = oy;
      else if (t.walkable(ox, ny)) nx = ox;
      else {
        nx = ox;
        ny = oy;
      }
    }
    u.x[i] = nx;
    u.y[i] = ny;
    u.moving[i] = 1;
    u.kbVx[i] *= TANK.kbDecay;
    u.kbVy[i] *= TANK.kbDecay;
    if (Math.abs(u.kbVx[i]) + Math.abs(u.kbVy[i]) < 0.3) u.kbVx[i] = u.kbVy[i] = 0;
  }

  // ===================================================================
  // Yetenekler ve durum etkileri
  // ===================================================================

  private readonly skillCache: Partial<Record<SkillId, SkillParams>> = {};
  private readonly zones: Zone[] = [];
  /** Hex bebegi -> bagli dusmanlar; Bone Caller -> iskelet havuzu. */
  private readonly links = new Map<number, number[]>();
  private readonly pools = new Map<number, number[]>();
  private readonly scratch: number[] = [];
  private readonly scratch2: number[] = [];

  /** Gorsel durum maskesini yazar (renderer renklendirir). */
  private updateStatus(): void {
    const u = this.units;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) {
        u.status[i] = 0;
        continue;
      }
      u.status[i] =
        (u.slowT[i] > 0 ? ST_SLOW : 0) |
        (u.burnT[i] > 0 ? ST_BURN : 0) |
        (u.stunT[i] > 0.35 ? ST_STUN : 0) |
        (u.fearT[i] > 0 ? ST_FEAR : 0) |
        (u.shieldT[i] > 0 ? ST_SHIELD : 0) |
        (u.invulnT[i] > 0 ? ST_INVULN : 0) |
        (u.tauntT[i] > 0 ? ST_TAUNT : 0);
    }
  }

  private sp(id: SkillId): SkillParams {
    return (this.skillCache[id] ??= skillParams(id, this.config.level ?? DEFAULT_LEVEL));
  }

  /** Hasar carpani: zayiflatma, ofke, mizrak yigini. */
  private dealMul(i: number): number {
    const u = this.units;
    let m = 1;
    if (u.weakT[i] > 0) m *= u.weakK[i];
    if ((u.flags[i] & F_RAGE) !== 0) m *= 1 + this.sp('rage').a;
    if (u.stacks[i] > 0) m *= 1 + u.stacks[i] * this.sp('spearBuild').a;
    return m;
  }

  private moveMul(i: number): number {
    const u = this.units;
    let m = u.slowT[i] > 0 ? u.slowK[i] : 1;
    if ((u.flags[i] & F_RAGE) !== 0) m *= 1 + this.sp('rage').a * 0.5;
    return m;
  }

  private atkRate(i: number): number {
    const u = this.units;
    let m = u.slowT[i] > 0 ? u.slowA[i] : 1;
    if ((u.flags[i] & F_RAGE) !== 0) m *= 1 + this.sp('rage').a;
    return m;
  }

  private tick(i: number, every: number): boolean {
    const u = this.units;
    if (++u.skillN[i] >= every) {
      u.skillN[i] = 0;
      return true;
    }
    return false;
  }

  private burst(x: number, y: number, radius: number, skill: SkillId | null): void {
    if (this.emitEvents) this.pushEvent({ type: 'burst', x, y, unit: -1, value: radius, element: skill ? (SKILL_ELEMENT[skill] ?? 0) : 0 });
  }

  /** Verilen takimlarin canli birimlerinden (x,y) merkezli r yaricap icindekileri out'a toplar. */
  private gather(teams: number[], x: number, y: number, r: number, out: number[], max = 96): number {
    const u = this.units;
    out.length = 0;
    const g0 = this.grids[0];
    const cols = g0.cols;
    const cell = g0.cell;
    const gx0 = Math.max(0, ((x - r) / cell) | 0);
    const gx1 = Math.min(cols - 1, ((x + r) / cell) | 0);
    const gy0 = Math.max(0, ((y - r) / cell) | 0);
    const gy1 = Math.min(cols - 1, ((y + r) / cell) | 0);
    const r2 = r * r;
    for (let a = 0; a < teams.length; a++) {
      const grid = this.grids[teams[a]];
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const c = gy * cols + gx;
          for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
            const j = grid.items[k];
            if (!u.alive[j]) continue;
            const dx = u.x[j] - x;
            const dy = u.y[j] - y;
            if (dx * dx + dy * dy <= r2) {
              out.push(j);
              if (out.length >= max) return out.length;
            }
          }
        }
      }
    }
    return out.length;
  }

  /** (ox,oy) noktasindan (dx,dy) yonunde uzunluk x yari-genislik seridindeki dusmanlar. */
  private gatherLine(teams: number[], ox: number, oy: number, dx: number, dy: number, length: number, half: number, out: number[]): number {
    const u = this.units;
    const tmp = this.scratch2;
    this.gather(teams, ox + (dx * length) / 2, oy + (dy * length) / 2, length / 2 + half, tmp, 200);
    out.length = 0;
    for (let k = 0; k < tmp.length; k++) {
      const j = tmp[k];
      const rx = u.x[j] - ox;
      const ry = u.y[j] - oy;
      const along = rx * dx + ry * dy;
      if (along < -0.3 || along > length) continue;
      if (Math.abs(rx * dy - ry * dx) <= half) out.push(j);
    }
    return out.length;
  }

  private applySlow(j: number, dur: number, moveK: number, atkK: number): void {
    const u = this.units;
    if (u.invulnT[j] > 0) return;
    if (u.slowT[j] > 0) {
      u.slowK[j] = Math.min(u.slowK[j], moveK);
      u.slowA[j] = Math.min(u.slowA[j], atkK);
    } else {
      u.slowK[j] = moveK;
      u.slowA[j] = atkK;
    }
    u.slowT[j] = Math.max(u.slowT[j], dur);
  }

  private applyStun(j: number, dur: number): void {
    const u = this.units;
    if (u.invulnT[j] > 0 || !u.alive[j]) return;
    u.stunT[j] = Math.max(u.stunT[j], dur);
  }

  private applyFear(j: number, dur: number, fx: number, fy: number): void {
    const u = this.units;
    if (u.invulnT[j] > 0 || !u.alive[j]) return;
    u.fearT[j] = Math.max(u.fearT[j], dur);
    u.fearX[j] = fx;
    u.fearY[j] = fy;
  }

  private applyWeak(j: number, dur: number, k: number): void {
    const u = this.units;
    u.weakK[j] = u.weakT[j] > 0 ? Math.min(u.weakK[j], k) : k;
    u.weakT[j] = Math.max(u.weakT[j], dur);
  }

  private applyShield(j: number, dur: number, k: number): void {
    const u = this.units;
    u.shieldK[j] = u.shieldT[j] > 0 ? Math.min(u.shieldK[j], k) : k;
    u.shieldT[j] = Math.max(u.shieldT[j], dur);
  }

  private applyTaunt(j: number, by: number, dur: number): void {
    const u = this.units;
    if (u.invulnT[j] > 0) return;
    // Zaten baska bir tank kiskirtiyorsa hedef degistirme (salinim olmasin).
    if (u.tauntT[j] > 0 && u.tauntBy[j] !== by && u.tauntBy[j] >= 0 && u.alive[u.tauntBy[j]]) return;
    u.tauntBy[j] = by;
    u.tauntT[j] = Math.max(u.tauntT[j], dur);
    u.target[j] = by;
    u.retarget[j] = dur;
  }

  private cleanse(j: number): void {
    const u = this.units;
    u.stunT[j] = u.slowT[j] = u.fearT[j] = u.burnT[j] = u.weakT[j] = 0;
  }

  private pushUnit(j: number, ux: number, uy: number, amount: number): void {
    const u = this.units;
    if (!u.alive[j]) return;
    const a = isTank(u.kind[j]) ? amount * 0.5 : amount;
    u.kbVx[j] = ux * a * 9;
    u.kbVy[j] = uy * a * 9;
  }

  private healUnit(j: number, amount: number): number {
    const u = this.units;
    if (!u.alive[j]) return 0;
    const before = u.hp[j];
    u.hp[j] = Math.min(u.maxHp[j], u.hp[j] + amount);
    const gained = u.hp[j] - before;
    this.counters.heal += gained;
    if (gained > 0 && this.emitEvents) this.pushEvent({ type: 'heal', x: u.x[j], y: u.y[j], unit: j, value: gained, kind: u.kind[j] });
    return gained;
  }

  /** Cevredeki dost birimleri iyilestirir (merkezdekiler dahil). */
  private healArea(team: number, x: number, y: number, r: number, amount: number): void {
    const out = this.scratch;
    this.gather(this.selfList[team], x, y, r, out, 64);
    for (let k = 0; k < out.length; k++) if (this.units.hp[out[k]] < this.units.maxHp[out[k]]) this.healUnit(out[k], amount);
  }

  private addZone(x: number, y: number, r: number, t: number, dps: number, team: number, slowK: number, skill: SkillId): void {
    if (this.zones.length >= 32) this.zones.shift();
    this.zones.push({ x, y, r, t, dps, team, slowK });
    this.burst(x, y, r, skill);
  }

  private updateZones(dt: number): void {
    const out = this.scratch;
    for (let k = this.zones.length - 1; k >= 0; k--) {
      const z = this.zones[k];
      z.t -= dt;
      if (z.t <= 0) {
        this.zones.splice(k, 1);
        continue;
      }
      this.gather(this.enemyList[z.team], z.x, z.y, z.r, out, 64);
      for (let a = 0; a < out.length; a++) {
        const j = out[a];
        if (z.dps > 0) this.damage(j, z.dps * dt, -1, false, true);
        if (z.slowK < 1 && this.units.alive[j]) this.applySlow(j, 0.4, z.slowK, z.slowK);
      }
    }
  }

  /** Yetenekli birimlerin yasam dongusu kurulumu: iskelet havuzu, hex baglari. */
  private setupSkills(): void {
    const u = this.units;
    const skelKind = KIND_OF_TROOP.skeleton;
    const n = u.count;
    for (let i = 0; i < n; i++) {
      const skill = STATS[u.kind[i]].skill;
      if (skill === 'summonSkeleton') {
        const pool: number[] = [];
        for (let k = 0; k < SUMMON_POOL; k++) {
          const s = u.spawn(u.team[i], skelKind, u.x[i], u.y[i], this.rng);
          u.alive[s] = 0;
          u.deathT[s] = 1000;
          u.hp[s] = 0;
          u.owner[s] = i;
          pool.push(s);
        }
        this.pools.set(i, pool);
      } else if (skill === 'destinyBond') {
        const foes: number[] = [];
        for (let j = 0; j < n; j++) if (u.alive[j] && u.team[j] !== u.team[i] && STATS[u.kind[j]].skill !== 'destinyBond') foes.push(j);
        const pick: number[] = [];
        const want = Math.min(this.sp('destinyBond').count, foes.length);
        while (pick.length < want) {
          const f = foes[Math.floor(this.rng() * foes.length)];
          if (!pick.includes(f)) pick.push(f);
        }
        if (pick.length) this.links.set(i, pick);
      }
    }
  }

  /** Bone Caller: havuzdan iskelet uyandirir. */
  private summon(i: number): void {
    const u = this.units;
    const pool = this.pools.get(i);
    if (!pool) return;
    let n = this.sp('summonSkeleton').count;
    for (let a = 0; a < pool.length && n > 0; a++) {
      const k = pool[a];
      if (u.alive[k]) continue;
      let x = u.x[i] + (this.rng() - 0.5) * 3;
      let y = u.y[i] + (this.rng() - 0.5) * 3;
      if (this.terrain) {
        const p = this.terrain.nearestWalkable(x, y, 3, true);
        if (!p) continue;
        x = p.x;
        y = p.y;
      }
      u.alive[k] = 1;
      u.hp[k] = u.maxHp[k];
      u.deathT[k] = 0;
      u.x[k] = u.px[k] = x;
      u.y[k] = u.py[k] = y;
      u.target[k] = -1;
      u.retarget[k] = 0;
      u.cooldown[k] = 0.4;
      u.flash[k] = 0.25;
      u.stunT[k] = u.slowT[k] = u.fearT[k] = u.burnT[k] = 0;
      u.winX[k] = x;
      u.winY[k] = y;
      u.winT[k] = 0;
      n--;
      this.burst(x, y, 1.6, 'summonSkeleton');
    }
  }

  private explode(i: number): void {
    const u = this.units;
    if ((u.flags[i] & F_EXPLODED) !== 0) return;
    u.flags[i] |= F_EXPLODED;
    const p = this.sp('explode');
    // Olum sirasinda cagrilabilir: ic ice gecen dongulerin ortak dizisini bozmamak icin yerel dizi.
    const out: number[] = [];
    this.gather(this.enemyList[u.team[i]], u.x[i], u.y[i], p.radius, out, 64);
    for (let k = 0; k < out.length; k++) this.damage(out[k], p.dmg, i, false);
    this.addZone(u.x[i], u.y[i], p.radius, p.dur, p.a / p.dur, u.team[i], 1, 'explode');
    if (u.alive[i]) this.killUnit(i);
  }

  /** Periyodik yetenekler: kiskirtma, alay, tas irade. */
  private periodic(i: number, dt: number, skill: SkillId): void {
    const u = this.units;
    u.skillT[i] -= dt;
    if (u.skillT[i] > 0) return;
    const p = this.sp(skill);
    const out = this.scratch;
    const team = u.team[i];
    if (skill === 'mock' || skill === 'taunt') {
      u.skillT[i] = p.b;
      this.gather(this.enemyList[team], u.x[i], u.y[i], p.radius, out, 48);
      if (out.length === 0) {
        u.skillT[i] = 0.6;
        return;
      }
      for (let k = 0; k < out.length; k++) {
        // Kiskirtma bir sonraki doneme kadar surer: hedef surekli degismesin.
        this.applyTaunt(out[k], i, p.b + 0.5);
        if (skill === 'mock') this.applyWeak(out[k], p.dur, p.a);
      }
      this.burst(u.x[i], u.y[i], p.radius, skill);
    } else if (skill === 'stoneWill') {
      u.skillT[i] = 6;
      this.gather(this.enemyList[team], u.x[i], u.y[i], p.radius, out, 48);
      if (out.length === 0) {
        u.skillT[i] = 1;
        return;
      }
      this.applyShield(i, p.dur, p.b);
      for (let k = 0; k < out.length; k++) {
        this.damage(out[k], STATS[u.kind[i]].power * 0.6, i, false);
        this.applySlow(out[k], p.dur, p.a, p.a);
      }
      this.burst(u.x[i], u.y[i], p.radius, skill);
    }
  }

  /** Yakin-dovus vurusu: temel hasar + yetenek. */
  private meleeHit(i: number, t: number, dist: number, dx: number, dy: number, power: number, skill: SkillId | null): void {
    const u = this.units;
    const s = STATS[u.kind[i]];
    if (skill === 'explode') {
      this.explode(i);
      return;
    }
    if (dist > s.range + 0.6 + (isTank(u.kind[t]) && !isTank(u.kind[i]) ? TANK_REACH : 0)) return;
    const nx = dist > 0.01 ? dx / dist : u.facing[i];
    const ny = dist > 0.01 ? dy / dist : 0;
    const out = this.scratch;
    let dealt = 0;
    if (skill === 'stun') {
      // Night Lancer: her vurus onundeki seride guclu saplama + sersemletme.
      const p = this.sp('stun');
      this.gatherLine(this.enemyList[u.team[i]], u.x[i], u.y[i], nx, ny, p.length, p.half, out);
      for (let k = 0; k < out.length; k++) {
        this.damage(out[k], p.dmg, i, true);
        this.applyStun(out[k], p.dur);
      }
      this.burst(u.x[i] + nx * 2, u.y[i] + ny * 2, 2, skill);
      return;
    }
    if (s.shape === 1 && s.splash > 0) {
      this.gather(this.enemyList[u.team[i]], u.x[t], u.y[t], s.splash, out, 48);
      for (let k = 0; k < out.length; k++) dealt += this.damage(out[k], power, i, true);
      this.burst(u.x[t], u.y[t], s.splash, null);
    } else if (s.shape === 2 && s.splash > 0) {
      this.gatherLine(this.enemyList[u.team[i]], u.x[i], u.y[i], nx, ny, s.splash * 1.7, s.splash * 0.5 + 0.3, out);
      for (let k = 0; k < out.length; k++) dealt += this.damage(out[k], power, i, true);
    } else {
      dealt = this.damage(t, power, i, true);
    }
    if (!skill) return;
    const p = this.sp(skill);
    switch (skill) {
      case 'lifesteal':
        u.hp[i] = Math.min(u.maxHp[i], u.hp[i] + dealt * p.a);
        break;
      case 'heal':
        this.healArea(u.team[i], u.x[i], u.y[i], p.radius, p.dmg);
        this.burst(u.x[i], u.y[i], 1.8, skill);
        break;
      case 'bash':
        if (this.tick(i, p.every)) {
          this.areaStrike(i, p.radius, p.dmg, p.a, 0, 0, false);
          this.burst(u.x[i], u.y[i], p.radius, skill);
          if (this.emitEvents) this.pushEvent({ type: 'slam', x: u.x[i], y: u.y[i], unit: i });
        }
        break;
      case 'knives':
        if (this.tick(i, p.every)) {
          this.gather(this.enemyList[u.team[i]], u.x[i], u.y[i], p.radius, out, p.count);
          for (let k = 0; k < out.length; k++) this.damage(out[k], p.dmg, i, false);
          this.burst(u.x[i], u.y[i], p.radius, skill);
        }
        break;
      case 'shield':
        if (this.tick(i, p.every)) {
          this.gather(this.selfList[u.team[i]], u.x[i], u.y[i], p.radius, out, 48);
          let n = p.count;
          for (let k = 0; k < out.length && n > 0; k++) {
            const j = out[k];
            if (u.hp[j] < u.maxHp[j] * 0.7) {
              this.applyShield(j, p.dur, p.a);
              n--;
            }
          }
          this.burst(u.x[i], u.y[i], p.radius, skill);
        }
        break;
      case 'withstand':
        if (this.tick(i, p.every)) {
          this.gather(this.selfList[u.team[i]], u.x[i], u.y[i], p.radius, out, 48);
          for (let k = 0; k < out.length; k++) this.applyShield(out[k], p.dur, p.a);
          this.burst(u.x[i], u.y[i], p.radius, skill);
        }
        break;
      case 'charge':
        if (this.tick(i, p.every)) {
          this.gatherLine(this.enemyList[u.team[i]], u.x[i], u.y[i], nx, ny, p.length, p.half, out);
          for (let k = 0; k < out.length; k++) {
            this.damage(out[k], p.dmg, i, true);
            this.pushUnit(out[k], nx, ny, p.a);
            this.applyStun(out[k], 0.3);
          }
          this.burst(u.x[i] + nx * 3, u.y[i] + ny * 3, 2.5, skill);
        }
        break;
      case 'swarm':
        if (this.tick(i, p.every)) {
          this.gatherLine(this.enemyList[u.team[i]], u.x[i], u.y[i], nx, ny, p.length, p.half, out);
          for (let k = 0; k < out.length; k++) this.damage(out[k], p.dmg, i, false);
          this.burst(u.x[i] + nx * 4, u.y[i] + ny * 4, 3.5, skill);
        }
        break;
      case 'fear':
        if (this.tick(i, p.every)) {
          this.gather(this.enemyList[u.team[i]], u.x[i], u.y[i], p.radius, out, 64);
          for (let k = 0; k < out.length; k++) this.applyFear(out[k], p.dur, u.x[i], u.y[i]);
          this.burst(u.x[i], u.y[i], p.radius, skill);
        }
        break;
      case 'rockThrow':
        if (this.tick(i, p.every)) {
          this.gather(this.enemyList[u.team[i]], u.x[t], u.y[t], p.radius, out, 48);
          for (let k = 0; k < out.length; k++) {
            this.damage(out[k], p.dmg, i, false);
            this.applyStun(out[k], p.dur);
          }
          this.burst(u.x[t], u.y[t], p.radius, skill);
        }
        break;
      case 'refraction':
        if (this.tick(i, p.every)) {
          u.invulnT[i] = p.dur;
          this.gather(this.enemyList[u.team[i]], u.x[i], u.y[i], p.radius, out, 48);
          for (let k = 0; k < out.length; k++) this.damage(out[k], p.dmg, i, false);
          this.burst(u.x[i], u.y[i], p.radius, skill);
        }
        break;
    }
  }

  /** Uzaktan saldiri: mermi uretir, yetenek icin yuk/bayrak koyar. */
  private fireShot(i: number, t: number, dist: number, power: number, skill: SkillId | null): void {
    const u = this.units;
    const s = STATS[u.kind[i]];
    const team = u.team[i];
    let dmg = power;
    let flags = s.shape === 3 ? PF_PIERCE : 0;
    const lob = s.splash >= 3 || skill === 'ship';
    if (skill) {
      const p = this.sp(skill);
      switch (skill) {
        case 'crit':
          if (this.rng() < p.a) dmg *= p.b;
          break;
        case 'spearBuild':
          u.stacks[i] = Math.min(p.count, u.stacks[i] + 1);
          u.stackT[i] = p.dur;
          break;
        case 'frostBlast':
        case 'fireball':
        case 'ship':
        case 'curseZone':
        case 'chill':
          if (this.tick(i, p.every)) flags |= PF_SKILL;
          break;
        case 'scarecrow':
          flags |= PF_SKILL;
          break;
        case 'orbs':
          if (this.tick(i, p.every)) this.fireOrbs(i, p);
          break;
        case 'axes':
          if (this.tick(i, p.every)) {
            const nx = dist > 0.01 ? (u.x[t] - u.x[i]) / dist : 1;
            const ny = dist > 0.01 ? (u.y[t] - u.y[i]) / dist : 0;
            const out = this.scratch;
            this.gatherLine(this.enemyList[team], u.x[i], u.y[i], nx, ny, p.length, p.half, out);
            for (let k = 0; k < out.length; k++) this.damage(out[k], p.dmg, i, false);
            this.burst(u.x[i] + nx * 5, u.y[i] + ny * 5, 3, skill);
          }
          break;
      }
    }
    const speed = lob ? 10 : ARROW_SPEED;
    const flight = Math.max(0.25, dist / speed);
    const tx = u.x[t] + u.vx[t] * flight;
    const ty = u.y[t] + u.vy[t] * flight;
    const height = lob ? 30 + dist * 3 : 18 + dist * 2.2;
    this.projectiles.spawn(u.x[i], u.y[i], tx, ty, flight, height, dmg, team, i, s.splash, flags, PROJ_TAG[u.kind[i]]);
    if (this.emitEvents) this.pushEvent({ type: 'shot', x: u.x[i], y: u.y[i], unit: i, angle: Math.atan2(ty - u.y[i], tx - u.x[i]) });
  }

  /** Horned Seer: ayni anda birden cok dusmana ates kuresi. */
  private fireOrbs(i: number, p: SkillParams): void {
    const u = this.units;
    const out = this.scratch;
    this.gather(this.enemyList[u.team[i]], u.x[i], u.y[i], STATS[u.kind[i]].range, out, 12);
    let n = p.count;
    for (let k = 0; k < out.length && n > 0; k++, n--) {
      const j = out[k];
      const d = Math.hypot(u.x[j] - u.x[i], u.y[j] - u.y[i]);
      this.projectiles.spawn(u.x[i], u.y[i], u.x[j], u.y[j], Math.max(0.3, d / ARROW_SPEED), 20 + d * 2, p.dmg, u.team[i], i, 0, 0, 1);
    }
  }

  /** Mermi indi: alan, delici ya da tek hedef; yetenek yan etkileri. */
  private arrowLanded(x: number, y: number, team: number, dmg: number, idx: number): void {
    const u = this.units;
    const pr = this.projectiles;
    const src = pr.src[idx];
    const spl = pr.splash[idx];
    const fl = pr.flags[idx];
    const skill = src >= 0 ? STATS[u.kind[src]].skill : null;
    const out = this.scratch;
    const enemies = this.enemyList[team];
    out.length = 0;
    if (spl > 0) {
      this.gather(enemies, x, y, spl, out, 64);
      if (out.length > 0 && this.emitEvents && spl >= 2.5) this.burst(x, y, spl, skill);
    } else {
      const g0 = this.grids[0];
      const cols = g0.cols;
      const cx = Math.min(cols - 1, Math.max(0, (x / g0.cell) | 0));
      const cy = Math.min(cols - 1, Math.max(0, (y / g0.cell) | 0));
      let best = -1;
      let bestD = LANDING_RADIUS;
      for (let e = 0; e < enemies.length; e++) {
        const grid = this.grids[enemies[e]];
        for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
          for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
            const c = gy * cols + gx;
            for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
              const j = grid.items[k];
              if (!u.alive[j]) continue;
              const ex = u.x[j] - x;
              const ey = u.y[j] - y;
              const d = Math.sqrt(ex * ex + ey * ey);
              if (d < bestD) {
                bestD = d;
                best = j;
              }
            }
          }
        }
      }
      if (best >= 0) out.push(best);
      if (best >= 0 && (fl & PF_PIERCE) !== 0) {
        // Delici: ayni noktanin hemen arkasindaki iki dusmana daha, azalan hasarla.
        const extra = this.scratch2;
        this.gather(enemies, x, y, 1.6, extra, 12);
        let n = 2;
        for (let k = 0; k < extra.length && n > 0; k++) {
          if (extra[k] !== best) {
            out.push(extra[k]);
            n--;
          }
        }
      }
    }
    if (out.length === 0) {
      if (this.emitEvents) this.pushEvent({ type: 'land', x, y, unit: -1 });
      if (skill === 'burnOil') this.landSkill(src, x, y, team, skill, fl);
      return;
    }
    let amount = dmg;
    let slowSkill: SkillParams | null = null;
    let stun = 0;
    if (skill && (fl & PF_SKILL) !== 0) {
      const p = this.sp(skill);
      if (skill === 'frostBlast') {
        amount = p.dmg;
        slowSkill = p;
      } else if (skill === 'ship') {
        amount = dmg * p.a;
        stun = p.dur;
      } else if (skill === 'chill') {
        slowSkill = p;
        stun = p.dur * 0.75;
      } else if (skill === 'scarecrow') stun = p.dur;
    } else if (skill === 'scarecrow') stun = this.sp('scarecrow').dur;
    else if (skill === 'chill') slowSkill = this.sp('chill');
    const first = out[0];
    for (let k = 0; k < out.length; k++) {
      const j = out[k];
      this.damage(j, k === 0 || spl > 0 ? amount : amount * 0.6, src, false);
      if (!u.alive[j]) continue;
      if (slowSkill) this.applySlow(j, slowSkill.dur || 2, slowSkill.a, slowSkill.b);
      if (stun > 0 && (skill !== 'chill' || (fl & PF_SKILL) !== 0)) this.applyStun(j, stun);
    }
    this.landSkill(src, x, y, team, skill, fl, first);
  }

  /** Inis sonrasi yetenek etkileri: bolge, bolunen toplar. */
  private landSkill(src: number, x: number, y: number, team: number, skill: SkillId | null, fl: number, first = -1): void {
    if (!skill || src < 0) return;
    const p = this.sp(skill);
    if (skill === 'burnOil') this.addZone(x, y, p.radius, p.dur, p.dmg / p.dur, team, 1, skill);
    else if (skill === 'curseZone' && (fl & PF_SKILL) !== 0) this.addZone(x, y, p.radius, p.dur, p.dmg, team, p.a, skill);
    else if (skill === 'fireball' && (fl & PF_SKILL) !== 0) {
      const near = this.scratch2;
      this.gather(this.enemyList[team], x, y, p.radius, near, 24);
      const u = this.units;
      for (let k = 0; k < p.count && near.length > 0; k++) {
        const j = near[Math.floor(this.rng() * near.length)];
        if (j === first && near.length > 1) continue;
        this.projectiles.spawn(x, y, u.x[j], u.y[j], 0.3, 14, p.dmg, team, src, 0, 0, 1);
      }
    }
  }

  /** Hasar uygular; gercekte dusen can miktarini dondurur. src: saldiran, melee: yakin vurus, quiet: olay/parlama uretme (sureli hasar). */
  private damage(j: number, amount: number, src = -1, melee = false, quiet = false): number {
    const u = this.units;
    if (!u.alive[j] || u.invulnT[j] > 0) return 0;
    // Uzun suredir kimse olmediyse hasar kademeli artar: iyilestirme dengesi savasi kilitleyemez.
    const stale = this.time - this.lastDeathTime - STALE_AFTER;
    if (stale > 0) amount *= 1 + stale * STALE_RAMP;
    amount *= 1 - STATS[u.kind[j]].armor;
    if (u.shieldT[j] > 0) amount *= u.shieldK[j];
    const dealt = Math.min(amount, Math.max(0, u.hp[j]));
    this.counters.damage += dealt;
    if (!quiet) {
      if (this.emitEvents) this.pushEvent({ type: 'hit', x: u.x[j], y: u.y[j], unit: j, value: amount, kind: u.kind[j] });
      u.flash[j] = 0.12;
    }
    u.hp[j] -= amount;
    const skill = STATS[u.kind[j]].skill;
    if (skill === 'thorns' && melee && src >= 0 && u.alive[src]) this.damage(src, amount * this.sp('thorns').a, -1, false, true);
    if (!quiet && this.links.size > 0) {
      const lk = this.links.get(j);
      if (lk) for (const e of lk) if (u.alive[e]) this.damage(e, amount * this.sp('destinyBond').a, -1, false, true);
    }
    if (u.hp[j] <= 0) {
      if (skill === 'revive' && (u.flags[j] & F_REVIVED) === 0) {
        u.flags[j] |= F_REVIVED;
        u.hp[j] = u.maxHp[j] * this.sp('revive').a;
        u.invulnT[j] = 1;
        this.cleanse(j);
        this.burst(u.x[j], u.y[j], 2.2, skill);
        return dealt;
      }
      if (skill === 'explode' && (u.flags[j] & F_EXPLODED) === 0) {
        u.hp[j] = 1;
        this.explode(j);
        return dealt;
      }
      if (skill === 'destinyBond') {
        const lk = this.links.get(j);
        if (lk) for (const e of lk) if (u.alive[e]) this.damage(e, this.sp('destinyBond').dmg, -1, false, true);
      }
      this.killUnit(j);
    }
    return dealt;
  }

  private killUnit(j: number): void {
    const u = this.units;
    u.hp[j] = 0;
    this.lastDeathTime = this.time;
    this.counters.kills++;
    u.alive[j] = 0;
    u.deathT[j] = 0;
    u.target[j] = -1;
    if (isRanged(u.kind[j])) {
      this.dbg.archerDeaths++;
      if (u.kiteState[j] === 1) this.dbg.archerDeathsKiting++;
    }
    if (this.emitEvents) this.pushEvent({ type: 'death', x: u.x[j], y: u.y[j], unit: j, kind: u.kind[j] });
  }

  /**
   * Hedefe dogru yuru. Arazi varsa: nehrin karsisindaysa kopruden gecer (useRoute), yurunemez
   * karoya girerse eksen boyunca kayar, ilerleyemiyorsa yan adimla kurtulmayi dener.
   * Gercek kat edilen mesafeyi dondurur.
   */
  private moveToward(i: number, gx: number, gy: number, speed: number, dt: number, faceMove = true, useRoute = true): number {
    if (this.units.slowT[i] > 0 || this.units.flags[i] !== 0) speed *= this.moveMul(i);
    const u = this.units;
    const t = this.terrain;
    if (t && useRoute) {
      this.applyRoute(i, gx, gy);
      gx = this.rx;
      gy = this.ry;
      this.followPath(i, gx, gy, dt);
      gx = this.rx;
      gy = this.ry;
    }
    const dx = gx - u.x[i];
    const dy = gy - u.y[i];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-4) return 0;
    let ux = dx / d;
    let uy = dy / d;
    if (u.sideT[i] > 0) {
      const sd = u.sideDir[i];
      const sx = -uy * sd;
      const sy = ux * sd;
      ux = ux * 0.35 + sx * 0.9;
      uy = uy * 0.35 + sy * 0.9;
      const m = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= m;
      uy /= m;
    }
    // Yumusak yon: kararli ilerleme icin yonu hedefe dogru yumusakca cevir; ters donuste fren yap.
    const hl = Math.abs(u.hx[i]) + Math.abs(u.hy[i]);
    if (hl < 0.01) {
      u.hx[i] = ux;
      u.hy[i] = uy;
    } else {
      const dot = u.hx[i] * ux + u.hy[i] * uy;
      if (dot < -0.3) u.spd[i] *= MOTION.brake;
      const k = Math.min(1, MOTION.turn * dt);
      let hx = u.hx[i] + (ux - u.hx[i]) * k;
      let hy = u.hy[i] + (uy - u.hy[i]) * k;
      const hm = Math.sqrt(hx * hx + hy * hy) || 1;
      hx /= hm;
      hy /= hm;
      u.hx[i] = hx;
      u.hy[i] = hy;
    }
    // Ivmelen: duran birim hizli ama aninda degil kalkar; hedef hiz asilmaz.
    u.spd[i] = Math.min(speed, u.spd[i] + MOTION.accel * dt);
    // Guvenlik: hesaplanan hiz cok dusukse yine de ilerle (sikisma tespiti calissin).
    const eff = Math.max(u.spd[i], speed * 0.25);
    ux = u.hx[i];
    uy = u.hy[i];
    const step = Math.min(eff * dt, d);
    const ox = u.x[i];
    const oy = u.y[i];
    // Konumlar Float32 saklanir: yurunebilirlik testi yuvarlanmis degerle yapilmali.
    const lim = this.mapSize - 0.5;
    let nx = Math.fround(Math.min(lim, Math.max(0.5, ox + ux * step)));
    let ny = Math.fround(Math.min(lim, Math.max(0.5, oy + uy * step)));
    if (t && !t.stepOk(ox, oy, nx, ny)) {
      // Engel onunde kenar boyunca TAM hizla kay (hedef yonu engele dikse bile ilerleyebilsin).
      const canX = t.walkable(Math.fround(ox + (ux >= 0 ? step : -step)), oy);
      const canY = t.walkable(ox, Math.fround(oy + (uy >= 0 ? step : -step)));
      const dirX = Math.abs(ux) > 1e-3 ? (ux > 0 ? 1 : -1) : u.sideDir[i];
      const dirY = Math.abs(uy) > 1e-3 ? (uy > 0 ? 1 : -1) : u.sideDir[i];
      let slideX = canX && (!canY || Math.abs(ux) >= Math.abs(uy));
      let slideY = canY && !slideX;
      if (!slideX && !slideY) {
        // Iki eksen de dogrudan yonde kapali: ters yone (engelin yanina) dene.
        if (t.walkable(Math.fround(ox + dirX * -step), oy) && Math.abs(ux) > 1e-3) {
          nx = Math.fround(ox - dirX * step);
          ny = oy;
        } else {
          nx = ox;
          ny = oy;
        }
        slideX = slideY = false;
      }
      if (slideX) {
        nx = Math.fround(Math.min(lim, Math.max(0.5, ox + dirX * step)));
        ny = oy;
        if (!t.walkable(nx, ny)) nx = ox;
      } else if (slideY) {
        nx = ox;
        ny = Math.fround(Math.min(lim, Math.max(0.5, oy + dirY * step)));
        if (!t.walkable(nx, ny)) ny = oy;
      }
      // Ters yone kayma dali da dogrulanmali.
      if (!t.walkable(nx, ny)) {
        nx = ox;
        ny = oy;
      }
    }
    u.x[i] = nx;
    u.y[i] = ny;
    const mdx = nx - ox;
    const mdy = ny - oy;
    const mv = Math.sqrt(mdx * mdx + mdy * mdy);
    u.vx[i] = mdx / dt;
    u.vy[i] = mdy / dt;
    if (mv > 1e-4) u.moving[i] = 1;

    // Net yer degistirme penceresi: 0.8 sn'de 0.3 tile'dan az ilerlediyse (ileri-geri kipirdama dahil) sikismis say.
    u.winT[i] += dt;
    if (u.winT[i] >= 0.8) {
      const wx = u.x[i] - u.winX[i];
      const wy = u.y[i] - u.winY[i];
      if (wx * wx + wy * wy < 0.09 && d > 1.2) {
        u.stuckT[i] = Math.max(u.stuckT[i], 0.6);
        this.dbg.stuck++;
      }
      u.winX[i] = u.x[i];
      u.winY[i] = u.y[i];
      u.winT[i] = 0;
    }
    // Hedefe dogru gercek ilerleme (kenar boyunca surunmek ilerleme sayilmaz).
    const progress = mdx * ux + mdy * uy;
    if (step > 0.02 && progress < step * 0.25) {
      u.stuckT[i] += dt;
      if (u.stuckT[i] > 0.5 && d > 1) {
        u.sideT[i] = 0.6;
        u.sideDir[i] = this.rng() < 0.5 ? -1 : 1;
        u.stuckT[i] = 0;
        this.dbg.stuck++;
      }
    } else if (u.stuckT[i] > 0) {
      u.stuckT[i] = Math.max(0, u.stuckT[i] - dt);
    }
    if (faceMove) this.faceTo(i, dx, dy);
    return mv;
  }

  /**
   * Sikisan birim icin A* yolu: yol varsa (rx, ry) = siradaki ara nokta. Yol yoksa hedef
   * ulasilamaz sayilir ve yasaklanir.
   */
  private followPath(i: number, gx: number, gy: number, dt: number): void {
    const u = this.units;
    const t = this.terrain!;
    this.rx = gx;
    this.ry = gy;
    let p = this.paths.get(i);
    if (p) {
      p.t += dt;
      const gd = (gx - p.gx) ** 2 + (gy - p.gy) ** 2;
      if (gd > 9 || p.t > 12) {
        this.paths.delete(i);
        p = undefined;
      }
    }
    // Her ~0.6 sn'de (birime kaydirmali) goruş hatti kontrolu: hedef/ara hedef gorunmuyorsa yol iste,
    // gorunuyorsa mevcut yolu birak.
    let blocked = false;
    if ((i + this.stepNo) % 20 === 0) {
      const dx0 = gx - u.x[i];
      const dy0 = gy - u.y[i];
      const far = dx0 * dx0 + dy0 * dy0 > 6;
      const clear = !far || t.lineWalkable(u.x[i], u.y[i], gx, gy);
      if (p && clear) {
        this.paths.delete(i);
        p = undefined;
      }
      blocked = far && !clear;
    }
    // Aktif yolun siradaki ara noktasi mevcut konumdan gorunmuyorsa (surunme/itilme) yolu yeniden kur.
    let dropped = false;
    if (p) {
      const k = Math.min(p.k, p.pts.length / 2 - 1);
      if (!t.lineWalkable(u.x[i], u.y[i], p.pts[k * 2], p.pts[k * 2 + 1])) {
        this.paths.delete(i);
        p = undefined;
        dropped = true;
      }
    }
    if (!p && (u.stuckT[i] > 0.3 || blocked || dropped) && this.pathBudget > 0) {
      this.pathBudget--;
      const pts = t.findPath(u.x[i], u.y[i], gx, gy);
      if (pts && pts.length > 0) {
        p = { pts, k: 0, gx, gy, t: 0 };
        this.paths.set(i, p);
        this.dbg.paths++;
        u.sideT[i] = 0;
      } else if (!pts) {
        this.dbg.pathFails++;
        const tg = u.target[i];
        if (tg >= 0) {
          u.banTarget[i] = tg;
          u.banT[i] = BAN_TIME;
          if (isHealer(u.kind[i])) {
            if (u.healers[tg] > 0) u.healers[tg]--;
          } else if (u.attackers[tg] > 0) u.attackers[tg]--;
          u.target[i] = -1;
          u.retarget[i] = 0;
        }
        u.stuckT[i] = 0;
      }
    }
    if (!p) return;
    const m = p.pts.length / 2;
    while (p.k < m) {
      const wx = p.pts[p.k * 2] - u.x[i];
      const wy = p.pts[p.k * 2 + 1] - u.y[i];
      if (wx * wx + wy * wy > 0.12) break;
      p.k++;
    }
    // Birimin guncel konumundan bir sonraki ara nokta dogrudan gorunuyorsa ara noktayi atla.
    if (p.k + 1 < m && t.lineWalkable(u.x[i], u.y[i], p.pts[(p.k + 1) * 2], p.pts[(p.k + 1) * 2 + 1])) p.k++;
    if (p.k >= m) {
      this.paths.delete(i);
      return;
    }
    this.rx = p.pts[p.k * 2];
    this.ry = p.pts[p.k * 2 + 1];
    u.sideT[i] = 0;
  }

  /** Nehir gecisi: hedef karsi yakadaysa (rx, ry) = kopru girisi/cikisi, degilse hedefin kendisi. */
  private applyRoute(i: number, gx: number, gy: number): void {
    const u = this.units;
    const t = this.terrain!;
    this.rx = gx;
    this.ry = gy;
    const su = t.sideAt(u.x[i], u.y[i]);
    const sg = t.sideAt(gx, gy);
    let b = u.route[i];
    const lat = (((i * 37) % 100) / 100 - 0.5) * 1.8;

    // Kopru koridorunun disina ciktiysa (kiyiya itildi, hedef degisti) evreyi sifirla: girise don.
    if (b >= 0 && u.routePhase[i] === 1) {
      const br = t.bridges[b];
      const s = t.toS(u.x[i], u.y[i]);
      const d = t.toD(u.x[i], u.y[i]);
      if (Math.abs(s - br.s) > br.halfW + 0.4 || Math.abs(d - br.o) > br.halfLen + 1.2) u.routePhase[i] = 0;
    }

    if (su === sg) {
      if (b >= 0 && u.routePhase[i] === 1) {
        // Orta noktayi gectik: karsi uca kadar kopruden cik.
        const e = this.tmpA;
        t.bridgeEnd(t.bridges[b], su, lat, e);
        const ex = e.x - u.x[i];
        const ey = e.y - u.y[i];
        if (ex * ex + ey * ey > 1) {
          this.rx = e.x;
          this.ry = e.y;
          return;
        }
      }
      u.route[i] = -1;
      u.routePhase[i] = 0;
      return;
    }

    if (b < 0) {
      b = this.chooseBridge(su, u.x[i], u.y[i], gx, gy);
      if (b < 0) return;
      u.route[i] = b;
      u.routePhase[i] = 0;
    }
    const br = t.bridges[b];
    if (u.routePhase[i] === 0) {
      const e = this.tmpA;
      t.bridgeEnd(br, su, lat, e);
      const ex = e.x - u.x[i];
      const ey = e.y - u.y[i];
      if (ex * ex + ey * ey > 0.8) {
        this.rx = e.x;
        this.ry = e.y;
        return;
      }
      u.routePhase[i] = 1;
    }
    const x = this.tmpA;
    t.bridgeEnd(br, -su, lat, x);
    this.rx = x.x;
    this.ry = x.y;
  }

  private chooseBridge(su: number, x: number, y: number, gx: number, gy: number): number {
    const t = this.terrain!;
    let best = -1;
    let bestCost = Infinity;
    const a = this.tmpA;
    const c = this.tmpB;
    for (let k = 0; k < t.bridges.length; k++) {
      const br = t.bridges[k];
      t.bridgeEnd(br, su, 0, a);
      t.bridgeEnd(br, -su, 0, c);
      const cost = Math.hypot(a.x - x, a.y - y) + br.w + 5 + Math.hypot(c.x - gx, c.y - gy);
      if (cost < bestCost) {
        bestCost = cost;
        best = k;
      }
    }
    return best;
  }

  private faceTo(i: number, dx: number, dy: number): void {
    const sx = dx - dy; // ekran x yonu
    if (Math.abs(sx) > 0.05) this.units.facing[i] = sx >= 0 ? 1 : -1;
  }

  /** Komsu hucrelerdeki birimlerle ittirme: her cift bir kez islenir (j > i). */
  private separate(): void {
    const u = this.units;
    const phase = this.sepTick++ % SEP_STRIDE;
    const lim = this.mapSize - 0.5;
    const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    const grid = this.sepGrid;
    const cols = grid.cols;
    const terrain = this.terrain;
    const flags = terrain ? terrain.flags : null;
    const n = this.mapSize;
    const isBad = (x: number, y: number): boolean => {
      const f = flags![(Math.fround(y) | 0) * n + (Math.fround(x) | 0)];
      return f === T_WATER || f === T_BLOCKED;
    };
    // Itme: hedef su/engel olmamali ve kose capraz gecisinde yan komsular acik olmali.
    const bad = (ox: number, oy: number, x: number, y: number): boolean => {
      if (!flags) return false;
      if (isBad(x, y)) return true;
      const fx = Math.fround(x);
      const fy = Math.fround(y);
      const gx = Math.fround(ox);
      const gy = Math.fround(oy);
      return (gx | 0) !== (fx | 0) && (gy | 0) !== (fy | 0) && (isBad(fx, gy) || isBad(gx, fy));
    };
    // Yumusak ayrisma: her adimda 1/SEP_STRIDE'i komsu ciftlerden (j > i) itme hizi biriktirir
    // (i'ye +, j'ye -); tum birimler itme hizini HER adim uygular ve hiz sonumlenir. Karsilikli
    // sert itmeyle olusan kare-kare titreme boylece olmaz.
    const maxStep = SEP_MAX_STEP;
    const sx = u.sepX;
    const sy = u.sepY;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) continue;
      if (i % SEP_STRIDE === phase) {
        const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / grid.cell) | 0));
        const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / grid.cell) | 0));
        const xi = u.x[i];
        const yi = u.y[i];
        // Saldiran birim yerinde durur: komsulari onu az iter (vurus animasyonu oynamayi surdurur).
        const wi = u.swing[i] > 0 ? 0.35 : 1;
        for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
          for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
            const c = gy * cols + gx;
            for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
              const j = grid.items[k];
              if (j <= i || !u.alive[j]) continue;
              const dx = xi - u.x[j];
              const dy = yi - u.y[j];
              const d2 = dx * dx + dy * dy;
              if (d2 >= r2) continue;
              let fx: number;
              let fy: number;
              if (d2 < 1e-6) {
                // Tam ust uste: indekse gore sabit, deterministik bir yon.
                const a = (i * 2.399963) % 6.283185;
                fx = Math.cos(a) * SEPARATION_RADIUS * 0.5;
                fy = Math.sin(a) * SEPARATION_RADIUS * 0.5;
              } else {
                const d = Math.sqrt(d2);
                const f = ((SEPARATION_RADIUS - d) * 0.5) / d;
                fx = dx * f;
                fy = dy * f;
              }
              const wj = u.swing[j] > 0 ? 0.35 : 1;
              sx[i] += fx * SEP_GAIN * wi;
              sy[i] += fy * SEP_GAIN * wi;
              sx[j] -= fx * SEP_GAIN * wj;
              sy[j] -= fy * SEP_GAIN * wj;
            }
          }
        }
      }
    }
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) continue;
      let vx = sx[i];
      let vy = sy[i];
      const m = vx * vx + vy * vy;
      if (m < 1e-7) {
        sx[i] = sy[i] = 0;
        if (u.x[i] > lim || u.y[i] > lim || u.x[i] < 0.5 || u.y[i] < 0.5) {
          u.x[i] = Math.min(lim, Math.max(0.5, u.x[i]));
          u.y[i] = Math.min(lim, Math.max(0.5, u.y[i]));
        }
        continue;
      }
      if (m > maxStep * maxStep) {
        const q = maxStep / Math.sqrt(m);
        vx *= q;
        vy *= q;
      }
      const bx = u.x[i];
      const by = u.y[i];
      let nx = Math.min(lim, Math.max(0.5, bx + vx));
      let ny = Math.min(lim, Math.max(0.5, by + vy));
      if (bad(bx, by, nx, ny)) {
        nx = bx;
        ny = by;
        sx[i] = sy[i] = 0;
      }
      u.x[i] = nx;
      u.y[i] = ny;
      sx[i] *= SEP_DECAY;
      sy[i] *= SEP_DECAY;
    }
    this.pushAroundTanks(bad);
  }

  /** Tanklar (2x boyut) yakinlarindaki birimleri belirgin sekilde iter. */
  private pushAroundTanks(bad: (ox: number, oy: number, x: number, y: number) => boolean): void {
    const u = this.units;
    const R = TANK.pushRadius;
    const g0 = this.grids[0];
    const cols = g0.cols;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i] || !isTank(u.kind[i])) continue;
      const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / g0.cell) | 0));
      const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / g0.cell) | 0));
      for (let t = 0; t < this.teamCount; t++) {
        // Tank yalniz DUSMAN birimleri iter: dost birimleri iterse ayni takim birbirini kilitler.
        if (t === u.team[i]) continue;
        const grid = this.grids[t];
        for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
          for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
            const c = gy * cols + gx;
            for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
              const j = grid.items[k];
              if (j === i || !u.alive[j]) continue;
              const dx = u.x[j] - u.x[i];
              const dy = u.y[j] - u.y[i];
              const d2 = dx * dx + dy * dy;
              if (d2 >= R * R) continue;
              const d = Math.sqrt(d2) || 0.001;
              const share = isTank(u.kind[j]) ? 0.5 : 1;
              const k2 = ((R - d) * 0.35 * share) / d;
              const nx = d2 === 0 ? 1 : dx;
              const lim = this.mapSize - 0.5;
              const jx = Math.min(lim, Math.max(0.5, u.x[j] + nx * k2));
              const jy = Math.min(lim, Math.max(0.5, u.y[j] + dy * k2));
              if (!bad(u.x[j], u.y[j], jx, jy)) {
                u.x[j] = jx;
                u.y[j] = jy;
              }
            }
          }
        }
      }
    }
  }
}

/** Blok genisligi (kolon) ve aralik; blok, derinliginden genis olur. */
export function benchLayout(perTeam: number): { cols: number; rows: number; spacing: number } {
  const cols = Math.max(2, Math.ceil(Math.sqrt(perTeam * 1.6)));
  return { cols, rows: Math.ceil(perTeam / cols), spacing: 1.2 };
}

function benchMapSize(perTeam: number): number {
  const { cols, rows, spacing } = benchLayout(perTeam);
  const depth = 2 * rows * spacing + BENCH_GAP;
  const width = cols * spacing;
  // Ordular capraz (x-y) eksende dizildigi icin harita kosegeni (x1.41) yetmeli.
  return Math.ceil(Math.max(depth, width) / 1.38) + 8;
}

export function unitCapacity(config: BattleConfig): number {
  if (config.mode === 'custom') {
    const L = config.layout;
    let necro = 0;
    if (L) for (let k = 1; k < L.length; k += 4) if (L[k] === KIND_OF_TROOP.bone-caller) necro++;
    return Math.floor((L?.length ?? 0) / 4) + 16 + necro * SUMMON_POOL;
  }
  return config.perTeam * 2 + 16;
}

export function projectileCapacity(config: BattleConfig): number {
  if (config.mode === 'custom') return 4096;
  return config.mode === 'bench' ? 16384 : 1024;
}

export function mapSizeFor(config: BattleConfig): number {
  if (config.mode === 'custom') return config.mapSize ?? MAP_SIZE;
  if (config.mode !== 'bench') return MAP_SIZE;
  // Cevre aciksa ordu blogunun cevresinde orman/koy icin pay birakilir.
  return Math.ceil(benchMapSize(config.perTeam) * (config.env === false ? 1 : 1.3));
}

/** Doguslarin kapladigi bolge: engel/dekor bu bolgeye konmaz. */
function spawnZone(config: BattleConfig): { spawnD0: number; spawnD1: number; spawnHalfS: number } {
  // custom: kullanici serbest yerlestirir, doguş bolgesi rezerve edilmez.
  if (config.mode === 'custom') return { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };
  if (config.mode === 'bench') {
    const { cols, rows, spacing } = benchLayout(config.perTeam);
    return {
      spawnD0: BENCH_GAP / 2 - 1,
      spawnD1: BENCH_GAP / 2 + rows * spacing + 2,
      spawnHalfS: (cols * spacing) / 2 + 3,
    };
  }
  return { spawnD0: DEMO_GAP_HALF - 1, spawnD1: DEMO_GAP_HALF + 4.5 + 1.5, spawnHalfS: 7 };
}

/** Sim (worker) ve renderer (ana thread) ayni haritayi bununla uretir. */
export function terrainFor(config: BattleConfig): Terrain | null {
  if (config.env === false) return null;
  return new Terrain(mapSizeFor(config), { seed: config.terrainSeed ?? 1, spec: config.map, ...spawnZone(config) });
}

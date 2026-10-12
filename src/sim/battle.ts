import { Grid } from './grid';
import { Terrain, T_BLOCKED, T_WATER } from './terrain';
import type { MapSpec } from './mapSpec';
import { KITE, Kind, MAX_TEAMS, MOTION, STATS, TANK, Units, applyStats, isHealer, isMelee, isRanged, isTank, type StatOverrides } from './units';
import { Projectiles } from './projectiles';
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
const SEP_STRIDE = 2;
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
  type: 'heal' | 'death' | 'bash' | 'slam' | 'hit' | 'shot' | 'land';
  x: number;
  y: number;
  unit: number;
  /** bash: itme yonu (radyan, dunya x/y duzleminde). */
  angle?: number;
  value?: number;
  /** Olay sahibi birimin turu (olum/vurus icin). */
  kind?: number;
}

/** Adim basina uretilen olay ust siniri (cok kalabalikta mesaj/tahsis patlamasin). */
const EVENT_CAP = 300;

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
    if (this.config.mode === 'custom') {
      this.spawnLayout();
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
      this.separate(dt);
      tn = performance.now();
      pf.separate += tn - tp;
      tp = tn;
    }

    this.projectiles.update(dt, (x, y, team, dmg) => this.arrowLanded(x, y, team, dmg));
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
    u.cooldown[i] -= dt;
    u.retarget[i] -= dt;
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

    if (dist <= (isMelee(kind) ? s.range + MELEE_SLACK : s.range * 0.95)) {
      u.chaseT[i] = 0;
      u.chaseBest[i] = Infinity;
    } else if (this.chaseWatchdog(i, t, dist, dt)) {
      return;
    }

    if (isMelee(kind)) {
      if (dist > s.range + MELEE_SLACK) {
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
    const t = u.target[i];
    if (t < 0 || !u.alive[t]) return;
    const s = STATS[u.kind[i]];
    const dx = u.x[t] - u.x[i];
    const dy = u.y[t] - u.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (isMelee(u.kind[i]) && !isTank(u.kind[i])) {
      if (dist <= s.range + 0.6) this.damage(t, s.power);
    } else if (u.kind[i] === Kind.Shield) {
      this.shieldBash(i, dx, dy, dist);
    } else if (u.kind[i] === Kind.Brute) {
      this.bruteSlam(i);
    } else if (isRanged(u.kind[i])) {
      const flight = Math.max(0.25, dist / ARROW_SPEED);
      // Hareketli hedefe on tahminle atar; tahmin tutmazsa ok kacirir.
      const tx = u.x[t] + u.vx[t] * flight;
      const ty = u.y[t] + u.vy[t] * flight;
      this.projectiles.spawn(u.x[i], u.y[i], tx, ty, flight, 18 + dist * 2.2, s.power, u.team[i]);
      if (this.emitEvents) this.pushEvent({ type: 'shot', x: u.x[i], y: u.y[i], unit: i, angle: Math.atan2(ty - u.y[i], tx - u.x[i]) });
    } else if (dist <= s.range + 1 && u.hp[t] < u.maxHp[t]) {
      const before = u.hp[t];
      const stale = this.time - this.lastDeathTime - STALE_AFTER;
      const heal = stale > 0 ? s.power / (1 + stale * STALE_RAMP) : s.power;
      u.hp[t] = Math.min(u.maxHp[t], u.hp[t] + heal);
      this.counters.heal += u.hp[t] - before;
      if (this.emitEvents) this.pushEvent({ type: 'heal', x: u.x[t], y: u.y[t], unit: t, value: heal, kind: u.kind[t] });
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

  private arrowLanded(x: number, y: number, team: number, dmg: number): void {
    const u = this.units;
    const g0 = this.grids[0];
    const cols = g0.cols;
    const cx = Math.min(cols - 1, Math.max(0, (x / g0.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (y / g0.cell) | 0));
    let best = -1;
    let bestD = LANDING_RADIUS;
    const enemies = this.enemyList[team];
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
    if (best >= 0) this.damage(best, dmg);
    else if (this.emitEvents) this.pushEvent({ type: 'land', x, y, unit: -1 });
  }

  private damage(j: number, amount: number): void {
    const u = this.units;
    // Uzun suredir kimse olmediyse hasar kademeli artar: iyilestirme dengesi savasi kilitleyemez.
    const stale = this.time - this.lastDeathTime - STALE_AFTER;
    if (stale > 0) amount *= 1 + stale * STALE_RAMP;
    amount *= 1 - STATS[u.kind[j]].armor;
    this.counters.damage += Math.min(amount, Math.max(0, u.hp[j]));
    if (this.emitEvents) this.pushEvent({ type: 'hit', x: u.x[j], y: u.y[j], unit: j, value: amount, kind: u.kind[j] });
    u.hp[j] -= amount;
    u.flash[j] = 0.12;
    if (u.hp[j] <= 0) {
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
  }

  /**
   * Hedefe dogru yuru. Arazi varsa: nehrin karsisindaysa kopruden gecer (useRoute), yurunemez
   * karoya girerse eksen boyunca kayar, ilerleyemiyorsa yan adimla kurtulmayi dener.
   * Gercek kat edilen mesafeyi dondurur.
   */
  private moveToward(i: number, gx: number, gy: number, speed: number, dt: number, faceMove = true, useRoute = true): number {
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
  private separate(dt: number): void {
    const u = this.units;
    const push = Math.min(1, dt * 10 * SEP_STRIDE);
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
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) continue;
      if (i % SEP_STRIDE !== phase) {
        u.x[i] = Math.min(lim, Math.max(0.5, u.x[i]));
        u.y[i] = Math.min(lim, Math.max(0.5, u.y[i]));
        continue;
      }
      const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / grid.cell) | 0));
      const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / grid.cell) | 0));
      // Itme gecersiz konuma sokarsa yalniz itmeyi geri al (adimdaki hareketi silme).
      const bx = u.x[i];
      const by = u.y[i];
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
          const c = gy * cols + gx;
          for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
            const j = grid.items[k];
            if (j <= i || !u.alive[j]) continue;
            const dx = u.x[j] - u.x[i];
            const dy = u.y[j] - u.y[i];
            const d2 = dx * dx + dy * dy;
            if (d2 >= r2) continue;
            const d = Math.sqrt(d2) || 0.001;
            const kk = ((SEPARATION_RADIUS - d) * 0.5 * push) / d;
            const nx = d2 === 0 ? 1 : dx;
            u.x[i] -= nx * kk;
            u.y[i] -= dy * kk;
            const jx = Math.min(lim, Math.max(0.5, u.x[j] + nx * kk));
            const jy = Math.min(lim, Math.max(0.5, u.y[j] + dy * kk));
            if (bad(u.x[j], u.y[j], jx, jy)) continue; // j'yi suya/engele itme
            u.x[j] = jx;
            u.y[j] = jy;
          }
        }
      }
      u.x[i] = Math.min(lim, Math.max(0.5, u.x[i]));
      u.y[i] = Math.min(lim, Math.max(0.5, u.y[i]));
      if (bad(bx, by, u.x[i], u.y[i])) {
        u.x[i] = bx;
        u.y[i] = by;
      }
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
  if (config.mode === 'custom') return Math.floor((config.layout?.length ?? 0) / 4) + 16;
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

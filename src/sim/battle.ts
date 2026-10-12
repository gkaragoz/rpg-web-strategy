import { Grid } from './grid';
import { Terrain, T_BLOCKED, T_WATER } from './terrain';
import { KITE, Kind, STATS, Team, Units } from './units';
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
const DEMO_GAP_HALF = 9;
const BENCH_GAP = 24;

export interface SimEvent {
  type: 'heal' | 'death';
  x: number;
  y: number;
  unit: number;
}

export interface BattleConfig {
  /** 'demo': 10v10 el yapimi dizilim, 'bench': takim basina perTeam birim blok dizilimi. */
  mode: 'demo' | 'bench';
  perTeam: number;
  /** false: cevre (nehir, engeller) yok, eski cıplak harita. Varsayilan true. */
  env?: boolean;
  /** Harita tohumu. */
  terrainSeed?: number;
  /** false: okcu/priest vur-kac ve cizgi siniri kapali (eski davranis, karsilastirma icin). */
  kite?: boolean;
}

export const DBG_KEYS = ['kites', 'kiteSteps', 'snapShots', 'archerDeaths', 'archerDeathsKiting', 'stuck', 'cornered'] as const;

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
  readonly dbg: Record<(typeof DBG_KEYS)[number], number> = {
    kites: 0,
    kiteSteps: 0,
    snapShots: 0,
    archerDeaths: 0,
    archerDeathsKiting: 0,
    stuck: 0,
    cornered: 0,
  };
  readonly alivePerTeam = [0, 0];
  private rng: () => number = Math.random;
  private get kiteOn(): boolean {
    return this.config.kite !== false;
  }
  private stepNo = 0;
  private lastDeathTime = 0;
  private readonly centroidX = [0, 0];
  private readonly centroidY = [0, 0];
  /** Warrior merkezi (cizgi sinirı); warrior yoksa takim merkezi. */
  private readonly frontX = [0, 0];
  private readonly frontY = [0, 0];
  private readonly hasFront = [false, false];
  private readonly grids: [Grid, Grid];
  private readonly sepGrid: Grid;
  private sepTick = 0;
  private rx = 0;
  private ry = 0;
  private readonly tmpA = { x: 0, y: 0 };
  private readonly tmpB = { x: 0, y: 0 };

  constructor(seed = 1, config: BattleConfig = { mode: 'demo', perTeam: 10 }) {
    this.config = config;
    const total = unitCapacity(config);
    this.mapSize = mapSizeFor(config);
    this.terrain = terrainFor(config);
    this.units = new Units(total);
    this.projectiles = new Projectiles(projectileCapacity(config));
    this.grids = [new Grid(this.mapSize, GRID_CELL, total), new Grid(this.mapSize, GRID_CELL, total)];
    this.sepGrid = new Grid(this.mapSize, SEP_CELL, total);
    this.reset(seed);
  }

  /** Bench modunda olum/iyilestirme olaylari uretilmez (render bunlari kullanmaz). */
  private get emitEvents(): boolean {
    return this.config.mode === 'demo';
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
    for (const k of DBG_KEYS) this.dbg[k] = 0;
    if (this.config.mode === 'bench') {
      this.spawnBenchArmy(Team.Blue, -1);
      this.spawnBenchArmy(Team.Red, 1);
    } else {
      this.spawnArmy(Team.Blue, -1);
      this.spawnArmy(Team.Red, 1);
    }
    this.countAlive();
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
    this.alivePerTeam[0] = this.alivePerTeam[1] = 0;
    for (let i = 0; i < u.count; i++) if (u.alive[i]) this.alivePerTeam[u.team[i]]++;
  }

  step(dt: number): void {
    const u = this.units;
    this.time += dt;
    this.stepNo++;
    const pf = this.prof;
    let tp = performance.now();

    u.attackers.fill(0, 0, u.count);
    u.healers.fill(0, 0, u.count);
    this.centroidX[0] = this.centroidX[1] = this.centroidY[0] = this.centroidY[1] = 0;
    const n = [0, 0];
    const wx = [0, 0];
    const wy = [0, 0];
    const wn = [0, 0];
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) {
        u.deathT[i] += dt;
        continue;
      }
      u.px[i] = u.x[i];
      u.py[i] = u.y[i];
      u.vx[i] = u.vy[i] = 0;
      u.moving[i] = 0;
      u.flash[i] = Math.max(0, u.flash[i] - dt);
      const t = u.target[i];
      if (t >= 0 && u.alive[t]) {
        if (u.kind[i] === Kind.Priest) u.healers[t]++;
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
      if (u.kind[i] === Kind.Warrior) {
        wx[tm] += u.x[i];
        wy[tm] += u.y[i];
        wn[tm]++;
      }
    }
    for (let tm = 0; tm < 2; tm++) {
      if (n[tm] > 0) {
        this.centroidX[tm] /= n[tm];
        this.centroidY[tm] /= n[tm];
      }
      this.hasFront[tm] = wn[tm] > 0;
      this.frontX[tm] = wn[tm] > 0 ? wx[tm] / wn[tm] : this.centroidX[tm];
      this.frontY[tm] = wn[tm] > 0 ? wy[tm] / wn[tm] : this.centroidY[tm];
    }

    let tn = performance.now();
    pf.prep += tn - tp;
    tp = tn;
    this.grids[0].build(u, 0);
    this.grids[1].build(u, 1);
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
      if (this.alivePerTeam[Team.Blue] === 0) this.winner = Team.Red;
      else if (this.alivePerTeam[Team.Red] === 0) this.winner = Team.Blue;
    }
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
    const ranged = kind !== Kind.Warrior;
    u.cooldown[i] -= dt;
    u.retarget[i] -= dt;
    if (u.sideT[i] > 0) u.sideT[i] -= dt;

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
      u.retarget[i] = u.target[i] < 0 ? 0.4 + this.rng() * 0.3 : 1.2 + this.rng() * 1.6;
    }

    if (ranged && this.kiteOn && this.tryKite(i, dt)) return;

    const t = u.target[i];
    if (t < 0) {
      if (kind === Kind.Priest) this.followArmy(i, dt);
      else this.marchToEnemy(i, dt);
      return;
    }

    const dx = u.x[t] - u.x[i];
    const dy = u.y[t] - u.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (kind === Kind.Warrior) {
      if (dist > s.range) {
        // Hedefin etrafinda kisiye ozel bir aciya kosar: herkes ayni noktaya yigilmaz.
        const base = Math.atan2(-dy, -dx) + u.slotAngle[i];
        const reach = s.range * 0.7;
        this.moveToward(i, u.x[t] + Math.cos(base) * reach, u.y[t] + Math.sin(base) * reach, s.speed, dt);
        return;
      }
    } else if (dist > s.range * 0.95) {
      if (kind === Kind.Priest && this.kiteOn) {
        // Hastaya arkasindan yaklas: dusmandan uzakta dur.
        const en = 1 - u.team[i];
        let ax = u.x[t] - this.centroidX[en];
        let ay = u.y[t] - this.centroidY[en];
        const len = Math.sqrt(ax * ax + ay * ay) || 1;
        ax /= len;
        ay /= len;
        this.moveToward(i, u.x[t] + ax * 3, u.y[t] + ay * 3, s.speed, dt);
      } else if (this.beyondLeash(i)) {
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
    const danger = u.kind[i] === Kind.Archer ? KITE.archerDanger : KITE.priestDanger;
    const d2max = danger * danger;
    const grid = this.grids[1 - u.team[i]];
    const cols = grid.cols;
    const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / grid.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / grid.cell) | 0));
    const xi = u.x[i];
    const yi = u.y[i];
    let best = Infinity;
    let ax = 0;
    let ay = 0;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(cols - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
        const c = gy * cols + gx;
        for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
          const j = grid.items[k];
          if (u.kind[j] !== Kind.Warrior) continue;
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
    const archer = u.kind[i] === Kind.Archer;
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
          if (ex * ex + ey * ey <= STATS[Kind.Archer].range * STATS[Kind.Archer].range) {
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

  /** Okcu/priest kendi warrior merkezinin onune (dusmana dogru) gecmesin. */
  private beyondLeash(i: number): boolean {
    const u = this.units;
    const tm = u.team[i];
    if (!this.kiteOn || !this.hasFront[tm]) return false;
    const en = 1 - tm;
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
    const isPriest = kind === Kind.Priest;
    const grid = this.grids[isPriest ? team : 1 - team];
    const maxRing = isPriest ? PRIEST_RING : MAX_RING;
    const cols = grid.cols;
    const cx = Math.min(cols - 1, Math.max(0, (u.x[i] / grid.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (u.y[i] / grid.cell) | 0));
    const terrain = this.terrain;
    const sideI = terrain ? terrain.sideAt(u.x[i], u.y[i]) : 0;
    const reach = STATS[kind].range * 0.95;
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
          for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
            const j = grid.items[k];
            if (j === i || (isPriest && u.hp[j] >= u.maxHp[j])) continue;
            const ddx = u.x[j] - u.x[i];
            const ddy = u.y[j] - u.y[i];
            const dist = Math.sqrt(ddx * ddx + ddy * ddy);
            const jitter = this.rng();
            let score: number;
            if (kind === Kind.Warrior) {
              const att = u.attackers[j] - (j === cur ? 1 : 0);
              score = dist + att * 3.5 + jitter * 2 + (att >= MELEE_SLOTS ? 100 : 0);
            } else if (kind === Kind.Archer) {
              const att = u.attackers[j] - (j === cur ? 1 : 0);
              score = dist + att * 2 + (u.hp[j] / u.maxHp[j]) * 3 + jitter * 2;
            } else {
              const heal = u.healers[j] - (j === cur ? 1 : 0);
              score = (u.hp[j] / u.maxHp[j]) * 10 + dist * 0.3 + heal * 4 + jitter;
            }
            // Nehrin karsisindaki hedefe sadece gerekirse: okcu menzildeyse nehir uzerinden vurur.
            if (terrain && (kind === Kind.Warrior || isPriest || dist > reach) && terrain.sideAt(u.x[j], u.y[j]) !== sideI) {
              score += OTHER_BANK_PENALTY;
            }
            if (j === cur) score -= 2.5;
            if (score < bestScore) {
              bestScore = score;
              best = j;
            }
            if (foundRing < 0) foundRing = r;
          }
        }
      }
    }

    if (cur >= 0 && cur !== best) {
      if (isPriest) u.healers[cur]--;
      else u.attackers[cur]--;
    }
    if (best >= 0 && best !== cur) {
      if (isPriest) u.healers[best]++;
      else u.attackers[best]++;
    }
    u.target[i] = best;
  }

  private marchToEnemy(i: number, dt: number): void {
    const u = this.units;
    const en = 1 - u.team[i];
    if (this.alivePerTeam[en] === 0) return;
    if (u.kind[i] !== Kind.Warrior && this.beyondLeash(i)) return;
    this.moveToward(i, this.centroidX[en], this.centroidY[en], STATS[u.kind[i]].speed, dt);
  }

  private followArmy(i: number, dt: number): void {
    const u = this.units;
    const tm = u.team[i];
    const en = 1 - tm;
    let ax = this.centroidX[tm] - this.centroidX[en];
    let ay = this.centroidY[tm] - this.centroidY[en];
    const len = Math.sqrt(ax * ax + ay * ay) || 1;
    ax /= len;
    ay /= len;
    const gx = this.centroidX[tm] + ax * 2.5;
    const gy = this.centroidY[tm] + ay * 2.5;
    const gdx = gx - u.x[i];
    const gdy = gy - u.y[i];
    if (gdx * gdx + gdy * gdy > 2.25) this.moveToward(i, gx, gy, STATS[Kind.Priest].speed, dt);
  }

  private resolveHit(i: number): void {
    const u = this.units;
    const t = u.target[i];
    if (t < 0 || !u.alive[t]) return;
    const s = STATS[u.kind[i]];
    const dx = u.x[t] - u.x[i];
    const dy = u.y[t] - u.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (u.kind[i] === Kind.Warrior) {
      if (dist <= s.range + 0.6) this.damage(t, s.power);
    } else if (u.kind[i] === Kind.Archer) {
      const flight = Math.max(0.25, dist / ARROW_SPEED);
      // Hareketli hedefe on tahminle atar; tahmin tutmazsa ok kacirir.
      const tx = u.x[t] + u.vx[t] * flight;
      const ty = u.y[t] + u.vy[t] * flight;
      this.projectiles.spawn(u.x[i], u.y[i], tx, ty, flight, 18 + dist * 2.2, s.power, u.team[i]);
    } else if (dist <= s.range + 1 && u.hp[t] < u.maxHp[t]) {
      u.hp[t] = Math.min(u.maxHp[t], u.hp[t] + s.power);
      if (this.emitEvents) this.events.push({ type: 'heal', x: u.x[t], y: u.y[t], unit: t });
    }
  }

  private arrowLanded(x: number, y: number, team: number, dmg: number): void {
    const u = this.units;
    const grid = this.grids[1 - team];
    const cols = grid.cols;
    const cx = Math.min(cols - 1, Math.max(0, (x / grid.cell) | 0));
    const cy = Math.min(cols - 1, Math.max(0, (y / grid.cell) | 0));
    let best = -1;
    let bestD = LANDING_RADIUS;
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
    if (best >= 0) this.damage(best, dmg);
  }

  private damage(j: number, amount: number): void {
    const u = this.units;
    // Uzun suredir kimse olmediyse hasar kademeli artar: iyilestirme dengesi savasi kilitleyemez.
    const stale = this.time - this.lastDeathTime - STALE_AFTER;
    if (stale > 0) amount *= 1 + stale * STALE_RAMP;
    u.hp[j] -= amount;
    u.flash[j] = 0.12;
    if (u.hp[j] <= 0) {
      u.hp[j] = 0;
      this.lastDeathTime = this.time;
      u.alive[j] = 0;
      u.deathT[j] = 0;
      u.target[j] = -1;
      if (u.kind[j] === Kind.Archer) {
        this.dbg.archerDeaths++;
        if (u.kiteState[j] === 1) this.dbg.archerDeathsKiting++;
      }
      if (this.emitEvents) this.events.push({ type: 'death', x: u.x[j], y: u.y[j], unit: j });
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
    const step = Math.min(speed * dt, d);
    const ox = u.x[i];
    const oy = u.y[i];
    let nx = ox + ux * step;
    let ny = oy + uy * step;
    if (t && !t.walkable(nx, ny)) {
      if (t.walkable(nx, oy)) ny = oy;
      else if (t.walkable(ox, ny)) nx = ox;
      else {
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
    const bad = (x: number, y: number): boolean => {
      if (!flags) return false;
      const f = flags[(y | 0) * n + (x | 0)];
      return f === T_WATER || f === T_BLOCKED;
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
            const jx = u.x[j] + nx * kk;
            const jy = u.y[j] + dy * kk;
            if (bad(jx, jy)) continue; // j'yi suya/engele itme
            u.x[j] = jx;
            u.y[j] = jy;
          }
        }
      }
      u.x[i] = Math.min(lim, Math.max(0.5, u.x[i]));
      u.y[i] = Math.min(lim, Math.max(0.5, u.y[i]));
      if (bad(u.x[i], u.y[i])) {
        u.x[i] = u.px[i];
        u.y[i] = u.py[i];
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
  return config.perTeam * 2 + 16;
}

export function projectileCapacity(config: BattleConfig): number {
  return config.mode === 'bench' ? 16384 : 1024;
}

export function mapSizeFor(config: BattleConfig): number {
  if (config.mode !== 'bench') return MAP_SIZE;
  // Cevre aciksa ordu blogunun cevresinde orman/koy icin pay birakilir.
  return Math.ceil(benchMapSize(config.perTeam) * (config.env === false ? 1 : 1.3));
}

/** Doguslarin kapladigi bolge: engel/dekor bu bolgeye konmaz. */
function spawnZone(config: BattleConfig): { spawnD0: number; spawnD1: number; spawnHalfS: number } {
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
  return new Terrain(mapSizeFor(config), { seed: config.terrainSeed ?? 1, ...spawnZone(config) });
}

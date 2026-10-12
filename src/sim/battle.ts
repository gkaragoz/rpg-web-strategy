import { Grid } from './grid';
import { Kind, STATS, Team, Units } from './units';
import { Projectiles } from './projectiles';
import { mulberry32 } from './random';

export const MAP_SIZE = 40;
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
}

export class Battle {
  readonly units: Units;
  readonly projectiles: Projectiles;
  readonly events: SimEvent[] = [];
  readonly mapSize: number;
  readonly config: BattleConfig;
  winner = -1;
  time = 0;
  /** Faz bazli sim suresi (ms, birikimli): hazirlik, grid, birim guncelleme, ayrisma, ok. */
  readonly prof = { prep: 0, grid: 0, units: 0, pick: 0, separate: 0, arrows: 0, steps: 0 };
  readonly alivePerTeam = [0, 0];
  private rng: () => number = Math.random;
  private readonly centroidX = [0, 0];
  private readonly centroidY = [0, 0];
  private readonly grids: [Grid, Grid];
  private readonly sepGrid: Grid;
  private sepTick = 0;

  constructor(seed = 1, config: BattleConfig = { mode: 'demo', perTeam: 10 }) {
    this.config = config;
    const total = unitCapacity(config);
    this.mapSize = mapSizeFor(config);
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
    if (this.config.mode === 'bench') {
      this.spawnBenchArmy(Team.Blue, -1);
      this.spawnBenchArmy(Team.Red, 1);
    } else {
      this.spawnArmy(Team.Blue, -1);
      this.spawnArmy(Team.Red, 1);
    }
    this.countAlive();
  }

  /** Ordular ekranda yatay (x-y ekseni) boyunca karsilikli dizilir. */
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
        const d = 3.5 + depth + (this.rng() - 0.5) * 0.4;
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
    const pf = this.prof;
    let tp = performance.now();

    u.attackers.fill(0, 0, u.count);
    u.healers.fill(0, 0, u.count);
    this.centroidX[0] = this.centroidX[1] = this.centroidY[0] = this.centroidY[1] = 0;
    const n = [0, 0];
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
    }
    for (let tm = 0; tm < 2; tm++) {
      if (n[tm] > 0) {
        this.centroidX[tm] /= n[tm];
        this.centroidY[tm] /= n[tm];
      }
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
      for (let i = 0; i < u.count; i++) if (u.alive[i]) this.updateUnit(i, dt);
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

  private updateUnit(i: number, dt: number): void {
    const u = this.units;
    const s = STATS[u.kind[i]];
    u.cooldown[i] -= dt;
    u.retarget[i] -= dt;

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

    const t = u.target[i];
    if (t < 0) {
      if (u.kind[i] === Kind.Priest) this.followArmy(i, dt);
      else this.marchToEnemy(i, dt);
      return;
    }

    const dx = u.x[t] - u.x[i];
    const dy = u.y[t] - u.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (u.kind[i] === Kind.Warrior) {
      if (dist > s.range) {
        // Hedefin etrafinda kisiye ozel bir aciya kosar: herkes ayni noktaya yigilmaz.
        const base = Math.atan2(-dy, -dx) + u.slotAngle[i];
        const reach = s.range * 0.7;
        this.moveToward(i, u.x[t] + Math.cos(base) * reach, u.y[t] + Math.sin(base) * reach, s.speed, dt);
        return;
      }
    } else if (dist > s.range * 0.95) {
      this.moveToward(i, u.x[t], u.y[t], s.speed, dt);
      return;
    }

    this.faceTo(i, dx, dy);
    if (u.cooldown[i] <= 0) {
      u.cooldown[i] = s.cooldown;
      u.swing[i] = s.swing;
      u.hitPending[i] = 1;
    }
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
    this.moveToward(i, this.centroidX[en], this.centroidY[en], STATS[u.kind[i]].speed, dt);
  }

  private followArmy(i: number, dt: number): void {
    const u = this.units;
    const tm = u.team[i];
    const en = 1 - tm;
    let ax = this.centroidX[tm] - this.centroidX[en];
    let ay = this.centroidY[tm] - this.centroidY[en];
    const len = Math.hypot(ax, ay) || 1;
    ax /= len;
    ay /= len;
    const gx = this.centroidX[tm] + ax * 2.5;
    const gy = this.centroidY[tm] + ay * 2.5;
    if (Math.hypot(gx - u.x[i], gy - u.y[i]) > 1.5) this.moveToward(i, gx, gy, STATS[Kind.Priest].speed, dt);
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
    u.hp[j] -= amount;
    u.flash[j] = 0.12;
    if (u.hp[j] <= 0) {
      u.hp[j] = 0;
      u.alive[j] = 0;
      u.deathT[j] = 0;
      u.target[j] = -1;
      if (this.emitEvents) this.events.push({ type: 'death', x: u.x[j], y: u.y[j], unit: j });
    }
  }

  private moveToward(i: number, gx: number, gy: number, speed: number, dt: number): void {
    const u = this.units;
    const dx = gx - u.x[i];
    const dy = gy - u.y[i];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-4) return;
    const step = Math.min(speed * dt, d);
    u.x[i] += (dx / d) * step;
    u.y[i] += (dy / d) * step;
    u.vx[i] = (dx / d) * speed;
    u.vy[i] = (dy / d) * speed;
    u.moving[i] = 1;
    this.faceTo(i, dx, dy);
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
            u.x[j] += nx * kk;
            u.y[j] += dy * kk;
          }
        }
      }
      u.x[i] = Math.min(lim, Math.max(0.5, u.x[i]));
      u.y[i] = Math.min(lim, Math.max(0.5, u.y[i]));
    }
  }
}

const BENCH_GAP = 24;

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
  return config.mode === 'bench' ? benchMapSize(config.perTeam) : MAP_SIZE;
}

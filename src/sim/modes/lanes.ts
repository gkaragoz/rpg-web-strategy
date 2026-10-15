import type { Battle } from '../battle';
import { LANE_CASTLE_KIND, LANE_TOWER_KIND, STATS } from '../units';
import { LANE_COUNT, LANE_WAYPOINTS, openLanesGeometry, type LanePoint, type LanesGeometry } from '../terrainLanes';
import {
  LANES_ROUTE_LEN,
  LANES_TEAMS,
  LANES_TIME_LIMIT,
  LANES_TOWERS_PER_LANE,
  LANES_WAVES,
  laneKind,
  laneWaveSize,
  lanesHash,
  lanesPoolIndex,
  lanesPoolSize,
  lanesWaveOffset,
  lanesWaveStep,
} from './lanesWaves';
import type { ModeHud, ModeRules } from './types';

/** A soldier counts as having reached a waypoint within this many tiles. */
const WP_RADIUS = 2;
/** Waypoint progress is evaluated every this many steps. */
const ADVANCE_EVERY = 4;
/** Towers per team. */
const TOWERS_PER_TEAM = LANE_COUNT * LANES_TOWERS_PER_LANE;

/**
 * Lane Conquest: two teams, one castle each, three walled lanes between them, towers along the lanes.
 * Everything is autonomous: every LANES_INTERVAL seconds (first wave at LANES_FIRST_WAVE) each castle releases a wave of lane
 * soldiers PER LANE from a dormant pool (reserved at reset, see `lanesPoolSize`); a soldier walks the lane's waypoints towards the
 * enemy castle (per-unit goals, see Battle.unitGoalX) and fights whatever it meets like any other unit, then attacks the enemy
 * castle. Human-placed armies get no goal: they use the classic AI (nearest enemy) and A* through the lanes.
 *
 * Win: destroying the enemy castle (the other team wins; with two teams the killer is always the other team). After
 * LANES_TIME_LIMIT seconds the castle with the higher health fraction wins, equal fractions are a draw (-2). The classic "last
 * team standing" rule is off (`lastStanding = false`): a team without an army keeps receiving waves. `alivePerTeam` counts soldiers
 * and human units only, never castles or towers.
 *
 * Towers are armed structures (see battleTower.ts): immobile, immune to displacement and crowd control, they shoot the nearest enemy
 * soldier in range and are never themselves target-picked by towers; soldiers and humans do attack them.
 *
 * State (plain numbers, in serialize/restore/hash): waves released, first pool unit, castle unit per team, tower units, and per pool
 * soldier its waypoint index. The unit goal arrays are derived from it (restore rebuilds them).
 */
export class LanesRules implements ModeRules {
  readonly id = 'lanes' as const;
  readonly lastStanding = false;
  private wave = 0;
  private poolStart = 0;
  private readonly castle = [-1, -1];
  private readonly tower: number[] = new Array(LANES_TEAMS * TOWERS_PER_TEAM).fill(-1);
  private geo: LanesGeometry = openLanesGeometry(80);
  /** Per [team][lane]: route of x,y pairs (the lane waypoints in walking order, then the enemy castle). */
  private readonly route: Float32Array[][] = [[], []];
  /** Per pool soldier: team, lane and the index of the waypoint it is walking to. */
  private poolTeam = new Uint8Array(0);
  private poolLane = new Uint8Array(0);
  private wp = new Uint8Array(0);
  /** Pool soldiers released so far (prefix of the pool). */
  private released = 0;
  private sps = 30;

  init(b: Battle): void {
    this.sps = Math.max(1, Math.round(1 / b.dt));
    this.wave = 0;
    this.released = 0;
    this.geo = b.terrain?.laneGeo ?? openLanesGeometry(b.mapSize);
    this.buildRoutes();
    this.castle.fill(-1);
    this.tower.fill(-1);
    for (let t = 0; t < LANES_TEAMS; t++) {
      const c = this.geo.castle[t];
      this.castle[t] = b.spawnStructure(LANE_CASTLE_KIND, t, c.x, c.y);
      for (let l = 0; l < LANE_COUNT; l++) {
        for (let k = 0; k < LANES_TOWERS_PER_LANE; k++) {
          const p = this.geo.tower[t][l][k];
          this.tower[t * TOWERS_PER_TEAM + l * LANES_TOWERS_PER_LANE + k] = b.spawnStructure(LANE_TOWER_KIND, t, p.x, p.y);
        }
      }
    }
    const u = b.units;
    const total = lanesPoolSize();
    this.poolStart = u.count;
    this.poolTeam = new Uint8Array(total);
    this.poolLane = new Uint8Array(total);
    this.wp = new Uint8Array(total);
    for (let n = 1; n <= LANES_WAVES; n++) {
      const size = laneWaveSize(n);
      for (let t = 0; t < LANES_TEAMS; t++) {
        for (let l = 0; l < LANE_COUNT; l++) {
          for (let k = 0; k < size; k++) {
            const p = lanesPoolIndex(n, t, l, k);
            const i = u.spawn(t, laneKind(n, k), this.geo.castle[t].x, this.geo.castle[t].y, b.rng);
            u.alive[i] = 0;
            u.deathT[i] = 1000;
            u.hp[i] = 0;
            u.lane[i] = l;
            this.poolTeam[p] = t;
            this.poolLane[p] = l;
          }
        }
      }
    }
    // Capacity is reserved from the config: the pool must fit exactly.
    if (u.count - this.poolStart !== total) throw new Error('lanes pool does not fit the unit capacity');
  }

  private buildRoutes(): void {
    const g = this.geo;
    for (let t = 0; t < LANES_TEAMS; t++) {
      const enemy = g.castle[1 - t];
      for (let l = 0; l < LANE_COUNT; l++) {
        const r = new Float32Array(LANES_ROUTE_LEN * 2);
        for (let k = 0; k < LANE_WAYPOINTS; k++) {
          const p: LanePoint = g.lane[l][t === 0 ? k : LANE_WAYPOINTS - 1 - k];
          r[k * 2] = p.x;
          r[k * 2 + 1] = p.y;
        }
        r[LANE_WAYPOINTS * 2] = enemy.x;
        r[LANE_WAYPOINTS * 2 + 1] = enemy.y;
        this.route[t][l] = r;
      }
    }
  }

  private setGoal(b: Battle, i: number, p: number): void {
    const r = this.route[this.poolTeam[p]][this.poolLane[p]];
    const w = this.wp[p];
    b.unitGoalX[i] = r[w * 2];
    b.unitGoalY[i] = r[w * 2 + 1];
    b.unitHasGoal[i] = 1;
  }

  step(b: Battle, dt: number): void {
    this.sps = Math.max(1, Math.round(1 / dt));
    if (this.wave < LANES_WAVES && b.stepNo >= lanesWaveStep(this.wave + 1, this.sps)) {
      this.release(b, this.wave + 1);
      this.wave++;
      // Fresh soldiers are alive now: the winner check of this very step must see them.
      b.countAlive();
    }
    if (this.released > 0 && b.stepNo % ADVANCE_EVERY === 0) this.advance(b);
  }

  /** Wakes wave n: every team's soldiers appear in front of their castle, fanned out towards their own lane. */
  private release(b: Battle, n: number): void {
    const u = b.units;
    const size = laneWaveSize(n);
    for (let t = 0; t < LANES_TEAMS; t++) {
      for (let l = 0; l < LANE_COUNT; l++) {
        const sp = this.geo.spawn[t][l];
        for (let k = 0; k < size; k++) {
          const p = lanesPoolIndex(n, t, l, k);
          const i = this.poolStart + p;
          const h = lanesHash(n * 131 + t * 17 + l * 3 + 7, k);
          const ang = ((h & 0xffff) / 65536) * Math.PI * 2;
          const rad = 0.5 + (((h >>> 16) & 0xffff) / 65536) * 1.9;
          let x = sp.x + Math.cos(ang) * rad;
          let y = sp.y + Math.sin(ang) * rad;
          if (b.terrain) {
            const q = b.terrain.nearestWalkable(x, y, 3, true);
            x = q ? q.x : sp.x;
            y = q ? q.y : sp.y;
          } else {
            const lim = b.mapSize - 0.5;
            x = Math.min(lim, Math.max(0.5, x));
            y = Math.min(lim, Math.max(0.5, y));
          }
          u.alive[i] = 1;
          u.hp[i] = u.maxHp[i];
          u.deathT[i] = 0;
          u.x[i] = u.px[i] = x;
          u.y[i] = u.py[i] = y;
          u.winX[i] = x;
          u.winY[i] = y;
          u.winT[i] = 0;
          u.target[i] = -1;
          u.retarget[i] = 0;
          u.cooldown[i] = 0.4;
          u.flash[i] = 0.25;
          this.wp[p] = 0;
          this.setGoal(b, i, p);
        }
      }
    }
    this.released = lanesWaveOffset(n + 1);
    // A quiet stretch before the wave must not count as "nobody died for a long time" (damage ramp).
    b.lastDeathTime = b.time;
  }

  /** Moves living soldiers on to their next waypoint once they are close to the current one. */
  private advance(b: Battle): void {
    const u = b.units;
    for (let p = 0; p < this.released; p++) {
      const i = this.poolStart + p;
      if (!u.alive[i]) continue;
      const w = this.wp[p];
      if (w >= LANES_ROUTE_LEN - 1) continue;
      const dx = u.x[i] - b.unitGoalX[i];
      const dy = u.y[i] - b.unitGoalY[i];
      if (dx * dx + dy * dy < WP_RADIUS * WP_RADIUS) {
        this.wp[p] = w + 1;
        this.setGoal(b, i, p);
      }
    }
  }

  private castleDead(b: Battle, t: number): boolean {
    const c = this.castle[t];
    return c >= 0 && !b.units.alive[c];
  }

  private castleFraction(b: Battle, t: number): number {
    const c = this.castle[t];
    const u = b.units;
    return c >= 0 && u.alive[c] ? Math.min(1, Math.max(0, u.hp[c] / u.maxHp[c])) : 0;
  }

  winner(b: Battle): number | undefined {
    const d0 = this.castleDead(b, 0);
    const d1 = this.castleDead(b, 1);
    if (d0 && d1) return -2;
    if (d0) return 1;
    if (d1) return 0;
    if (b.stepNo >= LANES_TIME_LIMIT * this.sps) {
      const f0 = this.castleFraction(b, 0);
      const f1 = this.castleFraction(b, 1);
      if (Math.abs(f0 - f1) < 1e-9) return -2;
      return f0 > f1 ? 0 : 1;
    }
    return undefined;
  }

  serialize(): number[] {
    const out = [this.wave, this.poolStart, this.castle[0], this.castle[1], ...this.tower];
    for (let p = 0; p < this.wp.length; p++) out.push(this.wp[p]);
    return out;
  }

  restore(s: number[], b?: Battle): void {
    this.wave = s[0] ?? 0;
    this.poolStart = s[1] ?? this.poolStart;
    this.castle[0] = s[2] ?? -1;
    this.castle[1] = s[3] ?? -1;
    for (let k = 0; k < this.tower.length; k++) this.tower[k] = s[4 + k] ?? -1;
    const base = 4 + this.tower.length;
    for (let p = 0; p < this.wp.length; p++) this.wp[p] = s[base + p] ?? 0;
    this.released = this.wave > 0 ? lanesWaveOffset(this.wave + 1) : 0;
    if (!b) return;
    // The goals are a pure function of the waypoint indices: rebuild them for every released soldier, clear the rest.
    b.unitGoalX.fill(0);
    b.unitGoalY.fill(0);
    b.unitHasGoal.fill(0);
    for (let p = 0; p < this.released; p++) this.setGoal(b, this.poolStart + p, p);
    this.sps = Math.max(1, Math.round(1 / b.dt));
  }

  hud(b: Battle): ModeHud {
    const u = b.units;
    const castles = [];
    for (let t = 0; t < LANES_TEAMS; t++) {
      const c = this.castle[t];
      castles.push({
        team: t,
        hp: this.castleFraction(b, t),
        maxHp: c >= 0 ? u.maxHp[c] : STATS[LANE_CASTLE_KIND].hp,
        unit: c,
        x: this.geo.castle[t].x,
        y: this.geo.castle[t].y,
      });
    }
    const towers = [0, 0];
    for (let t = 0; t < LANES_TEAMS; t++) {
      for (let k = 0; k < TOWERS_PER_TEAM; k++) {
        const i = this.tower[t * TOWERS_PER_TEAM + k];
        if (i >= 0 && u.alive[i]) towers[t]++;
      }
    }
    const next = this.wave >= LANES_WAVES ? 0 : Math.max(0, lanesWaveStep(this.wave + 1, this.sps) / this.sps - b.stepNo / this.sps);
    return { kind: 'lanes', castles, towers, wave: this.wave, nextIn: next, timeLeft: Math.max(0, LANES_TIME_LIMIT - b.stepNo / this.sps) };
  }

  scores(): number[] | undefined {
    return undefined;
  }

  /** Unit indices (castle per team, towers per team in lane/outer-inner order) and geometry, for the UI and tests. */
  structures(): { castle: number[]; tower: number[]; geometry: LanesGeometry } {
    return { castle: this.castle.slice(), tower: this.tower.slice(), geometry: this.geo };
  }

  /** First pool unit index and waves released (tests). */
  poolInfo(): { start: number; wave: number } {
    return { start: this.poolStart, wave: this.wave };
  }
}

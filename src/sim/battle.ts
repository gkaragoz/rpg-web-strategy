import { Grid } from './grid';
import { Terrain } from './terrain';
import { simDtFor } from './constants';
import { MovePool, PH_GRID, PH_MOVE, PH_PICK, PH_SEP_APPLY, PH_SEP_SCAN, phaseChunk, type HelperInit } from './movePool';
import { Picker } from './picker';
import { Separator } from './separator';
import { Mover, MV_FACE, MV_INTENT, MV_ROUTE, CNT_PATHS, CNT_PATH_FAILS, CNT_STUCK } from './mover';
import { F_RAGE, ST_BURN, ST_FEAR, ST_INVULN, ST_SHIELD, ST_SLOW, ST_STUN, ST_TAUNT, KITE, MAX_TEAMS, MOTION, STATS, TANK, Units, applyStats, isHealer, isMelee, isTank, KIND_COUNT } from './units';
import { Projectiles } from './projectiles';
import { skillParams, type SkillParams } from './data/skills';
import { Mulberry } from './random';
import { GRID_CELL, MELEE_SLACK, SEP_CELL, SEP_DECAY, SEP_GAIN, SEP_MAX_STEP, SEP_STRIDE } from './tuning';
import { copyTyped, fnv, pasteTyped, type BattleSnapshot, type Typed } from './snapshot';
import type { SkillId } from './data/troops';
import { TANK_REACH, BAN_TIME, NO_DAMAGE_DRAW, NO_DAMAGE_DRAW_FIRST, NO_DAMAGER_DRAW, EVENT_CAP, DBG_KEYS, EXTRA_DBG, unitCapacity, projectileCapacity, mapSizeFor, terrainFor, type SimEvent, type BattleConfig, type Zone } from './battleConfig';
import { sp, atkRate, burst } from './battleEffects';
import { damage, updateZones, flyStep, applyKnockback } from './battleDamage';
import { resolveHit, periodic, arrowLanded } from './battleSkills';
import { beyondLeash, canShoot, updateThreat, tryKite, chaseWatchdog, leashHold, pickNow, marchToEnemy, followArmy } from './battleAi';
import { spawnLayout, spawnArmy, spawnBenchArmy, setupSkills } from './battleSetup';
import { modeFor, vipUnitsOf } from './modes';
import type { ModeHud, ModeRules } from './modes/types';

// Public API re-exported from the split modules: other code keeps importing everything from './battle'.
export { MAP_SIZE, DBG_KEYS, EXTRA_DBG, benchLayout, unitCapacity, projectileCapacity, mapSizeFor, terrainFor } from './battleConfig';
export type { SimEvent, BattleConfig } from './battleConfig';

export class Battle {
  readonly units: Units;
  readonly projectiles: Projectiles;
  readonly events: SimEvent[] = [];
  readonly mapSize: number;
  readonly config: BattleConfig;
  readonly terrain: Terrain | null;
  winner = -1;
  time = 0;
  /** Sim time per phase (ms, accumulated): preparation, grid, unit update, separation, arrows. */
  readonly prof = { prep: 0, grid: 0, units: 0, pick: 0, separate: 0, arrows: 0, steps: 0 };
  /** Behavior counters (for verification). */
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
  /** Total damage/heal/death counters (for progress measurement and tests). */
  readonly counters = { damage: 0, heal: 0, kills: 0 };
  /**
   * Damage meter (display only, never read by the simulation): damage dealt per team x unit kind
   * (index team * KIND_COUNT + kind) and kills per team. Included in snapshots, not in the hash.
   */
  readonly meter = { dmg: new Float64Array(MAX_TEAMS * KIND_COUNT), kills: new Float64Array(MAX_TEAMS) };
  private lastDamageSeen = 0;
  private lastDamageT = 0;
  private noDamagerSince = -1;
  readonly alivePerTeam: number[] = new Array(MAX_TEAMS).fill(0);
  private rngObj = new Mulberry(1);
  /** @internal */
  rng: () => number = this.rngObj.next;
  /** @internal */
  get kiteOn(): boolean {
    return this.config.kite !== false;
  }
  /** @internal */
  stepNo = 0;
  /** Time scale of the current step relative to 30 Hz (1 at 30 Hz): per-step constants are scaled by it so a 20 Hz battle behaves alike. */
  private tk = 1;
  private brakeK = MOTION.brake;
  private sepDecayK = SEP_DECAY;
  private losEvery = 20;
  /** @internal */
  scanEveryK = KITE.scanEvery;
  /** A* paths for stuck units (unit -> waypoints) and the per-frame path computation budget. @internal */
  mover: Mover;
  /** @internal */
  readonly picker: Picker;
  private readonly separator: Separator;
  private aliveMask = 0;
  private pool: MovePool | null = null;
  /** Test hook: permutation of the movement chunks to execute (see runMoves). */
  chunkOrder: ((chunks: number) => number[]) | null = null;
  /** @internal */
  lastDeathTime = 0;
  /** @internal */
  readonly centroidX: number[] = new Array(MAX_TEAMS).fill(0);
  /** @internal */
  readonly centroidY: number[] = new Array(MAX_TEAMS).fill(0);
  /** Melee center (line limit); the team center if there is no melee. @internal */
  readonly frontX: number[] = new Array(MAX_TEAMS).fill(0);
  /** @internal */
  readonly frontY: number[] = new Array(MAX_TEAMS).fill(0);
  /** @internal */
  readonly hasFront: boolean[] = new Array(MAX_TEAMS).fill(false);
  /** Nearest living enemy team per team (-1: none) and the list of living enemy teams. @internal */
  readonly nearestEnemy = new Int8Array(MAX_TEAMS).fill(-1);
  /** @internal */
  readonly enemyList: number[][] = Array.from({ length: MAX_TEAMS }, () => []);
  private readonly teamCount: number;
  /** Whether comedy physics is on (config.comedy). @internal */
  readonly comedy: boolean;
  /** @internal */
  readonly allTeams: number[];
  /** Number of living non-priest units per team (so a team made only of priests does not flee). @internal */
  readonly damagerCount: number[] = new Array(MAX_TEAMS).fill(0);
  /** @internal */
  readonly selfList: number[][] = Array.from({ length: MAX_TEAMS }, (_, t) => [t]);
  /** @internal */
  readonly grids: Grid[];
  private readonly sepGrid: Grid;
  private sepTick = 0;
  /** Custom layouts: unit index spawned for each layout entry (position order), -1 when the entry was skipped. @internal */
  readonly layoutUnits: number[] = [];
  /** Rules of the game mode (classic: none; ctf plays as classic until implemented). */
  readonly mode: ModeRules;
  /** Optional per-team goal set by the mode: units without a target march there instead of toward the nearest enemy. @internal */
  readonly teamGoalX = new Float32Array(MAX_TEAMS);
  /** @internal */
  readonly teamGoalY = new Float32Array(MAX_TEAMS);
  /** @internal */
  readonly teamHasGoal = new Uint8Array(MAX_TEAMS);

  constructor(seed = 1, config: BattleConfig = { mode: 'demo', perTeam: 10 }) {
    this.config = config;
    applyStats(config.stats);
    const total = unitCapacity(config);
    this.mapSize = mapSizeFor(config);
    this.terrain = terrainFor(config);
    this.units = new Units(total);
    this.mover = new Mover(this.units, this.terrain, this.mapSize, skillParams('rage').a);
    this.projectiles = new Projectiles(projectileCapacity(config));
    this.teamCount = Math.min(MAX_TEAMS, Math.max(2, config.teamCount ?? 2));
    this.comedy = config.comedy === true;
    this.mode = modeFor(config.rules);
    this.allTeams = Array.from({ length: this.teamCount }, (_, t) => t);
    this.grids = Array.from({ length: this.teamCount }, () => new Grid(this.mapSize, GRID_CELL, total));
    this.sepGrid = new Grid(this.mapSize, SEP_CELL, total);
    this.picker = new Picker(this.units, this.terrain, this.grids, this.teamCount);
    this.separator = new Separator(this.units, this.terrain, this.sepGrid, this.mapSize);
    this.reset(seed);
  }

  /**
   * Runs the movement phase on extra threads (the units' arrays move into shared memory). Results do not depend on the
   * number of threads. `post` hands the setup message to whoever owns the helper workers (the page); they join as soon as
   * they are ready and until then this thread does all the work.
   */
  useThreads(helpers: number, post: (init: HelperInit) => void, log?: (msg: string) => void): void {
    if (this.pool || helpers < 1 || typeof SharedArrayBuffer === 'undefined') return;
    const grids = [...this.grids, this.sepGrid].map((g) => g.share());
    const pool = new MovePool(this.units, this.config, skillParams('rage').a, helpers, post, grids, this.teamCount, log);
    this.pool = pool;
    this.mover = new Mover(this.units, this.terrain, this.mapSize, skillParams('rage').a, pool.counts);
  }

  /** Threads used by the movement phase besides the sim thread. */
  get helperThreads(): number {
    return this.pool?.size ?? 0;
  }

  /** Tells the helper threads to exit (their owner terminates the workers). */
  dispose(): void {
    this.pool?.stop();
    this.pool = null;
  }

  /** In bench mode, death/heal events are not produced (the renderer does not use them). @internal */
  get emitEvents(): boolean {
    return this.config.mode !== 'bench';
  }

  reset(seed: number): void {
    this.rngObj = new Mulberry(seed);
    this.rng = this.rngObj.next;
    this.units.clear();
    this.projectiles.clear();
    this.events.length = 0;
    this.winner = -1;
    this.time = 0;
    this.stepNo = 0;
    this.lastDeathTime = 0;
    this.counters.damage = this.counters.heal = this.counters.kills = 0;
    this.meter.dmg.fill(0);
    this.meter.kills.fill(0);
    this.lastDamageSeen = this.lastDamageT = 0;
    this.noDamagerSince = -1;
    for (const k of DBG_KEYS) this.dbg[k] = 0;
    this.dbg.bans = this.dbg.leashBreaks = this.dbg.paths = this.dbg.pathFails = 0;
    this.zones.length = 0;
    this.links.clear();
    this.pools.clear();
    this.layoutUnits.length = 0;
    if (this.config.mode === 'custom') {
      spawnLayout(this);
      setupSkills(this);
    } else if (this.config.mode === 'bench') {
      spawnBenchArmy(this, 0, -1);
      spawnBenchArmy(this, 1, 1);
    } else {
      spawnArmy(this, 0, -1);
      spawnArmy(this, 1, 1);
    }
    this.countAlive();
    this.teamGoalX.fill(0);
    this.teamGoalY.fill(0);
    this.teamHasGoal.fill(0);
    this.mode.init(this);
  }

  /** Display data of the running game mode (the UI draws it). */
  modeHud(): ModeHud {
    return this.mode.hud(this);
  }

  /**
   * Unit index of each team's VIP (length MAX_TEAMS, -1: none / not a VIP battle). Stable for the whole battle; unit indices
   * are identical on every backend (worker, lockstep). Backends that only have `modeHud` use `vipUnitsOf(hud)`.
   */
  vipUnits(): Int32Array {
    return vipUnitsOf(this.modeHud());
  }

  /** Same as modeScores(): the surface the lockstep runner reads when the battle ends. */
  get scores(): number[] | undefined {
    return this.modeScores();
  }

  /** Points per team of the mode (undefined for classic). */
  modeScores(): number[] | undefined {
    return this.mode.scores()?.slice(0, this.allTeams.length);
  }

  /** @internal */
  countAlive(): void {
    const u = this.units;
    this.alivePerTeam.fill(0);
    for (let i = 0; i < u.count; i++) if (u.alive[i]) this.alivePerTeam[u.team[i]]++;
  }

  step(dt: number): void {
    const u = this.units;
    this.time += dt;
    this.stepNo++;
    const tk = dt * 30;
    if (tk !== this.tk) {
      this.tk = tk;
      this.brakeK = Math.pow(MOTION.brake, tk);
      this.sepDecayK = Math.pow(SEP_DECAY, tk);
      this.losEvery = Math.max(1, Math.round(20 / tk));
      this.scanEveryK = Math.max(1, Math.round(KITE.scanEvery / tk));
    }
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
      // If the unit did not move in the previous step, its speed decays quickly (a short brake instead of stopping abruptly).
      if (u.moving[i] === 0) u.spd[i] *= this.brakeK;
      u.moving[i] = 0;
      u.flash[i] = Math.max(0, u.flash[i] - dt);
      const t = u.target[i];
      if (t >= 0 && u.alive[t]) {
        if (isHealer(u.kind[i])) u.healers[t]++;
        else u.attackers[t]++;
      } else if (t >= 0) {
        // Target died: look for a new target after a short per-unit delay (not all in the same frame).
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
    // List of living enemy teams and the nearest enemy team (by center distance).
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
    let mask = 0;
    for (let tm = 0; tm < this.teamCount; tm++) if (n[tm] > 0) mask |= 1 << tm;
    this.aliveMask = mask;

    let tn = performance.now();
    pf.prep += tn - tp;
    tp = tn;
    // The grids are independent of each other: one per team plus the separation grid, one per chunk.
    this.runPhase(PH_GRID, this.teamCount + 1, (from, to) => {
      for (let g = from; g < to; g++) (g < this.teamCount ? this.grids[g] : this.sepGrid).build(u, g < this.teamCount ? g : -1);
    });
    this.beginPhases(dt);
    this.runPhase(PH_PICK, u.count, (from, to) => this.picker.runChunk(from, to));
    tn = performance.now();
    pf.grid += tn - tp;
    tp = tn;

    if (this.winner < 0) {
      if (this.zones.length > 0) updateZones(this, dt);
      // The order is reversed every step: so the low-index (first-spawned) team gains no permanent advantage.
      const cnt = u.count;
      const rev = (this.stepNo & 1) === 1;
      for (let k = 0; k < cnt; k++) {
        const i = rev ? cnt - 1 - k : k;
        if (u.alive[i]) this.updateUnit(i, dt);
      }
      this.runMoves(dt);
      tn = performance.now();
      pf.units += tn - tp;
      tp = tn;
      this.separate();
      if (this.terrain && this.terrain.hasRelief && (this.stepNo & 3) === 0) this.updateAdvantage();
      tn = performance.now();
      pf.separate += tn - tp;
      tp = tn;
    }

    if (this.config.mode !== 'bench') this.updateStatus();
    this.projectiles.update(dt, (x, y, team, dmg, idx) => arrowLanded(this, x, y, team, dmg, idx));
    pf.arrows += performance.now() - tp;
    pf.steps++;
    this.countAlive();
    if (this.winner < 0) {
      if (this.mode.id !== 'classic') this.mode.step(this, dt);
      // Winner: the last team with a living unit (-2: draw if all die).
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
      else if (this.mode.id === 'classic') this.checkDraw(alive);
      // Mode rules decide only while several teams are alive (the draw rules above are classic-only: a hold-the-point
      // battle may legitimately have long quiet stretches).
      if (this.winner < 0 && this.mode.id !== 'classic') {
        const w = this.mode.winner(this);
        if (w !== undefined) this.winner = w;
      }
    }
  }

  /**
   * Draw rules so a battle cannot lock up: (1) no living unit can deal damage
   * (only priests), (2) no damage for a long time (unreachable target, heal balance...).
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

  /** @internal */
  pushEvent(e: SimEvent): void {
    if (this.events.length < EVENT_CAP) this.events.push(e);
  }

  /** @internal */
  startAttack(i: number): void {
    const u = this.units;
    const s = STATS[u.kind[i]];
    u.cooldown[i] = s.cooldown;
    u.swing[i] = s.swing;
    u.hitPending[i] = 1;
  }

  /** Can unit i (not melee) hit target t from this distance (height advantage, ridges blocking fire); see battleAi.ts. */
  canShoot(i: number, t: number, dist: number): boolean {
    return canShoot(this, i, t, dist);
  }

  /** Archers/priests must not get in front of their own warrior center (also used by the stall detector); see battleAi.ts. */
  beyondLeash(i: number): boolean {
    return beyondLeash(this, i);
  }

  private updateUnit(i: number, dt: number): void {
    const u = this.units;
    const kind = u.kind[i];
    const s = STATS[kind];
    const ranged = !isMelee(kind);
    if (this.comedy) {
      if (u.airImm[i] > 0) u.airImm[i] -= dt;
      if (u.airT[i] > 0) {
        flyStep(this, i, dt);
        return;
      }
    }
    u.cooldown[i] -= dt * (u.slowT[i] > 0 || u.flags[i] !== 0 ? atkRate(this, i) : 1);
    u.retarget[i] -= dt;
    if (u.slowT[i] > 0) u.slowT[i] -= dt;
    if (u.shieldT[i] > 0) u.shieldT[i] -= dt;
    if (u.weakT[i] > 0) u.weakT[i] -= dt;
    if (u.invulnT[i] > 0) u.invulnT[i] -= dt;
    if (u.tauntT[i] > 0) u.tauntT[i] -= dt;
    if (u.stackT[i] > 0 && (u.stackT[i] -= dt) <= 0) u.stacks[i] = 0;
    if (u.burnT[i] > 0) {
      u.burnT[i] -= dt;
      damage(this, i, u.burnDps[i] * dt, -1, false, true);
      if (!u.alive[i]) return;
    }
    const skill = s.skill;
    if (skill === 'rage' && (u.flags[i] & F_RAGE) === 0 && u.hp[i] < u.maxHp[i] * sp(this, 'rage').b) {
      u.flags[i] |= F_RAGE;
      burst(this, u.x[i], u.y[i], 2, skill);
    }
    if (u.sideT[i] > 0) u.sideT[i] -= dt;
    if (u.banT[i] > 0) u.banT[i] -= dt;
    if (u.leashOffT[i] > 0) u.leashOffT[i] -= dt;
    if (u.ccImmT[i] > 0) u.ccImmT[i] -= dt;

    // A unit that is being knocked back or stunned cannot act this step.
    if (u.kbVx[i] !== 0 || u.kbVy[i] !== 0) applyKnockback(this, i, dt);
    if (u.stunT[i] > 0) {
      u.stunT[i] -= dt;
      u.swing[i] = 0;
      u.hitPending[i] = 0;
      return;
    }

    if (u.fearT[i] > 0) {
      // Fear: run away from the source, do not attack.
      u.fearT[i] -= dt;
      u.swing[i] = 0;
      u.hitPending[i] = 0;
      const fx = u.x[i] - u.fearX[i];
      const fy = u.y[i] - u.fearY[i];
      const fl = Math.sqrt(fx * fx + fy * fy) || 1;
      this.queueMove(i, u.x[i] + (fx / fl) * 6, u.y[i] + (fy / fl) * 6, s.speed * 1.15, true, false);
      return;
    }
    if (skill === 'mock' || skill === 'taunt' || skill === 'stoneWill') periodic(this, i, dt, skill);

    if (ranged && this.kiteOn) {
      updateThreat(this, i);
      if (u.kiteState[i] !== 1) u.stamina[i] = Math.min(1, u.stamina[i] + KITE.staminaRecharge * dt);
    }

    if (u.swing[i] > 0) {
      u.swing[i] -= dt;
      const t = u.target[i];
      if (t >= 0 && u.alive[t]) this.faceTo(i, u.x[t] - u.x[i], u.y[t] - u.y[i]);
      if (u.hitPending[i] && s.swing - u.swing[i] >= s.hitAt) {
        u.hitPending[i] = 0;
        resolveHit(this, i);
      }
      return;
    }

    if (u.retarget[i] <= 0) {
      const tq = performance.now();
      pickNow(this, i);
      this.prof.pick += performance.now() - tq;
      u.retarget[i] = u.target[i] < 0 ? 0.4 + this.rng() * 0.3 : 1.8 + this.rng() * 2.0;
    }

    if (ranged && this.kiteOn && tryKite(this, i, dt)) return;

    const t = u.target[i];
    if (t < 0) {
      if (isHealer(kind)) followArmy(this, i);
      else marchToEnemy(this, i, dt);
      return;
    }

    const dx = u.x[t] - u.x[i];
    const dy = u.y[t] - u.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);
    // A big (tank) target has a wider body: melee fighters can hit it from this much farther away.
    const tr = isTank(u.kind[t]) && !isTank(kind) ? TANK_REACH : 0;

    // Ranged attackers: height advantage extends the range, and a ridge in the way blocks direct fire (they must move).
    const inRange = isMelee(kind) ? dist <= s.range + MELEE_SLACK + tr : canShoot(this, i, t, dist);
    if (inRange) {
      // Entering range does not count instantly: a unit jittering at the range edge in a crowd cannot reset the counter.
      u.rangeT[i] += dt;
      if (u.rangeT[i] > 0.5) {
        u.chaseT[i] = 0;
        u.chaseBest[i] = Infinity;
      }
    } else {
      u.rangeT[i] = 0;
      if (chaseWatchdog(this, i, t, dist, dt)) return;
    }

    if (isMelee(kind)) {
      if (dist > s.range + MELEE_SLACK + tr) {
        // Runs to a per-unit angle around the target: not everyone piles onto the same point.
        const base = Math.atan2(-dy, -dx) + u.slotAngle[i];
        const reach = s.range * 0.7;
        let gx = u.x[t] + Math.cos(base) * reach;
        let gy = u.y[t] + Math.sin(base) * reach;
        // If the approach point lands in water/an obstacle or outside the map edge, head straight for the target.
        const edge = this.mapSize - 0.5;
        const outside = gx < 0.5 || gy < 0.5 || gx > edge || gy > edge;
        if (outside || (this.terrain && !this.terrain.walkable(gx, gy))) {
          gx = u.x[t];
          gy = u.y[t];
        }
        this.queueMove(i, gx, gy, s.speed);
        return;
      }
    } else if (!inRange) {
      if (isHealer(kind) && this.kiteOn) {
        // Approach the patient from behind: stay away from the enemy.
        const en = this.nearestEnemy[u.team[i]];
        if (en >= 0) {
          let ax = u.x[t] - this.centroidX[en];
          let ay = u.y[t] - this.centroidY[en];
          const len = Math.sqrt(ax * ax + ay * ay) || 1;
          ax /= len;
          ay /= len;
          this.queueMove(i, u.x[t] + ax * 3, u.y[t] + ay * 3, s.speed);
        } else {
          this.queueMove(i, u.x[t], u.y[t], s.speed);
        }
      } else if (leashHold(this, i, dt)) {
        this.faceTo(i, dx, dy);
      } else {
        this.queueMove(i, u.x[t], u.y[t], s.speed);
      }
      return;
    }

    this.faceTo(i, dx, dy);
    if (u.cooldown[i] <= 0) this.startAttack(i);
  }

  /** Display data for the renderer: height advantage of every unit over its current target (half steps). */
  private updateAdvantage(): void {
    const u = this.units;
    const tr = this.terrain!;
    for (let i = 0; i < u.count; i++) {
      const t = u.target[i];
      if (!u.alive[i] || t < 0 || !u.alive[t]) {
        u.hgAdv[i] = 0;
        continue;
      }
      const dh = tr.heightAt(u.x[i], u.y[i]) - tr.heightAt(u.x[t], u.y[t]);
      u.hgAdv[i] = Math.max(-127, Math.min(127, Math.round(dh * 2)));
    }
  }

  /** Publishes this step's inputs to the parallel kernels (and the helper threads). */
  private beginPhases(dt: number): void {
    const sep = this.separator;
    sep.phase = this.sepTick % SEP_STRIDE;
    sep.gain = SEP_GAIN * this.tk;
    sep.maxStep = SEP_MAX_STEP * this.tk;
    sep.decay = this.sepDecayK;
    const picker = this.picker;
    picker.step = this.stepNo;
    picker.dt = dt;
    picker.aliveMask = this.aliveMask;
    picker.prepare();
    this.pool?.setStep({ dt, step: this.stepNo, losEvery: this.losEvery, brakeK: this.brakeK, aliveMask: this.aliveMask, sepPhase: sep.phase, gain: sep.gain, maxStep: sep.maxStep, decay: sep.decay });
  }

  /** Runs one parallel phase over all units: on the helper threads when there are any, otherwise chunk by chunk right here. */
  private runPhase(phase: number, count: number, fn: (from: number, to: number, chunk: number) => void): void {
    const t0 = performance.now();
    this.runPhaseNow(phase, count, fn);
    this.phaseMs[phase] += performance.now() - t0;
  }

  /** Diagnostics: accumulated milliseconds per parallel phase (PH_*), see the benchmark. */
  readonly phaseMs = [0, 0, 0, 0, 0];

  private runPhaseNow(phase: number, count: number, fn: (from: number, to: number, chunk: number) => void): void {
    if (this.pool) {
      this.pool.run(phase, count, this.units.count, fn);
      return;
    }
    const size = phaseChunk(phase, count);
    const chunks = Math.ceil(count / size);
    // Test hook: the order in which chunks are executed must not change the result (helper threads take them in any order).
    const order = this.chunkOrder ? this.chunkOrder(chunks) : null;
    for (let k = 0; k < chunks; k++) {
      const c = order ? order[k] : k;
      fn(c * size, Math.min(count, (c + 1) * size), c);
    }
  }

  // ===================================================================
  // Skill state (the skill code lives in battleEffects/battleDamage/battleSkills.ts)
  // ===================================================================

  /** @internal */
  readonly skillCache: Partial<Record<SkillId, SkillParams>> = {};
  /** @internal */
  readonly zones: Zone[] = [];
  /** Hex Poppets -> linked enemies; Bone Caller -> bone soldier pool. @internal */
  readonly links = new Map<number, number[]>();
  /** @internal */
  readonly pools = new Map<number, number[]>();
  /** @internal */
  readonly scratch: number[] = [];
  /** @internal */
  readonly scratch2: number[] = [];

  // ===================================================================
  // Online: state snapshot (resync / spectator / reconnect) and checksum
  // ===================================================================

  /** Seconds per step of this battle (what the drivers pass to step()). */
  get dt(): number {
    return simDtFor(this.config);
  }

  /** Number of sim steps taken (lockstep time axis). */
  get stepCount(): number {
    return this.stepNo;
  }

  /** Copies the whole persistent state of the sim (can be restored into another Battle with the same config). */
  serialize(): BattleSnapshot {
    const u = this.units;
    return {
      v: 1,
      scalars: {
        count: u.count,
        pcount: this.projectiles.count,
        pcursor: this.projectiles.cursor,
        rng: this.rngObj.a,
        time: this.time,
        winner: this.winner,
        stepNo: this.stepNo,
        sepTick: this.sepTick,
        lastDeathTime: this.lastDeathTime,
        lastDamageSeen: this.lastDamageSeen,
        lastDamageT: this.lastDamageT,
        noDamagerSince: this.noDamagerSince,
        damage: this.counters.damage,
        heal: this.counters.heal,
        kills: this.counters.kills,
        ...Object.fromEntries(Object.entries(this.dbg)),
      },
      units: copyTyped(u, u.count),
      projectiles: copyTyped(this.projectiles, this.projectiles.cap),
      extra: {
        zones: this.zones.map((z) => ({ ...z })),
        links: [...this.links.entries()].map(([k, v]) => [k, v.slice()]),
        pools: [...this.pools.entries()].map(([k, v]) => [k, v.slice()]),
        meter: { dmg: Array.from(this.meter.dmg), kills: Array.from(this.meter.kills) },
        ...(this.mode.id === 'classic' ? {} : { mode: { id: this.mode.id, state: this.mode.serialize(), goals: Array.from(this.teamGoalX).concat(Array.from(this.teamGoalY), Array.from(this.teamHasGoal)) } }),
      },
    };
  }

  /** Loads the serialize() output into this Battle (same config and capacity are assumed). */
  restore(s: BattleSnapshot): void {
    const u = this.units;
    const sc = s.scalars;
    u.count = sc.count;
    pasteTyped(u, s.units);
    pasteTyped(this.projectiles, s.projectiles);
    this.projectiles.count = sc.pcount;
    this.projectiles.cursor = sc.pcursor;
    this.rngObj.a = sc.rng >>> 0;
    this.time = sc.time;
    this.winner = sc.winner;
    this.stepNo = sc.stepNo;
    this.sepTick = sc.sepTick;
    this.lastDeathTime = sc.lastDeathTime;
    this.lastDamageSeen = sc.lastDamageSeen;
    this.lastDamageT = sc.lastDamageT;
    this.noDamagerSince = sc.noDamagerSince;
    this.counters.damage = sc.damage;
    this.counters.heal = sc.heal;
    this.counters.kills = sc.kills;
    this.meter.dmg.fill(0);
    this.meter.kills.fill(0);
    if (s.extra.meter) {
      this.meter.dmg.set(s.extra.meter.dmg.slice(0, this.meter.dmg.length));
      this.meter.kills.set(s.extra.meter.kills.slice(0, this.meter.kills.length));
    }
    this.teamGoalX.fill(0);
    this.teamGoalY.fill(0);
    this.teamHasGoal.fill(0);
    if (s.extra.mode && s.extra.mode.id === this.mode.id) {
      this.mode.restore(s.extra.mode.state);
      const g = s.extra.mode.goals;
      for (let t = 0; t < MAX_TEAMS; t++) {
        this.teamGoalX[t] = g[t] ?? 0;
        this.teamGoalY[t] = g[MAX_TEAMS + t] ?? 0;
        this.teamHasGoal[t] = g[2 * MAX_TEAMS + t] ?? 0;
      }
    }
    for (const k of Object.keys(this.dbg)) (this.dbg as Record<string, number>)[k] = sc[k] ?? 0;
    this.zones.length = 0;
    for (const z of s.extra.zones) this.zones.push({ ...(z as Zone) });
    this.links.clear();
    for (const [k, v] of s.extra.links) this.links.set(k, v.slice());
    this.pools.clear();
    for (const [k, v] of s.extra.pools) this.pools.set(k, v.slice());
    this.events.length = 0;
    this.countAlive();
  }

  /** State checksum (FNV-1a): position, HP, alive flag, target, rng and the step counter. */
  hash(): number {
    const u = this.units;
    const n = u.count;
    let h = 2166136261;
    // Everything that shapes the future of a unit: position, health, timers, motion and crowd-control state. A client that
    // diverges in any of these is caught at the next checkpoint instead of drifting silently.
    for (const arr of [u.x, u.y, u.hp, u.cooldown, u.stunT, u.lift, u.swing, u.retarget, u.kbVx, u.kbVy, u.spd, u.hx, u.hy, u.slowT, u.burnT, u.shieldT, u.fearT, u.weakT, u.invulnT, u.tauntT] as Typed[]) h = fnv(h, arr, n, 4);
    for (const arr of [u.alive, u.team, u.kind, u.stacks] as Typed[]) h = fnv(h, arr, n, 1);
    h = fnv(h, u.target, n, 4);
    if (this.mode.id !== 'classic') {
      // Mode state and goals join the checksum (classic battles keep their old hash byte for byte).
      const st = Float64Array.from(this.mode.serialize());
      h = fnv(h, st, st.length, 8);
      h = fnv(h, this.teamGoalX, MAX_TEAMS, 4);
      h = fnv(h, this.teamGoalY, MAX_TEAMS, 4);
      h = fnv(h, this.teamHasGoal, MAX_TEAMS, 1);
    }
    h ^= this.rngObj.a;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= this.stepNo;
    h = Math.imul(h, 16777619) >>> 0;
    return h;
  }

  /** Writes the visual status mask (the renderer tints with it). */
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

  /**
   * Queues a move of unit i toward (gx, gy) for the movement phase at the end of the step (see `runMoves`): units decide
   * first, then every unit moves, so a decision never depends on the order in which units are processed.
   * @internal
   */
  queueMove(i: number, gx: number, gy: number, speed: number, faceMove = true, useRoute = true): void {
    const u = this.units;
    u.mvGx[i] = gx;
    u.mvGy[i] = gy;
    u.mvSpeed[i] = speed;
    u.mvFlags[i] = MV_INTENT | (faceMove ? MV_FACE : 0) | (useRoute ? MV_ROUTE : 0);
  }

  /** Movement phase: executes all queued moves (chunk by chunk) and applies what they found out about other units. */
  private runMoves(dt: number): void {
    const u = this.units;
    const n = u.count;
    const mover = this.mover;
    mover.stepNo = this.stepNo;
    mover.brakeK = this.brakeK;
    mover.losEvery = this.losEvery;
    mover.chunks = Math.ceil(n / phaseChunk(PH_MOVE, n));
    this.runPhase(PH_MOVE, n, (from, to, k) => mover.runChunk(from, to, dt, k));
    const c = mover.counts;
    this.dbg.stuck += c[CNT_STUCK];
    this.dbg.paths += c[CNT_PATHS];
    this.dbg.pathFails += c[CNT_PATH_FAILS];
    c.fill(0);
    // A target that cannot be reached is banned for its pursuer (in unit order: deterministic).
    for (let i = 0; i < n; i++) {
      if (!u.mvFail[i]) continue;
      u.mvFail[i] = 0;
      const tg = u.target[i];
      if (tg < 0) continue;
      u.banTarget[i] = tg;
      u.banT[i] = BAN_TIME;
      if (isHealer(u.kind[i])) {
        if (u.healers[tg] > 0) u.healers[tg]--;
      } else if (u.attackers[tg] > 0) u.attackers[tg]--;
      u.target[i] = -1;
      u.retarget[i] = 0;
    }
  }

  /** @internal */
  faceTo(i: number, dx: number, dy: number): void {
    const sx = dx - dy; // screen x direction
    if (Math.abs(sx) > 0.05) this.units.facing[i] = sx >= 0 ? 1 : -1;
  }

  /** Soft separation of crowded units (two parallel phases, see `Separator`), then the tanks' push. */
  private separate(): void {
    const n = this.units.count;
    const sep = this.separator;
    this.sepTick++;
    this.runPhase(PH_SEP_SCAN, n, (from, to) => sep.scan(from, to));
    this.runPhase(PH_SEP_APPLY, n, (from, to) => sep.apply(from, to));
    this.pushAroundTanks((ox, oy, x, y) => sep.bad(ox, oy, x, y));
  }

  /** Tanks (2x size) clearly push nearby units. */
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
        // A tank pushes only ENEMY units: if it pushed friendly units, the same team would lock itself up.
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

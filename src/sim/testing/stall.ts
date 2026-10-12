import { Battle } from '../battle';
import type { Terrain } from '../terrain';
import { Kind, STATS, isMelee } from '../units';
import type { Scenario } from './scenarios';

export type FlagType = 'idleChaser' | 'cannotHit' | 'oscillation' | 'noProgress' | 'noDamagePossible' | 'unreachable' | 'invariant' | 'timeout';

export interface Flag {
  type: FlagType;
  /** Sim saniyesi. */
  t: number;
  unit?: number;
  info: string;
}

const SIM_DT = 1 / 30;

/** Yurunebilir karolari bagli bilesenlere boler (8 komsuluk, kose kesme yok). -1: yurunemez. */
export function computeRegions(terrain: Terrain): Int32Array {
  const n = terrain.size;
  const region = new Int32Array(n * n).fill(-1);
  let id = 0;
  const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && terrain.walkable(x + 0.5, y + 0.5);
  const stack: number[] = [];
  for (let sy = 0; sy < n; sy++) {
    for (let sx = 0; sx < n; sx++) {
      if (region[sy * n + sx] !== -1 || !walk(sx, sy)) continue;
      region[sy * n + sx] = id;
      stack.push(sx, sy);
      while (stack.length) {
        const y = stack.pop()!;
        const x = stack.pop()!;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (!walk(nx, ny) || region[ny * n + nx] !== -1) continue;
            if (dx && dy && !(walk(x + dx, y) && walk(x, y + dy))) continue;
            region[ny * n + nx] = id;
            stack.push(nx, ny);
          }
        }
      }
      id++;
    }
  }
  return region;
}

/**
 * Savasi her adimda izler ve "askerler savasmayi birakti / vuramayacaklari donguye girdi"
 * durumlarini siniflandirir. Testlerde ve (ileride) ?debug katmaninda kullanilir.
 */
export class StallDetector {
  readonly flags: Flag[] = [];
  private readonly lastX: Float32Array;
  private readonly lastY: Float32Array;
  private readonly idleSec: Uint8Array;
  private readonly cantHit: Uint16Array;
  private readonly lastTarget: Int32Array;
  private readonly switches: number[][];
  private readonly flaggedAt: Map<string, number> = new Map();
  private step = 0;
  private lastProgressT = 0;
  private lastDamage = 0;
  private noDamageSince = -1;
  private readonly region: Int32Array | null;

  constructor(private readonly b: Battle) {
    const n = b.units.count;
    this.lastX = new Float32Array(n);
    this.lastY = new Float32Array(n);
    this.idleSec = new Uint8Array(n);
    this.cantHit = new Uint16Array(n);
    this.lastTarget = new Int32Array(n).fill(-1);
    this.switches = Array.from({ length: n }, () => []);
    this.region = b.terrain ? computeRegions(b.terrain) : null;
    for (let i = 0; i < n; i++) {
      this.lastX[i] = b.units.x[i];
      this.lastY[i] = b.units.y[i];
    }
  }

  private flag(type: FlagType, unit: number | undefined, info: string, cooldownSec = 20): void {
    const key = `${type}:${unit ?? -1}`;
    const last = this.flaggedAt.get(key);
    if (last !== undefined && this.b.time - last < cooldownSec) return;
    this.flaggedAt.set(key, this.b.time);
    this.flags.push({ type, t: +this.b.time.toFixed(1), unit, info });
  }

  private describe(i: number): string {
    const u = this.b.units;
    return `#${i} ${STATS[u.kind[i]].name} takim${u.team[i] + 1} @${u.x[i].toFixed(1)},${u.y[i].toFixed(1)} hedef=${u.target[i]}`;
  }

  /** Bosta kalmanin olasi nedenleri: leash, rota, kite, sikisma. */
  private reasons(i: number): string {
    const u = this.b.units;
    const leash = (this.b as unknown as { beyondLeash(i: number): boolean }).beyondLeash(i);
    const crowd = this.nearbyFriends(i);
    return `[leash=${leash ? 1 : 0} rota=${u.route[i]} kite=${u.kiteState[i]} yanAdim=${u.sideT[i] > 0 ? 1 : 0} komsu=${crowd}]`;
  }

  private nearbyFriends(i: number): number {
    const u = this.b.units;
    let n = 0;
    for (let j = 0; j < u.count; j++) {
      if (j === i || !u.alive[j]) continue;
      if ((u.x[j] - u.x[i]) ** 2 + (u.y[j] - u.y[i]) ** 2 < 1.4) n++;
    }
    return n;
  }

  /** Her b.step()'ten sonra cagir. */
  observe(): void {
    const b = this.b;
    const u = b.units;
    this.step++;
    const aliveTeams = b.alivePerTeam.filter((n) => n > 0).length;

    // --- hedef degisimi (salinim) ---
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) continue;
      const t = u.target[i];
      if (t !== this.lastTarget[i]) {
        if (t >= 0 && this.lastTarget[i] >= 0) {
          const arr = this.switches[i];
          arr.push(b.time);
          while (arr.length && b.time - arr[0] > 6) arr.shift();
          if (arr.length >= 6) this.flag('oscillation', i, `${this.describe(i)} 6 sn'de ${arr.length} kez hedef degistirdi`, 30);
        }
        this.lastTarget[i] = t;
      }

      // --- vuramayan: menzilde, hazir, ama saldirmiyor ---
      const tt = u.target[i];
      if (tt >= 0 && u.alive[tt] && u.kiteState[i] !== 1 && u.stunT[i] <= 0 && u.fearT[i] <= 0 && u.swing[i] <= 0) {
        const dx = u.x[tt] - u.x[i];
        const dy = u.y[tt] - u.y[i];
        const dist = Math.sqrt(dx * dx + dy * dy);
        const s = STATS[u.kind[i]];
        const reach = isMelee(u.kind[i]) ? s.range : s.range * 0.95;
        const hurtOk = u.kind[i] !== Kind.Priest || u.hp[tt] < u.maxHp[tt];
        if (dist <= reach && u.cooldown[i] <= 0 && hurtOk) {
          if (++this.cantHit[i] >= 60) this.flag('cannotHit', i, `${this.describe(i)} menzilde ve hazir ama 2 sn'dir saldirmiyor (mesafe ${dist.toFixed(2)})`);
        } else this.cantHit[i] = 0;
      } else this.cantHit[i] = 0;
    }

    // --- saniyede bir: bosta kovalayici + ulasilamaz hedef ---
    if (this.step % 30 === 0) {
      for (let i = 0; i < u.count; i++) {
        if (!u.alive[i]) continue;
        const moved = Math.hypot(u.x[i] - this.lastX[i], u.y[i] - this.lastY[i]);
        this.lastX[i] = u.x[i];
        this.lastY[i] = u.y[i];
        const t = u.target[i];
        // holdT > 0: leash yuzunden kasitli bekleme (en fazla LEASH_HOLD_MAX sn), hata degil.
        if (t >= 0 && u.alive[t] && u.kiteState[i] !== 1 && u.stunT[i] <= 0 && u.fearT[i] <= 0 && u.swing[i] <= 0 && u.holdT[i] <= 0) {
          const dist = Math.hypot(u.x[t] - u.x[i], u.y[t] - u.y[i]);
          const s = STATS[u.kind[i]];
          const reach = isMelee(u.kind[i]) ? s.range + 0.6 : s.range;
          if (dist > reach && moved < 0.25) {
            // Ilerleme bekcisi 6 sn'de hedefi birakir: 8 sn'yi asan bekleme gercek takilmadir.
            // Yalniz yakininda dost olmayan (izole) birimler: kalabalik baskisi gercek takilma degildir.
            if (++this.idleSec[i] >= 8 && this.nearbyFriends(i) === 0) this.flag('idleChaser', i, `${this.describe(i)} hedefe ${dist.toFixed(1)} tile uzakta ${this.idleSec[i]} sn'dir yerinde ${this.reasons(i)}`);
          } else this.idleSec[i] = 0;
          if (this.region) {
            const n = b.terrain!.size;
            const ri = this.region[(Math.floor(u.y[i]) * n + Math.floor(u.x[i])) | 0];
            const rt = this.region[(Math.floor(u.y[t]) * n + Math.floor(u.x[t])) | 0];
            if (ri !== rt && ri !== -1 && rt !== -1 && dist > reach) this.flag('unreachable', i, `${this.describe(i)} hedefi farkli bolgede (${ri} -> ${rt})`, 60);
          }
        } else this.idleSec[i] = 0;
      }
    }

    // --- takim ilerlemesizligi ---
    const dmg = b.counters.damage;
    if (dmg - this.lastDamage > 0.01 || aliveTeams < 2) {
      this.lastProgressT = b.time;
      this.lastDamage = dmg;
    }
    let canDamage = false;
    for (let i = 0; i < u.count; i++) {
      if (u.alive[i] && u.kind[i] !== Kind.Priest) {
        canDamage = true;
        break;
      }
    }
    if (aliveTeams >= 2 && !canDamage) {
      if (this.noDamageSince < 0) this.noDamageSince = b.time;
      if (b.time - this.noDamageSince > 5) this.flag('noDamagePossible', undefined, `Kimse hasar veremiyor ama ${aliveTeams} takim canli`, 60);
    } else this.noDamageSince = -1;
    // Ilk temas oncesi yaklasma suresi (buyuk harita, yavas birim) bayrak sayilmaz.
    // Sim 90/150 sn'de beraberlik ilan eder; bayrak yalniz bu kural isleyemezse atilir.
    const grace = b.counters.damage > 0 ? 100 : 160;
    if (aliveTeams >= 2 && canDamage && b.time - this.lastProgressT > grace) {
      this.flag('noProgress', undefined, `25 sn'dir hic hasar yok (${aliveTeams} takim canli, alive=${b.alivePerTeam.slice(0, 6).join('/')})`, 25);
    }
  }
}

/** Her an gecerli olmasi gereken degismezler. */
export function checkInvariants(b: Battle): string[] {
  const errs: string[] = [];
  const u = b.units;
  const t = b.terrain;
  const n = b.mapSize;
  for (let i = 0; i < u.count; i++) {
    if (!u.alive[i]) continue;
    const x = u.x[i];
    const y = u.y[i];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(u.hp[i])) {
      errs.push(`birim ${i} NaN/Infinity`);
      continue;
    }
    if (x < 0 || y < 0 || x > n || y > n) errs.push(`birim ${i} harita disinda (${x.toFixed(2)},${y.toFixed(2)})`);
    if (t && !t.walkable(x, y)) errs.push(`birim ${i} (${STATS[u.kind[i]].name}) yurunemez karoda (${x.toFixed(2)},${y.toFixed(2)})`);
    if (u.attackers[i] === 255) errs.push(`birim ${i} attackers sayaci 255 (tasma suphesi)`);
    if (u.hp[i] > u.maxHp[i] + 1e-3) errs.push(`birim ${i} can maxHp'yi asti`);
  }
  return errs;
}

export interface RunResult {
  scenario: Scenario;
  winner: number;
  secs: number;
  flags: Flag[];
  invariants: string[];
  counters: { damage: number; heal: number; kills: number };
  alive: number[];
  initialUnits: number;
  /** Determinizm kontrolu icin sonuc imzasi. */
  signature: string;
}

export function runScenario(sc: Scenario, maxSeconds = 300, detect = true): RunResult {
  const b = new Battle(sc.simSeed, sc.config);
  const det = detect ? new StallDetector(b) : null;
  const initial = b.units.count;
  const invariants: string[] = [];
  const maxSteps = Math.floor(maxSeconds / SIM_DT);
  let steps = 0;
  while (steps < maxSteps && b.winner === -1) {
    b.step(SIM_DT);
    steps++;
    det?.observe();
    if (steps % 15 === 0 && invariants.length < 5) invariants.push(...checkInvariants(b).slice(0, 2));
  }
  const flags = det ? [...det.flags] : [];
  // Yavas ama ilerleyen savas (son 60 sn icinde olum var) zaman asimi sayilmaz.
  const staleSecs = b.time - (b as unknown as { lastDeathTime: number }).lastDeathTime;
  if (b.winner === -1 && staleSecs > 60) {
    const names = ['Sav', 'Okc', 'Rah', 'Kal', 'Cek'];
    const comp: string[] = [];
    for (let tm = 0; tm < sc.config.teamCount!; tm++) {
      const c = [0, 0, 0, 0, 0];
      for (let i = 0; i < b.units.count; i++) if (b.units.alive[i] && b.units.team[i] === tm) c[b.units.kind[i]]++;
      if (c.some((v) => v)) comp.push(`T${tm + 1}:` + c.map((v, k) => (v ? `${names[k]}${v}` : '')).join(''));
    }
    flags.push({ type: 'timeout', t: +b.time.toFixed(1), info: `${maxSeconds} sn'de sonuc yok, kalan ${comp.join(' ')} sonHasar=${(b.time - (b as unknown as { lastDeathTime: number }).lastDeathTime).toFixed(0)}sn once olum` });
  }
  for (const e of invariants) flags.push({ type: 'invariant', t: +b.time.toFixed(1), info: e });
  let sig = '';
  for (let i = 0; i < b.units.count; i += Math.max(1, Math.floor(b.units.count / 20))) sig += `${b.units.x[i].toFixed(2)},${b.units.hp[i].toFixed(0)};`;
  return {
    scenario: sc,
    winner: b.winner,
    secs: +b.time.toFixed(1),
    flags,
    invariants,
    counters: { ...b.counters },
    alive: b.alivePerTeam.slice(0, 6),
    initialUnits: initial,
    signature: `${b.winner}|${steps}|${sig}`,
  };
}

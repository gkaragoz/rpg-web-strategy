import { SIM_DT } from '../sim/constants';
import { packSnapshot, unpackSnapshot, type BattleSnapshot } from '../sim/snapshot';
import { CHECK_EVERY, type HostLobby } from './host';
import type { OnlineModel } from './client';
import { b64decode, b64encode, type ClientMsg } from './protocol';

/** Lockstep'in ihtiyac duydugu sim yuzeyi (Battle bunu saglar; worker sarmalayicisi da saglayabilir). */
export interface SimLike {
  step(dt: number): void;
  readonly stepCount: number;
  hash(): number;
  serialize(): BattleSnapshot;
  restore(s: BattleSnapshot): void;
  readonly winner: number;
  readonly alivePerTeam: number[];
}

const MAX_STEPS_PER_FRAME = 8;
/** Host adimiyla yerel adim farki bu kadar buyurse yetisme/bekleme devreye girer. */
const LAG_TOLERANCE = 3;
/** Host adim bilgisini yayinlama araligi (adim). */
const TICK_EVERY = 15;

/**
 * Deterministik savasin zaman ilerletici: host kendi hizinda kosar ve adim/hiz/duraklatma bilgisini yayar;
 * misafir host'un adimina yetisir/bekler, kontrol noktalarinda hash gonderir, sapma olursa durum goruntusunu yukler.
 */
export class LockstepRunner {
  private acc = 0;
  private finished = false;
  private tickAt = 0;
  /** Host: yerel hiz/duraklat (hiz dugmeleri). Misafirde model'den okunur. */
  speed = 1;
  paused = false;
  /** Teshis: son yeniden senkron sayisi. */
  resyncs = 0;

  constructor(
    readonly sim: SimLike,
    private readonly model: OnlineModel,
    private readonly opts: { host?: HostLobby; send?: (m: ClientMsg) => void; now?: () => number },
  ) {
    if (opts.host) {
      opts.host.simProvider = {
        snapshot: () => ({ step: sim.stepCount, data: b64encode(packSnapshot(sim.serialize())) }),
      };
    }
  }

  private now(): number {
    return (this.opts.now ?? (() => Date.now()))();
  }

  /** Bir cizim karesinde cagrilir (dt saniye); calistirilan sim adimi sayisini dondurur. */
  advance(dt: number): number {
    const host = this.opts.host;
    // Misafir: bekleyen yeniden senkron.
    const rs = this.model.pendingResync;
    if (!host && rs) {
      this.model.pendingResync = null;
      this.sim.restore(unpackSnapshot(b64decode(rs.data)));
      this.resyncs++;
      this.acc = 0;
    }
    const speed = host ? this.speed : this.model.speed;
    const paused = host ? this.paused : this.model.paused;
    if (paused) return 0;
    this.acc += Math.min(dt, 0.1) * speed;
    let n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.acc / SIM_DT));
    this.acc -= Math.floor(this.acc / SIM_DT) * SIM_DT;
    if (!host && this.model.hostStep >= 0) {
      // Host adim tahmini: son tick + gecen sure.
      const est = this.model.hostStep + Math.round(((this.now() - this.model.hostStepAt) / 1000) * 30 * speed);
      const lag = est - this.sim.stepCount;
      if (lag > LAG_TOLERANCE) n = Math.min(MAX_STEPS_PER_FRAME, Math.max(n, lag - 1));
      else if (lag < -LAG_TOLERANCE) n = 0;
    }
    let ran = 0;
    for (let i = 0; i < n && this.sim.winner === -1; i++) {
      this.sim.step(SIM_DT);
      ran++;
      const step = this.sim.stepCount;
      if (step % CHECK_EVERY === 0) {
        if (host) host.recordHash(step, this.sim.hash());
        else this.opts.send?.({ t: 'check', step, hash: this.sim.hash() });
      }
    }
    if (host) {
      const t = this.now();
      if (t - this.tickAt >= 250 || this.sim.stepCount % TICK_EVERY === 0) {
        this.tickAt = t;
        host.broadcastTick(this.sim.stepCount, this.speed, this.paused);
      }
      if (this.sim.winner !== -1 && !this.finished) {
        this.finished = true;
        host.finish(this.sim.winner, this.sim.alivePerTeam.slice(0, 6));
      }
    }
    return ran;
  }
}

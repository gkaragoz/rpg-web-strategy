import { HostLobby } from './host';
import {
  PROTOCOL,
  passHash,
  type BattleStart,
  type ClientMsg,
  type LobbyState,
  type PlacedItem,
  type RejectReason,
  type ServerMsg,
} from './protocol';
import type { Transport } from './transport';

export interface PresenceInfo {
  id: string;
  x: number;
  y: number;
  ctx: 'world' | 'page';
  act?: string;
  /** Son guncelleme zamani (performans.now degil, yerel Date.now) */
  at: number;
}

export interface ChatLine {
  id: string;
  name: string;
  text: string;
  ts: number;
}

/** Arayuzun okudugu ortak model: lobi durumu, birimler, imecler, sohbet, savas baslangici, sonuc. */
export class OnlineModel {
  state: LobbyState | null = null;
  you = '';
  token = '';
  start: BattleStart | null = null;
  /** Yerlestirme asamasi birimleri (id -> birim): acik yerlestirmede herkesin, degilse yalniz benimki. */
  placed = new Map<number, PlacedItem>();
  presence = new Map<string, PresenceInfo>();
  chat: ChatLine[] = [];
  result: { winner: number; alive: number[] } | null = null;
  /** Host'tan gelen son hiz/duraklat bilgisi. */
  speed = 1;
  paused = false;
  hostStep = -1;
  /** hostStep'in alindigi yerel zaman (ms): adim tahmini icin. */
  hostStepAt = 0;
  closedReason: string | null = null;
  rejected: RejectReason | null = null;
  lastFail: { cids: number[]; reason: string } | null = null;
  pendingResync: { step: number; data: string } | null = null;
  /** Arayuz aboneligi: her sunucu mesajindan sonra cagrilir. */
  listeners: Array<(msg: ServerMsg) => void> = [];

  get me() {
    return this.state?.players.find((p) => p.id === this.you) ?? null;
  }
  get isHost(): boolean {
    return !!this.state && this.state.hostId === this.you;
  }

  apply(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.you = msg.you;
        this.token = msg.token;
        this.state = msg.state;
        if (msg.start) this.start = msg.start;
        break;
      case 'state':
        if (this.state && msg.state.phase !== this.state.phase) {
          if (msg.state.phase === 'lobby') {
            this.placed.clear();
            this.start = null;
            this.result = null;
            this.pendingResync = null;
          }
          if (msg.state.phase === 'placing') {
            this.placed.clear();
            this.result = null;
          }
        }
        this.state = msg.state;
        break;
      case 'placed':
        for (const it of msg.items) this.placed.set(it.id, it);
        break;
      case 'unplaced':
        for (const id of msg.ids) this.placed.delete(id);
        break;
      case 'placeFail':
        this.lastFail = { cids: msg.cids, reason: msg.reason };
        break;
      case 'chat':
        this.chat.push({ id: msg.id, name: msg.name, text: msg.text, ts: msg.ts });
        if (this.chat.length > 200) this.chat.shift();
        break;
      case 'presence':
        this.presence.set(msg.id, { id: msg.id, x: msg.x, y: msg.y, ctx: msg.ctx, act: msg.act, at: Date.now() });
        break;
      case 'start':
        this.start = msg.start;
        break;
      case 'tick':
        if (msg.step >= 0) {
          this.hostStep = msg.step;
          this.hostStepAt = Date.now();
        }
        this.speed = msg.speed;
        this.paused = msg.paused;
        break;
      case 'resync':
        this.pendingResync = { step: msg.step, data: msg.data };
        break;
      case 'result':
        this.result = { winner: msg.winner, alive: msg.alive };
        break;
      case 'reject':
        this.rejected = msg.reason;
        break;
      case 'kicked':
        this.closedReason = msg.reason;
        break;
      case 'closed':
        this.closedReason = 'Lobi kapandi';
        break;
    }
    // Ayrilan oyuncularin imleci silinir.
    if (msg.t === 'state' || msg.t === 'welcome') {
      const ids = new Set(msg.state.players.map((p) => p.id));
      for (const id of [...this.presence.keys()]) if (!ids.has(id)) this.presence.delete(id);
    }
    for (const l of this.listeners) l(msg);
  }
}

/** Arayuzun konustugu ortak oturum: host ya da misafir ayni API. */
export interface Session {
  readonly model: OnlineModel;
  readonly isHost: boolean;
  send(msg: ClientMsg): void;
  leave(): void;
}

export class HostSession implements Session {
  readonly model = new OnlineModel();
  readonly isHost = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly lobby: HostLobby,
    autoTick = true,
  ) {
    this.model.you = lobby.hostId;
    lobby.onEvent = (m) => this.model.apply(m);
    this.model.apply({ t: 'welcome', you: lobby.hostId, token: 'host', state: lobby.state() });
    if (autoTick) this.timer = setInterval(() => lobby.tick(), 100);
  }

  send(msg: ClientMsg): void {
    this.lobby.local(msg);
  }

  leave(): void {
    if (this.timer) clearInterval(this.timer);
    this.lobby.close();
  }
}

export interface JoinOptions {
  name: string;
  color: number;
  /** Parola (duz metin; ozeti gonderilir). */
  pass?: string;
  spectator?: boolean;
  token?: string;
}

export class GuestSession implements Session {
  readonly model = new OnlineModel();
  readonly isHost = false;

  constructor(
    private readonly tp: Transport,
    opts: JoinOptions,
  ) {
    tp.onMessage = (_from, msg) => this.model.apply(msg as ServerMsg);
    tp.onClose = (reason) => {
      this.model.closedReason = this.model.closedReason ?? reason;
      this.model.apply({ t: 'closed' });
    };
    this.send({ t: 'join', name: opts.name, color: opts.color, pass: opts.pass ? passHash(opts.pass) : undefined, spectator: opts.spectator, version: PROTOCOL, token: opts.token });
  }

  send(msg: ClientMsg): void {
    this.tp.send('host', msg);
  }

  leave(): void {
    this.send({ t: 'leave' });
    this.tp.close();
  }
}

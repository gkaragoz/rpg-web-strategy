import { HostLobby } from './host';
import {
  PROTOCOL,
  passHash,
  type BattleStart,
  type ClientMsg,
  type CloseReason,
  type LobbyState,
  type PlaceFailReason,
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
  /** Time of the last update (local Date.now, not performance.now) */
  at: number;
}

export interface ChatLine {
  /** Increasing sequence number so consumers keep tracking correctly when the list scrolls (200 cap). */
  n: number;
  id: string;
  name: string;
  text: string;
  ts: number;
}

/** Shared model read by the UI: lobby state, units, cursors, chat, battle start, result. */
export class OnlineModel {
  state: LobbyState | null = null;
  you = '';
  token = '';
  start: BattleStart | null = null;
  /** Placement-phase units (id -> unit): everyone's with open placement, otherwise only mine. */
  placed = new Map<number, PlacedItem>();
  presence = new Map<string, PresenceInfo>();
  chat: ChatLine[] = [];
  private chatN = 0;
  result: { winner: number; alive: number[]; scores?: number[] } | null = null;
  /** Comedy look chosen by the host during the battle (null: still the lobby value). */
  comedyVisual: boolean | null = null;
  /** Latest speed/pause info from the host. */
  speed = 1;
  paused = false;
  hostStep = -1;
  /** Local time (ms) at which hostStep was received: used for step estimation. */
  hostStepAt = 0;
  /** Stable code of why the session ended (the UI translates it as `online.reason.<code>`). */
  closedReason: CloseReason | null = null;
  rejected: RejectReason | null = null;
  lastFail: { cids: number[]; reason: PlaceFailReason } | null = null;
  pendingResync: { step: number; data: string } | null = null;
  /** UI subscription: called after every server message. */
  listeners: Array<(msg: ServerMsg) => void> = [];

  get me() {
    return this.state?.players.find((p) => p.id === this.you) ?? null;
  }
  get isHost(): boolean {
    return !!this.state && this.state.hostId === this.you;
  }

  /** Forgets the host's step/speed/pause info of the previous battle. */
  private resetClock(): void {
    this.hostStep = -1;
    this.hostStepAt = 0;
    this.speed = 1;
    this.paused = false;
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
            // Leftovers of the battle that just ended must not leak into the next one (a late resync of the old battle
            // would be restored into the new sim; stale host step/speed would make the new battle fast-forward).
            this.start = null;
            this.pendingResync = null;
            this.resetClock();
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
        this.chat.push({ n: ++this.chatN, id: msg.id, name: msg.name, text: msg.text, ts: msg.ts });
        if (this.chat.length > 200) this.chat.shift();
        break;
      case 'presence':
        this.presence.set(msg.id, { id: msg.id, x: msg.x, y: msg.y, ctx: msg.ctx, act: msg.act, at: Date.now() });
        break;
      case 'start':
        this.start = msg.start;
        this.pendingResync = null;
        this.resetClock();
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
        // Only a running (or just finished) battle can use a snapshot; one that arrives late, after the room moved on, is dropped.
        if (this.state && (this.state.phase === 'battle' || this.state.phase === 'result')) this.pendingResync = { step: msg.step, data: msg.data };
        break;
      case 'result':
        this.result = { winner: msg.winner, alive: msg.alive, scores: msg.scores };
        break;
      case 'comedyView':
        this.comedyVisual = msg.on;
        break;
      case 'reject':
        this.rejected = msg.reason;
        break;
      case 'kicked':
        this.closedReason = msg.reason;
        break;
      case 'closed':
        this.closedReason = this.closedReason ?? 'closed';
        break;
    }
    // Cursors of departed players are removed.
    if (msg.t === 'state' || msg.t === 'welcome') {
      const ids = new Set(msg.state.players.map((p) => p.id));
      for (const id of [...this.presence.keys()]) if (!ids.has(id)) this.presence.delete(id);
    }
    for (const l of this.listeners) l(msg);
  }
}

/** Shared session the UI talks to: the same API for host and guest. */
export interface Session {
  readonly model: OnlineModel;
  readonly isHost: boolean;
  send(msg: ClientMsg): void;
  /** Ends the session. A guest with `keepSlot` only drops the connection (no "leave" message), so it can take its place in a running game back with its token. */
  leave(keepSlot?: boolean): void;
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
  /** Password (plain text; its digest is sent). */
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
      // Transports report a code; anything other than a deliberate close/kick counts as a lost connection.
      const code: CloseReason = reason === 'closed' || reason === 'kicked' ? reason : 'lost';
      this.model.closedReason = this.model.closedReason ?? code;
      this.model.apply({ t: 'closed' });
    };
    this.send({ t: 'join', name: opts.name, color: opts.color, pass: opts.pass ? passHash(opts.pass) : undefined, spectator: opts.spectator, version: PROTOCOL, token: opts.token });
  }

  send(msg: ClientMsg): void {
    this.tp.send('host', msg);
  }

  leave(keepSlot = false): void {
    if (!keepSlot) this.send({ t: 'leave' });
    this.tp.close();
  }
}

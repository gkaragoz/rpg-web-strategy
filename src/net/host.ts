import { randomSpec, sanitizeSpec, DEFAULT_MAP } from '../sim/mapSpec';
import { mulberry32 } from '../sim/random';
import { Terrain } from '../sim/terrain';
import { STATS, KIND_COUNT } from '../sim/units';
import { TROOP_BY_ID } from '../sim/data/troops';
import { PlaceIndex } from './placeIndex';
import { MAX_GOLD, MAX_ROOM_UNITS, ONLINE_MAP_SIZES, buyable, costTable, mapSizeForPlayers, placeBlock, teamZones, type Zone } from './economy';
import {
  CHAT_MAX,
  MAX_PLAYERS,
  PLACE_GAP,
  PROTOCOL,
  REJOIN_SECS,
  cleanName,
  makeCode,
  passHash,
  type BattleStart,
  type ClientMsg,
  type GameInit,
  type LobbySettings,
  type LobbyState,
  type Msg,
  type Phase,
  type PlaceItem,
  type PlacedItem,
  type PlaceFailReason,
  type PlayerInfo,
  type RejectReason,
  type ServerMsg,
} from './protocol';
import type { Transport } from './transport';

export const DEFAULT_SETTINGS: LobbySettings = {
  mapMode: 'random',
  map: { ...DEFAULT_MAP },
  mapSeed: 1,
  mapSize: 0,
  gold: 2000,
  placeSecs: 120,
  openPlacement: true,
  comedyPhysics: false,
  comedyVisual: false,
  banned: [],
};

/** Most units a player may place (performance cap). */
const MAX_PLAYER_NAME_TRIES = 20;

export interface HostDeps {
  /** Predefined lobby code (LAN room / PeerJS id); generated when absent. */
  code?: string;
  now?: () => number;
  rnd?: () => number;
}

interface Slot {
  token: string;
  disconnectedAt: number;
  /** Ready state before the disconnect (restored on reconnect during placement). */
  readyBefore?: boolean;
  lastPresence: number;
  chatTimes: number[];
}

/**
 * Authoritative lobby/game state (runs on the host only). Transport-independent: talks to guests through the
 * Transport interface and to the host player's own actions through `local()`; server messages produced for the
 * host player are handed to the UI via `onEvent`.
 */
export class HostLobby {
  readonly code: string;
  readonly hostId: string;
  phase: Phase = 'lobby';
  settings: LobbySettings = { ...DEFAULT_SETTINGS, map: { ...DEFAULT_SETTINGS.map }, banned: [] };
  players: PlayerInfo[] = [];
  /** Server messages for the host player (UI). */
  onEvent: (msg: ServerMsg) => void = () => {};
  /** Sim provider for battles: current step, hash and state snapshot (wired by the host app). */
  simProvider: { snapshot(): { step: number; data: string } | Promise<{ step: number; data: string }> } | null = null;

  private readonly now: () => number;
  private readonly rnd: () => number;
  private passHashed: string | null = null;
  private readonly slots = new Map<string, Slot>();
  private readonly kickedTokens = new Set<string>();
  private readonly units = new PlaceIndex(PLACE_GAP, (k) => this.init?.costs[k] ?? 0);
  private nextUnitId = 1;
  private init: GameInit | null = null;
  private terrain: Terrain | null = null;
  private zones: Zone[] = [];
  private placeEndsAt = Infinity;
  private battleStart: BattleStart | null = null;
  private dirtyState = false;
  private lastState = 0;
  private readonly hashes = new Map<number, number>();
  private pendingPresence = new Map<string, ServerMsg>();
  private closed = false;
  private ghostSeq = 1;
  private readonly lastResync = new Map<string, number>();
  /** Per-sender message rate limit (token bucket) so a malicious or buggy client cannot flood the host. */
  private readonly rate = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly tp: Transport,
    hostName: string,
    hostColor: number,
    deps: HostDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.rnd = deps.rnd ?? Math.random;
    this.hostId = tp.id;
    this.code = deps.code ?? makeCode(this.rnd);
    this.slots.set(this.hostId, { token: 'host', disconnectedAt: 0, lastPresence: 0, chatTimes: [] });
    this.players.push(this.newPlayer(this.hostId, hostName, hostColor, 'player'));
    this.reteam();
    tp.onMessage = (from, msg) => this.handle(from, msg as ClientMsg);
    tp.onPeerLeave = (peer) => this.peerLeft(peer);
  }

  // ---------------------------------------------------------------- helpers

  private newPlayer(id: string, name: string, color: number, role: PlayerInfo['role']): PlayerInfo {
    return { id, name: this.uniqueName(cleanName(name), id), color: this.freeColor(color, id), ready: false, team: -1, connected: true, role, muted: false, gold: 0, units: 0 };
  }

  private uniqueName(name: string, selfId: string): string {
    let n = name;
    for (let i = 2; i < MAX_PLAYER_NAME_TRIES && this.players.some((p) => p.id !== selfId && p.name === n); i++) n = `${name.slice(0, 13)}${i}`;
    return n;
  }

  private freeColor(want: number, selfId: string): number {
    const used = new Set(this.players.filter((p) => p.id !== selfId && p.role === 'player').map((p) => p.color));
    const w = Math.max(0, Math.min(5, Math.floor(Number.isFinite(want) ? want : 0)));
    if (!used.has(w)) return w;
    for (let c = 0; c < MAX_PLAYERS; c++) if (!used.has(c)) return c;
    return w;
  }

  private player(id: string): PlayerInfo | undefined {
    return this.players.find((p) => p.id === id);
  }

  private reteam(): void {
    let t = 0;
    for (const p of this.players) p.team = p.role === 'player' ? t++ : -1;
  }

  get playerCount(): number {
    return this.players.filter((p) => p.role === 'player').length;
  }

  state(): LobbyState {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      players: this.players.map((p) => ({ ...p })),
      settings: { ...this.settings, map: { ...this.settings.map }, banned: [...this.settings.banned] },
      locked: this.passHashed !== null,
      placeLeft: this.phase === 'placing' && Number.isFinite(this.placeEndsAt) ? Math.max(0, Math.ceil((this.placeEndsAt - this.now()) / 1000)) : -1,
      init: this.init ?? undefined,
    };
  }

  private sendTo(id: string, msg: ServerMsg): void {
    if (id === this.hostId) this.onEvent(msg);
    else this.tp.send(id, msg as Msg);
  }

  private emit(msg: ServerMsg, except?: string): void {
    this.tp.broadcast(msg as Msg, except);
    if (except !== this.hostId) this.onEvent(msg);
  }

  private pushState(): void {
    this.dirtyState = false;
    this.lastState = this.now();
    this.refreshCounts();
    this.emit({ t: 'state', state: this.state() });
  }

  private refreshCounts(): void {
    if (!this.init) return;
    for (const p of this.players) {
      if (p.role !== 'player') continue;
      p.gold = this.init.gold - this.units.spent(p.team);
      p.units = this.units.count(p.team);
    }
  }

  private reject(to: string, reason: RejectReason): void {
    this.sendTo(to, { t: 'reject', reason });
    if (to !== this.hostId) this.tp.disconnect(to);
  }

  // ---------------------------------------------------------------- messages

  /** The host player's own action (same processing path as a guest message). */
  local(msg: ClientMsg): void {
    this.handle(this.hostId, msg);
  }

  handle(from: string, msg: ClientMsg): void {
    if (this.closed || !msg || typeof msg !== 'object') return;
    try {
      this.dispatch(from, msg);
    } catch (e) {
      // A malformed or unexpected message must not take the lobby down.
      console.warn('[host] could not process message', msg.t, e);
    }
  }

  /** About 40 messages per second for everything except presence (burst of 80). */
  private allow(from: string): boolean {
    if (from === this.hostId) return true;
    const t = this.now();
    let r = this.rate.get(from);
    if (!r) this.rate.set(from, (r = { tokens: 80, at: t }));
    r.tokens = Math.min(80, r.tokens + ((t - r.at) / 1000) * 40);
    r.at = t;
    if (r.tokens < 1) return false;
    r.tokens -= 1;
    return true;
  }

  private dispatch(from: string, msg: ClientMsg): void {
    if (msg.t === 'join') return this.onJoin(from, msg);
    const p = this.player(from);
    if (!p) return;
    if (msg.t !== 'presence' && !this.allow(from)) {
      // Rate limited: placement edits must never vanish silently (the client already changed its own view).
      if (msg.t === 'place' && Array.isArray(msg.items)) this.sendTo(p.id, { t: 'placeFail', cids: msg.items.map((i) => i?.cid).filter((c) => Number.isInteger(c)), reason: 'busy' });
      else if (msg.t === 'unplace' && Array.isArray(msg.ids)) this.sendUnplaceFail(p.id, msg.ids);
      return;
    }
    const isHost = from === this.hostId;
    switch (msg.t) {
      case 'profile':
        p.name = this.uniqueName(cleanName(msg.name), from);
        if (p.role === 'player' && this.phase === 'lobby') p.color = this.freeColor(msg.color, from);
        this.pushState();
        break;
      case 'ready':
        if (p.role !== 'player' || (this.phase !== 'lobby' && this.phase !== 'placing')) return;
        p.ready = !!msg.ready;
        this.pushState();
        break;
      case 'chat':
        this.onChat(p, msg.text);
        break;
      case 'presence':
        this.onPresence(from, msg);
        break;
      case 'place':
        if (Array.isArray(msg.items)) this.onPlace(p, msg.items);
        break;
      case 'unplace':
        if (Array.isArray(msg.ids)) this.onUnplace(p, msg.ids);
        break;
      case 'check':
        if (Number.isFinite(msg.step) && Number.isFinite(msg.hash)) this.onCheck(from, msg.step, msg.hash);
        break;
      case 'settings':
        if (isHost) this.onSettings(msg.settings, msg.password);
        break;
      case 'kick':
        if (isHost) this.kick(msg.id);
        break;
      case 'mute':
        if (isHost) {
          const t = this.player(msg.id);
          if (t && t.id !== this.hostId) {
            t.muted = !!msg.on;
            this.pushState();
          }
        }
        break;
      case 'start':
        if (isHost) this.start();
        break;
      case 'cmd':
        if (!isHost || this.phase !== 'battle') break;
        // Comedy view (look only): only the host decides, everybody follows, late joiners start with the current value.
        if (typeof msg.comedyVisual === 'boolean') {
          if (this.init) this.init.comedyVisual = msg.comedyVisual;
          this.emit({ t: 'comedyView', on: msg.comedyVisual });
        }
        if (msg.speed !== undefined || msg.paused !== undefined) this.emit({ t: 'tick', step: -1, speed: msg.speed ?? 1, paused: !!msg.paused });
        break;
      case 'rematch':
        if (isHost && (this.phase === 'result' || this.phase === 'battle')) this.rematch();
        break;
      case 'lobby':
        if (isHost && (this.phase === 'result' || this.phase === 'battle')) this.toLobby();
        break;
      case 'leave':
        if (isHost) this.close();
        else {
          this.removePlayer(from, false);
        }
        break;
    }
  }

  /** Sends the current battle state to one peer (a worker-backed sim answers asynchronously). */
  private sendSnapshot(to: string): void {
    const r = this.simProvider?.snapshot();
    if (!r) return;
    const send = (s: { step: number; data: string }): void => this.sendTo(to, { t: 'resync', step: s.step, data: s.data });
    if (r instanceof Promise) void r.then(send);
    else send(r);
  }

  private onJoin(from: string, msg: Extract<ClientMsg, { t: 'join' }>): void {
    if (msg.version !== PROTOCOL) return this.reject(from, 'version');
    // A second join from the same connection (double click / resend): ignore.
    if (this.player(from)) return;
    if (msg.token && this.kickedTokens.has(msg.token)) return this.reject(from, 'kicked');
    if (this.passHashed !== null && (msg.pass ?? '') !== this.passHashed) return this.reject(from, 'password');
    // Reconnect: the player whose token matches. If the old connection does not look dropped yet (half-open connection), it is taken over.
    if (msg.token) {
      for (const [oldId, slot] of this.slots) {
        const p = this.player(oldId);
        if (slot.token === msg.token && p && oldId !== this.hostId) {
          const stale = p.connected;
          this.slots.delete(oldId);
          this.pendingPresence.delete(oldId);
          p.id = from; // change the id first: the old connection's drop event can no longer find this player
          if (stale) this.tp.disconnect(oldId);
          p.connected = true;
          if (this.phase === 'placing') p.ready = stale ? p.ready : (slot.readyBefore ?? false);
          this.slots.set(from, { ...slot, disconnectedAt: 0 });
          this.welcome(from, slot.token);
          this.pushState();
          return;
        }
      }
    }
    const wantSpec = !!msg.spectator || this.phase !== 'lobby';
    if (!wantSpec && this.playerCount >= MAX_PLAYERS) return this.reject(from, 'full');
    if (this.phase !== 'lobby' && !msg.spectator) return this.reject(from, 'started');
    const role: PlayerInfo['role'] = wantSpec ? 'spectator' : 'player';
    const token = Math.floor(this.rnd() * 1e9).toString(36) + from;
    this.slots.set(from, { token, disconnectedAt: 0, lastPresence: 0, chatTimes: [] });
    this.players.push(this.newPlayer(from, msg.name, msg.color, role));
    this.reteam();
    this.welcome(from, token);
    this.pushState();
  }

  private welcome(to: string, token: string): void {
    this.refreshCounts();
    this.sendTo(to, { t: 'welcome', you: to, token, state: this.state(), start: this.battleStart ?? undefined });
    if (this.phase === 'battle' && this.simProvider) {
      this.sendSnapshot(to);
    }
    if (this.phase === 'placing') {
      // Send the existing placements (all of them with open placement, otherwise only the player's own).
      const items = this.visibleUnits(this.player(to));
      if (items.length) this.sendTo(to, { t: 'placed', owner: '*', items });
    }
  }

  private onChat(p: PlayerInfo, raw: string): void {
    if (p.muted) return;
    const text = String(raw).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return;
    const slot = this.slots.get(p.id);
    const t = this.now();
    if (slot) {
      slot.chatTimes = slot.chatTimes.filter((x) => t - x < 10000);
      if (slot.chatTimes.length >= 5) return; // spam limit
      slot.chatTimes.push(t);
    }
    this.emit({ t: 'chat', id: p.id, name: p.name, text, ts: t });
  }

  private onPresence(from: string, m: Extract<ClientMsg, { t: 'presence' }>): void {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    const out: ServerMsg = { t: 'presence', id: from, x: m.x, y: m.y, ctx: m.ctx === 'world' ? 'world' : 'page', act: m.act ? String(m.act).slice(0, 40) : undefined };
    const slot = this.slots.get(from);
    const t = this.now();
    if (slot && t - slot.lastPresence < 50) {
      this.pendingPresence.set(from, out); // the latest value goes out on the next tick
      return;
    }
    if (slot) slot.lastPresence = t;
    this.pendingPresence.delete(from);
    this.emit(out, from);
  }

  private onSettings(patch: Partial<LobbySettings>, password: string | null | undefined): void {
    if (this.phase !== 'lobby') return;
    const s = this.settings;
    const before = JSON.stringify(s) + String(this.passHashed);
    if (patch.mapMode === 'random' || patch.mapMode === 'fixed') s.mapMode = patch.mapMode;
    if (patch.map) s.map = sanitizeSpec(patch.map);
    if (typeof patch.mapSeed === 'number' && Number.isFinite(patch.mapSeed)) s.mapSeed = Math.max(1, Math.floor(patch.mapSeed)) % 1000000;
    if (typeof patch.mapSize === 'number') s.mapSize = ONLINE_MAP_SIZES.includes(patch.mapSize) ? patch.mapSize : s.mapSize;
    if (typeof patch.gold === 'number' && Number.isFinite(patch.gold)) s.gold = Math.min(MAX_GOLD, Math.max(100, Math.round(patch.gold)));
    if (typeof patch.placeSecs === 'number' && Number.isFinite(patch.placeSecs)) s.placeSecs = Math.min(600, Math.max(0, Math.round(patch.placeSecs)));
    if (typeof patch.openPlacement === 'boolean') s.openPlacement = patch.openPlacement;
    if (typeof patch.comedyPhysics === 'boolean') s.comedyPhysics = patch.comedyPhysics;
    if (typeof patch.comedyVisual === 'boolean') s.comedyVisual = patch.comedyVisual;
    if (Array.isArray(patch.banned)) s.banned = patch.banned.filter((r) => ['common', 'rare', 'epic', 'legendary'].includes(r));
    if (password !== undefined) this.passHashed = password ? passHash(password) : null;
    // When a setting really changes, clear everyone's ready flag (except the host): players must see the new rules.
    if (JSON.stringify(s) + String(this.passHashed) !== before) for (const p of this.players) if (p.id !== this.hostId) p.ready = false;
    this.pushState();
  }

  /** Digest the client sends to verify the lobby password. */
  static passwordToken(password: string): string {
    return passHash(password);
  }

  kick(id: string): void {
    if (id === this.hostId) return;
    const p = this.player(id);
    if (!p) return;
    const slot = this.slots.get(id);
    if (slot) this.kickedTokens.add(slot.token);
    this.sendTo(id, { t: 'kicked', reason: 'kicked' });
    this.removePlayer(id, true);
  }

  private removePlayer(id: string, disconnect: boolean): void {
    const p = this.player(id);
    if (!p) return;
    this.slots.delete(id);
    this.pendingPresence.delete(id);
    this.rate.delete(id);
    if (disconnect) this.tp.disconnect(id);
    if (this.phase === 'lobby' || p.role === 'spectator') {
      this.players = this.players.filter((x) => x.id !== id);
      this.reteam();
    } else {
      // If a player leaves mid-game, team numbers do NOT change (zones, units and init.teamPlayers depend on the
      // team index): the player stays as a disconnected ghost, their units fight, and they are removed on return to the lobby.
      p.connected = false;
      p.ready = true;
      p.id = `x${this.ghostSeq++}:${p.id}`;
    }
    this.pushState();
  }

  private peerLeft(peer: string): void {
    const p = this.player(peer);
    if (!p || peer === this.hostId) return;
    if (this.phase === 'lobby' || p.role === 'spectator') {
      this.removePlayer(peer, false);
      return;
    }
    p.connected = false;
    const slot = this.slots.get(peer);
    if (slot) {
      slot.disconnectedAt = this.now();
      slot.readyBefore = p.ready;
    }
    p.ready = true; // the placement phase must not wait for them
    this.pushState();
  }

  // ---------------------------------------------------------------- game flow

  /** Start: everyone (except the host) is ready and there are at least 2 players. */
  canStart(): boolean {
    const pl = this.players.filter((p) => p.role === 'player');
    return this.phase === 'lobby' && pl.length >= 2 && pl.every((p) => p.id === this.hostId || (p.ready && p.connected));
  }

  private start(): void {
    if (!this.canStart()) return;
    const pl = this.players.filter((p) => p.role === 'player');
    const teams = pl.length;
    const size = this.settings.mapSize || mapSizeForPlayers(teams);
    let seed = this.settings.mapSeed;
    let spec = this.settings.map;
    if (this.settings.mapMode === 'random') {
      seed = 1 + Math.floor(this.rnd() * 999999);
      for (let tries = 0; tries < 30; tries++) {
        spec = randomSpec(mulberry32(seed));
        const t = new Terrain(size, { seed, spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
        if (teamZones(size, teams, t).every((z) => z.area > 90)) break;
        seed = 1 + ((seed + 7919) % 999999);
      }
    }
    this.terrain = new Terrain(size, { seed, spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
    this.zones = teamZones(size, teams, this.terrain);
    this.units.clear();
    this.nextUnitId = 1;
    this.init = {
      spec,
      seed,
      size,
      gold: this.settings.gold,
      teams,
      openPlacement: this.settings.openPlacement,
      comedyPhysics: this.settings.comedyPhysics,
      comedyVisual: this.settings.comedyVisual,
      banned: [...this.settings.banned],
      costs: costTable(),
      teamPlayers: pl.map((p) => p.id),
    };
    this.phase = 'placing';
    this.placeEndsAt = this.settings.placeSecs > 0 ? this.now() + this.settings.placeSecs * 1000 : Infinity;
    for (const p of this.players) p.ready = false;
    this.battleStart = null;
    this.pushState();
  }

  private onPlace(p: PlayerInfo, items: PlaceItem[]): void {
    if (this.phase !== 'placing' || p.role !== 'player' || p.ready || !this.init || !this.terrain) {
      this.sendTo(p.id, { t: 'placeFail', cids: items.map((i) => i.cid), reason: 'busy' });
      return;
    }
    const zone = this.zones[p.team];
    const costs = this.init.costs;
    let spent = this.units.spent(p.team);
    const placed: PlacedItem[] = [];
    const failed: number[] = [];
    let reason: PlaceFailReason = 'busy';
    for (const it of items.slice(0, 80)) {
      const fail = (r: PlaceFailReason): void => {
        failed.push(it.cid);
        reason = r;
      };
      if (!Number.isFinite(it.x) || !Number.isFinite(it.y) || !Number.isInteger(it.kind) || it.kind < 0 || it.kind >= KIND_COUNT) {
        fail('invalid');
        continue;
      }
      if (!buyable(it.kind)) {
        fail('unbuyable');
        continue;
      }
      const tr = STATS[it.kind].troop ? TROOP_BY_ID[STATS[it.kind].troop!] : undefined;
      if (tr && this.init.banned.includes(tr.rarity)) {
        fail('banned');
        continue;
      }
      const block = placeBlock(this.terrain, zone, it.x, it.y);
      if (block) {
        fail(block);
        continue;
      }
      const c = costs[it.kind] ?? 0;
      if (spent + c > this.init.gold) {
        fail('gold');
        continue;
      }
      if (this.units.size + placed.length >= MAX_ROOM_UNITS) {
        fail('cap');
        continue;
      }
      // Units accepted earlier in this very batch are already in the index (added below as they pass).
      if (this.units.near(p.team, it.x, it.y)) {
        fail('close');
        continue;
      }
      spent += c;
      const item = { id: this.nextUnitId++, cid: it.cid, team: p.team, kind: it.kind, x: it.x, y: it.y };
      this.units.add(item);
      placed.push(item);
    }
    if (failed.length) this.sendTo(p.id, { t: 'placeFail', cids: failed, reason });
    if (!placed.length) return;
    // Always to the owner; to others only with open placement.
    this.sendTo(p.id, { t: 'placed', owner: p.id, items: placed });
    if (this.settings.openPlacement) this.emit({ t: 'placed', owner: p.id, items: placed }, p.id);
    this.dirtyState = true;
  }

  /** Tells the client that a removal was refused (in chunks, so nothing is truncated). */
  private sendUnplaceFail(to: string, ids: unknown[]): void {
    const ok = ids.filter((id): id is number => Number.isInteger(id));
    for (let i = 0; i < ok.length; i += 400) this.sendTo(to, { t: 'unplaceFail', ids: ok.slice(i, i + 400) });
  }

  private onUnplace(p: PlayerInfo, ids: number[]): void {
    if (this.phase !== 'placing' || p.role !== 'player' || p.ready) {
      // Never ignore silently: the client already removed the sprites and must put them back.
      if (p.role === 'player') this.sendUnplaceFail(p.id, ids);
      return;
    }
    const removed = this.units.remove(ids, p.team);
    if (!removed.length) return;
    this.sendTo(p.id, { t: 'unplaced', owner: p.id, ids: removed });
    if (this.settings.openPlacement) this.emit({ t: 'unplaced', owner: p.id, ids: removed }, p.id);
    this.dirtyState = true;
  }

  private beginBattle(): void {
    if (!this.init) return;
    const sorted = this.units.all().sort((a, b) => a.id - b.id);
    const layout: number[] = [];
    for (const u of sorted) layout.push(u.team, u.kind, u.x, u.y);
    this.battleStart = { init: this.init, simSeed: 1 + Math.floor(this.rnd() * 1000000), layout };
    this.phase = 'battle';
    this.hashes.clear();
    this.refreshCounts();
    this.emit({ t: 'start', start: this.battleStart });
    this.pushState();
  }

  /** Periodic call (about 100-250 ms): placement timer, pending presence, state broadcast, reconnect window. */
  tick(): void {
    if (this.closed) return;
    const t = this.now();
    for (const [id, msg] of this.pendingPresence) {
      const slot = this.slots.get(id);
      if (slot && t - slot.lastPresence >= 50) {
        slot.lastPresence = t;
        this.pendingPresence.delete(id);
        this.emit(msg, id);
      }
    }
    if (this.phase === 'placing') {
      const pl = this.players.filter((p) => p.role === 'player');
      if (t >= this.placeEndsAt || (pl.length > 0 && pl.every((p) => p.ready))) {
        this.beginBattle();
        return;
      }
    }
    if (this.phase !== 'lobby') {
      for (const [id, slot] of [...this.slots]) {
        const p = this.player(id);
        if (p && !p.connected && slot.disconnectedAt && t - slot.disconnectedAt > REJOIN_SECS * 1000 && this.phase === 'placing') {
          // Did not come back: the player is dropped during placement (their units stay but the team no longer counts separately).
          slot.disconnectedAt = 0;
        }
      }
    }
    if (this.dirtyState && t - this.lastState >= 200) this.pushState();
    // Placement countdown: broadcast the state once per second.
    if (this.phase === 'placing' && Number.isFinite(this.placeEndsAt) && t - this.lastState >= 1000) this.pushState();
  }

  // ---------------------------------------------------------------- battle sync

  /** Called when the host sim steps: records the hash at checkpoints. */
  recordHash(step: number, hash: number): void {
    if (step % CHECK_EVERY !== 0) return;
    this.hashes.set(step, hash);
    if (this.hashes.size > 40) this.hashes.delete(this.hashes.keys().next().value as number);
  }

  private onCheck(from: string, step: number, hash: number): void {
    if (this.phase !== 'battle') return;
    const mine = this.hashes.get(step);
    if (mine === undefined || mine === hash) return;
    // A client that keeps diverging (different browser engine etc.) must not flood the network with large snapshots: at most once per 4 s.
    const t = this.now();
    if (t - (this.lastResync.get(from) ?? -Infinity) < 4000) return;
    this.lastResync.set(from, t);
    if (this.simProvider) {
      this.sendSnapshot(from);
    }
  }

  /** The battle is over: announces the result to everyone. */
  finish(winner: number, alive: number[]): void {
    if (this.phase !== 'battle') return;
    this.phase = 'result';
    this.emit({ t: 'result', winner, alive });
    this.pushState();
  }

  /** Broadcasts the host's timed sim info (speed/pause); step = host step count. */
  broadcastTick(step: number, speed: number, paused: boolean): void {
    this.emit({ t: 'tick', step, speed, paused });
  }

  /** Placements a player may see: all of them with open placement, otherwise only the own team's. */
  private visibleUnits(me: PlayerInfo | undefined): PlacedItem[] {
    return this.units.visible(this.settings.openPlacement ? null : me ? me.team : -1);
  }

  /** Rematch: same map, teams and settings; the last formation stays and everybody places (tweaks) again. */
  private rematch(): void {
    if (!this.init || !this.terrain) return this.toLobby();
    this.phase = 'placing';
    this.battleStart = null;
    this.hashes.clear();
    this.placeEndsAt = this.settings.placeSecs > 0 ? this.now() + this.settings.placeSecs * 1000 : Infinity;
    for (const p of this.players) p.ready = !p.connected;
    this.refreshCounts();
    this.pushState();
    // After the state: clients clear their placements when the phase changes.
    for (const p of this.players) {
      if (!p.connected) continue;
      const items = this.visibleUnits(p);
      if (items.length) this.sendTo(p.id, { t: 'placed', owner: '*', items });
    }
  }

  private toLobby(): void {
    this.phase = 'lobby';
    this.units.clear();
    this.init = null;
    this.battleStart = null;
    this.terrain = null;
    this.zones = [];
    this.placeEndsAt = Infinity;
    for (const p of this.players) {
      p.ready = false;
      p.gold = 0;
      p.units = 0;
    }
    // Disconnected players are cleaned up.
    this.players = this.players.filter((p) => p.connected);
    for (const id of [...this.slots.keys()]) if (!this.player(id)) this.slots.delete(id);
    this.reteam();
    this.pushState();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ t: 'closed' });
    this.tp.close();
  }

  get zoneList(): Zone[] {
    return this.zones;
  }
}

/** Checksum interval (sim steps): 2 s at 30 Hz. */
export const CHECK_EVERY = 60;

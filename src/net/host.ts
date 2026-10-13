import { randomSpec, sanitizeSpec, DEFAULT_MAP } from '../sim/mapSpec';
import { mulberry32 } from '../sim/random';
import { Terrain } from '../sim/terrain';
import { STATS, KIND_COUNT } from '../sim/units';
import { TROOP_BY_ID } from '../sim/data/troops';
import { buyable, costTable, mapSizeForPlayers, teamZones, type Zone } from './economy';
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
  level: 5,
  openPlacement: true,
  comedyPhysics: false,
  comedyVisual: false,
  banned: [],
};

/** Her oyuncunun yerlestirebilecegi en cok birim (performans ust siniri). */
export const MAX_UNITS_PER_PLAYER = 1500;
const MAX_PLAYER_NAME_TRIES = 20;

export interface HostDeps {
  now?: () => number;
  rnd?: () => number;
}

interface Slot {
  token: string;
  disconnectedAt: number;
  lastPresence: number;
  chatTimes: number[];
}

/**
 * Yetkili lobi/oyun durumu (yalniz host'ta calisir). Taşımadan bagimsiz: Transport arayuzu uzerinden
 * misafirlerle, `local()` ile host oyuncusunun kendi eylemleriyle konusur; host oyuncusu icin uretilen
 * sunucu mesajlari `onEvent` ile arayuze verilir.
 */
export class HostLobby {
  readonly code: string;
  readonly hostId: string;
  phase: Phase = 'lobby';
  settings: LobbySettings = { ...DEFAULT_SETTINGS, map: { ...DEFAULT_SETTINGS.map }, banned: [] };
  players: PlayerInfo[] = [];
  /** Host oyuncusu icin sunucu mesajlari (arayuz). */
  onEvent: (msg: ServerMsg) => void = () => {};
  /** Savas icin sim saglayicisi: guncel adim, hash ve durum goruntusu (host uygulamasi baglar). */
  simProvider: { snapshot(): { step: number; data: string } } | null = null;

  private readonly now: () => number;
  private readonly rnd: () => number;
  private passHashed: string | null = null;
  private readonly slots = new Map<string, Slot>();
  private readonly kickedTokens = new Set<string>();
  private units: PlacedItem[] = [];
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

  constructor(
    private readonly tp: Transport,
    hostName: string,
    hostColor: number,
    deps: HostDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.rnd = deps.rnd ?? Math.random;
    this.hostId = tp.id;
    this.code = makeCode(this.rnd);
    this.slots.set(this.hostId, { token: 'host', disconnectedAt: 0, lastPresence: 0, chatTimes: [] });
    this.players.push(this.newPlayer(this.hostId, hostName, hostColor, 'player'));
    this.reteam();
    tp.onMessage = (from, msg) => this.handle(from, msg as ClientMsg);
    tp.onPeerLeave = (peer) => this.peerLeft(peer);
  }

  // ---------------------------------------------------------------- yardimcilar

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
      let spent = 0;
      let n = 0;
      for (const u of this.units) {
        if (u.team === p.team) {
          spent += this.init.costs[u.kind] ?? 0;
          n++;
        }
      }
      p.gold = this.init.gold - spent;
      p.units = n;
    }
  }

  private reject(to: string, reason: RejectReason): void {
    this.sendTo(to, { t: 'reject', reason });
    if (to !== this.hostId) this.tp.disconnect(to);
  }

  // ---------------------------------------------------------------- mesajlar

  /** Host oyuncusunun kendi eylemi (misafir mesajiyla ayni islem hatti). */
  local(msg: ClientMsg): void {
    this.handle(this.hostId, msg);
  }

  handle(from: string, msg: ClientMsg): void {
    if (this.closed) return;
    if (msg.t === 'join') return this.onJoin(from, msg);
    const p = this.player(from);
    if (!p) return;
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
        this.onPlace(p, msg.items);
        break;
      case 'unplace':
        this.onUnplace(p, msg.ids);
        break;
      case 'check':
        this.onCheck(from, msg.step, msg.hash);
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
        if (isHost && this.phase === 'battle') this.emit({ t: 'tick', step: -1, speed: msg.speed ?? 1, paused: !!msg.paused });
        break;
      case 'rematch':
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

  private onJoin(from: string, msg: Extract<ClientMsg, { t: 'join' }>): void {
    if (msg.version !== PROTOCOL) return this.reject(from, 'version');
    if (msg.token && this.kickedTokens.has(msg.token)) return this.reject(from, 'kicked');
    if (this.passHashed !== null && (msg.pass ?? '') !== this.passHashed) return this.reject(from, 'password');
    // Geri baglanma: bagli degil bir oyuncunun jetonu.
    if (msg.token) {
      for (const [oldId, slot] of this.slots) {
        const p = this.player(oldId);
        if (slot.token === msg.token && p && !p.connected && oldId !== this.hostId) {
          this.slots.delete(oldId);
          p.id = from;
          p.connected = true;
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
      const s = this.simProvider.snapshot();
      this.sendTo(to, { t: 'resync', step: s.step, data: s.data });
    }
    if (this.phase === 'placing') {
      // Mevcut yerlestirmeleri (acik yerlestirmede hepsini, degilse yalniz kendininkini) gonder.
      const me = this.player(to);
      const items = this.units.filter((u) => this.settings.openPlacement || (me && u.team === me.team));
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
      if (slot.chatTimes.length >= 5) return; // spam siniri
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
      this.pendingPresence.set(from, out); // en son deger sonraki tick'te gider
      return;
    }
    if (slot) slot.lastPresence = t;
    this.pendingPresence.delete(from);
    this.emit(out, from);
  }

  private onSettings(patch: Partial<LobbySettings>, password: string | null | undefined): void {
    if (this.phase !== 'lobby') return;
    const s = this.settings;
    if (patch.mapMode === 'random' || patch.mapMode === 'fixed') s.mapMode = patch.mapMode;
    if (patch.map) s.map = sanitizeSpec(patch.map);
    if (typeof patch.mapSeed === 'number' && Number.isFinite(patch.mapSeed)) s.mapSeed = Math.max(1, Math.floor(patch.mapSeed)) % 1000000;
    if (typeof patch.mapSize === 'number') s.mapSize = [0, 40, 56, 80, 100, 120].includes(patch.mapSize) ? patch.mapSize : s.mapSize;
    if (typeof patch.gold === 'number' && Number.isFinite(patch.gold)) s.gold = Math.min(100000, Math.max(100, Math.round(patch.gold)));
    if (typeof patch.placeSecs === 'number' && Number.isFinite(patch.placeSecs)) s.placeSecs = Math.min(600, Math.max(0, Math.round(patch.placeSecs)));
    if (typeof patch.level === 'number' && Number.isFinite(patch.level)) s.level = Math.min(10, Math.max(1, Math.round(patch.level)));
    if (typeof patch.openPlacement === 'boolean') s.openPlacement = patch.openPlacement;
    if (typeof patch.comedyPhysics === 'boolean') s.comedyPhysics = patch.comedyPhysics;
    if (typeof patch.comedyVisual === 'boolean') s.comedyVisual = patch.comedyVisual;
    if (Array.isArray(patch.banned)) s.banned = patch.banned.filter((r) => ['common', 'rare', 'epic', 'legendary'].includes(r));
    if (password !== undefined) this.passHashed = password ? passHash(password) : null;
    // Ayar degisince herkesin hazir isareti dusur (host haric): oyuncular yeni kurallari gormeli.
    for (const p of this.players) if (p.id !== this.hostId) p.ready = false;
    this.pushState();
  }

  /** Lobi parolasi dogrulamasi icin istemcinin gonderecegi ozet. */
  static passwordToken(password: string): string {
    return passHash(password);
  }

  kick(id: string): void {
    if (id === this.hostId) return;
    const p = this.player(id);
    if (!p) return;
    const slot = this.slots.get(id);
    if (slot) this.kickedTokens.add(slot.token);
    this.sendTo(id, { t: 'kicked', reason: 'Host tarafindan atildin' });
    this.removePlayer(id, true);
  }

  private removePlayer(id: string, disconnect: boolean): void {
    const p = this.player(id);
    if (!p) return;
    this.players = this.players.filter((x) => x.id !== id);
    this.slots.delete(id);
    this.pendingPresence.delete(id);
    if (disconnect) this.tp.disconnect(id);
    this.reteam();
    if (this.phase === 'lobby') this.pushState();
    else {
      // Oyun suruyor: oyuncu kaldirilirsa birimleri yetim kalir; seyirci degilse takimi bos birakilmaz.
      this.pushState();
    }
  }

  private peerLeft(peer: string): void {
    const p = this.player(peer);
    if (!p || peer === this.hostId) return;
    if (this.phase === 'lobby' || p.role === 'spectator') {
      this.removePlayer(peer, false);
      return;
    }
    p.connected = false;
    p.ready = true; // yerlestirme asamasi onu beklemesin
    const slot = this.slots.get(peer);
    if (slot) slot.disconnectedAt = this.now();
    this.pushState();
  }

  // ---------------------------------------------------------------- oyun akisi

  /** Baslat: herkes (host haric) hazir ve en az 2 oyuncu. */
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
    this.units = [];
    this.nextUnitId = 1;
    this.init = {
      spec,
      seed,
      size,
      level: this.settings.level,
      gold: this.settings.gold,
      teams,
      openPlacement: this.settings.openPlacement,
      comedyPhysics: this.settings.comedyPhysics,
      comedyVisual: this.settings.comedyVisual,
      banned: [...this.settings.banned],
      costs: costTable(this.settings.level),
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
      this.sendTo(p.id, { t: 'placeFail', cids: items.map((i) => i.cid), reason: 'Su an yerlestirilemez' });
      return;
    }
    const zone = this.zones[p.team];
    const costs = this.init.costs;
    let spent = 0;
    let n = 0;
    for (const u of this.units) {
      if (u.team === p.team) {
        spent += costs[u.kind] ?? 0;
        n++;
      }
    }
    const placed: PlacedItem[] = [];
    const failed: number[] = [];
    let reason = '';
    for (const it of items.slice(0, 80)) {
      const fail = (r: string): void => {
        failed.push(it.cid);
        reason = r;
      };
      if (!Number.isFinite(it.x) || !Number.isFinite(it.y) || !Number.isInteger(it.kind) || it.kind < 0 || it.kind >= KIND_COUNT) {
        fail('Gecersiz birim');
        continue;
      }
      if (!buyable(it.kind)) {
        fail('Birim alinamaz');
        continue;
      }
      const tr = STATS[it.kind].troop ? TROOP_BY_ID[STATS[it.kind].troop!] : undefined;
      if (tr && this.init.banned.includes(tr.rarity)) {
        fail('Bu nadirlik kapali');
        continue;
      }
      if (!zone.contains(it.x, it.y) || !this.terrain.walkable(it.x, it.y) || !this.terrain.reachable(it.x, it.y)) {
        fail('Bolge disi');
        continue;
      }
      const c = costs[it.kind] ?? 0;
      if (spent + c > this.init.gold) {
        fail('Gold yetersiz');
        continue;
      }
      if (n >= MAX_UNITS_PER_PLAYER) {
        fail('Birim siniri');
        continue;
      }
      let close = false;
      for (const u of this.units) {
        if (u.team === p.team && (u.x - it.x) ** 2 + (u.y - it.y) ** 2 < PLACE_GAP * PLACE_GAP) {
          close = true;
          break;
        }
      }
      if (!close) for (const u of placed) if ((u.x - it.x) ** 2 + (u.y - it.y) ** 2 < PLACE_GAP * PLACE_GAP) close = true;
      if (close) {
        fail('Cok yakin');
        continue;
      }
      spent += c;
      n++;
      placed.push({ id: this.nextUnitId++, cid: it.cid, team: p.team, kind: it.kind, x: it.x, y: it.y });
    }
    if (failed.length) this.sendTo(p.id, { t: 'placeFail', cids: failed, reason });
    if (!placed.length) return;
    for (const u of placed) this.units.push(u);
    // Sahibine her zaman; baskalarina yalniz acik yerlestirmede.
    this.sendTo(p.id, { t: 'placed', owner: p.id, items: placed });
    if (this.settings.openPlacement) this.emit({ t: 'placed', owner: p.id, items: placed }, p.id);
    this.dirtyState = true;
  }

  private onUnplace(p: PlayerInfo, ids: number[]): void {
    if (this.phase !== 'placing' || p.role !== 'player' || p.ready) return;
    const set = new Set(ids);
    const removed = this.units.filter((u) => set.has(u.id) && u.team === p.team).map((u) => u.id);
    if (!removed.length) return;
    const rm = new Set(removed);
    this.units = this.units.filter((u) => !rm.has(u.id));
    this.sendTo(p.id, { t: 'unplaced', owner: p.id, ids: removed });
    if (this.settings.openPlacement) this.emit({ t: 'unplaced', owner: p.id, ids: removed }, p.id);
    this.dirtyState = true;
  }

  private beginBattle(): void {
    if (!this.init) return;
    const sorted = this.units.slice().sort((a, b) => a.id - b.id);
    const layout: number[] = [];
    for (const u of sorted) layout.push(u.team, u.kind, u.x, u.y);
    this.battleStart = { init: this.init, simSeed: 1 + Math.floor(this.rnd() * 1000000), layout };
    this.phase = 'battle';
    this.hashes.clear();
    this.refreshCounts();
    this.emit({ t: 'start', start: this.battleStart });
    this.pushState();
  }

  /** Periyodik cagri (yaklasik 100-250 ms): yerlestirme suresi, bekleyen presence, durum yayini, geri baglanma suresi. */
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
          // Geri donmedi: yerlestirme asamasinda oyuncu dusurulur (birimleri kalir ama takimi ayri sayilmaz).
          slot.disconnectedAt = 0;
        }
      }
    }
    if (this.dirtyState && t - this.lastState >= 200) this.pushState();
    // Yerlestirme suresi geri sayimi: saniyede bir durum yay.
    if (this.phase === 'placing' && Number.isFinite(this.placeEndsAt) && t - this.lastState >= 1000) this.pushState();
  }

  // ---------------------------------------------------------------- savas senkronu

  /** Host sim adimi attiginda cagirir: kontrol noktalarinda hash kaydeder. */
  recordHash(step: number, hash: number): void {
    if (step % CHECK_EVERY !== 0) return;
    this.hashes.set(step, hash);
    if (this.hashes.size > 40) this.hashes.delete(this.hashes.keys().next().value as number);
  }

  private onCheck(from: string, step: number, hash: number): void {
    if (this.phase !== 'battle') return;
    const mine = this.hashes.get(step);
    if (mine === undefined || mine === hash) return;
    if (this.simProvider) {
      const s = this.simProvider.snapshot();
      this.sendTo(from, { t: 'resync', step: s.step, data: s.data });
    }
  }

  /** Savas bitti: sonucu herkese bildirir. */
  finish(winner: number, alive: number[]): void {
    if (this.phase !== 'battle') return;
    this.phase = 'result';
    this.emit({ t: 'result', winner, alive });
    this.pushState();
  }

  /** Host zamanli sim bilgisini yayinlar (hiz/duraklat); step = host adim sayisi. */
  broadcastTick(step: number, speed: number, paused: boolean): void {
    this.emit({ t: 'tick', step, speed, paused });
  }

  private toLobby(): void {
    this.phase = 'lobby';
    this.units = [];
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
    // Kopmus oyuncular temizlenir.
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

/** Kontrol toplami araligi (sim adimi): 30 Hz'de 2 sn. */
export const CHECK_EVERY = 60;

import type { BattleConfig } from '../sim/battle';
import type { MapSpec } from '../sim/mapSpec';
import type { Rarity } from '../sim/data/troops';

/** Protocol version: a client with a different version cannot join the lobby. */
export const PROTOCOL = 5;
export const MAX_PLAYERS = 6;
export const NAME_MAX = 16;
export const CHAT_MAX = 200;
/** Placement spacing: smallest distance between units of the same team (matches the editor's MIN_GAP). */
export const PLACE_GAP = 0.85;
/** Time (s) a disconnected player has to reconnect. */
export const REJOIN_SECS = 60;

export type Role = 'player' | 'spectator';
export type Phase = 'lobby' | 'placing' | 'battle' | 'result';

export interface PlayerInfo {
  id: string;
  name: string;
  /** Color palette index (team color, 0..5). */
  color: number;
  ready: boolean;
  /** Team number (player order); -1 for spectators. */
  team: number;
  connected: boolean;
  role: Role;
  muted: boolean;
  /** Gold left and number of units placed during the placement phase. */
  gold: number;
  units: number;
}

export interface LobbySettings {
  mapMode: 'random' | 'fixed';
  map: MapSpec;
  mapSeed: number;
  /** 0: automatic, based on the player count. */
  mapSize: number;
  gold: number;
  /** Placement time (s); 0: until everyone is ready. */
  placeSecs: number;
  openPlacement: boolean;
  comedyPhysics: boolean;
  comedyVisual: boolean;
  /** Rarities that cannot be bought (disabled by the host). */
  banned: Rarity[];
}

export interface GameInit {
  spec: MapSpec;
  seed: number;
  size: number;
  gold: number;
  teams: number;
  openPlacement: boolean;
  comedyPhysics: boolean;
  comedyVisual: boolean;
  banned: Rarity[];
  /** Gold cost per unit kind (computed by the host; everyone uses the same table). */
  costs: number[];
  /** Player ids in team order (team = index). */
  teamPlayers: string[];
}

export interface BattleStart {
  init: GameInit;
  simSeed: number;
  /** Flat list: team, kind, x, y (sorted by unit id). */
  layout: number[];
}

export interface LobbyState {
  code: string;
  phase: Phase;
  hostId: string;
  players: PlayerInfo[];
  settings: LobbySettings;
  locked: boolean;
  /** Placing: time left (s, -1 = unlimited). */
  placeLeft: number;
  init?: GameInit;
}

export interface PlaceItem {
  /** Client-side temporary id (to match replies). */
  cid: number;
  kind: number;
  x: number;
  y: number;
}
export interface PlacedItem {
  id: number;
  cid: number;
  team: number;
  kind: number;
  x: number;
  y: number;
}

export type RejectReason = 'full' | 'password' | 'version' | 'started' | 'kicked' | 'closed' | 'name';

/** Client -> host. */
export type ClientMsg =
  | { t: 'join'; name: string; color: number; pass?: string; spectator?: boolean; version: number; token?: string }
  | { t: 'profile'; name: string; color: number }
  | { t: 'ready'; ready: boolean }
  | { t: 'chat'; text: string }
  | { t: 'presence'; x: number; y: number; ctx: 'world' | 'page'; act?: string }
  | { t: 'place'; items: PlaceItem[] }
  | { t: 'unplace'; ids: number[] }
  | { t: 'check'; step: number; hash: number }
  | { t: 'settings'; settings: Partial<LobbySettings>; password?: string | null }
  | { t: 'kick'; id: string }
  | { t: 'mute'; id: string; on: boolean }
  | { t: 'start' }
  | { t: 'cmd'; speed?: number; paused?: boolean }
  | { t: 'rematch' }
  | { t: 'leave' };

/**
 * Why a placement was refused. These are stable codes on the wire; the receiving client translates them
 * (`online.reason.<code>`).
 * busy: not allowed right now; invalid: unknown unit; unbuyable: unit cannot be bought; banned: rarity disabled;
 * zone: outside the team zone; gold: not enough gold; cap: unit cap reached; close: too close to another unit.
 */
export type PlaceFailReason = 'busy' | 'invalid' | 'unbuyable' | 'banned' | 'zone' | 'gold' | 'cap' | 'close';

/** Why a session ended (stable codes, translated by the UI as `online.reason.<code>`). */
export type CloseReason = 'closed' | 'kicked' | 'lost' | 'serverLost';

/** Host -> client. */
export type ServerMsg =
  | { t: 'welcome'; you: string; token: string; state: LobbyState; start?: BattleStart }
  | { t: 'reject'; reason: RejectReason }
  | { t: 'state'; state: LobbyState }
  | { t: 'kicked'; reason: 'kicked' }
  | { t: 'chat'; id: string; name: string; text: string; ts: number }
  | { t: 'presence'; id: string; x: number; y: number; ctx: 'world' | 'page'; act?: string }
  | { t: 'placed'; owner: string; items: PlacedItem[] }
  | { t: 'placeFail'; cids: number[]; reason: PlaceFailReason }
  | { t: 'unplaced'; owner: string; ids: number[] }
  | { t: 'start'; start: BattleStart }
  | { t: 'tick'; step: number; speed: number; paused: boolean }
  | { t: 'resync'; step: number; data: string }
  | { t: 'result'; winner: number; alive: number[] }
  | { t: 'closed' };

export type Msg = ClientMsg | ServerMsg;

/** The configuration from which all clients build the same Battle out of a BattleStart. */
export function battleConfig(s: BattleStart): BattleConfig {
  return {
    mode: 'custom',
    perTeam: 0,
    teamCount: s.init.teams,
    mapSize: s.init.size,
    env: true,
    kite: true,
    terrainSeed: s.init.seed,
    map: s.init.spec,
    comedy: s.init.comedyPhysics,
    layout: new Float32Array(s.layout),
  };
}

export function cleanName(raw: string): string {
  const s = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX);
  return s || 'Player';
}

/** Lobby code: 6 characters, without easily confused ones (0/O, 1/I). */
export function makeCode(rnd: () => number = Math.random): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += A[Math.floor(rnd() * A.length) % A.length];
  return c;
}

export function b64encode(u8: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Simple password digest (so plain text does not travel over the network; not real security, only a barrier). */
export function passHash(p: string): string {
  let h = 2166136261;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

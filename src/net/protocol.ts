import type { BattleConfig } from '../sim/battle';
import type { MapSpec } from '../sim/mapSpec';
import type { Rarity } from '../sim/data/troops';
import type { GameModeId } from '../sim/modes/types';

/** Protocol version: a client with a different version cannot join the lobby. Bumped for wire changes and also when simulation or map generation results change (v11: valley gates, path costs, chase watchdog; v12: game modes, result scores; v13: VIP mode, vip/vipSet messages, BattleStart.vips; v14: Siege mode, siegeDefender setting / GameInit field, structure unit kind; v15: Horde mode with allied teams, startFail message; v16: Lane Conquest mode, lanes map layout, StartFailReason lanesNeedTwoTeams), because lockstep needs identical results. */
export const PROTOCOL = 16;
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
  /** Game mode rules ('classic' by default). */
  gameMode: GameModeId;
  /** Siege mode: team index of the defender (the lobby setting; the host clamps it into 0..teams-1 when the game starts). */
  siegeDefender: number;
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
  /** Game mode rules of this battle. */
  gameMode: GameModeId;
  /** Siege mode: team index of the defender, always 0..teams-1 (0 in other modes). */
  siegeDefender: number;
  /** Gold cost per unit kind (computed by the host; everyone uses the same table). */
  costs: number[];
  /** Player ids in team order (team = index). */
  teamPlayers: string[];
}

export interface BattleStart {
  init: GameInit;
  simSeed: number;
  /** Packed start layout, sorted by unit id: 10 bytes per unit (u8 team, u8 kind, f32 x, f32 y), base64. Use `layoutOf()`. */
  layout: string;
  /**
   * VIP mode: per team index (length = init.teams) the layout unit index (position order in `layoutOf()`) of the team's VIP chosen
   * during placement, -1 when the team did not choose (the sim auto-picks). Always present; all -1 in other modes.
   */
  vips: number[];
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
  /** Placement: mark one of the sender's own placed units (id = PlacedItem.id) as the team's VIP; -1 clears the choice. */
  | { t: 'vip'; id: number }
  | { t: 'check'; step: number; hash: number }
  | { t: 'settings'; settings: Partial<LobbySettings>; password?: string | null }
  | { t: 'kick'; id: string }
  | { t: 'mute'; id: string; on: boolean }
  | { t: 'start' }
  | { t: 'cmd'; speed?: number; paused?: boolean; comedyVisual?: boolean }
  | { t: 'rematch' }
  | { t: 'lobby' }
  | { t: 'leave' };

/**
 * Why a placement was refused. These are stable codes on the wire; the receiving client translates them
 * (`online.reason.<code>`).
 * busy: not allowed right now; invalid: unknown unit; unbuyable: unit cannot be bought; banned: rarity disabled;
 * zone: outside the team zone; gold: not enough gold; cap: unit cap reached; close: too close to another unit.
 */
export type PlaceFailReason = 'busy' | 'invalid' | 'unbuyable' | 'banned' | 'zone' | 'gold' | 'cap' | 'close' | 'unreachable';

/**
 * Why the host's 'start' was refused (stable codes, translated by the UI as `online.reason.<code>`).
 * hordeTooManyTeams: Horde mode needs a team index for the horde, so at most HORDE_MAX_HUMANS (5) players can start it.
 * lanesNeedTwoTeams: Lane Conquest is a two-team mode, so it only starts with exactly 2 players.
 */
export type StartFailReason = 'hordeTooManyTeams' | 'lanesNeedTwoTeams';

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
  /** The host's own 'start' was refused (sent to the host only; the room stays in the lobby). */
  | { t: 'startFail'; reason: StartFailReason }
  | { t: 'unplaced'; owner: string; ids: number[] }
  /** The host refused to remove these units (the player is ready or placement is over): the client restores them. */
  | { t: 'unplaceFail'; ids: number[] }
  /** The sender's own team VIP unit id (-1: none). Sent after every change, as the answer to a refused 'vip', after a rematch and when (re)joining during placement. */
  | { t: 'vipSet'; id: number }
  | { t: 'start'; start: BattleStart }
  | { t: 'tick'; step: number; speed: number; paused: boolean }
  /** The host switched the comedy look during the battle (look only; every client follows). */
  | { t: 'comedyView'; on: boolean }
  | { t: 'resync'; step: number; data: string }
  | { t: 'result'; winner: number; alive: number[]; /** Points per team of the game mode (hill); absent for classic. */ scores?: number[] }
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
    rules: s.init.gameMode,
    siegeDefender: s.init.siegeDefender,
    layout: layoutOf(s),
    vips: Array.isArray(s.vips) ? s.vips.slice(0, s.init.teams) : undefined,
  };
}

export function cleanName(raw: string): string {
  const s = (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX);
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

/** Packs units (already sorted by id) into the compact wire form of `BattleStart.layout`. */
export function packLayout(units: ReadonlyArray<{ team: number; kind: number; x: number; y: number }>): string {
  const buf = new Uint8Array(units.length * 10);
  const dv = new DataView(buf.buffer);
  units.forEach((u, i) => {
    buf[i * 10] = u.team;
    buf[i * 10 + 1] = u.kind;
    dv.setFloat32(i * 10 + 2, u.x, true);
    dv.setFloat32(i * 10 + 6, u.y, true);
  });
  return b64encode(buf);
}

let layoutCache: { key: string; arr: Float32Array } | null = null;

/** The start layout as the simulation wants it: flat team, kind, x, y per unit (Float32, identical on every client). */
export function layoutOf(s: { layout: string }): Float32Array {
  if (layoutCache && layoutCache.key === s.layout) return layoutCache.arr;
  const buf = b64decode(s.layout);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = Math.floor(buf.length / 10);
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    arr[i * 4] = buf[i * 10];
    arr[i * 4 + 1] = buf[i * 10 + 1];
    arr[i * 4 + 2] = dv.getFloat32(i * 10 + 2, true);
    arr[i * 4 + 3] = dv.getFloat32(i * 10 + 6, true);
  }
  layoutCache = { key: s.layout, arr };
  return arr;
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

import type { BattleConfig } from '../sim/battle';
import type { MapSpec } from '../sim/mapSpec';
import type { Rarity } from '../sim/data/troops';

/** Protokol surumu: uyusmayan istemci lobiye giremez. */
export const PROTOCOL = 2;
export const MAX_PLAYERS = 6;
export const NAME_MAX = 16;
export const CHAT_MAX = 200;
/** Placement kalinligi: ayni takimin birimleri arasi en kucuk uzaklik (editor MIN_GAP ile uyumlu). */
export const PLACE_GAP = 0.85;
/** Kopan oyuncunun geri baglanma suresi (sn). */
export const REJOIN_SECS = 60;

export type Role = 'player' | 'spectator';
export type Phase = 'lobby' | 'placing' | 'battle' | 'result';

export interface PlayerInfo {
  id: string;
  name: string;
  /** Renk paleti indeksi (takim rengi, 0..5). */
  color: number;
  ready: boolean;
  /** Takim numarasi (oyuncu sirasi); seyirci icin -1. */
  team: number;
  connected: boolean;
  role: Role;
  muted: boolean;
  /** Yerlestirme asamasinda kalan gold ve yerlestirilen birim sayisi. */
  gold: number;
  units: number;
}

export interface LobbySettings {
  mapMode: 'random' | 'fixed';
  map: MapSpec;
  mapSeed: number;
  /** 0: oyuncu sayisina gore otomatik. */
  mapSize: number;
  gold: number;
  /** Yerlestirme suresi (sn); 0: herkes hazir olana kadar. */
  placeSecs: number;
  level: number;
  openPlacement: boolean;
  comedyPhysics: boolean;
  comedyVisual: boolean;
  /** Alinamayacak nadirlikler (host kapatir). */
  banned: Rarity[];
}

export interface GameInit {
  spec: MapSpec;
  seed: number;
  size: number;
  level: number;
  gold: number;
  teams: number;
  openPlacement: boolean;
  comedyPhysics: boolean;
  comedyVisual: boolean;
  banned: Rarity[];
  /** Tur basina gold maliyeti (host hesaplar; herkes ayni tabloyu kullanir). */
  costs: number[];
  /** Oyuncu kimlikleri takim sirasiyla (team = indeks). */
  teamPlayers: string[];
}

export interface BattleStart {
  init: GameInit;
  simSeed: number;
  /** Duz liste: takim, tur, x, y (birim kimligine gore sirali). */
  layout: number[];
}

export interface LobbyState {
  code: string;
  phase: Phase;
  hostId: string;
  players: PlayerInfo[];
  settings: LobbySettings;
  locked: boolean;
  /** Placing: kalan sure (sn, -1 = sinirsiz). */
  placeLeft: number;
  init?: GameInit;
}

export interface PlaceItem {
  /** Istemci tarafi gecici kimlik (yanit eslemesi icin). */
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

/** Istemci -> host. */
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

/** Host -> istemci. */
export type ServerMsg =
  | { t: 'welcome'; you: string; token: string; state: LobbyState; start?: BattleStart }
  | { t: 'reject'; reason: RejectReason }
  | { t: 'state'; state: LobbyState }
  | { t: 'kicked'; reason: string }
  | { t: 'chat'; id: string; name: string; text: string; ts: number }
  | { t: 'presence'; id: string; x: number; y: number; ctx: 'world' | 'page'; act?: string }
  | { t: 'placed'; owner: string; items: PlacedItem[] }
  | { t: 'placeFail'; cids: number[]; reason: string }
  | { t: 'unplaced'; owner: string; ids: number[] }
  | { t: 'start'; start: BattleStart }
  | { t: 'tick'; step: number; speed: number; paused: boolean }
  | { t: 'resync'; step: number; data: string }
  | { t: 'result'; winner: number; alive: number[] }
  | { t: 'closed' };

export type Msg = ClientMsg | ServerMsg;

/** BattleStart'tan tum istemcilerin ayni Battle'i kurdugu yapilandirma. */
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
    level: s.init.level,
    comedy: s.init.comedyPhysics,
    layout: new Float32Array(s.layout),
  };
}

export function cleanName(raw: string): string {
  const s = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX);
  return s || 'Oyuncu';
}

/** Lobi kodu: karisabilecek harfler (0/O, 1/I) olmadan 6 karakter. */
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

/** Basit parola ozeti (ag uzerinde duz metin dolasmasin diye; guvenlik degil, sadece engel). */
export function passHash(p: string): string {
  let h = 2166136261;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

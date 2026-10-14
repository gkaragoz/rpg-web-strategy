import { Application } from 'pixi.js';
import { loc, t } from '../i18n';
import { placeableKinds } from '../app/armies';
import { teamColors } from '../app/state';
import { placeBlock, teamZones, type Zone } from '../net/economy';
import type { Session } from '../net/client';
import { HostSession } from '../net/client';
import { LockstepSim } from '../net/lockstepSim';
import { LockstepWorkerSim } from '../net/lockstepWorkerSim';
import { PLACE_GAP, battleConfig, layoutOf, type BattleStart, type PlaceItem } from '../net/protocol';
import { bakeAtlas, type Atlas } from '../render/atlas';
import { terrainFor, type BattleConfig } from '../sim/battle';
import { InlineSim } from '../sim/inlineSim';
import { PRESETS, type MapSpec } from '../sim/mapSpec';
import type { SimBackend } from '../sim/backend';
import { WorkerSim } from '../sim/workerSim';
import { KIND_OF_TROOP, LEGACY_COUNT, STATS, unitDisplayName } from '../sim/units';
import { atlasToGpu } from './atlasBridge';
import type { UnitsLike } from './billboards';
import { Controls, type Tool } from './controls';
import { fillFormations, type PlacedSoldier } from './formation';
import { View3D, type ZoneOverlay } from './scene3d';
import { hostRoom, teamColorsOf, watchRoom, type WatchVia } from './watch';

const DEFAULT_COLORS = teamColors('classic', 6);
let TEAM_COLORS = DEFAULT_COLORS;
const MAX_SOLDIERS = 30000;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** The soldiers of the editor as a static "units" view (the same writer renders them before and during the battle). */
class EditUnits implements UnitsLike {
  count = 0;
  kind = new Uint8Array(0);
  team = new Uint8Array(0);
  x = new Float32Array(0);
  y = new Float32Array(0);
  px = this.x;
  py = this.y;
  hp = new Float32Array(0);
  maxHp = new Float32Array(0);
  alive = new Uint8Array(0);
  facing = new Int8Array(0);
  moving = new Uint8Array(0);
  swing = new Float32Array(0);
  flash = new Float32Array(0);
  deathT = new Float32Array(0);
  status = new Uint8Array(0);

  set(list: PlacedSoldier[]): void {
    const n = list.length;
    if (n > this.kind.length) {
      const cap = Math.max(n, 1024);
      this.kind = new Uint8Array(cap);
      this.team = new Uint8Array(cap);
      this.x = new Float32Array(cap);
      this.y = new Float32Array(cap);
      this.px = this.x;
      this.py = this.y;
      this.hp = new Float32Array(cap).fill(1);
      this.maxHp = new Float32Array(cap).fill(1);
      this.alive = new Uint8Array(cap).fill(1);
      this.facing = new Int8Array(cap);
      this.moving = new Uint8Array(cap);
      this.swing = new Float32Array(cap);
      this.flash = new Float32Array(cap);
      this.deathT = new Float32Array(cap);
      this.status = new Uint8Array(cap);
    }
    list.forEach((s, i) => {
      this.kind[i] = s.kind;
      this.team[i] = s.team;
      this.x[i] = s.x;
      this.y[i] = s.y;
      this.facing[i] = s.team % 2 === 0 ? 1 : -1;
    });
    this.count = n;
  }
}

interface Settings {
  preset: string;
  seed: number;
  size: number;
  teams: number;
  perTeam: number;
  kind: number;
  team: number;
  brush: number;
  highlight: number;
  bars: boolean;
  numbers: boolean;
  particles: boolean;
}

const qp = new URLSearchParams(location.search);
const settings: Settings = {
  preset: qp.get('map') ?? 'pine-valley',
  seed: Number(qp.get('seed') ?? 1) || 1,
  size: Number(qp.get('size') ?? 56) || 56,
  teams: Math.min(6, Math.max(2, Number(qp.get('teams') ?? 2) || 2)),
  perTeam: Math.min(15000, Math.max(0, Number(qp.get('per') ?? 1500) || 0)),
  kind: 0,
  team: 0,
  brush: 3,
  highlight: -1,
  bars: true,
  numbers: qp.get('numbers') !== '0',
  particles: qp.get('fx') !== '0',
};

let pixi: Application | null = null;
let atlas: Atlas | null = null;
let atlasBiome = '';
let atlasColorKey = '';
const atlasKinds = new Set<number>();
let view!: View3D;
let controls!: Controls;
let terrain!: ReturnType<typeof terrainFor> & object;
let zones: Zone[] = [];
let placed: PlacedSoldier[] = [];
const editUnits = new EditUnits();
let sim: SimBackend | null = null;
let mode: 'edit' | 'battle' = 'edit';
let paused = false;
let speed = 1;
let seedCounter = 1;
let battleStep = 0;

/** Map of the room being watched (null: the preset chosen in the panel). */
let specOverride: MapSpec | null = null;
const specOf = (): MapSpec => specOverride ?? (PRESETS.find((p) => p.id === settings.preset) ?? PRESETS[0]).spec;
const configOf = (layout?: Float32Array): BattleConfig => ({ mode: 'custom', perTeam: 0, teamCount: settings.teams, mapSize: settings.size, env: true, kite: true, terrainSeed: settings.seed, map: specOf(), layout });

// ---- atlas ----

async function ensureAtlas(extra: Iterable<number> = []): Promise<void> {
  const need = new Set<number>([...Array.from({ length: LEGACY_COUNT }, (_, i) => i), settings.kind, ...extra]);
  for (const s of placed) need.add(s.kind);
  // The bone caller summons bone soldiers in battle: their texture must be in the atlas too.
  for (const k of [...need]) if (STATS[k]?.troop === 'bone-caller') need.add(KIND_OF_TROOP['bone-soldier']);
  const biome = specOf().biome;
  const colorKey = TEAM_COLORS.map((c) => c.main).join(',');
  let missing = biome !== atlasBiome || colorKey !== atlasColorKey;
  for (const k of need) if (!atlasKinds.has(k)) missing = true;
  if (!missing && atlas) return;
  if (!pixi) {
    pixi = new Application();
    await pixi.init({ width: 8, height: 8, preference: 'webgl', antialias: false, resolution: 1, backgroundAlpha: 0 });
  }
  for (const k of need) atlasKinds.add(k);
  const old = atlas;
  atlas = bakeAtlas(pixi.renderer, TEAM_COLORS, biome, atlasKinds);
  atlasBiome = biome;
  atlasColorKey = colorKey;
  view.setAtlas(atlasToGpu(pixi.renderer, atlas));
  old?.dispose();
}

// ---- world ----

function zoneTiles(zone: Zone): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < terrain.size; y++) for (let x = 0; x < terrain.size; x++) if (placeBlock(terrain, zone, x + 0.5, y + 0.5) === null) out.push([x, y]);
  return out;
}

async function buildWorld(): Promise<void> {
  stopSim();
  mode = 'edit';
  terrain = terrainFor(configOf())!;
  zones = teamZones(settings.size, settings.teams, terrain);
  view.setTerrain(terrain);
  placed = placed.filter((s) => s.team < settings.teams && zones[s.team] && placeBlock(terrain, zones[s.team], s.x, s.y) === null);
  await ensureAtlas();
  showZones(true);
  editUnits.set(placed);
  syncPanel();
  hostPushSettings();
}

function showZones(on: boolean): void {
  const ov: ZoneOverlay[] | null = on ? zones.map((z, i) => ({ team: i, color: TEAM_COLORS[i].main, tiles: zoneTiles(z) })) : null;
  view.setZones(ov);
}

// ---- editing ----

const hashKey = (x: number, y: number): number => Math.floor(x) * 4096 + Math.floor(y);
function occupied(grid: Map<number, PlacedSoldier[]>, team: number, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const list = grid.get(hashKey(x + dx, y + dy));
      if (list) for (const s of list) if (s.team === team && Math.hypot(s.x - x, s.y - y) < PLACE_GAP) return true;
    }
  }
  return false;
}

function paint(x: number, y: number, tool: 'place' | 'erase'): void {
  if (mode !== 'edit') return;
  if (watching && !playing()) return;
  const r = settings.brush;
  const net = watching && playing() ? watching.session : null;
  const myTeam = net?.model.me?.team ?? settings.team;
  if (tool === 'erase') {
    if (net) {
      const ids = [...net.model.placed.values()].filter((p) => p.team === myTeam && Math.hypot(p.x - x, p.y - y) <= Math.max(0.6, r)).map((p) => p.id);
      if (ids.length) net.send({ t: 'unplace', ids });
    }
    const keep = placed.filter((s) => Math.hypot(s.x - x, s.y - y) > Math.max(0.6, r));
    if (keep.length !== placed.length) placed = keep;
  } else {
    const zone = zones[myTeam];
    if (!zone) return;
    const sent: PlaceItem[] = [];
    const grid = new Map<number, PlacedSoldier[]>();
    for (const s of placed) {
      const k = hashKey(s.x, s.y);
      const l = grid.get(k);
      if (l) l.push(s);
      else grid.set(k, [s]);
    }
    const spots: Array<[number, number]> = r <= 0.7 ? [[x, y]] : [];
    if (spots.length === 0) {
      const step = PLACE_GAP + 0.15;
      for (let dy = -r; dy <= r; dy += step) for (let dx = -r; dx <= r; dx += step) if (dx * dx + dy * dy <= r * r) spots.push([x + dx, y + dy]);
    }
    for (const [sx, sy] of spots) {
      if (placed.length >= MAX_SOLDIERS) break;
      if (placeBlock(terrain, zone, sx, sy) !== null || occupied(grid, myTeam, sx, sy)) continue;
      const s = { team: myTeam, kind: settings.kind, x: sx, y: sy };
      placed.push(s);
      if (net) sent.push({ cid: cidCounter++, kind: s.kind, x: sx, y: sy });
      const k = hashKey(sx, sy);
      const l = grid.get(k);
      if (l) l.push(s);
      else grid.set(k, [s]);
    }
    if (net) for (let i = 0; i < sent.length; i += 80) net.send({ t: 'place', items: sent.slice(i, i + 80) });
  }
  void ensureAtlas().then(() => editUnits.set(placed));
  editUnits.set(placed);
  syncPanel();
}

/** Online fill: the formation of my team goes to the host in paced batches (guests are rate limited). */
let fillTimer: ReturnType<typeof setInterval> | null = null;
function fillOnline(): void {
  const w = watching;
  const me = w?.session.model.me;
  if (!w || !me || !playing() || !terrain) return;
  if (fillTimer) clearInterval(fillTimer);
  const mine = fillFormations(terrain, zones, settings.perTeam, settings.seed + me.team).filter((u) => u.team === me.team);
  const items: PlaceItem[] = mine.map((u) => ({ cid: cidCounter++, kind: u.kind, x: u.x, y: u.y }));
  let at = 0;
  const pump = (): void => {
    const room = playing() ? 1 : 0;
    if (!room || at >= items.length) {
      if (fillTimer) clearInterval(fillTimer);
      fillTimer = null;
      return;
    }
    const burst = w.host ? 40 : 1;
    for (let k = 0; k < burst && at < items.length; k++, at += 80) w.session.send({ t: 'place', items: items.slice(at, at + 80) });
  };
  fillTimer = setInterval(pump, 28);
  pump();
}

async function fill(): Promise<void> {
  if (watching) return fillOnline();
  if (mode !== 'edit') return;
  placed = fillFormations(terrain, zones, settings.perTeam, settings.seed);
  await ensureAtlas();
  editUnits.set(placed);
  syncPanel();
}

// ---- battle ----

function stopSim(): void {
  view?.clearFx();
  sim?.dispose();
  sim = null;
  $('banner').textContent = '';
}

async function startBattle(): Promise<void> {
  if (placed.length === 0) await fill();
  if (placed.length === 0) return;
  const layout = new Float32Array(placed.length * 4);
  placed.forEach((s, i) => {
    layout[i * 4] = s.team;
    layout[i * 4 + 1] = s.kind;
    layout[i * 4 + 2] = s.x;
    layout[i * 4 + 3] = s.y;
  });
  const cfg = configOf(layout);
  seedCounter = settings.seed;
  stopSim();
  showZones(false);
  sim = self.crossOriginIsolated ? await WorkerSim.create(cfg, seedCounter) : new InlineSim(cfg, seedCounter);
  sim.setSpeed(speed);
  sim.setPaused(paused);
  mode = 'battle';
  battleStep = 0;
  syncPanel();
}

function backToEdit(): void {
  stopSim();
  mode = 'edit';
  paused = false;
  showZones(true);
  editUnits.set(placed);
  syncPanel();
}

// ---- watching an online room ----

let watching: { session: Session; via: WatchVia; code: string; play: boolean; host: boolean } | null = null;
let cidCounter = 1;

/** True while joined as a player (not a spectator) and the room is placing. */
function playing(): boolean {
  const m = watching?.session.model;
  return !!watching?.play && m?.me?.role === 'player' && m.state?.phase === 'placing';
}
let watchSimStart: BattleStart | null = null;
let watchWorldKey = '';
let watchDirty = false;
let lastWatchRefresh = 0;
let watchBusy = false;
let watchRerun = false;

function setWatchStatus(text: string): void {
  $('w-status').textContent = text;
}

async function watchStart(code: string, play = false): Promise<void> {
  if (watching || !code.trim()) return;
  $<HTMLButtonElement>('w-go').disabled = true;
  try {
    const w = await watchRoom(code, `3D ${10 + Math.floor(Math.random() * 90)}`, (k) => setWatchStatus(t(k)), play);
    watching = { ...w, code: code.trim().toUpperCase(), play, host: false };
    w.session.model.listeners.push((m) => {
      watchMessage(m.t);
    });
    void watchKick();
  } catch (e) {
    const key = e instanceof Error && e.message.startsWith('v3.') ? e.message : 'v3.err.joinFail';
    setWatchStatus(t(key));
  }
  syncPanel();
}

/** Reacts to a server message of the room: placement changes only mark the armies dirty, ticks and cursors are ignored. */
function watchMessage(type: string): void {
  if (type === 'placed' || type === 'unplaced' || type === 'placeFail') watchDirty = true;
  else if (type !== 'tick' && type !== 'presence' && type !== 'chat') void watchKick();
}

async function hostStart(kind: 'lan' | 'net'): Promise<void> {
  if (watching) return;
  $<HTMLButtonElement>('w-hostbtn').disabled = true;
  try {
    const h = await hostRoom(kind, `3D ${10 + Math.floor(Math.random() * 90)}`, (k) => setWatchStatus(t(k)));
    watching = { ...h, play: true, host: true };
    h.session.model.listeners.push((m) => watchMessage(m.t));
    hostPushSettings();
    void watchKick();
  } catch (e) {
    setWatchStatus(t(e instanceof Error && e.message.startsWith('v3.') ? e.message : 'v3.err.host'));
  }
  syncPanel();
}

/** Sends the panel's rules (map, seed, size, gold, open placement) to the room; changing them makes the guests ready up again. */
function hostPushSettings(): void {
  const w = watching;
  if (!w?.host || w.session.model.state?.phase !== 'lobby') return;
  w.session.send({
    t: 'settings',
    settings: { mapMode: 'fixed', map: specOf(), mapSeed: settings.seed, mapSize: settings.size, gold: Number($<HTMLSelectElement>('h-gold').value), openPlacement: $<HTMLInputElement>('h-open').checked },
  });
}

function hostBegin(): void {
  if (watching?.host) watching.session.send({ t: 'start' });
}

function watchLeave(message = ''): void {
  const w = watching;
  watching = null;
  watchSimStart = null;
  watchWorldKey = '';
  watchDirty = false;
  if (w) {
    try {
      w.session.leave();
    } catch {
      /* connection already gone */
    }
  }
  specOverride = null;
  TEAM_COLORS = DEFAULT_COLORS;
  placed = [];
  stopSim();
  setWatchStatus(message);
  syncPanel();
  void buildWorld();
}

/** Follows the room: lobby phase -> map and placed armies -> the battle itself. */
async function watchKick(): Promise<void> {
  if (watchBusy) {
    watchRerun = true;
    return;
  }
  watchBusy = true;
  try {
    do {
      watchRerun = false;
      await watchReconcile();
    } while (watchRerun);
  } finally {
    watchBusy = false;
  }
}

async function watchReconcile(): Promise<void> {
  const w = watching;
  if (!w) return;
  const m = w.session.model;
  if (m.closedReason) {
    watchLeave(m.closedReason === 'lost' || m.closedReason === 'serverLost' ? t('v3.err.dropped') : t('v3.err.closed'));
    return;
  }
  const st = m.state;
  if (!st) return;
  const init = st.init ?? m.start?.init;
  if (st.phase === 'lobby' || !init) {
    if (sim) {
      stopSim();
      watchSimStart = null;
      mode = 'edit';
    }
    setWatchStatus(w.host ? t('v3.st.hostLobby', { code: w.code }) : t('v3.st.lobby'));
    syncPanel();
    return;
  }
  const colors = teamColorsOf(init, st);
  const key = [JSON.stringify(init.spec), init.seed, init.size, init.teams, colors.map((c) => c.main).join(',')].join('|');
  if (key !== watchWorldKey) {
    watchWorldKey = key;
    specOverride = init.spec;
    settings.seed = init.seed;
    settings.size = init.size;
    settings.teams = init.teams;
    TEAM_COLORS = colors;
    placed = [];
    await buildWorld();
    if (watching !== w) return;
  }
  if (st.phase === 'placing') {
    if (sim) {
      stopSim();
      watchSimStart = null;
      mode = 'edit';
      showZones(true);
    }
    const me = m.me;
    if (watching?.play && me?.role === 'player') {
      settings.team = me.team;
      setWatchStatus(t('v3.st.placingGold', { gold: me.gold, units: me.units }));
    } else setWatchStatus(t('v3.st.placing'));
    watchDirty = true;
    syncPanel();
    return;
  }
  const start = m.start;
  if (start && start !== watchSimStart) {
    watchSimStart = start;
    await watchBattle(w, start);
  }
  if (watching === w) setWatchStatus(t(st.phase === 'result' ? 'v3.st.result' : 'v3.st.battle'));
  syncPanel();
}

async function watchBattle(w: NonNullable<typeof watching>, start: BattleStart): Promise<void> {
  stopSim();
  showZones(false);
  const lay = layoutOf(start);
  const kinds = new Set<number>();
  for (let i = 0; i < lay.length; i += 4) kinds.add(lay[i + 1]);
  await ensureAtlas(kinds);
  if (watching !== w || watchSimStart !== start) return;
  const cfg = battleConfig(start);
  const opts = { host: w.session instanceof HostSession ? w.session.lobby : undefined, send: (msg: Parameters<Session['send']>[0]) => w.session.send(msg) };
  let next: SimBackend | null = null;
  if (self.crossOriginIsolated) {
    try {
      next = await LockstepWorkerSim.createLockstep(cfg, start.simSeed, w.session.model, opts);
    } catch (e) {
      console.warn('[3d] sim worker unavailable, running on the main thread', e);
    }
  }
  next ??= new LockstepSim(cfg, start.simSeed, w.session.model, opts);
  if (watching !== w || watchSimStart !== start) {
    next.dispose();
    return;
  }
  sim = next;
  mode = 'battle';
  battleStep = 0;
  syncPanel();
}

/** Placement phase: shows every army the room lets spectators see. */
function watchRefreshPlaced(): void {
  if (!watching || mode !== 'edit') return;
  placed = [...watching.session.model.placed.values()].map((p) => ({ team: p.team, kind: p.kind, x: p.x, y: p.y }));
  void ensureAtlas().then(() => editUnits.set(placed));
  editUnits.set(placed);
}

// ---- panel ----

function sizeOptions(): number[] {
  return [40, 56, 80, 120, 160, 256];
}

function buildPanel(): void {
  const kinds = placeableKinds();
  $('panel').innerHTML = `
    <h1>${t('v3.title')}</h1>
    <div class="row"><a href="../">${t('v3.back')}</a></div>
    <div class="row"><label>${t('v3.watch')}</label><input id="w-code" type="text" maxlength="8" placeholder="${t('v3.code')}" autocapitalize="characters" autocomplete="off" /><button id="w-go" type="button"></button></div>
    <div class="row" id="w-playrow"><label>${t('v3.play')}</label><input id="w-play" type="checkbox" /></div>
    <div class="row" id="w-hostrow"><select id="w-net"><option value="net">${t('v3.net.internet')}</option><option value="lan">${t('v3.net.lan')}</option></select><button id="w-hostbtn" type="button">${t('v3.hostBtn')}</button></div>
    <div id="host-ui" hidden>
      <div class="row"><label>${t('v3.gold')}</label><select id="h-gold">${[500, 1000, 2000, 5000, 10000, 100000, 1000000, 10000000].map((g) => `<option value="${g}">${g}</option>`).join('')}</select></div>
      <div class="row"><label>${t('v3.open')}</label><input id="h-open" type="checkbox" checked /></div>
      <div class="row"><button id="h-start" class="primary" type="button">${t('v3.startRoom')}</button></div>
    </div>
    <div class="row" id="w-ready-row" hidden><button id="w-ready" class="primary" type="button"></button><button id="w-fill" type="button">${t('v3.fill')}</button></div>
    <div class="row"><span id="w-status" class="hint"></span></div>
    <div class="row"><label>${t('v3.map')}</label><select id="p-map">${PRESETS.map((p) => `<option value="${p.id}">${loc(p.name)}</option>`).join('')}<option value="__room" hidden>${t('v3.roomMap')}</option></select></div>
    <div class="row"><label>${t('v3.seed')}</label><input id="p-seed" type="number" min="1" max="999999" /><button id="p-rnd" type="button">${t('v3.random')}</button></div>
    <div class="row"><label>${t('v3.size')}</label><select id="p-size">${sizeOptions().map((s) => `<option value="${s}">${t(`v3.sizeOpt.${s}`)}</option>`).join('')}</select></div>
    <div class="row"><label>${t('v3.teams')}</label><select id="p-teams">${[2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></div>
    <div id="edit-ui">
      <div class="row"><label>${t('v3.perTeam')}</label><input id="p-per" type="range" min="0" max="15000" step="100" /><span id="p-per-v"></span></div>
      <div class="row solo-only"><button id="p-fill" type="button">${t('v3.fill')}</button><button id="p-clear" type="button">${t('v3.clear')}</button></div>
      <div class="row solo-only"><label>${t('v3.team')}</label><select id="p-team"></select></div>
      <div class="row"><label>${t('v3.unit')}</label><select id="p-kind">${kinds.map((k) => `<option value="${k}">${unitDisplayName(k)}</option>`).join('')}</select></div>
      <div class="row seg" id="p-tool"><button type="button" data-tool="look">${t('v3.tool.look')}</button><button type="button" data-tool="place">${t('v3.tool.place')}</button><button type="button" data-tool="erase">${t('v3.tool.erase')}</button></div>
      <div class="row"><label>⌀</label><input id="p-brush" type="range" min="0" max="12" step="1" /></div>
      <div class="row solo-only"><button id="p-start" class="primary" type="button">${t('v3.start')}</button></div>
    </div>
    <div id="battle-ui" hidden>
      <div class="row"><button id="b-pause" type="button"></button><button id="b-restart" type="button">${t('v3.restart')}</button><button id="b-edit" type="button">${t('v3.edit')}</button></div>
      <div class="row"><label>${t('v3.speed')}</label><div class="seg" id="b-speed"><button type="button" data-s="1">1×</button><button type="button" data-s="2">2×</button><button type="button" data-s="4">4×</button></div></div>
    </div>
    <div class="row"><label>${t('v3.highlight')}</label><select id="p-hl"></select></div>
    <div class="row"><label>${t('v3.bars')}</label><input id="p-bars" type="checkbox" /></div>
    <div class="row"><label>${t('v3.numbers')}</label><input id="p-numbers" type="checkbox" /></div>
    <div class="row"><label>${t('v3.fx')}</label><input id="p-fx" type="checkbox" /></div>
    <div class="help">${t('v3.help')}</div>`;
  const sel = (id: string): HTMLSelectElement => $<HTMLSelectElement>(id);
  const inp = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
  sel('p-map').onchange = () => {
    settings.preset = sel('p-map').value;
    void buildWorld();
  };
  inp('p-seed').onchange = () => {
    settings.seed = Math.max(1, Math.floor(Number(inp('p-seed').value) || 1));
    void buildWorld();
  };
  $('p-rnd').onclick = () => {
    settings.seed = 1 + Math.floor(Math.random() * 999999);
    void buildWorld();
  };
  sel('p-size').onchange = () => {
    settings.size = Number(sel('p-size').value);
    placed = [];
    void buildWorld();
  };
  sel('p-teams').onchange = () => {
    settings.teams = Number(sel('p-teams').value);
    void buildWorld();
  };
  inp('p-per').oninput = () => {
    settings.perTeam = Number(inp('p-per').value);
    $('p-per-v').textContent = String(settings.perTeam);
  };
  $('w-go').onclick = () => (watching ? watchLeave() : void watchStart(inp('w-code').value, inp('w-play').checked));
  $('w-hostbtn').onclick = () => void hostStart(sel('w-net').value as 'lan' | 'net');
  $('h-start').onclick = hostBegin;
  $('h-gold').onchange = hostPushSettings;
  $('h-open').onchange = hostPushSettings;
  $('w-fill').onclick = fillOnline;
  $('w-ready').onclick = () => {
    const me = watching?.session.model.me;
    if (watching && me) watching.session.send({ t: 'ready', ready: !me.ready });
  };
  $('p-fill').onclick = () => void fill();
  $('p-clear').onclick = () => {
    placed = [];
    editUnits.set(placed);
    syncPanel();
  };
  sel('p-team').onchange = () => (settings.team = Number(sel('p-team').value));
  sel('p-kind').onchange = () => {
    settings.kind = Number(sel('p-kind').value);
    void ensureAtlas();
  };
  document.querySelectorAll<HTMLElement>('#p-tool button').forEach((b) =>
    b.addEventListener('click', () => {
      controls.tool = b.dataset.tool as Tool;
      syncPanel();
    }),
  );
  inp('p-brush').oninput = () => (settings.brush = Number(inp('p-brush').value));
  $('p-start').onclick = () => void startBattle();
  $('b-pause').onclick = () => {
    paused = !paused;
    sim?.setPaused(paused);
    syncPanel();
  };
  $('b-restart').onclick = () => {
    if (watching?.host) {
      watching.session.send({ t: 'rematch' });
      return;
    }
    if (!sim) return;
    $('banner').textContent = '';
    seedCounter = settings.seed;
    void sim.reset(seedCounter);
  };
  $('b-edit').onclick = () => (watching?.host ? watching.session.send({ t: 'lobby' }) : backToEdit());
  document.querySelectorAll<HTMLElement>('#b-speed button').forEach((b) =>
    b.addEventListener('click', () => {
      speed = Number(b.dataset.s);
      sim?.setSpeed(speed);
      syncPanel();
    }),
  );
  sel('p-hl').onchange = () => {
    settings.highlight = Number(sel('p-hl').value);
  };
  inp('p-bars').onchange = () => (settings.bars = inp('p-bars').checked);
  inp('p-numbers').onchange = () => (settings.numbers = inp('p-numbers').checked);
  inp('p-fx').onchange = () => (settings.particles = inp('p-fx').checked);
  $('toggle').onclick = () => $('panel').classList.toggle('hidden');
  if (matchMedia('(max-width: 760px)').matches) $('panel').classList.add('hidden');
}

function syncPanel(): void {
  const sel = (id: string): HTMLSelectElement => $<HTMLSelectElement>(id);
  const inp = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
  sel('p-map').value = specOverride ? '__room' : settings.preset;
  inp('p-seed').value = String(settings.seed);
  sel('p-size').value = String(settings.size);
  sel('p-teams').value = String(settings.teams);
  inp('p-per').value = String(settings.perTeam);
  $('p-per-v').textContent = String(settings.perTeam);
  sel('p-team').innerHTML = Array.from({ length: settings.teams }, (_, i) => `<option value="${i}">${t('v3.team')} ${i + 1}</option>`).join('');
  sel('p-team').value = String(Math.min(settings.team, settings.teams - 1));
  sel('p-kind').value = String(settings.kind);
  sel('p-hl').innerHTML = `<option value="-1">${t('v3.none')}</option>` + Array.from({ length: settings.teams }, (_, i) => `<option value="${i}">${t('v3.team')} ${i + 1}</option>`).join('');
  sel('p-hl').value = String(settings.highlight);
  inp('p-brush').value = String(settings.brush);
  inp('p-bars').checked = settings.bars;
  inp('p-numbers').checked = settings.numbers;
  inp('p-fx').checked = settings.particles;
  const isPlaying = playing();
  document.querySelectorAll<HTMLElement>('.solo-only').forEach((e) => (e.hidden = !!watching));
  const hosting = !!watching?.host;
  // The host picks the map in the lobby (a local preview until the game starts).
  const lobbyHost = hosting && watching?.session.model.state?.phase === 'lobby';
  $('edit-ui').hidden = mode !== 'edit' || (!!watching && !isPlaying);
  $('w-playrow').hidden = !!watching;
  const rm = watching?.session.model;
  const canReady = !!watching?.play && rm?.me?.role === 'player' && (rm.state?.phase === 'lobby' || rm.state?.phase === 'placing');
  $('w-ready-row').hidden = !canReady;
  if (canReady) $('w-ready').textContent = watching?.session.model.me?.ready ? t('v3.unready') : t('v3.ready');
  $('battle-ui').hidden = mode !== 'battle' || (!!watching && !watching.host);
  $('host-ui').hidden = !watching?.host || watching.session.model.state?.phase !== 'lobby';
  $('w-hostrow').hidden = !!watching;
  $('w-go').textContent = watching ? t('v3.leaveBtn') : t('v3.watchBtn');
  $<HTMLButtonElement>('w-go').disabled = false;
  inp('w-code').disabled = !!watching;
  inp('w-play').disabled = !!watching;
  for (const id of ['p-map', 'p-seed', 'p-rnd', 'p-size']) ($(id) as HTMLInputElement).disabled = !!watching && !lobbyHost;
  ($('p-teams') as HTMLInputElement).disabled = !!watching;
  $('b-pause').textContent = paused ? t('v3.resume') : t('v3.pause');
  document.querySelectorAll<HTMLElement>('#p-tool button').forEach((b) => b.classList.toggle('on', b.dataset.tool === controls.tool));
  document.querySelectorAll<HTMLElement>('#b-speed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === speed));
}

// ---- main loop ----

let fps = 60;
let statTimer = 0;

function frame(now: number, last: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  fps += (1 / Math.max(0.001, dt) - fps) * 0.08;
  controls.update(dt);
  if (watching && !watching.host) {
    const rm = watching.session.model;
    if (rm.paused !== paused || rm.speed !== speed) {
      paused = rm.paused;
      speed = rm.speed;
      syncPanel();
    }
  }
  if (watchDirty && now - lastWatchRefresh > 150) {
    lastWatchRefresh = now;
    watchDirty = false;
    watchRefreshPlaced();
  }
  view.setOutlineColor(settings.highlight >= 0 ? TEAM_COLORS[settings.highlight].main : 0xffffff);
  const focus = settings.highlight;
  if (mode === 'battle' && sim) {
    const info = sim.frame(dt);
    battleStep += info.steps;
    view.setUnits(sim.units as UnitsLike, info.alpha, dt, focus, settings.bars);
    view.setProjectiles(sim.projectiles, info.alpha * sim.stepDt);
    view.updateFx(sim.events, dt * (paused ? 0 : 1), settings.numbers, settings.particles);
    sim.events.length = 0;
    if (sim.winner !== -1) $('banner').textContent = sim.winner >= 0 ? t('v3.winner', { n: sim.winner + 1 }) : t('v3.draw');
  } else {
    view.updateFx([], dt, false, false);
    view.setUnits(editUnits, 1, dt, focus, false);
    view.setProjectiles({ count: 0 } as never, 0);
  }
  view.render(dt);
  statTimer += dt;
  if (statTimer > 0.25) {
    statTimer = 0;
    updateStats();
  }
}

function updateStats(): void {
  let text = `${fps.toFixed(0)} fps`;
  if (mode === 'battle' && sim) {
    const alive = sim.alivePerTeam.slice(0, settings.teams).join(' / ');
    const st = sim.stats();
    const ms = st.steps > 0 ? st.totalMs / st.steps : 0;
    text += `\n${t('v3.stats.units', { n: sim.units.count })} · ${alive} ${t('v3.stats.alive')}`;
    text += `\n${t('v3.stats.sim', { ms: ms.toFixed(1), rate: Math.round(1 / sim.stepDt) })}`;
  } else {
    text += `\n${t('v3.stats.units', { n: placed.length })}`;
  }
  text += `\n${t('v3.stats.draw', { draws: view.info.draws, tris: view.info.tris })}`;
  $('stats').textContent = text;
}

async function main(): Promise<void> {
  document.title = t('v3.page');
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2')) {
    $('loading').textContent = t('v3.noWebgl');
    return;
  }
  $('loading').textContent = t('v3.loading');
  view = new View3D($('view'));
  controls = new Controls(view, {
    onHover: (hit) => view.setHover(hit, controls.tool === 'look' ? 0 : Math.max(0.5, settings.brush), controls.tool === 'erase' ? 0xff6666 : 0xffffff),
    onPaint: (hit, tool) => paint(hit.x, hit.z, tool),
    onStrokeEnd: () => undefined,
  });
  buildPanel();
  await buildWorld();
  window.addEventListener('resize', () => view.resize());
  $('loading').remove();
  let last = performance.now();
  const loop = (now: number): void => {
    frame(now, last);
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  syncPanel();
  // Automation / sharing links: ?auto=1 fills the armies and starts the battle.
  const watchCode = qp.get('watch');
  const hostKind = qp.get('host');
  if (hostKind === 'lan' || hostKind === 'net') {
    void hostStart(hostKind);
  } else if (watchCode) {
    $<HTMLInputElement>('w-code').value = watchCode;
    $<HTMLInputElement>('w-play').checked = qp.get('play') === '1';
    void watchStart(watchCode, qp.get('play') === '1');
  } else if (qp.get('auto')) {
    await fill();
    await startBattle();
    if (qp.get('speed')) {
      speed = Number(qp.get('speed')) || 1;
      sim?.setSpeed(speed);
      syncPanel();
    }
  }
  (window as unknown as { __v3: unknown }).__v3 = { view, get watching() { return watching; }, settings, get sim() { return sim; }, get placed() { return placed; }, get zones() { return zones; }, get terrain() { return terrain; }, fill, startBattle, buildWorld, };
}

void main();

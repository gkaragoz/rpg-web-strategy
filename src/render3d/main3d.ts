import { Application } from 'pixi.js';
import { loc, t } from '../i18n';
import { placeableKinds } from '../app/armies';
import { teamColors } from '../app/state';
import { placeBlock, teamZones, type Zone } from '../net/economy';
import { PLACE_GAP } from '../net/protocol';
import { bakeAtlas, type Atlas } from '../render/atlas';
import { terrainFor, type BattleConfig } from '../sim/battle';
import { InlineSim } from '../sim/inlineSim';
import { PRESETS, type MapSpec } from '../sim/mapSpec';
import type { SimBackend } from '../sim/backend';
import { WorkerSim } from '../sim/workerSim';
import { LEGACY_COUNT, unitDisplayName } from '../sim/units';
import { atlasToGpu } from './atlasBridge';
import type { UnitsLike } from './billboards';
import { Controls, type Tool } from './controls';
import { fillFormations, type PlacedSoldier } from './formation';
import { View3D, type ZoneOverlay } from './scene3d';

const TEAM_COLORS = teamColors('classic', 6);
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
};

let pixi: Application | null = null;
let atlas: Atlas | null = null;
let atlasBiome = '';
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

const specOf = (): MapSpec => (PRESETS.find((p) => p.id === settings.preset) ?? PRESETS[0]).spec;
const configOf = (layout?: Float32Array): BattleConfig => ({ mode: 'custom', perTeam: 0, teamCount: settings.teams, mapSize: settings.size, env: true, kite: true, terrainSeed: settings.seed, map: specOf(), layout });

// ---- atlas ----

async function ensureAtlas(extra: Iterable<number> = []): Promise<void> {
  const need = new Set<number>([...Array.from({ length: LEGACY_COUNT }, (_, i) => i), settings.kind, ...extra]);
  for (const s of placed) need.add(s.kind);
  const biome = specOf().biome;
  let missing = biome !== atlasBiome;
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
  const r = settings.brush;
  if (tool === 'erase') {
    const keep = placed.filter((s) => Math.hypot(s.x - x, s.y - y) > Math.max(0.6, r));
    if (keep.length !== placed.length) placed = keep;
  } else {
    const zone = zones[settings.team];
    if (!zone) return;
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
      if (placeBlock(terrain, zone, sx, sy) !== null || occupied(grid, settings.team, sx, sy)) continue;
      const s = { team: settings.team, kind: settings.kind, x: sx, y: sy };
      placed.push(s);
      const k = hashKey(sx, sy);
      const l = grid.get(k);
      if (l) l.push(s);
      else grid.set(k, [s]);
    }
  }
  void ensureAtlas().then(() => editUnits.set(placed));
  editUnits.set(placed);
  syncPanel();
}

async function fill(): Promise<void> {
  if (mode !== 'edit') return;
  placed = fillFormations(terrain, zones, settings.perTeam, settings.seed);
  await ensureAtlas();
  editUnits.set(placed);
  syncPanel();
}

// ---- battle ----

function stopSim(): void {
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

// ---- panel ----

function sizeOptions(): number[] {
  return [40, 56, 80, 120, 160, 256];
}

function buildPanel(): void {
  const kinds = placeableKinds();
  $('panel').innerHTML = `
    <h1>${t('v3.title')}</h1>
    <div class="row"><a href="../">${t('v3.back')}</a></div>
    <div class="row"><label>${t('v3.map')}</label><select id="p-map">${PRESETS.map((p) => `<option value="${p.id}">${loc(p.name)}</option>`).join('')}</select></div>
    <div class="row"><label>${t('v3.seed')}</label><input id="p-seed" type="number" min="1" max="999999" /><button id="p-rnd" type="button">${t('v3.random')}</button></div>
    <div class="row"><label>${t('v3.size')}</label><select id="p-size">${sizeOptions().map((s) => `<option value="${s}">${t(`v3.sizeOpt.${s}`)}</option>`).join('')}</select></div>
    <div class="row"><label>${t('v3.teams')}</label><select id="p-teams">${[2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></div>
    <div id="edit-ui">
      <div class="row"><label>${t('v3.perTeam')}</label><input id="p-per" type="range" min="0" max="15000" step="100" /><span id="p-per-v"></span></div>
      <div class="row"><button id="p-fill" type="button">${t('v3.fill')}</button><button id="p-clear" type="button">${t('v3.clear')}</button></div>
      <div class="row"><label>${t('v3.team')}</label><select id="p-team"></select></div>
      <div class="row"><label>${t('v3.unit')}</label><select id="p-kind">${kinds.map((k) => `<option value="${k}">${unitDisplayName(k)}</option>`).join('')}</select></div>
      <div class="row seg" id="p-tool"><button type="button" data-tool="look">${t('v3.tool.look')}</button><button type="button" data-tool="place">${t('v3.tool.place')}</button><button type="button" data-tool="erase">${t('v3.tool.erase')}</button></div>
      <div class="row"><label>⌀</label><input id="p-brush" type="range" min="0" max="12" step="1" /></div>
      <div class="row"><button id="p-start" class="primary" type="button">${t('v3.start')}</button></div>
    </div>
    <div id="battle-ui" hidden>
      <div class="row"><button id="b-pause" type="button"></button><button id="b-restart" type="button">${t('v3.restart')}</button><button id="b-edit" type="button">${t('v3.edit')}</button></div>
      <div class="row"><label>${t('v3.speed')}</label><div class="seg" id="b-speed"><button type="button" data-s="1">1×</button><button type="button" data-s="2">2×</button><button type="button" data-s="4">4×</button></div></div>
    </div>
    <div class="row"><label>${t('v3.highlight')}</label><select id="p-hl"></select></div>
    <div class="row"><label>${t('v3.bars')}</label><input id="p-bars" type="checkbox" /></div>
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
    if (!sim) return;
    $('banner').textContent = '';
    seedCounter = settings.seed;
    void sim.reset(seedCounter);
  };
  $('b-edit').onclick = backToEdit;
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
  $('toggle').onclick = () => $('panel').classList.toggle('hidden');
  if (matchMedia('(max-width: 760px)').matches) $('panel').classList.add('hidden');
}

function syncPanel(): void {
  const sel = (id: string): HTMLSelectElement => $<HTMLSelectElement>(id);
  const inp = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
  sel('p-map').value = settings.preset;
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
  $('edit-ui').hidden = mode !== 'edit';
  $('battle-ui').hidden = mode !== 'battle';
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
  view.setOutlineColor(settings.highlight >= 0 ? TEAM_COLORS[settings.highlight].main : 0xffffff);
  const focus = settings.highlight;
  if (mode === 'battle' && sim) {
    const info = sim.frame(dt);
    battleStep += info.steps;
    view.setUnits(sim.units as UnitsLike, info.alpha, dt, focus, settings.bars);
    view.setProjectiles(sim.projectiles, info.alpha * sim.stepDt);
    sim.events.length = 0;
    if (sim.winner !== -1) $('banner').textContent = sim.winner >= 0 ? t('v3.winner', { n: sim.winner + 1 }) : t('v3.draw');
  } else {
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
  if (qp.get('auto')) {
    await fill();
    await startBattle();
    if (qp.get('speed')) {
      speed = Number(qp.get('speed')) || 1;
      sim?.setSpeed(speed);
      syncPanel();
    }
  }
  (window as unknown as { __v3: unknown }).__v3 = { view, settings, get sim() { return sim; }, get placed() { return placed; }, fill, startBattle, buildWorld, };
}

void main();

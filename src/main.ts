import { Application } from 'pixi.js';
import './app/studio.css';
import { BattleScene, type BattleOptions } from './app/battle';
import { Editor } from './app/editor';
import { loadState, saveState, teamColors } from './app/state';
import { Studio } from './app/studio';
import { WorldView } from './app/world';
import { Camera } from './camera';
import { bakeAtlas, type Atlas } from './render/atlas';
import { AudioSystem } from './render/audio';
import { UnitView } from './render/unitView';
import type { BattleConfig } from './sim/battle';
import { StatsPanel } from './ui/stats';

// Benchmark ve hata ayiklama parametreleri (stüdyoyu atlar):
//   ?bench=10000&auto=30  -> takim basina birim, otomatik rapor
//   ?sim=main             -> sim'i worker yerine ana thread'de calistir
//   ?debug=1              -> takilma izleme katmani (H/T/P/G tuslari)
//   ?env=off  ?kite=off  ?seed=3  -> stüdyo ayarlarini gecici olarak ezer
const loading = document.getElementById('loading');

/** Beklenmeyen hata: kullaniciya kisa, kapanan bir bildirim; konsola ayrinti. */
function showError(msg: string): void {
  const el = document.createElement('div');
  el.className = 'err-toast';
  el.textContent = `Beklenmeyen bir hata oluştu: ${msg.slice(0, 160)}`;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 6000);
}
window.addEventListener('error', (e) => {
  console.error(e.error ?? e.message);
  showError(e.message || 'bilinmeyen');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  showError(String((e.reason as Error)?.message ?? e.reason));
});

const params = new URLSearchParams(location.search);
const benchPer = params.has('bench') ? Math.max(10, Number(params.get('bench')) || 10000) : 0;
const autoSeconds = Number(params.get('auto')) || 0;
const isBench = benchPer > 0;
const canUseWorker = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
// ?debug=1: takilma izleme katmani sim'e dogrudan erisim ister, bu yuzden sim ana thread'de calisir.
const debugParam = params.get('debug') === '1';
/** Debug acik mi (URL veya secenek) ve sim worker'da mi calisacak. */
const debugOn = (): boolean => debugParam || state.options.debug;
const workerOk = (): boolean => params.get('sim') !== 'main' && canUseWorker && !debugOn();

const app = new Application();
await app.init({
  resizeTo: window,
  background: 0x1a2332,
  antialias: !isBench,
  preference: 'webgl',
  resolution: Math.min(window.devicePixelRatio || 1, 2),
  autoDensity: true,
});
document.body.prepend(app.canvas);
app.ticker.stop();

// WebGL baglami kaybolursa (GPU sifirlama, bellek baskisi) sayfayi yenilemeyi oner.
app.canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = '<div>Grafik bağlamı kayboldu.<br /><button type="button" id="reload-btn">Sayfayı yenile</button></div>';
  document.body.appendChild(el);
  el.querySelector('#reload-btn')!.addEventListener('click', () => location.reload());
});

const state = loadState();
if (params.get('env') === 'off') state.env = false;
if (params.get('kite') === 'off') state.kite = false;
if (Number(params.get('seed'))) state.seed = Number(params.get('seed'));

const world = new WorldView();
app.stage.addChild(world.root);
const camera = new Camera(app.canvas, state.mapSize);
const stats = new StatsPanel(document.getElementById('stats')!);
const banner = document.getElementById('banner')!;
const studioRoot = document.getElementById('studio')!;
const hudRoot = document.getElementById('hud')!;

let atlasBiome = state.map.biome;
let atlas: Atlas = bakeAtlas(app.renderer, teamColors(state.palette, state.teamCount), atlasBiome);
const getAtlas = (): Atlas => atlas;

const audio = new AudioSystem();
function applyOptions(): void {
  audio.enabled = state.options.sound;
  audio.setVolume(state.options.volume);
  UnitView.barMode = state.options.bars;
}
applyOptions();
// Tarayici politikasi: ses baglami ilk kullanici hareketinde acilir.
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => audio.unlock());

const battle = new BattleScene({
  app,
  world,
  camera,
  getAtlas,
  stats,
  hudRoot,
  banner,
  audio,
  isSoundOn: () => state.options.sound,
  isDebugOn: debugOn,
  toggleDebug: () => {
    state.options.debug = !debugOn();
    saveState(state);
    studio.render();
    void restartBattle();
  },
  toggleSound: () => {
    state.options.sound = !state.options.sound;
    saveState(state);
    applyOptions();
    return state.options.sound;
  },
});
let mode: 'studio' | 'battle' = 'studio';

function studioConfig(): BattleConfig {
  return { mode: 'custom', perTeam: 0, teamCount: state.teamCount, mapSize: state.mapSize, env: state.env, kite: state.kite, terrainSeed: state.seed, map: state.map, stats: state.stats };
}

function layoutArray(): Float32Array {
  const a = new Float32Array(state.units.length * 4);
  state.units.forEach((u, i) => {
    a[i * 4] = u.team;
    a[i * 4 + 1] = u.kind;
    a[i * 4 + 2] = u.x;
    a[i * 4 + 3] = u.y;
  });
  return a;
}

// ---- Stüdyo ----

let studio!: Studio;
const editor = new Editor({
  app,
  world,
  camera,
  state,
  getAtlas,
  onChange: () => studio?.render(),
  toast: (m) => studio?.toast(m),
});

/** Harita ayarlari (tohum/cevre/boyut) degisince dunyayi yeniler, gecersiz askerleri tasir. */
function rebuildWorld(announce: boolean): void {
  if (state.map.biome !== atlasBiome) rebakeAtlas();
  world.rebuild(studioConfig(), atlas, true);
  camera.setMap(world.mapSize);
  camera.fit(app.screen.width, app.screen.height);
  editor.setSeedForRandom(state.seed);
  const r = editor.revalidate();
  if (announce && (r.moved > 0 || r.removed > 0)) {
    studio.toast(`Harita değişti: ${r.moved} asker taşındı${r.removed ? `, ${r.removed} asker kaldırıldı` : ''}.`);
  }
  studio.render();
}

let mapTimer: number | undefined;
function onMapChange(): void {
  window.clearTimeout(mapTimer);
  mapTimer = window.setTimeout(() => rebuildWorld(true), 120);
}

/** Takim sayisi/palet degisti: atlas'i yeni renklerle yeniden pisirir. */
function rebakeAtlas(): void {
  const old = atlas;
  atlasBiome = state.map.biome;
  atlas = bakeAtlas(app.renderer, teamColors(state.palette, state.teamCount), atlasBiome);
  world.setAtlas(atlas, true);
  editor.refreshSprites();
  old.dispose();
}

function onPaletteChange(): void {
  rebakeAtlas();
  studio.render();
}

studio = new Studio(studioRoot, {
  state,
  editor,
  onMapChange,
  onPaletteChange,
  onStart: () => void startBattle(),
  onOptions: applyOptions,
  onBench: (per) => {
    location.search = `?bench=${per}&auto=30`;
  },
});

function battleOptions(): BattleOptions {
  const colors = teamColors(state.palette, state.teamCount);
  return {
    config: { ...studioConfig(), layout: layoutArray() },
    colors,
    speed: state.speed,
    bench: false,
    autoSeconds: 0,
    useWorker: workerOk(),
    seed: state.seed,
    fx: state.options.fx,
    numbers: state.options.numbers,
    debug: debugOn(),
    onEdit: () => void backToStudio(),
  };
}

/** Savasi ayni dizilimle bastan kurar (debug anahtari sim turunu degistirir). */
async function restartBattle(): Promise<void> {
  mode = 'studio';
  battle.exit();
  await battle.enter(battleOptions());
  stats.setShown(true);
  mode = 'battle';
}

async function startBattle(): Promise<void> {
  saveState(state);
  const opts = battleOptions();
  studio.hide();
  editor.exit();
  await battle.enter(opts);
  stats.setShown(true);
  mode = 'battle';
}

async function backToStudio(): Promise<void> {
  battle.exit();
  mode = 'studio';
  rebuildWorld(false);
  camera.fit(app.screen.width, app.screen.height);
  stats.setShown(false);
  studio.show();
  editor.enter();
}

async function startBench(): Promise<void> {
  studioRoot.hidden = true;
  await battle.enter({
    config: { mode: 'bench', perTeam: benchPer, env: state.env, terrainSeed: state.seed, map: state.map, kite: state.kite },
    colors: teamColors('classic', 2),
    speed: 1,
    bench: true,
    autoSeconds,
    useWorker: workerOk(),
    seed: 1,
    fx: 'off',
    numbers: false,
    onEdit: () => {
      location.search = '';
    },
  });
  mode = 'battle';
}

// ---- Ana dongu ----

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const frameMs = now - last;
  last = now;
  if (mode === 'battle') {
    battle.frame(now, frameMs);
    return;
  }
  const dt = frameMs > 500 ? 0 : Math.min(frameMs / 1000, 0.1);
  camera.update(dt);
  camera.apply(world.root, app.screen.width, app.screen.height);
  app.render();
}

(window as unknown as { __camera: Camera; __audio: AudioSystem }).__camera = camera;
(window as unknown as { __audio: AudioSystem }).__audio = audio;

if (isBench) {
  await startBench();
} else {
  rebuildWorld(false);
  if (state.fresh) {
    editor.quickFormation();
    state.fresh = false;
    saveState(state);
  }
  stats.setShown(false);
  studio.show();
  editor.enter();
}
loading?.remove();
requestAnimationFrame(frame);

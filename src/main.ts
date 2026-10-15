import { Application, Container, Rectangle } from 'pixi.js';
import { getLang, t } from './i18n';
import { startBottomStack } from './app/bottomStack';
import { mountLangPicker } from './app/langPicker';
import { UnitPreview, type FrameJob } from './app/unitPreview';
import './app/studio.css';
import { BattleScene, type BattleOptions } from './app/battle';
import { Editor } from './app/editor';
import { Nav, screenOfState, type NavScreen, type NavVerdict } from './app/nav';
import { OnlineApp, canRejoin } from './app/online/online';
import { resumeAction, resumeScreenFor, saveResume, takeResume } from './app/resume';
import type { Battle3D, CameraBackend, WorldBackend } from './contracts/backend';
import { loadState, saveState, saveStateNow, teamColors } from './app/state';
import { Studio } from './app/studio';
import { WorldView } from './app/world';
import { Camera } from './camera';
import { bakeAtlas, type Atlas } from './render/atlas';
import { AudioSystem } from './render/audio';
import { comedy } from './render/comedy';
import { POSE_STATES, UnitView, type TeamColors } from './render/unitView';
import type { BattleConfig } from './sim/battle';
import { KIND_OF_TROOP, LEGACY_COUNT, STATS } from './sim/units';
import { STATS_DEFAULT_SHOWN, StatsPanel } from './ui/stats';
import { debugEnabled, setDebug } from './debug';
import { healTextures, installErrorHandlers, watchGlContext } from './app/errors';

// Benchmark and debug parameters (they skip the studio):
//   ?bench=10000&auto=30  -> units per team, automatic report
//   ?sim=main             -> run the sim on the main thread instead of a worker
//   ?debug=1              -> stall-tracking overlay (H/T/P/G keys)
//   ?comedy=1             -> comedy mode (visuals + physics)
//   ?env=off  ?kite=off  ?seed=3  -> temporarily override studio settings
//   ?lang=en|tr           -> interface language
const loading = document.getElementById('loading');
document.documentElement.lang = getLang();
document.title = t('sys.title');
if (loading?.firstElementChild) loading.firstElementChild.textContent = t('sys.loading');

/** Heals the whole stage once it exists (assigned after the Pixi app is created). */
let healScene: () => number = () => 0;
installErrorHandlers(() => healScene());

const params = new URLSearchParams(location.search);
const benchPer = params.has('bench') ? Math.max(10, Number(params.get('bench')) || 10000) : 0;
const autoSeconds = Number(params.get('auto')) || 0;
const isBench = benchPer > 0;
// iOS Safari ignores user-scalable=no: stop the page-level pinch zoom (the canvas handles its own pinch).
for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(g, (e) => e.preventDefault());
const canUseWorker = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
// ?debug=1: the stall-tracking overlay needs direct access to the sim, so the sim runs on the main thread.
const debugParam = params.get('debug') === '1';
// ?comedy=1: comedy visuals + comedy physics are both on.
const comedyParam = params.get('comedy') === '1';
const comedyVisualOn = (): boolean => comedyParam || state.options.comedyVisual;
const comedyPhysicsOn = (): boolean => comedyParam || state.options.comedyPhysics;
/** Whether debug is on (URL or option) and whether the sim will run in a worker. */
const debugOn = (): boolean => debugParam || state.options.debug;
const workerOk = (): boolean => params.get('sim') !== 'main' && canUseWorker && !debugOn();

const app = new Application();
try {
  await app.init({
    resizeTo: window,
    background: 0x1a2332,
    antialias: !isBench,
    preference: 'webgl',
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
} catch (err) {
  // No WebGL at all (disabled, blocklisted GPU, headless without a GPU): say so instead of leaving "Loading..." on screen forever.
  if (loading?.firstElementChild) loading.firstElementChild.textContent = t('sys.gl.unavailable');
  throw err;
}
document.body.prepend(app.canvas);
app.ticker.stop();

watchGlContext(app.canvas, () => healScene());
healScene = (): number => healTextures(app.stage);

const state = loadState();
if (params.get('env') === 'off') state.env = false;
if (params.get('kite') === 'off') state.kite = false;
if (Number(params.get('seed'))) state.seed = Number(params.get('seed'));

// 2D (PixiJS isometric) or 3D (Three.js) world: ?view=3d / ?view=2d override the saved option. The rest of the app only sees the backend interfaces.
let view3d = params.get('view') === '3d' || (params.get('view') !== '2d' && state.options.view === '3d');
let world!: WorldBackend;
let camera!: CameraBackend;
let battle3d: Battle3D | undefined;
let render!: (dt: number) => void;
if (view3d) {
  // The Pixi app stays alive (atlas baking, unit icons, previews) but is hidden: the Three.js canvas takes its place.
  try {
    app.canvas.style.display = 'none';
    const m = await import('./render3d/world3d');
    const w3 = new m.World3D(app.renderer, document.body);
    world = w3;
    camera = w3.camera3d;
    battle3d = w3;
    // The visible canvas is the Three.js one: if its context is lost for good the player must be told (three.js re-uploads everything itself on restore).
    watchGlContext(w3.canvas, () => healScene());
    render = (dt) => {
      w3.camera3d.update(dt);
      w3.render(dt);
    };
  } catch (err) {
    // WebGL context for Three.js could not be created (too many contexts, driver refusal) or the 3D chunk failed to load: use the 2D view.
    console.error(err);
    view3d = false;
    app.canvas.style.display = '';
    for (const c of Array.from(document.querySelectorAll('canvas'))) if (c !== app.canvas) c.remove();
    document.querySelectorAll('.cam3d').forEach((el) => el.remove());
    const note = document.createElement('div');
    note.className = 'err-toast';
    note.textContent = t('sys.gl.no3d');
    document.body.appendChild(note);
    window.setTimeout(() => note.remove(), 9000);
  }
}
if (!view3d) {
  const w2 = new WorldView(app.canvas);
  app.stage.addChild(w2.root);
  const c2 = new Camera(app.canvas, state.mapSize);
  world = w2;
  camera = c2;
  render = (dt) => {
    c2.update(dt);
    c2.apply(w2.root, app.screen.width, app.screen.height);
    app.render();
  };
  setDebug('__camera', c2);
}
if (!isBench) {
  mountLangPicker({
    view: view3d ? '3d' : '2d',
    onView: (v) => {
      // The saved choice wins after the reload: drop a ?view= query so it does not override it.
      state.options.view = v;
      saveStateNow(state); // the debounced save would be lost by the reload
      const u = new URL(location.href);
      u.searchParams.delete('view');
      // Same entry, same history marker (location.replace would drop it and leave a bogus entry behind).
      history.replaceState(history.state, '', u.toString());
      location.reload();
    },
    // Switching reloads the page: remember the screen (restored on boot), then leave an active online session cleanly first (keeps the rejoin entry).
    beforeSwitch: () => {
      const screen = resumeScreenFor({ inOnlineSession: !!online?.inSession, inStudioOrSoloBattle: !online && (mode === 'studio' || mode === 'battle') });
      if (!online?.inSession) {
        saveResume(screen);
        return true;
      }
      if (!window.confirm(t('sys.lang.confirmLeave'))) return false;
      saveResume(screen);
      online.exit(true, true);
      return true;
    },
  });
  startBottomStack();
}
const stats = new StatsPanel(document.getElementById('stats')!);
const banner = document.getElementById('banner')!;
const studioRoot = document.getElementById('studio')!;
const hudRoot = document.getElementById('hud')!;

/** Types that need a texture in the atlas: the classics, placed ones, the selected type and its dependencies (Bone Caller -> Bone Soldier). */
function neededKinds(): Set<number> {
  const set = new Set<number>(Array.from({ length: LEGACY_COUNT }, (_, i) => i));
  for (const u of state.units) set.add(u.kind);
  set.add(state.selKind);
  for (const k of [...set]) if (STATS[k]?.troop === 'bone-caller') set.add(KIND_OF_TROOP['bone-soldier']);
  return set;
}

let atlasBiome = state.map.biome;
let atlas: Atlas = bakeAtlas(app.renderer, teamColors(state.palette, state.teamCount), atlasBiome, neededKinds());
const getAtlas = (): Atlas => atlas;
if (debugEnabled()) Object.defineProperty(window, '__atlas', { get: () => atlas, configurable: true }); // always the current atlas (tests)

const audio = new AudioSystem();
function applyOptions(): void {
  comedy.visual = comedyVisualOn();
  audio.enabled = state.options.sound;
  audio.setVolume(state.options.volume);
  UnitView.barMode = state.options.bars;
}
applyOptions();
// Browser policy: the audio context is unlocked on the first user gesture.
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => audio.unlock());

const battle = new BattleScene({
  icon: (kind, team) => renderIcon(kind, team),
  app,
  world,
  camera,
  battle3d,
  getAtlas,
  stats,
  hudRoot,
  banner,
  audio,
  isSoundOn: () => state.options.sound,
  isDebugOn: debugOn,
  // What is actually on screen: online battles use the lobby's setting, not the saved solo option.
  isComedyVisual: () => comedy.visual,
  toggleComedyVisual: () => {
    if (online) {
      // Online: a local view toggle only; the saved solo preference is left alone.
      comedy.visual = !comedy.visual;
      return comedy.visual;
    }
    state.options.comedyVisual = !comedyVisualOn();
    saveState(state);
    applyOptions();
    studio.render();
    return comedy.visual;
  },
  isComedyPhysics: comedyPhysicsOn,
  toggleComedyPhysics: () => {
    state.options.comedyPhysics = !comedyPhysicsOn();
    saveState(state);
    studio.render();
    void restartBattle();
  },
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
let mode: 'studio' | 'battle' | 'online' = 'studio';
let online: OnlineApp | null = null;
/** Online mode: icon colors (null: studio palette). */
let iconColors: TeamColors[] | null = null;

function studioConfig(): BattleConfig {
  return { mode: 'custom', perTeam: 0, teamCount: state.teamCount, mapSize: state.mapSize, env: state.env, kite: state.kite, terrainSeed: state.seed, map: state.map, comedy: comedyPhysicsOn(), stats: state.stats };
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

// ---- Studio ----

let studio!: Studio;
const editor = new Editor({
  world,
  camera,
  state,
  ensureAtlas: () => ensureAtlas(),
  onChange: () => studio?.render(),
  toast: (m) => studio?.toast(m),
});

/** Refreshes the world when map settings (seed/environment/size) change and moves invalid soldiers. */
function rebuildWorld(announce: boolean): void {
  if (state.map.biome !== atlasBiome) rebakeAtlas();
  world.rebuild(studioConfig(), atlas, true);
  camera.setMap(world.mapSize);
  camera.fit(world.size().w, world.size().h);
  editor.setSeedForRandom(state.seed);
  const r = editor.revalidate();
  if (announce && (r.moved > 0 || r.removed > 0)) {
    studio.toast(r.removed ? t('sys.mapChangedRemoved', { moved: r.moved, removed: r.removed }) : t('sys.mapChanged', { moved: r.moved }));
  }
  studio.render();
}

let mapTimer: number | undefined;
function onMapChange(): void {
  window.clearTimeout(mapTimer);
  mapTimer = window.setTimeout(() => rebuildWorld(true), 120);
}

/** Frees an old atlas a moment later: the frame in flight may still have its textures bound (Pixi warns when a bound texture is destroyed). */
function disposeLater(a: Atlas): void {
  window.setTimeout(() => a.dispose(), 300);
}

/** Team count/palette changed: re-bakes the atlas with the new colors. */
function rebakeAtlas(): void {
  const old = atlas;
  atlasBiome = state.map.biome;
  atlas = bakeAtlas(app.renderer, teamColors(state.palette, state.teamCount), atlasBiome, neededKinds());
  world.setAtlas(atlas, true);
  editor.refreshSprites();
  disposeLater(old);
  clearIcons();
}

/** Re-bakes the atlas if the textures of the needed types are missing. */
function ensureAtlas(): void {
  for (const k of neededKinds()) {
    if (!atlas.kinds.has(k)) {
      rebakeAtlas();
      return;
    }
  }
}

const iconCache = new Map<string, HTMLCanvasElement>();
/** Drops cached unit icons and animated preview sheets (palette or team colours changed). */
function clearIcons(): void {
  iconCache.clear();
  preview.clear();
}

/**
 * Starts rendering the attack-preview sheet of a unit: `frames` attack frames (swingProgress 0..1) plus one idle frame,
 * one frame per `step()` so the gallery never blocks the main thread.
 */
function beginFrameJob(kind: number, team: number, frames: number): FrameJob {
  const colors = iconColors ?? teamColors(state.palette, state.teamCount);
  const W = 120;
  const H = 150;
  const res = matchMedia('(pointer: coarse)').matches ? 1 : 1.25;
  const fw = Math.round(W * res);
  const fh = Math.round(H * res);
  const view = new UnitView(kind, colors[Math.min(team, colors.length - 1)], 0);
  view.update(POSE_STATES[0], 0, 1); // advance the spawn pop-in so frames are full size
  const box = new Container();
  const sc = 1.45 / Math.max(1, STATS[kind].scale * 0.75);
  view.root.position.set(W / 2, H - 18);
  view.root.scale.set(sc);
  box.addChild(view.root);
  const sheet = document.createElement('canvas');
  sheet.width = fw * (frames + 1);
  sheet.height = fh;
  const ctx = sheet.getContext('2d')!;
  let i = 0;
  let dead = false;
  const cleanup = (): void => {
    if (dead) return;
    dead = true;
    box.destroy({ children: true, context: true });
  };
  return {
    step() {
      if (dead) return null;
      const swing = i < frames ? i / (frames - 1) : -1;
      view.update({ ...POSE_STATES[0], swingProgress: swing }, 0, 0);
      const tex = app.renderer.generateTexture({ target: box, frame: new Rectangle(0, 0, W, H), resolution: res, antialias: true });
      const c = app.renderer.extract.canvas(tex) as HTMLCanvasElement;
      tex.destroy(true);
      ctx.drawImage(c, i * fw, 0, fw, fh);
      i++;
      if (i <= frames) return null;
      cleanup();
      return { canvas: sheet, frames, fw, fh };
    },
    cancel: cleanup,
  };
}
const preview = new UnitPreview({ begin: beginFrameJob });
/** Unit icon: drawn once from UnitView and cached; a copy is returned on every call. */
function renderIcon(kind: number, team: number): HTMLCanvasElement {
  const colors = iconColors ?? teamColors(state.palette, state.teamCount);
  const key = `${kind}:${team}:${iconColors ? iconColors.map((c) => c.main).join('.') : state.palette}`;
  let src = iconCache.get(key);
  if (!src) {
    const W = 120;
    const H = 150;
    const view = new UnitView(kind, colors[Math.min(team, colors.length - 1)], 0);
    view.update(POSE_STATES[0], 0, 0);
    const box = new Container();
    const sc = 1.45 / Math.max(1, STATS[kind].scale * 0.75);
    view.root.position.set(W / 2, H - 18);
    view.root.scale.set(sc);
    box.addChild(view.root);
    const tex = app.renderer.generateTexture({ target: box, frame: new Rectangle(0, 0, W, H), resolution: 1.5, antialias: true });
    src = app.renderer.extract.canvas(tex) as HTMLCanvasElement;
    tex.destroy(true);
    box.destroy({ children: true, context: true });
    iconCache.set(key, src);
  }
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  out.getContext('2d')!.drawImage(src, 0, 0);
  return out;
}

function onPaletteChange(): void {
  rebakeAtlas();
  studio.render();
}

studio = new Studio(studioRoot, {
  state,
  view3d,
  editor,
  onMapChange,
  onPaletteChange,
  onStart: () => void startBattle(),
  onOnline: () => startOnline(),
  onOptions: applyOptions,
  icon: renderIcon,
  preview,
  onKindPick: () => {
    ensureAtlas();
    saveState(state);
  },
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

/** Restarts the battle with the same layout (the debug toggle changes the sim kind). */
let restarting: Promise<void> | null = null;
function restartBattle(): Promise<void> {
  // Double clicks / key repeat: one restart at a time (an overlapping one would start a second worker).
  restarting ??= (async () => {
    try {
      ensureAtlas();
      const opts = battleOptions();
      opts.speed = battle.currentSpeed;
      opts.seed = battle.currentSeed;
      mode = 'studio';
      battle.exit();
      await enterBattle(opts);
    } finally {
      restarting = null;
    }
  })();
  return restarting;
}

/** Enters the battle; if the worker simulation cannot start, falls back to the main-thread simulation, and as a last resort back to the studio. */
async function enterBattle(opts: BattleOptions): Promise<void> {
  try {
    await battle.enter(opts);
  } catch (e) {
    console.error('[battle] could not start', e);
    battle.exit();
    try {
      await battle.enter({ ...opts, useWorker: false });
    } catch (e2) {
      console.error('[battle] fallback failed', e2);
      await backToStudio();
      return;
    }
  }
  stats.setShown(STATS_DEFAULT_SHOWN);
  mode = 'battle';
  nav.go('battle');
}

/** A double click / double tap on Start must not start two battles (the stale one would leave `mode` at 'battle' with no simulation). */
let startingBattle = false;
async function startBattle(): Promise<void> {
  if (startingBattle || mode !== 'studio') return;
  startingBattle = true;
  try {
    saveState(state);
    ensureAtlas();
    const opts = battleOptions();
    studio.hide();
    editor.exit();
    await enterBattle(opts);
  } finally {
    startingBattle = false;
  }
}

async function backToStudio(): Promise<void> {
  if (nav.cur === 'battle') nav.go('studio'); // (a Back press has already moved the history)
  battle.exit();
  mode = 'studio';
  rebuildWorld(false);
  camera.fit(world.size().w, world.size().h);
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

// ---- Online ----

function startOnline(joinCode?: string): void {
  if (online) return;
  saveState(state);
  studio.hide();
  editor.exit();
  mode = 'online';
  const app2 = online = new OnlineApp({
    world,
    camera,
    render,
    battle,
    stats,
    bake: (colors, biome, kinds) => {
      const old = atlas;
      atlasBiome = biome;
      atlas = bakeAtlas(app.renderer, colors, biome, kinds);
      world.setAtlas(atlas, true);
      disposeLater(old);
    },
    getAtlas,
    setIconColors: (c) => {
      iconColors = c;
      clearIcons();
    },
    icon: renderIcon,
    preview,
    battleDefaults: () => ({ fx: state.options.fx, numbers: state.options.numbers }),
    workerOk,
    setComedyVisual: (on) => {
      comedy.visual = on ?? comedyVisualOn();
    },
    onExit: (home) => {
      online = null;
      iconColors = null;
      rebakeAtlas();
      applyOptions();
      mode = 'studio';
      rebuildWorld(false);
      camera.fit(world.size().w, world.size().h);
      stats.setShown(false);
      if (location.hash.startsWith('#join=')) history.replaceState(history.state, '', location.pathname + location.search);
      if (home) startOnline();
      else {
        studio.show();
        editor.enter();
        nav.go('studio');
        studio.maybeStartTour();
      }
    },
  });
  app2.openMenu(joinCode);
  nav.go('home');
}

// ---- Browser history (Back/Forward behave like an app; see app/nav.ts) ----

/** Online screens follow the OnlineApp: the home menu is the base entry, a room (lobby / placement / battle) is one entry above it. */
function syncNav(): void {
  if (!online) return;
  if (online.screenName !== 'menu') nav.go('online');
  else if (!online.connecting) nav.go('home');
}

/** The player pressed Back/Forward (or the phone's system Back): move the app to the matching screen. */
async function navMove(target: NavScreen, from: NavScreen): Promise<NavVerdict> {
  if (startingBattle) return 'stay';
  if (target === 'home') {
    if (online?.inSession) {
      // Never drop a player silently: same confirmation pattern as the language switch.
      if (!window.confirm(t('sys.nav.confirmLeave'))) return 'stay';
      online.exit();
      return 'ok';
    }
    if (mode === 'battle') await backToStudio();
    if (!online) startOnline();
    return 'ok';
  }
  if (target === 'studio') {
    if (mode === 'battle') await backToStudio();
    else if (online && !online.inSession) online.exit(false, false, true);
    else if (online) return 'revert';
    return 'ok';
  }
  if (target === 'battle') {
    if (mode !== 'studio' || online) return 'revert';
    void startBattle();
    return 'ok';
  }
  // 'online' (forward into a room entry): a room cannot be restored from history.
  return from === 'home' ? 'revert' : 'stay';
}
const nav = new Nav(history, navMove);

// ---- Main loop ----

let last = performance.now();
/** Adaptive resolution: if frames have been slow for a long time during battle (weak device), the resolution drops step by step. */
let slowRun = 0;
let resTier = Math.min(window.devicePixelRatio || 1, 2);
function adaptResolution(frameMs: number): void {
  if (frameMs > 500) return; // returning from a background tab, etc.
  slowRun = frameMs > 38 ? slowRun + 1 : Math.max(0, slowRun - 2);
  if (slowRun < 90 || resTier <= 1 || state.options.fx !== 'auto') return;
  slowRun = 0;
  resTier = resTier > 1.5 ? 1.5 : 1;
  app.renderer.resize(app.screen.width, app.screen.height, resTier);
  studio.toast(t('sys.slow', { res: resTier }));
}
function frame(now: number): void {
  requestAnimationFrame(frame);
  const frameMs = now - last;
  last = now;
  if (mode !== 'studio') adaptResolution(frameMs);
  if (mode === 'online' && online) {
    syncNav();
    online.frame(now, frameMs);
    return;
  }
  if (mode === 'battle') {
    battle.frame(now, frameMs);
    return;
  }
  const dt = frameMs > 500 ? 0 : Math.min(frameMs / 1000, 0.1);
  render(dt);
}

setDebug('__audio', audio);
setDebug('__app', app); // diagnostics (scene walks, context-loss tests)

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
  // The game opens on the home page (the former online menu); "Your own simulation" leads to the studio.
  const joinHash = /^#join=([A-Za-z0-9]{4,8})$/.exec(location.hash);
  // A reload by the language / 2D-3D switch (or a plain refresh) comes back to the screen it was on (see app/resume.ts).
  const rec = takeResume();
  const histScreen = screenOfState(history.state);
  const act = joinHash ? 'home' : resumeAction(rec ?? (histScreen === 'studio' || histScreen === 'battle' ? { screen: 'studio', at: Date.now() } : histScreen === 'online' ? { screen: 'online', at: Date.now() } : null), canRejoin());
  if (act === 'studio') {
    // The studio is already shown; battles are not resumed.
    nav.boot('studio');
    studio.maybeStartTour();
  } else {
    startOnline(joinHash ? joinHash[1].toUpperCase() : undefined);
    if (act === 'rejoin' && (online as OnlineApp | null)?.rejoinLast()) nav.boot('online');
    else nav.boot('home');
  }
  nav.start(window);
  // A join link pasted into an already open page only changes the hash (no reload): put its code into the home page.
  window.addEventListener('hashchange', () => {
    const h = /^#join=([A-Za-z0-9]{4,8})$/.exec(location.hash);
    if (h && online && online.active && !online.inSession) online.openMenu(h[1].toUpperCase());
  });
}
loading?.remove();
requestAnimationFrame(frame);

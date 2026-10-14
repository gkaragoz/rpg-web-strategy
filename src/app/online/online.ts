import { t } from '../../i18n';
import { HostLobby } from '../../net/host';
import { GuestSession, HostSession, type Session } from '../../net/client';
import { LockstepSim } from '../../net/lockstepSim';
import { LockstepWorkerSim } from '../../net/lockstepWorkerSim';
import type { SimBackend } from '../../sim/backend';
import { battleConfig, layoutOf, makeCode, type ClientMsg, type GameInit, type ServerMsg } from '../../net/protocol';
import { PeerGuestTransport, PeerHostTransport } from '../../net/peerTransport';
import { RELAY_URL } from '../../net/relay';
import type { Transport } from '../../net/transport';
import { NetError, WsGuestTransport, WsHostTransport, lanUrl } from '../../net/wsTransport';
import type { Atlas } from '../../render/atlas';
import type { TeamColors } from '../../render/unitView';
import type { MapSpec } from '../../sim/mapSpec';
import { KIND_OF_TROOP, LEGACY_COUNT, STATS } from '../../sim/units';
import { STATS_DEFAULT_SHOWN, type StatsPanel } from '../../ui/stats';
import type { BattleOptions, BattleScene } from '../battle';
import { makeTeamColor } from '../state';
import type { CameraBackend, WorldBackend } from '../backend';
import { ConnBadge } from './badge';
import type { UnitPreview } from '../unitPreview';
import { ChatOverlay } from './chat';
import { CursorLayer, playerColor } from './cursors';
import { Placement } from './placement';
import { LobbyScreen, MenuScreen } from './screens';

const PROFILE_KEY = 'rpgweb.online.profile';
const LAST_KEY = 'rpgweb.online.last';

interface LastSession {
  code: string;
  token: string;
  name: string;
  color: number;
  at: number;
  /** A spectator comes back as a spectator (the host drops spectators when their connection ends). */
  spectator?: boolean;
}
/** Reconnect window (the host keeps the slot for 60 s); a small margin is left. */
const REJOIN_MS = 55000;
function loadLast(): LastSession | null {
  try {
    const l = JSON.parse(sessionStorage.getItem(LAST_KEY) ?? 'null') as LastSession | null;
    return l && typeof l.code === 'string' && Date.now() - l.at < REJOIN_MS ? l : null;
  } catch {
    return null;
  }
}
/** Whether a fresh rejoin entry exists (used by the page-reload resume). */
export function canRejoin(): boolean {
  return loadLast() !== null;
}
function saveLast(l: LastSession | null): void {
  try {
    if (l) sessionStorage.setItem(LAST_KEY, JSON.stringify(l));
    else sessionStorage.removeItem(LAST_KEY);
  } catch {
    /* storage unavailable */
  }
}
/** Internet relay (relay/ Cloudflare Worker): needs no NAT/TURN; if unreachable, PeerJS (WebRTC) is tried. */
export { RELAY_URL };
/** The first connection to the relay (TLS + Durable Object cold start) can be slower than LAN. */
const RELAY_TIMEOUT_MS = 12000;
/** `?relay=off` skips the internet relay (to test the direct WebRTC route). */
const relayOff = (): boolean => new URLSearchParams(location.search).get('relay') === 'off';
/** Shared join address of internet lobbies (Pages). */
const PAGES_URL = 'https://gkaragoz.github.io/rpg-web-strategy/';

export interface OnlineEnv {
  world: WorldBackend;
  camera: CameraBackend;
  /** Draws one frame of the world (camera update + render). */
  render(dt: number): void;
  battle: BattleScene;
  stats: StatsPanel;
  /** Re-bakes the atlas with the given team colors/biome/kinds and binds it to the world. */
  bake(colors: TeamColors[], biome: MapSpec['biome'], kinds: Set<number>): void;
  getAtlas(): Atlas;
  /** Temporary team colors for unit icons (null: normal). */
  setIconColors(c: TeamColors[] | null): void;
  icon(kind: number, team: number): HTMLCanvasElement;
  /** Shared attack-preview player for the unit gallery. */
  preview?: UnitPreview;
  battleDefaults(): Pick<BattleOptions, 'fx' | 'numbers'>;
  /** Leave online mode: back to the home page (`home`), or to the Battle Studio when the player chose their own simulation. */
  onExit(home: boolean): void;
  setComedyVisual(on: boolean | null): void;
  /** Whether the sim may run in a Web Worker (SharedArrayBuffer available, not in debug mode). */
  workerOk(): boolean;
}

type Screen = 'menu' | 'lobby' | 'placing' | 'battle';

function loadProfile(): { name: string; color: number } {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}') as { name?: string; color?: number };
    return { name: typeof p.name === 'string' ? p.name.slice(0, 16) : '', color: Number.isInteger(p.color) ? (p.color as number) : 0 };
  } catch {
    return { name: '', color: 0 };
  }
}
function saveProfile(name: string, color: number): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ name, color }));
  } catch {
    /* storage unavailable */
  }
}

/** Online mode orchestrator: menu -> lobby -> placement -> battle; switches screens according to the session state. */
export class OnlineApp {
  private readonly root: HTMLElement;
  private screen: Screen = 'menu';
  private menu: MenuScreen | null = null;
  private lobby: LobbyScreen | null = null;
  private placement: Placement | null = null;
  private chat: ChatOverlay | null = null;
  private badge: ConnBadge | null = null;
  private session: Session | null = null;
  /** Whether a lobby / match is active (the home menu alone is not a session). */
  get inSession(): boolean {
    return this.session !== null;
  }
  private cursors: CursorLayer | null = null;
  private colors: TeamColors[] = [];
  private biome: MapSpec['biome'] = 'forest';
  private inBattle = false;
  private sim: SimBackend | null = null;
  private kind: 'lan' | 'net' = 'lan';
  /** Transport in use ('lan' | 'relay' | 'webrtc'): for display and diagnostics. */
  private via = 'lan';
  private lastSaved = 0;
  private dead = false;
  private busy = false;
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly env: OnlineEnv) {
    this.root = document.createElement('div');
    this.root.id = 'online-root';
    document.body.appendChild(this.root);
  }

  get active(): boolean {
    return !this.dead;
  }

  /** The screen shown now (the app's history follows it; see `app/nav.ts`). */
  get screenName(): Screen {
    return this.screen;
  }

  /** A host/join attempt is in flight (the menu is still shown, but the player is on the way into a room). */
  get connecting(): boolean {
    return this.busy;
  }

  /** Rejoins the last room from the stored rejoin entry (page reload resume); false if there is none. Call after `openMenu`. */
  rejoinLast(): boolean {
    const l = loadLast();
    if (!l) return false;
    void this.join(l.name, l.color, l.code, '', !!l.spectator, l.token);
    return true;
  }

  // ---------------------------------------------------------------- menu

  openMenu(code?: string): void {
    this.menu?.destroy();
    const prof = loadProfile();
    this.menu = new MenuScreen(
      this.root,
      { name: prof.name, color: prof.color, code, last: loadLast()?.code },
      {
        onHost: (n, c, tp) => void this.host(n, c, tp),
        onJoin: (n, c, code2, pass, spec) => void this.join(n, c, code2, pass, spec),
        onOwn: () => this.exit(false, false, true),
        onRejoin: () => {
          const l = loadLast();
          if (l) void this.join(l.name, l.color, l.code, '', !!l.spectator, l.token);
        },
      },
      true,
    );
  }

  private fail(msg: string): void {
    this.menu?.setStatus('');
    this.menu?.setBusy(false);
    this.menu?.setError(msg);
    this.busy = false;
  }

  private async host(name: string, color: number, kind: 'lan' | 'net'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu?.setBusy(true);
    this.menu?.setError('');
    saveProfile(name, color);
    try {
      let tp: Transport | null = null;
      let code = '';
      this.menu?.setStatus(kind === 'net' ? t('online.st.signal') : t('online.st.lanHost'));
      for (let i = 0; i < 6 && !tp; i++) {
        code = makeCode();
        try {
          if (kind === 'net') {
            try {
              if (relayOff()) throw new NetError('failed', 'relay disabled');
              tp = await WsHostTransport.create(lanUrl(code, 'host', RELAY_URL), RELAY_TIMEOUT_MS);
              this.via = 'relay';
            } catch (re) {
              if (re instanceof NetError && re.code === 'taken') throw re;
              console.warn('[online] relay host error', re);
              this.menu?.setStatus(t('online.st.relayFail'));
              tp = await PeerHostTransport.create(code);
              this.via = 'webrtc';
            }
          } else {
            tp = await WsHostTransport.create(lanUrl(code, 'host'));
            this.via = 'lan';
          }
        } catch (e) {
          if (!(e instanceof NetError) || e.code !== 'taken') throw e;
        }
      }
      if (!tp) return this.fail(t('online.err.noCode'));
      const lobby = new HostLobby(tp, name, color, { code });
      this.kind = kind;
      const hs = new HostSession(lobby);
      // If the relay's/signaling server's host connection drops, the lobby is gone: tell the user.
      tp.onClose = () => {
        hs.model.closedReason = 'serverLost';
        hs.model.apply({ t: 'closed' });
      };
      this.attach(hs);
    } catch (e) {
      this.fail(
        e instanceof NetError && e.code === 'failed'
          ? kind === 'net'
            ? t('online.err.netHost')
            : t('online.err.lanHost')
          : t('online.err.generic', { msg: (e as Error).message }),
      );
    }
  }

  private async join(name: string, color: number, code: string, pass: string, spectator: boolean, token?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu?.setBusy(true);
    this.menu?.setError('');
    saveProfile(name, color);
    try {
      // LAN server first (same address), otherwise the internet (PeerJS).
      let tp: Transport;
      let kind: 'lan' | 'net' = 'lan';
      this.menu?.setStatus(t('online.st.lanFind'));
      try {
        tp = await WsGuestTransport.create(lanUrl(code, 'guest'));
        this.via = 'lan';
      } catch (e) {
        if (e instanceof NetError && (e.code === 'full' || e.code === 'taken')) throw e;
        kind = 'net';
        this.menu?.setStatus(t('online.st.relay'));
        try {
          if (relayOff()) throw new NetError('failed', 'relay disabled');
          tp = await WsGuestTransport.create(lanUrl(code, 'guest', RELAY_URL), RELAY_TIMEOUT_MS);
          this.via = 'relay';
        } catch (re) {
          if (re instanceof NetError && (re.code === 'full' || re.code === 'taken')) throw re;
          console.warn('[online] relay guest error', re);
          this.menu?.setStatus(t('online.st.webrtc'));
          tp = await PeerGuestTransport.create(code);
          this.via = 'webrtc';
        }
      }
      this.kind = kind;
      const s = new GuestSession(tp, { name, color, pass: pass || undefined, spectator, token });
      const ok = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(t('online.err.noReply')), 8000);
        s.model.listeners.push((m) => {
          if (m.t === 'welcome') {
            clearTimeout(timer);
            resolve(null);
          } else if (m.t === 'reject') {
            clearTimeout(timer);
            resolve(
              (['full', 'password', 'version', 'started', 'kicked', 'closed', 'name'] as string[]).includes(m.reason) ? t(`online.reject.${m.reason}`) : t('online.err.joinFail'),
            );
          } else if (m.t === 'closed') {
            clearTimeout(timer);
            resolve(t('online.err.dropped'));
          }
        });
      });
      if (ok) {
        s.leave();
        return this.fail(ok);
      }
      saveLast({ code, token: s.model.token, name, color, at: Date.now(), spectator });
      this.attach(s);
    } catch (e) {
      const detail = e instanceof NetError ? e.message : '';
      this.fail(
        e instanceof NetError
          ? e.code === 'noroom'
            ? t('online.err.noRoom')
            : e.code === 'full'
              ? t('online.err.full')
              : detail.startsWith('ice')
                ? t('online.err.ice')
                : t('online.err.server')
          : t('online.err.generic', { msg: (e as Error).message }),
      );
    }
  }

  // ---------------------------------------------------------------- session

  private attach(s: Session): void {
    this.busy = false;
    if (this.dead) {
      // The menu was closed while connecting: drop the late session.
      try {
        s.leave();
      } catch {
        /* zaten kapali */
      }
      return;
    }
    this.session = s;
    (window as unknown as { __session: Session }).__session = s; // diagnostics / scripted load tests (like __sim)
    this.menu?.destroy();
    this.menu = null;
    this.cursors = new CursorLayer(s.model, (m) => s.send(m));
    s.model.listeners.push((m) => this.onMessage(m));
    this.sync();
  }

  private onMessage(msg: ServerMsg): void {
    if (this.dead) return;
    const m = this.session?.model;
    if (!m) return;
    if (msg.t === 'closed' || msg.t === 'kicked') {
      // Network drop (the host did not close the lobby, you were not kicked): the token is kept and the menu opens with "Reconnect".
      const dropped = msg.t === 'closed' && !this.session?.isHost && m.closedReason === 'lost';
      this.toast(msg.t === 'kicked' ? t('online.toast.kicked', { reason: t(`online.reason.${msg.reason}`) }) : dropped ? t('online.toast.lost') : t(`online.reason.${m.closedReason ?? 'closed'}`));
      this.exit(dropped);
      return;
    }
    // Guest: the reconnect record's timestamp is kept fresh (counted from the moment of the drop).
    if (!this.session?.isHost && Date.now() - this.lastSaved > 4000) {
      this.lastSaved = Date.now();
      const l = loadLast();
      if (l) saveLast({ ...l, at: Date.now() });
    }
    if (msg.t === 'state' || msg.t === 'welcome' || msg.t === 'start') this.sync();
    this.lobby?.update();
    this.chat?.update();
    this.placement?.onMessage(msg);
    if (msg.t === 'comedyView' && this.inBattle) {
      // The host changed the comedy look: every client follows.
      this.env.setComedyVisual(msg.on);
      this.env.battle.showComedyView(msg.on);
    }
  }

  /** Builds the right screen for the session phase. */
  private sync(): void {
    if (this.wanted() === null) return;
    // Transitions run in order (asynchronous battle setup); the target is re-read at run time.
    this.transition = this.transition.then(() => this.reconcile()).catch((e) => this.setupFailed(e));
  }

  /** The screen the session state asks for; null if it cannot be built yet (init/start missing) or we are already there. */
  private wanted(): Screen | null {
    const m = this.session?.model;
    const st = m?.state;
    if (!m || !st) return null;
    const want: Screen = st.phase === 'lobby' ? 'lobby' : st.phase === 'placing' ? 'placing' : 'battle';
    if (want === 'placing' && !st.init) return null;
    if (want === 'battle' && !m.start) return null;
    if (want === this.screen && (want !== 'battle' || this.inBattle)) return null;
    return want;
  }

  /** If screen setup fails, do not stay on a blank screen: show the error and return to the menu keeping the session (token is kept). */
  private setupFailed(e: unknown): void {
    console.error('[online] screen setup failed', e);
    if (this.dead) return;
    this.toast(t('online.toast.setupFail', { msg: String((e as Error)?.message ?? e).slice(0, 120) }), 12000);
    this.exit(!this.session?.isHost);
  }

  private async reconcile(): Promise<void> {
    for (let i = 0; i < 4 && !this.dead; i++) {
      const want = this.wanted();
      if (!want) return;
      await this.go(want);
    }
  }

  private async go(want: Screen): Promise<void> {
    if (this.dead || !this.session) return;
    const st = this.session.model.state!;
    // Close the current screen.
    const prev = this.screen;
    if (prev === 'lobby' && want !== 'lobby') {
      this.lobby?.destroy();
      this.lobby = null;
    }
    if (prev === 'placing' && want !== 'placing') {
      this.placement?.destroy();
      this.placement = null;
    }
    if (prev === 'battle' && want !== 'battle') this.leaveBattle();
    this.screen = want;
    if (want === 'lobby') {
      this.chat?.destroy();
      this.chat = null;
      this.badge?.destroy();
      this.badge = null;
      this.cursors?.setView(null);
      this.env.setIconColors(null);
      this.env.setComedyVisual(null);
      this.lobby = new LobbyScreen(this.root, this.session, { onLeave: () => this.exit(), via: () => this.via, link: (c) => this.linkFor(c) });
    } else if (want === 'placing') {
      this.chat ??= new ChatOverlay(this.root, this.session);
      this.badge ??= this.makeBadge();
      await this.startPlacing(st.init!);
    } else {
      this.chat ??= new ChatOverlay(this.root, this.session);
      this.badge ??= this.makeBadge();
      await this.startBattle();
    }
  }

  private linkFor(code: string): string {
    return `${this.kind === 'net' ? PAGES_URL : location.origin + location.pathname}#join=${code}`;
  }

  private makeBadge(): ConnBadge {
    return new ConnBadge(this.root, () => {
      const code = this.session?.model.state?.code ?? '';
      return { via: this.via, code, link: this.linkFor(code) };
    });
  }

  private teamColorsFor(init: GameInit): TeamColors[] {
    const st = this.session!.model.state!;
    // By team index (a player id can turn into a ghost id mid-game).
    return init.teamPlayers.map((_, i) => makeTeamColor(playerColor(st.players.find((p) => p.role === 'player' && p.team === i)?.color ?? 0)));
  }

  private mapConfig(init: GameInit) {
    return { mode: 'custom' as const, perTeam: 0, teamCount: init.teams, mapSize: init.size, env: true, kite: true, terrainSeed: init.seed, map: init.spec, comedy: init.comedyPhysics };
  }

  private async startPlacing(init: GameInit): Promise<void> {
    const { env } = this;
    this.colors = this.teamColorsFor(init);
    this.biome = init.spec.biome;
    env.setIconColors(this.colors);
    env.bake(this.colors, this.biome, new Set(Array.from({ length: LEGACY_COUNT }, (_, i) => i)));
    env.world.rebuild(this.mapConfig(init), env.getAtlas(), true);
    env.camera.setMap(env.world.mapSize);
    env.camera.fit(env.world.size().w, env.world.size().h);
    this.cursors?.setView({ world: env.world });
    this.placement = new Placement(
      {
        world: env.world,
        camera: env.camera,
        ensureAtlas: (kinds) => this.ensureKinds(kinds),
        icon: (k, t) => env.icon(k, t),
        preview: env.preview,
        toast: (m) => this.toast(m),
        root: this.root,
      },
      this.session!,
      init,
      this.colors,
    );
  }

  private ensureKinds(kinds: Set<number>): boolean {
    const a = this.env.getAtlas();
    for (const k of kinds) {
      if (!a.kinds.has(k)) {
        this.env.bake(this.colors, this.biome, new Set([...a.kinds, ...kinds]));
        return true;
      }
    }
    return false;
  }

  private async startBattle(): Promise<void> {
    const s = this.session!;
    const m = s.model;
    const start = m.start!;
    const { env } = this;
    const init = start.init;
    this.colors = this.teamColorsFor(init);
    this.biome = init.spec.biome;
    env.setIconColors(this.colors);
    // The atlas of players who join midway must contain all kinds.
    const kinds = new Set<number>(Array.from({ length: LEGACY_COUNT }, (_, i) => i));
    const lay = layoutOf(start);
    for (let i = 0; i < lay.length; i += 4) kinds.add(lay[i + 1]);
    // The bone caller summons bone soldiers in battle (dormant skeletons exist in the sim from the start): their texture must be in the atlas.
    for (const k of [...kinds]) if (STATS[k]?.troop === 'bone-caller') kinds.add(KIND_OF_TROOP['bone-soldier']);
    env.bake(this.colors, this.biome, kinds);
    this.placement?.destroy();
    this.placement = null;
    const cfg = battleConfig(start);
    const host = s instanceof HostSession ? s.lobby : undefined;
    const lockOpts = { host, send: (msg: ClientMsg) => s.send(msg) };
    let sim: SimBackend | null = null;
    if (env.workerOk()) {
      // The battle runs in a Web Worker (the main thread only renders); fall back to the main thread if it cannot start.
      try {
        sim = await LockstepWorkerSim.createLockstep(cfg, start.simSeed, m, lockOpts);
      } catch (e) {
        console.warn('[online] sim worker unavailable, running on the main thread', e);
      }
    }
    if (this.dead) {
      sim?.dispose();
      return;
    }
    this.sim = sim ?? new LockstepSim(cfg, start.simSeed, m, lockOpts);
    const names = init.teamPlayers.map((_, i) => m.state?.players.find((p) => p.role === 'player' && p.team === i)?.name ?? '');
    env.setComedyVisual(init.comedyVisual);
    const d = env.battleDefaults();
    await env.battle.enter({
      config: cfg,
      colors: this.colors,
      speed: 1,
      bench: false,
      autoSeconds: 0,
      useWorker: false,
      seed: start.simSeed,
      fx: d.fx,
      numbers: d.numbers,
      onEdit: () => this.exit(),
      sim: this.sim,
      online: {
        isHost: s.isHost,
        teamNames: names,
        getSpeed: () => m.speed,
        getPaused: () => m.paused,
        onComedyView: s.isHost ? (on) => s.send({ t: 'cmd', comedyVisual: on }) : undefined,
        onLeave: () => this.exit(),
        onRematch: s.isHost ? () => s.send({ t: 'rematch' }) : undefined,
        onLobby: s.isHost ? () => s.send({ t: 'lobby' }) : undefined,
      },
    });
    if (this.dead) {
      // Online mode was left while the battle was being set up: close the half-built battle.
      env.battle.exit();
      return;
    }
    env.stats.setShown(STATS_DEFAULT_SHOWN);
    this.inBattle = true;
    this.cursors?.setView({ world: env.world });
  }

  private leaveBattle(): void {
    if (!this.inBattle) return;
    this.inBattle = false;
    this.env.battle.exit();
    this.env.stats.setShown(false);
    this.sim = null;
  }

  // ---------------------------------------------------------------- loop

  /** The online frame of the main loop. */
  frame(now: number, frameMs: number): void {
    const dt = frameMs > 500 ? 0 : Math.min(frameMs / 1000, 0.1);
    if (this.inBattle) this.env.battle.frame(now, frameMs);
    else if (this.screen === 'placing') {
      this.env.render(dt);
    }
    // Menu/lobby screens cover the map: skip needless drawing (battery/heat, especially on phones).
    this.cursors?.update(dt);
  }

  // ---------------------------------------------------------------- helpers

  private toast(msg: string, ms = 4000): void {
    const el = document.createElement('div');
    el.className = 'on-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /** Leave online mode: close the session, remove the screens, return to the studio. */
  /** Leaves online mode (back to the home page, or to the studio with `toStudio`). `quiet` skips the return (used right before a page reload). */
  exit(keepRejoin = false, quiet = false, toStudio = false): void {
    if (this.dead) return;
    this.dead = true;
    if (!keepRejoin) saveLast(null);
    try {
      // A kept rejoin entry needs the host to keep the slot too: only drop the connection, do not announce a leave.
      this.session?.leave(keepRejoin);
    } catch {
      /* connection already closed */
    }
    this.menu?.destroy();
    this.lobby?.destroy();
    this.placement?.destroy();
    this.chat?.destroy();
    this.badge?.destroy();
    this.leaveBattle();
    this.cursors?.destroy();
    this.root.remove();
    this.env.setIconColors(null);
    this.env.setComedyVisual(null);
    if (!quiet) this.env.onExit(!toStudio);
  }
}

import { loc, t } from '../../i18n';
import type { Session } from '../../net/client';
import { act } from '../../net/act';
import { ONLINE_MAP_SIZES } from '../../net/economy';
import type { PlayerInfo } from '../../net/protocol';
import { BIOME_NAMES, DEFAULT_MAP, LAYOUT_NAMES, type MapSpec } from '../../sim/mapSpec';
import type { Rarity } from '../../sim/data/troops';
import { MapPicker, drawMinimapCached } from '../mapPicker';
import { PALETTES, defaultState, type AppState } from '../state';
import { hex } from '../state';
import { playerColor } from './cursors';
import { ModePicker } from '../modePicker';
import { isSelectableMode } from '../modeIds';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const COLORS = PALETTES[0].colors;

export interface MenuHandlers {
  onHost(name: string, color: number, transport: 'lan' | 'net'): void;
  onJoin(name: string, color: number, code: string, pass: string, spectator: boolean): void;
  /** "Your own simulation": leave the home page for the Battle Studio. */
  onOwn(): void;
  onRejoin?(): void;
}

export interface MenuInit {
  name: string;
  color: number;
  code?: string;
  /** A dropped session: the reconnect button is shown. */
  last?: string;
}

/** Home page: name + color, and the Your own simulation / Host a lobby / Join with a code / Watch cards. */
export class MenuScreen {
  private readonly el: HTMLElement;
  private color: number;
  private busy = false;

  constructor(
    root: HTMLElement,
    init: MenuInit,
    private readonly h: MenuHandlers,
    netAvailable: boolean,
  ) {
    this.color = init.color;
    this.el = document.createElement('div');
    this.el.className = 'on-screen on-menu';
    this.el.innerHTML = `
<div class="on-panel on-menu-panel" role="dialog" aria-label="${esc(t('online.title'))}">
  <header><h2>${t('online.title')}</h2></header>
  <div class="on-profile">
    <label>${t('online.name')} <input id="m-name" maxlength="16" value="${esc(init.name)}" autocomplete="off" /></label>
    <div class="on-colors" id="m-colors" role="radiogroup" aria-label="${esc(t('online.color'))}"></div>
  </div>
  <div class="on-error" id="m-error" role="alert" hidden></div>
  <div class="on-status" id="m-status" aria-live="polite" hidden></div>
  ${init.last ? `<div class="on-rejoin"><span>${t('online.lastLobby')} <b>${esc(init.last)}</b></span> <button type="button" class="primary" id="m-rejoin">${t('online.rejoin')}</button></div>` : ''}
  <p class="legal">© gkaragoz and Contributors · <a href="https://github.com/gkaragoz/rpg-web-strategy/blob/master/LICENSE" target="_blank" rel="noopener">${t('online.license')}</a></p>
  <div class="on-cards">
    <section class="on-card">
      <h3>${t('online.own.title')}</h3>
      <p class="note">${t('online.own.note')}</p>
      <button type="button" class="primary wide" id="m-own">${t('online.own.btn')}</button>
    </section>
    <section class="on-card">
      <h3>${t('online.host.title')}</h3>
      <p class="note">${t('online.host.note')}</p>
      <div class="seg" id="m-tp" role="group" aria-label="${esc(t('online.tp.label'))}"></div>
      <p class="note" id="m-tp-note"></p>
      <button type="button" class="primary wide" id="m-host">${t('online.host.btn')}</button>
    </section>
    <section class="on-card">
      <h3>${t('online.join.title')}</h3>
      <label>${t('online.code')} <input id="m-code" maxlength="8" value="${esc((init.code ?? '').toUpperCase())}" placeholder="K7Q2XM" autocomplete="off" /></label>
      <label>${t('online.pass')} <input id="m-pass" type="password" placeholder="${esc(t('online.passHint'))}" autocomplete="off" /></label>
      <button type="button" class="primary wide" id="m-join">${t('online.join.btn')}</button>
    </section>
    <section class="on-card">
      <h3>${t('online.spec.title')}</h3>
      <p class="note">${t('online.spec.note')}</p>
      <label>${t('online.code')} <input id="m-scode" maxlength="8" placeholder="K7Q2XM" autocomplete="off" /></label>
      <label>${t('online.pass')} <input id="m-spass" type="password" placeholder="${esc(t('online.passHint'))}" autocomplete="off" /></label>
      <button type="button" class="wide" id="m-spec">${t('online.spec.btn')}</button>
    </section>
  </div>
</div>`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string): T => this.el.querySelector(s) as T;
    this.paintColors();
    let tp: 'lan' | 'net' = netAvailable ? 'net' : 'lan';
    const paintTp = (): void => {
      q('#m-tp').innerHTML = [
        { id: 'net', label: t('online.tp.net'), off: !netAvailable },
        { id: 'lan', label: t('online.tp.lan'), off: false },
      ]
        .map((o) => `<button type="button" data-tp="${o.id}" aria-pressed="${tp === o.id}"${o.off ? ' disabled' : ''}>${o.label}${o.off ? ' ' + t('online.tp.soon') : ''}</button>`)
        .join('');
      q('#m-tp-note').textContent = tp === 'lan' ? t('online.tp.noteLan') : t('online.tp.noteNet');
      q('#m-tp').querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          tp = (b as HTMLElement).dataset.tp as 'lan' | 'net';
          paintTp();
        }),
      );
    };
    paintTp();
    const prof = (): { name: string; color: number } => ({ name: q<HTMLInputElement>('#m-name').value.trim() || t('online.defaultName'), color: this.color });
    q('#m-own').addEventListener('click', () => {
      if (!this.busy) this.h.onOwn();
    });
    this.el.querySelector('#m-rejoin')?.addEventListener('click', () => {
      if (!this.busy) this.h.onRejoin?.();
    });
    q('#m-host').addEventListener('click', () => {
      if (this.busy) return;
      const p = prof();
      this.h.onHost(p.name, p.color, tp);
    });
    q('#m-join').addEventListener('click', () => {
      if (this.busy) return;
      const code = q<HTMLInputElement>('#m-code').value.trim().toUpperCase();
      if (!code) return this.setError(t('online.err.needCode'));
      const p = prof();
      this.h.onJoin(p.name, p.color, code, q<HTMLInputElement>('#m-pass').value, false);
    });
    q('#m-spec').addEventListener('click', () => {
      if (this.busy) return;
      const code = q<HTMLInputElement>('#m-scode').value.trim().toUpperCase();
      if (!code) return this.setError(t('online.err.needCode'));
      const p = prof();
      this.h.onJoin(p.name, p.color, code, q<HTMLInputElement>('#m-spass').value, true);
    });
  }

  private paintColors(): void {
    const box = this.el.querySelector('#m-colors') as HTMLElement;
    box.innerHTML = COLORS.map((c, i) => `<button type="button" class="on-sw${i === this.color ? ' sel' : ''}" data-c="${i}" style="background:${hex(c)}" role="radio" aria-checked="${i === this.color}" aria-label="${esc(t('online.colorN', { n: i + 1 }))}"></button>`).join('');
    box.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        this.color = Number((b as HTMLElement).dataset.c);
        this.paintColors();
      }),
    );
  }

  setBusy(on: boolean): void {
    this.busy = on;
    this.el.classList.toggle('busy', on);
  }

  setStatus(msg: string): void {
    const e = this.el.querySelector('#m-status') as HTMLElement;
    e.textContent = msg;
    e.hidden = !msg;
  }

  setError(msg: string): void {
    this.setStatus('');
    const e = this.el.querySelector('#m-error') as HTMLElement;
    e.textContent = msg;
    e.hidden = !msg;
  }

  destroy(): void {
    this.el.remove();
  }
}

const GOLDS = [500, 1000, 2000, 5000, 10000, 100000, 1000000];
/** Short label for a starting-gold choice (500, 1k, 10k, 1M) so the seven buttons fit a phone width. */
const goldLabel = (g: number): string => (g >= 1e6 ? `${g / 1e6}M` : g >= 1000 ? `${g / 1000}k` : String(g));
const TIMES: number[] = [60, 120, 300, 0];
const SIZES: readonly number[] = ONLINE_MAP_SIZES;

export interface LobbyEnv {
  onLeave(): void;
  /** Link to share, depending on the connection type (includes the code). */
  link(code: string): string;
  /** Connection kind in use: 'lan' | 'relay' | 'webrtc'. */
  via(): string;
}

/** Lobby: host settings on the left, players + chat on the right. */
export class LobbyScreen {
  private readonly el: HTMLElement;
  private readonly picker: MapPicker;
  private readonly mapState: AppState;
  private lastSettings = '';
  private lastPlayers = '';
  private chatSeen = 0;

  constructor(
    root: HTMLElement,
    private readonly session: Session,
    private readonly env: LobbyEnv,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'on-screen on-lobby';
    this.el.innerHTML = `
<div class="on-tabs" role="tablist"><button type="button" role="tab" data-tab="players">${t('online.lobby.tabPlayers')}</button><button type="button" role="tab" data-tab="settings">${t('online.lobby.tabSettings')}</button></div>
<div class="on-lobby-grid" data-tab="players">
  <aside class="on-panel on-settings" id="l-settings" aria-label="${esc(t('online.lobby.settings'))}">
    <h2>${t('online.lobby.settings')} <small id="l-host-note"></small></h2>
    <div class="on-field"><span>${t('online.lobby.map')}</span>
      <div class="on-map"><canvas id="l-prev" width="160" height="82"></canvas><div class="on-map-info"><b id="l-map-name"></b><div class="on-btnrow"><button type="button" id="l-map-pick">${t('online.lobby.pick')}</button><button type="button" id="l-map-rand">${t('online.lobby.random')}</button></div></div></div>
    </div>
    <div class="on-field stack"><span>${t('mode.label')}</span><div id="l-mode"></div></div>
    <div class="on-field" id="l-siege" hidden><span>${t('mode.siege.defender')}</span><select id="l-siege-def"></select></div>
    <div class="on-field"><span>${t('online.lobby.gold')}</span><div class="seg" id="l-gold"></div><input id="l-gold-n" type="number" min="100" max="10000000" step="100" aria-label="${esc(t('online.lobby.goldCustom'))}" /></div>
    <div class="on-field"><span>${t('online.lobby.placeTime')}</span><select id="l-time"></select></div>
    <div class="on-field"><span>${t('online.lobby.mapSize')}</span><select id="l-size"></select></div>
    <label class="row"><span>${t('online.lobby.openPlace')} <small>${t('online.lobby.openPlaceHint')}</small></span><input type="checkbox" id="l-open" role="switch" /></label>
    <label class="row"><span>${t('online.lobby.comedyPhys')} <small>${t('online.lobby.comedyPhysHint')}</small></span><input type="checkbox" id="l-cp" role="switch" /></label>
    <label class="row"><span>${t('online.lobby.comedyVis')}</span><input type="checkbox" id="l-cv" role="switch" /></label>
    <div class="on-field"><span>${t('online.lobby.bans')}</span><div class="on-bans" id="l-bans"></div></div>
    <button type="button" class="primary wide" id="l-start">${t('online.lobby.start')}</button>
    <p class="note" id="l-start-note"></p>
  </aside>
  <section class="on-panel on-players" aria-label="${esc(t('online.lobby.panelAria'))}">
    <header class="on-lhead">
      <div><span class="on-code-l">${t('online.lobby.codeLabel')}</span> <b class="on-code" id="l-code"></b> <small class="on-code-l" id="l-via"></small></div>
      <div class="on-btnrow"><button type="button" id="l-link">${t('online.lobby.copyLink')}</button><span id="l-pass-wrap"><input id="l-pass" type="text" placeholder="${esc(t('online.lobby.passPh'))}" maxlength="24" /><button type="button" id="l-pass-set">${t('online.lobby.passSet')}</button></span><button type="button" id="l-leave">${t('online.lobby.leave')}</button></div>
    </header>
    <h3 id="l-ptitle">${t('online.lobby.players')}</h3>
    <ul class="on-plist" id="l-players"></ul>
    <div class="on-chat"><div class="on-log" id="l-log" aria-live="polite"></div>
      <form class="on-chat-in" id="l-chatform"><input id="l-chat" maxlength="200" placeholder="${esc(t('online.lobby.chatPh'))}" autocomplete="off" /><button type="submit">${t('online.lobby.send')}</button></form>
    </div>
    <div class="on-ready-row"><button type="button" class="primary" id="l-ready">${t('online.lobby.ready')}</button></div>
  </section>
</div>`;
    root.appendChild(this.el);
    // Temporary state for the map picker (not written to localStorage).
    this.mapState = { ...defaultState(), ephemeral: true, map: { ...DEFAULT_MAP }, mapPreset: 'custom' };
    this.picker = new MapPicker(
      this.mapState,
      () => {
        const ms = this.mapState;
        if (ms.mapPreset === 'random') this.session.send({ t: 'settings', settings: { mapMode: 'random' } });
        else this.session.send({ t: 'settings', settings: { mapMode: 'fixed', map: ms.map, mapSeed: ms.seed } });
      },
      false,
    );
    this.build();
    // Tabs on narrow screens: the host sees the settings first, a guest sees the players.
    const grid = this.q('.on-lobby-grid');
    const setTab = (t: string): void => {
      grid.dataset.tab = t;
      this.el.querySelectorAll<HTMLElement>('.on-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    };
    this.el.querySelectorAll<HTMLElement>('.on-tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab!)));
    setTab(this.session.model.isHost ? 'settings' : 'players');
    this.update();
  }

  private q<T extends HTMLElement>(s: string): T {
    return this.el.querySelector(s) as T;
  }

  private modePicker!: ModePicker;

  /** Siege: which team defends (teams are numbered in join order when the placement starts, so the choices are plain team numbers). */
  private paintSiege(on: boolean, defender: number, players: number, host: boolean): void {
    const box = this.q('#l-siege');
    box.hidden = !on;
    if (!on) return;
    const sel = this.q<HTMLSelectElement>('#l-siege-def');
    const n = Math.max(2, Math.min(6, players));
    if (sel.options.length !== n) sel.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">${t('mode.siege.team', { n: i + 1 })}</option>`).join('');
    sel.value = String(Math.min(defender, n - 1));
    sel.disabled = !host;
  }

  private get host(): boolean {
    return this.session.model.isHost;
  }

  private build(): void {
    const q = this.q.bind(this);
    this.modePicker = new ModePicker({ value: 'classic', onPick: (id) => this.patch({ gameMode: id }) });
    q('#l-mode').appendChild(this.modePicker.el);
    q<HTMLSelectElement>('#l-siege-def').addEventListener('change', (e) => this.patch({ siegeDefender: Number((e.target as HTMLSelectElement).value) }));
    q('#l-gold').innerHTML = GOLDS.map((g) => `<button type="button" data-g="${g}">${goldLabel(g)}</button>`).join('');
    q('#l-gold').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => this.patch({ gold: Number((b as HTMLElement).dataset.g) })),
    );
    q<HTMLInputElement>('#l-gold-n').addEventListener('change', (e) => this.patch({ gold: Number((e.target as HTMLInputElement).value) }));
    // Show what the host really uses once the field is left (out-of-range values are clamped by the host).
    q<HTMLInputElement>('#l-gold-n').addEventListener('blur', () => {
      const st = this.session.model.state;
      if (st) q<HTMLInputElement>('#l-gold-n').value = String(st.settings.gold);
    });
    q<HTMLSelectElement>('#l-time').innerHTML = TIMES.map((v) => `<option value="${v}">${t(`online.time.${v}`)}</option>`).join('');
    q<HTMLSelectElement>('#l-time').addEventListener('change', (e) => this.patch({ placeSecs: Number((e.target as HTMLSelectElement).value) }));
    q<HTMLSelectElement>('#l-size').innerHTML = SIZES.map((v) => `<option value="${v}">${t(`online.size.${v}`)}</option>`).join('');
    q<HTMLSelectElement>('#l-size').addEventListener('change', (e) => this.patch({ mapSize: Number((e.target as HTMLSelectElement).value) }));
    q<HTMLInputElement>('#l-open').addEventListener('change', (e) => this.patch({ openPlacement: (e.target as HTMLInputElement).checked }));
    q<HTMLInputElement>('#l-cp').addEventListener('change', (e) => this.patch({ comedyPhysics: (e.target as HTMLInputElement).checked }));
    q<HTMLInputElement>('#l-cv').addEventListener('change', (e) => this.patch({ comedyVisual: (e.target as HTMLInputElement).checked }));
    const rar: Rarity[] = ['legendary', 'epic', 'rare'];
    q('#l-bans').innerHTML = rar.map((r) => `<label><input type="checkbox" data-r="${r}" /> ${t('online.lobby.banOne', { rarity: t(`online.rar.${r}`) })}</label>`).join('');
    q('#l-bans').querySelectorAll('input').forEach((i) =>
      i.addEventListener('change', () => {
        const banned = [...q('#l-bans').querySelectorAll('input')].filter((x) => (x as HTMLInputElement).checked).map((x) => (x as HTMLElement).dataset.r as Rarity);
        this.patch({ banned });
      }),
    );
    q('#l-map-pick').addEventListener('click', () => {
      const s = this.session.model.state!.settings;
      this.mapState.map = { ...s.map };
      this.mapState.seed = s.mapSeed;
      this.mapState.mapPreset = s.mapMode === 'random' ? 'random' : 'custom';
      this.mapState.mapSize = s.mapSize || 56;
      this.picker.open();
    });
    q('#l-map-rand').addEventListener('click', () => this.patch({ mapMode: 'random' }));
    q('#l-start').addEventListener('click', () => this.session.send({ t: 'start' }));
    q('#l-leave').addEventListener('click', () => this.env.onLeave());
    q('#l-link').addEventListener('click', () => {
      const st = this.session.model.state!;
      void navigator.clipboard?.writeText(this.env.link(st.code)).catch(() => {});
      q('#l-link').textContent = t('online.lobby.copied');
      setTimeout(() => (q('#l-link').textContent = t('online.lobby.copyLink')), 1500);
    });
    q('#l-pass-set').addEventListener('click', () => {
      const v = q<HTMLInputElement>('#l-pass').value.trim();
      this.session.send({ t: 'settings', settings: {}, password: v || null });
      q('#l-pass-set').textContent = v ? t('online.lobby.locked') : t('online.lobby.unlocked');
      setTimeout(() => (q('#l-pass-set').textContent = t('online.lobby.passSet')), 1500);
    });
    q('#l-ready').addEventListener('click', () => {
      const me = this.session.model.me;
      if (me) this.session.send({ t: 'ready', ready: !me.ready });
    });
    q<HTMLFormElement>('#l-chatform').addEventListener('submit', (e) => {
      e.preventDefault();
      const i = q<HTMLInputElement>('#l-chat');
      if (i.value.trim()) this.session.send({ t: 'chat', text: i.value });
      i.value = '';
    });
    // Show "(Lobby settings)" next to the cursor (sent as a code; each receiver translates it).
    const sp = q('#l-settings');
    sp.addEventListener('pointerenter', () => {
      act.text = 'lobbySettings';
    });
    sp.addEventListener('pointerleave', () => {
      if (act.text === 'lobbySettings') act.text = undefined;
    });
  }

  private patch(p: Record<string, unknown>): void {
    if (!this.host) return;
    this.session.send({ t: 'settings', settings: p });
  }

  /** Called when the state changes. */
  update(): void {
    const m = this.session.model;
    const st = m.state;
    if (!st) return;
    const q = this.q.bind(this);
    const host = this.host;
    q('#l-code').textContent = st.code;
    q('#l-via').textContent = t('online.lobby.via', { via: t(`online.via.${this.env.via()}`) });
    q('#l-host-note').textContent = host ? t('online.lobby.hostNote') : t('online.lobby.guestNote');
    q('#l-pass-wrap').hidden = !host;
    const s = st.settings;
    const key = JSON.stringify([s, host, st.locked]);
    if (key !== this.lastSettings) {
      this.lastSettings = key;
      q('#l-gold').querySelectorAll('button').forEach((b) => {
        (b as HTMLButtonElement).disabled = !host;
        b.setAttribute('aria-pressed', String(Number((b as HTMLElement).dataset.g) === s.gold));
      });
      this.modePicker.set(isSelectableMode(s.gameMode) ? s.gameMode : 'classic', !host);
      this.paintSiege(s.gameMode === 'siege', s.siegeDefender, st.players.filter((p) => p.role === 'player').length, host);
      const gn = q<HTMLInputElement>('#l-gold-n');
      if (document.activeElement !== gn) gn.value = String(s.gold);
      gn.disabled = !host;
      const set = (id: string, v: string, dis = !host): void => {
        const el = q<HTMLSelectElement>(id);
        el.value = v;
        el.disabled = dis;
      };
      set('#l-time', String(s.placeSecs));
      set('#l-size', String(s.mapSize));
      for (const [id, v] of [['#l-open', s.openPlacement], ['#l-cp', s.comedyPhysics], ['#l-cv', s.comedyVisual]] as const) {
        const el = q<HTMLInputElement>(id);
        el.checked = v;
        el.disabled = !host;
      }
      q('#l-bans').querySelectorAll('input').forEach((i) => {
        (i as HTMLInputElement).checked = s.banned.includes((i as HTMLElement).dataset.r as Rarity);
        (i as HTMLInputElement).disabled = !host;
      });
      (q('#l-map-pick') as HTMLButtonElement).disabled = !host;
      (q('#l-map-rand') as HTMLButtonElement).disabled = !host;
      this.paintMap(s.mapMode, s.map, s.mapSeed, s.mapSize);
    }
    const startBtn = q<HTMLButtonElement>('#l-start');
    startBtn.hidden = !host;
    const pl = st.players.filter((p) => p.role === 'player');
    const tooMany = s.gameMode === 'horde' && pl.length > 5;
    const can = pl.length >= 2 && !tooMany && pl.every((p) => p.id === st.hostId || (p.ready && p.connected));
    startBtn.disabled = !can;
    q('#l-start-note').textContent = !host ? '' : pl.length < 2 ? t('online.lobby.need2') : tooMany ? t('mode.horde.maxTeams') : can ? t('online.lobby.counts', { n: pl.length }) : t('online.lobby.needReady');
    const ready = q<HTMLButtonElement>('#l-ready');
    const me = m.me;
    ready.hidden = host || !me || me.role !== 'player';
    ready.textContent = me?.ready ? t('online.lobby.notReady') : t('online.lobby.ready');
    ready.classList.toggle('on', !!me?.ready);

    const pkey = JSON.stringify(st.players);
    // Repainting the list would throw away a name that is being typed (any other player's change triggers it): wait for the edit to end.
    const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('on-nameinp') && this.el.contains(document.activeElement);
    if (pkey !== this.lastPlayers && !typing) {
      this.lastPlayers = pkey;
      this.paintPlayers(st.players);
    }
    this.paintChat();
  }

  private paintMap(mode: 'random' | 'fixed', spec: MapSpec, seed: number, size: number): void {
    const c = this.q<HTMLCanvasElement>('#l-prev');
    const ctx = c.getContext('2d');
    if (mode === 'random') {
      ctx?.clearRect(0, 0, c.width, c.height);
      if (ctx) {
        ctx.fillStyle = '#0f1622';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#7aa7ff';
        ctx.font = 'bold 40px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('?', c.width / 2, c.height / 2 + 14);
      }
      this.q('#l-map-name').textContent = t('online.lobby.mapRandom');
      return;
    }
    const tmp = document.createElement('canvas');
    drawMinimapCached(tmp, spec, seed, size || 56);
    if (ctx) {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#0f1622';
      ctx.fillRect(0, 0, c.width, c.height);
      const k = Math.min(c.width / tmp.width, c.height / tmp.height);
      ctx.drawImage(tmp, (c.width - tmp.width * k) / 2, (c.height - tmp.height * k) / 2, tmp.width * k, tmp.height * k);
    }
    this.q('#l-map-name').textContent = t('online.lobby.mapFixed', { biome: loc(BIOME_NAMES[spec.biome]), layout: loc(LAYOUT_NAMES[spec.layout]), seed });
  }

  private paintPlayers(players: PlayerInfo[]): void {
    const m = this.session.model;
    const host = this.host;
    const taken = new Set(players.filter((p) => p.role === 'player').map((p) => p.color));
    const ul = this.q('#l-players');
    const row = (p: PlayerInfo): string => {
      const mine = p.id === m.you;
      const isHost = p.id === m.state!.hostId;
      const col = hex(playerColor(p.color));
      const swatches =
        mine && p.role === 'player'
          ? `<span class="on-pick">${COLORS.map((c, i) => `<button type="button" class="on-sw sm${i === p.color ? ' sel' : ''}" data-c="${i}" style="background:${hex(c)}" ${taken.has(i) && i !== p.color ? 'disabled' : ''} aria-label="${esc(t('online.colorN', { n: i + 1 }))}"></button>`).join('')}</span>`
          : '';
      const tags = [isHost ? `<span class="on-tag host">${t('online.tag.host')}</span>` : '', p.muted ? `<span class="on-tag">${t('online.tag.muted')}</span>` : '', !p.connected ? `<span class="on-tag warn">${t('online.tag.offline')}</span>` : '', p.role === 'spectator' ? `<span class="on-tag">${t('online.tag.spectator')}</span>` : ''].join('');
      const rd = p.role === 'player' && !isHost ? `<span class="on-rd${p.ready ? ' ok' : ''}">${p.ready ? t('online.tag.ready') : t('online.tag.waiting')}</span>` : '';
      const tools = host && !isHost ? `<button type="button" class="mini" data-mute="${p.id}">${p.muted ? t('online.player.unmute') : t('online.player.mute')}</button><button type="button" class="mini danger" data-kick="${p.id}">${t('online.player.kick')}</button>` : '';
      return `<li class="on-prow${mine ? ' me' : ''}"><i class="dot" style="background:${col}"></i><span class="on-pname">${mine ? `<input class="on-nameinp" value="${esc(p.name)}" maxlength="16" aria-label="${esc(t('online.lobby.yourName'))}" />` : esc(p.name)}</span>${tags}${swatches}${rd}${tools}</li>`;
    };
    const pl = players.filter((p) => p.role === 'player');
    const sp = players.filter((p) => p.role === 'spectator');
    ul.innerHTML = pl.map(row).join('') + (sp.length ? `<li class="on-sep">${t('online.lobby.spectators')}</li>${sp.map(row).join('')}` : '');
    this.q('#l-ptitle').textContent = t('online.lobby.playersCount', { n: pl.length });
    ul.querySelectorAll('[data-c]').forEach((b) =>
      b.addEventListener('click', () => {
        const me = m.me;
        if (me) this.session.send({ t: 'profile', name: me.name, color: Number((b as HTMLElement).dataset.c) });
      }),
    );
    ul.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', () => this.session.send({ t: 'kick', id: (b as HTMLElement).dataset.kick! })));
    ul.querySelectorAll('[data-mute]').forEach((b) => {
      const id = (b as HTMLElement).dataset.mute!;
      b.addEventListener('click', () => this.session.send({ t: 'mute', id, on: !players.find((p) => p.id === id)?.muted }));
    });
    const inp = ul.querySelector('.on-nameinp') as HTMLInputElement | null;
    inp?.addEventListener('change', () => {
      const me = m.me;
      if (me) this.session.send({ t: 'profile', name: inp.value, color: me.color });
    });
    // Leaving the field without a change: show the updates that were held back while typing.
    inp?.addEventListener('blur', () => setTimeout(() => this.update(), 0));
  }

  private paintChat(): void {
    const m = this.session.model;
    const log = this.q('#l-log');
    for (const c of m.chat) {
      if (c.n <= this.chatSeen) continue;
      this.chatSeen = c.n;
      const p = m.state?.players.find((x) => x.id === c.id);
      const d = document.createElement('div');
      d.className = 'on-line';
      d.innerHTML = `<b style="color:${hex(playerColor(p?.color ?? 0))}">${esc(c.name)}</b> ${esc(c.text)}`;
      log.appendChild(d);
      while (log.children.length > 200) log.firstElementChild?.remove();
      log.scrollTop = log.scrollHeight;
    }
  }

  destroy(): void {
    this.picker.destroy();
    if (act.text === 'lobbySettings') act.text = undefined;
    this.el.remove();
  }
}


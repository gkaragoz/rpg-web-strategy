import { getLang, t } from '../i18n';
import { isPlainShortcut, langKeys } from './hotkeys';
import { Tour, shouldStartTour } from './tutorial';
import { ModePicker } from './modePicker';
import type { UnitPreview } from './unitPreview';
import { initSheet } from './sheet';
import { LEGACY_COUNT, MAX_TEAMS, unitDisplayName } from '../sim/units';
import type { Editor } from './editor';
import { MapPicker } from './mapPicker';
import { UnitGallery } from './unitGallery';
import { UnitSettings } from './unitSettings';
import { BRUSHES, MAP_SIZES, MAX_PLACED, PALETTES, hex, saveState, teamColors, type AppState } from './state';

export interface StudioDeps {
  state: AppState;
  editor: Editor;
  /** Seed / environment / map size changed. */
  onMapChange: () => void;
  /** Team count or palette changed (the atlas is re-baked and sprites are refreshed). */
  onPaletteChange: () => void;
  onStart: () => void;
  /** Online mode menu. */
  onOnline?: () => void;
  onBench: (perTeam: number) => void;
  /** Display/sound options changed (sound and bar mode apply immediately). */
  onOptions: () => void;
  /** Unit icon (a copy of the canvas). */
  icon: (kind: number, team: number) => HTMLCanvasElement;
  /** Animated attack previews for the unit gallery. */
  preview?: UnitPreview;
  /** A new type was picked: the atlas is baked if needed. */
  onKindPick: (kind: number) => void;
  /** The 3D view is active (the hint line names the 3D camera keys). */
  view3d?: boolean;
}

const KIND_KEYS = ['1', '2', '3', '4', '5'];
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Main page: single-page studio (settings + teams + placement dock). */
export class Studio {
  private readonly root: HTMLElement;
  private readonly $: (sel: string) => HTMLElement;
  private visible = false;
  private modePicker!: ModePicker;
  private readonly units: UnitSettings;
  private readonly maps: MapPicker;
  private readonly gallery: UnitGallery;

  constructor(
    root: HTMLElement,
    private readonly d: StudioDeps,
  ) {
    this.root = root;
    this.units = new UnitSettings(d.state, () => this.render(), d.icon);
    this.gallery = new UnitGallery({
      state: d.state,
      icon: d.icon,
      preview: d.preview,
      onPick: (k) => {
        d.onKindPick(k);
        this.render();
      },
    });
    this.maps = new MapPicker(d.state, () => {
      d.onMapChange();
      this.render();
    });
    root.innerHTML = this.template();
    this.$ = (sel) => root.querySelector(sel) as HTMLElement;
    this.bind();
    initSheet(root.querySelector('.dock') as HTMLElement);
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Starts the quick tour (first run, or the "?" button). The side panels are closed first so they do not cover the highlighted controls. */
  startTour(): void {
    this.$('#panel-left').classList.remove('open');
    this.$('#panel-right').classList.remove('open');
    Tour.start(window.matchMedia('(pointer: coarse)').matches);
  }

  /** First run: shows the quick tour once the studio is the visible screen (never while the home page covers it). */
  maybeStartTour(): void {
    if (shouldStartTour()) window.setTimeout(() => this.visible && this.startTour(), 700);
  }

  show(): void {
    this.visible = true;
    this.root.hidden = false;
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
  }

  toast(msg: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    this.$('#toasts').appendChild(el);
    window.setTimeout(() => el.classList.add('out'), 2600);
    window.setTimeout(() => el.remove(), 3200);
  }

  private template(): string {
    return `
<aside class="panel left" id="panel-left" aria-label="${t('studio.panel.aria')}">
  <button type="button" class="panel-close only-narrow" aria-label="${t('studio.panel.close')}">×</button>
  <header><h1>${t('studio.title')}</h1><p>${t('studio.tagline')}</p></header>
  <section>
    <h2>${t('studio.map.h')}</h2>
    <button id="map-btn" type="button" class="wide map-btn" aria-haspopup="dialog">${t('studio.map.pick')}</button>
    <label class="row"><span>${t('studio.env')} <small>${t('studio.env.hint')}</small></span><input type="checkbox" id="env" role="switch" /></label>
    <div class="row"><span>${t('studio.seed')}</span><span class="inline"><input id="seed" type="number" min="1" max="999999" inputmode="numeric" aria-label="${t('studio.seed.aria')}" /><button id="dice" type="button" title="${t('studio.dice.title')}" aria-label="${t('studio.dice.title')}">${t('studio.dice')}</button></span></div>
    <div class="row stack"><span>${t('studio.size')}</span><div class="seg" id="mapsize" role="group" aria-label="${t('studio.size.aria')}"></div></div>
  </section>
  <section>
    <h2>${t('studio.battle.h')}</h2>
    <div class="row stack"><span>${t('mode.label')}</span><div id="mode-host"></div></div>
    <div class="row stack" id="siege-opts" hidden><span>${t('mode.siege.defender')}</span><div class="seg" id="siege-def" role="group" aria-label="${t('mode.siege.defender')}"></div></div>
    <label class="row"><span>${t('studio.kite')} <small>${t('studio.kite.hint')}</small></span><input type="checkbox" id="kite" role="switch" /></label>
    <div class="row"><span>${t('studio.speed')}</span><div class="seg" id="speed" role="group" aria-label="${t('studio.speed.aria')}"></div></div>
  </section>
  <section>
    <h2>${t('studio.display.h')}</h2>
    <label class="row"><span>${t('studio.snd')}</span><input type="checkbox" id="snd" role="switch" /></label>
    <div class="row"><span>${t('studio.vol')}</span><input type="range" id="vol" min="0" max="100" step="5" aria-label="${t('studio.vol')}" /></div>
    <div class="row stack"><span>${t('studio.fx')}</span><div class="seg" id="fxq" role="group" aria-label="${t('studio.fx.aria')}"></div></div>
    <label class="row"><span>${t('studio.nums')}</span><input type="checkbox" id="nums" role="switch" /></label>
    <div class="row stack"><span>${t('studio.bars')}</span><div class="seg" id="bars" role="group" aria-label="${t('studio.bars')}"></div></div>
    <h3>${t('studio.comedy.h')}</h3>
    <label class="row"><span>${t('studio.cv')} <small>${t('studio.cv.hint')}</small></span><input type="checkbox" id="cv" role="switch" /></label>
    <label class="row"><span>${t('studio.cp')} <small>${t('studio.cp.hint')}</small></span><input type="checkbox" id="cp" role="switch" /></label>
    <label class="row"><span>${t('studio.dbg')} <small>${t('studio.dbg.hint')}</small></span><input type="checkbox" id="dbg" role="switch" /></label>
  </section>
  <section>
    <h2>${t('studio.units.h')}</h2>
    <button id="units-btn" type="button" class="wide">${t('studio.units.btn')}</button>
    <p class="note" id="units-note">${t('studio.units.note')}</p>
  </section>
  <section>
    <h2>${t('studio.bench.h')}</h2>
    <div class="row"><span>${t('studio.bench.per')}</span><div class="seg" id="benchsel" role="group" aria-label="${t('studio.bench.aria')}"></div></div>
    <button id="bench" type="button" class="wide">${t('studio.bench.run')}</button>
    <p class="note">${t('studio.bench.note')}</p>
  </section>
  <footer class="legal">© gkaragoz and Contributors · <a href="https://github.com/gkaragoz/rpg-web-strategy/blob/master/LICENSE" target="_blank" rel="noopener">${t('studio.legal.license')}</a> · <a href="https://github.com/gkaragoz/rpg-web-strategy" target="_blank" rel="noopener">GitHub</a></footer>
</aside>

<aside class="panel right" id="panel-right" aria-label="${t('studio.teams.aria')}">
  <button type="button" class="panel-close only-narrow" aria-label="${t('studio.panel.close')}">×</button>
  <section>
    <h2>${t('studio.teams.h')}</h2>
    <div class="row"><span>${t('studio.teams.count')}</span><span class="stepper"><button id="tm-minus" type="button" aria-label="${t('studio.teams.minus')}">−</button><b id="tm-count">2</b><button id="tm-plus" type="button" aria-label="${t('studio.teams.plus')}">+</button></span></div>
    <h3>${t('studio.teams.theme')}</h3>
    <div id="palettes" role="radiogroup" aria-label="${t('studio.teams.theme')}"></div>
  </section>
  <section>
    <h2>${t('studio.teams.soldiers')}</h2>
    <div id="teamrows"></div>
    <button id="quick" type="button" class="wide">${t('studio.teams.quick')}</button>
  </section>
</aside>

<div class="dock" role="toolbar" aria-label="${t('studio.dock.aria')}">
  <div class="dock-note" id="reason" role="status"></div>
  <div class="dock-group primary" id="chips" role="radiogroup" aria-label="${t('studio.dock.team')}"></div>
  <div class="dock-group primary" id="kinds" role="radiogroup" aria-label="${t('studio.dock.kind')}"></div>
  <div class="dock-group primary"><button id="gallery-btn" type="button" title="${t('studio.dock.gallery.title')}">${t('studio.dock.gallery')}</button></div>
  <div class="dock-group"><div class="seg" id="brush" role="group" aria-label="${t('studio.dock.brush')}"></div></div>
  <div class="dock-group primary"><div class="seg" id="tool" role="group" aria-label="${t('studio.dock.tool')}"></div></div>
  <div class="dock-group">
    <button id="undo" type="button" title="${t('studio.undo.title')}">${t('studio.undo')}</button>
    <button id="redo" type="button" title="${t('studio.redo.title')}">${t('studio.redo')}</button>
    <button id="fill" type="button" title="${t('studio.fill.title')}">${t('studio.fill')}</button>
    <button id="rand-enemy" type="button" title="${t('studio.randEnemy.title')}">${t('studio.randEnemy')}</button>
    <button id="clear" type="button" title="${t('studio.clear.title')}">${t('studio.clear')}</button>
  </div>
  <div class="dock-group end primary">
    <span id="total" class="total">0 / ${MAX_PLACED}</span>
    <button id="tgl-left" type="button" class="only-narrow sec">${t('studio.settings')}</button>
    <button id="tgl-right" type="button" class="only-narrow sec">${t('studio.teamsBtn')}</button>
    <button id="tour-help" type="button" class="sec dock-help" title="${t('tour.help.title')}" aria-label="${t('tour.help.title')}">${t('tour.help')}</button>
    <button id="online" type="button" class="sec" title="${t('studio.online.title')}">${t('studio.online')}</button>
    <button id="start" type="button" class="primary">${t('studio.start')}</button>
  </div>
  <div class="dock-hint" id="hint">${t(this.d.view3d ? 'studio.hint3d' : 'studio.hint')} · ${t('studio.hint.keys', { key: langKeys(getLang()).gallery.replace('Key', ''), brushKey: langKeys(getLang()).brush.replace('Key', '') })}</div>
</div>
<div id="toasts" class="toasts" aria-live="polite"></div>`;
  }

  private seg(el: HTMLElement, items: Array<{ id: string | number; label: string }>, selected: string | number, onPick: (id: string) => void): void {
    el.innerHTML = items
      .map((it) => `<button type="button" data-id="${it.id}" aria-pressed="${String(it.id) === String(selected)}">${esc(it.label)}</button>`)
      .join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onPick((b as HTMLElement).dataset.id!)));
  }

  private bind(): void {
    const s = this.d.state;
    const $in = (id: string) => this.$(id) as HTMLInputElement;

    this.modePicker = new ModePicker({
      value: s.rules,
      onPick: (id) => {
        s.rules = id;
        if (id !== 'vip' && s.tool === 'vip') s.tool = 'place';
        saveState(s);
        this.d.onPaletteChange(); // the atlas needs the horde colour (and the structure kinds) of the new mode
        this.render();
      },
    });
    this.$('#mode-host').appendChild(this.modePicker.el);
    $in('#env').addEventListener('change', (e) => {
      s.env = (e.target as HTMLInputElement).checked;
      this.changed(true);
    });
    $in('#kite').addEventListener('change', (e) => {
      s.kite = (e.target as HTMLInputElement).checked;
      this.changed(false);
    });
    $in('#seed').addEventListener('change', (e) => {
      const v = Math.floor(Number((e.target as HTMLInputElement).value));
      s.seed = Number.isFinite(v) ? Math.min(999999, Math.max(1, v)) : s.seed;
      this.changed(true);
    });
    this.$('#dice').addEventListener('click', () => {
      s.seed = 1 + Math.floor(Math.random() * 999999);
      this.changed(true);
    });
    this.$('#tm-minus').addEventListener('click', () => this.setTeamCount(s.teamCount - 1));
    this.$('#tm-plus').addEventListener('click', () => this.setTeamCount(s.teamCount + 1));
    this.$('#quick').addEventListener('click', () => {
      const n = this.d.editor.quickFormation();
      this.toast(n > 0 ? t('studio.toast.quick', { n }) : t('studio.toast.quickNone'));
      this.render();
    });
    this.$('#undo').addEventListener('click', () => {
      this.d.editor.undo();
      this.render();
    });
    this.$('#redo').addEventListener('click', () => {
      this.d.editor.redo();
      this.render();
    });
    this.$('#rand-enemy').addEventListener('click', () => {
      const n = this.d.editor.addRandomEnemies();
      this.d.onKindPick(s.selKind);
      this.toast(n > 0 ? t('studio.toast.enemies', { n }) : t('studio.toast.none'));
      this.render();
    });
    this.$('#fill').addEventListener('click', () => {
      const n = this.d.editor.fillFormation(s.selTeam);
      this.toast(n > 0 ? t('studio.toast.fill', { team: s.selTeam + 1, n }) : t('studio.toast.none'));
      this.render();
    });
    this.$('#clear').addEventListener('click', () => {
      if (s.units.length === 0) return;
      if (!window.confirm(t('studio.confirm.clear', { n: s.units.length }))) return;
      this.d.editor.clear();
      this.render();
    });
    this.$('#bench').addEventListener('click', () => this.d.onBench(s.benchPerTeam));
    this.$('#online').addEventListener('click', () => this.d.onOnline?.());
    $in('#snd').addEventListener('change', (e) => {
      s.options.sound = (e.target as HTMLInputElement).checked;
      this.optionsChanged();
    });
    $in('#vol').addEventListener('input', (e) => {
      s.options.volume = Number((e.target as HTMLInputElement).value) / 100;
      this.optionsChanged(false);
    });
    // The comedy look and the debug overlay are drawn by the 2D renderers only.
    if (this.d.view3d) for (const id of ['#cv', '#dbg']) $in(id).closest<HTMLElement>('label')!.style.display = 'none';
    $in('#cv').addEventListener('change', (e) => {
      s.options.comedyVisual = (e.target as HTMLInputElement).checked;
      this.optionsChanged();
    });
    $in('#cp').addEventListener('change', (e) => {
      s.options.comedyPhysics = (e.target as HTMLInputElement).checked;
      this.optionsChanged();
    });
    $in('#dbg').addEventListener('change', (e) => {
      s.options.debug = (e.target as HTMLInputElement).checked;
      this.optionsChanged();
    });
    $in('#nums').addEventListener('change', (e) => {
      s.options.numbers = (e.target as HTMLInputElement).checked;
      this.optionsChanged();
    });
    this.$('#units-btn').addEventListener('click', () => this.units.open());
    this.$('#map-btn').addEventListener('click', () => this.maps.open());
    this.$('#gallery-btn').addEventListener('click', () => this.gallery.open());
    this.$('#start').addEventListener('click', () => {
      if (!this.canStart().ok) return;
      this.d.onStart();
    });
    this.$('#tour-help').addEventListener('click', () => this.startTour());
    this.$('#tgl-left').addEventListener('click', () => this.$('#panel-left').classList.toggle('open'));
    this.$('#tgl-right').addEventListener('click', () => this.$('#panel-right').classList.toggle('open'));
    // On phones the open panel covers the dock (and its Settings / Teams buttons): it carries its own close button.
    for (const id of ['#panel-left', '#panel-right']) this.$(id).querySelector('.panel-close')!.addEventListener('click', () => this.$(id).classList.remove('open'));
  }

  private optionsChanged(rerender = true): void {
    saveState(this.d.state);
    this.d.onOptions();
    if (rerender) this.render();
  }

  private setTeamCount(n: number): void {
    const s = this.d.state;
    const next = Math.min(MAX_TEAMS, Math.max(2, n));
    if (next === s.teamCount) return;
    if (next < s.teamCount) {
      const lost = s.units.filter((u) => u.team >= next).length;
      if (lost > 0 && !window.confirm(t('studio.confirm.teams', { from: next + 1, to: s.teamCount, lost }))) return;
      this.d.editor.dropTeamsAbove(next);
    }
    s.teamCount = next;
    s.selTeam = Math.min(s.selTeam, next - 1);
    saveState(s);
    this.d.onPaletteChange();
    this.render();
  }

  private changed(map: boolean): void {
    saveState(this.d.state);
    if (map) this.d.onMapChange();
    this.render();
  }

  private canStart(): { ok: boolean; reason: string } {
    const s = this.d.state;
    const withUnits = new Set(s.units.map((u) => u.team)).size;
    if (s.units.length === 0) return { ok: false, reason: t('studio.reason.empty') };
    if (s.rules === 'horde' && s.teamCount > 5) return { ok: false, reason: t('mode.horde.maxTeams') };
    if (s.rules !== 'horde' && withUnits < 2) return { ok: false, reason: t('studio.reason.twoTeams') };
    return { ok: true, reason: '' };
  }

  /** Redraws the whole UI from state (cheap, can be called often). */
  render(): void {
    if (!this.visible) return;
    const s = this.d.state;
    this.modePicker.set(s.rules);
    this.$('#siege-opts').hidden = s.rules !== 'siege';
    if (s.rules === 'siege') {
      s.siegeDefender = Math.min(s.siegeDefender, s.teamCount - 1);
      this.seg(this.$('#siege-def'), Array.from({ length: s.teamCount }, (_, i) => ({ id: i, label: t('mode.siege.team', { n: i + 1 }) })), s.siegeDefender, (id) => {
        s.siegeDefender = Number(id);
        this.changed(false);
      });
    }
    const colors = teamColors(s.palette, s.teamCount);
    const counts = this.d.editor.counts();
    const $in = (id: string) => this.$(id) as HTMLInputElement;

    $in('#env').checked = s.env;
    this.$('#map-btn').textContent = t('studio.map.current', { name: this.maps.label() });
    $in('#kite').checked = s.kite;
    if (document.activeElement !== $in('#seed')) $in('#seed').value = String(s.seed);

    this.seg(this.$('#mapsize'), MAP_SIZES.map((m) => ({ id: m.id, label: m.name })), s.mapSize, (id) => {
      s.mapSize = Number(id);
      this.changed(true);
    });
    this.seg(this.$('#speed'), [1, 2, 4].map((v) => ({ id: v, label: `${v}×` })), s.speed, (id) => {
      s.speed = Number(id);
      this.changed(false);
    });
    this.seg(this.$('#benchsel'), [1000, 3000, 10000].map((v) => ({ id: v, label: `${v / 1000}k` })), s.benchPerTeam, (id) => {
      s.benchPerTeam = Number(id);
      this.changed(false);
    });
    const op = s.options;
    $in('#snd').checked = op.sound;
    if (document.activeElement !== $in('#vol')) $in('#vol').value = String(Math.round(op.volume * 100));
    $in('#nums').checked = op.numbers;
    $in('#dbg').checked = op.debug;
    $in('#cv').checked = op.comedyVisual;
    $in('#cp').checked = op.comedyPhysics;
    this.seg(this.$('#fxq'), (['auto', 'high', 'low', 'off'] as const).map((id) => ({ id, label: t(`studio.fx.${id}`) })), op.fx, (id) => {
      op.fx = id as typeof op.fx;
      this.optionsChanged();
    });
    this.seg(this.$('#bars'), (['damaged', 'always', 'never'] as const).map((id) => ({ id, label: t(`studio.bars.${id}`) })), op.bars, (id) => {
      op.bars = id as typeof op.bars;
      this.optionsChanged();
    });
    this.$('#tm-count').textContent = String(s.teamCount);
    const changed = this.units.changedCount();
    this.$('#units-note').textContent = changed > 0 ? t('studio.units.changed', { n: changed }) : t('studio.units.note');

    // Palette sets
    this.$('#palettes').innerHTML = PALETTES.map((p) => {
      const sel = p.id === s.palette;
      return `<button type="button" class="palette${sel ? ' sel' : ''}" role="radio" aria-checked="${sel}" data-id="${p.id}"><span class="pname">${esc(p.name)}</span><span class="swatches">${p.colors
        .slice(0, Math.max(s.teamCount, 4))
        .map((c) => `<i style="background:${hex(c)}"></i>`)
        .join('')}</span></button>`;
    }).join('');
    this.$('#palettes').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        s.palette = (b as HTMLElement).dataset.id!;
        saveState(s);
        this.d.onPaletteChange();
        this.render();
      }),
    );

    // Team rows
    this.$('#teamrows').innerHTML = colors
      .map((c, ti) => {
        const total = counts[ti].reduce((a, b) => a + b, 0);
        const detail = counts[ti].map((n, k) => (n > 0 ? `${unitDisplayName(k)} ${n}` : '')).filter(Boolean).join(' · ');
        return `<div class="trow${ti === s.selTeam ? ' sel' : ''}" data-team="${ti}" tabindex="0" role="group" aria-label="${t('studio.team.name', { n: ti + 1 })} ${total}"${ti === s.selTeam ? ' aria-current="true"' : ''}><i class="dot" style="background:${hex(c.main)}"></i><span class="tname">${t('studio.team.name', { n: ti + 1 })} <b>${total}</b></span><small>${esc(detail || t('studio.team.empty'))}</small><button type="button" data-clear="${ti}" ${total === 0 ? 'disabled' : ''} title="${t('studio.team.clear.title', { n: ti + 1 })}">${t('studio.team.clear')}</button></div>`;
      })
      .join('');
    this.$('#teamrows').querySelectorAll('.trow').forEach((row) =>
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).dataset.clear !== undefined) return;
        s.selTeam = Number((row as HTMLElement).dataset.team);
        this.render();
      }),
    );
    // Keyboard: Enter / Space on a focused team row picks the team (the rows are rebuilt, so focus moves to the new row).
    this.$('#teamrows').querySelectorAll('.trow').forEach((row) =>
      row.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.target !== row || (ke.key !== 'Enter' && ke.key !== ' ')) return;
        ke.preventDefault();
        s.selTeam = Number((row as HTMLElement).dataset.team);
        this.render();
        this.$('#teamrows').querySelector<HTMLElement>(`.trow[data-team="${s.selTeam}"]`)?.focus();
      }),
    );
    this.$('#teamrows').querySelectorAll('button[data-clear]').forEach((b) =>
      b.addEventListener('click', () => {
        this.d.editor.clear(Number((b as HTMLElement).dataset.clear));
        this.render();
      }),
    );

    // Dock
    this.$('#chips').innerHTML = colors
      .map((c, ti) => {
        const total = counts[ti].reduce((a, b) => a + b, 0);
        return `<button type="button" class="chip${ti === s.selTeam ? ' sel' : ''}" role="radio" aria-checked="${ti === s.selTeam}" data-team="${ti}" title="${t('studio.chip.title', { n: ti + 1 })}"><i class="dot" style="background:${hex(c.main)}"></i>${ti + 1}<small>${total}</small></button>`;
      })
      .join('');
    this.$('#chips').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        s.selTeam = Number((b as HTMLElement).dataset.team);
        this.render();
      }),
    );
    const kindList = Array.from({ length: LEGACY_COUNT }, (_, k) => k);
    if (s.selKind >= LEGACY_COUNT) kindList.push(s.selKind);
    this.$('#kinds').innerHTML = kindList.map((k) => {
      const sel = k === s.selKind;
      return `<button type="button" class="kind${sel ? ' sel' : ''}" role="radio" aria-checked="${sel}" data-kind="${k}" title="${esc(unitDisplayName(k))} (${KIND_KEYS[k]})">${KIND_KEYS[k] ? `<kbd>${KIND_KEYS[k]}</kbd>` : ''}${esc(unitDisplayName(k))}</button>`;
    }).join('');
    this.$('#kinds').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        s.selKind = Number((b as HTMLElement).dataset.kind);
        s.tool = 'place';
        this.d.onKindPick(s.selKind);
        this.render();
      }),
    );
    this.seg(this.$('#brush'), BRUSHES.map((b) => ({ id: b.id, label: `${b.name}` })), s.brush, (id) => {
      s.brush = Number(id);
      this.changed(false);
    });
    this.seg(
      this.$('#tool'),
      [
        { id: 'place', label: t('studio.tool.place') },
        { id: 'erase', label: t('studio.tool.erase') },
        { id: 'eraseTeam', label: t('studio.tool.eraseTeam') },
        ...(s.rules === 'vip' ? [{ id: 'vip', label: t('mode.vip.tool') }] : []),
      ],
      s.tool === 'vip' ? 'vip' : s.tool === 'place' ? 'place' : s.eraseTeamOnly ? 'eraseTeam' : 'erase',
      (id) => {
        s.tool = id === 'vip' ? 'vip' : id === 'place' ? 'place' : 'erase';
        s.eraseTeamOnly = id === 'eraseTeam';
        this.render();
      },
    );

    this.$('#tool').querySelector('button[data-id="vip"]')?.setAttribute('title', t('mode.vip.tool.title'));
    ($in('#undo') as unknown as HTMLButtonElement).disabled = !this.d.editor.canUndo;
    ($in('#redo') as unknown as HTMLButtonElement).disabled = !this.d.editor.canRedo;
    ($in('#clear') as unknown as HTMLButtonElement).disabled = s.units.length === 0;
    this.$('#total').textContent = `${s.units.length} / ${MAX_PLACED}`;
    const start = this.canStart();
    const startBtn = this.$('#start') as HTMLButtonElement;
    startBtn.disabled = !start.ok;
    startBtn.title = start.ok ? t('studio.start') : start.reason;
    this.$('#reason').textContent = start.reason;
    this.$('#reason').hidden = start.ok;
    this.d.editor.drawGhost();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.visible) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const s = this.d.state;
    if (e.ctrlKey || e.metaKey) {
      if (e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) this.d.editor.redo();
        else this.d.editor.undo();
        this.render();
      } else if (e.code === 'KeyY') {
        e.preventDefault();
        this.d.editor.redo();
        this.render();
      }
      return;
    }
    const keys = langKeys(getLang());
    if (e.code === keys.gallery) {
      if (!isPlainShortcut(e)) return;
      e.preventDefault();
      this.gallery.toggle();
      return;
    }
    if (this.gallery.isOpen) return;
    if (e.code === 'KeyQ') s.selTeam = (s.selTeam + s.teamCount - 1) % s.teamCount;
    else if (e.code === 'KeyE') s.selTeam = (s.selTeam + 1) % s.teamCount;
    else if (e.code === 'KeyX') s.tool = s.tool === 'place' ? 'erase' : 'place';
    else if (e.code === 'KeyZ') this.d.editor.undo();
    else if (e.code === 'KeyY') this.d.editor.redo();
    else if (e.code === keys.brush) s.brush = (s.brush + 1) % BRUSHES.length;
    else if (e.code.startsWith('Digit')) {
      const k = Number(e.code.slice(5)) - 1;
      if (k < 0 || k >= LEGACY_COUNT) return;
      s.selKind = k;
      s.tool = 'place';
    } else return;
    saveState(s);
    this.render();
  }
}

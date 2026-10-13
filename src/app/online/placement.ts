import { Graphics, Sprite, type Application } from 'pixi.js';
import type { Camera } from '../../camera';
import { t } from '../../i18n';
import { isoX, isoY } from '../../iso';
import { act } from '../../net/act';
import { MAX_ROOM_UNITS, spent, teamZones, type Zone } from '../../net/economy';
import { fmtDamage } from '../dpsMeter';
import type { Session } from '../../net/client';
import type { GameInit, PlacedItem, ServerMsg } from '../../net/protocol';
import type { Atlas } from '../../render/atlas';
import { POSES, type TeamColors } from '../../render/unitView';
import { KIND_OF_TROOP, LEGACY_COUNT, MAX_TEAMS, STATS, unitDisplayName } from '../../sim/units';
import { initSheet } from '../sheet';
import type { UnitPreview } from '../unitPreview';
import { Editor } from '../editor';
import { UnitGallery } from '../unitGallery';
import { BRUSHES, defaultState, hex, type AppState, type PlacedUnit } from '../state';
import type { WorldView } from '../world';
import { playerColor } from './cursors';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface PlacementEnv {
  app: Application;
  world: WorldView;
  camera: Camera;
  getAtlas: () => Atlas;
  /** Re-bakes the atlas if a texture for the given kinds is missing; returns true if it did. */
  ensureAtlas: (kinds: Set<number>) => boolean;
  icon: (kind: number, team: number) => HTMLCanvasElement;
  preview?: UnitPreview;
  toast: (msg: string) => void;
  /** Root element for the screen layout (top strip + dock). */
  root: HTMLElement;
}

/** Placement phase: zone-restricted, budgeted editor, top strip, dock, live remote units. */
export class Placement {
  readonly state: AppState;
  readonly editor: Editor | null;
  private readonly zones: Zone[];
  private readonly myTeam: number;
  private readonly top: HTMLElement;
  private readonly dock: HTMLElement | null;
  private readonly overlay = new Graphics();
  private readonly remote = new Map<number, Sprite>();
  private readonly pending = new Map<number, PlacedUnit>();
  private readonly cancelled = new Set<number>();
  /** cids whose unit was erased and re-added (undo) before the host answered: the late answer must only undo that stale copy. */
  private readonly stale = new Set<number>();
  /** Units removed locally (by host id), so a refused removal can restore the very same objects and drop their undo entries. */
  private readonly removedById = new Map<number, PlacedUnit>();
  private nextCid = 1;
  private locked = false;
  /** READY the player asked for and the host has not echoed yet (the lock follows this, not stale state messages). */
  private readyWanted: boolean | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** READY waits until every placement was confirmed, so a deferred removal cannot arrive after the host is ready. */
  private readyDeferred = false;
  private readonly gallery: UnitGallery | null;
  private readonly keys: (e: KeyboardEvent) => void;
  private lastLeft = -2;
  private leftAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sheet: { destroy(): void } | null = null;

  constructor(
    private readonly env: PlacementEnv,
    private readonly session: Session,
    private readonly init: GameInit,
    private readonly colors: TeamColors[],
  ) {
    const model = session.model;
    this.myTeam = model.me && model.me.role === 'player' ? model.me.team : -1;
    this.zones = teamZones(init.size, init.teams, env.world.terrain);
    this.state = {
      ...defaultState(),
      ephemeral: true,
      teamCount: init.teams,
      selTeam: Math.max(0, this.myTeam),
      selKind: 0,
      mapSize: init.size,
      customColors: colors,
      units: [],
      fresh: false,
    };
    // Rejoin during placement: our own units and READY state are already known to the host.
    this.locked = !!model.me?.ready;
    if (this.myTeam >= 0) for (const it of model.placed.values()) if (it.team === this.myTeam) this.state.units.push({ team: it.team, kind: it.kind, x: it.x, y: it.y, id: it.id });
    this.drawZones();
    env.world.fxLayer.addChild(this.overlay);

    this.top = document.createElement('div');
    this.top.className = 'on-top';
    env.root.appendChild(this.top);

    if (this.myTeam >= 0) {
      const zone = this.zones[this.myTeam];
      this.editor = new Editor({
        app: env.app,
        world: env.world,
        camera: env.camera,
        state: this.state,
        getAtlas: env.getAtlas,
        ensureAtlas: () => this.ensureKinds(),
        onChange: () => this.refreshUi(),
        toast: env.toast,
      });
      this.editor.constraint = {
        allow: (x, y) => !this.locked && zone.contains(x, y),
        canEdit: () => !this.locked,
        cost: (k) => init.costs[k] ?? 0,
        left: () => init.gold - spent(this.state.units, init.costs),
        maxUnits: MAX_ROOM_UNITS,
      };
      this.editor.sync = {
        added: (units) => this.sendAdded(units),
        removed: (units) => this.sendRemoved(units),
      };
      this.editor.enter();
      if (this.state.units.length) this.ensureKinds();
      this.gallery = new UnitGallery({
        state: this.state,
        icon: env.icon,
        preview: env.preview,
        onPick: () => {
          this.ensureKinds();
          this.refreshUi();
        },
        online: { cost: (k) => init.costs[k] ?? 0, banned: () => init.banned },
      });
      this.dock = document.createElement('div');
      this.dock.className = 'dock on-dock';
      env.root.appendChild(this.dock);
      this.buildDock();
    } else {
      this.editor = null;
      this.gallery = null;
      this.dock = null;
    }
    this.keys = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keys);
    this.timer = setInterval(() => this.paintTop(), 250);
    this.refreshUi();
    // Process existing placements (reconnect/spectator).
    this.syncRemote();
  }

  // ---------------------------------------------------------------- atlas

  private neededKinds(): Set<number> {
    const set = new Set<number>(Array.from({ length: LEGACY_COUNT }, (_, i) => i));
    for (const u of this.state.units) set.add(u.kind);
    for (const it of this.session.model.placed.values()) set.add(it.kind);
    set.add(this.state.selKind);
    for (const k of [...set]) if (STATS[k]?.troop === 'bone-caller') set.add(KIND_OF_TROOP['bone-soldier']);
    return set;
  }

  /** Bakes the textures that are missing from the atlas and refreshes the sprites. */
  ensureKinds(): void {
    if (this.env.ensureAtlas(this.neededKinds())) this.onAtlas();
  }

  /** Called when the atlas is re-baked. */
  onAtlas(): void {
    this.editor?.refreshSprites();
    for (const s of this.remote.values()) s.destroy();
    this.remote.clear();
    this.syncRemote();
  }

  // ---------------------------------------------------------------- network mapping

  private sendAdded(units: PlacedUnit[]): void {
    const items = units.map((u) => {
      if (u.cid !== undefined && this.pending.get(u.cid) === u) {
        // Erased and restored before the host answered: the first request is now a stale duplicate.
        this.pending.delete(u.cid);
        this.cancelled.delete(u.cid);
        this.stale.add(u.cid);
      }
      u.id = undefined;
      u.cid = this.nextCid++;
      this.pending.set(u.cid, u);
      return { cid: u.cid, kind: u.kind, x: u.x, y: u.y };
    });
    for (let i = 0; i < items.length; i += 80) this.session.send({ t: 'place', items: items.slice(i, i + 80) });
  }

  private sendRemoved(units: PlacedUnit[]): void {
    const ids: number[] = [];
    for (const u of units) {
      if (u.id !== undefined) {
        ids.push(u.id);
        this.removedById.set(u.id, u);
      } else if (u.cid !== undefined) this.cancelled.add(u.cid); // not confirmed yet: removed once the confirmation arrives
    }
    if (ids.length) this.session.send({ t: 'unplace', ids });
  }

  /** Handles the server messages that concern placement. */
  onMessage(msg: ServerMsg): void {
    const me = this.session.model.you;
    switch (msg.t) {
      case 'placed':
        for (const it of msg.items) this.onPlaced(it, msg.owner === me);
        this.ensureKinds();
        this.syncRemote();
        this.flushReady();
        break;
      case 'unplaced':
        for (const id of msg.ids) {
          const s = this.remote.get(id);
          if (s) {
            s.destroy();
            this.remote.delete(id);
          }
          if (this.editor) {
            const u = this.state.units.find((x) => x.id === id);
            if (u) this.editor.removeSilently([u]);
          }
        }
        break;
      case 'placeFail': {
        const bad: PlacedUnit[] = [];
        for (const cid of msg.cids) {
          if (this.stale.delete(cid)) continue;
          const u = this.pending.get(cid);
          if (u) {
            bad.push(u);
            this.pending.delete(cid);
          }
        }
        if (bad.length && this.editor) this.editor.removeSilently(bad);
        this.env.toast(t(`online.reason.${msg.reason}`));
        this.flushReady();
        break;
      }
      case 'unplaceFail': {
        // The host kept these units (we were ready): restore them locally so what we see is what will fight.
        let back = 0;
        const old: PlacedUnit[] = [];
        for (const id of msg.ids) {
          const it = this.session.model.placed.get(id);
          if (!it || it.team !== this.myTeam || !this.editor || this.state.units.some((x) => x.id === id)) continue;
          const was = this.removedById.get(id);
          if (was) old.push(was);
          this.state.units.push({ team: it.team, kind: it.kind, x: it.x, y: it.y, id: it.id });
          back++;
        }
        if (back) {
          this.editor?.forget(old); // their undo entries would re-add duplicates
          this.ensureKinds();
          this.editor?.refreshSprites();
          this.refreshUi();
        }
        this.env.toast(t('online.place.locked'));
        break;
      }
      case 'state': {
        const ready = !!this.session.model.me?.ready;
        if (this.readyWanted !== null && this.readyWanted === ready) this.readyWanted = null;
        this.locked = this.readyWanted ?? ready;
        this.refreshUi();
        break;
      }
        break;
    }
  }

  private onPlaced(it: PlacedItem, mine: boolean): void {
    if (it.team === this.myTeam && this.editor) {
      const u = this.pending.get(it.cid);
      if (mine && u) {
        this.pending.delete(it.cid);
        if (this.cancelled.delete(it.cid)) {
          // It was deleted before confirmation: remove it from the host as well.
          this.session.send({ t: 'unplace', ids: [it.id] });
          this.editor.removeSilently([u]);
        } else u.id = it.id;
        return;
      }
      // One of my own units placed earlier (reconnect): add it to the local state.
      if (!this.state.units.some((x) => x.id === it.id)) {
        const nu: PlacedUnit = { team: it.team, kind: it.kind, x: it.x, y: it.y, id: it.id };
        this.state.units.push(nu);
        this.ensureKinds();
        this.editor.refreshSprites();
      }
    }
  }

  // ---------------------------------------------------------------- remote units

  /** Draws the other teams' units in model.placed as read-only sprites. */
  syncRemote(): void {
    const atlas = this.env.getAtlas();
    const placed = this.session.model.placed;
    for (const [id, s] of [...this.remote]) {
      if (!placed.has(id)) {
        s.destroy();
        this.remote.delete(id);
      }
    }
    const t = this.env.world.terrain;
    const c = this.init.size / 2;
    for (const it of placed.values()) {
      if (it.team === this.myTeam || this.remote.has(it.id)) continue;
      const idx = (it.kind * MAX_TEAMS + it.team) * POSES;
      const tex = atlas.unitTex[idx];
      const anc = atlas.unitAnchor[idx];
      if (!tex || !anc) continue;
      const spr = new Sprite(tex);
      spr.anchor.set(anc.ax, anc.ay);
      spr.position.set(isoX(it.x, it.y), isoY(it.x, it.y, t && t.hasRelief ? t.elevPx(it.x, it.y) : 0));
      spr.zIndex = it.x + it.y;
      spr.scale.x = isoX(c, c) - isoX(it.x, it.y) >= 0 ? 1 : -1;
      this.env.world.entityLayer.addChild(spr);
      this.remote.set(it.id, spr);
    }
  }

  // ---------------------------------------------------------------- zone layer

  private drawZones(): void {
    const g = this.overlay;
    g.clear();
    const size = this.init.size;
    const t = this.env.world.terrain;
    for (const z of this.zones) {
      const mine = z.team === this.myTeam;
      const col = this.colors[z.team]?.main ?? 0xffffff;
      for (let ty = 0; ty < size; ty++) {
        for (let tx = 0; tx < size; tx++) {
          if (!z.contains(tx + 0.5, ty + 0.5)) continue;
          if (t && !t.walkable(tx + 0.5, ty + 0.5)) continue;
          const e = (x: number, y: number): number => (t && t.hasRelief ? t.elevPx(x, y) : 0);
          const p = (x: number, y: number): [number, number] => [isoX(x, y), isoY(x, y, e(x, y))];
          const a = p(tx, ty);
          const b = p(tx + 1, ty);
          const c = p(tx + 1, ty + 1);
          const d = p(tx, ty + 1);
          g.poly([a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]]).fill({ color: col, alpha: mine ? 0.26 : 0.1 });
        }
      }
    }
  }

  // ---------------------------------------------------------------- UI

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (!this.editor) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) this.editor.redo();
      else this.editor.undo();
    } else if (e.code === 'KeyZ') this.editor.undo();
    else if (e.code === 'KeyY') this.editor.redo();
    else if (e.code === 'KeyX') {
      this.state.tool = this.state.tool === 'place' ? 'erase' : 'place';
      this.refreshUi();
    } else if (e.code === 'KeyB') {
      this.state.brush = (this.state.brush + 1) % BRUSHES.length;
      this.refreshUi();
    } else if (e.code.startsWith('Digit')) {
      const k = Number(e.code.slice(5)) - 1;
      if (k >= 0 && k < LEGACY_COUNT) {
        this.state.selKind = k;
        this.state.tool = 'place';
        this.ensureKinds();
        this.refreshUi();
      }
    }
  }

  private buildDock(): void {
    const d = this.dock!;
    d.innerHTML = `
<div class="dock-group primary on-gold"><span id="pg-gold" class="on-gold-t"></span><div class="on-gbar"><i id="pg-bar"></i></div></div>
<div class="dock-group primary" id="pg-kinds" role="radiogroup" aria-label="${esc(t('online.place.unit'))}"></div>
<div class="dock-group primary"><button type="button" id="pg-gallery">${t('online.place.gallery')}</button></div>
<div class="dock-group"><div class="seg" id="pg-brush" role="group" aria-label="${esc(t('online.place.brush'))}"></div></div>
<div class="dock-group primary"><div class="seg" id="pg-tool" role="group" aria-label="${esc(t('online.place.tool'))}"></div></div>
<div class="dock-group"><button type="button" id="pg-undo">${t('online.place.undo')}</button><button type="button" id="pg-redo">${t('online.place.redo')}</button><button type="button" id="pg-clear">${t('online.place.clear')}</button></div>
<div class="dock-group end primary"><button type="button" class="primary" id="pg-ready">${t('online.place.ready')}</button></div>`;
    this.sheet = initSheet(d);
    const q = (s: string): HTMLElement => d.querySelector(s) as HTMLElement;
    q('#pg-gallery').addEventListener('click', () => this.gallery!.open());
    q('#pg-undo').addEventListener('click', () => this.editor!.undo());
    q('#pg-redo').addEventListener('click', () => this.editor!.redo());
    q('#pg-clear').addEventListener('click', () => this.editor!.clear());
    q('#pg-ready').addEventListener('click', () => {
      const me = this.session.model.me;
      if (me) this.toggleReady(!(this.readyWanted ?? me.ready));
    });
  }

  /** READY on/off: locks the editor at once, defers the message until all placements are confirmed, and survives stale state messages. */
  private toggleReady(next: boolean): void {
    this.readyWanted = next;
    this.locked = next;
    this.readyDeferred = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    // If the host never echoes (dropped message), fall back to what it says.
    this.readyTimer = setTimeout(() => {
      this.readyWanted = null;
      this.locked = !!this.session.model.me?.ready;
      this.refreshUi();
    }, 4000);
    if (next && this.pending.size > 0) this.readyDeferred = true;
    else this.session.send({ t: 'ready', ready: next });
    this.refreshUi();
  }

  private flushReady(): void {
    if (!this.readyDeferred || this.pending.size > 0) return;
    this.readyDeferred = false;
    this.session.send({ t: 'ready', ready: true });
  }

  private refreshUi(): void {
    this.paintTop();
    const d = this.dock;
    if (!d) return;
    const q = (s: string): HTMLElement => d.querySelector(s) as HTMLElement;
    const left = this.init.gold - spent(this.state.units, this.init.costs);
    q('#pg-gold').textContent = t('online.place.gold', { left: fmtGold(left), max: fmtGold(this.init.gold) });
    (q('#pg-bar').style as CSSStyleDeclaration).width = `${Math.max(0, Math.min(100, (left / this.init.gold) * 100))}%`;
    const kinds = [0, 1, 2, 3, 4];
    if (!kinds.includes(this.state.selKind)) kinds.push(this.state.selKind);
    q('#pg-kinds').innerHTML = kinds
      .map((k) => `<button type="button" class="kind${k === this.state.selKind ? ' sel' : ''}" data-k="${k}" role="radio" aria-checked="${k === this.state.selKind}" title="${esc(unitDisplayName(k))}">${esc(unitDisplayName(k))} <small>${this.init.costs[k]}g</small></button>`)
      .join('');
    q('#pg-kinds').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        this.state.selKind = Number((b as HTMLElement).dataset.k);
        this.state.tool = 'place';
        this.ensureKinds();
        this.refreshUi();
      }),
    );
    const seg = (id: string, items: Array<[string | number, string]>, cur: string | number, on: (v: string) => void): void => {
      const el = q(id);
      el.innerHTML = items.map(([v, l]) => `<button type="button" data-id="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('');
      el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => on((b as HTMLElement).dataset.id!)));
    };
    seg('#pg-brush', BRUSHES.map((b) => [b.id, t(`online.brush.${b.id}`)]), this.state.brush, (v) => {
      this.state.brush = Number(v);
      this.refreshUi();
    });
    seg('#pg-tool', [['place', t('online.tool.place')], ['erase', t('online.tool.erase')]], this.state.tool, (v) => {
      this.state.tool = v as 'place' | 'erase';
      this.refreshUi();
    });
    (q('#pg-undo') as HTMLButtonElement).disabled = !this.editor!.canUndo || this.locked;
    (q('#pg-redo') as HTMLButtonElement).disabled = !this.editor!.canRedo || this.locked;
    (q('#pg-clear') as HTMLButtonElement).disabled = this.state.units.length === 0 || this.locked;
    const me = this.session.model.me;
    const rd = q('#pg-ready');
    rd.textContent = me?.ready ? t('online.place.readyOn') : t('online.place.ready');
    rd.classList.toggle('on', !!me?.ready);
    this.editor!.drawGhost();
  }

  private paintTop(): void {
    const st = this.session.model.state;
    if (!st) return;
    if (st.placeLeft !== this.lastLeft) {
      this.lastLeft = st.placeLeft;
      this.leftAt = performance.now();
    }
    const left = st.placeLeft < 0 ? -1 : Math.max(0, st.placeLeft - Math.floor((performance.now() - this.leftAt) / 1000));
    const time = left < 0 ? '∞' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    const chips = st.players
      .filter((p) => p.role === 'player')
      .map((p) => {
        const mine = p.id === this.session.model.you;
        const gold = mine && this.editor ? this.init.gold - spent(this.state.units, this.init.costs) : p.gold;
        return `<span class="on-chip${p.ready ? ' rdy' : ''}${mine ? ' me' : ''}${p.connected ? '' : ' off'}" style="border-color:${hex(playerColor(p.color))}"><i class="dot" style="background:${hex(playerColor(p.color))}"></i>${esc(p.name)} <b>${fmtGold(gold)}g</b> <small>${t('online.place.units', { n: p.units })}</small>${p.ready ? ' ✓' : ''}</span>`;
      })
      .join('');
    const spec = st.players.filter((p) => p.role === 'spectator').length;
    this.top.innerHTML = `<div class="on-chips">${chips}</div><div class="on-time" title="${esc(t('online.place.timeLeft'))}">${t('online.place.time', { time })}</div>${spec ? `<small class="on-spec">${t('online.place.spectators', { n: spec })}</small>` : ''}`;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keys);
    if (this.timer) clearInterval(this.timer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.editor?.exit();
    this.top.remove();
    this.sheet?.destroy();
    this.gallery?.destroy();
    if (act.text === 'unitPicker') act.text = undefined;
    this.dock?.remove();
    this.overlay.destroy();
    for (const s of this.remote.values()) s.destroy();
    this.remote.clear();
  }

  /** The battle is starting: exposes the player's own placed units (for counting/results). */
  get myUnits(): PlacedUnit[] {
    return this.state.units;
  }
}

/** Gold with a short suffix once it gets long (1 000 000 -> 1.0m). */
function fmtGold(n: number): string {
  return n >= 100000 ? fmtDamage(n) : String(n);
}

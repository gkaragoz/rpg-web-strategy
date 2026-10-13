import type { Application } from 'pixi.js';
import { isoX, isoY } from '../../iso';
import { act } from '../../net/act';
import type { OnlineModel } from '../../net/client';
import type { ClientMsg } from '../../net/protocol';
import type { Terrain } from '../../sim/terrain';
import { PALETTES } from '../state';
import type { WorldView } from '../world';

const SEND_MS = 66; // ~15 Hz
const STALE_MS = 4000;

/** Harita ekranlarinda ekran <-> dunya donusumu icin gerekenler (lobide null). */
export interface MapView {
  app: Application;
  world: WorldView;
  terrain: () => Terrain | null;
  size: () => number;
}

const hexOf = (c: number): string => '#' + c.toString(16).padStart(6, '0');

/** Oyuncu renk indeksinin ekran rengi (klasik palet). */
export function playerColor(index: number): number {
  const cols = PALETTES[0].colors;
  return cols[((index % cols.length) + cols.length) % cols.length];
}

/**
 * Canli imlecler: herkesin adi, rengi ve imleci (ok + dolgulu "Ad (eylem)" etiketi). Harita ekranlarinda imlec dunya
 * koordinatinda (kamera/zoom'dan bagimsiz), lobide sayfa-normalize koordinatta cizilir. DOM katmani; yumusatilir.
 */
export class CursorLayer {
  private readonly root: HTMLElement;
  private readonly els = new Map<string, { el: HTMLElement; label: HTMLElement; x: number; y: number; ready: boolean }>();
  private view: MapView | null = null;
  private lastSend = 0;
  private lastKey = '';
  private readonly onMove: (e: PointerEvent) => void;
  private readonly onLeave: () => void;
  private pendingLeave = false;

  constructor(
    private readonly model: OnlineModel,
    private readonly send: (m: ClientMsg) => void,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'online-cursors';
    document.body.appendChild(this.root);
    this.onMove = (e) => this.pointer(e);
    this.onLeave = () => {
      this.pendingLeave = true;
    };
    window.addEventListener('pointermove', this.onMove);
    document.addEventListener('pointerleave', this.onLeave);
  }

  /** Harita ekraniysa gorunumu ver; lobide null. */
  setView(v: MapView | null): void {
    this.view = v;
    // Baglam degisti: eski konumlar anlamsizlasir.
    for (const c of this.els.values()) c.ready = false;
  }

  destroy(): void {
    window.removeEventListener('pointermove', this.onMove);
    document.removeEventListener('pointerleave', this.onLeave);
    this.root.remove();
    this.els.clear();
  }

  // ---------------------------------------------------------------- gonderme

  private pointer(e: PointerEvent): void {
    const now = performance.now();
    if (now - this.lastSend < SEND_MS) return;
    const v = this.view;
    let msg: ClientMsg;
    if (v && e.target === v.app.canvas) {
      const p = this.toWorld(v, e.clientX, e.clientY);
      msg = { t: 'presence', x: +p.x.toFixed(2), y: +p.y.toFixed(2), ctx: 'world', act: act.text };
    } else {
      msg = { t: 'presence', x: +(e.clientX / window.innerWidth).toFixed(4), y: +(e.clientY / window.innerHeight).toFixed(4), ctx: 'page', act: act.text };
    }
    // Ayni konum + ayni eylem tekrar gonderilmez.
    const key = `${msg.t === 'presence' ? msg.x + ',' + msg.y + ',' + msg.ctx + ',' + (msg.act ?? '') : ''}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.lastSend = now;
    this.send(msg);
  }

  private toWorld(v: MapView, cx: number, cy: number): { x: number; y: number } {
    const rect = v.app.canvas.getBoundingClientRect();
    const p = v.world.root.toLocal({ x: cx - rect.left, y: cy - rect.top });
    let x = p.x / 64 + p.y / 32;
    let y = p.y / 32 - p.x / 64;
    const t = v.terrain();
    if (t && t.hasRelief) {
      const n = v.size();
      for (let k = 0; k < 3; k++) {
        const e = t.elevPx(Math.min(n, Math.max(0, x)), Math.min(n, Math.max(0, y)));
        x = p.x / 64 + (p.y + e) / 32;
        y = (p.y + e) / 32 - p.x / 64;
      }
    }
    return { x, y };
  }

  private toClient(v: MapView, x: number, y: number): { x: number; y: number } {
    const t = v.terrain();
    const n = v.size();
    const e = t && t.hasRelief ? t.elevPx(Math.min(n, Math.max(0, x)), Math.min(n, Math.max(0, y))) : 0;
    const g = v.world.root.toGlobal({ x: isoX(x, y), y: isoY(x, y, e) });
    const rect = v.app.canvas.getBoundingClientRect();
    return { x: g.x + rect.left, y: g.y + rect.top };
  }

  // ---------------------------------------------------------------- cizim

  /** Her karede cagrilir. */
  update(dt: number): void {
    const st = this.model.state;
    if (!st) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const p of st.players) {
      if (p.id === this.model.you) continue;
      const pr = this.model.presence.get(p.id);
      if (!pr) continue;
      // Baglam uyusmazligi: harita gorunumu yokken world imleci gosterilmez.
      if (pr.ctx === 'world' && !this.view) continue;
      seen.add(p.id);
      let c = this.els.get(p.id);
      if (!c) {
        const el = document.createElement('div');
        el.className = 'oc';
        el.innerHTML = '<svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true"><path d="M1 1 L1 17 L5.6 13.2 L9 20.5 L12 19 L8.7 11.8 L14.5 11.5 Z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="oc-label"></span>';
        this.root.appendChild(el);
        c = { el, label: el.querySelector('.oc-label') as HTMLElement, x: 0, y: 0, ready: false };
        this.els.set(p.id, c);
      }
      const col = hexOf(playerColor(p.color));
      (c.el.querySelector('path') as SVGPathElement).setAttribute('fill', col);
      c.label.style.background = col;
      const text = pr.act ? `${p.name} (${pr.act})` : p.name;
      if (c.label.textContent !== text) c.label.textContent = text;
      let tx: number;
      let ty: number;
      if (pr.ctx === 'world' && this.view) {
        const q = this.toClient(this.view, pr.x, pr.y);
        tx = q.x;
        ty = q.y;
      } else {
        tx = pr.x * window.innerWidth;
        ty = pr.y * window.innerHeight;
      }
      if (!c.ready) {
        c.x = tx;
        c.y = ty;
        c.ready = true;
      } else {
        const k = 1 - Math.exp(-dt * 22);
        c.x += (tx - c.x) * k;
        c.y += (ty - c.y) * k;
      }
      c.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
      c.el.style.opacity = now - pr.at > STALE_MS ? '0.35' : '1';
    }
    for (const [id, c] of [...this.els]) {
      if (!seen.has(id)) {
        c.el.remove();
        this.els.delete(id);
      }
    }
    if (this.pendingLeave) this.pendingLeave = false;
  }
}

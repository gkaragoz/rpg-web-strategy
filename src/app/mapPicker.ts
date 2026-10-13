import { PALETTES } from '../render/biome';
import {
  BIOMES,
  BIOME_NAMES,
  CROSSINGS,
  CROSSING_NAMES,
  FORESTS,
  FOREST_NAMES,
  LAYOUTS,
  LAYOUT_NAMES,
  RELIEFS,
  RELIEF_NAMES,
  PRESETS,
  RIVERS,
  RIVER_NAMES,
  VILLAGES,
  VILLAGE_NAMES,
  randomSpec,
  type Biome,
  type MapSpec,
} from '../sim/mapSpec';
import { mulberry32 } from '../sim/random';
import { T_BLOCKED, T_BRIDGE, T_GRASS, T_PATH, T_WATER, Terrain } from '../sim/terrain';
import { trackDialog } from '../net/act';
import { hex, saveState, type AppState } from './state';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Kucuk izometrik onizleme: arazi bayraklarindan ve dekorlardan 2:1 bir canvas cizer. */
export function drawMinimap(canvas: HTMLCanvasElement, spec: MapSpec, seed: number, size: number): void {
  const n = Math.max(32, Math.min(72, size));
  const t = new Terrain(n, { seed, spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
  const pal = PALETTES[spec.biome];
  canvas.width = n * 2 + 2;
  canvas.height = n + 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const px = (x: number, y: number): number => (x - y + n) * 1 + 1;
  const py = (x: number, y: number): number => (x + y) * 0.5 + 1;
  const tile = (tx: number, ty: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    const cx = px(tx + 0.5, ty + 0.5);
    const cy = py(tx + 0.5, ty + 0.5);
    ctx.moveTo(cx, cy - 0.75);
    ctx.lineTo(cx + 1.25, cy);
    ctx.lineTo(cx, cy + 0.75);
    ctx.lineTo(cx - 1.25, cy);
    ctx.fill();
  };
  const grassA = hex(pal.grassA);
  const grassB = hex(pal.grassB);
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const f = t.flags[ty * n + tx];
      let c: string;
      if (f === T_WATER) c = hex(pal.water);
      else if (f === T_BRIDGE) c = spec.crossing === 'ford' ? hex(pal.waterShine) : spec.crossing === 'stone' ? hex(pal.stoneDeck) : hex(pal.deck);
      else if (f === T_PATH) c = hex(pal.path);
      else {
        c = (tx + ty) % 2 === 0 ? grassA : grassB;
        if (t.hasRelief) {
          // Yukseklik golgesi: yuksek yerler acik, dik yamaclar (ucurum) koyu.
          const h = (t.vertexH(tx, ty) + t.vertexH(tx + 1, ty + 1)) / 2;
          const gx = t.vertexH(tx + 1, ty) - t.vertexH(tx, ty + 1);
          const k = Math.min(1.25, Math.max(0.55, 0.82 + 0.1 * h - 0.5 * Math.abs(gx)));
          const v = parseInt(c.slice(1), 16);
          const ch = (sh: number): number => Math.min(255, Math.round(((v >> sh) & 255) * k));
          c = `rgb(${ch(16)},${ch(8)},${ch(0)})`;
        }
      }
      if (f === T_GRASS || f === T_BLOCKED || f === T_PATH || f === T_WATER || f === T_BRIDGE) tile(tx, ty, c);
    }
  }
  for (const idx of t.landTiles) tile(idx % n, Math.floor(idx / n), hex(pal.bank));
  const treeColor = { forest: '#2b6236', desert: '#4f8a45', snow: '#2c5a48', swamp: '#4a3b2a' }[spec.biome];
  const houseColor = { forest: '#a8815a', desert: '#d8b97c', snow: '#8d837b', swamp: '#5b4a31' }[spec.biome];
  for (const d of t.decor) {
    const x = px(d.x, d.y);
    const y = py(d.x, d.y);
    if (d.kind === 'tree') {
      ctx.fillStyle = treeColor;
      ctx.fillRect(x - 1, y - 2.5, 2, 3);
    } else if (d.kind === 'house') {
      ctx.fillStyle = houseColor;
      ctx.fillRect(x - 3, y - 4, 5, 4);
    } else if (d.kind === 'wall') {
      ctx.fillStyle = houseColor;
      ctx.fillRect(x - 1, y - 2, 2, 2);
    } else if (d.kind === 'boulder') {
      ctx.fillStyle = '#8a8a84';
      ctx.fillRect(x - 1, y - 1.5, 2, 1.5);
    }
  }
}

/** Harita secici: biyom filtreli, onizlemeli kart galerisi + ozellestirme + rastgele kart. */
export class MapPicker {
  private readonly dlg: HTMLDialogElement;
  private filter: Biome | 'all' = 'all';
  private readonly actTrack: { open(): void };

  constructor(
    private readonly state: AppState,
    private readonly onChange: () => void,
    /** false: secimler localStorage'a yazilmaz (cevrimici lobi). */
    private readonly persist = true,
  ) {
    this.dlg = document.createElement('dialog');
    this.dlg.className = 'unit-dialog map-dialog';
    this.dlg.setAttribute('aria-label', 'Harita seç');
    document.body.appendChild(this.dlg);
    this.actTrack = trackDialog(this.dlg, 'Harita seçiyor');
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
  }

  /** Secili haritanin kisa adi (stüdyo dügmesinde gösterilir). */
  label(): string {
    const s = this.state;
    if (s.mapPreset === 'random') return 'Rastgele harita';
    const p = PRESETS.find((q) => q.id === s.mapPreset);
    return p ? p.name : 'Özel harita';
  }

  open(): void {
    this.render();
    this.actTrack.open();
    if (!this.dlg.open) this.dlg.showModal();
  }

  /** Kart tiklandi: tarifi uygula. */
  private pick(id: string): void {
    const s = this.state;
    if (id === 'random') {
      this.roll();
      return;
    }
    const p = PRESETS.find((q) => q.id === id);
    if (!p) return;
    s.map = { ...p.spec };
    s.mapPreset = p.id;
    this.commit();
  }

  /** Her seyi rastgele sec ve tohumu da cek. */
  private roll(): void {
    const s = this.state;
    const rnd = mulberry32((Math.random() * 4294967296) >>> 0);
    s.map = randomSpec(rnd);
    s.seed = 1 + Math.floor(rnd() * 999999);
    s.mapPreset = 'random';
    this.commit();
  }

  private commit(): void {
    if (this.persist) saveState(this.state);
    this.render();
    this.onChange();
  }

  private card(id: string, name: string, sub: string): string {
    const sel = this.state.mapPreset === id;
    return `<button type="button" class="map-card${sel ? ' sel' : ''}" data-id="${id}" aria-pressed="${sel}">
  ${id === 'random' && !sel ? '<span class="mc-dice" aria-hidden="true">?</span>' : `<canvas data-prev="${id}" aria-hidden="true"></canvas>`}
  <span class="mc-name">${esc(name)}</span>
  <span class="mc-sub">${esc(sub)}</span>
</button>`;
  }

  private opt<T extends string>(list: readonly T[], names: Record<T, string>, cur: T): string {
    return list.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(names[v])}</option>`).join('');
  }

  private render(): void {
    const s = this.state;
    const m = s.map;
    const chips = [{ id: 'all', name: 'Hepsi' }, ...BIOMES.map((b) => ({ id: b, name: BIOME_NAMES[b] }))]
      .map((c) => `<button type="button" data-f="${c.id}" aria-pressed="${this.filter === c.id}">${esc(c.name)}</button>`)
      .join('');
    const list = PRESETS.filter((p) => this.filter === 'all' || p.spec.biome === this.filter);
    const rnd = this.card('random', 'Rastgele', s.mapPreset === 'random' ? `${BIOME_NAMES[m.biome]} · tohum ${s.seed}` : 'Her şey rastgele');
    const cards = list.map((p) => this.card(p.id, p.name, `${BIOME_NAMES[p.spec.biome]} · ${p.spec.layout !== 'classic' ? LAYOUT_NAMES[p.spec.layout] : p.spec.relief !== 'flat' ? RELIEF_NAMES[p.spec.relief] : RIVER_NAMES[p.spec.river]}`)).join('');
    const detail =
      s.mapPreset === 'random'
        ? `<div class="map-rand"><b>Çekilen harita:</b> ${esc(BIOME_NAMES[m.biome])}, ${esc(RIVER_NAMES[m.river])} nehir, ${esc(FOREST_NAMES[m.forest])} orman, ${esc(VILLAGE_NAMES[m.village])}, ${esc(CROSSING_NAMES[m.crossing])} · tohum <b>${s.seed}</b>
  <span class="inline"><button type="button" id="mp-reroll">Yeniden çek</button><button type="button" id="mp-lock">Kilitle</button></span></div>`
        : '';

    this.dlg.innerHTML = `
<form method="dialog">
  <header><h2>Harita seç</h2><p>Biyom ve yapı çeşitleri; kartlar mevcut tohum ve boyutla önizlenir.</p></header>
  <div class="map-chips seg" role="group" aria-label="Biyom filtresi">${chips}</div>
  <div class="map-body">
    <div class="map-grid">${rnd}${cards}</div>
    ${detail}
    <div class="map-custom">
      <h3>Özelleştir</h3>
      <div class="map-fields">
        <label>Biyom<select id="mp-biome">${this.opt(BIOMES, BIOME_NAMES, m.biome)}</select></label>
        <label>Nehir<select id="mp-river"${m.layout === 'citadel' || m.layout === 'crossroads' || m.layout === 'archipelago' ? ' disabled' : ''}>${this.opt(RIVERS, RIVER_NAMES, m.river)}</select></label>
        <label>Orman<select id="mp-forest">${this.opt(FORESTS, FOREST_NAMES, m.forest)}</select></label>
        <label>Köy<select id="mp-village">${this.opt(VILLAGES, VILLAGE_NAMES, m.village)}</select></label>
        <label>Kurgu<select id="mp-layout">${this.opt(LAYOUTS, LAYOUT_NAMES, m.layout)}</select></label>
        <label>Kabartma<select id="mp-relief"${m.layout !== 'classic' ? ' disabled' : ''}>${this.opt(RELIEFS, RELIEF_NAMES, m.relief)}</select></label>
        <label>Geçit<select id="mp-crossing"${m.river === 'none' ? ' disabled' : ''}>${this.opt(CROSSINGS, CROSSING_NAMES, m.crossing)}</select></label>
      </div>
    </div>
  </div>
  <footer><span class="note">Seçili: ${esc(this.label())}</span><button type="submit" class="primary">Tamam</button></footer>
</form>`;

    this.dlg.querySelectorAll<HTMLElement>('[data-f]').forEach((b) =>
      b.addEventListener('click', () => {
        this.filter = b.dataset.f as Biome | 'all';
        this.render();
      }),
    );
    this.dlg.querySelectorAll<HTMLElement>('.map-card').forEach((b) => b.addEventListener('click', () => this.pick(b.dataset.id!)));
    this.dlg.querySelector('#mp-reroll')?.addEventListener('click', () => this.roll());
    this.dlg.querySelector('#mp-lock')?.addEventListener('click', () => {
      s.mapPreset = 'custom';
      this.commit();
    });
    const field = (id: string, key: keyof MapSpec): void => {
      this.dlg.querySelector(id)?.addEventListener('change', (e) => {
        (s.map as unknown as Record<string, string>)[key] = (e.target as HTMLSelectElement).value;
        s.mapPreset = 'custom';
        this.commit();
      });
    };
    field('#mp-biome', 'biome');
    field('#mp-river', 'river');
    field('#mp-forest', 'forest');
    field('#mp-village', 'village');
    field('#mp-crossing', 'crossing');
    field('#mp-layout', 'layout');
    field('#mp-relief', 'relief');

    // Onizlemeler (kartlar olustuktan sonra, sirayla).
    const size = s.mapSize;
    const specFor = (id: string): MapSpec => (id === 'random' ? m : PRESETS.find((p) => p.id === id)!.spec);
    this.dlg.querySelectorAll<HTMLCanvasElement>('canvas[data-prev]').forEach((c) => drawMinimap(c, specFor(c.dataset.prev!), s.seed, size));
  }
}

import { loc } from '../i18n';
import { RACE_NAMES, RARITY_NAMES, TROOP_BY_ID, type Rarity } from '../sim/data/troops';
import { DEFAULT_STATS, KIND_COUNT, LEGACY_COUNT, STATS, TUNABLE, isTank, type StatKey } from '../sim/units';
import { trackDialog } from '../net/act';
import { saveState, type AppState } from './state';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** Birim ayarlari penceresi: her satir bir birim; can, hiz, guc, bekleme, menzil, zirh, itme. */
export class UnitSettings {
  private readonly dlg: HTMLDialogElement;
  private readonly actTrack: { open(): void };

  constructor(
    private readonly state: AppState,
    private readonly onChange: () => void,
    private readonly icon: (kind: number, team: number) => HTMLCanvasElement,
  ) {
    this.dlg = document.createElement('dialog');
    this.dlg.className = 'unit-dialog unit-settings';
    this.dlg.setAttribute('aria-label', 'Birim ayarları');
    document.body.appendChild(this.dlg);
    this.actTrack = trackDialog(this.dlg, 'Birim ayarları');
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
  }

  /** Varsayilandan farkli kac deger var. */
  changedCount(): number {
    let n = 0;
    for (const row of this.state.stats) n += Object.keys(row).length;
    return n;
  }

  open(): void {
    this.render();
    this.actTrack.open();
    if (!this.dlg.open) this.dlg.showModal();
  }

  private value(k: number, key: StatKey): number {
    return this.state.stats[k][key] ?? DEFAULT_STATS[k][key];
  }

  /** Satir gruplari: klasik birimler, sonra nadirlige gore roster birimleri. */
  private groups(): Array<{ title: string; kinds: number[] }> {
    const out: Array<{ title: string; kinds: number[] }> = [{ title: 'Klasik', kinds: Array.from({ length: LEGACY_COUNT }, (_, k) => k) }];
    for (const r of RARITY_ORDER) {
      const kinds: number[] = [];
      for (let k = LEGACY_COUNT; k < KIND_COUNT; k++) {
        const t = TROOP_BY_ID[STATS[k].troop ?? ''];
        if (t && t.rarity === r) kinds.push(k);
      }
      if (kinds.length) out.push({ title: loc(RARITY_NAMES[r]), kinds });
    }
    return out;
  }

  private render(): void {
    const head = TUNABLE.map((t) => `<th scope="col" title="${esc(t.hint)}">${esc(t.label)}</th>`).join('');
    const rows = this.groups()
      .map((grp) => {
        const body = grp.kinds
          .map((k) => {
            const cells = TUNABLE.map((t) => {
              if (t.tankOnly && !isTank(k)) return '<td class="na">–</td>';
              const v = this.value(k, t.key);
              const changed = this.state.stats[k][t.key] !== undefined;
              return `<td><input type="number" data-k="${k}" data-key="${t.key}" value="${v}" min="${t.min}" max="${t.max}" step="${t.step}" aria-label="${esc(STATS[k].name)} ${esc(t.label)}" class="${changed ? 'changed' : ''}" /></td>`;
            }).join('');
            const has = Object.keys(this.state.stats[k]).length > 0;
            const t = STATS[k].troop ? TROOP_BY_ID[STATS[k].troop!] : undefined;
            const meta = t ? `${loc(RARITY_NAMES[t.rarity])} · ${loc(RACE_NAMES[t.race])}` : 'Klasik';
            const skill = t?.skillText ? `<small class="us-skill">${esc(loc(t.skillText))}</small>` : '';
            return `<tr><th scope="row" class="us-unit"><span class="us-icon" data-icon="${k}"></span><span class="us-name"><b>${esc(STATS[k].name)}</b><small>${esc(meta)}</small>${skill}</span></th>${cells}<td class="derived" data-derived="dps" data-k="${k}">${this.dps(k)}</td><td class="derived" data-derived="ehp" data-k="${k}">${this.effHp(k)}</td><td><button type="button" class="mini" data-reset-kind="${k}" ${has ? '' : 'disabled'}>Sıfırla</button></td></tr>`;
          })
          .join('');
        return `<tr class="grp"><th colspan="${TUNABLE.length + 4}">${esc(grp.title)} · ${grp.kinds.length}</th></tr>${body}`;
      })
      .join('');

    this.dlg.innerHTML = `
<form method="dialog">
  <header><h2>Birim ayarları</h2><p>Varsayılanlar seçili seviyeye göredir; değişiklikler sonraki savaştan itibaren geçerli olur ve kaydedilir.</p></header>
  <div class="table-wrap">
    <table>
      <thead><tr><th class="us-unit-h">Birim</th>${head}<th title="Güç / bekleme (rahipte şifa/sn)">Sn. güç</th><th title="Can / (1 − zırh)">Etkin can</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <footer>
    <button type="button" id="us-reset-all" ${this.changedCount() ? '' : 'disabled'}>Tümünü sıfırla</button>
    <button type="submit" class="primary">Kapat</button>
  </footer>
</form>`;

    this.dlg.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => el.appendChild(this.icon(Number(el.dataset.icon), 0)));
    this.dlg.querySelectorAll('input[data-k]').forEach((el) => {
      el.addEventListener('change', (e) => this.edit(e.target as HTMLInputElement));
    });
    this.dlg.querySelectorAll('[data-reset-kind]').forEach((el) =>
      el.addEventListener('click', () => {
        this.state.stats[Number((el as HTMLElement).dataset.resetKind)] = {};
        this.commit();
      }),
    );
    this.dlg.querySelector('#us-reset-all')!.addEventListener('click', () => {
      for (let k = 0; k < KIND_COUNT; k++) this.state.stats[k] = {};
      this.commit();
    });
  }

  private dps(k: number): string {
    return (this.value(k, 'power') / this.value(k, 'cooldown')).toFixed(1);
  }

  private effHp(k: number): string {
    return Math.round(this.value(k, 'hp') / (1 - this.value(k, 'armor'))).toString();
  }

  private edit(input: HTMLInputElement): void {
    const k = Number(input.dataset.k);
    const key = input.dataset.key as StatKey;
    const t = TUNABLE.find((x) => x.key === key)!;
    const raw = Number(input.value);
    if (!Number.isFinite(raw) || input.value === '') {
      input.value = String(this.value(k, key));
      return;
    }
    const v = Math.min(t.max, Math.max(t.min, raw));
    // Varsayilana esitse override tutma.
    if (Math.abs(v - DEFAULT_STATS[k][key]) < 1e-9) delete this.state.stats[k][key];
    else this.state.stats[k][key] = v;
    input.value = String(v);
    input.classList.toggle('changed', this.state.stats[k][key] !== undefined);
    this.refreshDerived();
    const reset = this.dlg.querySelector<HTMLButtonElement>(`[data-reset-kind="${k}"]`);
    if (reset) reset.disabled = Object.keys(this.state.stats[k]).length === 0;
    saveState(this.state);
    this.onChange();
    const resetAll = this.dlg.querySelector('#us-reset-all') as HTMLButtonElement | null;
    if (resetAll) resetAll.disabled = this.changedCount() === 0;
  }

  private refreshDerived(): void {
    this.dlg.querySelectorAll<HTMLElement>('[data-derived]').forEach((td) => {
      const k = Number(td.dataset.k);
      td.textContent = td.dataset.derived === 'dps' ? this.dps(k) : this.effHp(k);
    });
  }

  private commit(): void {
    saveState(this.state);
    this.onChange();
    this.render();
  }
}

import { DEFAULT_STATS, KIND_COUNT, LEGACY_COUNT, STATS, TUNABLE, isTank, type StatKey } from '../sim/units';
import { saveState, type AppState } from './state';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Birim ayarlari penceresi: can, hiz, guc, bekleme, menzil, zirh, itme. */
export class UnitSettings {
  private readonly dlg: HTMLDialogElement;

  constructor(
    private readonly state: AppState,
    private readonly onChange: () => void,
  ) {
    this.dlg = document.createElement('dialog');
    this.dlg.className = 'unit-dialog';
    this.dlg.setAttribute('aria-label', 'Birim ayarları');
    document.body.appendChild(this.dlg);
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
    if (!this.dlg.open) this.dlg.showModal();
  }

  private value(k: number, key: StatKey): number {
    return this.state.stats[k][key] ?? DEFAULT_STATS[k][key];
  }

  private render(): void {
    const head = Array.from({ length: LEGACY_COUNT }, (_, k) => `<th scope="col"><div>${esc(STATS[k].name)}</div><button type="button" class="mini" data-reset-kind="${k}" ${Object.keys(this.state.stats[k]).length ? '' : 'disabled'}>Sıfırla</button></th>`).join('');
    const rows = TUNABLE.map((t) => {
      const cells = Array.from({ length: LEGACY_COUNT }, (_, k) => {
        if (t.tankOnly && !isTank(k)) return '<td class="na">–</td>';
        const v = this.value(k, t.key);
        const changed = this.state.stats[k][t.key] !== undefined;
        return `<td><input type="number" data-k="${k}" data-key="${t.key}" value="${v}" min="${t.min}" max="${t.max}" step="${t.step}" aria-label="${esc(STATS[k].name)} ${esc(t.label)}" class="${changed ? 'changed' : ''}" /></td>`;
      }).join('');
      return `<tr><th scope="row" title="${esc(t.hint)}">${esc(t.label)}<small>${esc(t.hint)}</small></th>${cells}</tr>`;
    }).join('');
    const derived = (label: string, hint: string, fn: (k: number) => string): string =>
      `<tr class="derived"><th scope="row" title="${esc(hint)}">${esc(label)}<small>${esc(hint)}</small></th>${Array.from({ length: LEGACY_COUNT }, (_, k) => `<td data-derived="${esc(label)}" data-k="${k}">${fn(k)}</td>`).join('')}</tr>`;

    this.dlg.innerHTML = `
<form method="dialog">
  <header><h2>Birim ayarları</h2><p>Değişiklikler bir sonraki savaştan itibaren geçerli olur ve kaydedilir.</p></header>
  <div class="table-wrap">
    <table>
      <thead><tr><th></th>${head}</tr></thead>
      <tbody>${rows}${derived('Saniyelik güç', 'Güç / bekleme (rahipte şifa/sn)', (k) => this.dps(k))}${derived('Etkin can', 'Can / (1 − zırh)', (k) => this.effHp(k))}</tbody>
    </table>
  </div>
  <footer>
    <button type="button" id="us-reset-all" ${this.changedCount() ? '' : 'disabled'}>Tümünü sıfırla</button>
    <button type="submit" class="primary">Kapat</button>
  </footer>
</form>`;

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
    saveState(this.state);
    this.onChange();
    const resetAll = this.dlg.querySelector('#us-reset-all') as HTMLButtonElement | null;
    if (resetAll) resetAll.disabled = this.changedCount() === 0;
  }

  private refreshDerived(): void {
    this.dlg.querySelectorAll<HTMLElement>('[data-derived]').forEach((td) => {
      const k = Number(td.dataset.k);
      td.textContent = td.dataset.derived === 'Saniyelik güç' ? this.dps(k) : this.effHp(k);
    });
  }

  private commit(): void {
    saveState(this.state);
    this.onChange();
    this.render();
  }
}

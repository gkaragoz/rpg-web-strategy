/** Oyun ici baglanti rozeti (sag alt): baglanti turu + lobi kodu; dokununca davet linkini kopyalar. */
export class ConnBadge {
  private readonly el: HTMLButtonElement;
  private readonly timer: ReturnType<typeof setInterval>;
  private note = '';

  constructor(
    root: HTMLElement,
    private readonly info: () => { via: string; code: string; link: string },
  ) {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'on-badge';
    root.appendChild(this.el);
    this.el.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.info().link).catch(() => {});
      this.note = 'Link kopyalandı';
      this.paint();
      setTimeout(() => {
        this.note = '';
        this.paint();
      }, 1500);
    });
    this.paint();
    this.timer = setInterval(() => this.place(), 400);
    this.place();
  }

  private paint(): void {
    const { via, code } = this.info();
    const lan = via === 'LAN';
    const icon = lan ? '🏠' : '🌐';
    const kind = lan ? 'LAN' : 'İnternet';
    this.el.textContent = this.note || `${icon} ${kind} · ${code}`;
    this.el.title = `Bağlantı: ${via} — dokun: davet linkini kopyala`;
  }

  /** Alt dock'un (telefonda yuksek) ve savas alt cubugunun ustunde kal. */
  private place(): void {
    const h = window.innerHeight;
    let top = h;
    for (const sel of ['.on-dock', '.hud-bottom']) {
      const e = document.querySelector(sel) as HTMLElement | null;
      if (!e || e.hidden) continue;
      const r = e.getBoundingClientRect();
      // Yalniz ekranin sag alt bolgesini kaplayan ogeler icin yukari it.
      if (r.right > window.innerWidth - 150 && r.top < top) top = r.top;
    }
    this.el.style.bottom = `${Math.round(h - top + 8)}px`;
    this.paint();
  }

  destroy(): void {
    clearInterval(this.timer);
    this.el.remove();
  }
}

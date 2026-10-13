import { t } from '../../i18n';

/** In-game connection badge (bottom right): connection type + lobby code; tapping copies the invite link. */
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
      this.note = t('online.badge.copied');
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
    const lan = via === 'lan';
    const icon = lan ? '🏠' : '🌐';
    const kind = lan ? t('online.badge.lan') : t('online.badge.net');
    this.el.textContent = this.note || `${icon} ${kind} · ${code}`;
    this.el.title = t('online.badge.tip', { via: t(`online.via.${via}`) });
  }

  /** Stay above the bottom dock (tall on phones) and the battle's bottom bar. */
  private place(): void {
    const h = window.innerHeight;
    let top = h;
    for (const sel of ['.on-dock', '.hud-bottom']) {
      const e = document.querySelector(sel) as HTMLElement | null;
      if (!e || e.hidden) continue;
      const r = e.getBoundingClientRect();
      // Only push up for elements that cover the bottom-right area of the screen.
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

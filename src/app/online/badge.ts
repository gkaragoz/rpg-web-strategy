import { t } from '../../i18n';

/** In-game connection badge (bottom right): connection type + lobby code; tapping copies the invite link. */
export class ConnBadge {
  private readonly el: HTMLButtonElement;
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
  }

  private paint(): void {
    const { via, code } = this.info();
    const lan = via === 'lan';
    const icon = lan ? '🏠' : '🌐';
    const kind = lan ? t('online.badge.lan') : t('online.badge.net');
    this.el.textContent = this.note || `${icon} ${kind} · ${code}`;
    this.el.title = t('online.badge.tip', { via: t(`online.via.${via}`) });
  }

  destroy(): void {
    this.el.remove();
  }
}

import { t } from '../../i18n';
import type { Session } from '../../net/client';
import { hex } from '../state';
import { playerColor } from './cursors';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const SHOW_MS = 9000;

/** In-game chat: type with Enter; messages show for a while and then fade. */
export class ChatOverlay {
  private readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private seen = 0;
  private readonly keys: (e: KeyboardEvent) => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    root: HTMLElement,
    private readonly session: Session,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'on-ingame-chat';
    this.el.innerHTML = `<div class="on-ig-log" aria-live="polite"></div><input class="on-ig-in" maxlength="200" placeholder="${esc(t('online.chat.ph'))}" autocomplete="off" hidden /><button type="button" class="on-ig-btn" aria-label="${esc(t('online.chat.btn'))}">${t('online.chat.btn')}</button>`;
    root.appendChild(this.el);
    this.log = this.el.querySelector('.on-ig-log') as HTMLElement;
    this.input = this.el.querySelector('.on-ig-in') as HTMLInputElement;
    this.seen = session.model.chat.at(-1)?.n ?? 0;
    const btn = this.el.querySelector('.on-ig-btn') as HTMLButtonElement;
    // Touch: there is no Enter key; the button opens the input (prevent default on pointerdown so blur does not close it).
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      this.input.hidden = false;
      this.input.focus();
    });
    this.keys = (e) => {
      if (e.code === 'Enter' && document.activeElement !== this.input) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON')) return;
        e.preventDefault();
        this.input.hidden = false;
        this.input.focus();
      }
    };
    window.addEventListener('keydown', this.keys);
    // Stay above the bottom dock (tall on phones).
    const place = (): void => {
      const d = document.querySelector('.on-dock');
      this.el.style.bottom = `${d ? Math.round(window.innerHeight - d.getBoundingClientRect().top + 8) : 96}px`;
    };
    place();
    this.timer = setInterval(place, 400);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (this.input.value.trim()) this.session.send({ t: 'chat', text: this.input.value });
        this.input.value = '';
        this.close();
      } else if (e.key === 'Escape') this.close();
    });
    this.input.addEventListener('blur', () => this.close());
  }

  private close(): void {
    this.input.hidden = true;
    this.input.blur();
  }

  /** Adds new chat messages. */
  update(): void {
    const m = this.session.model;
    for (const c of m.chat) {
      if (c.n <= this.seen) continue;
      this.seen = c.n;
      const p = m.state?.players.find((x) => x.id === c.id);
      const d = document.createElement('div');
      d.className = 'on-ig-line';
      d.innerHTML = `<b style="color:${hex(playerColor(p?.color ?? 0))}">${esc(c.name)}</b> ${esc(c.text)}`;
      this.log.appendChild(d);
      while (this.log.children.length > 8) this.log.firstElementChild?.remove();
      setTimeout(() => d.classList.add('gone'), SHOW_MS);
      setTimeout(() => d.remove(), SHOW_MS + 1500);
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keys);
    clearInterval(this.timer);
    this.el.remove();
  }
}

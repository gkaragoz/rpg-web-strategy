import type { Session } from '../../net/client';
import { hex } from '../state';
import { playerColor } from './cursors';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const SHOW_MS = 9000;

/** Oyun ici sohbet: Enter ile yazilir, mesajlar bir sure gorunup solar. */
export class ChatOverlay {
  private readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private seen = 0;
  private readonly keys: (e: KeyboardEvent) => void;

  constructor(
    root: HTMLElement,
    private readonly session: Session,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'on-ingame-chat';
    this.el.innerHTML = '<div class="on-ig-log" aria-live="polite"></div><input class="on-ig-in" maxlength="200" placeholder="Mesaj (Enter gönder, Esc kapat)" autocomplete="off" hidden />';
    root.appendChild(this.el);
    this.log = this.el.querySelector('.on-ig-log') as HTMLElement;
    this.input = this.el.querySelector('.on-ig-in') as HTMLInputElement;
    this.seen = session.model.chat.length;
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

  /** Yeni sohbet mesajlarini ekler. */
  update(): void {
    const m = this.session.model;
    while (this.seen < m.chat.length) {
      const c = m.chat[this.seen++];
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
    this.el.remove();
  }
}

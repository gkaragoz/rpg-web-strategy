import { getLang, t } from '../i18n';
import { langKeys } from './hotkeys';
import { Scope } from './scope';
import { markTourSeen, placeBalloon, studioSteps, tourSeen, type TourStep } from './tourLogic';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const keyLabel = (code: string): string => code.replace(/^Key/, '');

/** The studio tour is wanted when it was never seen (or never finished/skipped) and the studio is the visible screen. */
export function shouldStartTour(): boolean {
  if (new URLSearchParams(location.search).get('tour') === 'off') return false; // automated tests and screenshots
  return !tourSeen();
}

/**
 * First-run tour: a dimmed screen with the real control highlighted and a balloon (title, text, Back / Next / Skip). Escape skips it,
 * finishing or skipping remembers that it was seen, and the "?" button in the dock starts it again.
 */
export class Tour {
  private readonly scope = new Scope();
  private readonly steps: TourStep[];
  private readonly root = document.createElement('div');
  private readonly spot = document.createElement('div');
  private readonly balloon = document.createElement('div');
  private index = 0;
  private closed = false;

  private constructor(touch: boolean, private readonly onClose: () => void) {
    this.steps = studioSteps(touch);
    this.root.className = 'tour';
    this.spot.className = 'tour-spot';
    this.balloon.className = 'tour-balloon';
    this.balloon.setAttribute('role', 'dialog');
    this.balloon.setAttribute('aria-label', t('tour.aria'));
    this.root.append(this.spot, this.balloon);
    document.body.appendChild(this.root);
    this.scope.add(() => this.root.remove());
    this.scope.on<KeyboardEvent>(window, 'keydown', (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if (e.code === 'Enter' || e.code === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        this.next();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        this.back();
      }
    }, true);
    this.scope.on(window, 'resize', () => this.paint());
    this.paint();
  }

  /** Starts the tour unless one is already open; returns it (or null). */
  static start(touch: boolean, onClose: () => void = () => undefined): Tour | null {
    if (document.querySelector('.tour')) return null;
    return new Tour(touch, onClose);
  }

  private next(): void {
    if (this.index >= this.steps.length - 1) this.close();
    else {
      this.index++;
      this.paint();
    }
  }

  private back(): void {
    if (this.index > 0) {
      this.index--;
      this.paint();
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    markTourSeen();
    this.scope.dispose();
    this.onClose();
  }

  private target(step: TourStep): HTMLElement | null {
    if (!step.target) return null;
    const el = document.querySelector<HTMLElement>(step.target);
    return el && el.getClientRects().length > 0 ? el : null;
  }

  private paint(): void {
    if (this.closed) return;
    const step = this.steps[this.index]!;
    const key = step.title;
    const k = step.body;
    const keys = langKeys(getLang());
    const last = this.index === this.steps.length - 1;
    this.balloon.innerHTML = `<h3>${esc(t(key))}</h3><p>${esc(t(k, { key: keyLabel(keys.gallery), brushKey: keyLabel(keys.brush) }))}</p>
<div class="tour-foot"><span class="tour-progress">${esc(t('tour.progress', { n: this.index + 1, total: this.steps.length }))}</span>
<span class="tour-btns"><button type="button" class="tour-skip">${esc(t('tour.skip'))}</button>${this.index > 0 ? `<button type="button" class="tour-back">${esc(t('tour.back'))}</button>` : ''}<button type="button" class="primary tour-next">${esc(t(last ? 'tour.done' : 'tour.next'))}</button></span></div>`;
    this.balloon.querySelector('.tour-skip')!.addEventListener('click', () => this.close());
    this.balloon.querySelector('.tour-back')?.addEventListener('click', () => this.back());
    const nextBtn = this.balloon.querySelector<HTMLButtonElement>('.tour-next')!;
    nextBtn.addEventListener('click', () => this.next());
    const el = this.target(step);
    const r = el?.getBoundingClientRect() ?? null;
    if (r) {
      const pad = 6;
      Object.assign(this.spot.style, { display: 'block', left: `${r.x - pad}px`, top: `${r.y - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    } else {
      this.spot.style.display = 'none';
      this.root.classList.add('tour-dim');
    }
    this.root.classList.toggle('tour-dim', !r);
    // Measure after the content is in place, then position.
    const size = { width: this.balloon.offsetWidth, height: this.balloon.offsetHeight };
    const dock = el?.closest('.dock')?.getBoundingClientRect() ?? null;
    const p = placeBalloon(r ? { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 } : null, size, { width: window.innerWidth, height: window.innerHeight }, dock);
    Object.assign(this.balloon.style, { left: `${p.left}px`, top: `${p.top}px` });
    this.balloon.dataset.arrow = p.arrow ?? '';
    nextBtn.focus({ preventScroll: true });
  }
}

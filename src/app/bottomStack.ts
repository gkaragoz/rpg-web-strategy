/**
 * Keeps the fixed bottom-right widgets (language picker, online connection badge) clear of the bottom bars.
 * On phones the studio dock / battle HUD / online dock are full-width bars; on desktop they float in the middle.
 * A light poll measures the bars that cover the bottom-right area and publishes CSS variables on <html>:
 *   --bar-h     height from the viewport bottom to the top of the covering bar (0 when none)
 *   --lp-w/--lp-h  size of the language picker button
 *   --lp-lift   extra bottom offset for the badge (picker height) when a bar forces both to stack vertically
 *   --lp-side   extra right offset for the badge (picker width) when both sit side by side on the bottom edge
 */
const BARS = ['.dock', '.hud-bottom'];

export function startBottomStack(): () => void {
  const root = document.documentElement;
  const set = (k: string, v: number): void => root.style.setProperty(k, `${Math.round(v)}px`);
  let last = '';
  const measure = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    let bar = 0;
    for (const sel of BARS) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (el.getClientRects().length === 0) continue;
        const r = el.getBoundingClientRect();
        // Only bars that reach the bottom-right area matter (floating desktop bars stay clear of it).
        if (r.right > w - 150 && r.bottom > h - 4) bar = Math.max(bar, h - r.top);
      }
    }
    const lp = document.querySelector<HTMLElement>('.lang-picker .lp-btn');
    const lw = lp?.offsetWidth ?? 0;
    const lh = lp?.offsetHeight ?? 0;
    const key = `${bar}|${lw}|${lh}`;
    if (key === last) return;
    last = key;
    set('--bar-h', bar);
    set('--lp-w', lw);
    set('--lp-h', lh);
    set('--lp-lift', bar > 0 ? lh + 6 : 0);
    set('--lp-side', bar > 0 ? 0 : lw + 8);
  };
  measure();
  const timer = setInterval(measure, 300);
  window.addEventListener('resize', measure);
  return () => {
    clearInterval(timer);
    window.removeEventListener('resize', measure);
  };
}
